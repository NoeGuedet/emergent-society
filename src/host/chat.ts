import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { access, lstat, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GATEWAY_ADDRESSEE, HUMAN_AUTHOR, JournalClosedError, assertConversationActor, isErrno,
  readFileOrNull,
} from '../journal/index.js';
import {
  appendLineUnderLock, ensureLockSidecar, repairUnderLock,
} from '../locked-append.js';
import {
  MAX_SPEAK_BYTES, type ConversationRecord, readConversationStream,
} from '../node/conversation.js';
import { GATEWAY_CHARTER_FILE } from '../overlay/charter.js';
import { isRenderableInstant, isoInstant } from '../util.js';
import { HostConfigError } from './errors.js';

/**
 * The human channel's chat log (`chat.v0.jsonl`): the human↔overlay
 * conversation, outside the world.
 *
 * The channel is the native chat — the human's typed records and the overlay
 * cycle's response records, interleaved in one kernel-owned log. It is one of
 * the sanctioned interface exceptions to "communication is a file" (the human
 * has no file to read). The log is mode 0600 and append-only, with one
 * `{v, at, uid, text}` line per record; `uid` follows the conversation actor
 * rule (a node uid, the reserved `human`, or the reserved `gateway`).
 *
 * THREE CROSS-PROCESS WRITERS: the overlay's cycle (`ChatLog`, the host's
 * delivery handle), the interactive session and `direct` (`ChatWriter`, the
 * human's typed/batch acts). All three take the SAME flock
 * (`<home>/.es/chat.lock`) and follow the shared audited sequence — the `.es`
 * ensure, the blocking wait, the torn-tail termination first, then the stat,
 * one `O_APPEND` write and one `fsync`, the create-if-absent 0600 with the
 * durable directory entry (`src/locked-append.ts`). The boot-time truncate
 * repair stays HOST-ONLY and runs under the same lock (`ChatLog.open`).
 *
 * The readers are tolerant (`readChatHistory`, `readChatWindow`,
 * `readChatSince`): a torn tail is dropped, a complete line that does not
 * parse is one droppable degraded line (the session says so and exits 1), and
 * the `at` finite guard plus the actor rule are shared with the writer.
 */

/** The chat log's file name inside the cell home. */
export const CHAT_FILE = 'chat.v0.jsonl';

/** The chat log's kernel-owned flock sidecar, inside `.es`. */
export const CHAT_LOCK_FILE = 'chat.lock';

/** The bounded tail window a chat read scans: never the whole log. */
export const MAX_CHAT_READ_BYTES = 1024 * 1024;

/** The session's default `--tail` bound on the rendered history. */
export const CHAT_DEFAULT_TAIL = 20;

/** The session's bounded wait for the overlay's response: the never-hang guard. */
export const CHAT_WAIT_TIMEOUT_MS = 60_000;

/** The session's client-side poll of the chat log while waiting. */
export const CHAT_WAIT_POLL_MS = 200;

/** The "still waiting…" note's interval. */
export const CHAT_WAIT_NOTE_MS = 15_000;

/** The timeout notice: the message stays saved and the boot cycle digests it. */
export const CHAT_TIMEOUT_NOTICE = 'no response yet — the overlay may be unconfigured or busy;'
  + ' your message is saved and will be digested';

/** The absent-overlay notice: detected up front from the charter sidecar. */
export const CHAT_ABSENT_OVERLAY_NOTICE = 'saved; no overlay is running — the message'
  + ' will be digested when the overlay is configured';

/** The Ctrl-C-aborted-wait notice: the session survives, the message stays saved. */
export const CHAT_INTERRUPTED_NOTICE = 'wait interrupted — your message is saved';

/** The periodic note while the wait has produced nothing yet. */
export const CHAT_STILL_WAITING = 'still waiting…';

/** One delivered message. */
export type ChatMessage = {
  readonly v: 0;
  readonly at: number;
  readonly uid: string;
  readonly text: string;
};

/** One append's confirmation: the record's host wall-clock and start offset. */
export type ChatAppended = {
  readonly at: number;
  readonly offset: number;
  readonly bytes: number;
};

/** A tolerant history read: the records, the older note, the degraded count. */
export type ChatHistory = {
  readonly records: readonly ChatMessage[];
  readonly older: boolean;
  readonly degraded: number;
};

/**
 * The bounded, path-free chat writer refusal. A raw fs error would carry the
 * absolute home path onto the human's terminal.
 */
export class ChatWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatWriteError';
  }
}

