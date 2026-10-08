import {
  BlobStore, JournalReader, JournalWriter, TornTailError,
  assertBlobBytes, assertBlobRefReadable, isBlobRef, repair, throwBlobReadError,
  type EventDataFor, type EventEnvelope, type JsonValue, type JournalWriterOptions,
} from '../journal/index.js';
import { NODE_EVENT_TYPES, type ShutdownReason, type TurnTrigger } from './events.js';
import { NodeStateError, WorldReconciliationError } from './errors.js';
import { WakeLatch } from './latch.js';
import {
  createBoundaryGate,
  type BoundaryGate, type BoundaryRegistry, type DurableWatermark, type DriverHooks,
  type GateCallbacks, type GateScope, type WorldAcknowledgement,
} from './gate.js';
import type { SafeFailure, Source } from '../context/contracts.js';
import type { VerifiedEvent } from '../context/loader.js';
import { HeadWatcher } from './watcher.js';
import type { WorldRange, WorldRepo } from './world.js';

export type NodeState = 'booting' | 'active' | 'waiting' | 'stopping' | 'stopped';

/**
 * The driver's default clock, mirroring the journal's own `systemClock`: the
 * driver resolves it once, so every turn heals the same `now` the caller
 * injected (or the wall clock when none was given).
 */
const systemClock = (): number => Date.now();

/**
 * The replay vocabulary a hooks bundle must be able to read: the node's own
 * lifecycle types unioned with every boundary type in its registry. When the
 * caller supplies `knownTypes`, it must cover both sets — a set missing a node
 * lifecycle type or a registered boundary type is refused here, explicitly and
 * early, rather than surfacing later as an unknown-event replay failure.
 */
function checkedKnownTypes(
  registryTypes: readonly string[], provided: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (provided === undefined) {
    return new Set([...NODE_EVENT_TYPES, ...registryTypes]);
  }
  for (const type of [...NODE_EVENT_TYPES, ...registryTypes]) {
    if (!provided.has(type)) {
      throw new Error(`knownTypes is missing event type ${JSON.stringify(type)}`);
    }
  }
  return provided;
}

// The turn/shutdown vocabulary lives in events.ts (single home); re-exported
// here for consumers of the driver's own signatures. The public surface
// (`index.ts`) names it from that home too, since `stop()` takes a
// ShutdownReason and a closer takes a TurnEndOutcome.
export type { ShutdownReason, TurnEndOutcome, TurnTrigger } from './events.js';

/** How a turn ended: chained/waiting are the handler's, error is a recoverable failure. */
export type TurnOutcome = 'chained' | 'waiting' | 'error';

/**
 * What the handler reports back. The driver decides what the turn *meant*: it
 * is the only one that knows what the world did, and the handler is the only
 * one that knows what it did with its tools.
 *
 * A recoverable failure (`outcome: 'error'`) carries a bounded `SafeFailure`:
 * the driver commits the turn, journals a nonignorable error closer and parks,
 * rather than shutting the node down as an ordinary thrown exception does.
 */
export type TurnResult =
  | { readonly outcome: 'chained' | 'waiting'; readonly toolCalls: boolean }
  | { readonly outcome: 'error'; readonly toolCalls: boolean; readonly error: SafeFailure };

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
  /** The trusted boundary gate for this turn; revoked once the turn closes. */
  readonly gate: BoundaryGate;
  /** The turn's cancellation signal; `stop()` aborts it immediately. */
  readonly signal: AbortSignal;
  now(): number;
}

export type TurnHandler = (ctx: TurnContext) => Promise<TurnResult> | TurnResult;

