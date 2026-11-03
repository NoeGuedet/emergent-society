import { Buffer } from 'node:buffer';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BlobStore, assertNodeUid, nodeDir } from '../journal/index.js';
import { canonicalBytes } from '../context/artifacts.js';
import { assemble } from '../context/assembler.js';
import { defaultAgentConfig, validateAgentConfig } from '../context/config.js';
import { runCompaction } from '../context/compaction.js';
import { presentWorld } from '../context/diff.js';
import { createBoundaryRegistry } from '../context/events.js';
import { ContextFold } from '../context/fold.js';
import { loadVerifiedEvents } from '../context/loader.js';
import {
  headerDigest, meterFires, meterHeadroom, meterPercent, meterThreshold, meterTotal, priceWire,
} from '../context/meter.js';
import { writeSnapshot } from '../context/snapshots.js';
import { dispatchCalls } from './tools/dispatch.js';
import { renderOpeningReceipt } from './receipt.js';
import { renderConversationNotice } from './conversation.js';
import type { ConversationNoticeSource } from './conversation-watcher.js';
import { createSelfPort } from './self.js';
import { readCommitPaths } from './world-paths.js';
import { windowForModel } from './tools/providers.js';
import type { ExtendPort } from './tools/extend.js';
import type { RunSupervisorEvents } from './packages/supervisor.js';
import type { ProviderAdapter } from '../provider/adapter.js';
import type {
  AgentConfig, AssistantAccounting, LlmModel, LlmModelWindow, MeterRecord, ProjectionState,
  RequestId, RequestPlan, TokenTriggerPolicy,
} from '../context/contracts.js';
import { MAX_CAPTURE_BYTES } from './gate.js';
import type { BoundaryGate, DriverHooks, DurableWatermark } from './gate.js';
import type { TurnContext, TurnHandler, TurnResult } from './driver.js';
import { buildSandboxSpec } from './tools/sandbox.js';
import type { SandboxStatus } from './tools/sandbox.js';
import { PtyTerminalRuntime, failedOutcome } from './tools/terminal.js';
import type { TerminalFactory, TerminalPort, TerminalRuntime } from './tools/terminal.js';
import type { WebTools } from './tools/web.js';
import type { WorldRepo } from './world.js';

/**
 * The C1.3 agent runtime: the trusted kernel handler and hook bundle that
 * turn the driver's turn ritual into real model requests and tool effects.
 *
 * It owns a `ContextFold`, presents one recorded world perception per turn,
 * assembles exactly one plan per logical request, refuses an oversize plan
 * before storage, delegates the request to the provider adapter and the
 * resulting calls to the dispatcher. It never hands the writer to
 * the model and never assembles a second message, request, artifact or state
 * shape: every fact it writes goes through the boundary gate.
 *
 * The persistent shell is confined by default (C1.4c): the first `execute`
 * builds the Landlock policy from the world, the cell home and the uid, probes
 * it functionally and spawns the vendored launcher. A sandbox that cannot be
 * built or probed fails every `execute` closed as `spawn-failed` (kernel.md:84)
 * — never a silent unconfined shell; `terminal.sandbox: false` is the loud,
 * explicit escape hatch and a supplied `create` factory owns confinement
 * itself. The kernel process stays outside the sandbox: it also spawns git,
 * the journal and the provider transport, none of which the confined shell can
 * reach. `sandboxStatus()` reports the probed ABI/enforcement (a host fact,
 * not journaled). `mock-model` is a test fixture, not a certified provider.
 *
 * The local log is the node's cold-start artifact, not the truth: every
 * kernel-mediated HTTP exchange (the provider and the web tools) crosses the
 * frontier journal, whose request record is durable before the send
 * and whose terminal is durable before the caller proceeds. The local log keeps
 * only the semantic runtime facts — turns, perceptions, assistant messages,
 * tool calls/results, compactions, config — and carries one-directional
 * `frontierCall` references for the cold start. `request/refused` stays local:
 * it is the runtime's own capture-ceiling decision before any call exists.
 *
 * The frontier journal is not the runtime's resource: the host opens one per
 * cell home, injects its gate into the adapter and the web tools, and closes it
 * at shutdown. So two runtimes on the same home (different uids — the local
 * writer's lock is per `(home, uid)`) share one frontier chain, while the
 * runtime itself neither opens nor closes it.
 */

