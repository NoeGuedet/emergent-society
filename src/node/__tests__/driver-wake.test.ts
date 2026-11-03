import { chmod, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import type { WakePolicy } from '../../context/contracts.js';
import type { DriverHooks } from '../gate.js';
import { NodeDriver, type TurnContext, type TurnHandler, type TurnResult,
  type TurnTrigger } from '../driver.js';
import { NodeStateError } from '../errors.js';
import { nextCadenceDueMs } from '../cadence.js';
import type { ConversationNotice, ConversationSource } from '../conversation-watcher.js';
import { HeadWatcher } from '../watcher.js';
import { WorldRepo } from '../world.js';
import { commitAs, openTestDriver, readNode, useWorld, writeWorldFile } from './helpers.js';

/**
 * The wake-v1 core through the programmatic `NodeDriverOptions.wakePolicy` seam:
 * the effective policy is late (never the incoming seed), modern explicit timers
 * bypass the legacy count, cadence is a per-uid phase grid with a rest band, and
 * the one owned timer is guarded by its park epoch and its OWN generation.
 */

const fixture = useWorld('node-wake-physics-');
const NOW = 1_800_000_000_000;

const wait = (): TurnResult => ({ outcome: 'waiting', toolCalls: false });
const modern = (heartbeatSeconds: number) => (): WakePolicy => ({ heartbeatSeconds });

type ManualTimer = { readonly ms: number; readonly fire: () => void; cancelled: boolean };

function manualSchedule(): {
  readonly timers: ManualTimer[];
  readonly schedule: (ms: number, callback: () => void) => () => void;
} {
  const timers: ManualTimer[] = [];
  return {
    timers,
    schedule: (ms, callback) => {
      const timer: ManualTimer = { ms, fire: callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
}

/** Parks the driver and waits until its world subscription is registered. */
async function parked(d: NodeDriver, world: WorldRepo, subscribers = 1): Promise<void> {
  await vi.waitFor(() => expect(d.state).toBe('waiting'));
  await vi.waitFor(() => expect(HeadWatcher.for(world).subscriberCount).toBe(subscribers));
}

type Loose = {
  wakeTimer: unknown;
  wakeTimerGeneration: number;
  retryTimer: unknown;
  retryGeneration: number;
  parkEpoch: number;
  timerFired: boolean;
  cadenceFired: boolean;
  worldFired: boolean;
  latch: { requested: boolean };
  onOwnedWake: (
    generation: number, epoch: number, cause: 'timer' | 'cadence', modern: boolean,
  ) => Promise<void>;
};

const loose = (d: NodeDriver): Loose => d as unknown as Loose;

function triggers(events: readonly { type: string; data: unknown }[]): TurnTrigger[] {
  return events.filter((event) => event.type === 'turn/start')
    .map((event) => (event.data as { trigger: TurnTrigger }).trigger);
}

function startTimes(events: readonly { type: string; time: number }[]): number[] {
  return events.filter((event) => event.type === 'turn/start').map((event) => event.time);
}

/** A hook bundle over the real loader, for the hooks replay path. */
function hooksFor(home: string): DriverHooks {
  return {
    registry: createBoundaryRegistry(),
    onDurable: async () => {},
    onReady: async () => {},
    onTurnStart: async () => {},
    readHistory: (path, uid, knownTypes) => loadVerifiedEvents(path, uid, knownTypes),
    readBlob: (hash) => new BlobStore(home).get(hash),
    acknowledgedWorld: () => null,
  };
}

/** A conversation source whose park listener can be fired by hand. */
class FakeConversation implements ConversationSource {
  private readonly active = new Set<() => void>();
  private notice: ConversationNotice | null = null;

  subscribe(listener: () => void): () => void {
    this.active.add(listener);
    return () => { this.active.delete(listener); };
  }

  noticeFor(): ConversationNotice | null {
    return this.notice;
  }

  async armBoot(): Promise<void> { /* the boot rule is not this test's subject */ }

  arm(notice: ConversationNotice): void {
    this.notice = notice;
  }

  fire(): void {
    for (const listener of [...this.active]) listener();
  }
}

describe('modern cadence', () => {
  it('parks on the phase grid, opens a cadence turn, then derives a fresh future grid', async () => {
    const { home, world } = fixture();
    let clock = NOW;
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx: TurnContext) => {
      seen.push(ctx.trigger);
      if (ctx.turn === 1) clock += 5_000;
      return wait();
    }, world, {
      worldPollMs: 0, now: () => clock, schedule: manual.schedule, wakePolicy: modern(5),
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      const firstDue = nextCadenceDueMs('n1', 5, NOW)!;
      expect(manual.timers[0]!.ms).toBe(firstDue - NOW);
      expect(manual.timers[0]!.ms).toBeGreaterThanOrEqual(1000);

      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'cadence']));
      // The just-completed cadence turn parks again: a fresh future grid sampled
      // at the new actual park, never a replay of the consumed slot.
      await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
      const secondDue = nextCadenceDueMs('n1', 5, NOW + 5_000)!;
      expect(manual.timers[1]!.ms).toBe(secondDue - (NOW + 5_000));
    } finally {
      d.stop();
      await running;
    }
    expect(triggers(await readNode(home))).toEqual(['boot', 'cadence']);
  });

  it('arms no cadence at heartbeatSeconds 0', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(0),
    });
    const running = d.run();
    try {
      await parked(d, world);
      expect(manual.timers).toEqual([]);
      expect(seen).toEqual(['boot']);
    } finally {
      d.stop();
      await running;
    }
  });

  it('a long active turn schedules no extra turn; the next park chooses a future slot', async () => {
    const { home, world } = fixture();
    let clock = NOW;
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let releaseTurn!: () => void;
    const held = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const d = await openTestDriver(home, 'n1', async (ctx) => {
      seen.push(ctx.trigger);
      if (ctx.turn === 0) { entered(); await held; }
      return wait();
    }, world, {
      worldPollMs: 0, now: () => clock, schedule: manual.schedule, wakePolicy: modern(5),
    });
    const running = d.run();
    try {
      await reached;
      // The turn outlives many periods: cadence never preempts an active turn,
      // so no timer exists yet.
      clock = NOW + 60_000;
      expect(manual.timers).toEqual([]);
      releaseTurn();
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      const due = nextCadenceDueMs('n1', 5, NOW + 60_000)!;
      expect(manual.timers[0]!.ms).toBe(due - (NOW + 60_000));
      expect(seen).toEqual(['boot']);
    } finally {
      releaseTurn();
      d.stop();
      await running;
    }
  });

  it('a recoverable error turn still re-parks onto a future cadence grid', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return ctx.turn === 0
        ? { outcome: 'error', toolCalls: false, error: { code: 'network', status: null } }
        : wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'cadence']));
    } finally {
      d.stop();
      await running;
    }
  });

  it('a cadence fire that sees a visible foreign commit selects wakeup, not cadence', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let checks = 0;
    const real = WorldRepo.prototype.hasForeignCommit;
    const spy = vi.spyOn(WorldRepo.prototype, 'hasForeignCommit')
      .mockImplementation(async function (this: WorldRepo, from, author) {
        checks += 1;
        return real.call(this, from, author);
      });
    try {
      const d = await openTestDriver(home, 'n1', (ctx) => {
        seen.push(ctx.trigger);
        return wait();
      }, world, {
        worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
      });
      const running = d.run();
      try {
        await parked(d, world);
        await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
        await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(2));
        // A commit lands with no in-process poke while the park is already
        // asleep; the fire-time predicate, not the watcher, sees it.
        await commitAs(world, 'n2', { 'n2/peer.md': 'peer\n' }, 'peer');
        manual.timers[0]!.fire();
        await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup']));
      } finally {
        d.stop();
        await running;
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the cadence opportunity when the fire-time predicate read fails', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const errors: Error[] = [];
    const seen: TurnTrigger[] = [];
    let checks = 0;
    const real = WorldRepo.prototype.hasForeignCommit;
    const spy = vi.spyOn(WorldRepo.prototype, 'hasForeignCommit')
      .mockImplementation(async function (this: WorldRepo, from, author) {
        checks += 1;
        // Call 1 is the run's opening check; call 2 the park's opening check;
        // call 3 is the cadence fire's async check.
        if (checks === 3) throw new Error('world read failed');
        return real.call(this, from, author);
      });
    try {
      const d = await openTestDriver(home, 'n1', (ctx) => {
        seen.push(ctx.trigger);
        return wait();
      }, world, {
        worldPollMs: 0, now: () => NOW, schedule: manual.schedule,
        wakePolicy: modern(5), onError: (err) => { errors.push(err); },
      });
      const running = d.run();
      try {
        await parked(d, world);
        await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
        await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(2));
        manual.timers[0]!.fire();
        await vi.waitFor(() => expect(seen).toEqual(['boot', 'cadence']));
        expect(errors.map((err) => err.message))
          .toEqual(['wake predicate failed: world read failed']);
      } finally {
        d.stop();
        await running;
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('arms no cadence on an unsafe clock and keeps reactive wakes subscribed', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const errors: Error[] = [];
    const seen: TurnTrigger[] = [];
    let invalid = false;
    let invalidateNext = true;
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return wait();
    }, world, {
      worldPollMs: 0,
      now: () => (invalid ? Number.NaN : NOW),
      schedule: manual.schedule,
      wakePolicy: modern(5),
      onMaintenance: () => {
        if (invalidateNext) { invalid = true; invalidateNext = false; }
      },
      onError: (err) => { errors.push(err); },
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(errors.map((err) => err.name))
        .toEqual(['WakeClockUnavailableError']));
      expect(manual.timers).toEqual([]);
      // No cadence timer, but the park's subscriptions are live: a foreign
      // commit still wakes it as an ordinary wakeup.
      invalid = false;
      await commitAs(world, 'n2', { 'n2/peer.md': 'peer\n' }, 'peer');
      HeadWatcher.for(world, 0).poke();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup']));
    } finally {
      d.stop();
      await running;
    }
  }, 20_000);

  it('samples the effective policy lazily, AFTER onReady folds the journal', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const openings: (TurnContext['opening'] | undefined)[] = [];
    let policy: WakePolicy | null = null;
    const hooks: DriverHooks = {
      ...hooksFor(home),
      onReady: async () => { policy = { heartbeatSeconds: 5 }; },
    };
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      openings.push(ctx.opening);
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule,
      wakePolicy: () => policy, knownTypes: C13_EVENT_TYPES, hooks,
    });
    const running = d.run();
    try {
      await parked(d, world);
      // The incoming seam was legacy at construction time; only `onReady`
      // flipped it, and the turn-start sample therefore sees modern semantics.
      expect(policy).toEqual({ heartbeatSeconds: 5 });
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      const due = nextCadenceDueMs('n1', 5, NOW)!;
      expect(manual.timers[0]!.ms).toBe(due - NOW);
      expect(openings[0]).toBeDefined();
      expect(seen).toEqual(['boot']);
    } finally {
      d.stop();
      await running;
    }
  });
});

