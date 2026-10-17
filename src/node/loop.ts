import { BlobStore, assertNodeUid } from '../journal/index.js';
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
import type { ProviderAdapter } from '../provider/adapter.js';
import type { AgentConfig, ProjectionState, RequestId } from '../context/contracts.js';
import type { BoundaryGate, DriverHooks, DurableWatermark } from './gate.js';
import type { TurnContext, TurnHandler, TurnResult } from './driver.js';
import { PtyTerminalRuntime } from './tools/terminal.js';
import type { TerminalFactory, TerminalPort, TerminalRuntime } from './tools/terminal.js';
import type { WebTools } from './tools/web.js';
import type { WorldRepo } from './world.js';

/**
 * The C1.3 agent runtime (T9): the trusted kernel handler and hook bundle that
 * turn the driver's turn ritual into real model requests and tool effects.
 *
 * It owns a `ContextFold`, presents one recorded world perception per turn,
 * assembles exactly one plan per logical request, refuses an oversize plan
 * before storage, delegates the request to the provider adapter and the
 * resulting calls to the dispatcher. It never hands the writer to
 * the model and never assembles a second message, request, artifact or state
 * shape: every fact it writes goes through the boundary gate.
 *
 * The runtime is not a confinement boundary. Raw bash can still escape the
 * world; C1.4c and C1.5 remain deferred, and `mock-model` is a test
 * fixture, not a certified provider.
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
  };
  /** Kernel-mediated web tools; when absent, offered web calls resolve as `denied`. */
  readonly webTools?: WebTools;
};

export interface AgentRuntime {
  readonly handler: TurnHandler; readonly hooks: DriverHooks;
  scheduleConfig(config: AgentConfig): void;
  snapshot(): ProjectionState;
  checkpoint(mark: DurableWatermark): Promise<void>;
}

// `defaultAgentConfig`/`validateAgentConfig` live in `src/context/config.ts` (T1)
// and are re-exported here for runtime consumers; they are never redefined.
export { defaultAgentConfig, validateAgentConfig };

/** The fixed artifact ingest ceiling; a plan at or above it is refused before storage. */
const CAPTURE_CEILING = 32 * 1024 * 1024;

/** Stop-time kill grace when no config was ever journaled (pre-ready stop). */
const FALLBACK_KILL_GRACE_MS = 200;

/** The one message a reconciled call with no durable result carries (fold algorithm 6). */
const RECONCILE_NOTICE = 'Outcome unknown after interruption; not re-executed';

class Runtime implements AgentRuntime {
  private readonly fold = new ContextFold();
  private readonly initialConfig: AgentConfig;
  /** The latest scheduled configuration, applied at the next turn start. */
  private pendingConfig: AgentConfig | null = null;
  private terminalSession: TerminalRuntime | null = null;
  private readonly terminalPort: TerminalPort;
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
      acknowledgedWorld: () => this.fold.acknowledgedWorld(),
      onStop: async (): Promise<void> => { await this.stopTerminal(); },
    };
    this.terminalPort = {
      run: (cmd, limits, signal) => this.session().run(cmd, limits, signal),
    };
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
    if (this.fold.snapshot().config === null) {
      const stored = await gate.store(this.initialConfig);
      gate.append('system/message', { version: this.initialConfig.version, value: stored });
    }
    for (const unresolved of this.fold.unresolvedCalls()) {
      gate.append('tool/result', {
        turn: unresolved.turn, request: unresolved.request, callId: unresolved.call.id,
        message: { role: 'tool', content: RECONCILE_NOTICE, tool_call_id: unresolved.call.id },
        isError: true, raw: null, failure: null, synthetic: true,
      });
    }
    if (this.fold.orphanCompactions().length > 0) await runCompaction(this.fold, gate);
    await gate.flush();
  }

  /** The one session per node, spawned lazily and respawned by its own resets. */
  private session(): TerminalRuntime {
    if (this.terminalSession === null) {
      const create = this.options.terminal.create
        ?? ((cwd, env) => new PtyTerminalRuntime(cwd, env));
      this.terminalSession = create(this.options.world.path, this.options.terminal.env);
    }
    return this.terminalSession;
  }

  /** The driver's stop tears the session down before the journal closes. */
  private async stopTerminal(): Promise<void> {
    const session = this.terminalSession;
    this.terminalSession = null;
    if (session === null) return;
    const grace = this.fold.snapshot().config?.value.policy.killGraceMs ?? FALLBACK_KILL_GRACE_MS;
    await session.dispose('driver stop', grace);
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
      if (bytes >= CAPTURE_CEILING) {
        ctx.gate.append('request/refused', { id, bytes, limit: CAPTURE_CEILING, phase: 'plan' });
        await ctx.gate.flush();
        return {
          outcome: 'error', toolCalls: accepted > 0,
          error: { code: 'request-limit', status: null },
        };
      }
      const sent = await this.options.adapter.send(plan, ctx.gate);
      if (sent.kind === 'failure') {
        return { outcome: 'error', toolCalls: accepted > 0, error: sent.failure };
      }
      const calls = sent.projection.message.tool_calls;
      const dispatched = await dispatchCalls(
        sent.projection, id, ctx.gate, config, this.terminalPort, this.options.webTools,
      );
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