/** Everything one runtime needs; each field is either a recorded policy or a trusted port. */
export type RuntimeOptions = {
  readonly home: string; readonly uid: string; readonly world: WorldRepo;
  readonly initialConfig: AgentConfig; readonly adapter: ProviderAdapter;
  /**
   * The persistent terminal: the trusted environment allowlist (never
   * `process.env`), plus an optional factory — the test seam that replaces the
   * retired module mock. Numeric limits are read from the journaled policy at
   * each call, so a restart cannot resurrect ignored numbers.
   */
  readonly terminal: {
    readonly env: Readonly<Record<string, string>>;
    readonly create?: TerminalFactory;
    /**
     * Confinement of the persistent shell (C1.4c). Default: Landlock via the
     * vendored launcher. `false` is the explicit unconfined escape hatch (host
     * debugging only). `{ launcherPath }` overrides the binary (tests). A
     * supplied `create` owns the runtime entirely — no spec is built for it.
     * An unusable sandbox fails every `execute` closed as `spawn-failed`
     * (kernel.md:84), never a silent unconfined shell.
     */
    readonly sandbox?: false | {
      readonly launcherPath?: string;
      /** The shell's cgroup leaf; absent = no cgroup attach (Landlock-only). */
      readonly cgroupPath?: string;
      /** Written into the leaf before the shell spawns (delegated hosts only). */
      readonly leafLimits?: { readonly memoryMaxBytes: number; readonly pidsMax: number };
    };
  };
  /** Kernel-mediated web tools; when absent, offered web calls resolve as `denied`. */
  readonly webTools?: WebTools;
  /**
   * The operator-declared model catalog (providers.json `llm.models`): handed to
   * the assembler for the plan's substrate block (its IDS — the window never
   * rides the wire) and read for the current model's declared window, which
   * drives the token trigger. A host fact, not a journaled one: absent means the
   * store declares no catalog, so no block is rendered, no window resolves and a
   * node's model stays the free string it was.
   */
  readonly models?: readonly LlmModel[];
  /**
   * One bounded, NON-JOURNALED host diagnostic (host state, never a journal
   * fact): the token trigger's windowless fallback (once per boot — the absent
   * catalog cell and the out-of-catalog spawn both land here) and the
   * uncompactable-over-window escape. The host writes it to its log; the
   * runtime journals nothing for either.
   */
  readonly diagnose?: (diagnostic: RuntimeDiagnostic) => void;
  /**
   * The extend port factory (C1.5): the loop owns the event router (it alone
   * knows which gate the current dispatch holds), the caller owns the
   * construction — the host composes the store and the supervisor (L5), tests
   * inject them. When absent, offered `extend` calls resolve as `denied`. The
   * runtime always replaces the returned port's `self` field with its own seam
   * over the live fold, so a rewrite is derived from the identity in force,
   * never from a caller's snapshot.
   */
  readonly extend?: (
    events: RunSupervisorEvents,
    ports: { readonly terminal: TerminalPort | null; readonly web: WebTools | null },
  ) => ExtendPort;
  /**
   * The pending conversation notice (the interface's notification, host state):
   * the runtime reads it before each assembled request and clears it only after
   * a request the kernel actually sent. Absent means no conversation physics.
   */
  readonly notice?: ConversationNoticeSource;
};

export interface AgentRuntime {
  readonly handler: TurnHandler; readonly hooks: DriverHooks;
  scheduleConfig(config: AgentConfig): void;
  snapshot(): ProjectionState;
  checkpoint(mark: DurableWatermark): Promise<void>;
  /** The shell sandbox status: the live runtime's, the last probed one across a stop, else null. */
  sandboxStatus(): SandboxStatus | null;
}

// `defaultAgentConfig` lives in `src/context/config.ts` and is re-exported here
// for runtime consumers; it is never redefined. `validateAgentConfig` is an
// implementation detail of this module (the runtime validates its own config),
// so it is imported and used, never re-exported.
export { defaultAgentConfig };

/**
 * The uncompactable escape's typed sentence (A4): the priced request is over the
 * threshold and no transaction can reduce it, so it is sent anyway — a stated
 * policy, its accounting home the bounded host diagnostic (the escape branch
 * journals nothing).
 */
export const UNCOMPACTABLE_OVER_WINDOW = 'over the window but uncompactable: sent anyway';

/**
 * The re-price's observed sentence: the forced compaction reduced the surface
 * but the re-assembled request is still over the threshold, so it is sent
 * anyway (the bounded loop never compacts twice for one logical request).
 */
export const AFTER_COMPACTION_OVER_WINDOW =
  'still over the window after the forced compaction: sent anyway';

/**
 * The early trigger's typed miss (A5): the `remember {compact:true}` flag was
 * consumed at the plan site and no transaction could reduce the surface, so it
 * is the uncompactable escape's shape — a stated outcome, never a silent
 * no-op. The pending authored payload, when there is one, stays pending (it
 * may still fill a later slot inside its turn-distance expiry).
 */
export const EARLY_COMPACT_NOTHING_SELECTABLE =
  'the early compaction found nothing selectable: no transaction ran';

/**
 * The early trigger's second typed miss (A5): the forced transaction was
 * ABORTED (an orphan recovered at the plan site, or a stale candidate raced by
 * a concurrent change), so no replacement applied. Like the nothing-selectable
 * case it is a stated outcome, never a silent flag consumption.
 */
export const EARLY_COMPACT_ABORTED =
  'the early compaction was aborted (stale or orphan): no replacement applied';

/**
 * The pending authored survival's turn-distance expiry (A5), part of this
 * brick's committed pins. The payload recorded at turn N is eligible at the
 * plan site while `turn − N < REMEMBER_PENDING_TURNS` and is dropped once that
 * distance is reached; its later slots are never filled by a stale text. The
 * slot is RUNTIME state, not a journal fact: a restart drops it outright (the
 * node re-authors — residual A8(n)), independent of the turn distance.
 */
export const REMEMBER_PENDING_TURNS = 4;

/** One bounded runtime diagnostic: host state, never a journal fact. */
export type RuntimeDiagnostic =
  | { readonly kind: 'token-trigger-fallback' }
  | {
      readonly kind: 'uncompactable-over-window';
      readonly estimate: number; readonly threshold: number;
    }
  | {
      readonly kind: 'over-window-after-compaction';
      readonly estimate: number; readonly threshold: number;
    }
  | { readonly kind: 'early-compact-nothing-selectable' }
  | { readonly kind: 'early-compact-aborted' };

/**
 * The typed outcome of one early-trigger attempt (A5): `applied` is the one
 * non-miss (the transaction journals its own summary); every other outcome is
 * a stated miss — `skipped` (nothing selectable) or `aborted` (stale/orphan) —
 * so the flag's consumption is never silent. Pure; the host maps each miss to
 * its own bounded log line.
 */
export function earlyTriggerMiss(
  outcome: 'applied' | 'skipped' | 'aborted',
): RuntimeDiagnostic | null {
  if (outcome === 'applied') return null;
  return outcome === 'skipped'
    ? { kind: 'early-compact-nothing-selectable' }
    : { kind: 'early-compact-aborted' };
}

/** The resolved token rule of one request: the declared window, `O`, and the journaled rule. */
type TokenRule = {
  readonly window: number;
  readonly output: number;
  readonly policy: TokenTriggerPolicy;
};

