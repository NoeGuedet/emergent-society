import {
  JournalReader, JournalWriter, TornTailError, repair,
  type JournalWriterOptions,
} from '../journal/index.js';
import { NODE_EVENT_TYPES, type ShutdownReason, type TurnTrigger } from './events.js';
import { NodeStateError } from './errors.js';
import { WakeLatch } from './latch.js';
import { HeadWatcher } from './watcher.js';
import type { WorldRange, WorldRepo } from './world.js';

export type NodeState = 'booting' | 'active' | 'waiting' | 'stopping' | 'stopped';

/**
 * The driver's default clock, mirroring the journal's own `systemClock`: the
 * driver resolves it once, so every turn heals the same `now` the caller
 * injected (or the wall clock when none was given).
 */
const systemClock = (): number => Date.now();

// The turn/shutdown vocabulary lives in events.ts (single home); re-exported
// here for consumers of the driver's own signatures. The public surface
// (`index.ts`) names it from that home too, since `stop()` takes a
// ShutdownReason and a closer takes a TurnEndOutcome.
export type { ShutdownReason, TurnEndOutcome, TurnTrigger } from './events.js';

/** How a turn ended, as the handler chose to end it. */
export type TurnOutcome = 'chained' | 'waiting';

/**
 * What the handler reports back. The driver decides what the turn *meant*: it
 * is the only one that knows what the world did, and the handler is the only
 * one that knows what it did with its tools.
 */
export interface TurnResult {
  readonly outcome: TurnOutcome;
  /**
   * Whether the turn invoked at least one tool. It is the half of the
   * empty-turn rule (kernel.md §5.4) the driver cannot observe by itself; the
   * other half is whether the turn's commit changed anything. Deferred to C1.4:
   * the flag must come from the mutation gate's record, not from a declaration.
   */
  readonly toolCalls: boolean;
}

/** The handler's whole world: no writer, no commit — the clock is the injected `now`. */
export interface TurnContext {
  readonly turn: number;
  readonly trigger: TurnTrigger;
  /**
   * The world range this turn opened on (kernel.md §4): `from` is the node's
   * wake watermark — the last commit it has been shown, null before it has ever
   * perceived the world — and `to` is HEAD when the turn opened. The C1.3
   * assembler turns it into the diff the turn must perceive; the driver only
   * records it.
   */
  readonly world: WorldRange;
  now(): number;
}

export type TurnHandler = (ctx: TurnContext) => Promise<TurnResult> | TurnResult;

export interface NodeDriverOptions extends JournalWriterOptions {
  onMaintenance?: () => Promise<void> | void;
  /**
   * The event types this driver's replay understands, defaulting to its own
   * `NODE_EVENT_TYPES`. Later checkpoints boot a driver with their types unioned
   * in, so a journal written by a richer node still resumes here.
   */
  knownTypes?: ReadonlySet<string>;
  /**
   * HEAD re-read cadence in ms for the world's shared watcher; 0 disables the
   * interval. The first driver of a world repo sets it — the watcher is one per
   * repo, since HEAD is one value.
   */
  worldPollMs?: number;
}

/**
 * The breathing loop of one node (kernel.md §5): boot and resume, the turn
 * ritual, the commit that closes every turn, and the wait.
 *
 * There is no transport. A node communicates by writing files in the world, the
 * driver commits them with the node's uid as git author, and a node wakes on the
 * commits it did not author — so a static world spends nothing, a dialogue is
 * alternating commits, and a node's own commits never wake it.
 */
export class NodeDriver {
  private nodeState: NodeState = 'booting';
  private turn = 0;
  /**
   * The last world commit this node has been shown (§5.2), null before it has
   * ever perceived the world. It advances when a turn opens, not when a commit
   * lands: what a turn perceives is fixed at its opening, and a commit made
   * while the turn ran is part of the *next* turn's range — otherwise a foreign
   * write landing mid-turn would be absorbed into this node's own commit and
   * never presented.
   */
  private watermark: string | null = null;
  /**
   * Which park the node is in. Bumped on entry and on exit, so an evaluation
   * started under one park can never arm the latch of another (see `park`).
   */
  private parkEpoch = 0;
  private stopRequested = false;
  private stopReason: ShutdownReason = 'stop-requested';
  private readonly latch = new WakeLatch();
  private readonly watcher: HeadWatcher;
  /** Resolved once in the constructor, like the writer's `systemClock`. */
  private readonly now: () => number;

