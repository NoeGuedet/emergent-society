import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConversationLog, renderConversationNotice } from '../conversation.js';
import { ConversationWatcher } from '../conversation-watcher.js';

/**
 * The conversation watcher and the pending notice (A3).
 *
 * The watcher announces MOVEMENT of the stream's size — grow or shrink — and
 * arms one notice per addressed recipient: a count and the newest sender. The
 * interval runs only while something is subscribed; an in-process append pokes
 * the same check even with nobody parked, because the notice must reach a
 * RUNNING recipient's next request too.
 */

const homes: string[] = [];

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'es-conversation-watch-'));
  homes.push(dir);
  return dir;
}

afterEach(async () => {
  // Every interval-running test unsubscribes in its own `finally`; a remaining
  // subscriber would leave a ref'd interval behind, so the suites keep them
  // short and explicit.
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});

function watcherFor(dir: string, pollMs = 0): ConversationWatcher {
  return ConversationWatcher.for(dir, pollMs);
}

const execFileAsync = promisify(execFile);

/** Appends one line from ANOTHER process — a foreign writer, no poke. */
async function foreignAppend(path: string, record: Record<string, unknown>): Promise<void> {
  const script = 'require("node:fs").appendFileSync(process.argv[1], process.argv[2] + "\\n")';
  await execFileAsync(process.execPath, ['-e', script, path, JSON.stringify(record)]);
}