/**
 * `O`'s exact precedence (A4): `parameters.max_tokens ?? catalog.maxOutputTokens
 * ?? 0`. The parameters validator already bounds `max_tokens` to a positive safe
 * integer; anything else falls through to the declaration.
 */
function outputReservation(
  parameters: AgentConfig['parameters'], declaredOutput: number,
): number {
  const maxTokens = parameters['max_tokens'];
  return typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0
    ? maxTokens
    : declaredOutput;
}

/** Stop-time kill grace when no config was ever journaled (pre-ready stop). */
const FALLBACK_KILL_GRACE_MS = 200;

/** The one message a reconciled call with no durable result carries (fold algorithm 6). */
const RECONCILE_NOTICE = 'Outcome unknown after interruption; not re-executed';

/**
 * A session build's settled outcome. Never a rejecting promise: a stop awaits
 * the memo, and a rejection there would re-throw through `driver.shutdown`.
 */
type SessionBuild =
  | { readonly ok: true; readonly runtime: TerminalRuntime }
  | { readonly ok: false; readonly diagnostic: Uint8Array };

class Runtime implements AgentRuntime {
  private readonly fold = new ContextFold();
  private readonly initialConfig: AgentConfig;
  /** The latest scheduled configuration, applied at the next turn start. */
  private pendingConfig: AgentConfig | null = null;
  /**
   * The current stop generation's session build, taken and cleared by
   * `stopTerminal` before it awaits. A settled union, assigned synchronously
   * before the build's first await, so two runs never build twice.
   */
  private sessionMemo: Promise<SessionBuild> | null = null;
  /**
   * A build that failed under the current generation. It persists for the
   * runtime's lifetime (a stop never clears it): a host that fixed its
   * environment constructs a fresh runtime, and a same-generation failure
   * short-circuits without re-running the builder.
   */
  private buildFailure: Uint8Array | null = null;
  /** Incremented by every stop: a build finishing later is superseded. */
  private stopGeneration = 0;
  /** The adopted runtime of the current generation; a superseded build never sets it. */
  private liveRuntime: TerminalRuntime | null = null;
  /** The last probed status, surviving a stop; null until a probe succeeds. */
  private lastStatus: SandboxStatus | null = null;
  /**
   * The token meter's anchor, beside `pendingConfig` (runtime state, never
   * journaled): the latest journaled sample — {headerDigest,
   * surfacePriceAtSample, usage} — which the adoption rule reads at the next
   * plan site. It is a CACHE of the fold's `lastAssistantAccounting()`: `ready`
   * re-forms it, so a restart re-anchors exactly from the journal.
   */
  private anchor: AssistantAccounting | null = null;
  /**
   * The pending authored survival (A5), beside the conversation notice: host
   * state, never journaled. The `remember` verb records it (a second call
   * replaces it outright), the next applied compaction consumes it, and the
   * turn-distance expiry drops a stale one. A restart starts empty — the node
   * re-authors; the verb's result text says the slot is runtime-only.
   */
  private pendingAuthored: { readonly text: string; readonly turn: number } | null = null;
  /**
   * The remember verb's early-trigger FLAG (A5): consumed at the NEXT plan
   * site, never a verb-time transaction — the committed surface excludes the
   * open turn, so "compact now" pre-compacts the next request. A second
   * remember replaces the whole act (payload and flag alike).
   */
  private earlyCompact = false;
  /** The windowless fallback is diagnosed once per boot (the stated bound). */
  private fallbackDiagnosed = false;
  /** Set by the driver's stop: a late run can never respawn a session. */
  private terminalStopped = false;
  private readonly terminalPort: TerminalPort;
  /** The extend port, built once per runtime; null resolves calls as denied. */
  private readonly extendPort: ExtendPort | null;
  /** The gate holder the package event router reads (the current dispatch's). */
  private packageGateHolder: { gate: BoundaryGate | null } = { gate: null };
  /** Flushes the queued out-of-dispatch package facts into a gate; returns how many landed. */
  private flushPackageFacts: (gate: BoundaryGate) => number = () => 0;
  readonly handler: TurnHandler;
  readonly hooks: DriverHooks;

