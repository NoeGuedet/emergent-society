import { open, stat, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JournalClosedError, assertConversationActor, isErrno, readFileOrNull, syncPath,
} from '../journal/index.js';
import { MAX_SPEAK_BYTES } from '../node/conversation.js';

/**
 * The human channel's chat log (`chat.v0.jsonl`): the human↔overlay
 * conversation, outside the world.
 *
 * The channel is the conversation's human-side surface — one of the sanctioned
 * interface exceptions to "communication is a file" (the human has no file to
 * read). The log is kernel-owned, mode 0600 and append-only, with one
 * `{v, at, uid, text}` line per record; `uid` follows the conversation actor
 * rule (a node uid, the reserved `human`, or the reserved `gateway`). The node
 * offering carries no `speak` verb: its successor is the overlay's native chat.
 * The DELIVERY half is implemented (the overlay's cycle appends one response
 * record per cycle); the human's own writing surface (the interactive `chat`
 * session and the `direct` batch act) is specified, not implemented. A torn
 * tail from a crash inside one append is dropped at open, exactly like the
 * attribution sidecar's.
 */

/** The chat log's file name inside the cell home. */
export const CHAT_FILE = 'chat.v0.jsonl';

/** The bounded tail window a chat window read scans: never the whole log. */
export const MAX_CHAT_READ_BYTES = 1024 * 1024;

/** One delivered message. */
export type ChatMessage = {
  readonly v: 0;
  readonly at: number;
  readonly uid: string;
  readonly text: string;
};

/**
 * The kernel's append-only chat writer. The handle is opened on the first
 * message; every append is one `O_APPEND` write followed by one `fsync`, and
 * the directory entry is made durable when the file is created.
 */
export class ChatLog {
  private handle: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;
  private closed = false;

  private constructor(private readonly dir: string, private readonly path: string) {}

  /** Opens the home's chat log, dropping a torn trailing fragment. */
  static async open(home: string): Promise<ChatLog> {
    const path = join(home, CHAT_FILE);
    const raw = await readFileOrNull(path);
    if (raw !== null && raw.length > 0) {
      const complete = raw.lastIndexOf(0x0a) + 1;
      if (complete < raw.length) await truncate(path, complete);
    }
    return new ChatLog(home, path);
  }

  /** Appends one message and makes it durable before returning. */
  async append(uid: string, text: string, at: number): Promise<void> {
    if (this.closed) throw new JournalClosedError();
    const actor = assertConversationActor(uid);
    if (text.trim() === '') throw new Error('a chat message cannot be blank');
    if (Buffer.byteLength(text, 'utf8') > MAX_SPEAK_BYTES) {
      throw new Error(`a chat message cannot exceed ${MAX_SPEAK_BYTES} bytes`);
    }
    const handle = await this.file();
    const line = JSON.stringify({ v: 0, at, uid: actor, text }) + '\n';
    await handle.write(line, null, 'utf8');
    await handle.sync();
  }

  /** Closes the handle; idempotent, the bytes are already durable. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.handle === null) return;
    const handle = this.handle;
    this.handle = null;
    await handle.close();
  }

  private async file(): Promise<FileHandle> {
    if (this.handle !== null) return this.handle;
    if (this.opening === null) this.opening = this.openHandle();
    return this.opening;
  }

  private async openHandle(): Promise<FileHandle> {
    try {
      const created = !(await pathExists(this.path));
      const handle = await open(this.path, 'a', 0o600);
      try {
        if (created) await syncPath(this.dir);
      } catch (err) {
        await handle.close().catch(() => {});
        throw err;
      }
      if (this.closed) {
        await handle.close().catch(() => {});
        throw new JournalClosedError();
      }
      this.handle = handle;
      return handle;
    } finally {
      this.opening = null;
    }
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
 * The chat log's last n records, from a bounded TAIL read.
 *
 * The cycle's chat window uses this: the read starts at most `maxBytes` before
 * EOF, drops a leading fragment when it starts mid-record, and skips a complete
 * line that does not parse (a crash fragment the next writer terminated). A
 * torn trailing fragment is never a record. Missing file = an empty log.
 */
export async function readChatWindow(
  home: string, n: number, maxBytes: number = MAX_CHAT_READ_BYTES,
): Promise<ChatMessage[]> {
  const limit = Number.isSafeInteger(n) && n > 0 ? n : 1;
  const path = join(home, CHAT_FILE);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return [];
    throw err;
  }
  if (size === 0) return [];
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
  const records: ChatMessage[] = [];
  for (const line of lines) {
    const record = parseChatLineOrNull(line);
    if (record !== null) records.push(record);
  }
  return records.slice(-limit);
}

/**
 * Parses one complete chat line tolerantly: a degraded line is `null`, never a
 * throw. The strict reader (`readChat`) keeps its own throwing form for the
 * scripted read; the cycle's window and the watcher share this one.
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await open(path, 'r').then((handle) => handle.close());
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}
