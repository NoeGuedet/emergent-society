import { describe, expect, it, vi } from 'vitest';
import { CLAIM_CHECK_THRESHOLD, MAX_BLOB_BYTES, isBlobRef } from '../../journal/blobs.js';
import { JournalWriter } from '../../journal/index.js';
import { collectEvents, useTempHome, withFailingWrite } from '../../journal/__tests__/helpers.js';
import { NodeDriver, type Router, type TurnTrigger } from '../driver.js';
import { MessageTooLargeError } from '../errors.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { Hub } from '../hub.js';
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

/** A minimal typed view of the driver's private writer, for fault injection. */
type LooseWriter = { append: (...args: unknown[]) => unknown; close(): Promise<unknown> };

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
    expect(events.at(-1)?.data).toEqual({ reason: 'handler-error', error: 'Error: boom' });
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

  it('propagates the handler error when the shutdown append also fails', async () => {
    const d = await NodeDriver.open(home(), 'n1', () => {
      throw new Error('boom');
    }, new DropRouter());
    // Fault injection: nothing outside the driver can reach the writer, so the
    // private field is patched to fail exactly where a poisoned writer or a
    // recorded write-behind failure would — the shutdown append.
    type LooseAppend = (...args: unknown[]) => unknown;
    const writer = (d as unknown as { writer: { append: LooseAppend } }).writer;
    const realAppend = writer.append.bind(writer);
    writer.append = (type: unknown, ...rest: unknown[]) => {
      if (type === 'node/shutdown') throw new Error('append dead');
      return realAppend(type, ...rest);
    };
    await expect(d.run()).rejects.toThrow('boom');
    expect(d.state).toBe('stopped');
  });

  it('propagates the handler error and still stops when close() fails', async () => {
    const d = await NodeDriver.open(home(), 'n1', () => {
      throw new Error('boom');
    }, new DropRouter());
    // Same fault-injection technique as the shutdown-append test: the writer is
    // private, so the field is reached through an annotated cast.
    type LooseClose = () => Promise<unknown>;
    const writer = (d as unknown as { writer: { close: LooseClose } }).writer;
    const realClose = writer.close.bind(writer);
    writer.close = async () => {
      // Release the lock and handle for real, then fail the way a poisoned
      // writer's close does: the run must survive it.
      await realClose();
      throw new Error('close dead');
    };
    await expect(d.run()).rejects.toThrow('boom');
    expect(d.state).toBe('stopped');
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

  it('delivers, claims and serves a claim-checked body intact', async () => {
    const body = 'b'.repeat(CLAIM_CHECK_THRESHOLD);
    const seen: string[] = [];
    const d = await NodeDriver.open(home(), 'n1', (ctx) => {
      seen.push(...ctx.messages.map((m) => m.body));
      return 'waiting' as const;
    }, new DropRouter());
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    await d.deliver(msg('x/m1', body));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    d.stop();
    await running;
    expect(seen[0]).toBe(body);
    const events = await log();
    // The envelope is claim-checked, but the claim names the real message id —
    // not the `undefined` an inbox fed the blob reference would have stored.
    expect(isBlobRef(events.find((e) => e.type === 'message/received')?.data ?? null))
      .toBe(true);
    expect(events.find((e) => e.type === 'inbox/claim')?.data)
      .toEqual({ turn: 1, messages: ['x/m1'] });
  });

  it('re-presents unclaimed mail after a resume, with trigger wakeup', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('message/received', {
      id: 'x/m1', from: 'x', kind: 'chat', wakeupRequested: false, body: 'held',
    });
    await w.close();
    const seen: { trigger: TurnTrigger; bodies: string[] }[] = [];
    const d = await NodeDriver.open(home(), 'n1', (ctx) => {
      seen.push({ trigger: ctx.trigger, bodies: ctx.messages.map((m) => m.body) });
      return 'waiting' as const;
    }, new DropRouter());
    expect(d.pendingCount).toBe(1);
    const running = d.run();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    d.stop();
    await running;
    expect(seen[0]).toEqual({ trigger: 'wakeup', bodies: ['held'] });
  });

  it('re-presents mail claimed by an interrupted turn after a resume', async () => {
    // The crash shape: the turn claimed m1 and opened, no turn/end was ever
    // journaled. Resume appends the synthetic interrupted closer, which is what
    // releases the claim — no event carries the release itself.
    const w = await JournalWriter.open(home(), 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('message/received', {
      id: 'x/m1', from: 'x', kind: 'chat', wakeupRequested: false, body: 'held',
    });
    w.append('inbox/claim', { turn: 0, messages: ['x/m1'] });
    w.append('turn/start', { turn: 0, trigger: 'boot' });
    await w.close();
    const seen: { trigger: TurnTrigger; bodies: string[] }[] = [];
    const d = await NodeDriver.open(home(), 'n1', (ctx) => {
      seen.push({ trigger: ctx.trigger, bodies: ctx.messages.map((m) => m.body) });
      return 'waiting' as const;
    }, new DropRouter());
    expect(d.pendingCount).toBe(1);
    const running = d.run();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    d.stop();
    await running;
    expect(seen[0]).toEqual({ trigger: 'wakeup', bodies: ['held'] });
  });

  it('re-presents a claim-checked message after close and resume', async () => {
    const body = 'b'.repeat(CLAIM_CHECK_THRESHOLD);
    const w = await JournalWriter.open(home(), 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('message/received', {
      id: 'x/m1', from: 'x', kind: 'chat', wakeupRequested: false, body,
    });
    await w.close();
    const seen: { trigger: TurnTrigger; bodies: string[] }[] = [];
    const d = await NodeDriver.open(home(), 'n1', (ctx) => {
      seen.push({ trigger: ctx.trigger, bodies: ctx.messages.map((m) => m.body) });
      return 'waiting' as const;
    }, new DropRouter());
    expect(d.pendingCount).toBe(1);
    const running = d.run();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    d.stop();
    await running;
    expect(seen[0]).toEqual({ trigger: 'wakeup', bodies: [body] });
  });

  it('rejects a run() called out of order', async () => {
    const d = await NodeDriver.open(home(), 'n1', wait, new DropRouter());
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    await expect(d.run()).rejects.toThrow('run() out of order');
    d.stop();
    await running;
  });

  it('stops cleanly with node/shutdown journaled when stop() precedes run()', async () => {
    const d = await NodeDriver.open(home(), 'n1', wait, new DropRouter());
    d.stop();
    await d.run();
    expect(d.state).toBe('stopped');
    const events = await log();
    expect(events.map((e) => e.type)).toEqual(['node/boot', 'node/shutdown']);
    expect(events[1]?.data).toEqual({ reason: 'stop-requested' });
  });

  it('shuts down with reason maintenance-error when the maintenance hook throws', async () => {
    const d = await NodeDriver.open(home(), 'n1', wait, new DropRouter(), {
      onMaintenance: () => { throw new Error('maint boom'); },
    });
    await expect(d.run()).rejects.toThrow('maint boom');
    expect(d.state).toBe('stopped');
    expect((await log()).at(-1)?.data)
      .toEqual({ reason: 'maintenance-error', error: 'Error: maint boom' });
  });

  it('refuses an oversize body before journaling anything', async () => {
    const sent: string[] = [];
    const d = await NodeDriver.open(home(), 'n1', async (ctx) => {
      // At the bound exactly: the writer would claim-check-truncate this, and a
      // truncated reference is refused at resume — so send() must reject first.
      await expect(ctx.send('b'.repeat(MAX_BLOB_BYTES), 'peer')).rejects
        .toBeInstanceOf(MessageTooLargeError);
      sent.push('survived');
      return 'waiting' as const;
    }, new DropRouter());
    const running = d.run();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    d.stop();
    await running;
    const events = await log();
    expect(events.filter((e) => e.type === 'message/sent')).toEqual([]);
    expect(events.filter((e) => e.type === 'message/undeliverable')).toEqual([]);
  });

  it('refuses an oversize delivery before journaling anything', async () => {
    const d = await NodeDriver.open(home(), 'n1', wait, new DropRouter());
    await expect(d.deliver(msg('x/m1', 'b'.repeat(MAX_BLOB_BYTES))))
      .rejects.toBeInstanceOf(MessageTooLargeError);
    expect(d.pendingCount).toBe(0);
    expect((await log()).filter((e) => e.type === 'message/received')).toEqual([]);
  });

  it('journals an undeliverable message and lets the turn end normally', async () => {
    // The real transport: no node owns 'ghost', so the Hub refuses the route.
    const hub = new Hub(home());
    const d = await NodeDriver.open(home(), 'n1', async (ctx) => {
      // The handler is never told: send() resolves and the fact is in the log.
      await ctx.send('boo', 'ghost');
      return 'waiting' as const;
    }, hub);
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    const events = await log();
    const sent = events.find((e) => e.type === 'message/sent');
    const undeliverable = events.find((e) => e.type === 'message/undeliverable');
    expect(sent?.data).toMatchObject({ id: 'n1/m1', to: 'ghost' });
    expect(undeliverable?.data)
      .toEqual({ id: 'n1/m1', to: 'ghost', reason: 'unknown-node' });
    // The sender's turn consumed itself normally: no error outcome at all.
    expect(events.filter((e) => e.type === 'turn/end').map((e) => (e.data as { outcome: string }).outcome))
      .toEqual(['waiting']);
  });

  it('journals not-accepting when the recipient is stopped', async () => {
    const hub = new Hub(home());
    const peer = await hub.boot('peer', wait);
    peer.stop();
    await peer.run();
    expect(peer.state).toBe('stopped');
    const d = await NodeDriver.open(home(), 'n1', async (ctx) => {
      await ctx.send('late', 'peer');
      return 'waiting' as const;
    }, hub);
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    const undeliverable = (await log())
      .find((e) => e.type === 'message/undeliverable');
    expect(undeliverable?.data)
      .toEqual({ id: 'n1/m1', to: 'peer', reason: 'not-accepting' });
  });

  it('labels a loop death outside the handler as driver-error, with its error', async () => {
    const d = await NodeDriver.open(home(), 'n1', wait, new DropRouter());
    // Fault injection: the flush barrier after the claim must fail so the loop
    // dies outside the handler — a handler-error would be a lie in the journal.
    const writer = (d as unknown as { writer: LooseWriter }).writer;
    const realAppend = writer.append.bind(writer);
    writer.append = (type: unknown, ...rest: unknown[]) => {
      if (type === 'turn/start') throw new Error('barrier dead');
      return realAppend(type, ...rest);
    };
    await expect(d.run()).rejects.toThrow('barrier dead');
    expect(d.state).toBe('stopped');
    const shutdown = (await log()).find((e) => e.type === 'node/shutdown');
    expect(shutdown?.data)
      .toEqual({ reason: 'driver-error', error: 'Error: barrier dead' });
  });

  it('journals driver-error when the flush barrier itself rejects', async () => {
    const d = await NodeDriver.open(home(), 'n1', wait, new DropRouter());
    // The recorded-write-behind shape: append() accepts, the barrier flush
    // fails. The failure is injected at the fs primitive the writer uses, so
    // nothing in the driver can be blamed for it.
    await withFailingWrite(home(), async () => {
      await expect(d.run()).rejects.toThrow('injected EIO');
    });
    expect(d.state).toBe('stopped');
    const shutdown = (await log()).find((e) => e.type === 'node/shutdown');
    expect(shutdown?.data)
      .toEqual({ reason: 'driver-error', error: 'Error: injected EIO' });
  });
});
