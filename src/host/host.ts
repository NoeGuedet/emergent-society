import { lstat, open, stat, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DEFAULT_WAKE_BUDGET_PER_HOUR, defaultAgentConfig, validateAgentConfig,
} from '../context/config.js';
import type { AgentConfig } from '../context/contracts.js';
import { C13_EVENT_TYPES } from '../context/events.js';
import { ContextFold } from '../context/fold.js';
import { loadVerifiedEvents } from '../context/loader.js';
import { openFrontierJournal, type FrontierJournal } from '../frontier/index.js';
import { nodeLayout } from '../journal/index.js';
import { createPackageStore, createRunSupervisor } from '../node/packages/index.js';
import { singleLine } from '../text.js';
import { readWorldState, type WorldState } from '../node/world-state.js';
import { runWorldDoctor, type DoctorReport } from '../node/world-doctor.js';
import { fileURLToPath } from 'node:url';
import type { ProviderRegistry } from '../node/tools/providers.js';
import { DEFAULT_TERMINAL_ENV } from '../node/tools/terminal.js';
import { webToolsFromProviders } from '../node/tools/web.js';
import {
  NodeDriver, NodeStateError, WorldRepo, createAgentRuntime,
  type AgentRuntime, type FencePort, type TurnHandler, type TurnResult,
} from '../node/index.js';
import { ProviderAdapter } from '../provider/adapter.js';
import { systemProviderPolicy } from '../provider/policy.js';
import { OpenAITransport } from '../provider/transport.js';
import {
  DEFAULT_STORAGE_POLICY, storageFact,
  type StorageConfig, type StorageFact, type StorageFree, type StoragePolicy,
  type StorageProbe, type StorageQuota,
} from '../storage.js';
import { DEFAULT_STORAGE, statfsProbe } from '../node/storage-probe.js';
import type { LlmCredential } from './credentials.js';
import { llmCredentialFrom, loadProviderStore } from './credentials.js';
import {
  assertCellLayout, assertHomeOutsideCheckout, assertHomePermissions, cellPaths,
} from './layout.js';
import type { HostLog } from './observe.js';
import {
  attachCell, bootHygiene, detectLaunchMode, ensureLeaf, LIMITS, limitLeaf, nodeLeaf, reapRunLeaf,
  runLeaf,
} from './cgroups.js';
import type { BootHygiene, CellCgroup } from './cgroups.js';
import { createFencePort } from './fence.js';
import {
  SpawnRefusedError, type SpawnCaps, type SpawnPort, type SpawnRequest,
} from '../node/tools/extend.js';
import { acquireOwner, type HostCommand, type OwnerHandle } from './owner.js';
import { MAX_NODES, readNodesFile, type NodeSpec } from './nodes.js';
import { HostAlreadyRunningError, HostConfigError } from './errors.js';
import { UnsafeWorldPathError, WorldNotARepoError } from '../node/errors.js';

/**
 * The composition root: one cell, composed in one place and in one order.
 *
 * `composeCell` walks the plan's order exactly — the world, then the cell's
 * frontier journal, then the provider transport and adapter built on that
 * journal's gate, then the runtime, then the driver — and hands back the parts
 * a host lifetime needs to steer and report. Every path in here comes from
 * `cellPaths`, so the world pair, the frontier directory and the node's local
 * log are addressed through the journal's own constructors rather than
 * re-spelled.
 *
 * The frontier journal is the cell's, not the runtime's: the host opens it
 * before anything can send, injects its gate into the adapter and the web
 * tools, and closes it only once the driver has stopped. That is why a failure
 * anywhere after the open closes the frontier before rethrowing — a cell that
 * never came to be must not leave the home locked. There is deliberately no
 * driver cleanup branch: `NodeDriver.open` already closes its own writer when
 * it fails, and nothing after a successful open can throw before the cell is
 * returned (`Cell.close` is the only later transition).
 *
 * `Cell.close` is the lifetime's single exit. Its callers share one in-flight
 * outcome: concurrent calls await the same promise, so a booting cell is
 * stopped, run and settled exactly once even when a host tears down from two
 * paths. It refuses a cell whose driver has not settled —
 * `active`/`waiting`/`stopping` means the caller did not await `run()`, and
 * closing the frontier under a live turn would cut the very journal the turn is
 * writing. That refusal is not sticky: a rejected close clears the in-flight
 * promise, so the caller's own `stop(); await run(); close()` still closes the
 * cell. A `booting` cell is stopped and awaited here — `NodeDriver.open` has
 * already journaled `node/boot`, so `run()` writes an empty `node/shutdown` and
 * releases the local writer — and the frontier is closed before the shared
 * promise resolves, so a resolved close always means the home is unlocked.
 *
 * `wrapHandler` is the driver-to-log seam: it never changes a turn's result, it
 * only records the bounded facts the operator reads (turn, trigger, outcome,
 * whether tools ran, and for a recoverable failure the failure's code and
 * status). A thrown handler is `turn/error` with the error's *name* only, and
 * the throw propagates unchanged for the driver to classify.
 *
 * The commit fence (C2) is built here, from the attached cell root and the node
 * uid, and injected into `NodeDriver.open`; a test-only `CellOptions.fence` wins
 * over it. The returned `Cell.fence` is the host-lifetime availability fact the
 * lifetime records in the owner record and on `host/boot`.
 */

/** Everything one cell needs to exist; every field is already validated. */
export type CellOptions = {
  readonly home: string; readonly uid: string;
  readonly config: AgentConfig; readonly credential: LlmCredential;
  readonly providers: ProviderRegistry;
  readonly sandbox: false | {
    readonly launcherPath?: string; readonly cgroupRoot?: string;
    readonly leafLimits?: { readonly memoryMaxBytes: number; readonly pidsMax: number };
  };
  /**
   * TEST-ONLY fence injection (the fence-off control and the driver's unit
   * suites): it wins over the production port, which is built from
   * `sandbox.cgroupRoot` when the attach succeeded. There is no production
   * switch — `HostDeps.fence` is the only other seam, and it is likewise never
   * set by the CLI.
   */
  readonly fence?: FencePort;
  /**
   * The storage circuit breaker (W0-d): the enforcement policy and the probe
   * shared by the frontier journal, the local log and the driver's turn start.
   * The host always composes it (production default, no quota); a test may
   * inject one through `HostDeps`, and a quota exists only through those
   * test-only seams (`storageQuota`, or a `storagePolicy` that carries one).
   * No env switch, no CLI flag.
   */
  readonly storage?: StorageConfig;
  /**
   * TEST-ONLY doctor runner (F-6): production is `runWorldDoctor`. A throw is
   * caught into the bounded `world/doctor-failed` diagnostic, exactly as the
   * production runner's programming-error path is.
   */
  readonly doctorRunner?: (world: WorldRepo, opts: { home: string }) => Promise<DoctorReport>;
  /**
   * The kernel's spawn capability (A3), when this node was granted it. The host
   * passes its own port only to the first booted node; every child receives one
   * only through an explicit grant.
   */
  readonly spawn?: SpawnPort;
  readonly pollMs?: number; readonly log: HostLog;
};