describe('ConversationWatcher', () => {
  it('is one instance per stream and starts at the boot size', async () => {
    const dir = await home();
    const first = ConversationWatcher.for(dir);
    expect(ConversationWatcher.for(dir)).toBe(first);
    expect(first.streamPath).toBe(join(dir, 'conversation.v0.jsonl'));
    // A stream that already exists at construction is the boot backlog: the
    // first check does not re-announce it.
    const seeded = await home();
    await ConversationLog.for(seeded).append('gateway', 'n1', 'before the watcher');
    const watcher = watcherFor(seeded);
    const listener = vi.fn();
    watcher.subscribe(listener);
    await watcher.check();
    expect(listener).not.toHaveBeenCalled();
    expect(watcher.noticeFor('n1')).toBeNull();
  });

  it('arms the addressed recipient on a grow, and only that recipient', async () => {
    const dir = await home();
    const watcher = watcherFor(dir);
    const listener = vi.fn();
    watcher.subscribe(listener);
    await ConversationLog.for(dir).append('gateway', 'n1', 'one');
    await watcher.check();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(watcher.noticeFor('n1')).toMatchObject({ count: 1, newestFrom: 'gateway' });
    expect(watcher.noticeFor('n2')).toBeNull();
    // A second record aggregates into the same notice with a newer version.
    const before = watcher.noticeFor('n1')!.version;
    await ConversationLog.for(dir).append('gateway', 'n1', 'two');
    await watcher.check();
    const notice = watcher.noticeFor('n1')!;
    expect(notice.count).toBe(2);
    expect(notice.version).toBeGreaterThan(before);
  });

  it('clears only the version that was rendered, not a newer arrival', async () => {
    const dir = await home();
    const watcher = watcherFor(dir);
    await ConversationLog.for(dir).append('gateway', 'n1', 'one');
    await watcher.check();
    const rendered = watcher.noticeFor('n1')!;
    await ConversationLog.for(dir).append('gateway', 'n1', 'two');
    await watcher.check();
    // The clear of the rendered request must not consume the newer record.
    watcher.consume('n1', rendered.version);
    expect(watcher.noticeFor('n1')).toMatchObject({ count: 2 });
    watcher.consume('n1', watcher.noticeFor('n1')!.version);
    expect(watcher.noticeFor('n1')).toBeNull();
  });

  it('arms from the thread tail at boot, bounded to the last n records', async () => {
    const dir = await home();
    const log = ConversationLog.for(dir);
    await log.append('gateway', 'n1', 'old one');
    await log.append('gateway', 'n1', 'old two');
    await log.append('gateway', 'n2', 'for the peer');
    const watcher = watcherFor(dir);
    await watcher.armBoot('n1', 2);
    expect(watcher.noticeFor('n1')).toMatchObject({ count: 2, newestFrom: 'gateway' });
    expect(watcher.noticeFor('n2')).toBeNull();
    // The window is bounded: the boot notice never replays the whole history.
    const other = await home();
    const otherLog = ConversationLog.for(other);
    await otherLog.append('gateway', 'n1', 'one');
    await otherLog.append('gateway', 'n1', 'two');
    const limited = watcherFor(other);
    await limited.armBoot('n1', 1);
    expect(limited.noticeFor('n1')).toMatchObject({ count: 1 });
  });

  it('pokes the same check with nobody parked (a running recipient)', async () => {
    const dir = await home();
    const watcher = watcherFor(dir);
    await ConversationLog.for(dir).append('gateway', 'n1', 'while running');
    // No subscriber: the host's own append pokes the check, and the notice is
    // armed for the running node's next assembled request.
    watcher.poke();
    await vi.waitFor(() => expect(watcher.noticeFor('n1')).not.toBeNull());
    expect(watcher.noticeFor('n1')).toMatchObject({ count: 1 });
  });

  it('catches a foreign process\'s append on its interval', async () => {
    const dir = await home();
    const watcher = watcherFor(dir, 25);
    const listener = vi.fn();
    const unsubscribe = watcher.subscribe(listener);
    try {
      await watcher.check();
      listener.mockClear();
      await foreignAppend(join(dir, 'conversation.v0.jsonl'), {
        v: 0, at: Date.now(), from: 'gateway', to: 'n1', text: 'from outside',
      });
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1), { timeout: 2000 });
      expect(watcher.noticeFor('n1')).toMatchObject({ count: 1, newestFrom: 'gateway' });
    } finally {
      unsubscribe();
      await watcher.check();
    }
    expect(watcher.subscriberCount).toBe(0);
  });

  it('treats a shrink as a reset: notify, re-arm from the new watermark, never re-scan', async () => {
    const dir = await home();
    const path = join(dir, 'conversation.v0.jsonl');
    const watcher = watcherFor(dir);
    const listener = vi.fn();
    watcher.subscribe(listener);
    await ConversationLog.for(dir).append('gateway', 'n1', 'first');
    await watcher.check();
    watcher.consume('n1', watcher.noticeFor('n1')!.version);
    listener.mockClear();
    // The boot repair (or any truncation) shrinks the stream.
    await writeFile(path, '', 'utf8');
    await watcher.check();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(watcher.noticeFor('n1')).toBeNull();
    await ConversationLog.for(dir).append('gateway', 'n1', 'second');
    await watcher.check();
    expect(watcher.noticeFor('n1')).toMatchObject({ count: 1 });
  });

  it('skips a degraded complete line and a gateway-addressed record', async () => {
    const dir = await home();
    const path = join(dir, 'conversation.v0.jsonl');
    const watcher = watcherFor(dir);
    await writeFile(path, 'not a record\n', 'utf8');
    await watcher.check();
    expect(watcher.noticeFor('n1')).toBeNull();
    // A node's own message to the gateway is not a recipient's arrival.
    await ConversationLog.for(dir).append('n1', undefined, 'my own send');
    await watcher.check();
    expect(watcher.noticeFor('n1')).toBeNull();
    expect(watcher.noticeFor('gateway')).toBeNull();
  });
});

describe('the notice renderer', () => {
  it('renders the aggregate sentence: the count and the newest sender', () => {
    expect(renderConversationNotice({ count: 3, newestFrom: 'node-4' }))
      .toBe('3 messages arrived, the newest from node-4; consult get_messages');
    expect(renderConversationNotice({ count: 1, newestFrom: 'gateway' }))
      .toBe('1 message arrived, the newest from gateway; consult get_messages');
  });
});
