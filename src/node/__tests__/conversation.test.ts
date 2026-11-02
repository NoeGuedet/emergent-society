import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { GATEWAY_ADDRESSEE } from '../../journal/index.js';
import {
  CONVERSATION_FILE, CONVERSATION_FRAMING, ConversationLog, ConversationRefusedError,
  ConversationWriteError, MAX_SPEAK_BYTES, openConversationLog, readConversationThread,
  renderConversationThread,
} from '../conversation.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { UNRENDERABLE_INSTANT } from '../../util.js';
import { ChatLog, CHAT_FILE, readChat } from '../../host/chat.js';

/**
 * The conversation stream (A3): the append mechanics under the cross-process
 * flock, the kernel-stamped record, the boot repair, and the bounded thread
 * read — the interface's privacy filter and its degraded-line tolerance.
 */

const homes: string[] = [];

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'es-conversation-'));
  homes.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});

function recordsOf(text: string): Record<string, unknown>[] {
  return text.split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('ConversationLog: the append', () => {
  it('creates the stream 0600 and stamps the resolved addressee', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    const sent = await log.append('n1', undefined, 'hello gateway');
    expect(sent.to).toBe('gateway');
    expect(sent.offset).toBe(0);
    const path = join(dir, CONVERSATION_FILE);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const records = recordsOf(await readFile(path, 'utf8'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      v: 0, from: 'n1', to: 'gateway', text: 'hello gateway',
    });
    expect(Object.keys(records[0]!).sort()).toEqual(['at', 'from', 'text', 'to', 'v']);
    expect(Number.isFinite(records[0]!['at'] as number)).toBe(true);
    // The lock sidecar lives in the kernel-owned .es directory.
    expect((await stat(join(dir, '.es', 'conversation.lock'))).isFile()).toBe(true);
  });

  it('keeps an explicit gateway addressee and accepts the gateway as a sender', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    await log.append('gateway', 'n1', 'a reply');
    await log.append('n1', 'gateway', 'a question');
    const records = recordsOf(await readFile(join(dir, CONVERSATION_FILE), 'utf8'));
    expect(records.map((record) => [record['from'], record['to']])).toEqual([
      ['gateway', 'n1'],
      ['n1', 'gateway'],
    ]);
  });

  it('requires the gateway to name a node addressee, never itself or nothing', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    // The gateway's OWN send: to is required and must be a node; the gateway
    // can neither omit it nor address itself.
    await expect(log.append('gateway', undefined, 'to nobody'))
      .rejects.toBeInstanceOf(ConversationRefusedError);
    await expect(log.append('gateway', GATEWAY_ADDRESSEE, 'to myself'))
      .rejects.toBeInstanceOf(ConversationRefusedError);
    // The refusal precedes every filesystem effect.
    await expect(stat(join(dir, CONVERSATION_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dir, '.es'))).rejects.toMatchObject({ code: 'ENOENT' });
    // A node addressee is the gateway's one valid send direction.
    await expect(log.append('gateway', 'n1', 'a question'))
      .resolves.toMatchObject({ to: 'n1' });
  });

  it('maps an unavailable lock sidecar to the fixed path-free refusal', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const dir = await home();
    // A home the kernel cannot write: the .es creation fails with EACCES.
    await chmod(dir, 0o500);
    try {
      const result = await ConversationLog.for(dir).append('n1', undefined, 'hello')
        .catch((err: unknown) => err);
      expect(result).toBeInstanceOf(ConversationWriteError);
      const message = (result as Error).message;
      // The model-visible refusal never carries the absolute home path or the
      // raw errno.
      expect(message).not.toContain(dir);
      expect(message).not.toContain('EACCES');
      expect(message).toContain('kernel-owned lock sidecar');
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('a directory at the stream path is the same fixed path-free refusal', async () => {
    const dir = await home();
    // The helper's raw diagnostic for this case is
    // `EISDIR: ... open '<home>/conversation.v0.jsonl'`; the model-visible
    // refusal must carry neither the absolute path nor the file name.
    await mkdir(join(dir, CONVERSATION_FILE));
    const result = await ConversationLog.for(dir).append('n1', undefined, 'hello')
      .catch((err: unknown) => err);
    expect(result).toBeInstanceOf(ConversationWriteError);
    const message = (result as Error).message;
    expect(message).toBe('the conversation stream could not be written');
    expect(message).not.toContain(dir);
    expect(message).not.toContain(CONVERSATION_FILE);
    expect(message).not.toContain('/');
  });

  it('refuses blank, oversize, non-finite and reserved-name violations before any write', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    await expect(log.append('n1', undefined, '   ')).rejects.toThrow(/cannot be blank/);
    await expect(log.append('n1', undefined, 'x'.repeat(MAX_SPEAK_BYTES + 1)))
      .rejects.toThrow(/cannot exceed 8192 bytes/);
    await expect(log.append('n1', undefined, 'ok', Number.NaN))
      .rejects.toThrow(/finite at/);
    await expect(log.append('peer!', undefined, 'ok')).rejects.toThrow(/InvalidNodeUidError|uid/);
    await expect(log.append('n1', 'peer!', 'ok')).rejects.toThrow(/InvalidNodeUidError|uid/);
    // The human reads the chat log, never the conversation stream.
    await expect(log.append('n1', 'human', 'ok')).rejects.toThrow(/InvalidNodeUidError|addressee/);
    // Nothing was created: validation precedes the first filesystem effect.
    await expect(stat(join(dir, CONVERSATION_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('terminates a torn tail first: one droppable degraded line, the record never glued', async () => {
    const dir = await home();
    const path = join(dir, CONVERSATION_FILE);
    const torn = '{"v":0,"at":1,"from":"n1","to":"gatew';
    await writeFile(path, torn, 'utf8');
    const sent = await ConversationLog.for(dir).append('n1', undefined, 'after the crash');
    // The termination is one byte before the record: the fragment stays its own
    // complete (and unusable) line, and the new record starts after the newline.
    expect(sent.offset).toBe(Buffer.byteLength(torn, 'utf8') + 1);
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain(`${torn}\n`);
    const thread = await readConversationThread(dir, 'n1', 16);
    expect(thread.records.map((record) => record.text)).toEqual(['after the crash']);
  });

  it('drops the leading partial and the trailing torn record under a byte bound', async () => {
    const dir = await home();
    const path = join(dir, CONVERSATION_FILE);
    const a = JSON.stringify({ v: 0, at: 1, from: 'gateway', to: 'n1', text: `A${'a'.repeat(80)}` });
    const b = JSON.stringify({ v: 0, at: 2, from: 'gateway', to: 'n1', text: `B${'b'.repeat(10)}` });
    const torn = '{"v":0,"at":3,"from":"gateway","to":"n1","text":"tor';
    await writeFile(path, `${a}\n${b}\n${torn}`, 'utf8');
    // A window that starts inside line A and runs to EOF: the leading partial
    // line is dropped, and the unterminated tail is dropped too.
    const bound = Buffer.byteLength(`${b}\n${torn}`, 'utf8') + 5;
    const bounded = await readConversationThread(dir, 'n1', 16, bound);
    expect(bounded.records.map((record) => record.text)).toEqual([`B${'b'.repeat(10)}`]);
    expect(bounded.older).toBe(true);
    // A window from offset 0 keeps both complete records and still drops the
    // torn tail.
    const whole = await readConversationThread(dir, 'n1', 16, 1 << 20);
    expect(whole.records.map((record) => record.text))
      .toEqual([`A${'a'.repeat(80)}`, `B${'b'.repeat(10)}`]);
    expect(whole.older).toBe(false);
    // A one-byte window is all partial: no record is invented.
    const tiny = await readConversationThread(dir, 'n1', 16, 1);
    expect(tiny.records).toEqual([]);
    expect(tiny.older).toBe(true);
  });

  it('interleaves concurrent first openers with strictly increasing offsets', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    // Two appends race from two helper processes on a fresh home: the flock
    // serializes them, both create-or-open safely, and the offsets follow the
    // file order.
    const sent = await Promise.all([
      log.append('n1', undefined, 'first'),
      log.append('n2', undefined, 'second'),
    ]);
    const offsets = sent.map((entry) => entry.offset).sort((a, b) => a - b);
    expect(offsets[0]).not.toBe(offsets[1]);
    const raw = await readFile(join(dir, CONVERSATION_FILE), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    // Map each line's start offset and check the lower offset names the line
    // that actually starts there.
    const firstLine = raw.slice(0, raw.indexOf('\n'));
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(Buffer.byteLength(firstLine, 'utf8') + 1);
    expect(recordsOf(raw)).toHaveLength(2);
  });
});

describe('the boot repair (host-only)', () => {
  it('refuses a stream that is nothing but one torn fragment (the chat log is the truncating one)', async () => {
    const dir = await home();
    const path = join(dir, CONVERSATION_FILE);
    const fragment = '{"v":0,"at":1,"from":"n1","to":"gateway","text":"tor';
    await writeFile(path, fragment, 'utf8');
    // The conversation stream's records are kernel-stamped exchanges; a file
    // with no newline anywhere in the repair window is refused, never
    // truncated blindly. (The chat log has its own truncate-to-zero precedent.)
    await expect(openConversationLog(dir)).rejects.toBeInstanceOf(ConversationWriteError);
    expect(await readFile(path, 'utf8')).toBe(fragment);
  });

  it('truncates at most one incomplete trailing fragment under the lock', async () => {
    const dir = await home();
    const path = join(dir, CONVERSATION_FILE);
    await writeFile(path, '{"v":0,"at":1,"from":"n1","to":"gateway","text":"kept"}\ntrailing', 'utf8');
    await openConversationLog(dir);
    expect(await readFile(path, 'utf8'))
      .toBe('{"v":0,"at":1,"from":"n1","to":"gateway","text":"kept"}\n');
    // A clean stream is untouched, and a missing one creates nothing.
    const clean = await readFile(path, 'utf8');
    await openConversationLog(dir);
    expect(await readFile(path, 'utf8')).toBe(clean);
    const fresh = await home();
    await openConversationLog(fresh);
    await expect(stat(join(fresh, CONVERSATION_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(fresh, '.es'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('readConversationThread: the privacy filter and the guards', () => {
  it('returns only the records that involve the caller', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    await log.append('n1', undefined, 'one secret question');
    await log.append('gateway', 'n1', 'one answer');
    await log.append('n2', undefined, 'two secret question');
    await log.append('gateway', 'n2', 'two answer');
    const one = await readConversationThread(dir, 'n1', 16);
    expect(one.records.map((record) => record.text)).toEqual(['one secret question', 'one answer']);
    // A node never sees a peer's thread: no record names another participant.
    expect(one.records.every((record) => record.from === 'n1' || record.to === 'n1')).toBe(true);
    expect(one.records.map((record) => record.text)).not.toContain('two answer');
    const two = await readConversationThread(dir, 'n2', 16);
    expect(two.records.map((record) => record.text)).toEqual(['two secret question', 'two answer']);
  });

  it('keeps the human\'s words out of the stream entirely (the chat log is their home)', async () => {
    const dir = await home();
    const chat = await ChatLog.open(dir);
    await chat.append('human', 'my private words', 1);
    await chat.close();
    const log = ConversationLog.for(dir);
    await log.append('n1', undefined, 'public question');
    const stream = await readFile(join(dir, CONVERSATION_FILE), 'utf8');
    expect(stream).not.toContain('my private words');
    const chatText = await readFile(join(dir, CHAT_FILE), 'utf8');
    expect(chatText).toContain('my private words');
    const thread = await readConversationThread(dir, 'n1', 16);
    expect(thread.records).toHaveLength(1);
  });

  it('the chat reader validates the same actor rule as the writer', async () => {
    const dir = await home();
    const chat = await ChatLog.open(dir);
    await chat.append('human', 'my words', 1);
    await chat.append('gateway', 'a recap', 2);
    await chat.close();
    expect((await readChat(dir)).map((record) => record.uid)).toEqual(['human', 'gateway']);
    // An actor the rule refuses is a corrupt line, never silently returned.
    const raw = await readFile(join(dir, CHAT_FILE), 'utf8');
    await writeFile(join(dir, CHAT_FILE),
      `${raw}${JSON.stringify({ v: 0, at: 3, uid: 'bad uid', text: 'x' })}\n`, 'utf8');
    await expect(readChat(dir)).rejects.toThrow(/invalid node uid/);
  });

  it('renders an out-of-range at as the fixed unrenderable stamp instead of throwing', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    await log.append('n1', undefined, 'far future', 1e16); // finite, beyond Date's range
    const thread = await readConversationThread(dir, 'n1', 16);
    const rendered = renderConversationThread(thread, 4096);
    expect(rendered).toContain(`${UNRENDERABLE_INSTANT} from n1 to gateway`);
    expect(rendered).toContain('far future');
  });

  it('windows the thread, reports older records, and self-bounds its render', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    for (let i = 0; i < 5; i += 1) await log.append('gateway', 'n1', `m${i}`);
    const windowed = await readConversationThread(dir, 'n1', 2);
    expect(windowed.records.map((record) => record.text)).toEqual(['m3', 'm4']);
    expect(windowed.older).toBe(true);
    const all = await readConversationThread(dir, 'n1', 16);
    expect(all.older).toBe(false);
    const exact = await readConversationThread(dir, 'n1', 5);
    expect(exact.older).toBe(false);
    const rendered = renderConversationThread(all, 4096);
    expect(rendered).toContain(CONVERSATION_FRAMING);
    expect(rendered).not.toContain('older records exist');
    const bounded = renderConversationThread(all, 300);
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(300);
    expect(bounded).toContain('m4');
    expect(bounded).toContain('older records exist');
    // The framing is never dropped for a sane cap.
    expect(bounded).toContain('messages from your conversation thread');
  });

  it('satisfies the at finite guard and skips a degraded complete line', async () => {
    const dir = await home();
    const path = join(dir, CONVERSATION_FILE);
    const good = JSON.stringify({ v: 0, at: 2, from: 'gateway', to: 'n1', text: 'good' });
    const badAt = JSON.stringify({ v: 0, at: null, from: 'gateway', to: 'n1', text: 'bad at' });
    const badShape = JSON.stringify({ v: 0, at: 3, from: 'bad uid!', to: 'n1', text: 'bad actor' });
    await writeFile(path, `${badShape}\n${badAt}\n${good}\n`, 'utf8');
    const thread = await readConversationThread(dir, 'n1', 16);
    expect(thread.records.map((record) => record.text)).toEqual(['good']);
    const rendered = renderConversationThread(thread, 4096);
    expect(rendered).toContain('good');
    expect(rendered).not.toContain('bad at');
  });

  it('reads a missing stream as empty and is not a journal event vocabulary', async () => {
    const dir = await home();
    expect(await readConversationThread(dir, 'n1', 16)).toEqual({ records: [], older: false });
    const conversationTypes = [...NODE_EVENT_TYPES].filter((type) => /conversation|message\//.test(type));
    expect(conversationTypes).toEqual([]);
  });
});