export interface NodeDriverOptions extends JournalWriterOptions {
  onMaintenance?: () => Promise<void> | void;
  /**
   * The event types this driver's replay understands, defaulting to its own
   * `NODE_EVENT_TYPES`. Later checkpoints boot a driver with their types unioned
   * in, so a journal written by a richer node still resumes here. With hooks, a
   * supplied set must cover both `NODE_EVENT_TYPES` and every type in the
   * registry; a set missing either is refused before the writer is opened.
   */
  knownTypes?: ReadonlySet<string>;
  /**
   * HEAD re-read cadence in ms for the world's shared watcher; 0 disables the
   * interval. The first driver of a world repo sets it — the watcher is one per
   * repo, since HEAD is one value.
   */
  worldPollMs?: number;
  /**
   * The C1.3 trusted hooks: registry, durable/ready/turn-start callbacks and the
   * required verified-history and blob sources. Absent for legacy handlers, whose
   * gate is closed and whose resume keeps the resolved reader.
   */
  hooks?: DriverHooks;
  /** Best-effort checkpoint at each durable completed turn boundary. */
  onCheckpoint?: (mark: DurableWatermark) => Promise<void> | void;
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
   * ever perceived the world. It never advances when a commit lands — what a
   * turn perceives is fixed at its opening, and a commit made while the turn ran
   * is part of the *next* turn's range, or a foreign write landing mid-turn
   * would be absorbed into this node's own commit and never presented.
   *
   * How it advances depends on the physics in play: a hookless node advances it
   * at the turn/start barrier, which is its own perception; a hooks node advances
   * it only from a verified durable `world/perception` proof (see
   * `advanceAcknowledgement`/`resumeAcknowledgement`), so a turn that failed
   * before recording one is re-presented rather than skipped.
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
  private readonly home: string;
  private readonly hooks: DriverHooks | undefined;

  /**
   * The ordered durable observation list (T2 seam). Every gate or driver append
   * pushes its receipt (raw, claim-check ref intact) paired with the original
   * validated payload; resume pushes the loader-verified events. Delivery to
   * `onDurable` advances `delivered` only after the callback succeeds.
   */
  private readonly observations: VerifiedEvent[] = [];
  private delivered = 0;
  /**
   * The index of every delivered observation, keyed by `seq:hash`, so a world
   * acknowledgement's source can be verified against the delivered prefix in
   * O(1) — never by rescanning history, and never against the receipt inventory,
   * which also holds pending, not-yet-delivered receipts.
   */
  private readonly deliveredIndex = new Map<string, number>();
  /** The highest turn whose verified acknowledgement advanced the watermark. */
  private acknowledgedTurn = -1;
  /** Receipt inventory for validators, including pending receipts. */
  private readonly receipts = new Map<string, EventEnvelope>();
  /** The one logical lookup, shared by reference with every gate scope. */
  private readonly lookup: (source: Source) => EventEnvelope | null;
  /** Accepted `tool/call` appends in the active turn (C1.3 accounting). */
  private turnToolCalls = 0;
  /** The active turn's cancellation controller, or null between turns. */
  private activeController: AbortController | null = null;
  /** Revokes the active turn's gate once the turn closes. */
  private closeTurnGate: (() => void) | null = null;
  /** A durability/flush/observation fault ended (or poisoned) the run. */
  private durabilityFault = false;
  /** The maintenance hook failed; distinguishes that fixed label from a kernel invariant. */
  private maintenanceFault = false;

  private constructor(
    private readonly writer: JournalWriter,
    readonly uid: string,
    private readonly handler: TurnHandler,
    private readonly world: WorldRepo,
    private readonly opts: NodeDriverOptions,
    home: string,
  ) {
    this.now = opts.now ?? systemClock;
    this.watcher = HeadWatcher.for(world, opts.worldPollMs);
    this.home = home;
    this.hooks = opts.hooks;
    this.lookup = (source: Source): EventEnvelope | null =>
      this.receipts.get(`${source.seq}:${source.hash}`) ?? null;
  }