  constructor(private readonly options: RuntimeOptions) {
    // The runtime's uid is the node's technical identity: the journal directory
    // name, the commit author and the perception uid all derive from it, so it is
    // validated at construction — an invalid one can never reach the filesystem
    // or a git identity through this runtime.
    assertNodeUid(options.uid);
    this.initialConfig = validateAgentConfig(options.initialConfig);
    this.handler = (ctx: TurnContext): Promise<TurnResult> => this.run(ctx);
    this.hooks = {
      registry: createBoundaryRegistry(),
      onDurable: async (events): Promise<void> => { await this.fold.observe(events); },
      onReady: async (gate): Promise<void> => { await this.ready(gate); },
      onTurnStart: async (ctx): Promise<void> => { await this.beginTurn(ctx); },
      readHistory: (home, uid, knownTypes) => loadVerifiedEvents(home, uid, knownTypes),
      readBlob: (hash) => new BlobStore(this.options.home).get(hash),
      acknowledgedWorld: (turn) => this.fold.acknowledgedWorld(turn),
      onStop: async (gate): Promise<void> => {
        // Independent disposals: the terminal teardown's failure never skips
        // the Run disposal, and it rethrows only after both have settled.
        const terminalError = await this.stopTerminal()
          .then(() => null, (err: unknown) => err);
        await this.stopPackages(gate);
        // A fact queued while the node was parked (a Run that crashed before
        // this stop) lands here — the queue must not die with the process,
        // because a production resume is a new one. The flush happens only
        // when a fact actually landed: an empty queue must not perturb the
        // stop's own durable sequencing.
        if (gate !== null && this.flushPackageFacts(gate) > 0) {
          await gate.flush();
        }
        if (terminalError !== null) throw terminalError;
      },
    };
    // The events router: the supervisor's effect/error/service facts append
    // to whichever gate the current dispatch holds — the turn gate here, the
    // ready gate for L5's boot scan.
    const packageGateHolder: { gate: BoundaryGate | null } = { gate: null };
    this.packageGateHolder = packageGateHolder;
    // A fact arriving with no gate held (an idle Run crash while the node is
    // parked) is QUEUED and flushed into the next gate — a kernel-mediated
    // fact is never silently dropped (design §6.3/§8). The queue is bounded:
    // a torn-down Run emits at most one fact per kind.
    const packageFactQueue: { type: string; data: unknown }[] = [];
    const queueFact = (type: string, data: unknown): void => {
      const gate = packageGateHolder.gate;
      if (gate !== null) {
        gate.append(type as 'package/effect', data as never);
        return;
      }
      if (packageFactQueue.length >= 64) packageFactQueue.shift();
      packageFactQueue.push({ type, data });
    };
    const flushPackageFacts = (gate: BoundaryGate): number => {
      const queued = packageFactQueue.splice(0);
      for (const fact of queued) {
        gate.append(fact.type as 'package/effect', fact.data as never);
      }
      return queued.length;
    };
    this.flushPackageFacts = flushPackageFacts;
    const packageEvents: RunSupervisorEvents = {
      effect: (payload) => { queueFact('package/effect', payload); },
      error: (payload) => { queueFact('package/error', payload); },
      service: (payload) => { queueFact('package/service', payload); },
    };
    this.terminalPort = {
      run: async (cmd, limits, signal) => {
        if (this.terminalStopped) {
          return failedOutcome(signal.aborted ? 'cancelled' : 'spawn-failed', null);
        }
        const built = await this.session();
        // Re-check after the await: a stop during the build latches this run
        // too, and it must not touch the runtime the stop is disposing. A
        // fresh late call (not aborted) still reports `spawn`, preserving the
        // between-drivers contract; a real stop aborts its own work first.
        if (this.terminalStopped) {
          return failedOutcome(signal.aborted ? 'cancelled' : 'spawn-failed', null);
        }
        if (!built.ok) return failedOutcome('spawn-failed', null, false, built.diagnostic);
        return built.runtime.run(cmd, limits, signal);
      },
    };
    // The extend port is composed last: the factory receives the event
    // router AND the node's own ports (svc inherits their rights — an
    // absent tool is a null port, the allowedTools inheritance). The runtime
    // then supplies the self seam over its own live fold: only this module
    // holds the folded configuration a rewrite is derived from, and the
    // renew reads it at call time — never the config captured at turn start.
    const port = options.extend === undefined
      ? null
      : options.extend(packageEvents, {
        terminal: this.terminalPort,
        web: options.webTools ?? null,
      });
    this.extendPort = port === null
      ? null
      : {
        ...port,
        self: createSelfPort(
          () => this.fold.snapshot().config?.value ?? null, options.uid, options.models,
        ),
        // The history seam (the SelfPort precedent): composed HERE, beside the
        // fold, because only the runtime holds the live ContextFold — the host
        // cannot compose it. It is bound to this node's uid by construction
        // (the fold is this node's journal): the port takes no uid and can
        // answer only for this node. The paths reader is the world's read
        // plumbing (`world-paths.ts`), one diff-tree child per committed entry
        // in a read's window, each under its own read deadline.
        history: {
          events: () => this.fold.verifiedEvents(),
          commitPaths: (hash) => readCommitPaths(this.options.world, hash),
        },
        // The memory seam (A5, the SelfPort/HistoryPort precedent): the pending
        // authored survival and the early-trigger flag are runtime state, so
        // only this module can hold them; the executor reads the journaled
        // `memory.remember` gate FIRST and reaches this port only when it is ON.
        // The turn is carried explicitly: the payload's expiry is a distance
        // from the turn that authored it, not from wall time.
        memory: {
          remember: (text, compact, turn) => {
            this.pendingAuthored = { text, turn };
            this.earlyCompact = compact;
          },
        },
      };
  }

  /**
   * The host-stopped Run's disposal (the stopTerminal precedent): the
   * supervisor's stop completes kernel-side, and the `package/stop` fact
   * names the host as its reason through the stop gate — a stop-phase fact is
   * never unattributed.
   */
  private async stopPackages(gate: BoundaryGate | null): Promise<void> {
    const port = this.extendPort;
    if (port === null) return;
    const runId = port.supervisor.liveRunId();
    const packageId = port.supervisor.livePackageId();
    if (runId === null || packageId === null) return;
    await port.supervisor.stopRun();
    if (gate !== null) {
      gate.append('package/stop', { id: packageId, runId, reason: 'host-stop' });
      await gate.flush();
    }
  }

  /**
   * The boot scan (C1.5, design §6.1): every stored definition is re-verified
   * in place — corrupt bytes are deleted and reported through the ready gate
   * as `package/error` corrupt facts — and everything under `runs/` is reaped:
   * no Run survives a restart, and a kernel crash between leaf creation and
   * spawn cannot leak orphaned leaves. No config message, no re-journal: the
   * offering is the frozen base offering by construction.
   */
  private async scanPackages(gate: BoundaryGate): Promise<void> {
    const port = this.extendPort;
    if (port === null) return;
    const { corrupt } = await port.store.readMountedPackages();
    for (const entry of corrupt) {
      gate.append('package/error', {
        id: entry.id, runId: null, code: 'corrupt', detail: entry.reason,
      });
    }
    if (corrupt.length > 0) await gate.flush();
    await rm(
      join(nodeDir(this.options.home, this.options.uid), 'runs'),
      { recursive: true, force: true },
    ).catch(() => { /* absence is the clean state */ });
  }

  scheduleConfig(config: AgentConfig): void {
    // Validated immediately (an oversize or malformed config is refused before it
    // is accepted, the prior durable config staying in force); the version is
    // checked again when it is applied.
    this.pendingConfig = validateAgentConfig(config);
  }