  private constructor(
    private readonly writer: JournalWriter,
    readonly uid: string,
    private readonly handler: TurnHandler,
    private readonly world: WorldRepo,
    private readonly opts: NodeDriverOptions,
  ) {
    this.now = opts.now ?? systemClock;
    this.watcher = HeadWatcher.for(world, opts.worldPollMs);
  }

  static async open(
    home: string, uid: string, handler: TurnHandler, world: WorldRepo,
    opts: NodeDriverOptions = {},
  ): Promise<NodeDriver> {
    let writer: JournalWriter;
    try {
      writer = await JournalWriter.open(home, uid, opts);
    } catch (err) {
      if (!(err instanceof TornTailError)) throw err;
      await repair(home, uid);
      writer = await JournalWriter.open(home, uid, opts);
    }
    const driver = new NodeDriver(writer, uid, handler, world, opts);
    try {
      await driver.resume(home);
    } catch (err) {
      // Mirror the writer's own failed-open force-close: a driver whose replay
      // failed must not keep the node locked behind the live pid, or every
      // in-process retry hits SessionAlreadyOwnedError. The close is
      // best-effort — the resume failure is the one that propagates.
      try {
        await writer.close();
      } catch { /* the resume error stands */ }
      throw err;
    }
    return driver;
  }

  get state(): NodeState {
    return this.nodeState;
  }

  stop(reason: ShutdownReason = 'stop-requested'): void {
    if (this.nodeState === 'stopping' || this.nodeState === 'stopped') return;
    this.stopReason = reason;
    this.stopRequested = true;
    if (this.nodeState === 'waiting') this.latch.request();
  }

  async run(): Promise<void> {
    if (this.nodeState !== 'booting') {
      throw new NodeStateError(`run() out of order: state is ${this.nodeState}`);
    }
    this.nodeState = 'active';
    let failure: unknown = null;
    try {
      // A first turn is a wakeup when the world holds commits this node has not
      // been shown — a node joining a populated world, or one that was down
      // while the world moved — and a boot otherwise. A read that fails here is
      // the wake path's policy too (see `armIfAwake`): it reads as "no wake",
      // and the turn's own world read is what surfaces a world that really
      // cannot be read.
      let trigger: TurnTrigger = (await this.wakeDue()) ? 'wakeup' : 'boot';
      while (!this.stopRequested) {
        const world = await this.worldRange();
        this.watermark = world.to;
        this.writer.append('turn/start', { turn: this.turn, trigger, world });
        // Barrier: the turn's opening is durable before the handler can produce
        // any effect (kernel.md §3).
        await this.writer.flush();
        let result: TurnResult;
        try {
          result = await this.handler({
            turn: this.turn, trigger, world, now: () => this.now(),
          });
        } catch (err) {
          await this.endFailedTurn(this.turn, err);
          this.stopReason = 'handler-error';
          throw err;
        }
        // The world is committed before the closer is journaled, so the closer
        // can carry the hash that joins the journal to the world's history
        // (kernel.md §3, §5.2).
        const commit = await this.commitWorld(this.turn);
        const end = {
          turn: this.turn, outcome: result.outcome,
          ...(commit !== null ? { commit } : {}),
        };
        // Empty (kernel.md §5.4): no tool call and nothing committed. It is
        // still a turn — the fact of a node that woke and changed nothing — and
        // the closer is the skip unit: emptiness is knowable only once the turn
        // has ended, so `turn/end` is the only event that can carry the marker.
        if (!result.toolCalls && commit === null) this.writer.append('turn/end', end, { ignorable: true });
        else this.writer.append('turn/end', end);
        // The closer is durable per event, never left to the write-behind window
        // (kernel.md §3): a crash right after it would otherwise orphan the
        // world commit — a hash in the world's history that the journal, the
        // only record of which turn produced it, does not reference.
        await this.writer.flush();
        if (result.outcome === 'chained') {
          trigger = 'chain';
          this.turn += 1;
          continue;
        }
        this.nodeState = 'waiting';
        try {
          await this.opts.onMaintenance?.();
        } catch (err) {
          this.stopReason = 'maintenance-error';
          throw err;
        }
        if (this.stopRequested) break;
        await this.park();
        if (this.stopRequested) break;
        this.nodeState = 'active';
        trigger = 'wakeup';
        this.turn += 1;
      }
    } catch (err) {
      failure = err;
      // The loop died outside the handler's contract — a failed barrier, a
      // maintenance hook that rejected, a git failure on the turn's commit — so
      // the run's reason becomes 'driver-error' unless the handler's own turn
      // already set one. The check is by value, so an explicit stop() (which
      // carries the same default) is relabelled too: accepted, since a stop WAS
      // requested and the error still reaches the caller. A clean stop keeps the
      // plain label and journals no `error` field, the run having failed
      // nowhere.
      if (this.stopReason === 'stop-requested') this.stopReason = 'driver-error';
    }
    const shutdownFailure = await this.shutdown(failure);
    failure ??= shutdownFailure;
    if (failure !== null) throw failure;
  }

