import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CHAT_FILE, readChatWindow } from '../chat.js';

/**
 * The overlay's chat-window read (`readChatWindow`): a bounded TAIL read over
 * the chat log. The window starts mid-file when the log is larger than the
 * bound, so its leading partial line must be dropped; a torn trailing fragment
 * is never a record; a degraded complete line is skipped, never fatal.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'es-chat-window-'));
  dirs.push(dir);
  return dir;
}

function line(uid: string, text: string, at = 1): string {
  return `${JSON.stringify({ v: 0, at, uid, text })}\n`;
}

it('reads the last n complete records in order', async () => {
  const dir = await home();
  await writeFile(join(dir, CHAT_FILE),
    line('human', 'one', 1) + line('gateway', 'two', 2) + line('human', 'three', 3),
    { mode: 0o600 });
  const window = await readChatWindow(dir, 2);
  expect(window.map((record) => record.text)).toEqual(['two', 'three']);
  expect(window[0]).toMatchObject({ v: 0, uid: 'gateway', at: 2 });
  // A missing log is an empty window.
  expect(await readChatWindow(await home(), 4)).toEqual([]);
});

it('drops a torn trailing fragment and skips a degraded complete line', async () => {
  const dir = await home();
  await writeFile(join(dir, CHAT_FILE),
    line('human', 'kept') + '{"v":0,"at":2,"uid":"hum', { mode: 0o600 });
  expect((await readChatWindow(dir, 4)).map((record) => record.text)).toEqual(['kept']);
  await writeFile(join(dir, CHAT_FILE), 'not json\n' + line('human', 'after', 2),
    { flag: 'a', mode: 0o600 });
  expect((await readChatWindow(dir, 4)).map((record) => record.text)).toEqual(['kept', 'after']);
});

it('drops the leading partial line when the bounded window starts mid-record', async () => {
  const dir = await home();
  // Each line is ~70 bytes; a 150-byte window starts inside the second record,
  // so the fragment must be dropped and only the complete tail is returned.
  await writeFile(join(dir, CHAT_FILE),
    line('human', 'a'.repeat(60), 1) + line('gateway', 'b'.repeat(60), 2)
    + line('human', 'c'.repeat(60), 3),
    { mode: 0o600 });
  const window = await readChatWindow(dir, 10, 150);
  expect(window.map((record) => record.uid)).toEqual(['human']);
  expect(window[0]!.text).toBe('c'.repeat(60));
});

it('clamps a nonsensical n to one record and accepts a large n', async () => {
  const dir = await home();
  await writeFile(join(dir, CHAT_FILE), line('human', 'only'), { mode: 0o600 });
  expect((await readChatWindow(dir, 0)).map((record) => record.text)).toEqual(['only']);
  expect(await readChatWindow(dir, 10_000)).toHaveLength(1);
});
