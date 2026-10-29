import { Buffer } from 'node:buffer';
import { rm } from 'node:fs/promises';
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
import { writeSnapshot } from '../context/snapshots.js';
import { dispatchCalls } from './tools/dispatch.js';
import type { ExtendPort } from './tools/extend.js';
import type { RunSupervisorEvents } from './packages/supervisor.js';
import type { ProviderAdapter } from '../provider/adapter.js';
import type { AgentConfig, ProjectionState, RequestId } from '../context/contracts.js';
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
    readonly sandbox?: false | { readonly launcherPath?: string };
  };
  /** Kernel-mediated web tools; when absent, offered web calls resolve as `denied`. */
  readonly webTools?: WebTools;
  /**
   * The extend port factory (C1.5): the loop owns the event router (it alone
   * knows which gate the current dispatch holds), the caller owns the
   * construction — the host composes the store and the supervisor (L5), tests
   * inject them. When absent, offered `extend` calls resolve as `denied`.
   */
  readonly extend?: (
    events: RunSupervisorEvents,
    ports: { readonly terminal: TerminalPort | null; readonly web: WebTools | null },
  ) => ExtendPort;
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
  /** Set by the driver's stop: a late run can never respawn a session. */
  private terminalStopped = false;
  private readonly terminalPort: TerminalPort;
  /** The extend port, built once per runtime; null resolves calls as denied. */
  private readonly extendPort: ExtendPort | null;
  /** The gate holder the package event router reads (the current dispatch's). */
  private packageGateHolder: { gate: BoundaryGate | null } = { gate: null };
  /** Flushes the queued out-of-dispatch package facts into a gate. */
  private flushPackageFacts: (gate: BoundaryGate) => void = () => {};
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
    const flushPackageFacts = (gate: BoundaryGate): void => {
      for (const fact of packageFactQueue.splice(0)) {
        gate.append(fact.type as 'package/effect', fact.data as never);
      }
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
    // absent tool is a null port, the allowedTools inheritance).
    this.extendPort = options.extend === undefined
      ? null
      : options.extend(packageEvents, {
        terminal: this.terminalPort,
        web: options.webTools ?? null,
      });
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
    this.flushPackageFacts(gate);
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
    const spec = await buildSandboxSpec({
      world: cwd,
      home: this.options.home,
      uid: this.options.uid,
      // exactOptionalPropertyTypes: an absent override, never an explicit undefined.
      ...(sandbox?.launcherPath !== undefined ? { launcherPath: sandbox.launcherPath } : {}),
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
   * The turn's logical requests. Before each one: run a committed compaction,
   * assemble, measure the canonical plan against the capture ceiling (refusing an
   * oversize plan durably before any storage or send), send through the adapter,
   * then dispatch the calls. A no-call response or an explicit wait parks; an
   * exhausted call group chains while the quantum lasts.
   */
  private async run(ctx: TurnContext): Promise<TurnResult> {
    const slot = this.fold.snapshot().config;
    if (slot === null) throw new Error('runtime: handler reached without a configuration');
    const config = slot.value;
    let accepted = 0;
    let ordinal = 0;
    for (let step = 0; step < config.policy.stepsPerTurn; step += 1) {
      await runCompaction(this.fold, ctx.gate);
      const id: RequestId = { turn: ctx.turn, ordinal };
      const plan = assemble({ id, state: this.fold.snapshot() });
      const bytes = canonicalBytes(plan).length;
      if (bytes >= MAX_CAPTURE_BYTES) {
        ctx.gate.append('request/refused', { id, bytes, limit: MAX_CAPTURE_BYTES, phase: 'plan' });
        await ctx.gate.flush();
        return {
          outcome: 'error', toolCalls: accepted > 0,
          error: { code: 'request-limit', status: null },
        };
      }
      const sent = await this.options.adapter.send(plan, ctx.gate);
      if (sent.kind === 'failure') {
        // A failure the aborted signal caused is a boundary cancellation, not a
        // failed turn: park like the dispatch policy below, so a clean stop
        // never journals an error closer. Keying on the code — the adapter
        // normalizes abort-induced failures to `cancelled` — keeps a real
        // failure (a malformed body) an error even when a stop races it.
        if (sent.failure.code === 'cancelled') return { outcome: 'waiting', toolCalls: accepted > 0 };
        return { outcome: 'error', toolCalls: accepted > 0, error: sent.failure };
      }
      const calls = sent.projection.message.tool_calls;
      this.packageGateHolder.gate = ctx.gate;
      this.flushPackageFacts(ctx.gate);
      let dispatched: { waited: boolean; called: number };
      try {
        dispatched = await dispatchCalls(
          sent.projection, id, ctx.gate, config, this.terminalPort,
          this.options.webTools, this.extendPort ?? undefined,
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
      if (dispatched.waited) return { outcome: 'waiting', toolCalls: accepted > 0 };
    }
    return { outcome: 'chained', toolCalls: accepted > 0 };
  }
}

export function createAgentRuntime(options: RuntimeOptions): AgentRuntime {
  return new Runtime(options);
}