  snapshot(): ProjectionState {
    return this.fold.snapshot();
  }

  async checkpoint(mark: DurableWatermark): Promise<void> {
    await writeSnapshot(this.options.home, this.options.uid, {
      ver: 1, seq: mark.seq, hash: mark.hash, val: this.fold.snapshot(),
    });
  }

  /**
   * Ready scope: record the initial configuration when the journal has none,
   * reconcile every interrupted call that has no durable result with a synthetic
   * unknown-outcome result, abort orphaned compaction transactions, flush.
   * `compaction/abort` is scope-agnostic, so `runCompaction` is only reached here
   * when there is an orphan to abort — it can never select a new transaction in
   * ready scope.
   *
   * The shell's numeric limits are read from the journaled policy at each
   * dispatch, so the journal's numbers win by construction and nothing is left
   * to compare.
   */
  private async ready(gate: BoundaryGate): Promise<void> {
    // A new driver session begins its ready phase here: the latch above is
    // scoped to one driver run, so a sequential second driver on this runtime
    // may spawn again, while an execute after a stop and before any next open
    // still fails closed. The runtime stays single-terminal — one live session.
    this.terminalStopped = false;
    // The boot scan precedes the fold's config check, so it precedes the
    // first turn (kernel.md, the C1.5 lifecycle): re-verify the stored
    // definitions, report the corrupt ones, reap the orphaned run leaves.
    await this.scanPackages(gate);
    // A fact queued while the node was parked (an idle Run crash) lands here.
    void this.flushPackageFacts(gate);
    if (this.fold.snapshot().config === null) {
      const stored = await gate.store(this.initialConfig);
      gate.append('system/message', { version: this.initialConfig.version, value: stored });
    }
    for (const unresolved of this.fold.unresolvedCalls()) {
      gate.append('tool/result', {
        turn: unresolved.turn, request: unresolved.request, callId: unresolved.call.id,
        message: { role: 'tool', content: RECONCILE_NOTICE, tool_call_id: unresolved.call.id },
        isError: true, raw: null, failure: null, synthetic: true, frontierCall: null,
      });
    }
    if (this.fold.orphanCompactions().length > 0) await runCompaction(this.fold, gate);
    // The anchor re-forms from the fold (A2(ii)/A7): the latest assistant
    // record's journaled triple is the durable source of the runtime state, so
    // the restart claim is the journal's, not a remembered estimate.
    this.anchor = this.fold.lastAssistantAccounting();
    await gate.flush();
  }

  /**
   * The one session per node, built lazily by the current driver and torn down
   * by its stop. The memo is assigned synchronously before the build's first
   * await, so concurrent runs share one build; a recorded build failure
   * short-circuits for the runtime's lifetime without re-running the builder.
   */
  private session(): Promise<SessionBuild> {
    if (this.buildFailure !== null) {
      return Promise.resolve({ ok: false, diagnostic: this.buildFailure });
    }
    const memo = this.sessionMemo;
    if (memo !== null) return memo;
    const built = this.buildSession(this.stopGeneration);
    this.sessionMemo = built;
    return built;
  }

  /**
   * Builds the runtime: the supplied factory owns everything; otherwise
   * `sandbox: false` is the explicit unconfined runtime and the default builds
   * the Landlock spec (the home layout already exists by the first execute).
   * A build that observes a stop after its last await disposes what it made and
   * does not memoize a failure: the next sequential driver rebuilds cleanly.
   */
  private async buildSession(generation: number): Promise<SessionBuild> {
    let runtime: TerminalRuntime;
    try {
      runtime = await this.createRuntime();
    } catch (err) {
      const diagnostic = Buffer.from(err instanceof Error ? err.message : String(err));
      if (this.stopGeneration === generation) this.buildFailure = diagnostic;
      return { ok: false, diagnostic };
    }
    if (this.stopGeneration !== generation) {
      // The stop already took the memo, so nothing will dispose this runtime
      // unless the build does. Deliberately outside the failure-classifying
      // catch: a throwing dispose neither rejects the union nor masquerades as
      // a build failure. The stop's own disposal is idempotent, and the
      // resolved `ok` runtime fails every run closed (it is disposed).
      await runtime.dispose(this.killGrace()).catch(() => {});
      return { ok: true, runtime };
    }
    this.liveRuntime = runtime;
    return { ok: true, runtime };
  }

  private async createRuntime(): Promise<TerminalRuntime> {
    const terminal = this.options.terminal;
    const cwd = this.options.world.path;
    if (terminal.create !== undefined) return terminal.create(cwd, terminal.env);
    const sandbox = terminal.sandbox;
    if (sandbox === false) return new PtyTerminalRuntime(cwd, terminal.env, 'off');
    if (sandbox?.cgroupPath !== undefined) {
      // The leaf must exist before the launcher joins it; the naming and the
      // tree belong to the host layer, which passes the path as a string.
      await mkdir(sandbox.cgroupPath, { recursive: true });
      if (sandbox.leafLimits !== undefined) {
        // Before any process enters: a leaf keeps its caps for the session.
        await writeFile(join(sandbox.cgroupPath, 'memory.max'), String(sandbox.leafLimits.memoryMaxBytes))
          .catch(() => {});
        await writeFile(join(sandbox.cgroupPath, 'pids.max'), String(sandbox.leafLimits.pidsMax))
          .catch(() => {});
      }
    }
    const spec = await buildSandboxSpec({
      world: cwd,
      home: this.options.home,
      uid: this.options.uid,
      // exactOptionalPropertyTypes: an absent override, never an explicit undefined.
      ...(sandbox?.launcherPath !== undefined ? { launcherPath: sandbox.launcherPath } : {}),
      ...(sandbox?.cgroupPath !== undefined ? { cgroupPath: sandbox.cgroupPath } : {}),
    });
    return new PtyTerminalRuntime(cwd, terminal.env, spec);
  }

