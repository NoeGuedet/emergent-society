import { Buffer } from 'node:buffer';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantProjection } from '../../context/contracts.js';
import { GATEWAY_ADDRESSEE, HUMAN_AUTHOR } from '../../journal/index.js';
import { ConversationLog } from '../../node/conversation.js';
import { createHostLog } from '../observe.js';
import { OverlayService } from '../../overlay/service.js';
import { GATEWAY_CHARTER_FILE } from '../../overlay/charter.js';
import type { SendPlan, SendResult } from '../../provider/adapter.js';
import { UNRENDERABLE_INSTANT } from '../../util.js';
import { HostConfigError } from '../errors.js';
import {
  CHAT_ABSENT_OVERLAY_NOTICE, CHAT_FILE, CHAT_INTERRUPTED_NOTICE, CHAT_LOCK_FILE,
  CHAT_STILL_WAITING, CHAT_TIMEOUT_NOTICE, ChatLog, ChatWriteError, ChatWriter,
  createProcessStdin, parseChatLineOrNull, readChat, readChatHistory, readChatSince,
  readChatWindow, renderChatHistory, renderChatRecord, runChatSession,
  type ChatStdin,
} from '../chat.js';

/**
 * The chat log (G4): the human↔overlay surface.
 *
 * The writer/lock units — the human's `ChatWriter` under `<home>/.es/chat.lock`,
 * the torn-tail termination, the three cross-process writers' interleave — and
 * the interactive session: type → the record lands → the host-side ChatWatcher
 * triggers the overlay's cycle → the response renders; the bounded wait and
 * its timeout; the absent overlay; Ctrl-C aborting the wait only; the
 * non-TTY/EOF scripted read; and the tolerant `--conversation`/`--json` reads.
 */

const dirs: string[] = [];
const chats: ChatLog[] = [];
const services: OverlayService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop().catch(() => {});
  for (const chat of chats.splice(0)) await chat.close().catch(() => {});
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'es-chat-'));
  dirs.push(dir);
  return dir;
}

function line(uid: string, text: string, at = 1): string {
  return `${JSON.stringify({ v: 0, at, uid, text })}\n`;
}

async function configured(home: string): Promise<void> {
  await writeFile(join(home, GATEWAY_CHARTER_FILE), 'You are the gateway overlay.\n',
    { encoding: 'utf8', mode: 0o600 });
}

type ScriptedStdin = ChatStdin & { readonly reads: () => number };

function scriptedStdin(lines: readonly string[], isTTY = true): ScriptedStdin {
  let index = 0;
  let reads = 0;
  return {
    isTTY,
    reads: () => reads,
    async readLine(): Promise<string | null> {
      reads += 1;
      if (index >= lines.length) return null;
      const value = lines[index]!;
      index += 1;
      return value;
    },
  };
}

function sink(): { readonly write: (text: string) => void; readonly text: () => string } {
  let buffer = '';
  return { write: (text: string) => { buffer += text; }, text: () => buffer };
}

/**
 * One scripted overlay service: the real cycle + watchers, a scripted model.
 * `onSend` runs inside a cycle's send (0-based cycle order), the seam a test
 * uses to make a side effect land while the gateway is generating its reply.
 */
function overlayService(
  home: string, chat: ChatLog, replies: readonly string[],
  onSend?: (sendIndex: number) => Promise<void>,
): { readonly service: OverlayService; readonly plans: SendPlan[] } {
  const plans: SendPlan[] = [];
  let index = 0;
  const service = new OverlayService({
    home,
    config: { model: 'test-model', charter: 'You are the gateway overlay.' },
    chat,
    conversation: ConversationLog.for(home),
    world: { path: join(home, 'world'), gitBaseArgs: () => [] },
    send: async (plan: SendPlan): Promise<SendResult> => {
      plans.push(plan);
      const sendIndex = index;
      index += 1;
      await onSend?.(sendIndex);
      const text = replies[Math.min(sendIndex, replies.length - 1)]!;
      const message: AssistantProjection['message'] = {
        role: 'assistant', content: text, tool_calls: [],
      };
      return {
        kind: 'response',
        projection: { message, contentTruncated: false, frontierCall: 'call-1' },
      };
    },
    log: createHostLog(() => {}),
    pollMs: 25,
  });
  return { service, plans };
}