/** The composed cell: its durable parts, its live parts, and its one exit. */
export type Cell = {
  readonly uid: string;
  readonly world: WorldRepo; readonly frontier: FrontierJournal;
  readonly runtime: AgentRuntime; readonly driver: NodeDriver;
  /** The effective journaled config after the ready phase, not necessarily `CellOptions.config`. */
  readonly config: AgentConfig; readonly webTools: boolean;
  /**
   * Whether this cell committed under a fence: the production port was built
   * from the attached cell root or a test-only port was injected. The host
   * records this fact in the owner record and on `host/boot`; an unfenced cell
   * is a host-lifetime fact, never a per-commit one.
   */
  readonly fence: 'available' | 'unavailable';
  /**
   * The host-lifetime storage fact: `quoted` only when a quota record was
   * injected, `unquoted` for every production cell (none is detected). The host
   * records it in the owner record and on `host/boot`.
   */
  readonly storage: StorageFact;
  /**
   * The durable degraded-world sidecar read after `NodeDriver.open` (so a
   * boot-reconcile refusal is included), replayed at composition: the host
   * logs it on `host/boot` and never fabricates it from a missing file.
   */
  readonly worldState: WorldState;
  close(): Promise<void>;
};

/**
 * One node of a multi-node host: the same composed parts without the shared
 * journal it does not own. `close` stops this node only; closing the set stops
 * every node and then releases the frontier exactly once.
 */
export type NodeCell = Omit<Cell, 'frontier'>;

/** The nodes of one home composed together: one world, one frontier, N nodes. */
export type CellSet = {
  readonly home: string;
  readonly world: WorldRepo;
  readonly frontier: FrontierJournal;
  readonly nodes: readonly NodeCell[];
  close(): Promise<void>;
};

/** Everything a multi-node composition needs; each node's config is resolved. */
export type CellSetOptions = {
  readonly home: string;
  readonly nodes: readonly { readonly uid: string; readonly config: AgentConfig }[];
  readonly credential: LlmCredential; readonly providers: ProviderRegistry;
  readonly sandbox: CellOptions['sandbox'];
  readonly fence?: FencePort;
  readonly storage?: StorageConfig;
  readonly doctorRunner?: CellOptions['doctorRunner'];
  /** The spawn capability, granted to the first node of the set only. */
  readonly spawn?: SpawnPort;
  readonly pollMs?: number; readonly log: HostLog;
};

/** The states in which closing would cut a live turn's journal. */
const UNSETTLED: ReadonlySet<string> = new Set(['active', 'waiting', 'stopping']);

/** The parts one home shares across every node it runs. */
type SharedCell = {
  readonly world: WorldRepo;
  readonly frontier: FrontierJournal;
  readonly doctor: DoctorReport | undefined;
  readonly storage: StorageConfig;
  readonly storageState: StorageFact;
};

/**
 * Opens the parts one home shares across its nodes: the world repo, the one
 * world-doctor pass, the one frontier journal (whose attribution sidecar every
 * node's view writes to), and the storage seam. The journal is opened once per
 * home: under a multi-node host the single writer lock is the host's, not a
 * node's.
 */
async function openCellShared(options: CellOptions): Promise<SharedCell> {
  const { home, uid, log } = options;
  // The one storage seam for this cell: the production default (no quota) when
  // the host injected nothing. The frontier writer + gate and the driver + its
  // local writer all receive this same object, so their floors cannot drift.
  const storage = options.storage ?? DEFAULT_STORAGE;
  const storageState = storageFact(storage.policy);
  const paths = cellPaths(home, uid);
  const world = await WorldRepo.open(paths.world, { gitDir: paths.gitDir });
  // The world doctor (C3) runs between `WorldRepo.open` (which holds no
  // closeable resource) and the frontier open, so it can act on a lock and an
  // index BEFORE any boot-reconcile commit. It never opens a writer: the
  // report is handed to `NodeDriver.open`, which writes it after `node/boot`.
  // A doctor failure is a bounded host diagnostic, never a refused boot.
  let doctor: DoctorReport | undefined;
  try {
    doctor = await (options.doctorRunner ?? runWorldDoctor)(world, { home });
  } catch (err) {
    log.emit('world/doctor-failed', {
      reason: err instanceof Error ? err.name : 'Error',
    });
  }
  const frontier = await openFrontierJournal(home, {
    worldHead: () => world.headHash(), now: Date.now, storage,
  });
  return { world, frontier, doctor, storage, storageState };
}

/**
 * Composes one node on the home's shared parts. The node owns its runtime and
 * its driver; `close` stops the driver and never closes the shared journal —
 * the solo `composeCell` wrapper and the host's `CellSet` own that exit.
 */
