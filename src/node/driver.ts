import {
  BlobStore, JournalReader, JournalWriter, TornTailError,
  isBlobRef, readVerifiedBlob, repair,
  type EventDataFor, type EventEnvelope, type JsonValue, type JournalWriterOptions,
} from '../journal/index.js';
import { StorageError, checkStorage, type StorageConfig } from '../storage.js';
import { DEFAULT_STORAGE } from './storage-probe.js';
import { systemClock } from '../util.js';
import { NODE_EVENT_TYPES, type ShutdownReason, type TurnTrigger } from './events.js';
import {
  GitCommandError, InvalidDoctorReportError, NodeStateError, WorldReconciliationError,
} from './errors.js';
import { WakeLatch } from './latch.js';
import {
  boundedRefusalDetail, commitAllRefused, type CommitRefusal,
} from './world-commit.js';
import { clearWorldState, markWorldDegraded } from './world-state.js';
import { parseDoctorReport, type DoctorReport } from './world-doctor.js';
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

// The turn vocabulary lives in events.ts (single home). `TurnTrigger` is
// re-exported here because the driver's own exported types name it — the
// `TurnContext.trigger` field — and its consumers import it from this module.
// `ShutdownReason` is imported from `./events.js` here; `index.ts` re-exports
// both it and `TurnEndOutcome`, so no consumer needs the driver module as a
// second path to them.
export type { TurnTrigger } from './events.js';

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

/**
 * What one fence attempt proved. `fenced` names how many leaves are frozen (the
 * node leaf plus every Run leaf that existed at acquire time). A non-fenced
 * outcome is a present port's failure — `unavailable` (the runtime says it
 * cannot fence) or `freeze-failed` (a fence that was attempted and could not be
 * established); both become the typed `freeze-timeout` commit refusal, never an
 * unfenced commit. The unfenced case is the ABSENCE of a port: the host records
 * it on the owner record/`host/boot` and `status`.
 */
export type FenceOutcome =
  | { readonly fenced: true; readonly leaves: number }
  | {
    readonly fenced: false;
    readonly reason: 'unavailable' | 'freeze-failed';
    readonly detail?: string;
  };

/**
 * The commit fence: the host's cgroup port that freezes every shell/Run leaf
 * around the commit's critical section (walk → add → write-tree → commit-tree →
 * update-ref), so a writer inside a leaf cannot change the tree between staging
 * and tree creation.
 *
 * `acquire` is called once per `commitWorld` attempt, outside the commit queue
 * and the internal git retries; `release` is called exactly once in a `finally`
 * and is idempotent — the driver guarantees it runs before the closer and
 * shutdown even when the commit or the turn failed. A port must never let a
 * caller end up frozen: a failed acquire thaws what it froze. `release` never
 * throws; the driver also guards it, so a broken port cannot displace a commit.
 */
export interface FencePort {
  acquire(): Promise<FenceOutcome>;
  release(): Promise<void>;
}

