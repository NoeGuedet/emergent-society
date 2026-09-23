import { describe, expect, it, vi } from 'vitest';
import { JournalWriter } from '../../journal/index.js';
import { NodeDriver, type TurnResult, type TurnTrigger } from '../driver.js';
import type { EventEnvelope } from '../../journal/index.js';
import { HeadWatcher } from '../watcher.js';
import { WorldRepo, type WorldRange } from '../world.js';
import {
  commitAs, committedContent, readNode, useWorld, worldLog, writeWorldFile,
} from './helpers.js';

const fixture = useWorld('node-world-physics-');
/** A second world whose watcher runs its interval, for the out-of-process path. */
const timed = useWorld('node-world-timed-', { pollMs: 25 });

const wait = (): TurnResult => ({ outcome: 'waiting', toolCalls: false });
const acted = (): TurnResult => ({ outcome: 'waiting', toolCalls: true });

/** Long enough for a wake evaluation (two git reads) to have finished, or not to. */
const quiet = (ms = 80): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** Parks the driver, then waits until its subscription to the world is in place. */
async function parked(d: NodeDriver, world: WorldRepo, subscribers = 1): Promise<void> {
  await vi.waitFor(() => expect(d.state).toBe('waiting'));
  await vi.waitFor(() => expect(HeadWatcher.for(world).subscriberCount).toBe(subscribers));
}

/** The data of the first event of a type. */
function first(events: readonly EventEnvelope[], type: string): Record<string, unknown> {
  const e = events.find((event) => event.type === type);
  if (e === undefined) throw new Error(`no ${type} event`);
  return e.data as Record<string, unknown>;
}

describe('the world as the only channel', () => {
  it('commits the world at the end of a turn, authored by the node, and records the hash', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', async () => {
      await writeWorldFile(world, 'n1/notes.md', 'hello');
      return acted();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);
    d.stop();
    await running;

    const events = await readNode(home);
    const commit = first(events, 'turn/end')['commit'];
    expect(commit).toBe(await world.headHash());
    expect(await worldLog(world)).toEqual([`${commit} n1`]);
    expect(await committedContent(world, 'n1/notes.md')).toBe('hello');
  });

  it('records the commit of every turn, one per turn', async () => {
    const { home, world } = fixture();
    let turns = 0;
    const d = await NodeDriver.open(home, 'n1', async () => {
      turns += 1;
      await writeWorldFile(world, `n1/${turns}.md`, String(turns));
      return { outcome: turns < 2 ? 'chained' : 'waiting', toolCalls: true } as TurnResult;
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);
    d.stop();
    await running;
    const events = await readNode(home);
    const ends = events.filter((e) => e.type === 'turn/end').map((e) => e.data as { commit: string });
    expect(ends.map((e) => e.commit))
      .toEqual((await worldLog(world)).map((line) => line.split(' ')[0]));
    expect(await worldLog(world)).toHaveLength(2);
  });

  it('journals an empty turn as ignorable, and commits nothing', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);
    d.stop();
    await running;
    const events = await readNode(home);
    const end = events.find((e) => e.type === 'turn/end');
    // The turn woke and changed nothing: it is still a turn, and the envelope
    // says a reader may skip it without loss (kernel.md §5.4).
    expect(end?.ignorable).toBe(true);
    expect(end?.data).toEqual({ turn: 0, outcome: 'waiting' });
    expect(await world.headHash()).toBeNull();
  });

  it('does not mark a turn ignorable when a tool was called', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', acted, world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);
    d.stop();
    await running;
    const end = (await readNode(home)).find((e) => e.type === 'turn/end');
    expect(end?.ignorable).toBeUndefined();
    expect(end?.data).toEqual({ turn: 0, outcome: 'waiting' });
  });

  it('does not mark a turn ignorable when the world changed without a tool call', async () => {
    // A Run — a process the node left alive (kernel.md §6) — writes to the world
    // with no tool call in the turn: the commit, not the report, settles it.
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', async () => {
      await writeWorldFile(world, 'n1/by-a-run.md', 'x');
      return wait();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);
    d.stop();
    await running;
    const end = (await readNode(home)).find((e) => e.type === 'turn/end');
    expect(end?.ignorable).toBeUndefined();
    expect((end?.data as { commit?: string }).commit).toBe(await world.headHash());
  });
});