/**
 * The kernel's append-only chat writer, the host's delivery handle.
 *
 * The handle is stateless — every append's critical section lives in the
 * shared locked-append helper — so the class exists to bind one home and to
 * keep the host's `open`/`close` lifetime. `open` is the HOST's boot act: the
 * one torn-tail truncate repair, under the chat log's own lock. A missing log
 * is a new cell and creates nothing.
 */
export class ChatLog {
  private closed = false;

  private constructor(private readonly home: string, private readonly path: string) {}

  /** Opens the home's chat log, repairing a torn trailing fragment under the lock. */
  static async open(home: string): Promise<ChatLog> {
    const path = join(home, CHAT_FILE);
    const log = new ChatLog(home, path);
    if (await pathPresent(path)) {
      const lock = await chatLock(home);
      try {
        // The chat log's own precedence: a log that is NOTHING but a torn
        // first append is truncated to zero instead of making the host
        // unbootable (the conversation stream keeps its refusal).
        await repairUnderLock(lock, path, 'truncate');
      } catch {
        throw new ChatWriteError('the chat log could not be repaired at boot');
      }
    }
    return log;
  }

  /** Appends one message under the chat log's flock and makes it durable. */
  async append(uid: string, text: string, at: number = Date.now()): Promise<void> {
    if (this.closed) throw new JournalClosedError();
    await appendChatRecord(this.home, this.path, uid, text, at);
  }

  /** Releases the handle; the bytes are already durable, so this is bookkeeping. */
  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * The human's chat writer — the session's typed record and `direct`'s batch
 * twin. One `{v: 0, at, uid: 'human', text}` record per call, appended under
 * `<home>/.es/chat.lock`. It never truncates: the boot repair is the host's
 * (`ChatLog.open`), and this class is deliberately not a `ChatLog.open` caller
 * (that open is mutating and racy against a live host).
 */
export class ChatWriter {
  private constructor(private readonly home: string) {}

  /** The home's human writer. No I/O: the first append takes the lock. */
  static for(home: string): ChatWriter {
    return new ChatWriter(home);
  }

  /** Appends one human record; `text` must be non-blank and ≤ 8192 bytes. */
  async append(text: string, at: number = Date.now()): Promise<ChatAppended> {
    return await appendChatRecord(this.home, join(this.home, CHAT_FILE), HUMAN_AUTHOR, text, at);
  }
}

/** The one append path every chat writer takes, validation then the lock. */
async function appendChatRecord(
  home: string, path: string, uid: string, text: string, at: number,
): Promise<ChatAppended> {
  const actor = assertConversationActor(uid);
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ChatWriteError('a chat message cannot be blank');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SPEAK_BYTES) {
    throw new ChatWriteError(`a chat message cannot exceed ${MAX_SPEAK_BYTES} bytes`);
  }
  if (!Number.isFinite(at)) {
    throw new ChatWriteError('a chat record needs a finite at');
  }
  const line = `${JSON.stringify({ v: 0, at, uid: actor, text })}\n`;
  const lock = await chatLock(home);
  try {
    const outcome = await appendLineUnderLock(lock, path, line);
    return { at, offset: outcome.offset, bytes: outcome.bytes };
  } catch {
    throw new ChatWriteError('the chat log could not be written');
  }
}

/**
 * The `.es` directory and the chat log's flock sidecar, created before `flock`
 * touches it. A refused creation is the fixed path-free refusal: a raw fs
 * error would carry the absolute home path onto the human's terminal.
 */
async function chatLock(home: string): Promise<string> {
  try {
    // The chat log lives directly in the home, so a home without owner write
    // permission cannot take the append even when the `.es` sidecar directory
    // already exists (it always does on a fresh marker-bearing home). Fail at
    // the lock step with the same bounded, path-free refusal.
    await access(home, constants.W_OK);
    return await ensureLockSidecar(home, CHAT_LOCK_FILE);
  } catch {
    throw new ChatWriteError(
      'the chat log could not be written: the kernel-owned lock sidecar is unavailable',
    );
  }
}

/** `lstat` presence; a symlink counts as present (the reader follows nothing). */
async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return false;
    throw err;
  }
}