describe('modern explicit timers and the old count', () => {
  it('succeeds past twelve fires and with the legacy option at 0', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const errors: Error[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return { outcome: 'waiting', toolCalls: false, wakeAt: NOW + 60_000 };
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule,
      wakePolicy: modern(0), wakeBudgetPerHour: 0, onError: (err) => { errors.push(err); },
    });
    const running = d.run();
    try {
      await parked(d, world);
      for (let fire = 0; fire < 13; fire += 1) {
        await vi.waitFor(() => expect(manual.timers).toHaveLength(fire + 1));
        manual.timers[fire]!.fire();
        await vi.waitFor(() => expect(seen).toHaveLength(fire + 2));
      }
      expect(seen.every((trigger, index) => index === 0 ? trigger === 'boot' : trigger === 'timer'))
        .toBe(true);
      expect(errors).toEqual([]);
    } finally {
      d.stop();
      await running;
    }
  });

  it('legacy cells keep the exact count: option 0 refuses the first fire', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const errors: Error[] = [];
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return { outcome: 'waiting', toolCalls: false, wakeAt: NOW + 60_000 };
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule,
      wakeBudgetPerHour: 0, onError: (err) => { errors.push(err); },
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(errors.map((err) => err.name))
        .toEqual(['WakeBudgetExhaustedError']));
      expect(seen).toEqual(['boot']);
    } finally {
      d.stop();
      await running;
    }
  });

  it('anchors a relative duration at the actual park after maintenance', async () => {
    const { home, world } = fixture();
    let clock = NOW;
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return { outcome: 'waiting', toolCalls: false, wakeAfterMs: 1000 };
    }, world, {
      worldPollMs: 0, now: () => clock, schedule: manual.schedule,
      wakePolicy: modern(5),
      onMaintenance: () => { clock += 7_000; },
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      // The maintenance delay is behind us: exactly the requested positive
      // duration, and no cadence floor competing with it.
      expect(manual.timers[0]!.ms).toBe(1000);
      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'timer']));
    } finally {
      d.stop();
      await running;
    }
  });

  it('keeps an absolute instant that passed during closing at delay 0', async () => {
    const { home, world } = fixture();
    let clock = NOW;
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return { outcome: 'waiting', toolCalls: false, wakeAt: NOW + 5_000 };
    }, world, {
      worldPollMs: 0, now: () => clock, schedule: manual.schedule,
      wakePolicy: modern(5),
      onMaintenance: () => { clock += 7_000; },
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      expect(manual.timers[0]!.ms).toBe(0);
      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'timer']));
    } finally {
      d.stop();
      await running;
    }
  });

  it('refuses a trusted result carrying both timer forms with a bounded NodeStateError', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const handler: TurnHandler = () => ({
      outcome: 'waiting', toolCalls: false, wakeAt: NOW + 1_000, wakeAfterMs: 1_000,
    } as TurnResult);
    const d = await openTestDriver(home, 'n1', handler, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(0),
    });
    await expect(d.run()).rejects.toBeInstanceOf(NodeStateError);
    expect(manual.timers).toEqual([]);
    expect(d.state).toBe('stopped');
    expect((await readNode(home)).find((event) => event.type === 'node/shutdown')?.data)
      .toEqual({ reason: 'driver-error', error: 'NodeStateError: wait result carries both wakeAt and wakeAfterMs' });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses an invalid relative duration (%s) with a bounded NodeStateError and no timer',
    async (bad) => {
      const { home, world } = fixture();
      const manual = manualSchedule();
      const handler: TurnHandler = () => ({
        outcome: 'waiting', toolCalls: false, wakeAfterMs: bad,
      } as TurnResult);
      const d = await openTestDriver(home, 'n1', handler, world, {
        worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(0),
      });
      await expect(d.run()).rejects.toBeInstanceOf(NodeStateError);
      expect(manual.timers).toEqual([]);
      expect(d.state).toBe('stopped');
      expect((await readNode(home)).find((event) => event.type === 'node/shutdown')?.data)
        .toMatchObject({ reason: 'driver-error' });
    },
  );
});

