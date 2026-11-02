import { readdirSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_WAKE_BUDGET_PER_HOUR, defaultAgentConfig, validateAgentConfig,
} from '../context/config.js';
import type { AgentConfig, LlmModel } from '../context/contracts.js';
import { C13_EVENT_TYPES } from '../context/events.js';
import { ContextFold } from '../context/fold.js';
import { loadVerifiedEvents } from '../context/loader.js';
import { openFrontierJournal, type FrontierJournal } from '../frontier/index.js';
import { GATEWAY_ADDRESSEE, nodeLayout } from '../journal/index.js';
import { createPackageStore, createRunSupervisor } from '../node/packages/index.js';
import { identitySentence, stripAuthoredIdentity } from '../node/identity.js';
import { IdentityBudgetError, assertSendableIdentity } from '../node/identity-budget.js';
import { singleLine } from '../text.js';
import { readWorldState, type WorldState } from '../node/world-state.js';
import { runWorldDoctor, type DoctorReport } from '../node/world-doctor.js';
import { fileURLToPath } from 'node:url';
import {
  modelIds, modelRefusal, windowOf, windowRefusal, type ProviderRegistry,
} from '../node/tools/providers.js';
import {
  AFTER_COMPACTION_OVER_WINDOW, UNCOMPACTABLE_OVER_WINDOW,
} from '../node/loop.js';
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
import { readCharterFile } from './charter-file.js';
import type { HostLog } from './observe.js';
import {
  attachCell, bootHygiene, detectLaunchMode, ensureLeaf, LIMITS, limitLeaf, nodeLeaf, reapRunLeaf,
  runLeaf,
} from './cgroups.js';
import type { BootHygiene, CellCgroup } from './cgroups.js';
import { createFencePort } from './fence.js';
import {
  SpawnRefusedError,
  type DepartPort, type SpawnCaps, type SpawnPort, type SpawnRequest,
} from '../node/tools/extend.js';
import {
  ConversationLog, openConversationLog,
} from '../node/conversation.js';
import { ConversationWatcher } from '../node/conversation-watcher.js';
import { ChatLog } from './chat.js';
import {
  OverlayService, persistOverlayConfig, resolvePersistedOverlay,
  type OverlayConfig,
} from '../overlay/index.js';
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
   * The kernel's spawn capability (A3), when the operator declared it for this
   * node. The host passes a port only to a node whose nodes-file entry says
   * `spawn: true`; a solo flag boot grants nobody, and a composed child
   * receives one only when the requester asked for it.
   */
  readonly spawn?: SpawnPort;
  /**
   * The node's own clean end (plan §0.9): the host composes it for every node
   * over the pool, whose check-and-mark refuses the last live node.
   */
  readonly depart?: DepartPort;
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
  readonly nodes: readonly {
    readonly uid: string; readonly config: AgentConfig;
    /** The spawn port for a node whose nodes-file entry declared the grant. */
    readonly spawn?: SpawnPort;
    /** The departure port every node holds: its own clean end. */
    readonly depart?: DepartPort;
  }[];
  readonly credential: LlmCredential; readonly providers: ProviderRegistry;
  readonly sandbox: CellOptions['sandbox'];
  readonly fence?: FencePort;
  readonly storage?: StorageConfig;
  readonly doctorRunner?: CellOptions['doctorRunner'];
  readonly pollMs?: number; readonly log: HostLog;
};

/** The states in which closing would cut a live turn's journal. */
const UNSETTLED: ReadonlySet<string> = new Set(['active', 'waiting', 'stopping']);

/**
 * The pool's child-composition seam type (test-only): production is
 * `composeNode`, reached through the thunk the pool supplies.
 */
export type ChildComposeSeam = (
  options: CellOptions, compose: () => Promise<NodeCell>,
) => Promise<NodeCell>;

/** The parts one home shares across every node it runs. */
type SharedCell = {
  readonly world: WorldRepo;
  readonly frontier: FrontierJournal;
  readonly doctor: DoctorReport | undefined;
  readonly storage: StorageConfig;
  readonly storageState: StorageFact;
  /** The home's conversation stream: stateless, shared by every node's port. */
  readonly conversation: ConversationLog;
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
  // The conversation stream's stateless writer/reader, shared by every node of
  // the home; the boot repair is the host's own act (startHost), not a
  // composition side effect.
  const conversation = ConversationLog.for(home);
  return { world, frontier, doctor, storage, storageState, conversation };
}

/**
 * Composes one node on the home's shared parts. The node owns its runtime and
 * its driver; `close` stops the driver and never closes the shared journal —
 * the solo `composeCell` wrapper and the host's `CellSet` own that exit.
 */
