import { describe, expect, it } from 'vitest';
import { JournalWriter, type EventEnvelope } from '../../journal/index.js';
import { appendTear, collectEvents, useTempHome } from '../../journal/__tests__/helpers.js';
import { NodeDriver, type Router } from '../driver.js';
import { NODE_EVENT_TYPES } from '../events.js';
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
});