describe('the turn closer', () => {
  it('is durable before the turn ends, commit hash and all', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', async () => {
      await writeWorldFile(world, 'n1/notes.md', 'hello');
      return acted();
    }, world, { worldPollMs: 0, batchWindowMs: 10_000 });
    const running = d.run();
    await parked(d, world);
    // Read the log while the writer is still open and its write-behind window
    // has not elapsed: the closer is on disk only because it is flushed per
    // event (kernel.md §3). A crash here must not leave a world commit that the
    // journal — the only record of which turn produced it — never names.
    const end = (await readNode(home)).find((e) => e.type === 'turn/end');
    expect((end?.data as { commit?: string }).commit).toBe(await world.headHash());
    d.stop();
    await running;
  });

  it('is flushed before the loop unwinds on a failed turn', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', () => {
      throw new Error('boom');
    }, world, { worldPollMs: 0 });
    type LooseWriter = { flush(): Promise<void> };
    const writer = (d as unknown as { writer: LooseWriter }).writer;
    const real = writer.flush.bind(writer);
    let flushes = 0;
    writer.flush = async () => { flushes += 1; await real(); };
    await expect(d.run()).rejects.toThrow('boom');
    // The turn/start barrier and the closer — not the closer and then close():
    // the write-behind window would only be flushed by a process that lived.
    expect(flushes).toBe(2);
    const end = (await readNode(home)).find((e) => e.type === 'turn/end');
    expect(end?.data).toMatchObject({ outcome: 'error' });
  });
});

