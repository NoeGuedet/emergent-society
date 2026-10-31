import { describe, expect, it, vi } from 'vitest';
import { NodeDriver } from '../driver.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { type StorageConfig, type StorageFree, type StoragePolicy,
  StorageError, checkStorage } from '../../storage.js';
import { DEFAULT_STORAGE } from '../storage-probe.js';
import { collectEvents } from '../../journal/__tests__/helpers.js';
import { useWorld } from './helpers.js';

/**
 * The driver's storage home: the turn never opens on a low disk.
 *
 * A low probe defers the turn — one bounded diagnostic, the `waiting` state and
 * a cancellable `storageRetryMs` wait — and opens no `turn/start`; the loop
 * re-checks after the wait, so a high probe starts the turn and a low one keeps
 * deferring without spinning. `stop()` cancels the wait promptly and the node is
 * ended by the stop, never by the disk.
 */

const fixture = useWorld('node-storage-');

const policy: StoragePolicy = {
  minFreeBytes: 100, minFreeInodes: 10, reserveBytes: 0, reserveInodes: 0,
};

const HIGH: StorageFree = { bytes: 1_000, inodes: 1_000 };
const LOW: StorageFree = { bytes: 99, inodes: 1_000 };

type State = { free: StorageFree | null };
const guard = (state: State): StorageConfig => ({ policy, probe: async () => state.free });

const wait = (): { outcome: 'waiting'; toolCalls: boolean } => ({ outcome: 'waiting', toolCalls: false });

function readLog(at: string) {
  return collectEvents(at, NODE_EVENT_TYPES, 'n1');
}

