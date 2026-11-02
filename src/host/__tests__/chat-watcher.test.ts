import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HUMAN_AUTHOR, GATEWAY_ADDRESSEE } from '../../journal/index.js';
import { ChatLog, CHAT_FILE } from '../chat.js';
import { ChatWatcher } from '../chat-watcher.js';

/**
 * The chat watcher (the overlay's second trigger): a size poll on the chat log,
 * ACTOR-FILTERED — a `uid: human` record is the arrival; the overlay's own
 * `uid: gateway` delivery grows the file and never re-triggers.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'es-chat-watcher-'));
  dirs.push(dir);
  return dir;
}

function record(uid: string, text: string, at = 1): string {
  return `${JSON.stringify({ v: 0, at, uid, text })}\n`;
}

it('notifies on a human record and never on the overlay\'s own delivery', async () => {
  const dir = await home();
  const chat = await ChatLog.open(dir);
  const watcher = ChatWatcher.for(dir, 0);
  let notifications = 0;
  const off = watcher.subscribe(() => { notifications += 1; });
  try {
    await chat.append(GATEWAY_ADDRESSEE, 'a delivery', 1);
    await watcher.check();
    expect(notifications).toBe(0);

    await chat.append(HUMAN_AUTHOR, 'a human message', 2);
    await watcher.check();
    expect(notifications).toBe(1);

    // The watermark followed the delivery: the next check is a no-change.
    await watcher.check();
    expect(notifications).toBe(1);
  } finally {
    off();
    await chat.close();
  }
});

it('catches a cross-process append by the size poll and resolves the actor from the tail', async () => {
  const dir = await home();
  const watcher = ChatWatcher.for(dir, 0);
  let notifications = 0;
  const off = watcher.subscribe(() => { notifications += 1; });
  try {
    // A writer this process does not own (the future session or `direct`).
    await writeFile(join(dir, CHAT_FILE), record(GATEWAY_ADDRESSEE, 'the overlay, earlier'), { mode: 0o600 });
    await watcher.check();
    expect(notifications).toBe(0);

    await writeFile(join(dir, CHAT_FILE), record(HUMAN_AUTHOR, 'typed elsewhere', 2),
      { flag: 'a', mode: 0o600 });
    await watcher.check();
    expect(notifications).toBe(1);
  } finally {
    off();
  }
});

it('drops a torn trailing fragment and skips a degraded line', async () => {
  const dir = await home();
  const watcher = ChatWatcher.for(dir, 0);
  let notifications = 0;
  const off = watcher.subscribe(() => { notifications += 1; });
  try {
    await writeFile(join(dir, CHAT_FILE), `${record(HUMAN_AUTHOR, 'complete')}torn-frag`,
      { mode: 0o600 });
    await watcher.check();
    expect(notifications).toBe(1);

    // A degraded complete line and a gateway record: neither is a human arrival.
    await writeFile(join(dir, CHAT_FILE), `not-json\n${record(GATEWAY_ADDRESSEE, 'delivery')}`,
      { flag: 'a', mode: 0o600 });
    await watcher.check();
    expect(notifications).toBe(1);
  } finally {
    off();
  }
});

it('treats a shrink as a watermark reset, not an arrival', async () => {
  const dir = await home();
  const watcher = ChatWatcher.for(dir, 0);
  let notifications = 0;
  const off = watcher.subscribe(() => { notifications += 1; });
  try {
    await writeFile(join(dir, CHAT_FILE), record(HUMAN_AUTHOR, 'first'), { mode: 0o600 });
    await watcher.check();
    expect(notifications).toBe(1);
    // The host's boot repair truncates a torn tail: a shrink, never a re-read.
    await truncate(join(dir, CHAT_FILE), 0);
    await watcher.check();
    expect(notifications).toBe(1);
    await writeFile(join(dir, CHAT_FILE), record(HUMAN_AUTHOR, 'second'), { mode: 0o600 });
    await watcher.check();
    expect(notifications).toBe(2);
  } finally {
    off();
  }
});

it('keeps one watcher per chat log and starts its interval only while subscribed', async () => {
  const dir = await home();
  const first = ChatWatcher.for(dir, 0);
  expect(ChatWatcher.for(dir, 0)).toBe(first);
  expect(first.chatPath).toBe(join(dir, CHAT_FILE));
  const off = first.subscribe(() => {});
  expect(first.subscriberCount).toBe(1);
  off();
  expect(first.subscriberCount).toBe(0);
});

it('takes its boot watermark from the log as it exists at construction', async () => {
  const dir = await home();
  // The backlog written before the watcher exists (the boot cycle digest case).
  await writeFile(join(dir, CHAT_FILE), record(HUMAN_AUTHOR, 'backlog'), { mode: 0o600 });
  const watcher = ChatWatcher.for(dir, 0);
  const seen = vi.fn();
  const off = watcher.subscribe(seen);
  try {
    await watcher.check();
    expect(seen).not.toHaveBeenCalled();
    await writeFile(join(dir, CHAT_FILE), record(HUMAN_AUTHOR, 'new arrival', 2),
      { flag: 'a', mode: 0o600 });
    await watcher.check();
    expect(seen).toHaveBeenCalledTimes(1);
  } finally {
    off();
  }
});