describe('the wake predicate', () => {
  it('does not wake on a static world', async () => {
    const { home, world } = fixture();
    const seen: number[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => { seen.push(ctx.turn); return wait(); },
      world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);
    // Movement announced with nothing behind it: the predicate reads HEAD and
    // finds it unmoved, so the node stays parked and spends nothing.
    await HeadWatcher.for(world).check();
    await HeadWatcher.for(world).check();
    await quiet();
    expect(seen).toEqual([0]);
    expect(d.state).toBe('waiting');
    d.stop();
    await running;
  });

  it('never wakes on its own commit', async () => {
    const { home, world } = fixture();
    const seen: number[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => { seen.push(ctx.turn); return wait(); },
      world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);
    // A commit authored by n1 landing while n1 is parked — exactly what its own
    // turn-end produces. The predicate is "commits not authored by me", so a
    // node cannot self-excite by writing.
    await commitAs(world, 'n1', { 'n1/mine.md': 'mine' });
    await HeadWatcher.for(world).check();
    await quiet();
    expect(seen).toEqual([0]);
    expect(d.state).toBe('waiting');
    d.stop();
    await running;
  });

  it('wakes on a foreign commit, carrying the range from the watermark to HEAD', async () => {
    const { home, world } = fixture();
    const seen: { trigger: TurnTrigger; world: WorldRange }[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      seen.push({ trigger: ctx.trigger, world: ctx.world });
      return wait();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);

    const foreign = await commitAs(world, 'n2', { 'n2/hello.md': 'hi' });
    await HeadWatcher.for(world).check();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    // The first turn opened on an unborn world, so the watermark is null: the
    // range is what the node has not been shown, not what it wrote.
    expect(seen[1]).toEqual({ trigger: 'wakeup', world: { from: null, to: foreign } });

    // The watermark advanced to the HEAD that turn opened on, so the next wake
    // carries only what landed after it.
    await parked(d, world);
    const later = await commitAs(world, 'n3', { 'n3/yo.md': 'yo' });
    await HeadWatcher.for(world).check();
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[2]).toEqual({ trigger: 'wakeup', world: { from: foreign, to: later } });
    d.stop();
    await running;
  });

  it('coalesces several foreign commits into one wake', async () => {
    const { home, world } = fixture();
    const seen: WorldRange[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => { seen.push(ctx.world); return wait(); },
      world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);

    await commitAs(world, 'n2', { 'n2/a.md': 'a' });
    const head = await commitAs(world, 'n3', { 'n3/b.md': 'b' });
    await HeadWatcher.for(world).check();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    await quiet();
    // One diff, one turn: the range covers both commits.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ from: null, to: head });
    d.stop();
    await running;
  });

  it('wakes on a commit made outside this process, on the watcher interval', async () => {
    const { home, world } = timed();
    const seen: TurnTrigger[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => { seen.push(ctx.trigger); return wait(); },
      world, { worldPollMs: 25 });
    const running = d.run();
    await parked(d, world);
    // No poke at all: this is the human's commit, or another process's (§5.1).
    await commitAs(world, 'human', { 'human/hello.md': 'hello' });
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 3000 });
    expect(seen[1]).toBe('wakeup');
    d.stop();
    await running;
  });

  it('does not let a stale evaluation wake the node on an unmoved world', async () => {
    const { home, world } = fixture();
    const triggers: TurnTrigger[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      triggers.push(ctx.trigger);
      return wait();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);
    expect(triggers).toEqual(['boot']);

    // Stall the next predicate read. That evaluation captured its input before
    // its git call, so it will still be in flight — and still answering about
    // the world as it was — when the wake it belongs to has been consumed by
    // the evaluation that follows it.
    const real = WorldRepo.prototype.commitsSince;
    let stall = true;
    vi.spyOn(WorldRepo.prototype, 'commitsSince').mockImplementation(
      async function (this: WorldRepo, from: string | null) {
        const stalled = stall;
        stall = false;
        if (stalled) await quiet(150);
        return real.call(this, from);
      },
    );

    await commitAs(world, 'n2', { 'n2/a.md': 'a' });
    await HeadWatcher.for(world).check(); // notification one: the stalled evaluation
    const head = await commitAs(world, 'n3', { 'n3/b.md': 'b' });
    await HeadWatcher.for(world).check(); // notification two: the wake that lands

    await vi.waitFor(() => expect(triggers).toHaveLength(2));
    expect(triggers[1]).toBe('wakeup');
    const start = (await readNode(home))
      .find((e) => e.type === 'turn/start' && (e.data as { turn: number }).turn === 1);
    expect((start?.data as { world: WorldRange }).world).toEqual({ from: null, to: head });

    // The stalled evaluation resolves after that park ended: it must not arm the
    // latch of the park that follows, or the node would take a `wakeup` turn on
    // a world that has not moved since it looked.
    await parked(d, world);
    await quiet(250);
    expect(triggers).toEqual(['boot', 'wakeup']);
    expect(d.state).toBe('waiting');
    d.stop();
    await running;
  });

  it('parks instead of dying when the check a park opens with fails', async () => {
    const { home, world } = fixture();
    const seen: number[] = [];
    const spy = vi.spyOn(WorldRepo.prototype, 'commitsSince');
    const d = await NodeDriver.open(home, 'n1', (ctx) => { seen.push(ctx.turn); return wait(); }, world, {
      worldPollMs: 0,
      // Runs after the turn closed and before the park: the read that fails is
      // the park's own pre-check.
      onMaintenance: () => { spy.mockRejectedValue(new Error('git dead')); },
    });
    const running = d.run();
    await parked(d, world);
    expect(seen).toEqual([0]);
    expect(d.state).toBe('waiting');

    // The failure delayed the wake, it did not lose it: the next movement lands.
    spy.mockRestore();
    await commitAs(world, 'n2', { 'n2/a.md': 'a' });
    await HeadWatcher.for(world).check();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    d.stop();
    await running;
  });

  it('parks instead of dying when the watcher’s evaluation fails', async () => {
    const { home, world } = fixture();
    const seen: number[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => { seen.push(ctx.turn); return wait(); },
      world, { worldPollMs: 0 });
    const running = d.run();
    await parked(d, world);

    const spy = vi.spyOn(WorldRepo.prototype, 'commitsSince')
      .mockRejectedValue(new Error('git dead'));
    await commitAs(world, 'n2', { 'n2/a.md': 'a' });
    await HeadWatcher.for(world).check(); // the listener's read fails
    await quiet();
    expect(seen).toEqual([0]);
    expect(d.state).toBe('waiting');

    spy.mockRestore();
    await commitAs(world, 'n3', { 'n3/b.md': 'b' });
    await HeadWatcher.for(world).check();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    d.stop();
    await running;
  });

  it('wakes a node joining a populated world, on the whole history', async () => {
    const { home, world } = fixture();
    const head = await commitAs(world, 'n2', { 'n2/earlier.md': 'earlier' });
    const seen: { trigger: TurnTrigger; world: WorldRange }[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      seen.push({ trigger: ctx.trigger, world: ctx.world });
      return wait();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // The first turn of a node with no journal is a wakeup when the world
    // already holds commits it has never been shown.
    expect(seen[0]).toEqual({ trigger: 'wakeup', world: { from: null, to: head } });
    d.stop();
    await running;
  });
});