export interface NodeDriverOptions extends JournalWriterOptions {
  /**
   * The inherited write-behind/head diagnostic sink, and also the driver's
   * wake-predicate diagnostics: a bounded label plus, for git, its exit status —
   * never an arbitrary message or payload. A throwing reporter is swallowed.
   */
  onError?: (err: Error) => void;
  onMaintenance?: () => Promise<void> | void;
  /**
   * The event types this driver's replay understands, defaulting to its own
   * `NODE_EVENT_TYPES`. Later checkpoints boot a driver with their types unioned
   * in, so a local log written by a richer node still resumes here. With hooks, a
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
  /**
   * The retry seam: schedules one callback after `ms` and returns its cancel.
   * Production is `setTimeout`/`clearTimeout`; tests inject a manual clock so
   * the bounded refusal retry (1 s/4 s/16 s) is deterministic. It is the
   * supervisor's own seam, applied one layer up.
   */
  schedule?: (ms: number, callback: () => void) => () => void;
  /**
   * The commit fence (C2). Absent means the host has no usable cgroup fence
   * (a degraded attach or an off cell): the commit proceeds unfenced, and the
   * host records that degradation in the owner record and on its boot line.
   * Present means one `acquire`/`release` wraps the whole commit attempt; a
   * runtime freeze failure becomes the typed refusal `freeze-timeout`.
   */
  fence?: FencePort;
  /**
   * The boot-time world doctor's report (C3), when composition ran it. It is
   * written once after `node/boot` as the ignorable local event
   * `world/doctor`; the driver is the writer because the node journal does not
   * exist before `open`, and the doctor itself never opens one. Absent means
   * no doctor ran or it failed — a diagnostic, never a refused boot.
   */
  doctor?: DoctorReport;
  /**
   * The cancellable wait after a turn-start storage refusal, in ms. Production
   * is `DEFAULT_STORAGE_RETRY_MS`; a test injects a short one so the deferral's
   * retry is deterministic. The wait only ever ends early on `stop()`.
   */
  storageRetryMs?: number;
}

/** The bounded self-retry delays: three attempts, then the cell stays parked. */
const RETRY_DELAYS_MS: readonly number[] = [1000, 4000, 16000];

/** The turn-start storage retry wait (W0-d): the production default, no switch. */
const DEFAULT_STORAGE_RETRY_MS = 5_000;

/** The one bounded diagnostic a deferred turn emits: a fixed label, no payload. */
const STORAGE_DEFERRED_LABEL = 'turn deferred: storage low';

/**
 * The named turn-start deferral: a stable class name so the host's bounded
 * `driver/error` channel records a fact (never the generic `Error`), and the
 * message stays the fixed label.
 */
export class StorageDeferredError extends Error {
  constructor() {
    super(STORAGE_DEFERRED_LABEL);
    this.name = 'StorageDeferredError';
  }
}

/** One commit attempt as the driver sees it: a hash to join, or a typed refusal. */
type DriverCommitAttempt = {
  readonly commit: string | null;
  readonly refusal: CommitRefusal | null;
};

