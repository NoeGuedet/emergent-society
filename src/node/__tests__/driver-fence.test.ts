import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { BlobStore, type EventEnvelope } from '../../journal/index.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import type { DriverHooks } from '../gate.js';
import {
  NodeDriver, type FenceOutcome, type FencePort, type TurnResult,
} from '../driver.js';
import { readWorldState } from '../world-state.js';
import {
  readNode, useWorld, writeWorldFile,
} from './helpers.js';

/**
 * The C2 commit fence at the driver seam: one acquire/release wraps the whole
 * commit attempt, a freeze failure is a typed refusal (`freeze-timeout`) rather
 * than an unfenced commit, `release` runs in `finally` before the closer, a stop
 * never aborts the commit, and the fence sits outside the commit queue and the
 * internal git retries (one acquire per attempt).
 *
 * The real cgroup freeze is the host port's own suite; here the port is the
 * injected seam the plan defines, so every branch is deterministic.
 */

const fixture = useWorld('node-fence-');
const wait = (): TurnResult => ({ outcome: 'waiting', toolCalls: false });

/** A completed driver run, stopped by the test. */
async function parked(d: NodeDriver): Promise<void> {
  await vi.waitFor(() => expect(d.state).toBe('waiting'));
}

/** The hooks a driver needs when a case observes durability ordering. */
function hooks(home: string, onDurable: DriverHooks['onDurable']): DriverHooks {
  return {
    registry: createBoundaryRegistry(),
    onDurable,
    onReady: async () => {},
    onTurnStart: async () => {},
    readHistory: (path, uid, knownTypes) => loadVerifiedEvents(path, uid, knownTypes),
    readBlob: (hash) => new BlobStore(home).get(hash),
    acknowledgedWorld: () => null,
  };
}

/** A promise plus its resolver, for holding the fence mid-commit. */
function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve: () => resolve() };
}

function first(events: readonly EventEnvelope[], type: string): Record<string, unknown> {
  const event = events.find((entry) => entry.type === type);
  if (event === undefined) throw new Error(`no ${type} event`);
  return event.data as Record<string, unknown>;
}

it('acquires once around the commit and releases before the closer is durable', async () => {
  const { home, world } = fixture();
  const calls: string[] = [];
  let releasedAtCloser: boolean | null = null;
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      calls.push('acquire');
      return { fenced: true, leaves: 1 };
    },
    async release(): Promise<void> {
      calls.push('release');
    },
  };
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/fenced.md', 'fenced');
    return wait();
  }, world, {
    worldPollMs: 0,
    fence: port,
    knownTypes: C13_EVENT_TYPES,
    hooks: hooks(home, async (events) => {
      if (events.some((event) => event.type === 'turn/end')) {
        releasedAtCloser = calls.includes('release');
      }
    }),
    schedule: () => () => {},
  });
  const running = d.run();
  try {
    await parked(d);
    expect(d.state).toBe('waiting');
    // Release is in the commit's `finally`, so it precedes the sidecar/closer
    // writes; a closer that flushed while the leaves were still frozen would
    // make `releasedAtCloser` false.
    expect(calls).toEqual(['acquire', 'release']);
    expect(releasedAtCloser).toBe(true);
    const events = await readNode(home);
    const end = first(events, 'turn/end');
    expect(end).toMatchObject({ turn: 0, outcome: 'waiting' });
    expect(end['commit']).toBe(await world.headHash());
    expect(events.some((event) => event.type === 'world/commit-refused')).toBe(false);
    expect(await readWorldState(home)).toMatchObject({ degraded: false });
  } finally {
    d.stop();
    await running;
  }
});

