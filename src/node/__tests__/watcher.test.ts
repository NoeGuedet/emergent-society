import { describe, expect, it, vi } from 'vitest';
import { HeadWatcher } from '../watcher.js';
import { commitAs, useWorld, writeWorldFile } from './helpers.js';

const fixture = useWorld('node-watch-');
/** A second world whose watcher runs its interval, for the timer path only. */
const timed = useWorld('node-watch-timed-', { pollMs: 25 });

/** Yields past a scheduled microtask, which is where a poke's check runs. */
const settle = (): Promise<void> => new Promise((r) => { setImmediate(r); });

describe('the HEAD watcher', () => {
  it('is one instance per world repo', () => {
    const { world } = fixture();
    expect(HeadWatcher.for(world)).toBe(HeadWatcher.for(world));
    expect(HeadWatcher.for(world, 999)).toBe(HeadWatcher.for(world));
  });

  it('notifies a listener when HEAD moved, and only then', async () => {
    const { world } = fixture();
    const watcher = HeadWatcher.for(world);
    let calls = 0;
    watcher.subscribe(() => { calls += 1; });

    // No movement: the first read establishes HEAD, the second sees it unmoved.
    await watcher.check();
    await watcher.check();
    expect(calls).toBe(1);

    await commitAs(world, 'n2', { 'a.txt': 'one' });
    await watcher.check();
    expect(calls).toBe(2);
    await watcher.check();
    expect(calls).toBe(2);
  });

  it('pokes a listener in-process, coalescing several pokes into one check', async () => {
    const { world } = fixture();
    const watcher = HeadWatcher.for(world);
    const listener = vi.fn();
    watcher.subscribe(listener);
    await watcher.check();
    listener.mockClear();

    await writeWorldFile(world, 'a.txt', 'one');
    await world.commitAll('n1', 'turn 0');
    // Both pokes land before the scheduled check runs: one read, one notify.
    watcher.poke();
    watcher.poke();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    // And the second poke did not queue a second read behind it.
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does nothing when nothing is parked', async () => {
    const { world } = fixture();
    const watcher = HeadWatcher.for(world);
    // A commit made with no subscriber: the poke is a no-op, not an error, and
    // the listener registered later starts from the current HEAD.
    await writeWorldFile(world, 'a.txt', 'one');
    await world.commitAll('n1', 'turn 0');
    watcher.poke();
    await settle();
    expect(watcher.subscriberCount).toBe(0);
  });

  it('stops notifying a removed listener, idempotently', async () => {
    const { world } = fixture();
    const watcher = HeadWatcher.for(world);
    const listener = vi.fn();
    const unsubscribe = watcher.subscribe(listener);
    expect(watcher.subscriberCount).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(watcher.subscriberCount).toBe(0);

    await commitAs(world, 'n2', { 'a.txt': 'one' });
    watcher.poke();
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps notifying the other listeners when one throws', async () => {
    const { world } = fixture();
    const watcher = HeadWatcher.for(world);
    const second = vi.fn();
    watcher.subscribe(() => { throw new Error('bad listener'); });
    watcher.subscribe(second);
    await commitAs(world, 'n2', { 'a.txt': 'one' });
    watcher.poke();
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  });

  it('reports a failing HEAD read as no movement', async () => {
    const { world } = fixture();
    const watcher = HeadWatcher.for(world);
    const listener = vi.fn();
    watcher.subscribe(listener);
    await world.commitAll('n1', 'turn 0');
    const { rm } = await import('node:fs/promises');
    await rm(`${world.path}/.git`, { recursive: true, force: true });
    // A transient git failure must not reject into a timer callback; the next
    // read retries, so a wake is delayed rather than lost.
    await expect(watcher.check()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it('catches an out-of-process commit on its interval', async () => {
    const { world } = timed();
    const watcher = HeadWatcher.for(world);
    const listener = vi.fn();
    watcher.subscribe(listener);
    await watcher.check();
    // No poke at all: this is the human's commit, or another process's.
    await commitAs(world, 'human', { 'a.txt': 'from outside' });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });
});