describe('commit-retry priority and ownership', () => {
  async function blockGitAdd(world: WorldRepo): Promise<string> {
    const path = join(world.path, 'blocked.txt');
    await writeFile(path, 'unreadable');
    await chmod(path, 0o000);
    return path;
  }

  async function unblock(path: string): Promise<void> {
    await chmod(path, 0o600).catch(() => {});
    await rm(path, { force: true }).catch(() => {});
  }

  it('gives a pending retry priority over cadence, then arms a fresh grid after success', async () => {
    const { home, world } = fixture();
    const blocked = await blockGitAdd(world);
    const manual = manualSchedule();
    let turns = 0;
    const d = await openTestDriver(home, 'n1', async (ctx) => {
      turns += 1;
      if (ctx.turn === 2) await writeWorldFile(world, 'n1/ok.md', 'ok');
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers.map((timer) => timer.ms)).toEqual([1000]));
      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(turns).toBe(2));
      await parked(d, world);
      // The second refusal's retry is still the only armed timer: no cadence
      // competes with the bounded recovery.
      await vi.waitFor(() => expect(manual.timers.map((timer) => timer.ms)).toEqual([1000, 4000]));
      await unblock(blocked);
      manual.timers[1]!.fire();
      await vi.waitFor(() => expect(turns).toBe(3));
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(3));
      const due = nextCadenceDueMs('n1', 5, NOW)!;
      expect(manual.timers[2]!.ms).toBe(due - NOW);
    } finally {
      await unblock(blocked);
      d.stop();
      await running;
    }
    expect(triggers(await readNode(home))).toEqual(['boot', 'wakeup', 'wakeup']);
  }, 20_000);

  it('a canceled retry callback cannot null the next retry handle or latch a later park', async () => {
    const { home, world } = fixture();
    const blocked = await blockGitAdd(world);
    const manual = manualSchedule();
    let turn1Entered!: () => void;
    const entered = new Promise<void>((resolve) => { turn1Entered = resolve; });
    let releaseTurn1!: () => void;
    const held = new Promise<void>((resolve) => { releaseTurn1 = resolve; });
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', async (ctx) => {
      seen.push(ctx.trigger);
      if (ctx.turn === 1) { turn1Entered(); await held; }
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers.map((timer) => timer.ms)).toEqual([1000]));
      const retry = manual.timers[0]!;
      retry.fire();
      await entered;
      // The retry was consumed when it legitimately opened turn 1; a duplicate
      // stale invocation during the active turn is ignored by its generation.
      retry.fire();
      expect(loose(d).latch.requested).toBe(false);
      releaseTurn1();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup']));
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers.map((timer) => timer.ms)).toEqual([1000, 4000]));
      // A stale callback after the next park must not null this handle.
      retry.fire();
      expect(loose(d).retryTimer).not.toBeNull();
      expect(loose(d).retryGeneration).toBeGreaterThan(0);
    } finally {
      releaseTurn1();
      await unblock(blocked);
      d.stop();
      await running;
    }
  }, 20_000);

  it('a legitimate retry fired BEFORE park is one pending latch, an ordinary wakeup, then a fresh grid', async () => {
    const { home, world } = fixture();
    const blocked = await blockGitAdd(world);
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let holdMaintenance = true;
    let releaseMaintenance!: () => void;
    const heldMaintenance = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
    let enteredMaintenance!: () => void;
    const reachedMaintenance = new Promise<void>((resolve) => { enteredMaintenance = resolve; });
    const d = await openTestDriver(home, 'n1', async (ctx) => {
      seen.push(ctx.trigger);
      if (ctx.turn === 2) await writeWorldFile(world, 'n1/ok.md', 'ok');
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
      onMaintenance: async () => {
        if (holdMaintenance) {
          holdMaintenance = false;
          enteredMaintenance();
          await heldMaintenance;
        }
      },
    });
    const running = d.run();
    try {
      // The refusal armed the 1000 ms retry BEFORE park; the turn is still
      // closing in maintenance. Firing it here must set EXACTLY one pending
      // latch (no turn starts while maintenance is held).
      await reachedMaintenance;
      await vi.waitFor(() => expect(manual.timers.map((timer) => timer.ms)).toEqual([1000]));
      manual.timers[0]!.fire();
      expect(loose(d).latch.requested).toBe(true);
      expect(seen).toEqual(['boot']);
      expect(manual.timers.filter((timer) => timer.ms === 1000)).toHaveLength(1);

      releaseMaintenance();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup']));
      // The pending pre-park latch opened one ordinary wakeup, never a cadence
      // label. Any cadence arm made after the retry was consumed was cancelled
      // before it could fire; the next refusal's retry is 4000 ms.
      await parked(d, world);
      await vi.waitFor(() => {
        expect(manual.timers.map((timer) => timer.ms).filter((ms) => ms === 1000 || ms === 4000))
          .toEqual([1000, 4000]);
      });
      expect(seen).toEqual(['boot', 'wakeup']);

      await unblock(blocked);
      manual.timers.find((timer) => timer.ms === 4000)!.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup', 'wakeup']));
      await parked(d, world);
      // The successful turn settles the retry; the next park derives a FRESH
      // grid (one live cadence timer at the expected future delay).
      const due = nextCadenceDueMs('n1', 5, NOW)!;
      await vi.waitFor(() => expect(
        manual.timers.filter((timer) => timer.ms === due - NOW && !timer.cancelled),
      ).toHaveLength(1));
    } finally {
      releaseMaintenance();
      await unblock(blocked);
      d.stop();
      await running;
    }
  }, 20_000);
});

