import { describe, expect, it, vi } from 'vitest';
import {
  JournalWriter, UnknownEventTypeError, type EventEnvelope,
} from '../../journal/index.js';
import { appendTear, collectEvents, useTempHome } from '../../journal/__tests__/helpers.js';
import { NodeDriver, type Router } from '../driver.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { Hub } from '../hub.js';
import type { RoutedMessage } from '../message.js';

const home = useTempHome('node-boot-');

class DropRouter implements Router {
  async route(_msg: RoutedMessage): Promise<void> { /* drops */ }
}

const noOp = () => 'waiting' as const;

function bootlog(): Promise<EventEnvelope[]> {
  return collectEvents(home(), NODE_EVENT_TYPES, 'n1');
}

// The drivers opened here are never run nor closed (the loop is Task 6):
// resume effects are journaled and flushed by open() itself, the reader
// needs no lock, and the suite's temp home is removed after each test.
describe('NodeDriver boot and resume', () => {
  it('journals node/boot with reason start on a fresh node', async () => {
    await NodeDriver.open(home(), 'n1', noOp, new DropRouter());
    const events = await bootlog();
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['node/boot', { reason: 'start' }],
    ]);
  });

  it('closes an interrupted turn synthetically and resumes', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('turn/start', { turn: 0, trigger: 'boot' });
    await w.close(); // clean fs, logically unclosed turn: the crash shape
    await NodeDriver.open(home(), 'n1', noOp, new DropRouter());
    const events = await bootlog();
    expect(events.map((e) => e.type)).toEqual([
      'node/boot', 'turn/start', 'turn/end', 'node/boot',
    ]);
    expect(events[2]?.data).toEqual({ turn: 0, outcome: 'interrupted', synthetic: true });
    expect(events[3]?.data).toEqual({ reason: 'resume' });
  });

  it('repairs a torn tail before resuming', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('node/boot', { reason: 'start' });
    await w.close();
    await appendTear(home());
    await NodeDriver.open(home(), 'n1', noOp, new DropRouter());
    const events = await bootlog();
    expect(events.map((e) => e.type)).toEqual(['node/boot', 'node/boot']);
    expect(events[1]?.data).toEqual({ reason: 'resume' });
  });

  it('rebuilds the unclaimed inbox and the outgoing counter from the journal', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('message/sent', { id: 'n1/m1', to: 'x', kind: 'chat', wakeup: true, body: 'out' });
    w.append('message/received', {
      id: 'x/m1', from: 'x', kind: 'chat', wakeupRequested: false, body: 'in',
    });
    await w.close();
    const d = await NodeDriver.open(home(), 'n1', noOp, new DropRouter());
    expect(d.pendingCount).toBe(1);
    expect(d.nextMessageId()).toBe('n1/m2');
  });

  it('releases the writer lock when resume fails on an unknown event type', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('node/boot', { reason: 'start' });
    // Known to the writer (it checks no types) but not to the node registry:
    // the driver's replay must refuse it.
    w.append('future/thing', { n: 0 });
    await w.close();
    await expect(NodeDriver.open(home(), 'n1', noOp, new DropRouter()))
      .rejects.toThrow(UnknownEventTypeError);
    // The failed open released its lock: a fresh writer can take the node over
    // instead of hitting SessionAlreadyOwnedError forever.
    const w2 = await JournalWriter.open(home(), 'n1');
    await w2.close();
  });

  it('resumes a journal whose extra type the caller declared known', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('node/boot', { reason: 'start' });
    // `ignorable: false` is the required form: without the option the replay
    // refuses it (the test above), with it the event is understood here.
    w.append('future/thing', { n: 0 }, { ignorable: false });
    await w.close();
    const known = new Set([...NODE_EVENT_TYPES, 'future/thing']);
    const d = await NodeDriver.open(home(), 'n1', noOp, new DropRouter(), { knownTypes: known });
    expect(d.state).toBe('booting');
    d.stop();
    await d.run();
    expect(d.state).toBe('stopped');
    // Read back with the same widened vocabulary: the extra type is understood
    // here, which is exactly what the option declares.
    const events = await collectEvents(home(), known, 'n1');
    expect(events.map((e) => e.type)).toEqual([
      'node/boot', 'future/thing', 'node/boot', 'node/shutdown',
    ]);
  });

  it('accepts a receipt while still booting and serves it on the first turn', async () => {
    const hub = new Hub(home());
    const seen: { trigger: string; bodies: string[] }[] = [];
    // Booted but not yet run: the receipt is journaled now, and the loop's
    // first turn is a wakeup because the inbox is already non-empty.
    const n1 = await hub.boot('n1', (ctx) => {
      seen.push({ trigger: ctx.trigger, bodies: ctx.messages.map((m) => m.body) });
      return 'waiting' as const;
    });
    const n2 = await hub.boot('n2', async (ctx) => {
      if (ctx.trigger === 'boot') await ctx.send('early', 'n1');
      return 'waiting' as const;
    });
    const sender = n2.run();
    // n2's first turn routes into a node that has not started its loop yet.
    await vi.waitFor(() => expect(n1.pendingCount).toBe(1));
    expect(n1.state).toBe('booting');
    n2.stop();
    await sender;
    const n1Running = n1.run();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    n1.stop();
    await n1Running;
    expect(seen[0]).toEqual({ trigger: 'wakeup', bodies: ['early'] });
  });
});