describe('ChatWriter: the human record under chat.lock', () => {
  it('appends {v:0, at, uid:human, text} 0600 and creates the lock sidecar', async () => {
    const dir = await home();
    const sent = await ChatWriter.for(dir).append('hello overlay', 1_000);
    expect(sent.offset).toBe(0);
    const path = join(dir, CHAT_FILE);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, '.es', CHAT_LOCK_FILE))).isFile()).toBe(true);
    const raw = await readFile(path, 'utf8');
    expect(raw).toBe(`${JSON.stringify({ v: 0, at: 1_000, uid: HUMAN_AUTHOR, text: 'hello overlay' })}\n`);
    const history = await readChatHistory(dir);
    expect(history.records).toEqual([{ v: 0, at: 1_000, uid: HUMAN_AUTHOR, text: 'hello overlay' }]);
    expect(history.degraded).toBe(0);
  });

  it('validates the record before any filesystem effect', async () => {
    const dir = await home();
    const writer = ChatWriter.for(dir);
    await expect(writer.append('   ')).rejects.toThrow(/cannot be blank/);
    await expect(writer.append('x'.repeat(8193))).rejects.toThrow(/cannot exceed 8192 bytes/);
    await expect(writer.append('ok', Number.NaN)).rejects.toThrow(/finite at/);
    await expect(stat(join(dir, CHAT_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dir, '.es'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps an unavailable lock sidecar to the fixed path-free refusal', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const dir = await home();
    await chmod(dir, 0o500);
    try {
      const result = await ChatWriter.for(dir).append('hello').catch((err: unknown) => err);
      expect(result).toBeInstanceOf(ChatWriteError);
      const message = (result as Error).message;
      expect(message).not.toContain(dir);
      expect(message).not.toContain('EACCES');
      expect(message).toContain('kernel-owned lock sidecar');
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('a directory at the chat path is the same fixed path-free refusal', async () => {
    const dir = await home();
    await mkdir(join(dir, CHAT_FILE));
    const result = await ChatWriter.for(dir).append('hello').catch((err: unknown) => err);
    expect(result).toBeInstanceOf(ChatWriteError);
    expect((result as Error).message).toBe('the chat log could not be written');
  });

  it('terminates a torn tail first: one droppable degraded line, the record never glued', async () => {
    const dir = await home();
    const path = join(dir, CHAT_FILE);
    const torn = '{"v":0,"at":1,"uid":"human","text":"tor';
    await writeFile(path, torn, { encoding: 'utf8', mode: 0o600 });
    const sent = await ChatWriter.for(dir).append('after the crash', 2);
    // The termination is one byte before the record: the fragment stays its own
    // complete (and unusable) line, and the new record starts after the newline.
    expect(sent.offset).toBe(Buffer.byteLength(torn, 'utf8') + 1);
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain(`${torn}\n`);
    expect(raw.endsWith('\n')).toBe(true);
    const history = await readChatHistory(dir);
    expect(history.records.map((record) => record.text)).toEqual(['after the crash']);
    // The terminated scar is a complete but unreadable line: reported, not fatal.
    expect(history.degraded).toBe(1);
  });

  it('serializes the three cross-process writers on chat.lock around a torn tail', async () => {
    const dir = await home();
    const path = join(dir, CHAT_FILE);
    const chat = await ChatLog.open(dir);
    chats.push(chat);
    // Seed a crash fragment AFTER the open (the boot repair would drop it): the
    // writers themselves must terminate it under the lock. Without chat.lock,
    // two racers can both see a missing trailing newline and each prepend one,
    // leaving a blank line between the fragment and the records.
    const torn = '{"v":0,"at":1,"uid":"human","text":"tor';
    await writeFile(path, torn, { encoding: 'utf8', mode: 0o600 });
    const writer = ChatWriter.for(dir);
    // The three writers race: the cycle (ChatLog), the session and direct.
    const [one, two] = await Promise.all([
      writer.append('typed in the session', 2),
      writer.append('sent by direct', 3),
      chat.append(GATEWAY_ADDRESSEE, 'delivered by the cycle', 4),
    ]);
    const raw = await readFile(path, 'utf8');
    // The termination newline appears EXACTLY ONCE, directly after the
    // fragment; the fragment is its own droppable line, never glued.
    expect(raw.startsWith(`${torn}\n`)).toBe(true);
    expect(raw.split(torn)).toHaveLength(2);
    const lines = raw.split('\n');
    expect(lines.pop()).toBe(''); // our writer always terminates
    expect(lines).toHaveLength(4); // the torn fragment + the three records
    expect(lines[0]).toBe(torn);
    expect(lines.filter((entry) => entry === '')).toHaveLength(0); // no second termination
    // Every record is complete, unique and starts after the termination. The
    // two ChatWriter appends report their own line's start offset;
    // ChatLog.append returns no offset (the cycle's line is observed here).
    const starts = new Map<string, number>();
    let offset = Buffer.byteLength(torn, 'utf8') + 1; // after the termination
    for (const entry of lines.slice(1)) {
      const record = JSON.parse(entry) as { readonly text: string };
      starts.set(record.text, offset);
      offset += Buffer.byteLength(entry, 'utf8') + 1;
    }
    expect([...starts.keys()].sort())
      .toEqual(['delivered by the cycle', 'sent by direct', 'typed in the session']);
    expect(one.offset).toBe(starts.get('typed in the session'));
    expect(two.offset).toBe(starts.get('sent by direct'));
    for (const start of starts.values()) {
      expect(start).toBeGreaterThan(Buffer.byteLength(torn, 'utf8'));
    }
    // The readers see the fragment as exactly one droppable degraded line.
    const history = await readChatHistory(dir);
    expect(history.records).toHaveLength(3);
    expect(history.degraded).toBe(1);
  });

  it('refuses an actor outside the conversation rule before any write', async () => {
    const dir = await home();
    const chat = await ChatLog.open(dir);
    chats.push(chat);
    await expect(chat.append('bad uid', 'x', 1)).rejects.toThrow(/uid/);
    await expect(stat(join(dir, CHAT_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('ChatLog.open: the host-only boot repair under the lock', () => {
  it('truncates one incomplete trailing fragment and creates nothing for a missing log', async () => {
    const dir = await home();
    const path = join(dir, CHAT_FILE);
    await writeFile(path, `${line('human', 'kept')}torn`, { encoding: 'utf8', mode: 0o600 });
    const chat = await ChatLog.open(dir);
    chats.push(chat);
    expect(await readFile(path, 'utf8')).toBe(line('human', 'kept'));
    // A clean log is untouched; a missing one is a new cell.
    await chat.close();
    const clean = await home();
    const cleanLog = await ChatLog.open(clean);
    chats.push(cleanLog);
    await expect(stat(join(clean, CHAT_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(clean, '.es'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('truncates a log that is nothing but one torn first append: the host still boots', async () => {
    const dir = await home();
    const path = join(dir, CHAT_FILE);
    // The chat log's own precedent (the whole file is the torn first append —
    // no newline anywhere in the repair window): truncate to zero instead of
    // making a boot impossible. The conversation stream keeps its refusal.
    const torn = '{"v":0,"at":1,"uid":"human","text":"tor';
    await writeFile(path, torn, { encoding: 'utf8', mode: 0o600 });
    const chat = await ChatLog.open(dir);
    chats.push(chat);
    expect((await stat(path)).size).toBe(0);
    // The booted home appends cleanly afterwards.
    await chat.append(HUMAN_AUTHOR, 'after the repair', 2);
    const history = await readChatHistory(dir);
    expect(history.records.map((record) => record.text)).toEqual(['after the repair']);
    expect(history.degraded).toBe(0);
  });

  it('does not truncate a no-newline file larger than the repair window', async () => {
    const dir = await home();
    const path = join(dir, CHAT_FILE);
    // Beyond the helper's 64 KiB tail window: refused, never truncated blindly.
    const fragment = 'x'.repeat(64 * 1024 + 1);
    await writeFile(path, fragment, { encoding: 'utf8', mode: 0o600 });
    await expect(ChatLog.open(dir)).rejects.toBeInstanceOf(ChatWriteError);
    expect((await stat(path)).size).toBe(fragment.length);
  });
});

describe('the tolerant readers and the renderers', () => {
  it('renders both sides interleaved with the ISO-8601 UTC stamp', async () => {
    const dir = await home();
    await writeFile(join(dir, CHAT_FILE),
      line(HUMAN_AUTHOR, 'first', Date.UTC(2026, 0, 2, 3, 4, 5))
      + line(GATEWAY_ADDRESSEE, 'second', Date.UTC(2026, 0, 2, 3, 4, 6)),
      { encoding: 'utf8', mode: 0o600 });
    const history = await readChatHistory(dir);
    expect(history.records.map((record) => record.uid)).toEqual([HUMAN_AUTHOR, GATEWAY_ADDRESSEE]);
    const rendered = renderChatHistory(history);
    expect(rendered).toContain('[2026-01-02T03:04:05.000Z] human: first');
    expect(rendered).toContain('[2026-01-02T03:04:06.000Z] gateway: second');
    expect(renderChatRecord({ v: 0, at: 0, uid: HUMAN_AUTHOR, text: 'x' }))
      .toBe('[1970-01-01T00:00:00.000Z] human: x');
  });

  it('drops a torn tail and reports a corrupt interior record as degraded', async () => {
    const dir = await home();
    await writeFile(join(dir, CHAT_FILE),
      line(HUMAN_AUTHOR, 'kept', 1) + 'not json\n' + line(GATEWAY_ADDRESSEE, 'after', 2)
      + '{"v":0,"at":3,"uid":"hum',
      { encoding: 'utf8', mode: 0o600 });
    const history = await readChatHistory(dir);
    expect(history.records.map((record) => record.text)).toEqual(['kept', 'after']);
    expect(history.degraded).toBe(1);
    expect(history.older).toBe(false);
    expect(renderChatHistory(history)).toContain('(degraded: 1 unreadable chat record skipped)');
    // The `at` finite guard is a degraded record, never a rendered one.
    await writeFile(join(dir, CHAT_FILE), '{"v":0,"at":"soon","uid":"human","text":"x"}\n',
      { encoding: 'utf8', mode: 0o600 });
    const guarded = await readChatHistory(dir);
    expect(guarded.records).toEqual([]);
    expect(guarded.degraded).toBe(1);
    expect(parseChatLineOrNull('{"v":0,"at":1,"uid":"bad uid","text":"x"}')).toBeNull();
  });

  it('bounds the history with --tail and says older records exist', async () => {
    const dir = await home();
    await writeFile(join(dir, CHAT_FILE),
      [1, 2, 3, 4, 5].map((n) => line(HUMAN_AUTHOR, `m${n}`, n)).join(''),
      { encoding: 'utf8', mode: 0o600 });
    const windowed = await readChatHistory(dir, 2);
    expect(windowed.records.map((record) => record.text)).toEqual(['m4', 'm5']);
    expect(windowed.older).toBe(true);
    expect(renderChatHistory(windowed))
      .toContain('(older records exist — this window shows the newest 2)');
    const all = await readChatHistory(dir, 5);
    expect(all.older).toBe(false);
    expect(renderChatHistory(all)).not.toContain('older records exist');
    // The overlay's window reader shares the tail read and its tolerance.
    expect((await readChatWindow(dir, 2)).map((record) => record.text)).toEqual(['m4', 'm5']);
    expect(await readChatWindow(await home(), 4)).toEqual([]);
  });

  it('reads only gateway records at or after the typed record\'s offset', async () => {
    const dir = await home();
    const first = await ChatWriter.for(dir).append('typed', 1);
    await writeFile(join(dir, CHAT_FILE),
      line(GATEWAY_ADDRESSEE, 'delivered', 2), { flag: 'a', mode: 0o600 });
    expect((await readChatSince(dir, first.offset + first.bytes)).map((record) => record.text))
      .toEqual(['delivered']);
    // Nothing after the offset: the wait's empty read.
    expect(await readChatSince(dir, (await stat(join(dir, CHAT_FILE))).size)).toEqual([]);
  });

  it('never throws on a finite but unrenderable at (the fixed stamp, degraded)', async () => {
    const dir = await home();
    const far = 1e16; // finite, beyond the Date range (±8.64e15)
    await writeFile(join(dir, CHAT_FILE),
      `${JSON.stringify({ v: 0, at: far, uid: HUMAN_AUTHOR, text: 'far future' })}\n`,
      { encoding: 'utf8', mode: 0o600 });
    const history = await readChatHistory(dir);
    // The text is kept; the stamp is the fixed unrenderable one; the line is
    // reported degraded (the status precedent) rather than throwing.
    expect(history.records.map((record) => record.text)).toEqual(['far future']);
    expect(history.degraded).toBe(1);
    const rendered = renderChatHistory(history);
    expect(rendered).toContain(`[${UNRENDERABLE_INSTANT}] human: far future`);
    expect(rendered).toContain('(degraded: 1 unreadable chat record skipped)');
    expect(renderChatRecord({ v: 0, at: far, uid: GATEWAY_ADDRESSEE, text: 'x' }))
      .toBe('[(unrenderable time)] gateway: x'); // the response render is tolerant too
    // The raw conversation render tolerates it in the same session read.
    await ConversationLog.for(dir).append('n1', undefined, 'far conversation', far);
    const out = sink();
    const result = await runChatSession({
      home: dir, stdin: scriptedStdin([], false), conversation: true, stdout: out.write,
    });
    expect(result.code).toBe(1);
    expect(out.text()).toContain('(unrenderable time)] from n1 to gateway');
    expect(out.text()).toContain('far conversation');
  });
});

describe('the interactive session', () => {
  it('types → the record lands → the cycle fires → the response renders', async () => {
    const dir = await home();
    await configured(dir);
    const chat = await ChatLog.open(dir);
    chats.push(chat);
    const { service, plans } = overlayService(dir, chat, ['ready.', 'hello there.']);
    services.push(service);
    service.start();
    // The boot cycle digests the backlog (and delivers its own record).
    await service.idle();
    expect(plans).toHaveLength(1);
    expect((await readChat(dir)).map((record) => record.uid)).toEqual([GATEWAY_ADDRESSEE]);

    const out = sink();
    const stdin = scriptedStdin(['hello gateway']);
    const result = await runChatSession({
      home: dir, stdin, stdout: out.write, stderr: sink().write,
      waitTimeoutMs: 10_000, waitPollMs: 20, waitNoteMs: 1_000,
    });
    expect(result.code).toBe(0);
    expect(result.responses).toBe(1);
    // The response rendered after the history.
    const text = out.text();
    expect(text).toContain('gateway: ready.');
    expect(text).toContain('gateway: hello there.');
    expect(text.indexOf('ready.')).toBeLessThan(text.indexOf('hello there.'));
    // The record landed in the log as a human record, the cycle's reply after it.
    expect((await readChat(dir)).map((record) => [record.uid, record.text])).toEqual([
      [GATEWAY_ADDRESSEE, 'ready.'],
      [HUMAN_AUTHOR, 'hello gateway'],
      [GATEWAY_ADDRESSEE, 'hello there.'],
    ]);
    // The cycle fired on the human arrival and its chat window carried the words.
    expect(plans).toHaveLength(2);
    expect(JSON.stringify(plans[1]!.history)).toContain('hello gateway');
    // The prompt loop returned to the prompt: it read the line, then EOF.
    expect(stdin.reads()).toBe(2);
  });

  it('re-renders the raw conversation stream before each prompt: a mid-session relay appears', async () => {
    const dir = await home();
    await configured(dir);
    const chat = await ChatLog.open(dir);
    chats.push(chat);
    const conversation = ConversationLog.for(dir);
    // The stream already holds a node's question when the session opens, so the
    // OPEN render shows the raw view; nothing else is there yet.
    await conversation.append('n1', GATEWAY_ADDRESSEE, 'a question from the node', 1);
    const { service } = overlayService(dir, chat, ['ready.', 'hello there.'], async (sendIndex) => {
      // The human-triggered cycle (index 1): the overlay relays to the node
      // while it generates the reply. The record lands after the open render
      // and before the next prompt's refresh.
      if (sendIndex !== 1) return;
      await conversation.append(GATEWAY_ADDRESSEE, 'n1', 'relayed mid-session', 3);
    });
    services.push(service);
    service.start();
    await service.idle();

    const out = sink();
    const stdin = scriptedStdin(['hello gateway']);
    const result = await runChatSession({
      home: dir, stdin, stdout: out.write, stderr: sink().write,
      conversation: true,
      waitTimeoutMs: 10_000, waitPollMs: 20, waitNoteMs: 1_000,
    });
    expect(result.code).toBe(0);
    expect(result.responses).toBe(1);
    const text = out.text();
    // Two renders, same renderer and bounds: the open one and the refresh at
    // the second prompt. The relay is absent from the first and present in the
    // second, which lands after the first prompt's response render.
    const blocks = text.split('conversation stream (nodes ↔ overlay), oldest first:');
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain('a question from the node');
    expect(blocks[1]).not.toContain('relayed mid-session');
    expect(blocks[2]).toContain('a question from the node');
    expect(blocks[2]).toContain('relayed mid-session');
    const relayAt = text.indexOf('relayed mid-session');
    expect(relayAt).toBeGreaterThan(text.indexOf('hello there.'));
    expect(relayAt).toBeLessThan(text.lastIndexOf('> '));
  });

  it('returns to the prompt after the bounded wait: the timeout notice, the message saved', async () => {
    const dir = await home();
    await configured(dir);
    const out = sink();
    const stdin = scriptedStdin(['is anyone there']);
    const result = await runChatSession({
      home: dir, stdin, stdout: out.write, stderr: sink().write,
      waitTimeoutMs: 180, waitPollMs: 20, waitNoteMs: 50,
    });
    expect(result.code).toBe(0);
    expect(out.text()).toContain(CHAT_STILL_WAITING);
    expect(out.text()).toContain(CHAT_TIMEOUT_NOTICE);
    expect(out.text()).not.toContain(CHAT_ABSENT_OVERLAY_NOTICE);
    // The message stays saved; the boot cycle digests it when the overlay appears.
    expect((await readChat(dir)).map((record) => record.text)).toEqual(['is anyone there']);
    expect(stdin.reads()).toBe(2);
  });

  it('Ctrl-C aborts the WAIT, not the session: the next prompt still reads', async () => {
    const dir = await home();
    await configured(dir);
    const controller = new AbortController();
    const stdin = scriptedStdin(['hello', '']);
    const out = sink();
    const timer = setTimeout(() => controller.abort(), 60);
    try {
      const result = await runChatSession({
        home: dir, stdin, stdout: out.write, stderr: sink().write,
        waitTimeoutMs: 10_000, waitPollMs: 20, waitNoteMs: 1_000,
        waitSignal: controller.signal,
      });
      expect(result.code).toBe(0);
      expect(out.text()).toContain(CHAT_INTERRUPTED_NOTICE);
      // The session survived the interrupt: it re-prompted and read to EOF.
      expect(stdin.reads()).toBe(3);
      expect((await readChat(dir)).map((record) => record.uid)).toEqual([HUMAN_AUTHOR]);
    } finally {
      clearTimeout(timer);
    }
  });

  it('detects the absent overlay up front and saves the message anyway', async () => {
    const dir = await home();
    const out = sink();
    const stdin = scriptedStdin(['saved for later']);
    const result = await runChatSession({
      home: dir, stdin, stdout: out.write, stderr: sink().write,
      waitTimeoutMs: 10_000, waitPollMs: 20, waitNoteMs: 1_000,
    });
    expect(result.code).toBe(0);
    // No sidecar: the notice is immediate, never a wait and never a refusal.
    expect(out.text()).toContain(CHAT_ABSENT_OVERLAY_NOTICE);
    expect(out.text()).not.toContain(CHAT_STILL_WAITING);
    expect(stdin.reads()).toBe(2);
    expect((await readChat(dir)).map((record) => [record.uid, record.text]))
      .toEqual([[HUMAN_AUTHOR, 'saved for later']]);
  });

  it('re-prompts on a blank line and refuses an oversize message without sending it', async () => {
    const dir = await home();
    await configured(dir);
    const err = sink();
    const stdin = scriptedStdin(['   ', 'x'.repeat(8193), 'saved']);
    const result = await runChatSession({
      home: dir, stdin, stdout: sink().write, stderr: err.write,
      waitTimeoutMs: 120, waitPollMs: 20, waitNoteMs: 1_000,
    });
    expect(result.code).toBe(0);
    expect((await readChat(dir)).map((record) => record.text)).toEqual(['saved']);
    expect(err.text()).toContain('cannot exceed 8192 bytes');
  });

  it('a non-TTY stdin renders the history and exits without reading', async () => {
    const dir = await home();
    await writeFile(join(dir, CHAT_FILE), line('human', 'scripted read', 1),
      { encoding: 'utf8', mode: 0o600 });
    const stdin = scriptedStdin(['never read'], false);
    const out = sink();
    const result = await runChatSession({ home: dir, stdin, stdout: out.write, stderr: sink().write });
    expect(result.code).toBe(0);
    expect(stdin.reads()).toBe(0);
    expect(out.text()).toContain('human: scripted read');
    expect(out.text()).not.toContain('> ');
    // An empty log says so, and a missing home is the one refusal.
    const fresh = await home();
    const empty = sink();
    expect((await runChatSession({
      home: fresh, stdin: scriptedStdin([], false), stdout: empty.write,
    })).code).toBe(0);
    expect(empty.text()).toContain('(no chat records yet)');
    await expect(runChatSession({ home: join(dir, 'nope'), stdin: scriptedStdin([]) }))
      .rejects.toBeInstanceOf(HostConfigError);
  });

  it('a degraded history renders what it can and exits 1 (the status precedent)', async () => {
    const dir = await home();
    await writeFile(join(dir, CHAT_FILE), `${line('human', 'kept', 1)}not json\n`,
      { encoding: 'utf8', mode: 0o600 });
    const out = sink();
    const result = await runChatSession({
      home: dir, stdin: scriptedStdin([], false), stdout: out.write,
    });
    expect(result.code).toBe(1);
    expect(result.degraded).toBe(true);
    expect(out.text()).toContain('human: kept');
    expect(out.text()).toContain('degraded: 1 unreadable chat record skipped');
  });
});

describe('the one-shot reads: --conversation and --json', () => {
  it('renders the raw conversation stream beside the chat, read-only', async () => {
    const dir = await home();
    await ChatWriter.for(dir).append('my words', 1);
    const conversation = ConversationLog.for(dir);
    await conversation.append('n1', undefined, 'the world is on fire', 2);
    await conversation.append(GATEWAY_ADDRESSEE, 'n1', 'noted', 3);
    const out = sink();
    const result = await runChatSession({
      home: dir, stdin: scriptedStdin([], false), conversation: true, stdout: out.write,
    });
    expect(result.code).toBe(0);
    const text = out.text();
    expect(text).toContain('conversation stream (nodes ↔ overlay), oldest first:');
    expect(text).toContain('from n1 to gateway');
    expect(text).toContain('the world is on fire');
    expect(text).toContain('from gateway to n1');
    // Read-only: the chat render came first, the conversation was not written.
    expect(text.indexOf('my words')).toBeLessThan(text.indexOf('conversation stream'));
    expect(await readChatHistory(dir).then((history) => history.records)).toHaveLength(1);
  });

  it('prints the chat records as JSON and exits (and the raw stream when asked)', async () => {
    const dir = await home();
    await writeFile(join(dir, CHAT_FILE),
      line(HUMAN_AUTHOR, 'one', 1) + line(GATEWAY_ADDRESSEE, 'two', 2),
      { encoding: 'utf8', mode: 0o600 });
    await ConversationLog.for(dir).append('n1', undefined, 'a question', 3);
    const plain = sink();
    const result = await runChatSession({
      home: dir, stdin: scriptedStdin(['never read'], false), json: true, stdout: plain.write,
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(plain.text()) as {
      records: { uid: string; text: string }[];
      conversation: unknown;
    };
    expect(parsed.records.map((record) => record.text)).toEqual(['one', 'two']);
    expect(parsed.conversation).toBeNull();

    const both = sink();
    const withStream = await runChatSession({
      home: dir, stdin: scriptedStdin([], false), json: true, conversation: true,
      stdout: both.write,
    });
    expect(withStream.code).toBe(0);
    const parsedBoth = JSON.parse(both.text()) as {
      conversation: { from: string; text: string }[] | null;
    };
    expect(parsedBoth.conversation?.map((record) => record.text)).toEqual(['a question']);
  });
});

it('the process stdin reader is the production seam for the session', () => {
  const stdin = createProcessStdin();
  expect(typeof stdin.readLine).toBe('function');
  expect(typeof stdin.isTTY).toBe('boolean');
});