async function composeNode(options: CellOptions, shared: SharedCell): Promise<NodeCell> {
  const { home, uid, config, credential, providers, sandbox, pollMs, log } = options;
  const { world, doctor, storage, storageState } = shared;
  const paths = cellPaths(home, uid);
  // Every mediator this node owns — the model adapter and the web tools —
  // crosses the frontier through the node's attribution view, so each begun
  // exchange carries this cell's uid in the sidecar beside the journal. The
  // gate itself stays node-blind.
  const nodeFrontier = shared.frontier.attribute(uid);
  const webTools = webToolsFromProviders(providers, nodeFrontier);
  const transport = new OpenAITransport({
    endpoint: credential.endpoint,
    key: credential.key,
    credentialId: credential.credentialId,
  });
  const adapter = new ProviderAdapter(transport, systemProviderPolicy, nodeFrontier);
  // The extend port (C1.5): the host composes the store and the supervisor
  // once per runtime over the cell's own roots. The supervisor is built
  // INSIDE the factory: its event port is the loop's router and its service
  // ports are the node's own — the allowedTools inheritance is decided here
  // (a node without a tool passes a null port, so a package's svc call
  // resolves denied).
  const store = await createPackageStore({
    home, uid, worldDir: paths.world, scratchDir: join(home, 'tmp', uid),
  });
  const cgroupRoot = sandbox !== false ? sandbox.cgroupRoot : undefined;
  // The commit fence (C2): the production port is built from the attached
  // cell root; a test-only injected port wins. Absent means this cell has no
  // fence (a degraded attach or an off cell), and `Cell.fence` tells the
  // operator-facing surfaces so — the unfenced fact is host-lifetime, never
  // a silent per-commit property.
  const fencePort = options.fence ?? (cgroupRoot !== undefined
    ? createFencePort({ root: cgroupRoot, uid, log })
    : undefined);
  const shellSandbox = sandbox === false ? false : {
    ...(sandbox.launcherPath !== undefined ? { launcherPath: sandbox.launcherPath } : {}),
    ...(cgroupRoot !== undefined ? { cgroupPath: nodeLeaf(cgroupRoot, uid) } : {}),
    ...(sandbox.leafLimits !== undefined ? { leafLimits: sandbox.leafLimits } : {}),
  };
  const runtime = createAgentRuntime({
    home, uid, world, initialConfig: config, adapter,
    terminal: { env: DEFAULT_TERMINAL_ENV, sandbox: shellSandbox },
    ...(webTools !== undefined ? { webTools } : {}),
    extend: (events, ports) => ({
      store,
      supervisor: createRunSupervisor({
        home, uid,
        sandbox: sandbox !== false,
        shellTimeoutMs: config.policy.shellTimeoutMs,
        killGraceMs: config.policy.killGraceMs,
        maxShellCaptureBytes: config.policy.maxShellCaptureBytes,
        now: () => Date.now(),
        schedule: (ms, callback) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
        terminal: config.allowedTools.includes('execute') ? ports.terminal : null,
        web: config.allowedTools.includes('web_search')
          || config.allowedTools.includes('web_fetch') ? ports.web : null,
        webAllowance: {
          search: config.allowedTools.includes('web_search'),
          fetch: config.allowedTools.includes('web_fetch'),
        },
        events,
        bootstrapPath: fileURLToPath(new URL(
          '../node/packages/run-bootstrap.js', import.meta.url,
        )),
        ...(sandbox !== false && typeof sandbox === 'object'
          && sandbox.launcherPath !== undefined
          ? { launcherPath: sandbox.launcherPath } : {}),
        ...(cgroupRoot !== undefined
          ? {
            prepareCgroupLeaf: async (runId: string): Promise<string> => {
              const leaf = runLeaf(cgroupRoot, runId);
              await ensureLeaf(leaf);
              if (sandbox !== false && sandbox.leafLimits !== undefined) {
                await limitLeaf(leaf, sandbox.leafLimits);
              }
              return leaf;
            },
            reapCgroupLeaf: (leaf: string) => reapRunLeaf(leaf),
          }
          : {}),
      }),
      sandbox: sandbox !== false,
      ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    }),
  });
  const driver = await NodeDriver.open(home, uid, wrapHandler(runtime.handler, log), world, {
    knownTypes: C13_EVENT_TYPES,
    hooks: runtime.hooks,
    ...(pollMs !== undefined ? { worldPollMs: pollMs } : {}),
    ...(fencePort !== undefined ? { fence: fencePort } : {}),
    ...(doctor !== undefined ? { doctor } : {}),
    storage,
    wakeBudgetPerHour: config.policy.wakeBudgetPerHour ?? DEFAULT_WAKE_BUDGET_PER_HOUR,
    onError: (err) => log.emit('driver/error', { error: err.name }),
    onMaintenance: () => log.emit('host/parked'),
    schedule: (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return () => { clearTimeout(timer); };
    },
  });
  // The sidecar is read AFTER the driver opened: a boot-reconcile refusal is
  // written during `open`, so composition sees the state the host actually
  // booted with (a missing file reads healthy, never fabricated).
  const worldState = await readWorldState(home);
  // The ready phase has already folded the journal during `open`, so a resume
  // reports the config the journal holds, not the one this call supplied.
  const effective = runtime.snapshot().config?.value ?? config;
  let closing: Promise<void> | null = null;
  const closeOnce = async (): Promise<void> => {
    if (driver.state === 'booting') {
      driver.stop();
      await driver.run();
    } else if (UNSETTLED.has(driver.state)) {
      throw new NodeStateError(
        `close() before run() settled: state is ${driver.state}`,
      );
    }
  };
  // One in-flight close for every caller. A rejection clears the memo, so a
  // refused close leaves the cell closable by `stop(); await run(); close()`.
  const close = (): Promise<void> => {
    if (closing === null) {
      closing = closeOnce().catch((err: unknown) => {
        closing = null;
        throw err;
      });
    }
    return closing;
  };
  return {
    world, runtime, driver, config: effective,
    uid, webTools: webTools !== undefined, worldState,
    fence: fencePort !== undefined ? 'available' : 'unavailable',
    storage: storageState,
    close,
  };
}

/**
 * Composes one node against its cell home and returns it ready to run.
 *
 * On any failure after the frontier journal is open, the journal is closed
 * before the error is rethrown, so the home is never left locked by a cell that
 * was never returned.
 */
export async function composeCell(options: CellOptions): Promise<Cell> {
  const shared = await openCellShared(options);
  let node: NodeCell;
  try {
    node = await composeNode(options, shared);
  } catch (err) {
    await shared.frontier.close().catch(() => {});
    throw err;
  }
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing === null) {
      closing = (async () => {
        await node.close();
        await shared.frontier.close();
      })().catch((err: unknown) => {
        closing = null;
        throw err;
      });
    }
    return closing;
  };
  return { ...node, frontier: shared.frontier, close };
}

/**
 * Composes several nodes on one home: one world, one doctor pass, one frontier
 * journal and its attribution sidecar, one runtime and driver per node (each
 * with its own local log, scratch leaf and cgroup leaf). `close` stops every
 * node and then closes the shared journal exactly once.
 */
export async function composeCellSet(options: CellSetOptions): Promise<CellSet> {
  const first = options.nodes[0];
  if (first === undefined) throw new Error('a cell set needs at least one node');
  const shared = await openCellShared(nodeOptionsOf(options, first));
  const nodes: NodeCell[] = [];
  try {
    for (const [index, spec] of options.nodes.entries()) {
      nodes.push(await composeNode(
        nodeOptionsOf(options, spec, index === 0 ? options.spawn : undefined), shared,
      ));
    }
  } catch (err) {
    for (const node of nodes) await node.close().catch(() => {});
    await shared.frontier.close().catch(() => {});
    throw err;
  }
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing === null) {
      closing = (async () => {
        for (const node of nodes) await node.close();
        await shared.frontier.close();
      })().catch((err: unknown) => {
        closing = null;
        throw err;
      });
    }
    return closing;
  };
  return {
    home: options.home, world: shared.world, frontier: shared.frontier, nodes, close,
  };
}