describe('two nodes on one world', () => {
  it('serializes the commits of two drivers sharing the world, losing no effect', async () => {
    const { home, world } = fixture();
    // A barrier so both turns write before either commits: the worst case for a
    // shared working tree, and the one git's index lock would turn into a failed
    // commit if the drivers did not serialize.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handler = (uid: string) => async (): Promise<TurnResult> => {
      await writeWorldFile(world, `${uid}/file.md`, uid);
      arrived += 1;
      if (arrived === 2) release();
      await gate;
      return acted();
    };
    const first = await NodeDriver.open(home, 'n1', handler('n1'), world, { worldPollMs: 0 });
    const second = await NodeDriver.open(home, 'n2', handler('n2'), world, { worldPollMs: 0 });
    const runs = [first.run(), second.run()];
    await vi.waitFor(() => expect(first.state).toBe('waiting'));
    await vi.waitFor(() => expect(second.state).toBe('waiting'));
    first.stop();
    second.stop();
    await Promise.all(runs);

    // No commit failed on the index lock, and no write was left out of the
    // world: the loser of the race found the tree already committed.
    const history = await worldLog(world);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(await committedContent(world, 'n1/file.md')).toBe('n1');
    expect(await committedContent(world, 'n2/file.md')).toBe('n2');
    // Every hash a journal claims is a commit of the world, and every commit is
    // authored by one of the two nodes — whoever won the race for the tree.
    const hashes = new Set(history.map((line) => line.split(' ')[0]));
    for (const uid of ['n1', 'n2']) {
      const ends = (await readNode(home, uid)).filter((e) => e.type === 'turn/end');
      expect(ends.length).toBeGreaterThanOrEqual(1);
      for (const end of ends) {
        const commit = (end.data as { commit?: string }).commit;
        if (commit !== undefined) expect(hashes.has(commit)).toBe(true);
      }
    }
    const authors = history.map((line) => line.split(' ')[1]);
    expect(authors.every((author) => author === 'n1' || author === 'n2')).toBe(true);
    expect(new Set(authors).size).toBe(authors.length);
  });

  it('wakes the peer when one node commits', async () => {
    const { home, world } = fixture();
    const triggers: TurnTrigger[] = [];
    const writer = await NodeDriver.open(home, 'n1', async () => {
      await writeWorldFile(world, 'n1/said.md', 'hello');
      return acted();
    }, world, { worldPollMs: 0 });
    const reader = await NodeDriver.open(home, 'n2', (ctx) => {
      triggers.push(ctx.trigger);
      return wait();
    }, world, { worldPollMs: 0 });
    // The reader parks on an empty world first, so its first turn is a boot.
    const runningReader = reader.run();
    await parked(reader, world);
    await vi.waitFor(() => expect(triggers).toEqual(['boot']));

    // n1 writes and commits; the poke reaches n2, whose predicate is satisfied
    // by a commit it did not author — no interval wait, no polling loop.
    const runningWriter = writer.run();
    await vi.waitFor(() => expect(triggers).toHaveLength(2));
    expect(triggers[1]).toBe('wakeup');
    const commit = await world.headHash();
    const start = (await readNode(home, 'n2'))
      .find((e) => e.type === 'turn/start' && (e.data as { turn: number }).turn === 1);
    expect(start?.data).toEqual({ turn: 1, trigger: 'wakeup', world: { from: null, to: commit } });
    writer.stop();
    reader.stop();
    await Promise.all([runningWriter, runningReader]);
  });
});