  /**
   * Parks until the world moves with a commit this node did not author, or until
   * `stop()`.
   *
   * The subscription is taken *before* the predicate is checked, so a commit
   * landing between the two cannot be lost: the watcher arms the latch and the
   * wait returns at once instead of parking on a wake that already happened.
   *
   * Each park is an epoch. An evaluation started under one park can resolve
   * after it ended — it read the predicate's input before its git call, so its
   * verdict is stale — and would then arm the *next* park's latch: a `wakeup`
   * turn on an unmoved world. The epoch is what forbids it.
   */
  private async park(): Promise<void> {
    this.parkEpoch += 1;
    const epoch = this.parkEpoch;
    const unsubscribe = this.watcher.subscribe(() => { void this.armIfAwake(epoch); });
    try {
      await this.armIfAwake(epoch);
      await this.latch.wait();
    } finally {
      unsubscribe();
      // The park is over: an evaluation still in flight for it must not arm the
      // latch of the park that follows.
      this.parkEpoch += 1;
    }
  }

  /**
   * Arms the latch when the world has moved with a commit this node did not
   * author. Both wake paths — the check a park opens with, and the watcher's
   * notification — come through here, so they cannot drift into two policies.
   *
   * **The wake path's failure policy, once: a read that fails delays a wake, it
   * never kills the node.** The predicate is a question, and a question that
   * cannot be answered leaves the node parked; the next tick or poke asks again.
   * Fatal stays reserved for durability — the commit that closes a turn, and the
   * journal itself — where losing the answer would lose a fact.
   *
   * @param epoch the park this evaluation belongs to.
   */
  private async armIfAwake(epoch: number): Promise<void> {
    if ((await this.wakeDue()) && epoch === this.parkEpoch) this.latch.request();
  }

  /**
   * Whether a wake is due, with the wake path's failure policy applied (see
   * `armIfAwake`). The predicate itself is `wakeNeeded`.
   */
  private async wakeDue(): Promise<boolean> {
    try {
      return await this.wakeNeeded();
    } catch {
      return false;
    }
  }

  /**
   * The wake predicate (kernel.md §5.2): HEAD has advanced with at least one
   * commit this node did not author. A static world is silent, a node's own
   * commits never wake it, and several foreign commits landing before the node
   * looks again are one list, hence one wake.
   */
  private async wakeNeeded(): Promise<boolean> {
    const commits = await this.world.commitsSince(this.watermark);
    return commits.some((commit) => commit.author !== this.uid);
  }

  /** The range a turn opening now would present: the watermark to HEAD. */
  private async worldRange(): Promise<WorldRange> {
    return { from: this.watermark, to: await this.world.headHash() };
  }

  /**
   * Commits the world as this node. Committing is kernel mechanism, not a tool:
   * an agent cannot end a turn without its effects being committed and
   * attributed (kernel.md §5.2).
   *
   * @returns the commit hash, or null when the turn changed nothing.
   * @throws GitCommandError when git fails; an unattributed effect is not a fact
   * to shrug off, so the loop dies on it (driver-error).
   */
  private async commitWorld(turn: number): Promise<string | null> {
    const commit = await this.world.commitAll(this.uid, `turn ${turn}`);
    if (commit === null) return null;
    this.watcher.poke();
    return commit.hash;
  }