it('refuses a freeze failure as freeze-timeout, never as an unfenced commit', async () => {
  const { home, world } = fixture();
  const calls: string[] = [];
  const detail = `freeze-timeout ${'x'.repeat(1000)}`;
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      calls.push('acquire');
      return { fenced: false, reason: 'freeze-failed', detail };
    },
    async release(): Promise<void> {
      calls.push('release');
    },
  };
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/held.md', 'held');
    return wait();
  }, world, { worldPollMs: 0, fence: port, schedule: () => () => {} });
  const running = d.run();
  try {
    await parked(d);
    // The freeze failed, so the port was acquired and released but `commitAll`
    // never ran: nothing was staged and the working tree keeps the turn's write
    // for the retry, exactly like any other refusal.
    expect(calls).toEqual(['acquire', 'release']);
    expect(await world.headHash()).toBeNull();
    const events = await readNode(home);
    const end = first(events, 'turn/end');
    expect(end).toMatchObject({ turn: 0, outcome: 'waiting' });
    expect('commit' in end).toBe(false);
    const refusal = first(events, 'world/commit-refused') as {
      readonly turn: number;
      readonly refusal: { readonly reason: string; readonly detail: string };
    };
    expect(refusal.turn).toBe(0);
    expect(refusal.refusal.reason).toBe('freeze-timeout');
    // The detail is bounded through the one refusal boundary (one line, 300
    // code points), so a cgroup failure can never grow the event.
    expect(refusal.refusal.detail.length).toBeLessThanOrEqual(300);
    expect(refusal.refusal.detail).toContain('freeze-timeout');
    expect(await readWorldState(home)).toMatchObject({
      degraded: true, reason: 'freeze-timeout',
    });
  } finally {
    d.stop();
    await running;
  }
});

it('commits unfenced when the host has no port', async () => {
  const { home, world } = fixture();
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/open.md', 'open');
    return wait();
  }, world, { worldPollMs: 0, schedule: () => () => {} });
  const running = d.run();
  try {
    await parked(d);
    const events = await readNode(home);
    expect(first(events, 'turn/end')['commit']).toBe(await world.headHash());
    expect(events.some((event) => event.type === 'world/commit-refused')).toBe(false);
  } finally {
    d.stop();
    await running;
  }
});

it('refuses a present port that reports unavailable, never committing unfenced', async () => {
  // A present port means the host was fence-available at boot; a runtime
  // `unavailable` is a contradiction the commit must not silently ignore. Only
  // the ABSENCE of a port is the unfenced host case (owner/boot/status).
  const { home, world } = fixture();
  const calls: string[] = [];
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      calls.push('acquire');
      return { fenced: false, reason: 'unavailable' };
    },
    async release(): Promise<void> {
      calls.push('release');
    },
  };
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/unavailable.md', 'unavailable');
    return wait();
  }, world, { worldPollMs: 0, fence: port, schedule: () => () => {} });
  const running = d.run();
  try {
    await parked(d);
    expect(calls).toEqual(['acquire', 'release']);
    expect(await world.headHash()).toBeNull();
    const events = await readNode(home);
    expect(first(events, 'turn/end')).toMatchObject({ turn: 0, outcome: 'waiting' });
    const refusal = first(events, 'world/commit-refused') as {
      readonly refusal: { readonly reason: string; readonly detail: string };
    };
    expect(refusal.refusal.reason).toBe('freeze-timeout');
    expect(refusal.refusal.detail).toBe('the commit fence is unavailable');
    expect(await readWorldState(home)).toMatchObject({ degraded: true, reason: 'freeze-timeout' });
  } finally {
    d.stop();
    await running;
  }
});

it('turns a throwing acquire into a freeze-timeout refusal, never a driver error', async () => {
  const { home, world } = fixture();
  let released = false;
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      throw new Error('port exploded');
    },
    async release(): Promise<void> {
      released = true;
    },
  };
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/acquire.md', 'acquire');
    return wait();
  }, world, { worldPollMs: 0, fence: port, schedule: () => () => {} });
  const running = d.run();
  try {
    await parked(d);
    expect(d.state).toBe('waiting');
    expect(released).toBe(true);
    expect(await world.headHash()).toBeNull();
    const events = await readNode(home);
    const refusal = first(events, 'world/commit-refused') as {
      readonly refusal: { readonly reason: string; readonly detail: string };
    };
    expect(refusal.refusal.reason).toBe('freeze-timeout');
    expect(refusal.refusal.detail).toBe('the commit fence could not be acquired');
    expect(await readWorldState(home)).toMatchObject({ degraded: true, reason: 'freeze-timeout' });
  } finally {
    d.stop();
    await running;
  }
});