/** Reads every complete chat line in order; a missing file is an empty chat. */
export async function readChat(home: string): Promise<ChatMessage[]> {
  const raw = await readFileOrNull(join(home, CHAT_FILE));
  if (raw === null) return [];
  const lines = raw.toString('utf8').split('\n');
  // Our writer always terminates a line; the last segment is empty or torn.
  lines.pop();
  return lines.map((line, index) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) {
      throw new Error(`chat record ${index + 1} is not an object`);
    }
    const record = value as Record<string, unknown>;
    if (record['v'] !== 0 || typeof record['at'] !== 'number'
      || typeof record['uid'] !== 'string' || typeof record['text'] !== 'string') {
      throw new Error(`chat record ${index + 1} has an invalid shape`);
    }
    // Both logs' readers validate the same actor rule (the writer does too):
    // a node uid, the reserved human, or the reserved gateway.
    return {
      v: 0, at: record['at'], uid: assertConversationActor(record['uid']), text: record['text'],
    };
  });
}

/**
 * The chat log's newest `n` records, tolerantly — the session's history read.
 *
 * The read is a bounded TAIL read (`MAX_CHAT_READ_BYTES`): it starts at most
 * one window before EOF, drops a leading fragment when it starts mid-record,
 * drops a torn trailing fragment (never a record), and reports `older` when
 * the window did not reach the log's start. A complete line that does not
 * parse is one droppable degraded line: it is counted, never fatal — the
 * session renders what it can, says so, and exits 1.
 */
export async function readChatHistory(
  home: string, n: number = CHAT_DEFAULT_TAIL, maxBytes: number = MAX_CHAT_READ_BYTES,
): Promise<ChatHistory> {
  const limit = Number.isSafeInteger(n) && n > 0 ? n : 1;
  const tail = await readChatTail(join(home, CHAT_FILE), maxBytes);
  if (tail === null) return { records: [], older: false, degraded: 0 };
  const records: ChatMessage[] = [];
  let degraded = 0;
  for (const line of tail.lines) {
    if (line === '') {
      // An empty complete line is never something a writer produces: corruption.
      degraded += 1;
      continue;
    }
    const record = parseChatLineOrNull(line);
    if (record === null) degraded += 1;
    else {
      // A finite but unrenderable `at` keeps the record (the text is intact)
      // and renders the fixed unrenderable stamp; it is a degraded line too.
      if (!isRenderableInstant(record.at)) degraded += 1;
      records.push(record);
    }
  }
  const older = tail.midFile || records.length > limit;
  return { records: records.slice(-limit), older, degraded };
}

/**
 * The chat log's last n records, from a bounded TAIL read — the overlay's chat
 * window. A degraded complete line is skipped silently here: the cycle digests
 * what it can and never fails on one droppable line.
 */
export async function readChatWindow(
  home: string, n: number, maxBytes: number = MAX_CHAT_READ_BYTES,
): Promise<readonly ChatMessage[]> {
  return (await readChatHistory(home, n, maxBytes)).records;
}

/**
 * The gateway records appended at or after `offset` — the session's wait read.
 *
 * `offset` is the end of the record the human's append wrote, so every record
 * starting there is later than the typed message. The read is bounded and
 * tolerant (a torn tail is dropped, a degraded line skipped); a shrink (the
 * host's boot repair) is simply an empty window.
 */