describe('the one owned timer: epoch + generation guards', () => {
  it('arms before the park\'s first await: a relative self-timer is scheduled before the stalled opening read', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const real = WorldRepo.prototype.hasForeignCommit;
    const spy = vi.spyOn(WorldRepo.prototype, 'hasForeignCommit')
      .mockImplementation(async function (this: WorldRepo, from, author) {
        calls += 1;
        if (calls === 2) { entered(); await held; }
        return real.call(this, from, author);
      });
    try {
      const d = await openTestDriver(home, 'n1', (ctx) => {
        seen.push(ctx.trigger);
        return { outcome: 'waiting', toolCalls: false, wakeAfterMs: 1000 };
      }, world, {
        worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(0),
      });
      const running = d.run();
      try {
        await reached;
        // The opening world read is STILL stalled, yet the timer exists: arming
        // happened inside the park before its first await.
        expect(manual.timers.map((timer) => timer.ms)).toEqual([1000]);
        manual.timers[0]!.fire();
        release();
        await vi.waitFor(() => expect(seen).toEqual(['boot', 'timer']));
      } finally {
        release();
        d.stop();
        await running;
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('arms cadence before the park\'s first await and fires it while the opening read is stalled', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const real = WorldRepo.prototype.hasForeignCommit;
    const spy = vi.spyOn(WorldRepo.prototype, 'hasForeignCommit')
      .mockImplementation(async function (this: WorldRepo, from, author) {
        calls += 1;
        if (calls === 2) { entered(); await held; }
        return real.call(this, from, author);
      });
    try {
      const d = await openTestDriver(home, 'n1', (ctx) => {
        seen.push(ctx.trigger);
        return wait();
      }, world, {
        worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
      });
      const running = d.run();
      try {
        await reached;
        const due = nextCadenceDueMs('n1', 5, NOW)!;
        expect(manual.timers.map((timer) => timer.ms)).toEqual([due - NOW]);
        manual.timers[0]!.fire();
        release();
        await vi.waitFor(() => expect(seen).toEqual(['boot', 'cadence']));
      } finally {
        release();
        d.stop();
        await running;
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('a canceled self-timer callback invoked during an ACTIVE turn cannot latch or take the next handle', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let releaseTurn!: () => void;
    const held = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const d = await openTestDriver(home, 'n1', async (ctx) => {
      seen.push(ctx.trigger);
      if (ctx.turn === 1) { entered(); await held; }
      return { outcome: 'waiting', toolCalls: false, wakeAt: NOW + 60_000 };
    }, world, { worldPollMs: 0, now: () => NOW, schedule: manual.schedule });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      const stale = manual.timers[0]!;
      await commitAs(world, 'n2', { 'n2/peer.md': 'peer\n' }, 'peer');
      HeadWatcher.for(world, 0).poke();
      await reached;
      // The foreign wake canceled this timer and opened turn 1, which is now
      // active. Its stale callback must change nothing.
      stale.fire();
      await Promise.resolve();
      expect(loose(d).wakeTimer).toBeNull();
      expect(loose(d).timerFired).toBe(false);
      expect(loose(d).latch.requested).toBe(false);
      releaseTurn();
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
      manual.timers[1]!.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup', 'timer']));
    } finally {
      releaseTurn();
      d.stop();
      await running;
    }
    // After stop and shutdown the same stale callback is still inert.
    manual.timers[0]!.fire();
    await Promise.resolve();
    expect(loose(d).timerFired).toBe(false);
  });

  it('a stale self-timer callback cannot clear the next park\'s handle or latch it', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return { outcome: 'waiting', toolCalls: false, wakeAt: NOW + 60_000 };
    }, world, { worldPollMs: 0, now: () => NOW, schedule: manual.schedule });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      const stale = manual.timers[0]!;
      await commitAs(world, 'n2', { 'n2/peer.md': 'peer\n' }, 'peer');
      HeadWatcher.for(world, 0).poke();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup']));
      await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
      const current = manual.timers[1]!;
      stale.fire();
      await Promise.resolve();
      expect(loose(d).wakeTimer).not.toBeNull();
      expect(loose(d).timerFired).toBe(false);
      expect(loose(d).latch.requested).toBe(false);
      current.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup', 'timer']));
    } finally {
      d.stop();
      await running;
    }
    // After shutdown a further stale invocation is a no-op, not a throw.
    const seenAfter = [...seen];
    manual.timers[0]!.fire();
    await Promise.resolve();
    expect(seen).toEqual(seenAfter);
    expect(loose(d).timerFired).toBe(false);
    expect(loose(d).latch.requested).toBe(false);
    expect(loose(d).wakeTimer).toBeNull();
  });

  it('a canceled cadence callback invoked during an ACTIVE turn cannot latch or take the next handle', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let releaseTurn!: () => void;
    const held = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const d = await openTestDriver(home, 'n1', async (ctx) => {
      seen.push(ctx.trigger);
      if (ctx.turn === 1) { entered(); await held; }
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      const stale = manual.timers[0]!;
      await commitAs(world, 'n2', { 'n2/peer.md': 'peer\n' }, 'peer');
      HeadWatcher.for(world, 0).poke();
      await reached;
      stale.fire();
      await Promise.resolve();
      expect(loose(d).wakeTimer).toBeNull();
      expect(loose(d).cadenceFired).toBe(false);
      expect(loose(d).latch.requested).toBe(false);
      releaseTurn();
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
      manual.timers[1]!.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup', 'cadence']));
    } finally {
      releaseTurn();
      d.stop();
      await running;
    }
  });

  it('a stale cadence callback cannot mutate a later park, and a stalled fire-time read after stop leaks nothing', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let stallNext = false;
    let releaseRead: (() => void) | null = null;
    const real = WorldRepo.prototype.hasForeignCommit;
    const spy = vi.spyOn(WorldRepo.prototype, 'hasForeignCommit')
      .mockImplementation(async function (this: WorldRepo, from, author) {
        if (stallNext) {
          stallNext = false;
          await new Promise<void>((resolve) => { releaseRead = resolve; });
        }
        return real.call(this, from, author);
      });
    try {
      const d = await openTestDriver(home, 'n1', (ctx) => {
        seen.push(ctx.trigger);
        return wait();
      }, world, {
        worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
      });
      const running = d.run();
      try {
        await parked(d, world);
        await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
        const stale = manual.timers[0]!;
        await commitAs(world, 'n2', { 'n2/peer.md': 'peer\n' }, 'peer');
        HeadWatcher.for(world, 0).poke();
        await vi.waitFor(() => expect(seen).toEqual(['boot', 'wakeup']));
        await vi.waitFor(() => expect(manual.timers).toHaveLength(2));
        stale.fire();
        await Promise.resolve();
        expect(loose(d).wakeTimer).not.toBeNull();
        expect(loose(d).cadenceFired).toBe(false);

        // The current cadence fire stalls in its async world read; stop() closes
        // the epoch, and the resolved read must not set a flag or latch/start.
        stallNext = true;
        manual.timers[1]!.fire();
        await vi.waitFor(() => expect(releaseRead).not.toBeNull());
        d.stop();
        releaseRead!();
        await running;
        expect(seen).toEqual(['boot', 'wakeup']);
        expect(loose(d).cadenceFired).toBe(false);
        expect(loose(d).wakeTimer).toBeNull();
        // AFTER shutdown, the canceled callback is invoked once more: it must
        // not set a flag, latch, take a handle or start a turn.
        const seenAfter = [...seen];
        manual.timers[1]!.fire();
        await Promise.resolve();
        expect(seen).toEqual(seenAfter);
        expect(loose(d).cadenceFired).toBe(false);
        expect(loose(d).latch.requested).toBe(false);
        expect(loose(d).wakeTimer).toBeNull();
      } finally {
        (releaseRead as unknown as (() => void) | null)?.();
        d.stop();
        await running;
      }
    } finally {
      spy.mockRestore();
    }
  }, 20_000);

  it('isolates the epoch guard and the generation guard on a current valid handle', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      const state = loose(d);
      const handle = state.wakeTimer;
      const generation = state.wakeTimerGeneration;
      const epoch = state.parkEpoch;

      // Current generation, OLD park epoch: the epoch guard alone must stop it.
      await state.onOwnedWake(generation, epoch - 1, 'cadence', true);
      await Promise.resolve();
      expect(seen).toEqual(['boot']);
      expect(state.wakeTimer).toBe(handle);
      expect(state.cadenceFired).toBe(false);
      expect(state.latch.requested).toBe(false);

      // OLD generation, current park epoch: the generation guard alone must
      // stop it. Together these rows distinguish either guard's removal.
      await state.onOwnedWake(generation - 1, epoch, 'cadence', true);
      await Promise.resolve();
      expect(seen).toEqual(['boot']);
      expect(state.wakeTimer).toBe(handle);
      expect(state.cadenceFired).toBe(false);
      expect(state.latch.requested).toBe(false);

      // The current generation + current epoch is live: it consumes and wakes.
      await state.onOwnedWake(generation, epoch, 'cadence', true);
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'cadence']));
    } finally {
      d.stop();
      await running;
    }
  });

  it('a conversation notice outranks a cadence fire and cancels its timer', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const conversation = new FakeConversation();
    const seen: TurnTrigger[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule,
      wakePolicy: modern(5), conversation,
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      conversation.arm({ count: 1, newestFrom: 'gateway', version: 1 });
      conversation.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'conversation']));
      expect(manual.timers[0]!.cancelled).toBe(true);
    } finally {
      d.stop();
      await running;
    }
  });

  it('defers the selected cadence OPENING through low storage without a new timer or turn', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let low = false;
    const diagnostics: string[] = [];
    const probe = async () => low
      ? { bytes: 0, inodes: 1_000 }
      : { bytes: 10 ** 12, inodes: 10 ** 9 };
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
      storage: { policy: { minFreeBytes: 1, minFreeInodes: 1, reserveBytes: 0, reserveInodes: 0 }, probe },
      storageRetryMs: 7,
      onError: (err) => { diagnostics.push(err.message); },
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      const cadence = manual.timers[0]!;
      low = true;
      cadence.fire();
      // Each deferral's retry is driven by hand (the same injected scheduler the
      // cadence uses); two of them prove repeated storageReady deferral.
      const retries = (): ManualTimer[] => manual.timers.filter((timer) => timer.ms === 7);
      await vi.waitFor(() => expect(retries().length).toBe(1), { timeout: 5_000 });
      for (let step = 0; step < 2; step += 1) {
        retries()[step]!.fire();
        await vi.waitFor(() => expect(diagnostics.length).toBe(step + 2), { timeout: 5_000 });
        await vi.waitFor(() => expect(retries().length).toBe(step + 2), { timeout: 5_000 });
      }
      // No turn/start and no model effect while low, and no second cadence arm:
      // the only new timers are the storage retry waits.
      expect(seen).toEqual(['boot']);
      const nonStorage = manual.timers.filter((timer) => timer.ms !== 7);
      expect(nonStorage).toHaveLength(1);
      expect((await readNode(home)).filter((event) => event.type === 'turn/start'))
        .toHaveLength(1);

      low = false;
      await vi.waitFor(() => expect(retries().length).toBe(3), { timeout: 5_000 });
      retries()[2]!.fire();
      await vi.waitFor(() => expect(seen).toEqual(['boot', 'cadence']), { timeout: 5_000 });
      // The recovered opening is the SAME cadence-origin opening, and its
      // completed turn then parks onto a fresh grid.
      await vi.waitFor(() => expect(manual.timers.filter((timer) => timer.ms !== 7)).toHaveLength(2));
    } finally {
      low = false;
      d.stop();
      await running;
    }
    expect(triggers(await readNode(home))).toEqual(['boot', 'cadence']);
  }, 20_000);

  it('stop during the storage deferral prevents the postponed cadence opening', async () => {
    const { home, world } = fixture();
    const manual = manualSchedule();
    const seen: TurnTrigger[] = [];
    let low = false;
    const diagnostics: string[] = [];
    const probe = async () => low
      ? { bytes: 0, inodes: 1_000 }
      : { bytes: 10 ** 12, inodes: 10 ** 9 };
    const d = await openTestDriver(home, 'n1', (ctx) => {
      seen.push(ctx.trigger);
      return wait();
    }, world, {
      worldPollMs: 0, now: () => NOW, schedule: manual.schedule, wakePolicy: modern(5),
      storage: { policy: { minFreeBytes: 1, minFreeInodes: 1, reserveBytes: 0, reserveInodes: 0 }, probe },
      storageRetryMs: 60_000,
      onError: (err) => { diagnostics.push(err.message); },
    });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      low = true;
      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(diagnostics).toHaveLength(1), { timeout: 5_000 });
      // Space returns before the stop so the shutdown can flush; the wait itself
      // must end from the stop, and no postponed cadence opening may occur.
      low = false;
      d.stop();
      await running;
      expect(seen).toEqual(['boot']);
    } finally {
      low = false;
      d.stop();
      await running.catch(() => {});
    }
    expect(triggers(await readNode(home))).toEqual(['boot']);
  }, 20_000);
});