  /**
   * Closes a turn whose handler threw. The turn's writes are in the world's
   * working tree even though the turn failed, so they are committed here — with
   * this node's authorship — rather than left to be swept into the next
   * committer's commit (§5.3: an effect is never left unattributed).
   *
   * A commit failure must not displace the handler's error, which is the one
   * that ended the run: it is caught, and the writes then stay in the tree for
   * the next commit of this world — a later turn's, whoever ends it — to pick
   * up.
   */
  private async endFailedTurn(turn: number, err: unknown): Promise<void> {
    let commit: string | null = null;
    try {
      commit = await this.commitWorld(turn);
    } catch {
      commit = null;
    }
    this.writer.append('turn/end', {
      turn, outcome: 'error', error: String(err),
      ...(commit !== null ? { commit } : {}),
    });
    // The same per-event barrier as the success path: this closer carries the
    // hash of the commit the failed turn did land, and a crash before the
    // write-behind window elapsed would orphan it (kernel.md §3).
    await this.writer.flush();
  }

  /**
   * The one shutdown path: mark the stop, journal the reason, release the
   * writer, and land in `stopped` no matter which step failed.
   *
   * The run's `prior` failure outranks any error these steps raise — the append
   * can fail (poisoned writer, recorded write-behind failure) and so can
   * close(), and neither may displace the error that ended the run. Step errors
   * are still returned, so a clean run is told about them.
   *
   * @param prior the error that ended the run, or null on a clean stop.
   * @returns the first shutdown-step error, or null when both steps succeeded.
   */
  private async shutdown(prior: unknown): Promise<unknown> {
    let failure: unknown = null;
    this.nodeState = 'stopping';
    try {
      this.writer.append('node/shutdown', {
        reason: this.stopReason,
        ...(prior !== null && prior !== undefined ? { error: String(prior) } : {}),
      });
    } catch (err) {
      failure ??= err;
    }
    try {
      await this.writer.close();
    } catch (err) {
      failure ??= err;
    } finally {
      // Reached even when close() fails: a driver whose writer cannot be closed
      // is still stopped, never left in 'stopping'.
      this.nodeState = 'stopped';
    }
    return failure;
  }

  /**
   * The resume protocol (kernel.md §3): rebuild the durable state by replay,
   * close an interrupted turn synthetically — committing the world state its
   * writes left in the working tree, with this node's authorship — then journal
   * the boot, durable before any turn effect can exist.
   */
  private async resume(home: string): Promise<void> {
    const reader = await JournalReader.open(home, this.uid, {
      knownTypes: this.opts.knownTypes ?? NODE_EVENT_TYPES,
      // Projections replay the original payloads, not claim-check references.
      resolveBlobs: true,
    });
    let sawAny = false;
    let openTurn: number | null = null;
    for await (const e of reader.events()) {
      sawAny = true;
      if (e.type === 'turn/start') {
        const d = e.data as unknown as { turn: number; world: WorldRange };
        openTurn = d.turn;
        this.turn = d.turn + 1;
        // The watermark is the HEAD the last turn opened on: what the node has
        // been shown, not what it wrote. Rebuilding it from the journal, never
        // from the current HEAD, is what makes a node that was down while the
        // world moved wake on the commits it missed.
        this.watermark = d.world.to;
      } else if (e.type === 'turn/end') {
        openTurn = null;
      }
    }
    if (openTurn !== null) {
      // The interrupted turn never closed, so its writes are still in the
      // world's working tree: they are committed here with the node's
      // authorship, and the closer carries the hash (§5.3).
      const commit = await this.commitWorld(openTurn);
      this.writer.append('turn/end', {
        turn: openTurn, outcome: 'interrupted', synthetic: true,
        ...(commit !== null ? { commit } : {}),
      });
      // A closer is a closer, synthetic or not: durable before the boot is
      // journaled on top of it, so a crash between the two still leaves the
      // commit it names attributable (kernel.md §3).
      await this.writer.flush();
    }
    this.writer.append('node/boot', { reason: sawAny ? 'resume' : 'start' });
    await this.writer.flush();
  }
}