  /** The journaled kill grace, or the pre-ready fallback. */
  private killGrace(): number {
    try {
      return this.fold.snapshot().config?.value.policy.killGraceMs ?? FALLBACK_KILL_GRACE_MS;
    } catch { return FALLBACK_KILL_GRACE_MS; }
  }

  /**
   * The shell's status: a live runtime reports its own — `null` until it has
   * probed, and `null` again when its probe failed — so a stale success never
   * describes a live shell. `lastStatus` serves only with no live runtime, the
   * cached read that survives a stop.
   */
  sandboxStatus(): SandboxStatus | null {
    if (this.liveRuntime !== null) return this.liveRuntime.sandboxStatus?.() ?? null;
    return this.lastStatus;
  }

  /** The driver's stop tears the session down before the journal closes. */
  private async stopTerminal(): Promise<void> {
    // All three state transitions are synchronous and precede any await: latch
    // the port, supersede an in-flight build, and take the memo (so the next
    // driver's ready() starts a fresh one). A build that settles afterwards
    // sees the generation change and disposes what it made.
    this.terminalStopped = true;
    this.stopGeneration += 1;
    const memo = this.sessionMemo;
    this.sessionMemo = null;
    // An unconditional copy would wipe a surviving status on a stop with no
    // session; a live runtime's status is the freshest fact there is.
    this.lastStatus = this.liveRuntime?.sandboxStatus?.() ?? this.lastStatus;
    this.liveRuntime = null;
    if (memo === null) return;
    // A settled union: this await can never reject.
    const built = await memo;
    if (!built.ok) return;
    await built.runtime.dispose(this.killGrace());
  }

  /**
   * Turn scope: apply a strictly newer scheduled configuration, present the world
   * pinned to the turn's opening range with the recorded render budgets, refuse a
   * perception whose uid is not the runtime's before storing anything, store the
   * perception once and flush. The refusal produces no effect — the driver still
   * closes the turn through its normal durable fatal closer.
   */
  private async beginTurn(ctx: TurnContext): Promise<void> {
    const slot = this.fold.snapshot().config;
    if (slot === null) throw new Error('runtime: turn started without a configuration');
    let config = slot.value;
    const scheduled = this.pendingConfig;
    this.pendingConfig = null;
    if (scheduled !== null && scheduled.version > config.version) {
      const stored = await ctx.gate.store(scheduled);
      ctx.gate.append('system/message', { version: scheduled.version, value: stored });
      config = scheduled;
    }
    const perception = await presentWorld(
      this.options.world, this.options.uid, ctx.world,
      config.policy.maxDiffBytes, config.policy.maxCommits,
    );
    if (perception.uid !== this.options.uid) {
      throw new Error(
        `runtime: presented world perception uid ${JSON.stringify(perception.uid)}`
        + ` is not the runtime uid ${JSON.stringify(this.options.uid)}`);
    }
    const stored = await ctx.gate.store(perception);
    ctx.gate.append('world/perception', { turn: ctx.turn, range: ctx.world, value: stored });
    await ctx.gate.flush();
  }

  /**
   * The declared window of the current model, from the operator's catalog. A
   * key-present/windowless cell (the absent-catalog home, an out-of-catalog
   * spawn-inherited model, or a store edited to the ids-only form) keeps the
   * byte trigger and is diagnosed ONCE per boot with a bounded host fact.
   */
  private resolveWindow(config: AgentConfig): LlmModelWindow | null {
    const window = windowForModel(this.options.models, config.model);
    if (window === null && config.policy.compactAfterTokens !== undefined
      && !this.fallbackDiagnosed) {
      this.fallbackDiagnosed = true;
      this.diagnose({ kind: 'token-trigger-fallback' });
    }
    return window;
  }

  /** The bounded, non-journaled diagnostic: a throwing sink never breaks a turn. */
  private diagnose(diagnostic: RuntimeDiagnostic): void {
    try {
      this.options.diagnose?.(diagnostic);
    } catch { /* the diagnostic is not the turn */ }
  }

  /**
   * The pending authored survival for this turn, after the turn-distance
   * expiry (A5): a payload whose distance has reached REMEMBER_PENDING_TURNS is
   * dropped here — it is never applied to a slot authored long after the text.
   * The expiry shares the restart-loss rule's honest shape: the slot is runtime
   * state, so neither the payload nor its age is journaled.
   */
  private pendingAuthoredFor(turn: number): string | undefined {
    const pending = this.pendingAuthored;
    if (pending === null) return undefined;
    if (turn - pending.turn >= REMEMBER_PENDING_TURNS) {
      this.pendingAuthored = null;
      return undefined;
    }
    return pending.text;
  }

  /**
   * One priced request at the plan site: the full wire price, the anchor's
   * adoption (A2(ii)), the threshold and its published effective percent, and
   * the domain verdict. Pure — no journal, no send, no model.
   */
  private tokenDecision(
    plan: RequestPlan, rule: TokenRule,
  ): {
    readonly total: number; readonly kind: 'usage' | 'estimate';
    readonly headroom: number; readonly threshold: number; readonly percent: number;
    readonly degenerate: boolean;
  } {
    const headroom = meterHeadroom(rule.window, rule.policy);
    const threshold = meterThreshold(rule.window, rule.output, rule.policy);
    const priced = meterTotal({
      headerDigest: headerDigest(plan),
      surfacePrice: priceWire(plan),
      anchor: this.anchor,
    });
    return {
      ...priced,
      headroom,
      threshold,
      percent: meterPercent(rule.window, threshold),
      // O >= W is the typed refusal the plan names; a threshold at or below zero
      // is the same degenerate domain reached by a journaled rule (the
      // declaration refuses only the factory's band).
      degenerate: rule.output >= rule.window || threshold <= 0,
    };
  }