export async function readChatSince(
  home: string, offset: number, maxBytes: number = MAX_CHAT_READ_BYTES,
): Promise<ChatMessage[]> {
  const path = join(home, CHAT_FILE);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return [];
    throw err;
  }
  const from = Math.max(0, Math.min(offset, size));
  if (size <= from) return [];
  const start = Math.max(from, size - Math.max(1, Math.floor(maxBytes)));
  const buffer = Buffer.alloc(size - start);
  const handle = await open(path, 'r');
  let read = 0;
  try {
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer, read, buffer.length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  let text = buffer.subarray(0, read).toString('utf8');
  // A window that begins after `from` may start mid-record: drop the fragment.
  if (start > from) {
    if (buffer[0] === 0x0a) text = text.slice(1);
    else {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
  }
  const lines = text.split('\n');
  // Our writer always terminates a line: the last segment is empty or torn.
  lines.pop();
  const records: ChatMessage[] = [];
  for (const line of lines) {
    const record = parseChatLineOrNull(line);
    if (record !== null && record.uid === GATEWAY_ADDRESSEE) records.push(record);
  }
  return records;
}

/** The tail window as complete lines; `midFile` says the window missed the start. */
async function readChatTail(
  path: string, maxBytes: number,
): Promise<{ lines: string[]; midFile: boolean } | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
  if (size === 0) return { lines: [], midFile: false };
  const window = Math.max(1, Math.floor(maxBytes));
  const start = Math.max(0, size - window);
  const from = start > 0 ? start - 1 : 0;
  const length = size - from;
  const buffer = Buffer.alloc(length);
  const handle = await open(path, 'r');
  let read = 0;
  try {
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, from + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  let text = buffer.subarray(0, read).toString('utf8');
  if (from > 0) {
    if (buffer[0] === 0x0a) text = text.slice(1);
    else {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
  }
  const lines = text.split('\n');
  // Our writer always terminates a line: the last segment is empty or torn.
  lines.pop();
  return { lines, midFile: start > 0 };
}

/**
 * Parses one complete chat line tolerantly: a degraded line is `null`, never a
 * throw. The strict reader (`readChat`) keeps its own throwing form for the
 * scripted read; the session, the overlay's window and the watcher share this
 * one.
 */
export function parseChatLineOrNull(line: string): ChatMessage | null {
  if (line === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['v'] !== 0) return null;
  const at = record['at'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const uid = record['uid'];
  const text = record['text'];
  if (typeof uid !== 'string' || typeof text !== 'string') return null;
  try {
    return { v: 0, at, uid: assertConversationActor(uid), text };
  } catch {
    return null;
  }
}

/**
 * The human's UTC ISO render of one record's host wall-clock `at`. It is
 * never allowed to throw: an out-of-range instant renders the fixed
 * `(unrenderable time)` stamp (the readers guard finite; this guards range).
 */
export function chatStamp(at: number): string {
  return isoInstant(at);
}

/** One chat record as the session renders it: `[ISO] uid: text`. */
export function renderChatRecord(record: ChatMessage): string {
  return `[${chatStamp(record.at)}] ${record.uid}: ${record.text}`;
}

/**
 * The history block: the older note, the records oldest-first, the degraded
 * notice when an unreadable record had to be skipped. An empty log says so.
 */
export function renderChatHistory(history: ChatHistory): string {
  const parts: string[] = [];
  if (history.older) {
    parts.push(`(older records exist — this window shows the newest ${history.records.length})`);
  }
  if (history.records.length === 0) parts.push('(no chat records yet)');
  for (const record of history.records) parts.push(renderChatRecord(record));
  if (history.degraded > 0) {
    parts.push(history.degraded === 1
      ? '(degraded: 1 unreadable chat record skipped)'
      : `(degraded: ${history.degraded} unreadable chat records skipped)`);
  }
  return parts.join('\n');
}

/**
 * The raw conversation stream beside the chat (`--conversation`): every
 * participant's records in order, oldest first, read-only. This is the HUMAN's
 * window on the interface, not a world read: the log is kernel-owned. A
 * degraded line is skipped (the stream's documented tolerance), never fatal.
 */
export function renderConversationHistory(records: readonly ConversationRecord[]): string {
  const header = 'conversation stream (nodes ↔ overlay), oldest first:';
  if (records.length === 0) return `${header}\n(no conversation records yet)`;
  const lines = records.map((record) => `[${chatStamp(record.at)}] from ${record.from}`
    + ` to ${record.to}\n${record.text}`);
  return `${header}\n${lines.join('\n\n')}`;
}

/**
 * The stdin seam: one line at a time, `null` at EOF. `isTTY` is the
 * interactive fact — a pipe/EOF stdin renders the history and exits, so a
 * scripted `chat --home` can never hang on a read.
 */
export type ChatStdin = {
  readonly isTTY: boolean;
  readLine(): Promise<string | null>;
};

/** The process stdin: UTF-8 lines, EOF as `null` (the Ctrl-D exit). */
export function createProcessStdin(): ChatStdin {
  const input = process.stdin;
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let buffer = '';
  let ended = false;
  let attached = false;

  const flush = (): void => {
    for (;;) {
      if (lines.length > 0 && waiters.length > 0) {
        waiters.shift()!(lines.shift()!);
        continue;
      }
      if (ended && buffer === '' && lines.length === 0) {
        while (waiters.length > 0) waiters.shift()!(null);
      }
      return;
    }
  };

  const attach = (): void => {
    if (attached) return;
    attached = true;
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        let line = buffer.slice(0, index);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        lines.push(line);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
      flush();
    });
    input.on('end', () => {
      if (buffer !== '') {
        lines.push(buffer);
        buffer = '';
      }
      ended = true;
      flush();
    });
    input.on('error', () => {
      ended = true;
      flush();
    });
  };

  return {
    get isTTY(): boolean {
      return input.isTTY === true;
    },
    readLine(): Promise<string | null> {
      attach();
      input.resume();
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
        flush();
      });
    },
  };
}

