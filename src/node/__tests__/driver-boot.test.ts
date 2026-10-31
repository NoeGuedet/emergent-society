import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JournalWriter, UnknownEventTypeError, type EventEnvelope,
} from '../../journal/index.js';
import { appendTear, collectEvents } from '../../journal/__tests__/helpers.js';
import { NodeDriver, type TurnResult } from '../driver.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { readWorldState } from '../world-state.js';
import { runWorldDoctor, type DoctorReport } from '../world-doctor.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { ContextFold } from '../../context/fold.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { openTestDriver, useWorld } from './helpers.js';

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
    const d = await openTestDriver(home, 'n1', wait, world, { worldPollMs: 0 });
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
    const d = await openTestDriver(home, 'n1', wait, world, { worldPollMs: 0 });
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

  it('boots degraded when the interrupted turn\'s recovery commit is refused', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    await w.close(); // the crash shape: an open turn, no commit, no closer
    // A world directory the walk cannot read is the raw-EACCES refusal, not a
    // GitCommandError: the incident class that used to make the home unbootable.
    const locked = join(world.path, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const d = await openTestDriver(home, 'n1', wait, world, { worldPollMs: 0 });
      const events = await bootlog(home);
      expect(events.map((e) => e.type)).toEqual([
        'node/boot', 'turn/start', 'turn/end', 'world/commit-refused', 'node/boot',
      ]);
      // The synthetic closer is written WITHOUT a commit and the boot follows:
      // a damaged home still boots.
      expect(events[2]?.data).toEqual({
        turn: 0, outcome: 'interrupted', synthetic: true,
      });
      const refusal = events[3]!;
      expect(refusal.ignorable).toBe(true);
      expect(refusal.data).toMatchObject({
        turn: 0, refusal: { reason: 'walk-eacces' },
      });
      expect(events[4]?.data).toEqual({ reason: 'resume' });
      const state = await readWorldState(home);
      expect(state.degraded).toBe(true);
      expect(state.reason).toBe('walk-eacces');
      await closeIdle(d);
    } finally {
      await chmod(locked, 0o700).catch(() => {});
    }
  });

  it('refuses a forged doctor report on the error channel and journals no event', async () => {
    const { home, world } = fixture();
    const errors: string[] = [];
    // An invalid report can only arrive through a cast/injection (the doctor's
    // own writer now validates); the driver must not make it durable.
    const forged = { lock: 'free' } as unknown as DoctorReport;
    const d = await openTestDriver(home, 'n1', wait, world, {
      worldPollMs: 0, doctor: forged,
      onError: (err) => { errors.push(err.name); },
    });
    expect(errors).toEqual(['InvalidDoctorReportError']);
    const events = await bootlog(home);
    expect(events.map((e) => e.type)).toEqual(['node/boot']);
    // The durable history still folds: the poisoned payload never existed.
    const fold = new ContextFold();
    await fold.observe(await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES));
    await closeIdle(d);
  });

  it('repairs a torn tail before resuming', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    await w.close();
    await appendTear(home);
    const d = await openTestDriver(home, 'n1', wait, world, { worldPollMs: 0 });
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
    await expect(openTestDriver(home, 'n1', wait, world, { worldPollMs: 0 }))
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
    const d = await openTestDriver(home, 'n1', wait, world, {
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

describe('the world/doctor carrier (C3)', () => {
  it('journals the report after node/boot as an ignorable local event', async () => {
    const { home, world } = fixture();
    const report = await runWorldDoctor(world, {
      home, freeSpace: async () => ({ bytes: 100 * 1024 ** 3, inodes: 1_000_000 }),
    });
    const d = await openTestDriver(home, 'n1', wait, world, { worldPollMs: 0, doctor: report });
    const events = await bootlog(home);
    expect(events.map((event) => event.type)).toEqual(['node/boot', 'world/doctor']);
    expect(events[1]!.ignorable).toBe(true);
    expect(events[1]!.data).toEqual({ report });
    await closeIdle(d);
  });

  it('renders nothing and replays identically; an older reader skips the type', async () => {
    const { home, world } = fixture();
    const report = await runWorldDoctor(world, {
      home, freeSpace: async () => ({ bytes: 100 * 1024 ** 3, inodes: 1_000_000 }),
    });
    const d = await openTestDriver(home, 'n1', wait, world, { worldPollMs: 0, doctor: report });
    await closeIdle(d);

    // An older reader whose known set lacks the type still rebuilds: the
    // envelope is ignorable, which is the whole compatibility contract.
    const older = new Set([...C13_EVENT_TYPES].filter((type) => type !== 'world/doctor'));
    const events = await loadVerifiedEvents(home, 'n1', older);
    const doctor = events.find((event) => event.type === 'world/doctor');
    expect(doctor).toBeDefined();

    const withReport = new ContextFold();
    await withReport.observe(events);
    // The valid comparison is a PREFIX fold (seq 1 only), not a filtered event
    // list: the fold requires a gap-free chain, and the doctor is the last
    // event. A non-rendered fact leaves the projection byte-identical.
    const beforeDoctor = new ContextFold();
    await beforeDoctor.observe(events.filter((event) => event.seq === 0));
    // The watermark is the fold's observation pointer, not its projection: an
    // event advances it whether or not it renders. Everything the projection
    // is made of must stay identical.
    const { watermark: afterWatermark, ...afterProjection } = withReport.snapshot();
    const { watermark: beforeWatermark, ...beforeProjection } = beforeDoctor.snapshot();
    expect(afterProjection).toEqual(beforeProjection);
    expect(afterWatermark?.seq).toBe(events.at(-1)!.seq);
    expect(beforeWatermark?.seq).toBe(0);
    expect(withReport.snapshot().surface).toBeNull();
  });

  it('poisons the fold on a malformed report payload', async () => {
    const { home } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('world/doctor', { report: { lock: 'nope' } } as never, { ignorable: true });
    await w.close();
    const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
    await expect(new ContextFold().observe(events))
      .rejects.toThrow(/world\/doctor report is not a valid DoctorReport/);
  });
});