it('defers a stop across the critical section: the commit lands and release precedes the closer', async () => {
  const { home, world } = fixture();
  const calls: string[] = [];
  const gate = deferred();
  const acquired = deferred();
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      calls.push('acquire');
      acquired.resolve();
      await gate.promise;
      return { fenced: true, leaves: 1 };
    },
    async release(): Promise<void> {
      calls.push('release');
    },
  };
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/deferred.md', 'deferred');
    return wait();
  }, world, { worldPollMs: 0, fence: port, schedule: () => () => {} });
  const running = d.run();
  await acquired.promise;
  // The stop arrives while the fence is held: it must not abort the commit, and
  // the run ends with the turn's commit recorded before the shutdown.
  d.stop();
  gate.resolve();
  await running;
  expect(d.state).toBe('stopped');
  expect(calls).toEqual(['acquire', 'release']);
  const events = await readNode(home);
  const end = first(events, 'turn/end');
  expect(end['commit']).toBe(await world.headHash());
  expect(events.some((event) => event.type === 'world/commit-refused')).toBe(false);
  expect(events.find((event) => event.type === 'node/shutdown')?.data)
    .toEqual({ reason: 'stop-requested' });
});

it('takes one acquire per attempt across the commit\'s internal lock retries', async () => {
  const { home, world } = fixture();
  const lock = join(world.gitDir, 'index.lock');
  await writeFile(lock, '');
  const calls: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      calls.push('acquire');
      // The lock is held for the first tries and released mid-retry: the commit
      // retries inside `commitAll` while the fence stays held. One acquire and
      // one release must cover all of them (a fence inside `commitOnce` would
      // thaw between tries and show up as several pairs here).
      timer = setTimeout(() => { void rm(lock, { force: true }); }, 60);
      return { fenced: true, leaves: 1 };
    },
    async release(): Promise<void> {
      calls.push('release');
    },
  };
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/retried.md', 'retried');
    return wait();
  }, world, { worldPollMs: 0, fence: port, schedule: () => () => {} });
  const running = d.run();
  try {
    await vi.waitFor(() => expect(d.state).toBe('waiting'), { timeout: 10_000 });
    expect(calls).toEqual(['acquire', 'release']);
    const events = await readNode(home);
    const end = first(events, 'turn/end');
    expect(typeof end['commit']).toBe('string');
    expect(end['commit']).toBe(await world.headHash());
  } finally {
    if (timer !== null) clearTimeout(timer);
    await rm(lock, { force: true }).catch(() => {});
    d.stop();
    await running;
  }
});

it('acquires only after the handler returned, with no driver timer across the commit', async () => {
  // The invariant G6 names: no shell or Run deadline is armed across
  // `commitWorld` by construction. Shell/Run calls are awaited inside the
  // handler, whose deadlines settle before it returns, and the driver arms its
  // one timer seam (the refusal retry) only after a refusal — never across a
  // commit. This test pins the driver half: the fence is entered only after the
  // handler returned, and the retry seam never fires during an ordinary commit.
  const { home, world } = fixture();
  let handlerReturned = false;
  let sawReturned: boolean | null = null;
  let scheduleCalls = 0;
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      sawReturned = handlerReturned;
      return { fenced: true, leaves: 1 };
    },
    async release(): Promise<void> {},
  };
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/ordered.md', 'ordered');
    handlerReturned = true;
    return wait();
  }, world, {
    worldPollMs: 0,
    fence: port,
    schedule: () => {
      scheduleCalls += 1;
      return () => {};
    },
  });
  const running = d.run();
  try {
    await parked(d);
    expect(sawReturned).toBe(true);
    expect(scheduleCalls).toBe(0);
    expect(first(await readNode(home), 'turn/end')['commit']).toBe(await world.headHash());
  } finally {
    d.stop();
    await running;
  }
});

it('a throwing release never displaces the commit', async () => {
  const { home, world } = fixture();
  const errors: string[] = [];
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      return { fenced: true, leaves: 1 };
    },
    async release(): Promise<void> {
      throw new Error('release exploded');
    },
  };
  const d = await NodeDriver.open(home, 'n1', async () => {
    await writeWorldFile(world, 'n1/safe.md', 'safe');
    return wait();
  }, world, {
    worldPollMs: 0, fence: port, schedule: () => () => {},
    onError: (err) => errors.push(`${err.name}:${err.message}`),
  });
  const running = d.run();
  try {
    await parked(d);
    expect(d.state).toBe('waiting');
    const events = await readNode(home);
    expect(first(events, 'turn/end')['commit']).toBe(await world.headHash());
    // The host logs the error NAME only; the named fault keeps the step.
    expect(errors).toContain('FenceReleaseError:fence release failed');
  } finally {
    d.stop();
    await running;
  }
});