/** The production schedule seam; the one place this module spells `setTimeout`. */
function defaultSchedule(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);
  return () => { clearTimeout(timer); };
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
  /**
   * The injected `now`, or the shared `systemClock` in `util.ts` — the same
   * clock the journal writer defaults to. Resolved once here, so every turn
   * heals the same `now` the caller injected (or the wall clock when none was
   * given).
   */
  private readonly now: () => number;
  private readonly home: string;
  private readonly hooks: DriverHooks | undefined;
  private readonly schedule: (ms: number, callback: () => void) => () => void;
  /** How many bounded self-retries this refusal streak has spent (0..3). */
  private retryAttempt = 0;
  /** The pending retry wake's cancel, or null; cleared on park, stop and success. */
  private retryTimer: (() => void) | null = null;
  /** The storage circuit breaker shared by the local writer and the turn start. */
  private readonly storage: StorageConfig;
  /** The cancellable storage wait's cancel, or null; cleared when it settles. */
  private storageWait: (() => void) | null = null;
  private readonly storageRetryMs: number;

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
    this.schedule = opts.schedule ?? defaultSchedule;
    this.storage = opts.storage ?? DEFAULT_STORAGE;
    this.storageRetryMs = opts.storageRetryMs ?? DEFAULT_STORAGE_RETRY_MS;
    this.lookup = (source: Source): EventEnvelope | null =>
      this.receipts.get(`${source.seq}:${source.hash}`) ?? null;
  }

  static async open(
    home: string, uid: string, handler: TurnHandler, world: WorldRepo,
    opts: NodeDriverOptions = {},
  ): Promise<NodeDriver> {
    if (opts.hooks !== undefined) {
      // The whole hooks contract is checked before the writer exists: a missing
      // port must not leave a lock taken by a driver that can never run. The
      // lifecycle callbacks are as required as the replay ports — a bundle that
      // omits one would otherwise fail later, mid-run, after effects are possible.
      if (typeof opts.hooks.registry !== 'object' || opts.hooks.registry === null) {
        throw new Error('C1.3 hooks require registry');
      }
      for (const port of [
        'readHistory', 'readBlob', 'acknowledgedWorld', 'onDurable', 'onReady', 'onTurnStart',
      ] as const) {
        if (typeof (opts.hooks as unknown as Record<string, unknown>)[port] !== 'function') {
          throw new Error(`C1.3 hooks require ${port}`);
        }
      }
      checkedKnownTypes(Object.keys(opts.hooks.registry), opts.knownTypes);
    }
    // The effective storage seam: the caller's injection, or the production
    // policy over the real probe. The local writer and the turn-start home must
    // share it, so the resolved config is what the writer receives.
    const storage = opts.storage ?? DEFAULT_STORAGE;
    const writerOptions: NodeDriverOptions = { ...opts, storage };
    let writer: JournalWriter;
    try {
      writer = await JournalWriter.open(home, uid, writerOptions);
    } catch (err) {
      if (!(err instanceof TornTailError)) throw err;
      await repair(home, uid);
      writer = await JournalWriter.open(home, uid, writerOptions);
    }
    const driver = new NodeDriver(writer, uid, handler, world, writerOptions, home);
    try {
      await driver.resume(home);
    } catch (err) {
      // Mirror the writer's own failed-open force-close: a driver whose replay
      // failed must not keep the node locked behind the live pid, or every
      // in-process retry hits SessionAlreadyOwnedError. The handler's own
      // teardown runs first — `onReady` may already have acquired resources —
      // and its failure, like the close's, must never mask the resume error,
      // which is the one that propagates.
      try {
        await opts.hooks?.onStop?.(null);
      } catch { /* the resume error stands */ }
      try {
        await writer.close();
      } catch { /* the resume error stands */ }
      throw err;
    }
    if (opts.doctor !== undefined) {
      // After `node/boot` (and its flush): the report is a boot-time fact of
      // this open, written by the one writer the driver owns. The writer and the
      // replay fold must agree, so the payload is validated before it can become
      // durable: an invalid report is a named error on the diagnostic channel
      // and NO event at all (a `world/doctor` the fold rejects would poison the
      // current run and every later boot).
      const report = parseDoctorReport(opts.doctor);
      if (report === null) {
        try { opts.onError?.(new InvalidDoctorReportError()); }
        catch { /* the diagnostic is not the boot */ }
      } else {
        try {
          driver.writeEvent('world/doctor', { report }, { ignorable: true });
          await driver.flushObservations();
        } catch (err) {
          try { opts.onError?.(err instanceof Error ? err : new Error('world/doctor write failed')); }
          catch { /* the diagnostic is not the boot */ }
        }
      }
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
    // A pending self-retry or storage wait must not wake a stopped node (or
    // hold the process).
    this.clearRetryTimer();
    this.storageWait?.();
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
        // stop() aborts `activeController`, which is null between turns: a stop
        // that lands while the opening HEAD read is in flight has no controller
        // to cancel and would otherwise be lost, letting the handler start with
        // a live signal. Re-check after the read and open no turn at all.
        if (this.stopRequested) break;
        // The storage home (W0-d): a turn never opens on a low disk. A refusal
        // waits a cancellable retry and re-checks the world and the probe on
        // the next pass — no turn, no spin, and no end of the node.
        if (!(await this.storageReady())) continue;
        // A stop that landed while the storage probe was in flight (or during
        // the deferral wait) must not open a full turn: the old controller was
        // aborted by stop(), the new one would not be, and the handler must
        // never start un-aborted.
        if (this.stopRequested) break;
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
          // True only while the driver validates the handler's acknowledgement:
          // that proof is the driver's own kernel invariant, so its failure is a
          // driver error, never a handler error. The journal still carries the
          // bounded 'kernel invariant failure' label.
          let kernelFault = false;
          try {
            if (this.hooks !== undefined) {
              await this.hooks.onTurnStart(ctx);
              kernelFault = true;
              this.advanceAcknowledgement(ctx);
              kernelFault = false;
            }
            result = await this.handler(ctx);
            if (this.hooks !== undefined && (this.turnToolCalls > 0) !== result.toolCalls) {
              throw new Error('handler toolCalls report disagrees with accepted tool/call events');
            }
          } catch (err) {
            await this.endFailedTurn(this.turn, err);
            this.stopReason = kernelFault ? 'driver-error' : 'handler-error';
            throw err;
          }
          // The world is committed before the closer is written, so the closer
          // can carry the hash that joins the node's local log to the world's
          // history (kernel.md §3, §5.2). A refused commit is not a death: the
          // turn ends `waiting` (the fold treats waiting as success), the
          // refusal becomes a local fact, and the node parks.
          const attempt = await this.commitWorld(this.turn);
          const commit = attempt.commit;
          const refusal = attempt.refusal;
          // The degraded sidecar precedes the closer. A crash between the two
          // must still leave the degraded fact behind: a durable closer makes
          // the turn look closed, so no boot reconcile would retry it.
          if (refusal !== null) await this.markCommitRefusal(refusal);
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
            // The handler may have reported `chained`; a refusal overrides it
            // to `waiting` and parks, never continues.
            const outcome: 'chained' | 'waiting' =
              refusal !== null ? 'waiting' : result.outcome;
            const end: EventDataFor<'turn/end'> = {
              turn: this.turn, outcome,
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
          // the node's local log, the only record of which turn produced it, does
          // not reference. A storage refusal here is not a durability fault and
          // must not end the run or skip the C1 carrier: the writer keeps the
          // batch pending, the next turn's storage home defers every effect until
          // a later flush commits it, and the carrier below is still attempted.
          // On a SUCCESSFUL commit this swallowed refusal is the documented
          // residual (kernel.md): no self-retry is armed — the retry is the
          // refused-commit path below — so the pending turn/end waits for the
          // next turn's barrier or a stop's final flush, and a crash in that
          // window reconciles the already-committed turn as interrupted at the
          // next boot (the reconciler names its commit and closes it
          // synthetically).
          try {
            await this.flushObservations();
          } catch (err) {
            if (!(err instanceof StorageError)) throw err;
          }
          if (refusal !== null) {
            try {
              await this.recordCommitRefusal(refusal, this.turn, true);
            } catch (err) {
              if (!(err instanceof StorageError)) throw err;
              // The carrier was appended to the same pending batch and the
              // degraded sidecar already holds the fact. The bounded self-retry
              // is still armed: without it a node whose closer AND carrier both
              // refused would park until a foreign commit or a stop, despite
              // the documented bounded self-retry. The retry only requests the
              // latch; the next turn's storage home defers until the probe is
              // high, and the barrier flush lands the pending batch then.
              this.scheduleRetry();
            }
          }
          await this.checkpoint();
          this.endTurnGate();
          if (result.outcome === 'chained' && refusal === null) {
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
      // maintenance hook that rejected, a commit failure the refusal boundary
      // cannot name — so the run's reason becomes 'driver-error' unless the
      // handler's own turn already set one. The check is by value, so an
      // explicit stop() (which carries the same default) is relabelled too:
      // accepted, since a stop WAS requested and the error still reaches the
      // caller. A clean stop keeps the plain label and journals no `error`
      // field, the run having failed nowhere.
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
      append: (type, data, opts) => {
        if (type === 'tool/call') this.turnToolCalls += 1;
        const receipt = this.writer.append(type, data, opts);
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
        // A typed storage refusal is not a durability fault: the writer keeps
        // the batch pending by contract and the driver's turn-start home
        // defers every effect until a later flush commits it.
        if (!(err instanceof StorageError)) this.durabilityFault = true;
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
      // The delivery barrier re-verifies through the shared read: a flagged
      // prefix is refused before any read, so it can never reach `onDurable` or
      // an effect even when its blob digest and size would match. Gate verify and
      // this one sit at different trust transitions; neither is skipped.
      await readVerifiedBlob(ref, (hash) => this.readBlob(hash));
    }
  }

  /**
   * The boot path's barrier (W0-d): a storage refusal leaves the batch pending
   * by the writer's own contract and must not refuse the boot — the same rule
   * as the turn-start home, and no effect can precede the durable boot because
   * every turn is deferred until a flush commits it. Any other failure is the
   * durability fault it always was.
   */
  private async flushBooting(): Promise<void> {
    try {
      await this.flushObservations();
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
    }
  }

  /**
   * The driver's storage home (W0-d): probe before the turn opens. A low disk
   * emits one bounded diagnostic, sets `waiting` and waits a cancellable
   * `storageRetryMs`; the caller then re-reads the world range and re-checks,
   * so a high probe starts the turn and a low one keeps deferring without a
   * spin. A probe that cannot read degrades: it never refuses.
   *
   * @returns true when the turn may open.
   */
  private async storageReady(): Promise<boolean> {
    try {
      await checkStorage(this.storage, this.home);
    } catch (err) {
      if (!(err instanceof StorageError)) throw err;
      // A stop during the probe wins: no diagnostic, no fresh wait (stop()
      // already cancelled the previous one), so shutdown is never delayed.
      if (this.stopRequested) return false;
      try { this.opts.onError?.(new StorageDeferredError()); }
      catch { /* the diagnostic is not the deferral */ }
      this.nodeState = 'waiting';
      try {
        await this.waitStorageRetry();
      } finally {
        if (!this.stopRequested) this.nodeState = 'active';
      }
      return false;
    }
    return true;
  }

  /** The cancellable storage retry wait; `stop()` ends it before its timer. */
  private waitStorageRetry(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopRequested) { resolve(); return; }
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.storageWait = null;
        resolve();
      };
      const cancel = this.schedule(this.storageRetryMs, finish);
      this.storageWait = () => { cancel(); finish(); };
    });
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
    const ack = this.hooks!.acknowledgedWorld(ctx.turn);
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
    // A typed storage refusal is a bounded kernel fact (its kind, never a
    // message that could carry a payload), and it is not a write failure.
    if (err instanceof StorageError) return `storage refused (${err.kind})`;
    // A git failure is never a kernel invariant failure: it is the world's
    // mechanism refusing, and the closed vocabulary already has its own label.
    // (A turn's commit refusal never reaches here; this covers a git fault on
    // a path outside the commit boundary, such as the wake predicate.)
    if (err instanceof GitCommandError) return `git failure (${err.kind})`;
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
      // The park is over: a pending self-retry must not wake the park that
      // follows (the refusal that armed it is this park's, and the next turn
      // either re-arms it or a successful commit clears it).
      this.clearRetryTimer();
      // An evaluation still in flight for this park must not arm the latch of
      // the park that follows.
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
   *
   * A failure is reported to the host's existing diagnostic channel before it is
   * read as "no wake": silence there would make a world the predicate can never
   * read look exactly like a quiet one. The report is bounded and secret-free —
   * a fixed label (plus a git exit status), never an arbitrary message that may
   * carry a payload — and a throwing reporter cannot change the policy's answer.
   */
  private async wakeDue(): Promise<boolean> {
    try {
      return await this.wakeNeeded();
    } catch (err) {
      try { this.opts.onError?.(this.wakeDiagnostic(err)); } catch { /* the diagnostic is not the failure */ }
      return false;
    }
  }

  /** The bounded label for a failed wake read: a kind and, for a plain exit, its status. */
  private wakeDiagnostic(err: unknown): Error {
    if (err instanceof GitCommandError) {
      const label = err.kind === 'timeout'
        ? 'git timeout'
        : err.kind === 'spawn' ? 'git spawn' : `git exit ${err.exitCode ?? 'none'}`;
      return new Error(`wake predicate failed: ${label}`);
    }
    return new Error('wake predicate failed: world read failed');
  }

  /**
   * The wake predicate (kernel.md §5.2): HEAD has advanced with at least one
   * commit this node did not author. A static world is silent, a node's own
   * commits never wake it, and several foreign commits landing before the node
   * looks again are one list, hence one wake.
   *
   * The question is asked of the bounded author stream, never of the whole
   * range: the node stops at the first foreign author, so a fresh node joining a
   * large world cannot buffer a `git log` past its exec bound.
   */
  private async wakeNeeded(): Promise<boolean> {
    return this.world.hasForeignCommit(this.watermark, this.uid);
  }

  /** The range a turn opening now would present: the watermark to HEAD. */
  private async worldRange(): Promise<WorldRange> {
    return { from: this.watermark, to: await this.world.headHash() };
  }

  /**
   * Commits the world as this node, classifying every failure the commit
   * boundary can name as a typed refusal. Committing is kernel mechanism, not a
   * tool: a turn's effects are committed and attributed before its closer
   * (kernel.md §5.2) — or, when the boundary refuses, the refusal is recorded
   * and the turn ends without a commit.
   *
   * A successful commit — one that produced a hash — resets the bounded
   * self-retry and clears the durable degraded sidecar (the only clear). A
   * no-op attempt is not a successful commit: it proves the walk and `add` ran,
   * but it publishes nothing, so a held ref lock can still block the next real
   * commit and the degraded projection must stay. A refusal is returned, never
   * thrown, so the caller decides. Unknown failures still throw.
   *
   * The commit fence (C2): when a port is present, one `acquire`/`release`
   * wraps this WHOLE attempt — outside the commit queue and the internal git
   * retries, so a retry does not thaw between attempts. `release` runs in a
   * `finally`, before the closer is written, and never displaces the attempt's
   * own outcome. A present port that cannot hold the cell — a freeze failure, a
   * port that reports `unavailable`, or an acquire that throws — is the typed
   * refusal `freeze-timeout`, and `commitAll` never runs: a fence that was
   * available at boot and cannot be established now never degrades into an
   * unfenced commit. Only the ABSENCE of a port is the host's unfenced case,
   * and that fact is carried by the owner record from boot.
   */
  private async commitWorld(turn: number): Promise<DriverCommitAttempt> {
    const fence = this.opts.fence;
    try {
      if (fence !== undefined) {
        let outcome: FenceOutcome;
        try {
          outcome = await fence.acquire();
        } catch {
          return {
            commit: null,
            refusal: {
              reason: 'freeze-timeout',
              detail: boundedRefusalDetail('the commit fence could not be acquired'),
            },
          };
        }
        if (!outcome.fenced) {
          return {
            commit: null,
            refusal: {
              reason: 'freeze-timeout',
              detail: boundedRefusalDetail(
                outcome.detail ?? (outcome.reason === 'unavailable'
                  ? 'the commit fence is unavailable'
                  : 'the commit fence could not freeze the cell')),
            },
          };
        }
      }
      const attempt = await commitAllRefused(
        () => this.world.commitAll(this.uid, `turn ${turn}`),
      );
      if (attempt.refusal !== null) return { commit: null, refusal: attempt.refusal };
      const commit = attempt.commit?.hash ?? null;
      if (commit !== null) {
        this.retryAttempt = 0;
        this.clearRetryTimer();
        await this.clearWorldDegraded();
        this.watcher.poke();
      }
      return { commit, refusal: null };
    } finally {
      // The contract is that `release` never throws; the guard keeps a broken
      // port from displacing the commit's own answer, and the diagnostic is a
      // fixed label — a release fault is not a commit refusal.
      if (fence !== undefined) {
        try {
          await fence.release();
        } catch {
          // A named fault, so the host's name-only diagnostic keeps the step:
          // the fixed label is the only payload a release failure contributes.
          const fault = new Error('fence release failed');
          fault.name = 'FenceReleaseError';
          try { this.opts.onError?.(fault); } catch { /* diagnostic */ }
        }
      }
    }
  }

  /**
   * Writes the durable degraded sidecar for a refusal. It must happen BEFORE
   * the refused turn's closer: a crash between the two then still leaves the
   * degraded fact, whereas a crash after a durable closer but before the
   * sidecar would leave a turn that looks successfully closed with no retry
   * queued at boot. A failed write is diagnostic only — the local event is the
   * node's fact.
   */
  private async markCommitRefusal(refusal: CommitRefusal): Promise<void> {
    try {
      await markWorldDegraded(this.home, refusal.reason, this.now());
    } catch {
      try { this.opts.onError?.(new Error('world-state write failed')); } catch { /* diagnostic */ }
    }
  }

  /**
   * Writes the refusal fact after the refused turn's closer and flushed: the
   * event is ignorable (an older reader skips it) and outside the turn, so the
   * fold renders it into the next turn's context. The bounded self-retry is
   * armed only on the run path — a boot reconcile is followed by its own first
   * turn, so it needs no timer.
   */
  private async recordCommitRefusal(
    refusal: CommitRefusal, turn: number, retry: boolean,
  ): Promise<void> {
    this.writeEvent('world/commit-refused', { refusal, turn }, { ignorable: true });
    await this.flushObservations();
    if (retry) this.scheduleRetry();
  }

  /** Clears the sidecar after a successful commit; a failure is diagnostic only. */
  private async clearWorldDegraded(): Promise<void> {
    try {
      await clearWorldState(this.home);
    } catch {
      try { this.opts.onError?.(new Error('world-state clear failed')); } catch { /* diagnostic */ }
    }
  }

  /**
   * Arms the next bounded self-retry (1 s/4 s/16 s), never while a stop is
   * requested. The timer only requests the latch: the next turn is an ordinary
   * `wakeup`, so the retry takes the same path as a foreign commit.
   */
  private scheduleRetry(): void {
    if (this.stopRequested) return;
    if (this.retryAttempt >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[this.retryAttempt]!;
    this.retryAttempt += 1;
    this.clearRetryTimer();
    this.retryTimer = this.schedule(delay, () => {
      this.retryTimer = null;
      if (!this.stopRequested) this.latch.request();
    });
  }

  /** Cancels a pending retry wake; idempotent. */
  private clearRetryTimer(): void {
    const cancel = this.retryTimer;
    this.retryTimer = null;
    if (cancel !== null) cancel();
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
    let refusal: CommitRefusal | null = null;
    try {
      // The failed-turn path keeps its own policy: a refusal (or any commit
      // fault) must not displace the handler's error, which is the one that
      // ended the run. The writes stay in the tree for the next commit.
      const attempt = await this.commitWorld(turn);
      commit = attempt.commit;
      refusal = attempt.refusal;
    } catch {
      commit = null;
    }
    // The sidecar precedes the closer here too: a crash after the error closer
    // must not leave a degraded world that no later boot would notice.
    if (refusal !== null) await this.markCommitRefusal(refusal);
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
    // The refusal is recorded after the closer (or after its failed attempt),
    // exactly like the clean path, but WITHOUT arming a retry: the run is
    // ending, and the next process retries through the boot reconcile. A
    // failed record must not displace the handler's error either.
    if (refusal !== null) {
      try {
        await this.recordCommitRefusal(refusal, turn, false);
      } catch {
        // The handler error outranks a journal write failure on this path.
      }
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
    this.clearRetryTimer();
    // The loop has already left any storage wait; the cancel is defensive so a
    // shutdown can never be held by a timer.
    this.storageWait?.();
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
      // The trusted handler's own teardown (the terminal session and the live
      // Package Run) runs before the journal closes, with a ready-scoped gate
      // for the stop phase's facts; its failure joins the shutdown error channel.
      const stopGate = this.makeGate('ready', null, new AbortController().signal);
      try {
        await this.hooks?.onStop?.(stopGate.gate);
      } finally {
        stopGate.close();
      }
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
      await this.flushBooting();
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
      // names it rather than making a second one. A refused recovery commit is
      // the incident's own path: the sidecar is set before the synthetic closer,
      // the closer is written WITHOUT a commit, and the host still boots. The
      // refused turn's writes stay in the tree for the next turn to retry.
      const attempt = await this.reconcileInterrupted(openTurn, openRangeTo);
      if (attempt.refusal !== null) await this.markCommitRefusal(attempt.refusal);
      this.writeEvent('turn/end', {
        turn: openTurn, outcome: 'interrupted', synthetic: true,
        ...(attempt.commit !== null ? { commit: attempt.commit } : {}),
      });
      // A closer is a closer, synthetic or not: durable before the boot is
      // journaled on top of it, so a crash between the two still leaves the
      // commit it names attributable (kernel.md §3).
      await this.flushBooting();
      if (attempt.refusal !== null) {
        // The refusal fact's own barrier is part of the boot: a storage
        // refusal leaves it pending rather than refusing the boot.
        try {
          await this.recordCommitRefusal(attempt.refusal, openTurn, false);
        } catch (err) {
          if (!(err instanceof StorageError)) throw err;
        }
      }
    }
    this.writeEvent('node/boot', { reason: sawAny ? 'resume' : 'start' });
    await this.flushBooting();
    await this.readyPhase();
  }

  /**
   * The commit a surviving open turn already made, or the one its remaining
   * working-tree writes now make. The search base is the range the turn opened
   * on (`to`), never the prior acknowledgement: only commits *after* the turn
   * opened can belong to it, and the node's uid and the exact `turn N` subject
   * must both match. Zero candidates is the existing dirty-tree recovery: the
   * whole working tree is committed as this node's own recovery commit, and
   * because `commitWorld` stages everything (`git add --all`), a peer's dirty
   * files are swept in with the node's own — commit-granular attribution, the
   * accepted behavior of the zero-candidate path. Exactly one candidate is
   * named as-is and stages nothing — a commit already succeeded, so any stale
   * degraded sidecar is cleared here exactly as a fresh successful commit
   * would clear it. A bounded-out search and an unreachable base are refused by
   * `commitsForTurn`; more than one match is returned by it and refused here.
   */
  private async reconcileInterrupted(
    turn: number, base: string | null,
  ): Promise<DriverCommitAttempt> {
    const candidates = await this.world.commitsForTurn(base, this.uid, turn);
    if (candidates.length > 1) {
      throw new WorldReconciliationError(
        `interrupted turn ${turn} names ${candidates.length} matching commits`);
    }
    if (candidates.length === 1) {
      // The turn's commit landed before the crash: that is a successful commit,
      // so the sidecar a refused attempt may have left must not outlive it.
      this.retryAttempt = 0;
      this.clearRetryTimer();
      await this.clearWorldDegraded();
      return { commit: candidates[0]!.hash, refusal: null };
    }
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
      try {
        // The handler's ready phase flushes through its gate (the journaled
        // config, the recovery facts): on a low disk that refusal leaves the
        // batch pending exactly like the driver's own boot barrier, and the
        // boot still completes — no turn opens until a flush commits it.
        await this.hooks.onReady(created.gate);
      } catch (err) {
        if (!(err instanceof StorageError)) throw err;
      }
      await this.flushBooting();
    } finally {
      created.close();
    }
  }
}