describe('resume and the world', () => {
  it('commits an interrupted turn’s writes with the node’s authorship', async () => {
    const { home, world } = fixture();
    // The crash shape: the turn opened, wrote to the world, and never closed.
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    await w.close();
    await writeWorldFile(world, 'n1/half.md', 'unfinished');

    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    const events = await readNode(home);
    const closer = events.find((e) => e.type === 'turn/end');
    expect(closer?.data).toMatchObject({ turn: 0, outcome: 'interrupted', synthetic: true });
    // An effect is never left unattributed: the closer carries the hash of the
    // commit the resume made, authored by the node that was interrupted.
    const commit = (closer?.data as { commit?: string }).commit;
    expect(commit).toBe(await world.headHash());
    expect(await worldLog(world)).toEqual([`${commit} n1`]);
    expect(await committedContent(world, 'n1/half.md')).toBe('unfinished');
    d.stop();
    await d.run();
  });

  it('commits nothing at resume when no turn was left open', async () => {
    const { home, world } = fixture();
    // A dirty tree with no open turn is somebody else's in-flight work: only the
    // node's own interrupted turn is the node's to commit.
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    w.append('turn/end', { turn: 0, outcome: 'waiting' });
    await w.close();
    await writeWorldFile(world, 'peer/inflight.md', 'not mine');
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    expect(await world.headHash()).toBeNull();
    d.stop();
    await d.run();
  });

  it('rebuilds the watermark from the journal, and wakes on what it missed', async () => {
    const { home, world } = fixture();
    // A first life: one turn that writes and commits, then a second turn that
    // opens on that commit and parks. Its watermark is a real hash, not null.
    const first = await NodeDriver.open(home, 'n1', async (ctx) => {
      if (ctx.turn === 0) {
        await writeWorldFile(world, 'n1/first.md', 'first');
        return { outcome: 'chained', toolCalls: true };
      }
      return wait();
    }, world, { worldPollMs: 0 });
    const firstRun = first.run();
    await parked(first, world);
    first.stop();
    await firstRun;
    const seenByFirst = await world.headHash();

    // While the node is down, the world moves twice.
    await commitAs(world, 'n2', { 'n2/a.md': 'a' });
    const head = await commitAs(world, 'n3', { 'n3/b.md': 'b' });

    const seen: { trigger: TurnTrigger; world: WorldRange }[] = [];
    const second = await NodeDriver.open(home, 'n1', (ctx) => {
      seen.push({ trigger: ctx.trigger, world: ctx.world });
      return wait();
    }, world, { worldPollMs: 0 });
    const secondRun = second.run();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    // Rebuilt from the journal — never from the current HEAD, which would have
    // made the node believe it had already seen the commits it missed.
    expect(seen[0]).toEqual({ trigger: 'wakeup', world: { from: seenByFirst, to: head } });
    second.stop();
    await secondRun;
  });
});
