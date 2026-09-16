import { describe, expect, it, vi } from 'vitest';
import { collectEvents, useTempHome } from '../../journal/__tests__/helpers.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { Hub } from '../hub.js';
import { UnknownNodeError } from '../index.js';
import type { Message, RoutedMessage } from '../message.js';

const home = useTempHome('node-hub-');

describe('Hub', () => {
  it('runs a ping-pong between two nodes, journaled on both sides', async () => {
    const hub = new Hub(home());
    const pongs: Message[] = [];
    const a = await hub.boot('a', async (ctx) => {
      for (const m of ctx.messages) {
        if (m.body === 'ping') await ctx.send('pong', 'b', { replyTo: m.id });
      }
      return 'waiting' as const;
    });
    const b = await hub.boot('b', async (ctx) => {
      if (ctx.trigger === 'boot') await ctx.send('ping', 'a');
      for (const m of ctx.messages) {
        if (m.body === 'pong') pongs.push(m);
      }
      return 'waiting' as const;
    });
    const running = [a.run(), b.run()];
    await vi.waitFor(() => expect(pongs).toHaveLength(1));
    hub.stopAll();
    await Promise.all(running);

    expect(pongs[0]?.replyTo).toBe('b/m1');
    const aLog = await collectEvents(home(), NODE_EVENT_TYPES, 'a');
    const bLog = await collectEvents(home(), NODE_EVENT_TYPES, 'b');
    const aSent = aLog.find((e) => e.type === 'message/sent');
    const bReceived = bLog.find((e) => e.type === 'message/received');
    expect((aSent?.data as { id: string }).id).toBe('a/m1');
    expect((bReceived?.data as { id: string }).id).toBe('a/m1');
    expect((bReceived?.data as { replyTo?: string }).replyTo).toBe('b/m1');
  });

  it('rejects routing to an unknown node', async () => {
    const hub = new Hub(home());
    const ghost: RoutedMessage = {
      id: 'x/m1', from: 'x', to: 'ghost', kind: 'chat', wakeup: true, body: 'boo',
    };
    await expect(hub.route(ghost)).rejects.toThrow(UnknownNodeError);
  });

  it('resumes a node through a new Hub, ids continuing', async () => {
    const hub1 = new Hub(home());
    const first = await hub1.boot('n1', async (ctx) => {
      if (ctx.trigger === 'boot') await ctx.send('note to self', 'n1');
      return 'waiting' as const;
    });
    let running = first.run();
    await vi.waitFor(() => expect(first.pendingCount).toBe(0));
    hub1.stopAll();
    await running;

    // A new Hub over the same home is a process restart.
    const hub2 = new Hub(home());
    const second = await hub2.boot('n1', () => 'waiting');
    expect(second.nextMessageId()).toBe('n1/m2');
    running = second.run();
    await vi.waitFor(() => expect(second.state).toBe('waiting'));
    hub2.stopAll();
    await running;
    const log = await collectEvents(home(), NODE_EVENT_TYPES, 'n1');
    const boots = log.filter((e) => e.type === 'node/boot');
    expect(boots.map((e) => (e.data as { reason: string }).reason))
      .toEqual(['start', 'resume']);
  });
});