describe('NodeDriver storage home', () => {
  it('defers the turn on a low probe and opens it on a later high probe', async () => {
    const { home, world } = fixture();
    const state: State = { free: LOW };
    const diagnostics: string[] = [];
    let handlerTurn: number | null = null;
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      handlerTurn = ctx.turn;
      return wait();
    }, world, {
      worldPollMs: 0,
      storage: guard(state),
      storageRetryMs: 10,
      onError: (err) => { diagnostics.push(err.message); },
    });
    const running = d.run();
    try {
      await vi.waitFor(() => expect(diagnostics.length).toBeGreaterThan(0), { timeout: 5_000 });
      // Every deferral carries the one bounded label, no payload.
      expect(new Set(diagnostics)).toEqual(new Set(['turn deferred: storage low']));
      // No turn was opened while the disk was low. (The state cycles between
      // `waiting` during a retry wait and `active` between them; the handler
      // never runs and no `turn/start` exists, which is the property.)
      expect(handlerTurn).toBeNull();
      expect((await readLog(home)).filter((event) => event.type === 'turn/start')).toHaveLength(0);

      // The retry re-checks and opens the turn.
      state.free = HIGH;
      await vi.waitFor(() => expect(handlerTurn).toBe(0), { timeout: 5_000 });
    } finally {
      state.free = HIGH;
      d.stop();
      await running;
    }
    const events = await readLog(home);
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      'node/boot', 'turn/start', 'turn/end', 'node/shutdown',
    ]);
  }, 20_000);

  it('does not spin while the probe stays low', async () => {
    const { home, world } = fixture();
    const state: State = { free: LOW };
    const diagnostics: string[] = [];
    const d = await NodeDriver.open(home, 'n1', wait, world, {
      worldPollMs: 0,
      storage: guard(state),
      storageRetryMs: 50,
      onError: (err) => { diagnostics.push(err.message); },
    });
    const running = d.run();
    try {
      await vi.waitFor(() => expect(diagnostics.length).toBeGreaterThan(0), { timeout: 5_000 });
      // ~4 retry windows: a spinning loop would emit thousands.
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(diagnostics.length).toBeLessThanOrEqual(8);
      expect(new Set(diagnostics)).toEqual(new Set(['turn deferred: storage low']));
    } finally {
      state.free = HIGH;
      d.stop();
      await running;
    }
    expect((await readLog(home)).filter((event) => event.type === 'turn/start')).toHaveLength(0);
  }, 20_000);

  it('cancels the wait promptly on stop and opens no turn', async () => {
    const { home, world } = fixture();
    const state: State = { free: LOW };
    const diagnostics: string[] = [];
    const d = await NodeDriver.open(home, 'n1', wait, world, {
      worldPollMs: 0,
      storage: guard(state),
      storageRetryMs: 60_000,
      onError: (err) => { diagnostics.push(err.message); },
    });
    const running = d.run();
    await vi.waitFor(() => expect(diagnostics).toHaveLength(1), { timeout: 5_000 });
    // Space returns before the stop so the shutdown's close can land the
    // pending boot fact; the wait itself must end from the stop, not the timer.
    state.free = HIGH;
    const started = Date.now();
    d.stop();
    await running;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(d.state).toBe('stopped');
    const events = await readLog(home);
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(['node/boot', 'node/shutdown']);
  }, 20_000);

  it('degrades on a null probe: the turn opens', async () => {
    const { home, world } = fixture();
    const state: State = { free: null };
    const diagnostics: string[] = [];
    let handlerTurn: number | null = null;
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      handlerTurn = ctx.turn;
      return wait();
    }, world, {
      worldPollMs: 0,
      storage: guard(state),
      storageRetryMs: 60_000,
      onError: (err) => { diagnostics.push(err.message); },
    });
    const running = d.run();
    try {
      await vi.waitFor(() => expect(handlerTurn).toBe(0), { timeout: 5_000 });
      expect(diagnostics).toEqual([]);
    } finally {
      d.stop();
      await running;
    }
    expect((await readLog(home)).filter((event) => event.type === 'turn/start')).toHaveLength(1);
  }, 20_000);

  it('a stop during the turn-start probe opens no turn, even when the probe answers high', async () => {
    const { home, world } = fixture();
    let calls = 0;
    let release: ((free: StorageFree | null) => void) | null = null;
    const probe = (): Promise<StorageFree | null> => {
      calls += 1;
      // Call 1 is the boot barrier (high, so the boot lands); call 2 is the
      // turn-start check, held open until the test stops the driver; every
      // later call (the shutdown's flush) must not hang the run.
      if (calls === 1) return Promise.resolve(HIGH);
      if (calls === 2) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve(HIGH);
    };
    const d = await NodeDriver.open(home, 'n1', () => {
      throw new Error('handler must not run after the stop');
    }, world, {
      worldPollMs: 0, storage: { policy, probe }, onError: () => {},
    });
    const running = d.run();
    await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 5_000 });
    d.stop();
    release!({ bytes: 1_000, inodes: 1_000 });
    await running;
    const events = await readLog(home);
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(['node/boot', 'node/shutdown']);
  }, 20_000);

  it('a stop during a deferred probe does not arm a fresh wait', async () => {
    const { home, world } = fixture();
    let calls = 0;
    let release: ((free: StorageFree | null) => void) | null = null;
    const probe = (): Promise<StorageFree | null> => {
      calls += 1;
      if (calls === 1) return Promise.resolve(HIGH);
      if (calls === 2) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve(HIGH);
    };
    const diagnostics: string[] = [];
    const d = await NodeDriver.open(home, 'n1', wait, world, {
      worldPollMs: 0, storage: { policy, probe }, storageRetryMs: 60_000,
      onError: (err) => { diagnostics.push(err.message); },
    });
    const running = d.run();
    await vi.waitFor(() => expect(release).not.toBeNull(), { timeout: 5_000 });
    d.stop();
    const started = Date.now();
    release!({ bytes: 99, inodes: 1_000 });
    await running;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(diagnostics).toEqual([]);
    const events = await readLog(home);
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(['node/boot', 'node/shutdown']);
  }, 20_000);

  it('opens a turn under the default real probe when the host is above the floors', async ({ skip }) => {
    const { home, world } = fixture();
    // A legitimate low-space host must skip, not fail: the default real probe is
    // a production-parity case, not a host-capability requirement.
    try {
      await checkStorage(DEFAULT_STORAGE, home);
    } catch (err) {
      if (err instanceof StorageError) skip();
      throw err;
    }
    let handlerTurn: number | null = null;
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      handlerTurn = ctx.turn;
      return wait();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    try {
      await vi.waitFor(() => expect(handlerTurn).toBe(0), { timeout: 5_000 });
    } finally {
      d.stop();
      await running;
    }
    expect((await readLog(home)).filter((event) => event.type === 'turn/start')).toHaveLength(1);
  }, 20_000);
});