/** One session run's outcome: the exit code and the facts a test can assert. */
export type ChatSessionResult = {
  readonly code: number;
  readonly degraded: boolean;
  /** How many response records the session rendered. */
  readonly responses: number;
};

/** Everything one session needs; production binds the process stdin and sinks. */
export type ChatSessionOptions = {
  readonly home: string;
  readonly stdin: ChatStdin;
  readonly tail?: number;
  readonly conversation?: boolean;
  readonly json?: boolean;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly now?: () => number;
  readonly waitTimeoutMs?: number;
  readonly waitPollMs?: number;
  readonly waitNoteMs?: number;
  /**
   * A test seam for the Ctrl-C abort: the session installs its own SIGINT
   * handler around the wait (Ctrl-C interrupts the wait, never the session);
   * this signal composes with it so a test can abort without a process signal.
   */
  readonly waitSignal?: AbortSignal;
};

type WaitOutcome =
  | { readonly kind: 'response'; readonly records: readonly ChatMessage[] }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'interrupted' };

/**
 * The interactive `chat` session: the human↔overlay surface, read AND write in
 * one place.
 *
 * It renders the recent chat log first (both sides' records interleaved, the
 * tolerant reader, `--tail N`, the ISO-8601 UTC stamp), then runs the prompt
 * loop: a typed line → the `ChatWriter` appends the `{v:0, at, uid:human,
 * text}` record under the chat lock → the host's ChatWatcher (a size poll, so a
 * cross-process append is caught) triggers the overlay's cycle → the session
 * waits for and renders the new `uid: gateway` record(s) → the prompt returns.
 *
 * THE WAIT IS MECHANIZED, never open-ended: a bounded client-side poll of the
 * chat log (`CHAT_WAIT_TIMEOUT_MS`, a "still waiting…" note at intervals);
 * after the timeout the session says so and RETURNS TO THE PROMPT — the
 * message stays in the log and the boot cycle digests it when the overlay
 * appears. Ctrl-C aborts the WAIT only (the session survives); EOF/Ctrl-D
 * exits, 0 unless the history itself was degraded.
 *
 * THE ABSENT OVERLAY is detected up front from `<home>/gateway.charter.md`'s
 * PRESENCE: the session still saves the typed record and says the message will
 * be digested when the overlay is configured, then returns to the prompt —
 * never a hang, never a refusal. RESIDUAL, stated: the check is the sidecar's
 * presence, so a configured-but-stopped host passes it and the 60 s timeout is
 * the backstop.
 *
 * A NON-TTY stdin (a pipe/EOF) renders the history and exits: a scripted
 * `chat --home` never blocks on a read. `--json` is the one-shot scripted
 * read (the chat records, and the raw conversation stream when asked).
 *
 * Exit codes: a missing home is `HostConfigError` (the CLI maps it to 2); a
 * corrupt interior chat record renders what it can with the degraded notice
 * and exits 1 (the status precedent: the report prints, the code degrades);
 * EOF is 0 otherwise.
 */
