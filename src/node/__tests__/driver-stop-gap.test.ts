import { describe, expect, it, vi } from 'vitest';
import { collectEvents } from '../../journal/__tests__/helpers.js';
import { NODE_EVENT_TYPES, type TurnTrigger } from '../events.js';
import type { TurnContext, TurnResult } from '../driver.js';
import { openTestDriver, useWorld } from './helpers.js';

/**
 * The pre-existing stop/direction window (C1): after `storageReady` and the
 * stop check, the loop awaits `currentDirection()`. `stop()` has no active
 * controller to abort at that point, so without a re-check the loop can write
 * `turn/start`, create a fresh (unaborted) controller and run one handler turn
 * AFTER the stop. These rows are the distinguishing regression: no post-stop
 * turn/start and no handler effect, for the initial opening and a
 * cadence-triggered reopening.
 */

const fixture = useWorld('node-stop-gap-');
const NOW = 1_800_000_000_000;

const wait = (): TurnResult => ({ outcome: 'waiting', toolCalls: false });

function starts(events: readonly { type: string; data: unknown }[]): TurnTrigger[] {
  return events.filter((event) => event.type === 'turn/start')
    .map((event) => (event.data as { trigger: TurnTrigger }).trigger);
}

describe('a stop during the direction read opens no turn', () => {
  it('breaks before turn/start on the initial opening and runs no handler', async () => {
    const { home, world } = fixture();
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let handlerCalls = 0;
    const d = await openTestDriver(home, 'n1', (_ctx: TurnContext) => {
      handlerCalls += 1;
      return wait();
    }, world, {
      worldPollMs: 0,
      readDirection: async () => {
        entered();
        await held;
        return null;
      },
    });
    const running = d.run();
    try {
      await reached;
      d.stop();
      release();
      await running;
    } finally {
      release();
    }
    expect(d.state).toBe('stopped');
    expect(starts(await collectEvents(home, NODE_EVENT_TYPES, 'n1'))).toEqual([]);
    expect(handlerCalls).toBe(0);
  });

  it('breaks a cadence-origin reopening and runs no second handler turn', async () => {
    const { home, world } = fixture();
    const timers: { readonly ms: number; readonly fire: () => void }[] = [];
    const seen: TurnTrigger[] = [];
    let reads = 0;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const d = await openTestDriver(home, 'n1', (ctx: TurnContext) => {
      seen.push(ctx.trigger);
      return wait();
    }, world, {
      worldPollMs: 0,
      now: () => NOW,
      schedule: (ms, callback) => {
        timers.push({ ms, fire: callback });
        return () => {};
      },
      wakePolicy: () => ({ heartbeatSeconds: 5 }),
      readDirection: async () => {
        reads += 1;
        // The first direction read is the boot opening; the second is the
        // cadence-origin reopening the test stalls.
        if (reads === 2) {
          entered();
          await held;
        }
        return null;
      },
    });
    const running = d.run();
    try {
      await vi.waitFor(() => expect(timers).toHaveLength(1));
      timers[0]!.fire();
      await reached;
      d.stop();
      release();
      await running;
    } finally {
      release();
    }
    expect(d.state).toBe('stopped');
    expect(seen).toEqual(['boot']);
    expect(starts(await collectEvents(home, NODE_EVENT_TYPES, 'n1'))).toEqual(['boot']);
  });
});
