import { describe, expect, it, vi } from 'vitest';
import { collectEvents, useTempHome } from '../../journal/__tests__/helpers.js';
import { NodeDriver, type Router, type TurnTrigger } from '../driver.js';
import { NODE_EVENT_TYPES } from '../events.js';
import type { RoutedMessage } from '../message.js';

const home = useTempHome('node-loop-');

class DropRouter implements Router {
  routed: RoutedMessage[] = [];
  async route(msg: RoutedMessage): Promise<void> { this.routed.push(msg); }
}

const wait = () => 'waiting' as const;

function msg(id: string, body: string, over: Partial<RoutedMessage> = {}): RoutedMessage {
  return { id, from: 'x', to: 'n1', kind: 'chat', wakeup: true, body, ...over };
}

function log() {
  return collectEvents(home(), NODE_EVENT_TYPES, 'n1');
}

describe('NodeDriver run loop', () => {
  it('chains turns with trigger chain until the handler waits', async () => {
    const triggers: TurnTrigger[] = [];
    const d = await NodeDriver.open(home(), 'n1', (ctx) => {
      triggers.push(ctx.trigger);
      return triggers.length < 3 ? 'chained' : 'waiting';
    }, new DropRouter());
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    expect(triggers).toEqual(['boot', 'chain', 'chain']);
    expect((await log()).map((e) => e.type)).toEqual([
      'node/boot',
      'turn/start', 'turn/end',
      'turn/start', 'turn/end',
      'turn/start', 'turn/end',
      'node/shutdown',
    ]);
    expect(d.state).toBe('stopped');
  });

  it('wakes a parked node on delivery and claims the message', async () => {
    const seen: { trigger: TurnTrigger; bodies: string[] }[] = [];
    const d = await NodeDriver.open(home(), 'n1', (ctx) => {
      seen.push({ trigger: ctx.trigger, bodies: ctx.messages.map((m) => m.body) });
      return 'waiting';
    }, new DropRouter());
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    await d.deliver(msg('x/m1', 'hello'));
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    d.stop();
    await running;
    expect(seen[1]).toEqual({ trigger: 'wakeup', bodies: ['hello'] });
    const events = await log();
    expect(events.find((e) => e.type === 'message/received')?.data)
      .toMatchObject({ id: 'x/m1', wakeupRequested: true });
    expect(events.find((e) => e.type === 'inbox/claim')?.data)
      .toEqual({ turn: 1, messages: ['x/m1'] });
  });

  it('coalesces the wake: only the first delivery arms the latch', async () => {
    const d = await NodeDriver.open(home(), 'n1', wait, new DropRouter());
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    // Un-awaited: both synchronous prefixes run before the loop can resume,
    // so the second delivery deterministically observes the armed latch.
    const p1 = d.deliver(msg('x/m1', 'one'));
    const p2 = d.deliver(msg('x/m2', 'two'));
    await Promise.all([p1, p2]);
    d.stop();
    await running;
    const events = await log();
    const received = events.filter((e) => e.type === 'message/received');
    expect(received.map((e) => (e.data as { wakeupRequested: boolean }).wakeupRequested))
      .toEqual([true, false]);
    expect(events.find((e) => e.type === 'inbox/claim')?.data)
      .toEqual({ turn: 1, messages: ['x/m1', 'x/m2'] });
  });

  it('journals an error turn and shuts down when the handler throws', async () => {
    const d = await NodeDriver.open(home(), 'n1', () => {
      throw new Error('boom');
    }, new DropRouter());
    await expect(d.run()).rejects.toThrow('boom');
    const events = await log();
    expect(events.at(-2)?.data).toMatchObject({ outcome: 'error', error: 'Error: boom' });
    expect(events.at(-1)?.data).toEqual({ reason: 'handler-error' });
    expect(d.state).toBe('stopped');
  });

  it('makes message/sent durable before routing', async () => {
    let sentDurableInRoute = false;
    class CheckingRouter implements Router {
      async route(m: RoutedMessage): Promise<void> {
        const events = await log();
        sentDurableInRoute = events.some(
          (e) => e.type === 'message/sent' && (e.data as { id: string }).id === m.id,
        );
      }
    }
    const d = await NodeDriver.open(home(), 'n1', async (ctx) => {
      await ctx.send('hello', 'peer');
      return 'waiting' as const;
    }, new CheckingRouter());
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    expect(sentDurableInRoute).toBe(true);
  });

  it('runs maintenance once per park', async () => {
    let maintenanceCalls = 0;
    const d = await NodeDriver.open(home(), 'n1', wait, new DropRouter(), {
      onMaintenance: () => { maintenanceCalls += 1; },
    });
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    expect(maintenanceCalls).toBe(1);
  });
});