/** One node's composition options from the set's shared fields. */
function nodeOptionsOf(
  options: CellSetOptions, spec: { readonly uid: string; readonly config: AgentConfig },
  spawn?: SpawnPort,
): CellOptions {
  return {
    home: options.home, uid: spec.uid, config: spec.config,
    credential: options.credential, providers: options.providers,
    sandbox: options.sandbox, log: options.log,
    ...(spawn !== undefined ? { spawn } : {}),
    ...(options.fence !== undefined ? { fence: options.fence } : {}),
    ...(options.storage !== undefined ? { storage: options.storage } : {}),
    ...(options.doctorRunner !== undefined ? { doctorRunner: options.doctorRunner } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
  };
}

/**
 * Wraps a turn handler with the diagnostic events of §3.10.
 *
 * The result is returned unchanged and a throw is rethrown unchanged: this
 * wrapper observes, it never decides. A recoverable failure
 * (`outcome: 'error'`) is an ordinary result and adds its code and status; a
 * thrown handler adds only the error's name.
 */
export function wrapHandler(handler: TurnHandler, log: HostLog): TurnHandler {
  return async (ctx): Promise<TurnResult> => {
    log.emit('turn/start', { turn: ctx.turn, trigger: ctx.trigger });
    let result: TurnResult;
    try {
      result = await handler(ctx);
    } catch (err) {
      log.emit('turn/error', {
        turn: ctx.turn, error: err instanceof Error ? err.name : 'Error',
      });
      throw err;
    }
    if (result.outcome === 'error') {
      log.emit('turn/end', {
        turn: ctx.turn, outcome: result.outcome, toolCalls: result.toolCalls,
        errorCode: result.error.code, errorStatus: result.error.status,
      });
    } else {
      log.emit('turn/end', {
        turn: ctx.turn, outcome: result.outcome, toolCalls: result.toolCalls,
      });
    }
    return result;
  };
}

/**
 * Builds the cell's cgroup tree and moves the kernel into `svc/`, once per
 * host boot. Degrading by design: a host without cgroup v2 (or without write
 * access to its own cgroup) runs Landlock-only with one bounded diagnostic —
 * the shell never fails closed for an additive containment layer.
 */
async function attachSandbox(
  home: string,
  uid: string,
  sandbox: HostOptions['sandbox'],
  log: HostLog,
  deps: HostDeps,
): Promise<HostOptions['sandbox']> {
  if (sandbox === false) return sandbox;
  try {
    const attach = await (deps.attachToCell ?? attachCell)(home);
    if (!attach.ok) {
      log.emit('host/degraded', { home, uid, reason: attach.reason });
      return sandbox;
    }
    const hygiene = await (deps.bootHygiene ?? bootHygiene)(attach.root);
    if (hygiene.failed.length > 0) {
      // A leaf that survived the thaw/kill keeps a possibly frozen process on
      // disk: never boot silently over it. The names are leaf basenames, never
      // paths; the reason is bounded like every host diagnostic.
      const names = hygiene.failed.slice(0, 8).join(',');
      log.emit('host/degraded', {
        home, uid, reason: singleLine(`boot-thaw-failed: ${names}`, 200),
      });
    }
    if (hygiene.listError !== undefined) {
      // An unreadable cell root is not "no leaves": booting over it would skip
      // the thaw/kill entirely. The errno is bounded and carries no path.
      log.emit('host/degraded', {
        home, uid, reason: singleLine(`boot-hygiene-failed: ${hygiene.listError}`, 200),
      });
    }
    return {
      ...sandbox,
      cgroupRoot: attach.root,
      ...(attach.limits
        ? {
          leafLimits: {
            memoryMaxBytes: LIMITS.nodeMemoryMaxBytes, pidsMax: LIMITS.nodePidsMax,
          },
        }
        : {}),
    };
  } catch (err) {
    // The additive layer must never turn a boot into a failure.
    log.emit('host/degraded', {
      home, uid, reason: err instanceof Error ? err.message : String(err),
    });
    return sandbox;
  }
}

/** What one host run was asked to do; every field is the CLI's validated value. */
export type HostOptions = {
  readonly home: string; readonly uid: string; readonly command: HostCommand;
  readonly model?: string; readonly heading?: string; readonly charterFile?: string;
  /**
   * A JSON nodes file declaring the whole boot: its uids (and, on a start, each
   * model, heading and optional absolute charter file) replace the solo flags.
   * The parser refuses `--nodes-file` together with `--uid`/`--model`/`--heading`/
   * `--charter-file`; the host reads and validates the file at the config gate.
   */
  readonly nodesFile?: string;
  readonly sandbox: false | {
    readonly launcherPath?: string; readonly cgroupRoot?: string;
    readonly leafLimits?: { readonly memoryMaxBytes: number; readonly pidsMax: number };
  };
  readonly pollMs?: number; readonly log: HostLog;
};

/** The host's process-level seams; absent fields mean the production behavior. */
export type HostDeps = {
  readonly installSignals?: boolean; readonly keepAlive?: boolean;
  /** The cell-tree attach seam; production builds the cgroup tree, tests stub it. */
  readonly attachToCell?: (home: string) => Promise<CellCgroup>;
  /**
   * TEST-ONLY fence injection (the fence-off control). It wins over the
   * production port built from the attached cell root; no env switch or CLI
   * flag reaches it, so production can never run unfenced while claiming a
   * fence.
   */
  readonly fence?: FencePort;
  /**
   * TEST-ONLY storage seams (W0-d). `freeSpace` replaces the real `statfs`
   * probe, `storageQuota`/`storagePolicy` inject the quota record production
   * never has. No env switch or CLI flag reaches them.
   */
  readonly freeSpace?: StorageProbe;
  readonly storageQuota?: StorageQuota;
  readonly storagePolicy?: StoragePolicy;
  readonly compose?: (options: CellOptions) => Promise<Cell>;
  /** The multi-node composition seam: production is `composeCellSet`. */
  readonly composeSet?: (options: CellSetOptions) => Promise<CellSet>;
  readonly now?: () => number;
  readonly proc?: ProcessHandlersTarget;
  /**
   * TEST-ONLY doctor runner (F-6): injected into `composeCell`, so the
   * `world/doctor-failed` branch is reachable without a production switch.
   */
  readonly doctorRunner?: (world: WorldRepo, opts: { home: string }) => Promise<DoctorReport>;
  /**
   * TEST-ONLY boot-hygiene seam: reachable without a real cgroup tree, so both
   * bounded diagnostics (`boot-thaw-failed`, `boot-hygiene-failed`) are tested
   * without a production switch. Production is `bootHygiene` from cgroups.ts.
   */
  readonly bootHygiene?: (root: string) => Promise<BootHygiene>;
  /**
   * TEST-ONLY config-fold seam (E-5): a test can hold the boot's POST-owner
   * config-fold window open — the owner record is already acquired when it
   * runs, so a pause issued meanwhile targets this host. Production is
   * `resolveInitialConfig`.
   */
  readonly readInitialConfig?: (
    home: string, command: HostCommand, spec: NodeSpec,
  ) => Promise<AgentConfig>;
};

/** A running host: one idempotent stop and one promise that never rejects. */
export type HostHandle = { stop(): void; readonly done: Promise<number> };

/** What a signal or an unhandled rejection asks the lifetime to do. */
export type ProcessHandlers = { onStop(): void; onUnhandled(error: unknown): void };

/**
 * The slice of `process` the handlers need. It is a seam, not a second
 * implementation: production passes the real `process`, and a test passes an
 * `EventEmitter` to emit the events without touching the test runner's own.
 */
export type ProcessHandlersTarget = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
};