  /**
   * The turn's logical requests. Before each one: the trigger (the byte trigger
   * on a legacy/windowless cell, the token trigger when the policy key AND a
   * declared window resolve), assemble, measure the canonical plan against the
   * capture ceiling (refusing an oversize plan durably before any storage or
   * send), send through the adapter, then dispatch the calls. A no-call response
   * or an explicit wait parks; an exhausted call group chains while the quantum
   * lasts.
   *
   * The token trigger (A4) lives at the plan site: the priced request's total
   * (never the plan's canonical bytes — the input-is-the-wire rule) is compared
   * to `floor(min(ratio·W, W − O − headroom))`; over it, ONE forced compaction
   * and ONE re-assemble + re-price follow, and a request no transaction can
   * reduce is sent anyway under the typed uncompactable escape. A compaction
   * makes NO adapter send: the kernel never calls a model for memory.
   */
  private async run(ctx: TurnContext): Promise<TurnResult> {
    const slot = this.fold.snapshot().config;
    if (slot === null) throw new Error('runtime: handler reached without a configuration');
    const config = slot.value;
    // The modern opening receipt is rendered ONCE at run entry from the driver's
    // captured physical facts (never Date.now) and reused for every assembly of
    // this turn's logical request ordinal 0 — compaction, reassembly, adapter
    // retry and the overflow resend included. It is never retained as local
    // history and never regenerated for later ordinals.
    const openingReceipt = ctx.opening === undefined
      ? undefined
      : renderOpeningReceipt(ctx.opening, ctx.trigger);
    let accepted = 0;
    let ordinal = 0;
    for (let step = 0; step < config.policy.stepsPerTurn; step += 1) {
      // The LIVE configuration, per step: an `update_self` earlier in the turn
      // re-resolves the model (and so the window) from the next request on.
      const live = this.fold.snapshot().config?.value ?? config;
      // The window is a host fact resolved per request (A3); it also bounds the
      // usage the adapter accepts, whether or not the token trigger is armed.
      const window = this.resolveWindow(live);
      const rule = window === null || live.policy.compactAfterTokens === undefined
        ? null
        : {
          window: window.contextTokens,
          output: outputReservation(live.parameters, window.maxOutputTokens),
          policy: live.policy.compactAfterTokens as TokenTriggerPolicy,
        };
      // The pending authored survival (A5), resolved ONCE per logical request
      // after the turn-distance expiry. Every transaction this request runs
      // uses it as the effective replacement until one APPLIES — the slot is
      // then consumed (authored text or the notice fallback alike).
      let authored = this.pendingAuthoredFor(ctx.turn);
      let compacted = false;
      // The remember verb's early trigger: the FLAG is consumed HERE, at the
      // next plan site, never as a verb-time transaction. The committed surface
      // excludes the open turn, so this pre-compacts the next request.
      if (this.earlyCompact) {
        this.earlyCompact = false;
        const early = await runCompaction(this.fold, ctx.gate, {
          force: true, ...(authored !== undefined ? { authored } : {}),
        });
        if (early === 'applied') {
          this.anchor = null;
          compacted = true;
          authored = undefined;
          this.pendingAuthored = null;
        } else {
          // The escape's shape: every non-applied outcome is typed, never a
          // silent flag consumption. A pending payload stays pending — it may
          // still fill a later slot inside its expiry.
          const miss = earlyTriggerMiss(early);
          if (miss !== null) this.diagnose(miss);
        }
      }
      if (rule === null) {
        // The byte trigger (the pre-wave cells' forever path, and the windowless
        // fallback): an applied replacement rewrites the sampled surface, so the
        // anchor resets. An applied early trigger above is this request's one
        // compaction, so the routine byte transaction must not erase twice.
        if (!compacted) {
          const outcome = await runCompaction(this.fold, ctx.gate,
            authored !== undefined ? { authored } : {});
          if (outcome === 'applied') {
            this.anchor = null;
            authored = undefined;
            this.pendingAuthored = null;
          }
        }
      }
      const id: RequestId = { turn: ctx.turn, ordinal };
      // Host state, not journaled state: the notice rides the volatile queue,
      // so a new arrival never invalidates the cached prefix.
      const notice = this.options.notice?.current() ?? null;
      const assemblePlan = (): RequestPlan => assemble({
        id, state: this.fold.snapshot(),
        ...(ctx.direction !== undefined ? { direction: ctx.direction } : {}),
        ...(this.options.models !== undefined ? { models: this.options.models } : {}),
        ...(ordinal === 0 && openingReceipt !== undefined ? { opening: openingReceipt } : {}),
        ...(notice !== null ? { notice: renderConversationNotice(notice) } : {}),
      });
      let plan = assemblePlan();
      const bytes = canonicalBytes(plan).length;
      if (bytes >= MAX_CAPTURE_BYTES) {
        ctx.gate.append('request/refused', { id, bytes, limit: MAX_CAPTURE_BYTES, phase: 'plan' });
        await ctx.gate.flush();
        return {
          outcome: 'error', toolCalls: accepted > 0,
          error: { code: 'request-limit', status: null },
        };
      }
      if (rule !== null) {
        const decision = this.tokenDecision(plan, rule);
        // The domain guards: an output reservation at or above the declared
        // window — and the equivalent degenerate band a journaled rule can
        // produce — is a TYPED request refusal at the plan site, never a silent
        // assertion. Nothing is journaled: no plan was sent, and the turn's
        // closer carries the typed failure.
        if (decision.degenerate) {
          return {
            outcome: 'error', toolCalls: accepted > 0,
            error: { code: 'request-limit', status: null },
          };
        }
        if (meterFires(decision.total, decision.threshold)) {
          if (compacted) {
            // The applied early compaction is this request's one erasure: the
            // re-price reports the residual instead of firing a second one.
            this.diagnose({
              kind: 'over-window-after-compaction',
              estimate: decision.total, threshold: decision.threshold,
            });
          } else {
            const meter: MeterRecord = {
              window: rule.window,
              output: rule.output,
              headroom: decision.headroom,
              threshold: decision.threshold,
              percent: decision.percent,
              estimate: decision.total,
              anchor: decision.kind,
              outcome: 'compact',
            };
            const outcome = await runCompaction(this.fold, ctx.gate, {
              force: true, meter, ...(authored !== undefined ? { authored } : {}),
            });
            // The reset on compaction: an APPLIED replacement rewrites the sampled
            // surface, so the anchor's delta can no longer describe it — the
            // estimate stands wholesale from here. A skipped transaction changes
            // nothing, so the anchor survives it.
            if (outcome === 'applied') {
              this.anchor = null;
              authored = undefined;
              this.pendingAuthored = null;
              // ONE re-assemble and ONE re-price (the bound): the re-assembled plan
              // is what is sent, and a price still over the threshold is sent
              // anyway — a second compaction would be a second erasure for one
              // logical request. The re-price is not journaled (the transaction's
              // start record is the accounting home); when it is still over, the
              // bounded host diagnostic carries the fact to the operator.
              plan = assemblePlan();
              const repriced = this.tokenDecision(plan, rule);
              if (meterFires(repriced.total, repriced.threshold)) {
                this.diagnose({
                  kind: 'over-window-after-compaction',
                  estimate: repriced.total, threshold: repriced.threshold,
                });
              }
            } else {
              // The uncompactable escape (A4): nothing eligible, an unbalanced
              // first group, an empty span, a notice not smaller — or a stale
              // abort. The request is sent anyway under the typed policy, its only
              // accounting the bounded host diagnostic (this branch journals
              // nothing).
              this.diagnose({
                kind: 'uncompactable-over-window',
                estimate: decision.total, threshold: decision.threshold,
              });
            }
          }
        }
      }
      const sendOptions = window === null ? {} : { window: window.contextTokens };
      let sent = await this.options.adapter.send(plan, ctx.gate, sendOptions);
      if (sent.kind === 'failure' && sent.failure.code === 'context-exceeded') {
        // The overflow answer (the separable M2b slice): ONE forced maximal
        // reduction (retain 0, bypassing the threshold) and ONE resend in a NEW
        // frontier group. A second failure — or a reduction no transaction can
        // make — passes the ORIGINAL error through.
        const reduced = await runCompaction(
          this.fold, ctx.gate, {
            force: true, retainGroups: 0,
            ...(authored !== undefined ? { authored } : {}),
          });
        if (reduced === 'applied') {
          this.anchor = null;
          authored = undefined;
          this.pendingAuthored = null;
          plan = assemblePlan();
          const resent = await this.options.adapter.send(plan, ctx.gate, sendOptions);
          if (resent.kind === 'response') {
            sent = resent;
          } else if (resent.failure.code === 'cancelled') {
            // A stop that landed during the resend is a boundary cancellation,
            // never an error closer: park like every other cancelled request,
            // and never journal the original provider error over the stop.
            return { outcome: 'waiting', toolCalls: accepted > 0 };
          } else {
            // The second failure passes the ORIGINAL error through.
            return { outcome: 'error', toolCalls: accepted > 0, error: sent.failure };
          }
        } else {
          return { outcome: 'error', toolCalls: accepted > 0, error: sent.failure };
        }
      }
      if (sent.kind === 'failure') {
        // A failure the aborted signal caused is a boundary cancellation, not a
        // failed turn: park like the dispatch policy below, so a clean stop
        // never journals an error closer. Keying on the code — the adapter
        // normalizes abort-induced failures to `cancelled` — keeps a real
        // failure (a malformed body) an error even when a stop races it.
        if (sent.failure.code === 'cancelled') return { outcome: 'waiting', toolCalls: accepted > 0 };
        return { outcome: 'error', toolCalls: accepted > 0, error: sent.failure };
      }
      // Every successful send replaces the anchor: the sample journals on the
      // assistant record, and a response without a usable usage resets it to the
      // estimate — exactly what a restart re-forms from the fold.
      this.anchor = sent.accounting ?? null;
      // The CLEAR rule: the notice is consumed only by a request the kernel
      // actually sent (the exchange is journaled and answered). A failed
      // request leaves it pending and the next attempt re-renders it.
      if (notice !== null) this.options.notice?.consume(notice.version);
      const calls = sent.projection.message.tool_calls;
      this.packageGateHolder.gate = ctx.gate;
      this.flushPackageFacts(ctx.gate);
      let dispatched: {
        waited: boolean; called: number; wakeAt?: number; wakeAfterMs?: number;
      };
      try {
        dispatched = await dispatchCalls(
          sent.projection, id, ctx.gate, config, this.terminalPort,
          this.options.webTools, this.extendPort ?? undefined, ctx.now,
        );
      } finally {
        this.packageGateHolder.gate = null;
      }
      accepted += dispatched.called;
      ordinal += 1;
      if (calls.length === 0) return { outcome: 'waiting', toolCalls: accepted > 0 };
      // A stop during dispatch reconciles the group (dispatchCalls closes it) and
      // parks rather than opening another logical request.
      if (ctx.signal.aborted) return { outcome: 'waiting', toolCalls: accepted > 0 };
      if (dispatched.waited) {
        return {
          outcome: 'waiting', toolCalls: accepted > 0,
          ...(dispatched.wakeAt !== undefined ? { wakeAt: dispatched.wakeAt } : {}),
          // A relative wait is carried as a DURATION; the driver anchors it at
          // the actual park, never at this model-call/assembly point.
          ...(dispatched.wakeAfterMs !== undefined
            ? { wakeAfterMs: dispatched.wakeAfterMs } : {}),
        };
      }
    }
    return { outcome: 'chained', toolCalls: accepted > 0 };
  }
}

export function createAgentRuntime(options: RuntimeOptions): AgentRuntime {
  return new Runtime(options);
}