export async function runChatSession(options: ChatSessionOptions): Promise<ChatSessionResult> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  const now = options.now ?? (() => Date.now());
  const tail = options.tail ?? CHAT_DEFAULT_TAIL;
  await assertChatHome(options.home);

  const history = await readChatHistory(options.home, tail);
  const degraded = history.degraded > 0;
  // The raw stream's bounded tail: the SAME reader, `--tail` bound and renderer
  // at open and before every prompt. A record that lands mid-session (the
  // overlay's relay to a node) is therefore visible in the raw view without a
  // restart, and the view never grows past the open render's bounds.
  const conversationWindow = async (): Promise<readonly ConversationRecord[]> =>
    (await readConversationStream(options.home, tail)).records;
  const conversation = options.conversation === true ? await conversationWindow() : null;

  if (options.json === true) {
    out(`${JSON.stringify({ records: history.records, conversation })}\n`);
    return { code: degraded ? 1 : 0, degraded, responses: 0 };
  }

  out(`${renderChatHistory(history)}\n`);
  // What the raw view currently shows. The open render already reflects the
  // state at the first prompt, so the loop re-renders only when the stream
  // actually changed — never a duplicated unchanged block, never a stale view.
  let shownConversation = conversation === null
    ? null
    : renderConversationHistory(conversation);
  if (shownConversation !== null) out(`${shownConversation}\n`);

  // A pipe/EOF stdin is the scripted read: render and leave. It never blocks.
  let code = degraded ? 1 : 0;
  if (!options.stdin.isTTY) return { code, degraded, responses: 0 };

  const writer = ChatWriter.for(options.home);
  let responses = 0;
  for (;;) {
    // Before each prompt, after the previous response rendered: re-read the
    // newest tail and re-render it when it moved (still the open render's
    // bounds), so an arrival during the wait is never invisible until restart.
    if (shownConversation !== null) {
      const refreshed = renderConversationHistory(await conversationWindow());
      if (refreshed !== shownConversation) {
        out(`${refreshed}\n`);
        shownConversation = refreshed;
      }
    }
    out('> ');
    const line = await options.stdin.readLine();
    if (line === null) {
      out('\n');
      return { code, degraded, responses };
    }
    if (line.trim() === '') continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_SPEAK_BYTES) {
      err(`error: a message cannot exceed ${MAX_SPEAK_BYTES} bytes; not sent\n`);
      continue;
    }
    let appended: ChatAppended;
    try {
      appended = await writer.append(line, now());
    } catch (error) {
      err(`error: ${error instanceof Error ? error.message : 'the message was not saved'}\n`);
      out('\n');
      return { code: 1, degraded, responses };
    }
    if (!(await overlayConfigured(options.home))) {
      out(`${CHAT_ABSENT_OVERLAY_NOTICE}\n`);
      continue;
    }
    const outcome = await waitForResponse(options.home, appended.offset + appended.bytes, {
      out,
      now,
      timeoutMs: options.waitTimeoutMs ?? CHAT_WAIT_TIMEOUT_MS,
      pollMs: options.waitPollMs ?? CHAT_WAIT_POLL_MS,
      noteMs: options.waitNoteMs ?? CHAT_WAIT_NOTE_MS,
      ...(options.waitSignal !== undefined ? { signal: options.waitSignal } : {}),
    });
    switch (outcome.kind) {
      case 'response':
        responses += outcome.records.length;
        for (const record of outcome.records) out(`${renderChatRecord(record)}\n`);
        break;
      case 'timeout':
        out(`${CHAT_TIMEOUT_NOTICE}\n`);
        break;
      case 'interrupted':
        out(`${CHAT_INTERRUPTED_NOTICE}\n`);
        break;
    }
  }
}

/** The session's home gate: the one refusal, mapped to exit 2 by the CLI. */
async function assertChatHome(home: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(home);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      throw new HostConfigError('home does not exist; run init');
    }
    throw error;
  }
  if (!entry.isDirectory()) throw new HostConfigError(`home must be a directory: ${home}`);
}

/**
 * The absent-overlay probe: the charter sidecar's PRESENCE (the residual is
 * that a configured-but-stopped host passes it; the wait timeout is the
 * backstop). A raw fs fault other than absence propagates — it is the home
 * probe's class, not a "no overlay" fact.
 */
async function overlayConfigured(home: string): Promise<boolean> {
  try {
    await lstat(join(home, GATEWAY_CHARTER_FILE));
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
}

/** The bounded wait's one read/poll/note loop, with the SIGINT abort installed. */
async function waitForResponse(
  home: string,
  from: number,
  options: {
    readonly out: (text: string) => void;
    readonly now: () => number;
    readonly timeoutMs: number;
    readonly pollMs: number;
    readonly noteMs: number;
    readonly signal?: AbortSignal;
  },
): Promise<WaitOutcome> {
  const controller = new AbortController();
  const onAbort = (): void => { controller.abort(); };
  // Ctrl-C aborts the WAIT, not the session: a process-level listener replaces
  // the default terminate, and it is removed as soon as the wait ends.
  process.on('SIGINT', onAbort);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const deadline = options.now() + Math.max(0, options.timeoutMs);
    let nextNote = options.now() + Math.max(1, options.noteMs);
    for (;;) {
      if (controller.signal.aborted) return { kind: 'interrupted' };
      const records = await readChatSince(home, from);
      if (records.length > 0) return { kind: 'response', records };
      const remaining = deadline - options.now();
      if (remaining <= 0) return { kind: 'timeout' };
      await sleep(Math.min(options.pollMs, remaining), controller.signal);
      if (controller.signal.aborted) return { kind: 'interrupted' };
      if (options.now() >= nextNote) {
        options.out(`${CHAT_STILL_WAITING}\n`);
        nextNote = options.now() + Math.max(1, options.noteMs);
      }
    }
  } finally {
    process.off('SIGINT', onAbort);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Sleeps, resolving early when `signal` aborts (the wait's Ctrl-C path). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => { done(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