describe('modern opening clock facts', () => {
  it('supplies the actual turn/start time and the elapsed recorded end, unavailable first', async () => {
    const { home, world } = fixture();
    let clock = NOW;
    const manual = manualSchedule();
    const openings: (TurnContext['opening'] | undefined)[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      openings.push(ctx.opening);
      return ctx.turn === 0
        ? { outcome: 'waiting', toolCalls: false, wakeAt: NOW + 5_000 }
        : wait();
    }, world, { worldPollMs: 0, now: () => clock, schedule: manual.schedule, wakePolicy: modern(0) });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      clock += 6_000;
      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(openings).toHaveLength(2));
    } finally {
      d.stop();
      await running;
    }
    const events = await readNode(home);
    const starts = startTimes(events);
    const ends = events.filter((event) => event.type === 'turn/end').map((event) => event.time);
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(openings[0]).toEqual({ openedAt: starts[0], sinceLastRecordedEndMs: null });
    expect(openings[1]).toEqual({ openedAt: starts[1], sinceLastRecordedEndMs: starts[1]! - ends[0]! });
    expect(openings[1]!.sinceLastRecordedEndMs).toBe(6_000);
  });

  it('is absent on a legacy turn (the narrow context keeps every old key)', async () => {
    const { home, world } = fixture();
    const keys: string[][] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      keys.push(Object.keys(ctx).sort());
      return wait();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    try {
      await parked(d, world);
    } finally {
      d.stop();
      await running;
    }
    expect(keys).toEqual([['gate', 'now', 'signal', 'trigger', 'turn', 'world']]);
  });

  it('rebuilds the recorded end from the hookless replay path', async () => {
    const { home, world } = fixture();
    let clock = NOW;
    const first = await openTestDriver(home, 'n1', wait, world, {
      worldPollMs: 0, now: () => clock, wakePolicy: modern(0),
    });
    const firstRun = first.run();
    await parked(first, world);
    first.stop();
    await firstRun;

    clock = NOW + 12_345;
    const openings: (TurnContext['opening'] | undefined)[] = [];
    const second = await openTestDriver(home, 'n1', (ctx) => {
      openings.push(ctx.opening);
      return wait();
    }, world, { worldPollMs: 0, now: () => clock, wakePolicy: modern(0) });
    const secondRun = second.run();
    try {
      await parked(second, world);
    } finally {
      second.stop();
      await secondRun;
    }
    expect(openings[0]).toEqual({ openedAt: clock, sinceLastRecordedEndMs: 12_345 });
  });

  it('rebuilds the recorded end from the hooks replay path', async () => {
    const { home, world } = fixture();
    let clock = NOW;
    const first = await openTestDriver(home, 'n1', wait, world, {
      worldPollMs: 0, now: () => clock, wakePolicy: modern(0),
    });
    const firstRun = first.run();
    await parked(first, world);
    first.stop();
    await firstRun;

    clock = NOW + 9_000;
    const openings: (TurnContext['opening'] | undefined)[] = [];
    const second = await openTestDriver(home, 'n1', (ctx) => {
      openings.push(ctx.opening);
      return wait();
    }, world, {
      worldPollMs: 0, now: () => clock, wakePolicy: modern(0),
      knownTypes: C13_EVENT_TYPES, hooks: hooksFor(home),
    });
    const secondRun = second.run();
    try {
      await parked(second, world);
    } finally {
      second.stop();
      await secondRun;
    }
    expect(openings[0]).toEqual({ openedAt: clock, sinceLastRecordedEndMs: 9_000 });
  });

  it('counts a synthetic resume closer as the last recorded end', async () => {
    const { home, world } = fixture();
    const T1 = NOW;
    const writer = await JournalWriter.open(home, 'n1', { now: () => T1 });
    writer.append('node/boot', { reason: 'start' });
    writer.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    await writer.close();

    let clock = T1 + 1_000;
    const openings: (TurnContext['opening'] | undefined)[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      openings.push(ctx.opening);
      return wait();
    }, world, { worldPollMs: 0, now: () => clock, wakePolicy: modern(0) });
    clock = T1 + 6_000;
    const running = d.run();
    try {
      await parked(d, world);
    } finally {
      d.stop();
      await running;
    }
    const events = await readNode(home);
    const synthetic = events.find((event) => event.type === 'turn/end');
    expect(synthetic?.data).toMatchObject({ turn: 0, outcome: 'interrupted', synthetic: true });
    expect(synthetic?.time).toBe(T1 + 1_000);
    expect(openings[0]).toEqual({ openedAt: T1 + 6_000, sinceLastRecordedEndMs: 5_000 });
  });

  it('reports an unavailable delta on a backwards clock, never a clamped zero', async () => {
    const { home, world } = fixture();
    let clock = NOW;
    const manual = manualSchedule();
    const openings: (TurnContext['opening'] | undefined)[] = [];
    const d = await openTestDriver(home, 'n1', (ctx) => {
      openings.push(ctx.opening);
      return ctx.turn === 0
        ? { outcome: 'waiting', toolCalls: false, wakeAt: NOW + 60_000 }
        : wait();
    }, world, { worldPollMs: 0, now: () => clock, schedule: manual.schedule, wakePolicy: modern(0) });
    const running = d.run();
    try {
      await parked(d, world);
      await vi.waitFor(() => expect(manual.timers).toHaveLength(1));
      clock = NOW - 10_000;
      manual.timers[0]!.fire();
      await vi.waitFor(() => expect(openings).toHaveLength(2));
    } finally {
      d.stop();
      await running;
    }
    expect(openings[1]!.openedAt).toBe(NOW - 10_000);
    expect(openings[1]!.sinceLastRecordedEndMs).toBeNull();
  });
});