/**
 * Installs `SIGINT`/`SIGTERM` and `unhandledRejection` on `proc`, returning an
 * idempotent detach.
 *
 * A signal is a stop request, not an exit: the lifetime closes its cell before
 * the process ends, and a second signal is a no-op at the lifetime's own flag.
 * The rejection listener forwards the reason (first argument) only; the promise
 * itself is not inspected.
 */
export function attachProcessHandlers(
  handlers: ProcessHandlers,
  proc: ProcessHandlersTarget = process,
): () => void {
  const onSignal = (): void => { handlers.onStop(); };
  const onRejection = (...args: unknown[]): void => { handlers.onUnhandled(args[0]); };
  proc.on('SIGINT', onSignal);
  proc.on('SIGTERM', onSignal);
  proc.on('unhandledRejection', onRejection);
  let detached = false;
  return (): void => {
    if (detached) return;
    detached = true;
    proc.off('SIGINT', onSignal);
    proc.off('SIGTERM', onSignal);
    proc.off('unhandledRejection', onRejection);
  };
}

/** What the cell's local log says about its configuration. */
type CellConfigState = {
  readonly hasLog: boolean; readonly config: AgentConfig | null;
};

/**
 * The per-uid config fold the gate is built on (§3.5).
 *
 * A missing log is "nothing journaled yet"; a present one is folded exactly as
 * the context layer folds it, so the gate and the ready phase cannot disagree
 * about which config the cell holds. A corrupt or unreadable log is a
 * `HostConfigError` naming the file — the operator's only route from here is to
 * inspect (or delete) it, and `start` must not silently write a second config
 * on top of an unreadable history. The `lstat` itself is left raw: an `EACCES`
 * on the home is a failure of the environment, not a configuration refusal.
 */
async function readCellConfig(home: string, uid: string): Promise<CellConfigState> {
  const layout = nodeLayout(home, uid);
  const logPath = join(layout.dir, layout.logFile);
  try {
    await lstat(logPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hasLog: false, config: null };
    }
    throw err;
  }
  try {
    const events = await loadVerifiedEvents(home, uid, C13_EVENT_TYPES);
    const fold = new ContextFold();
    await fold.observe(events);
    return { hasLog: true, config: fold.snapshot().config?.value ?? null };
  } catch (err) {
    throw new HostConfigError(
      `cell log is unreadable or corrupt: ${logPath}; inspect it`, { cause: err },
    );
  }
}

/** The operator charter ceiling: a file this large would own every request. */
const MAX_CHARTER_BYTES = 8192;

/**
 * Reads the operator's charter file once, at the start gate. The path is the
 * operator's own (validated absolute by argv parsing) and must resolve to a
 * regular file — a FIFO, a device or a directory is refused rather than read;
 * symlinks are followed. At most `MAX_CHARTER_BYTES + 1` raw bytes are ever
 * loaded, so an oversize file is refused by its byte count, never buffered
 * whole; the bytes must be valid UTF-8 — an invalid encoding is refused, not
 * silently rewritten into replacement characters — and nothing about the file
 * is ever echoed back except its path, never its content. The providers store
 * is refused by path AND by identity: a symlink or a hardlink to it carries
 * the same inode, so the opened file's `(dev, ino)` is compared to the
 * store's before a single byte is read — the credential store must never
 * enter the journal.
 */