  static async open(
    home: string, uid: string, handler: TurnHandler, world: WorldRepo,
    opts: NodeDriverOptions = {},
  ): Promise<NodeDriver> {
    if (opts.hooks !== undefined) {
      // The whole hooks contract is checked before the writer exists: a missing
      // port must not leave a lock taken by a driver that can never run.
      for (const port of ['readHistory', 'readBlob', 'acknowledgedWorld'] as const) {
        if (typeof (opts.hooks as unknown as Record<string, unknown>)[port] !== 'function') {
          throw new Error(`C1.3 hooks require ${port}`);
        }
      }
      checkedKnownTypes(Object.keys(opts.hooks.registry), opts.knownTypes);
    }
    let writer: JournalWriter;
    try {
      writer = await JournalWriter.open(home, uid, opts);
    } catch (err) {
      if (!(err instanceof TornTailError)) throw err;
      await repair(home, uid);
      writer = await JournalWriter.open(home, uid, opts);
    }
    const driver = new NodeDriver(writer, uid, handler, world, opts, home);
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
    // Cancel the active turn immediately; the gate stays valid while the
    // handler's awaited cleanup settles (see `endTurnGate`).
    this.activeController?.abort();
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
        this.writeEvent('turn/start', {
          turn: this.turn, trigger, world: { from: world.from, to: world.to },
        });
        const controller = new AbortController();
        this.activeController = controller;
        this.turnToolCalls = 0;
        const created = this.makeGate('turn', this.turn, controller.signal);
        this.closeTurnGate = created.close;
        const ctx: TurnContext = {
          turn: this.turn, trigger, world, now: () => this.now(),
          gate: created.gate, signal: controller.signal,
        };
        try {
          // Barrier: the turn's opening is durable and observed before the handler
          // can produce any effect (kernel.md §3).
          await this.flushObservations();
          // Hookless legacy physics: the turn/start barrier *is* the node's
          // perception of this range, so its watermark advances to HEAD here. A
          // hooks bundle advances the watermark only from a verified durable
          // `world/perception` (see `advanceAcknowledgement`), so a turn that
          // fails before recording one re-presents its range after a restart
          // instead of skipping it.
          if (this.hooks === undefined) this.watermark = world.to;
          let result: TurnResult;
          try {
            if (this.hooks !== undefined) {
              await this.hooks.onTurnStart(ctx);
              this.advanceAcknowledgement(ctx);
            }
            result = await this.handler(ctx);
            if (this.hooks !== undefined && (this.turnToolCalls > 0) !== result.toolCalls) {
              throw new Error('handler toolCalls report disagrees with accepted tool/call events');
            }
          } catch (err) {
            await this.endFailedTurn(this.turn, err);
            this.stopReason = 'handler-error';
            throw err;
          }
          // The world is committed before the closer is journaled, so the closer
          // can carry the hash that joins the journal to the world's history
          // (kernel.md §3, §5.2).
          const commit = await this.commitWorld(this.turn);
          const toolCalls = this.hooks !== undefined ? this.turnToolCalls > 0 : result.toolCalls;
          if (result.outcome === 'error') {
            const status = result.error.status;
            const end: EventDataFor<'turn/end'> = {
              turn: this.turn, outcome: 'error',
              error: status === null ? `${result.error.code} null` : `${result.error.code} ${status}`,
              ...(commit !== null ? { commit } : {}),
            };
            // A normal, nonignorable error closer: failed-turn evidence survives.
            this.writeEvent('turn/end', end);
          } else {
            const end: EventDataFor<'turn/end'> = {
              turn: this.turn, outcome: result.outcome,
              ...(commit !== null ? { commit } : {}),
            };
            // Empty (kernel.md §5.4): no tool call and nothing committed. It is
            // still a turn — the fact of a node that woke and changed nothing — and
            // the closer is the skip unit: emptiness is knowable only once the turn
            // has ended, so `turn/end` is the only event that can carry the marker.
            if (!toolCalls && commit === null) this.writeEvent('turn/end', end, { ignorable: true });
            else this.writeEvent('turn/end', end);
          }
          // The closer is durable and observed per event, never left to the
          // write-behind window (kernel.md §3): a crash right after it would
          // otherwise orphan the world commit — a hash in the world's history that
          // the journal, the only record of which turn produced it, does not
          // reference.
          await this.flushObservations();
          await this.checkpoint();
          this.endTurnGate();
          if (result.outcome === 'chained') {
            trigger = 'chain';
            this.turn += 1;
            continue;
          }
          // Both 'waiting' and a recoverable 'error' park: the node stays alive.
          this.nodeState = 'waiting';
          try {
            await this.opts.onMaintenance?.();
          } catch (err) {
            this.maintenanceFault = true;
            this.stopReason = 'maintenance-error';
            throw err;
          }
          if (this.stopRequested) break;
          await this.park();
          if (this.stopRequested) break;
          this.nodeState = 'active';
          trigger = 'wakeup';
          this.turn += 1;
        } finally {
          // Every exit from the turn — the barrier, a handler failure, a commit
          // or closer fault, a maintenance error, a clean park — revokes the
          // gate, so a retained reference can never append after it closed.
          this.endTurnGate();
        }
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

  // --- gate construction and the durable observation seam -------------------------

  /** The one lookup, shared by reference with every gate scope (factory requires it). */
  private makeGate(
    phase: 'ready' | 'turn', turn: number | null, signal: AbortSignal,
  ): { readonly gate: BoundaryGate; readonly close: () => void } {
    const scope: GateScope = { phase, turn, signal, lookup: this.lookup };
    const callbacks: GateCallbacks = {
      append: (type, data) => {
        if (type === 'tool/call') this.turnToolCalls += 1;
        const receipt = this.writer.append(type, data);
        this.record(receipt, data);
        return receipt;
      },
      // `callbacks.flush` is the driver's durable barrier: it flushes the writer
      // and delivers the captured observation prefix to `onDurable`. It never
      // re-enters `gate.flush`, so a chunked capture cannot deadlock.
      flush: () => this.flushObservations(),
      lookup: this.lookup,
      readBlob: (hash) => this.readBlob(hash),
      now: () => this.now(),
    };
    // A hookless driver keeps the expanded context type but its gate is closed
    // to every boundary type: an empty registry rejects every append.
    const registry: BoundaryRegistry = this.hooks !== undefined
      ? this.hooks.registry
      : ({} as BoundaryRegistry);
    return createBoundaryGate(registry, scope, callbacks);
  }

  private readBlob(hash: string): Promise<Uint8Array> {
    if (this.hooks !== undefined) return this.hooks.readBlob(hash);
    return new BlobStore(this.home).get(hash);
  }

  /** Records a receipt in the inventory and appends an in-memory observation. */
  private record(receipt: EventEnvelope, data: JsonValue): void {
    this.receipts.set(`${receipt.seq}:${receipt.hash}`, receipt);
    this.observations.push({ ...receipt, data, raw: receipt });
  }

  /** A typed lifecycle append, observed like any other. */
  private writeEvent<T extends string>(
    type: T, data: EventDataFor<T>, opts: { ignorable?: boolean } = {},
  ): EventEnvelope {
    const receipt = this.writer.append(type, data, opts);
    this.record(receipt, data as unknown as JsonValue);
    return receipt;
  }

  /**
   * Captures the current pending suffix, flushes the writer, verifies every
   * captured claim-check, delivers that immutable prefix to `onDurable`, then
   * advances the delivered watermark. Repeats while appends remain (a callback
   * may append), and refuses an appending callback after 1024 batches.
   */
  private async flushObservations(): Promise<void> {
    let batches = 0;
    while (this.delivered < this.observations.length) {
      batches += 1;
      if (batches > 1024) throw new Error('observation seam exceeded 1024 batches');
      const batch: readonly VerifiedEvent[] = this.observations.slice(this.delivered);
      try {
        await this.writer.flush();
        await this.verifyObservations(batch);
      } catch (err) {
        this.durabilityFault = true;
        throw err;
      }
      if (this.hooks !== undefined) await this.hooks.onDurable(batch);
      for (let offset = 0; offset < batch.length; offset += 1) {
        const observation = batch[offset]!;
        this.deliveredIndex.set(`${observation.raw.seq}:${observation.raw.hash}`, this.delivered + offset);
      }
      this.delivered += batch.length;
    }
  }

  /**
   * The driver-flush guarantee: every observation whose raw journaled data is a
   * claim-check reference is read back and its digest and byte length checked
   * before it is delivered or any effect is allowed. A resumed event's payload
   * was already verified by the loader; this re-reads the blob on disk. A missing
   * blob is a typed integrity error; any other read failure keeps its own type.
   */
  private async verifyObservations(batch: readonly VerifiedEvent[]): Promise<void> {
    for (const obs of batch) {
      if (!isBlobRef(obs.raw.data)) continue;
      const ref = obs.raw.data;
      // A flagged prefix is refused before any read, so it can never reach
      // `onDurable` or an effect even when its blob digest and size would match.
      assertBlobRefReadable(ref);
      let bytes: Uint8Array;
      try {
        bytes = await this.readBlob(ref.blob);
      } catch (err) {
        // Only a missing blob (ENOENT) becomes an integrity error; EACCES/EIO
        // keep their own type so an environment failure is not called corruption.
        throwBlobReadError(ref, err);
      }
      assertBlobBytes(ref, Buffer.from(bytes));
    }
  }

  /** Best-effort checkpoint at a durable turn boundary; never fatal. */
  private async checkpoint(): Promise<void> {
    const onCheckpoint = this.opts.onCheckpoint;
    if (onCheckpoint === undefined || this.delivered === 0) return;
    const last = this.observations[this.delivered - 1]!;
    try {
      await onCheckpoint({ seq: last.raw.seq, hash: last.raw.hash });
    } catch { /* best-effort: a checkpoint failure must not end the run */ }
  }

  private endTurnGate(): void {
    const close = this.closeTurnGate;
    this.closeTurnGate = null;
    if (close !== null) close();
    this.activeController = null;
  }

  /**
   * Advances the watermark from the handler's own acknowledgement, verified
   * against the current turn. Called after `onTurnStart` returns: by then the
   * handler has recorded and flushed its `world/perception`, so its proof — if
   * any — names a delivered observation. A null acknowledgement advances
   * nothing: a trusted handler that owns no perception is never falsely
   * acknowledged, and its prior watermark simply stands.
   */
  private advanceAcknowledgement(ctx: TurnContext): void {
    const ack = this.hooks!.acknowledgedWorld();
    if (ack === null) return;
    if (ack.turn !== ctx.turn) {
      throw new Error(
        `world acknowledgement turn ${ack.turn} is not the current turn ${ctx.turn}`);
    }
    if (ack.range.from !== ctx.world.from || ack.range.to !== ctx.world.to) {
      throw new Error('world acknowledgement range is not the turn opening range');
    }
    this.proveAcknowledgement(ack);
    if (ack.turn < this.acknowledgedTurn) {
      throw new Error(`world acknowledgement turn ${ack.turn} regresses ${this.acknowledgedTurn}`);
    }
    this.watermark = ack.range.to;
    this.acknowledgedTurn = ack.turn;
  }

  /**
   * The watermark rebuild at resume: the last range the node can prove it
   * durably perceived, derived from the full observed history. Only a verified
   * proof moves it — never the last `turn/start`, whose range a turn that failed
   * before recording a perception never actually showed the node.
   */
  private resumeAcknowledgement(): void {
    const ack = this.hooks!.acknowledgedWorld();
    if (ack === null || ack.turn < this.acknowledgedTurn) return;
    this.proveAcknowledgement(ack);
    this.watermark = ack.range.to;
    this.acknowledgedTurn = ack.turn;
  }

  /**
   * Verifies an acknowledgement against the driver's own delivered prefix: its
   * source must be a delivered observation (not a pending receipt), that
   * observation must be a `world/perception`, and the wrapper turn and range it
   * carried must match the acknowledgement exactly. The check reads the resolved
   * observation, not the raw receipt inventory, so a claim-check raw reference
   * cannot pass for a resolved perception, and it is O(1) in the delivered index.
   */
  private proveAcknowledgement(ack: WorldAcknowledgement): void {
    const index = this.deliveredIndex.get(`${ack.source.seq}:${ack.source.hash}`);
    if (index === undefined) {
      throw new Error('world acknowledgement source is not a delivered observation');
    }
    const observation = this.observations[index]!;
    if (observation.type !== 'world/perception') {
      throw new Error(
        `world acknowledgement source is a ${observation.type} observation, not world/perception`);
    }
    const data = observation.data as { turn: number; range: WorldRange };
    if (data.turn !== ack.turn) {
      throw new Error('world acknowledgement turn does not match its observation');
    }
    if (data.range.from !== ack.range.from || data.range.to !== ack.range.to) {
      throw new Error('world acknowledgement range does not match its observation');
    }
  }

  private durableError(err: unknown): string {
    if (this.hooks === undefined) return String(err);
    // Only a bounded fixed label ever reaches the journal under C1.3 hooks; the
    // original exception is retained and rethrown to its trusted caller. The
    // labels are distinct so the journal names the kind of failure without ever
    // carrying a message that might hold a payload (an API key, a provider body).
    if (this.durabilityFault) return 'durability failure';
    if (this.maintenanceFault) return 'maintenance failure';
    return 'kernel invariant failure';
  }

  private knownTypes(): ReadonlySet<string> {
    if (this.hooks === undefined) return this.opts.knownTypes ?? NODE_EVENT_TYPES;
    return checkedKnownTypes(Object.keys(this.hooks.registry), this.opts.knownTypes);
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
   * A commit or closer fault must not displace the handler's error, which is the
   * one that ended the run: both are caught, and the writes then stay in the tree
   * for the next commit of this world — a later turn's, whoever ends it — to pick
   * up. A turn left without a durable closer here is closed synthetically, and its
   * commit reconciled, on the next restart.
   */
  private async endFailedTurn(turn: number, err: unknown): Promise<void> {
    let commit: string | null = null;
    try {
      commit = await this.commitWorld(turn);
    } catch {
      commit = null;
    }
    const end: EventDataFor<'turn/end'> = {
      turn, outcome: 'error', error: this.durableError(err),
      ...(commit !== null ? { commit } : {}),
    };
    try {
      this.writeEvent('turn/end', end);
      // The same per-event barrier as the success path: this closer carries the
      // hash of the commit the failed turn did land, and a crash before the
      // write-behind window elapsed would orphan it (kernel.md §3).
      await this.flushObservations();
    } catch {
      // The handler's failure is the one that ended the run; a commit or closer
      // fault must not displace it. The writes stay in the tree for the next
      // commit of this world (§5.3), and the next restart reconciles the turn
      // left open here.
    }
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
      this.writeEvent('node/shutdown', {
        reason: this.stopReason,
        ...(prior !== null && prior !== undefined ? { error: this.durableError(prior) } : {}),
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
   * reconcile an interrupted turn — naming the commit its own turn already made
   * when it exists, else committing the world state its writes left in the
   * working tree, with this node's authorship — then journal the boot, durable
   * before any turn effect can exist. With hooks, every durable event is
   * delivered to `onDurable` through the ordered seam first, then the proof of
   * the last durably perceived range rebuilds the watermark, then the synthetic
   * closer and boot, then `onReady`.
   */
  private async resume(home: string): Promise<void> {
    const knownTypes = this.knownTypes();
    let sawAny = false;
    let openTurn: number | null = null;
    let openRangeTo: string | null = null;
    const applyLifecycle = (type: string, data: unknown): void => {
      if (type === 'turn/start') {
        const d = data as { turn: number; world: WorldRange };
        openTurn = d.turn;
        openRangeTo = d.world.to;
        this.turn = d.turn + 1;
        // Hookless legacy physics: the last `turn/start` is the node's own
        // perception of that range. A hooks bundle instead rebuilds the
        // watermark from the verified durable proof below — the last range the
        // node can *prove* it was shown — so a turn that failed before recording
        // a perception is re-presented rather than silently skipped.
        if (this.hooks === undefined) this.watermark = d.world.to;
      } else if (type === 'turn/end') {
        openTurn = null;
      }
    };
    if (this.hooks !== undefined) {
      const events = await this.hooks.readHistory(home, this.uid, knownTypes);
      for (const event of events) {
        sawAny = true;
        this.receipts.set(`${event.raw.seq}:${event.raw.hash}`, event.raw);
        this.observations.push(event);
        applyLifecycle(event.type, event.data);
      }
      await this.flushObservations();
      // Only after the whole history is delivered can the handler prove the last
      // range it durably perceived; that proof, not the last turn/start, is the
      // rebuilt watermark.
      this.resumeAcknowledgement();
    } else {
      const reader = await JournalReader.open(home, this.uid, {
        knownTypes,
        // Projections replay the original payloads, not claim-check references.
        resolveBlobs: true,
      });
      for await (const e of reader.events()) {
        sawAny = true;
        applyLifecycle(e.type, e.data);
      }
    }
    if (openTurn !== null) {
      // The interrupted turn never closed. Its own commit may already have
      // landed — the driver committed the world, then crashed before the closer
      // — so the closer first looks for that commit in the turn's own range and
      // names it rather than making a second one.
      const commit = await this.reconcileInterrupted(openTurn, openRangeTo);
      this.writeEvent('turn/end', {
        turn: openTurn, outcome: 'interrupted', synthetic: true,
        ...(commit !== null ? { commit } : {}),
      });
      // A closer is a closer, synthetic or not: durable before the boot is
      // journaled on top of it, so a crash between the two still leaves the
      // commit it names attributable (kernel.md §3).
      await this.flushObservations();
    }
    this.writeEvent('node/boot', { reason: sawAny ? 'resume' : 'start' });
    await this.flushObservations();
    await this.readyPhase();
  }

  /**
   * The commit a surviving open turn already made, or the one its remaining
   * working-tree writes now make. The search base is the range the turn opened
   * on (`to`), never the prior acknowledgement: only commits *after* the turn
   * opened can belong to it, and the node's uid and the exact `turn N` subject
   * must both match. Zero candidates is the existing dirty-tree recovery; exactly
   * one is named as-is, without staging anything a peer left in the tree; a
   * bounded-out search, an unreachable base or more than one match is refused by
   * `commitsForTurn`.
   */
  private async reconcileInterrupted(turn: number, base: string | null): Promise<string | null> {
    const candidates = await this.world.commitsForTurn(base, this.uid, turn);
    if (candidates.length > 1) {
      throw new WorldReconciliationError(
        `interrupted turn ${turn} names ${candidates.length} matching commits`);
    }
    if (candidates.length === 1) return candidates[0]!.hash;
    return this.commitWorld(turn);
  }

  /**
   * `onReady` during `open`, after synthetic closer and boot durability. It gets
   * a short-lived ready gate — config, artifacts, synthetic recovery results and
   * compaction-abort only, no model request or effect — revoked once it returns
   * and its final flush succeeds.
   */
  private async readyPhase(): Promise<void> {
    if (this.hooks === undefined) return;
    const created = this.makeGate('ready', null, new AbortController().signal);
    try {
      await this.hooks.onReady(created.gate);
      await this.flushObservations();
    } finally {
      created.close();
    }
  }
}