async function composeNode(options: CellOptions, shared: SharedCell): Promise<NodeCell> {
  const { home, uid, config, credential, providers, sandbox, pollMs, log } = options;
  // The operator's served-model declaration rides the credential: the runtime
  // renders it as the plan's substrate block and the extend port lists it.
  // Absent stays absent — no block, no line, no validation.
  const models = credential.models;
  const { world, doctor, storage, storageState, conversation } = shared;
  // The conversation stream's watcher: one per home, process-lifetime, the
  // second subscription every driver's park takes beside the HEAD one. Its
  // notices are the interface's notification — host state, in memory.
  const conversationWatcher = ConversationWatcher.for(home, pollMs);
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
    ...(models !== undefined ? { models } : {}),
    notice: {
      current: () => conversationWatcher.noticeFor(uid),
      consume: (version) => { conversationWatcher.consume(uid, version); },
    },
    // The token trigger's bounded host diagnostics (A4): host state, never a
    // journal fact. The windowless fallback fires once per boot; the
    // uncompactable escape names the decision it could not serve. Neither ever
    // carries a credential or agent-authored text.
    diagnose: (diagnostic) => {
      if (diagnostic.kind === 'token-trigger-fallback') {
        log.emit('host/meter-fallback', { home, uid, reason: 'no-declared-window' });
        return;
      }
      if (diagnostic.kind === 'uncompactable-over-window') {
        // The typed escape states its policy in the log line: the request is
        // over the threshold and no transaction could reduce it.
        log.emit('host/meter-over-window', {
          home, uid, reason: UNCOMPACTABLE_OVER_WINDOW,
          estimate: diagnostic.estimate, threshold: diagnostic.threshold,
        });
        return;
      }
      // The re-price's observed outcome: reduced, still over, sent anyway.
      log.emit('host/meter-after-compaction', {
        home, uid, reason: AFTER_COMPACTION_OVER_WINDOW,
        estimate: diagnostic.estimate, threshold: diagnostic.threshold,
      });
    },
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
      ...(options.depart !== undefined ? { depart: options.depart } : {}),
      ...(models !== undefined ? { models } : {}),
      // The conversation interface, bound to this node: `from` is stamped from
      // the runtime's own uid, and the port pokes the watcher so an in-process
      // arrival wakes a parked recipient without the interval's latency.
      conversation: {
        send: async (to, text) => {
          const sent = await conversation.append(uid, to, text);
          conversationWatcher.poke();
          return sent;
        },
        thread: (n) => conversation.thread(uid, n),
      },
    }),
  });
  const driver = await NodeDriver.open(home, uid, wrapHandler(runtime.handler, log), world, {
    knownTypes: C13_EVENT_TYPES,
    hooks: runtime.hooks,
    conversation: conversationWatcher,
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
    for (const spec of options.nodes) {
      nodes.push(await composeNode(nodeOptionsOf(options, spec, spec.spawn), shared));
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
  options: CellSetOptions,
  spec: {
    readonly uid: string; readonly config: AgentConfig;
    readonly spawn?: SpawnPort; readonly depart?: DepartPort;
  },
  spawn?: SpawnPort,
): CellOptions {
  return {
    home: options.home, uid: spec.uid, config: spec.config,
    credential: options.credential, providers: options.providers,
    sandbox: options.sandbox, log: options.log,
    ...(spawn !== undefined ? { spawn } : {}),
    ...(spec.depart !== undefined ? { depart: spec.depart } : {}),
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
  /**
   * The gateway overlay's config home (O4), start-only. `gatewayCharter` is the
   * operator's absolute charter file, read once at the config gate and
   * persisted beside the model; `gatewayModel` is validated against the
   * declared catalog and defaults to its first entry. A start without
   * `gatewayCharter` runs a nodes-only host, and a resume takes the persisted
   * pair (the parser refuses both flags there).
   */
  readonly gatewayCharter?: string; readonly gatewayModel?: string;
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
  /**
   * TEST-ONLY pool child composition (the pause-mid-spawn and
   * composed-rejection cases): the pool hands the seam the child's options and
   * the production composition as a thunk. Production never sets it — no env
   * switch or CLI flag reaches it.
   */
  readonly composeChild?: ChildComposeSeam;
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
    // The kernel owns the final sentence at boot too: any authored trailing
    // identity sentence (any uid — an operator file may echo another node's)
    // is stripped before the stamp, so it never stacks.
    const base = charterFile !== undefined
      ? await readCharterFile(home, uid, charterFile)
      : defaultAgentConfig().charter;
    return validateAgentConfig({
      ...defaultAgentConfig(),
      model,
      heading,
      charter: `${stripAuthoredIdentity(base)}${identitySentence(uid)}`,
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

/**
 * The gateway overlay's configuration gate (O4).
 *
 * A start supplies it once: `--gateway-charter` is the operator's charter file,
 * read with the one charter-file discipline (regular, UTF-8, bounded, the
 * providers store refused by path and inode), and the model is
 * `--gateway-model` — validated against the declared served-model catalog,
 * defaulting to its FIRST entry; without either a model flag or a declared
 * catalog there is no model, so a gateway-bearing start refuses. Both are then
 * persisted as the home's overlay pair (`<home>/gateway.charter.md` and
 * `<home>/gateway.json`, 0600, atomic) and that pair is what a resume reads.
 *
 * A start WITHOUT `--gateway-charter` runs a nodes-only host: no overlay
 * service, no diagnostic, and records addressed to the absent `gateway`
 * accumulate in the stream under the absent-recipient rule. A resume reads the
 * persisted pair: absent means nodes-only (the overlay was never configured),
 * a damaged or partial pair is a bounded host refusal, and the persisted model
 * is NOT re-validated — it won, and may legally predate the declaration (the
 * journaled-configs-win rule the node resume follows).
 */
async function resolveGatewayOverlay(
  home: string, command: HostCommand, options: HostOptions,
  models: readonly LlmModel[] | undefined,
): Promise<OverlayConfig | null> {
  if (command !== 'start') return await resolvePersistedOverlay(home);
  const charterFile = options.gatewayCharter;
  if (charterFile === undefined) return null;
  const charter = await readCharterFile(home, options.uid, charterFile);
  // The default is the FIRST declared entry's id. The overlay has no meter and
  // no compaction, so a windowless first entry is a legitimate default here —
  // the fresh-start window refusal is scoped to the nodes.
  const model = options.gatewayModel ?? models?.[0]?.id;
  if (model === undefined) {
    throw new HostConfigError(
      'the gateway overlay needs --gateway-model: the provider store declares no'
      + ' served-model catalog, so there is no default to take',
    );
  }
  if (models !== undefined && !models.some((entry) => entry.id === model)) {
    throw new HostConfigError(modelRefusal(model, modelIds(models)));
  }
  const config: OverlayConfig = { model, charter };
  await persistOverlayConfig(home, config);
  return config;
}

/**
 * The minted-uid form: `node-<n>`. Operator-chosen uids are exempt from the
 * scan (they carry no n), so a home booted as `alice` still mints from the
 * pool and the on-disk directory set.
 */
const MINTED_UID_RE = /^node-(\d+)$/;

/** The pool's per-node record: the cell, its grant and the run the pool owns. */
type PoolNode = {
  readonly cell: NodeCell;
  readonly canSpawn: boolean;
  /** Whether the host booted this node (fault semantics differ from composed). */
  readonly booted: boolean;
  /** The run this pool started and observes; null before `startAll`/registration. */
  run: Promise<void> | null;
};

/** One pending drain: the host body's single lifetime await. */
type DrainWaiter = {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(err: unknown): void;
};

function createDrainWaiter(): DrainWaiter {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * The host's live node pool (A3): the flat roster over one home's shared world
 * and frontier. A node's end removes only that node — never the nodes it
 * composed — and the pool starts, owns and observes every run, booted and
 * composed alike.
 *
 * The pool is the host's sole lifetime anchor. The drain waiter is per call: a
 * fresh promise is created by each `drain()` call and resolves once no live
 * node remains, rejecting at the first BOOTED run's rejection; it is never
 * re-armed because the pool cannot empty while a spawn is in flight (the
 * requester awaits the call), so a settled wait is never resumed by a spawn.
 * The body's await propagates that rejection into the
 * host's existing catch (exit 1, `host/error`), and the exit `finally` then
 * stops and settles everything. A composed node's rejection ends only that node
 * (`host/ended` carries the reason) and the host keeps running while any other
 * node is live.
 *
 * `host/spawned {requester, uid}` and `host/ended {uid, reason}` are the host
 * log's lines for birth and death; the frontier journal is untouched (it
 * records kernel-mediated HTTP exchanges only, and is node-blind). A node may
 * ask for its own clean end (`extend {verb:"request_death"}`): the
 * synchronous `beginDepart` check-and-mark refuses the last live node, and
 * `depart` stops the marked node under the `self-requested` reason.
 *
 * Spawned nodes are in-memory, like a Run: their local logs survive, the pool
 * does not. A restart reaps them; the next boot's roster is the nodes file.
 */
class NodePool {
  private readonly nodes = new Map<string, PoolNode>();
  /** Registration/spawn order; the shutdown walk runs backwards over it. */
  private readonly order: string[] = [];
  /**
   * Uids a spawn has claimed and not yet registered: the synchronous
   * reservation that lets concurrent spawns mint distinct uids and count
   * against the one ceiling before either composes anything.
   */
  private readonly reservations = new Set<string>();
  /**
   * Uids whose own departure is marked (plan §0.9). A mark counts as LEAVING
   * for the last-node rule and lives until the node's run settles — `onEnd`
   * clears it, never an error path — so a granted departure cannot be
   * re-decided against a stale roster.
   */
  private readonly departures = new Set<string>();
  /** Every run the pool ever started: `close` awaits them all, settled or not. */
  private readonly runs = new Set<Promise<void>>();
  private closing = false;
  /** The first booted run's rejection; the drain rejects with it. */
  private fault: unknown = null;
  private drainWait: DrainWaiter | null = null;

  constructor(private readonly deps: {
    readonly home: string;
    readonly shared: SharedCell;
    readonly providers: ProviderRegistry;
    readonly credential: LlmCredential;
    readonly sandbox: CellOptions['sandbox'];
    readonly storage: StorageConfig;
    readonly log: HostLog;
    readonly maxNodes: number;
    readonly composeChild?: ChildComposeSeam;
  }) {}

  /**
   * Registers a node the host composed at boot. Registration happens for every
   * booted node BEFORE any run starts (`startAll`), so a first-turn spawn sees
   * the whole roster and mints over it.
   */
  addBooted(cell: NodeCell, canSpawn: boolean): void {
    this.nodes.set(cell.uid, { cell, canSpawn, booted: true, run: null });
    this.order.push(cell.uid);
  }

  /** Starts and observes every booted run, in registration order. */
  startAll(): void {
    for (const uid of this.order) {
      const node = this.nodes.get(uid);
      if (node !== undefined && node.run === null) this.start(uid, node);
    }
  }

  /** The live nodes in registration order (booted first). */
  snapshot(): readonly NodeCell[] {
    return this.order.map((uid) => this.nodes.get(uid)!.cell);
  }

  /**
   * Whether `uid` names a node this pool admits as a conversation recipient:
   * a registered live node OR one whose spawn has claimed a uid and not yet
   * registered. The reservation counts because `spawn` composes the child
   * (and the child's boot notice arms) BEFORE it registers the cell, so a
   * record already waiting for the minted uid must arm during composition.
   */
  admitsRecipient(uid: string): boolean {
    return this.nodes.has(uid) || this.reservations.has(uid);
  }

  /**
   * The host lifetime's one anchor: a fresh waiter per call, resolving when no
   * live node remains and rejecting with the first booted run's rejection. It
   * is never re-armed: the pool cannot empty while a spawn is in flight (the
   * requester awaits the call), so a settled wait is never resumed by a spawn.
   */
  drain(): Promise<void> {
    if (this.fault !== null) return Promise.reject(this.fault);
    if (this.nodes.size === 0) return Promise.resolve();
    if (this.drainWait === null) this.drainWait = createDrainWaiter();
    return this.drainWait.promise;
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
      return { available: false, nodesLeft: 0 };
    }
    return { available: true, nodesLeft: this.placesLeft() };
  }

  /** The departure port handed to a node's cell: the pool's own check-and-mark. */
  departPortFor(uid: string): DepartPort {
    return {
      beginDepart: () => this.beginDepart(uid),
      depart: () => { this.depart(uid); },
    };
  }

  /**
   * The departure check-and-mark (plan §0.9), SYNCHRONOUS by design: the
   * executor's branch calls it, appends its one result and stops the node with
   * no await in between, so two turns cannot interleave between the check and
   * the mark.
   *
   * The last live node is refused — in-flight departures count as LEAVING, so
   * a node is granted only when at least one other node stays — and the pool
   * therefore never empties through `request_death`. The mark lives until the
   * node's run settles (`onEnd` clears it), never an error path: a marked node
   * that is still finishing its turn keeps counting as leaving, so a second
   * departure cannot slip through the window between the grant and the end.
   */
  beginDepart(uid: string): boolean {
    if (!this.nodes.has(uid)) return false;
    // Already marked: this node is leaving; its stop is in flight.
    if (this.departures.has(uid)) return true;
    if (this.nodes.size - this.departures.size <= 1) return false;
    this.departures.add(uid);
    return true;
  }

  /** Fulfils a marked departure: the node stops under its own reason. */
  depart(uid: string): void {
    this.nodes.get(uid)?.cell.driver.stop('self-requested');
  }

  /**
   * Composes a child of `requesterUid` on the home's shared parts.
   *
   * The uid and a roster place are reserved synchronously, before any await:
   * two turns may spawn at once, and the reservation is what keeps their uids
   * distinct and the home inside its one ceiling. The reservation is released
   * by ONE shared, unconditional `finally` around the whole reserve-to-register
   * sequence — so a refusal, a compose failure and the closing branch all give
   * the place back.
   *
   * Order: (1) reserve; (2) compose the child's config from the requester's
   * live config; (3) compose the child cell through the test-only seam
   * (production: `composeNode`); (4) re-check `closing` — no await separates it
   * from registration, and a pause that landed mid-spawn closes the fresh cell
   * (the one path that stops and settles a composed-but-unrun cell) and throws
   * the bounded refusal, never registering a child; (5) register, start and
   * observe.
   *
   * Before the reservation, a requested model is validated against the
   * operator's declared catalog: an out-of-catalog id is a bounded teaching
   * refusal whose enumeration is budgeted whole for the renderer's clamp, and
   * a refusal never reserves a uid or a roster place. A request that names no
   * model inherits the requester's own — attenuation wins over validation —
   * even when that model is not in the catalog (the documented residual).
   *
   * The composed config is checked against the derived identity budget (the
   * plan's spawn-side admission seam) after it is composed and BEFORE any
   * composition side effect: an over-budget child is a bounded
   * `SpawnRefusedError`, so no cell directory is created, no child local log
   * exists and no `host/spawned` is emitted. The composer suffix is part of the
   * measured block, which is why a requester sitting just under the budget can
   * be refused a child that would cross it.
   */
  async spawn(
    requesterUid: string, request: SpawnRequest,
  ): Promise<{ readonly uid: string }> {
    if (this.closing) throw new SpawnRefusedError('the host is stopping');
    const requester = this.nodes.get(requesterUid);
    if (requester === undefined) {
      throw new SpawnRefusedError('the requester node is not live');
    }
    if (!requester.canSpawn) {
      throw new SpawnRefusedError('this node was not granted the spawn capability');
    }
    const catalog = this.deps.credential.models;
    if (catalog !== undefined && request.model !== undefined
      && !catalog.some((entry) => entry.id === request.model)) {
      throw new SpawnRefusedError(modelRefusal(request.model, modelIds(catalog)));
    }
    const uid = this.reserveUid(requesterUid);
    try {
      // The requester's LIVE config, not its boot snapshot: a rewrite is
      // already the identity the next child is composed from.
      const base = requester.cell.runtime.snapshot().config?.value
        ?? requester.cell.config;
      const canSpawn = request.spawn === true && requester.canSpawn;
      const config = composedChildConfig(base, uid, requesterUid, request);
      try {
        assertSendableIdentity(config, catalog);
      } catch (err) {
        if (err instanceof IdentityBudgetError) {
          throw new SpawnRefusedError(singleLine(err.message, 200));
        }
        throw err;
      }
      const options: CellOptions = {
        home: this.deps.home, uid, config,
        credential: this.deps.credential, providers: this.deps.providers,
        sandbox: this.deps.sandbox, log: this.deps.log,
        storage: this.deps.storage,
        ...(canSpawn ? { spawn: this.portFor(uid) } : {}),
        // Every node holds its own clean end — the grant is the pool's rule,
        // not a declared capability, so a composed child mirrors a booted one.
        depart: this.departPortFor(uid),
      };
      let cell: NodeCell;
      try {
        cell = await this.composeChild(options);
      } catch (err) {
        this.deps.log.emit('host/degraded', {
          home: this.deps.home, uid, reason: `spawn-failed: ${errorName(err)}`,
        });
        throw new SpawnRefusedError('the child could not be composed');
      }
      // The pause re-check and the registration share one synchronous turn: a
      // stop delivered while the child composed is caught here, never by an
      // already-passed `stopAll` walk. The whole branch is try/finally: a
      // close failure is a bounded diagnostic and is swallowed, so the
      // bounded refusal is unconditional and a booted parent's run is never
      // faulted by a raw error.
      if (this.closing) {
        try {
          await cell.close();
        } catch (err) {
          this.deps.log.emit('host/degraded', {
            home: this.deps.home, uid,
            reason: `spawn-close-failed: ${errorName(err)}`,
          });
        }
        throw new SpawnRefusedError('the host is stopping');
      }
      const node: PoolNode = { cell, canSpawn, booted: false, run: null };
      this.nodes.set(uid, node);
      this.order.push(uid);
      this.start(uid, node);
      this.deps.log.emit('host/spawned', { requester: requesterUid, uid });
      return { uid };
    } finally {
      // Only the reservation: the requester is live for the whole spawn (its
      // run awaits the call), so the pool cannot be empty here and no drain
      // can be pending — the drain is settled by `onEnd`, never by this path.
      this.reservations.delete(uid);
    }
  }

  /** Stops every live node, in reverse registration order. */
  stopAll(): void {
    this.closing = true;
    for (const uid of [...this.order].reverse()) {
      this.nodes.get(uid)?.cell.driver.stop('stop-requested');
    }
  }

  /** The host's one pool exit: stop everything, await every owned run. */
  async close(): Promise<void> {
    this.stopAll();
    await Promise.allSettled([...this.runs]);
  }

  /**
   * Starts one node's run and observes it: clean or rejecting, its settlement
   * lands in `onEnd`, which removes only that node, names the end on
   * `host/ended` and decides the host's fate (a booted rejection faults the
   * drain; a composed rejection does not).
   */
  private start(uid: string, node: PoolNode): void {
    const run = node.cell.driver.run();
    node.run = run;
    this.runs.add(run);
    void run.then(
      () => { this.onEnd(uid, null, node); },
      (err: unknown) => { this.onEnd(uid, err, node); },
    );
  }

  /**
   * A node's end: remove only that node (no cascade), journal
   * `host/ended {uid, reason}` and settle the drain. The reason is the driver's
   * own shutdown vocabulary, read through the getter, so ends the pool did not
   * initiate are named as honestly as stops.
   */
  private onEnd(uid: string, err: unknown, node: PoolNode): void {
    this.nodes.delete(uid);
    // The departure mark lives exactly as long as the node's run: the node's
    // own end clears it, never an error path.
    this.departures.delete(uid);
    const at = this.order.indexOf(uid);
    if (at !== -1) this.order.splice(at, 1);
    this.deps.log.emit('host/ended', {
      uid, reason: node.cell.driver.shutdownReason(),
    });
    if (node.booted && err !== null) this.fault ??= err;
    this.settleDrain();
  }

  /** Resolves or rejects the pending drain from the pool's own state. */
  private settleDrain(): void {
    if (this.drainWait === null) return;
    if (this.fault !== null) {
      const wait = this.drainWait;
      this.drainWait = null;
      wait.reject(this.fault);
      return;
    }
    if (this.nodes.size === 0) {
      const wait = this.drainWait;
      this.drainWait = null;
      wait.resolve();
    }
  }

  /** The home's remaining roster places (live nodes plus live reservations). */
  private placesLeft(): number {
    return Math.max(0, this.deps.maxNodes - this.nodes.size - this.reservations.size);
  }

  /**
   * Mints `node-<max-known+1>` and claims it, synchronously: the highest n in
   * the pool, its live reservations or on disk, plus one. The disk term is why
   * a uid whose cell directory already exists is never reused; the
   * synchronization is why two concurrent spawns can neither mint the same uid
   * nor both take the ceiling's last place.
   */
  private reserveUid(requesterUid: string): string {
    if (this.nodes.size + this.reservations.size >= this.deps.maxNodes) {
      throw new SpawnRefusedError(`this home already holds ${this.deps.maxNodes} nodes`);
    }
    const known = this.knownUidNumbers(requesterUid);
    let n = (known.size === 0 ? 0 : Math.max(...known)) + 1;
    while (known.has(n)) n += 1;
    const uid = `node-${n}`;
    this.reservations.add(uid);
    return uid;
  }

  /** The known minted-uid numbers: the pool, its reservations and the disk. */
  private knownUidNumbers(requesterUid: string): Set<number> {
    const known = new Set<number>();
    const add = (uid: string): void => {
      const match = MINTED_UID_RE.exec(uid);
      if (match === null) return;
      const n = Number(match[1]);
      if (Number.isSafeInteger(n)) known.add(n);
    };
    for (const uid of this.nodes.keys()) add(uid);
    for (const uid of this.reservations) add(uid);
    for (const uid of this.diskUids(requesterUid)) add(uid);
    return known;
  }

  /**
   * The on-disk node directory names: an earlier lifetime's uid must never be
   * minted again over its local log. The read is synchronous on purpose — the
   * mint's max must be computed and claimed in one turn (see `reserveUid`), so
   * the reservation happens before any await. There is no separate entry cap:
   * the directory is the home's own, one entry per node.
   */
  private diskUids(requesterUid: string): string[] {
    try {
      return readdirSync(join(this.deps.home, 'nodes'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      this.deps.log.emit('host/degraded', {
        home: this.deps.home, uid: requesterUid,
        reason: `spawn-mint: ${code ?? 'read-failed'}`,
      });
      throw new SpawnRefusedError('the child uid could not be minted');
    }
  }

  /** The one child-composition call: the test seam or the production path. */
  private composeChild(options: CellOptions): Promise<NodeCell> {
    const compose = (): Promise<NodeCell> => composeNode(options, this.deps.shared);
    return this.deps.composeChild === undefined
      ? compose() : this.deps.composeChild(options, compose);
  }
}

/**
 * The child's configuration from the requester's live one: identity fields as
 * requested, the tools and budget inherited (attenuated, never widened), and
 * the kernel's composer sentence in place of ANY authored trailing identity
 * sentence — on a derived charter and on a requested one alike.
 */
function composedChildConfig(
  base: AgentConfig, uid: string, requesterUid: string, request: SpawnRequest,
): AgentConfig {
  const authored = stripAuthoredIdentity(request.charter ?? base.charter);
  return validateAgentConfig({
    ...base,
    model: request.model ?? base.model,
    heading: request.heading ?? base.heading,
    charter: `${authored}${identitySentence(uid, requesterUid)}`,
    // Attenuation: a child can hold only what the requester holds.
    allowedTools: [...base.allowedTools],
    policy: {
      ...base.policy,
      wakeBudgetPerHour: base.policy.wakeBudgetPerHour ?? DEFAULT_WAKE_BUDGET_PER_HOUR,
    },
  });
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
  let chat: ChatLog | null = null;
  let overlay: OverlayService | null = null;
  let owner: OwnerHandle | null = null;
  let clearKeepAlive: (() => void) | null = null;
  let detach: (() => void) | null = null;

  const stop = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    for (const node of composed?.nodes ?? []) node.driver.stop('stop-requested');
    // The overlay has no turn or park to stop: aborting cancels an in-flight
    // model exchange, and the finally awaits its settled cycle.
    void overlay?.stop();
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
      // The human channel's delivery surface, opened once per host: outside the
      // world, kernel-owned, and independent of composition. A failed open is a
      // refused boot (a kernel-owned record that cannot be read is not reset).
      const openedChat = await ChatLog.open(home);
      chat = openedChat;
      // The conversation stream's boot repair — HOST-ONLY: one TAIL read under
      // the stream's own flock, truncating at most one incomplete trailing
      // fragment. A missing stream is a new cell and creates nothing; a failed
      // repair is a refused boot (a kernel-owned record that cannot be read is
      // never silently reset).
      await openConversationLog(home);
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
      // Every START is validated against the operator's declared manifest
      // here — immediately after the provider store loads, where it loads
      // today (the resolved configs are already known; no boot reorder). A
      // start on a fresh or recovered cell composes its model from the flags
      // or the nodes file, so an id the store does not serve is a
      // configuration refusal (exit 2), not a wedged first request. `resume`
      // never re-validates: its journaled config won and may predate the
      // declaration (the journaled-configs-win invariant).
      if (command === 'start') {
        const catalog = credential.models;
        if (catalog !== undefined) {
          for (const config of configs) {
            const entry = catalog.find((candidate) => candidate.id === config.model);
            if (entry === undefined) {
              throw new HostConfigError(modelRefusal(config.model, modelIds(catalog)));
            }
            // The fresh-start boot rule (A3): a START on a declared model whose
            // entry carries no window is refused with the bounded teaching
            // refusal. A RESUME never re-validates (its journaled config won and
            // may predate the declaration): the cell keeps the byte trigger.
            if (windowOf(entry) === null) {
              throw new HostConfigError(windowRefusal(config.model));
            }
          }
        }
        // The START-composition seam of the derived identity budget (plan
        // §0.5): the composed identity — heading + charter + the kernel's
        // sentence (inside the charter) + model, in canonical bytes — must be
        // strictly below `budget = min(max(C − W, IDENTITY_FLOOR), C)`, where
        // the reserve W needs the declared catalog for its substrate term.
        // This is why the check sits AFTER the provider load, and it is
        // START-ONLY: a resume's journaled config won and may legally predate
        // the budget (replay compatibility), and `validateAgentConfig` is
        // never touched (the fold re-runs it on every replay). The refusal
        // keeps the helper's bounded message, naming the measurement and the
        // bound.
        for (const config of configs) {
          try {
            assertSendableIdentity(config, catalog);
          } catch (err) {
            if (err instanceof IdentityBudgetError) throw new HostConfigError(err.message);
            throw err;
          }
        }
      }
      // The gateway overlay's config home (O4). A start supplies it from the
      // flags and persists it; a resume reads the persisted pair (or runs
      // nodes-only when the home was never configured). This is a config-gate
      // refusal (exit 2), so it sits where the other start/resume refusals do.
      const overlayConfig = await resolveGatewayOverlay(
        home, command, options, credential.models,
      );
      // The declared spawn grant: one port per node whose nodes-file entry
      // says `spawn: true` (a solo flag boot grants nobody). The port closes
      // over the pool, which exists only after the shared parts are composed;
      // a spawn call can only come from a running turn, so the pool is always
      // bound by then.
      const spawnPortFor = (uid: string): SpawnPort => ({
        spawn: async (request) => {
          if (pool === null) throw new SpawnRefusedError('the node pool is not open');
          return pool.spawn(uid, request);
        },
        caps: () => (pool === null
          ? { available: false, nodesLeft: 0 }
          : pool.caps(uid)),
      });
      // The node's own clean end: every node holds it (the grant is the pool's
      // last-node rule, not a declared capability). The pool exists only after
      // the shared parts are composed, and a call can only come from a running
      // turn, so it is bound by then — an unbound pool is an honest refusal.
      const departPortFor = (uid: string): DepartPort => ({
        beginDepart: () => (pool === null ? false : pool.beginDepart(uid)),
        depart: () => { pool?.depart(uid); },
      });
      // The composition seams are the solo cell's or the set's; both receive
      // the same validated providers/credential and the one attached sandbox.
      const sharedOptions = {
        home, credential, providers, sandbox: cellSandbox, log, storage,
        ...(deps.fence !== undefined ? { fence: deps.fence } : {}),
        ...(deps.doctorRunner !== undefined ? { doctorRunner: deps.doctorRunner } : {}),
        ...(pollMs !== undefined ? { pollMs } : {}),
      };
      if (specs.length === 1) {
        const spec = specs[0]!;
        const cell = await (deps.compose ?? composeCell)({
          ...sharedOptions, uid: spec.uid, config: configs[0]!,
          depart: departPortFor(spec.uid),
          ...(spec.spawn === true ? { spawn: spawnPortFor(spec.uid) } : {}),
        });
        composed = {
          nodes: [cell], world: cell.world, frontier: cell.frontier,
          close: () => cell.close(),
        };
      } else {
        composed = await (deps.composeSet ?? composeCellSet)({
          ...sharedOptions,
          nodes: specs.map((spec, index) => ({
            uid: spec.uid, config: configs[index]!,
            depart: departPortFor(spec.uid),
            ...(spec.spawn === true ? { spawn: spawnPortFor(spec.uid) } : {}),
          })),
        });
      }
      // The flat roster: the shared parts are known now, and every booted node
      // enters before any run starts (`startAll`, below), so a first-turn spawn
      // sees the whole roster. The grant is per entry, never implicit.
      pool = new NodePool({
        home,
        shared: {
          world: composed.world, frontier: composed.frontier,
          doctor: undefined, storage, storageState,
          conversation: ConversationLog.for(home),
        },
        providers, credential, sandbox: cellSandbox, storage, log, maxNodes: MAX_NODES,
        ...(deps.composeChild !== undefined ? { composeChild: deps.composeChild } : {}),
      });
      // The conversation's live recipients: a record addressed to a uid no live
      // (or reserved) node bears accumulates in the stream with NO notice (the
      // absent-recipient rule). The pool's reservations count, because a
      // spawned child's boot notice arms during composition, before its cell
      // is registered.
      ConversationWatcher.for(home).setRecipientFilter(
        (uid) => pool !== null && pool.admitsRecipient(uid),
      );
      for (const [index, node] of composed.nodes.entries()) {
        pool.addBooted(node, specs[index]?.spawn === true);
      }
      // The gateway overlay: a host-side single-tenant service, never a pool
      // member. Its model exchanges cross the SAME frontier through the
      // gateway's attribution view (the `gateway` actor line beside the frozen
      // envelope), and its cycle starts with exactly ONE boot cycle over the
      // backlog both windows already hold.
      if (overlayConfig !== null) {
        const gatewayFrontier = composed.frontier.attribute(GATEWAY_ADDRESSEE);
        const gatewayAdapter = new ProviderAdapter(
          new OpenAITransport({
            endpoint: credential.endpoint,
            key: credential.key,
            credentialId: credential.credentialId,
          }),
          systemProviderPolicy,
          gatewayFrontier,
        );
        overlay = new OverlayService({
          home,
          config: overlayConfig,
          chat: openedChat,
          conversation: ConversationLog.for(home),
          world: composed.world,
          send: (plan, gate) => gatewayAdapter.send(plan, gate),
          log,
          ...(pollMs !== undefined ? { pollMs } : {}),
        });
        overlay.start();
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
      // Two-phase boot: every booted node is registered (above), then the pool
      // starts and observes every run; the body then awaits the pool's drain —
      // the host lives while ANY node is live, booted or composed. A stop that
      // landed during boot is delivered here, before the await.
      pool.startAll();
      if (stopRequested) {
        for (const node of composed.nodes) node.driver.stop('stop-requested');
      }
      await pool.drain();
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
      // The overlay is stopped FIRST: its cycle writes to the frontier, so it
      // must settle while the shared journal is still open (it is not a pool
      // member — no driver, no run, nothing else owns its lifetime).
      if (overlay !== null) {
        try {
          await overlay.stop();
        } catch {
          code = 1;
        }
      }
      // The pool is closed before the frontier: every run it owns (booted and
      // composed) must settle while the shared journal is still open.
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
      if (chat !== null) {
        try {
          await chat.close();
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