async function readCharterFile(home: string, uid: string, path: string): Promise<string> {
  const resolved = resolve(path);
  const { providersFile } = cellPaths(home, uid);
  if (resolved === resolve(providersFile)) {
    throw new HostConfigError(
      'refusing the providers store as a charter file; its content would be journaled');
  }
  let providersInfo;
  try {
    providersInfo = await stat(providersFile);
  } catch {
    // The store may not exist yet in a fresh home: no inode to compare then.
    providersInfo = null;
  }
  let info;
  try {
    info = await stat(resolved);
  } catch (err) {
    throw new HostConfigError(
      `could not read the charter file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!info.isFile()) {
    throw new HostConfigError(`the charter file ${path} is not a regular file`);
  }
  let handle: FileHandle;
  try {
    handle = await open(resolved, 'r');
  } catch (err) {
    throw new HostConfigError(
      `could not read the charter file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // The identity check the path check cannot give: a symlink or a hardlink
    // to the providers store has a different path but the same inode, and
    // the opened handle's own stat is the opened bytes' truth — no TOCTOU.
    const opened = await handle.stat();
    if (providersInfo !== null
      && opened.dev === providersInfo.dev && opened.ino === providersInfo.ino) {
      throw new HostConfigError(
        'refusing the providers store as a charter file; its content would be journaled');
    }
    const buffer = Buffer.alloc(MAX_CHARTER_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const { bytesRead: chunk } = await handle.read(
        buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > MAX_CHARTER_BYTES) {
      throw new HostConfigError(
        `the charter file is over ${MAX_CHARTER_BYTES} bytes; the limit is ${MAX_CHARTER_BYTES}`);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new HostConfigError(`the charter file ${path} is not valid UTF-8`);
    }
    if (text.trim() === '') throw new HostConfigError('the charter file is empty');
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * The start/resume gate, pinned by §3.5.
 *
 * `start` supplies a config only into a cell that has none; a log with a
 * durable `node/boot` but no `system/message` is the recoverable crash window
 * and is allowed. `resume` never supplies one — a `--model`/`--heading` on a
 * resume is refused rather than ignored, so an operator who expects their flags
 * to win is told the journaled config wins. `--charter-file` follows the same
 * rule: its text becomes the BASE of the composed charter — the kernel
 * appends the node's identity sentence — on any start that composes a config
 * (a fresh cell, or the boot-without-config recovery), and a resume carrying
 * it is refused; the file is read after the journaled-config refusal, so a
 * start on an already-configured cell never touches the operator's file.
 */
async function resolveNodeConfig(
  home: string, command: HostCommand, spec: NodeSpec,
): Promise<AgentConfig> {
  const { uid, model, heading, charterFile } = spec;
  const state = await readCellConfig(home, uid);
  if (command === 'start') {
    if (model === undefined || model === '') throw new HostConfigError('start requires a model');
    if (model === 'mock-model') throw new HostConfigError('start refuses the mock model');
    if (heading === undefined || heading === '') {
      throw new HostConfigError('start requires a heading');
    }
    if (state.config !== null) {
      throw new HostConfigError('cell already has a journaled configuration; use resume');
    }
    // The composed charter always carries the node's identity: "You are
    // <uid>." is the one kernel-composed sentence, appended to the factory
    // or operator base — the uid is the git author of this node's commits and
    // the self-name the wake predicate excludes (its own commits never wake
    // it), and the charter is the pinned place it lives, outside compaction.
    const base = charterFile !== undefined
      ? await readCharterFile(home, uid, charterFile)
      : defaultAgentConfig().charter;
    return validateAgentConfig({
      ...defaultAgentConfig(),
      model,
      heading,
      charter: `${base} You are ${uid}.`,
    });
  }
  if (model !== undefined || heading !== undefined) {
    throw new HostConfigError('resume takes no --model or --heading; the journaled config wins');
  }
  if (charterFile !== undefined) {
    throw new HostConfigError('resume takes no --charter-file; the journaled config wins');
  }
  if (!state.hasLog || state.config === null) {
    throw new HostConfigError('no journaled configuration; use start');
  }
  return state.config;
}

/** The spawn-tree caps: a society, not a fork bomb. */
export const MAX_SPAWN_CHILDREN = 8;
export const MAX_SPAWN_DEPTH = 3;

type PoolNode = {
  readonly cell: NodeCell;
  readonly parent: string | null;
  readonly depth: number;
  readonly canSpawn: boolean;
  /** The spawned node's run, awaited on close; null for a host-booted node. */
  readonly run: Promise<void> | null;
};

/**
 * The host's live node pool (A3): the custody tree over one home's shared
 * world and frontier. A booted node enters as a root; `spawn` composes a child
 * on the same shared parts with a kernel-minted uid, attenuates the child's
 * configuration to the parent's, and enforces the caps (8 live children per
 * node, 3 levels deep, the home's 16-node ceiling). A node's death unloads its
 * descendants in reverse spawn order (LIFO), and the host's stop unloads
 * everything deepest-first. Spawned nodes are in-memory, like a Run: their
 * local logs survive, the pool does not.
 */
class NodePool {
  private readonly nodes = new Map<string, PoolNode>();
  /** Spawn order; the unload walk runs backwards over it. */
  private readonly order: string[] = [];
  /** parent uid -> live child uids, in spawn order. */
  private readonly children = new Map<string, string[]>();
  private closing = false;

  constructor(private readonly deps: {
    readonly home: string;
    readonly shared: SharedCell;
    readonly providers: ProviderRegistry;
    readonly credential: LlmCredential;
    readonly sandbox: CellOptions['sandbox'];
    readonly storage: StorageConfig;
    readonly log: HostLog;
    readonly maxNodes: number;
  }) {}

  /** Registers a node the host composed at boot; the host runs it. */
  addBooted(cell: NodeCell, canSpawn: boolean): void {
    this.nodes.set(cell.uid, { cell, parent: null, depth: 0, canSpawn, run: null });
    this.order.push(cell.uid);
    if (canSpawn) this.children.set(cell.uid, []);
  }

  /** The live nodes in spawn order (booted first). */
  snapshot(): readonly NodeCell[] {
    return this.order.map((uid) => this.nodes.get(uid)!.cell);
  }

  /** The port handed to a node that may spawn; its caps are read live. */
  portFor(uid: string): SpawnPort {
    return {
      spawn: (request) => this.spawn(uid, request),
      caps: () => this.caps(uid),
    };
  }

  caps(uid: string): SpawnCaps {
    const node = this.nodes.get(uid);
    if (node === undefined || !node.canSpawn || this.closing) {
      return { available: false, childrenLeft: 0, nodesLeft: 0, depthLeft: 0 };
    }
    return {
      available: true,
      childrenLeft: Math.max(0, MAX_SPAWN_CHILDREN - (this.children.get(uid)?.length ?? 0)),
      nodesLeft: Math.max(0, this.deps.maxNodes - this.nodes.size),
      depthLeft: Math.max(0, MAX_SPAWN_DEPTH - node.depth),
    };
  }

  async spawn(
    parentUid: string, request: SpawnRequest,
  ): Promise<{ readonly uid: string; readonly depth: number }> {
    if (this.closing) throw new SpawnRefusedError('the host is stopping');
    const parent = this.nodes.get(parentUid);
    if (parent === undefined) throw new SpawnRefusedError('the parent node is not live');
    if (!parent.canSpawn) {
      throw new SpawnRefusedError('this node was not granted the spawn capability');
    }
    const depth = parent.depth + 1;
    if (depth > MAX_SPAWN_DEPTH) {
      throw new SpawnRefusedError(`the depth cap (${MAX_SPAWN_DEPTH}) is reached`);
    }
    const live = this.children.get(parentUid) ?? [];
    if (live.length >= MAX_SPAWN_CHILDREN) {
      throw new SpawnRefusedError(`this node already has ${MAX_SPAWN_CHILDREN} live children`);
    }
    if (this.nodes.size >= this.deps.maxNodes) {
      throw new SpawnRefusedError(`this home already holds ${this.deps.maxNodes} nodes`);
    }
    const uid = await this.mintUid();
    if (uid === null) throw new SpawnRefusedError('no free node uid is available');
    const base = parent.cell.config;
    // The identity sentence is the one kernel-composed line (the parent's was
    // composed at boot); the child's replaces it rather than stacking a second.
    const sentence = ` You are ${parentUid}.`;
    const charter = request.charter ?? (base.charter.endsWith(sentence)
      ? `${base.charter.slice(0, -sentence.length)} You are ${uid}.`
      : `${base.charter} You are ${uid}.`);
    const config = validateAgentConfig({
      ...base,
      model: request.model ?? base.model,
      heading: request.heading ?? base.heading,
      charter,
      // Attenuation: a child can hold only what the parent holds.
      allowedTools: [...base.allowedTools],
      policy: {
        ...base.policy,
        wakeBudgetPerHour: base.policy.wakeBudgetPerHour ?? DEFAULT_WAKE_BUDGET_PER_HOUR,
      },
    });
    const canSpawn = request.spawn === true && parent.canSpawn;
    let cell: NodeCell;
    try {
      cell = await composeNode({
        home: this.deps.home, uid, config,
        credential: this.deps.credential, providers: this.deps.providers,
        sandbox: this.deps.sandbox, log: this.deps.log,
        storage: this.deps.storage,
        ...(canSpawn ? { spawn: this.portFor(uid) } : {}),
      }, this.deps.shared);
    } catch (err) {
      this.deps.log.emit('host/degraded', {
        home: this.deps.home, uid, reason: `spawn-failed: ${errorName(err)}`,
      });
      throw new SpawnRefusedError('the child could not be composed');
    }
    const run = cell.driver.run();
    void run.then(() => this.onEnd(uid), () => this.onEnd(uid));
    this.nodes.set(uid, { cell, parent: parentUid, depth, canSpawn, run });
    this.order.push(uid);
    this.children.set(parentUid, [...live, uid]);
    if (canSpawn) this.children.set(uid, []);
    this.deps.log.emit('host/spawned', { parent: parentUid, uid, depth });
    return { uid, depth };
  }

  /** Stops every node deepest-first; each spawned run is awaited by `close`. */
  stopAll(): void {
    this.closing = true;
    for (const uid of [...this.order].reverse()) {
      this.nodes.get(uid)?.cell.driver.stop('stop-requested');
    }
  }

  /** The host's one pool exit: stop everything, await every spawned run. */
  async close(): Promise<void> {
    this.stopAll();
    await Promise.allSettled(
      [...this.nodes.values()].flatMap((node) => (node.run === null ? [] : [node.run])),
    );
  }

  /**
   * A node's end unloads its descendants in reverse spawn order, then drops the
   * node. A child's own end runs this again for its subtree, so the walk is
   * recursive by construction and LIFO by the spawn order.
   */
  private onEnd(uid: string): void {
    for (const child of [...(this.children.get(uid) ?? [])].reverse()) {
      this.nodes.get(child)?.cell.driver.stop('stop-requested');
    }
    this.children.delete(uid);
    this.nodes.delete(uid);
    const at = this.order.indexOf(uid);
    if (at !== -1) this.order.splice(at, 1);
  }

  /** Mints `node-<n>` for the first free n not in the pool or on disk. */
  private async mintUid(): Promise<string | null> {
    for (let n = 1; n <= this.deps.maxNodes * 4; n += 1) {
      const uid = `node-${n}`;
      if (this.nodes.has(uid)) continue;
      const dir = nodeLayout(this.deps.home, uid).dir;
      try {
        await lstat(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return uid;
        throw err;
      }
    }
    return null;
  }
}

/**
 * The host's one composition of the storage seam (W0-d): the production default
 * unless a test injects a policy or a quota record. The fact follows the
 * effective policy, so `quoted` can only ever come from an injected quota.
 */
function resolveStorage(deps: HostDeps): StorageConfig {
  const base = deps.storagePolicy ?? DEFAULT_STORAGE_POLICY;
  const policy = deps.storageQuota === undefined
    ? base
    : { ...base, quota: deps.storageQuota };
  return { policy, probe: deps.freeSpace ?? statfsProbe };
}

/** The solo boot's one node, built from the validated flags. */
function singleNodeSpec(options: HostOptions): NodeSpec {
  return {
    uid: options.uid,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.heading !== undefined ? { heading: options.heading } : {}),
    ...(options.charterFile !== undefined ? { charterFile: options.charterFile } : {}),
  };
}

/** The bounded error label: a name, never a message and never a payload. */
function errorName(err: unknown): string {
  return err instanceof Error && err.name !== '' ? err.name : 'Error';
}

/**
 * Starts one host and returns its handle; the lifetime runs in `done`.
 *
 * Signal handling and the keepalive are installed **synchronously**, before the
 * first await, because a SIGINT that arrives while the first home check is in
 * flight must still stop the host that is about to exist. Everything after that
 * runs in the plan's order: the home checks, the owner record (acquired BEFORE
 * the potentially long config fold, so a pause issued during boot targets this
 * host; a config refusal releases the record in the one `finally`), the config
 * gate, the attach, the fence/storage annotate, the credential read, then the
 * composition.
 *
 * A stop that arrives before the cell exists is remembered, not lost: after
 * composition the driver is stopped before `run()`, which replays the
 * `node/boot` the driver already wrote and journals `node/shutdown` with no
 * turn. That is the same path a signal during boot takes, so one flag covers
 * both.
 *
 * The `finally` is the single exit. It closes the cell (guarded — a refused or
 * failed close is a `1`), releases the owner (guarded — release can reject on a
 * moved or non-regular record, and a host that failed to clean up must not
 * escape with success), clears the keepalive, detaches the handlers, and emits
 * `host/stop` exactly once with the final code. `faulted` — an unhandled
 * rejection — outranks a clean run: the host still takes the graceful path, but
 * it exits `1`.
 *
 * A configuration refusal maps to `2` — `HostConfigError`, a live
 * `HostAlreadyRunningError`, and the world open/trust family
 * (`WorldNotARepoError`, `UnsafeWorldPathError`) — with its bounded typed
 * message; everything else maps to `1`. `UsageError` is a CLI-only error and
 * never reaches here. The lifetime never calls `process.exit` and never rejects
 * `done`: the caller owns the process exit, and a host that cannot start is a
 * resolved code, not a throw.
 */
export function startHost(options: HostOptions, deps: HostDeps = {}): HostHandle {
  const { home, command, sandbox, pollMs, log } = options;
  let stopRequested = false;
  let faulted = false;
  let composed: {
    readonly nodes: readonly NodeCell[];
    readonly world: WorldRepo;
    readonly frontier: FrontierJournal;
    close(): Promise<void>;
  } | null = null;
  let pool: NodePool | null = null;
  let owner: OwnerHandle | null = null;
  let clearKeepAlive: (() => void) | null = null;
  let detach: (() => void) | null = null;

  const stop = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    for (const node of composed?.nodes ?? []) node.driver.stop('stop-requested');
    pool?.stopAll();
  };
  const onUnhandled = (err: unknown): void => {
    faulted = true;
    log.emit('host/unhandled-rejection', { error: errorName(err) });
    stop();
  };

  if (deps.installSignals !== false) {
    detach = attachProcessHandlers({ onStop: stop, onUnhandled }, deps.proc);
  }
  if (deps.keepAlive !== false) {
    // A ref'd timer holds the event loop while the driver is parked between
    // turns: a parked host must stay a running process, not look exited.
    const timer = setInterval(() => {}, 60_000);
    clearKeepAlive = (): void => { clearInterval(timer); };
  }

  // The body maps every failure and guards every cleanup step, so the trailing
  // catch is unreachable defense-in-depth: `done` is contractually total.
  const done = (async (): Promise<number> => {
    let code = 0;
    try {
      await assertHomeOutsideCheckout(home);
      await assertHomePermissions(home);
      await assertCellLayout(home);
      // The boot's node set: one solo spec from the flags, or the operator's
      // nodes file. It is read before the owner record (a malformed file is an
      // exit-2 refusal that never writes one) and validated entry by entry.
      const specs: readonly NodeSpec[] = options.nodesFile === undefined
        ? [singleNodeSpec(options)]
        : await readNodesFile(options.nodesFile, command);
      const primaryUid = specs[0]!.uid;
      // The owner record comes BEFORE the long config fold: a `pause` issued
      // while the boot is still reading the journal then targets a live host
      // instead of answering "no host" and letting the start proceed. The
      // fence/storage facts are annotated after the attach (below), so a boot
      // that fails in the fold releases the record in the one `finally`.
      owner = await acquireOwner(home, {
        uid: primaryUid, command, ...(deps.now !== undefined ? { now: deps.now } : {}),
        sandbox: sandbox === false ? 'off' : 'landlock',
      });
      const configs = await Promise.all(specs.map(
        (spec) => (deps.readInitialConfig ?? resolveNodeConfig)(home, command, spec),
      ));
      const storage = resolveStorage(deps);
      const storageState = storageFact(storage.policy);
      // Read the launch mode before the attach moves this process into svc/.
      const launchMode = detectLaunchMode();
      const cellSandbox = await attachSandbox(home, primaryUid, sandbox, log, deps);
      // The fence fact is known only after the attach: an attached cell root
      // (or a test-only injected port) means this host commits fenced; an off
      // cell or a degraded attach commits unfenced and says so. It is written
      // to the owner record here, never cleared by a later successful commit,
      // and repeated on `host/boot` and in `status`.
      const fenceFact: 'available' | 'unavailable' =
        (cellSandbox !== false && cellSandbox.cgroupRoot !== undefined)
          || deps.fence !== undefined
          ? 'available' : 'unavailable';
      try {
        await owner.annotate({
          fence: fenceFact,
          storage: storageState,
          ...(fenceFact === 'available'
            ? {}
            : { fenceReason: sandbox === false ? 'sandbox-off' : 'no-cell-cgroup' }),
        });
      } catch {
        // The owner record is liveness metadata, not a truth artifact: a failed
        // annotate must not turn a boot into a failure. `host/boot` still
        // carries the fact and the diagnostic names the step only.
        log.emit('host/degraded', { home, uid: primaryUid, reason: 'owner-annotate-failed' });
      }
      // One boot-time storage probe: an unreadable reading is a bounded
      // diagnostic, never a refusal, and never changes the quota fact.
      let bootFree: StorageFree | null;
      try {
        bootFree = await storage.probe(home);
      } catch {
        bootFree = null;
      }
      if (bootFree === null) {
        log.emit('host/degraded', { home, uid: primaryUid, reason: 'storage-probe' });
      }
      const providers = await loadProviderStore(home);
      const credential = llmCredentialFrom(providers);
      // The root's spawn capability: a closure over the pool, which exists only
      // after the shared parts are composed. A spawn call can only come from a
      // running turn, so the pool is always bound by then.
      const rootSpawn: SpawnPort = {
        spawn: async (request) => {
          if (pool === null) throw new SpawnRefusedError('the node pool is not open');
          return pool.spawn(primaryUid, request);
        },
        caps: () => (pool === null
          ? { available: false, childrenLeft: 0, nodesLeft: 0, depthLeft: 0 }
          : pool.caps(primaryUid)),
      };
      // The composition seams are the solo cell's or the set's; both receive
      // the same validated providers/credential and the one attached sandbox.
      const sharedOptions = {
        home, credential, providers, sandbox: cellSandbox, log, storage,
        ...(deps.fence !== undefined ? { fence: deps.fence } : {}),
        ...(deps.doctorRunner !== undefined ? { doctorRunner: deps.doctorRunner } : {}),
        ...(pollMs !== undefined ? { pollMs } : {}),
      };
      if (specs.length === 1) {
        const cell = await (deps.compose ?? composeCell)({
          ...sharedOptions, uid: specs[0]!.uid, config: configs[0]!, spawn: rootSpawn,
        });
        composed = {
          nodes: [cell], world: cell.world, frontier: cell.frontier,
          close: () => cell.close(),
        };
      } else {
        composed = await (deps.composeSet ?? composeCellSet)({
          ...sharedOptions, spawn: rootSpawn,
          nodes: specs.map((spec, index) => ({ uid: spec.uid, config: configs[index]! })),
        });
      }
      // The custody pool: the shared parts are known now, and the booted nodes
      // enter as roots. Only the first booted node carries the spawn grant; the
      // others receive it only if the operator's file/root grants one — no
      // implicit grant exists.
      pool = new NodePool({
        home,
        shared: {
          world: composed.world, frontier: composed.frontier,
          doctor: undefined, storage, storageState,
        },
        providers, credential, sandbox: cellSandbox, storage, log, maxNodes: MAX_NODES,
      });
      for (const [index, node] of composed.nodes.entries()) {
        pool.addBooted(node, index === 0);
      }
      for (const node of composed.nodes) {
        log.emit('host/boot', {
          home, uid: node.uid, command, model: node.config.model,
          webTools: node.webTools ? 'tavily' : 'off',
          sandbox: sandbox === false ? 'off' : 'landlock',
          launch: launchMode,
          limits: cellSandbox !== false && cellSandbox.leafLimits !== undefined
            ? 'available' : 'unavailable',
          reap: launchMode,
          // The commit fence is a host-lifetime fact, never per-commit: a host
          // that cannot fence commits unfenced and says so here.
          fence: node.fence,
          // The storage fact: no quota is ever detected, so production is
          // `unquoted`; `quoted` exists only through the test seam.
          storage: node.storage,
          // The replayed degraded-world sidecar, read at composition: a status
          // projection, never a second truth.
          world: node.worldState.degraded ? 'degraded' : 'healthy',
        });
      }
      if (stopRequested) {
        for (const node of composed.nodes) node.driver.stop('stop-requested');
      }
      await Promise.all(composed.nodes.map((node) => node.driver.run()));
    } catch (err) {
      // A usage/config refusal is exit 2, matching AGENTS: the host's own
      // configuration classes plus the world open/trust family (a legacy or
      // tampered world is a configuration refusal, not a runtime failure).
      // Those typed messages are bounded by the log (200 code points) and carry
      // the migration recipe's opening or the blocking pid/uid.
      const configRefusal = err instanceof HostConfigError
        || err instanceof HostAlreadyRunningError
        || err instanceof WorldNotARepoError
        || err instanceof UnsafeWorldPathError;
      code = configRefusal ? 2 : 1;
      log.emit('host/error', {
        error: errorName(err),
        ...(configRefusal && err instanceof Error ? { message: err.message } : {}),
      });
    } finally {
      // Both cleanup steps can reject, and neither may replace the code the
      // failure itself earned: a host that cannot close its cell or release its
      // owner has still failed, but the journal is the record of why.
      // The pool is closed before the frontier: its spawned runs must settle
      // (deepest-first) while the shared journal is still open.
      if (pool !== null) {
        try {
          await pool.close();
        } catch {
          code = 1;
        }
      }
      if (composed !== null) {
        try {
          await composed.close();
        } catch {
          code = 1;
        }
      }
      if (owner !== null) {
        try {
          await owner.release();
        } catch {
          code = 1;
        }
      }
      clearKeepAlive?.();
      detach?.();
      log.emit('host/stop', { code: faulted ? 1 : code });
    }
    return faulted ? 1 : code;
  })().catch(() => 1);

  return { stop, done };
}
