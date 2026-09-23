import { describe, expect, it } from 'vitest';
import {
  JournalWriter, UnknownEventTypeError, type EventEnvelope,
} from '../../journal/index.js';
import { appendTear, collectEvents } from '../../journal/__tests__/helpers.js';
import { NodeDriver, type TurnResult } from '../driver.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { useWorld } from './helpers.js';

const fixture = useWorld('node-boot-');

const wait = (): TurnResult => ({ outcome: 'waiting', toolCalls: false });

function bootlog(home: string): Promise<EventEnvelope[]> {
  return collectEvents(home, NODE_EVENT_TYPES, 'n1');
}

/** Releases a booting driver's writer handle without adding a live turn. */
async function closeIdle(d: NodeDriver): Promise<void> {
  d.stop();
  await d.run();
}

// Every driver here is stopped and run once its journal assertions are made:
// open() journals and flushes the resume effects itself, so the reader needs no
// live loop, and running to the clean close keeps no writer's FileHandle open
// to GC (a driver left 'booting' leaks its handle — DEP0137).
describe('NodeDriver boot and resume', () => {
  it('journals node/boot with reason start on a fresh node', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    const events = await bootlog(home);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['node/boot', { reason: 'start' }],
    ]);
    await closeIdle(d);
  });

  it('closes an interrupted turn synthetically and resumes', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    await w.close(); // clean fs, logically unclosed turn: the crash shape
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    const events = await bootlog(home);
    expect(events.map((e) => e.type)).toEqual([
      'node/boot', 'turn/start', 'turn/end', 'node/boot',
    ]);
    // Nothing was written, so the resume commit has nothing to record and the
    // closer carries no hash.
    expect(events[2]?.data).toEqual({ turn: 0, outcome: 'interrupted', synthetic: true });
    expect(events[3]?.data).toEqual({ reason: 'resume' });
    await closeIdle(d);
  });

  it('repairs a torn tail before resuming', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    await w.close();
    await appendTear(home);
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    const events = await bootlog(home);
    expect(events.map((e) => e.type)).toEqual(['node/boot', 'node/boot']);
    expect(events[1]?.data).toEqual({ reason: 'resume' });
    await closeIdle(d);
  });

  it('releases the writer lock when resume fails on an unknown event type', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    // Known to the writer (it checks no types) but not to the node registry:
    // the driver's replay must refuse it. The retired `message/*` vocabulary
    // fails this way too, which is what makes a C1.2-era journal unreadable here
    // rather than silently misread.
    w.append('future/thing', { n: 0 });
    await w.close();
    await expect(NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 }))
      .rejects.toThrow(UnknownEventTypeError);
    // The failed open released its lock: a fresh writer can take the node over
    // instead of hitting SessionAlreadyOwnedError forever.
    const w2 = await JournalWriter.open(home, 'n1');
    await w2.close();
  });

  it('resumes a journal whose extra type the caller declared known', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    // `ignorable: false` is the required form: without the option the replay
    // refuses it (the test above), with it the event is understood here.
    w.append('future/thing', { n: 0 }, { ignorable: false });
    await w.close();
    const known = new Set([...NODE_EVENT_TYPES, 'future/thing']);
    const d = await NodeDriver.open(home, 'n1', wait, world, {
      worldPollMs: 0, knownTypes: known,
    });
    expect(d.state).toBe('booting');
    d.stop();
    await d.run();
    expect(d.state).toBe('stopped');
    // Read back with the same widened vocabulary: the extra type is understood
    // here, which is exactly what the option declares.
    const events = await collectEvents(home, known, 'n1');
    expect(events.map((e) => e.type)).toEqual([
      'node/boot', 'future/thing', 'node/boot', 'node/shutdown',
    ]);
  });
});
