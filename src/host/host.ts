import { lstat, open, stat, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultAgentConfig, validateAgentConfig } from '../context/config.js';
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
import type { LlmCredential } from './credentials.js';
import { llmCredentialFrom, loadProviderStore } from './credentials.js';
import { HostConfigError } from './errors.js';
import {
  assertCellLayout, assertHomeOutsideCheckout, assertHomePermissions, cellPaths,
} from './layout.js';
import type { HostLog } from './observe.js';
import {
  attachCell, bootHygiene, detectLaunchMode, ensureLeaf, LIMITS, limitLeaf, nodeLeaf, runLeaf,
} from './cgroups.js';
import type { CellCgroup } from './cgroups.js';
import { createFencePort } from './fence.js';
import { acquireOwner, type HostCommand, type OwnerHandle } from './owner.js';

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
  readonly pollMs?: number; readonly log: HostLog;
};

/** The composed cell: its durable parts, its live parts, and its one exit. */
export type Cell = {
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
   * The durable degraded-world sidecar read after `NodeDriver.open` (so a
   * boot-reconcile refusal is included), replayed at composition: the host
   * logs it on `host/boot` and never fabricates it from a missing file.
   */
  readonly worldState: WorldState;
  close(): Promise<void>;
};

/** The states in which closing would cut a live turn's journal. */
const UNSETTLED: ReadonlySet<string> = new Set(['active', 'waiting', 'stopping']);

/**
 * Composes one node against its cell home and returns it ready to run.
 *
 * On any failure after the frontier journal is open, the journal is closed
 * before the error is rethrown, so the home is never left locked by a cell that
 * was never returned.
 */
export async function composeCell(options: CellOptions): Promise<Cell> {
  const { home, uid, config, credential, providers, sandbox, pollMs, log } = options;
  const paths = cellPaths(home, uid);
  const world = await WorldRepo.open(paths.world, { gitDir: paths.gitDir });
  // The world doctor (C3) runs between `WorldRepo.open` (which holds no
  // closeable resource) and the frontier open, so it can act on a lock and an
  // index BEFORE any boot-reconcile commit. It never opens a writer: the
  // report is handed to `NodeDriver.open`, which writes it after `node/boot`.
  // A doctor failure is a bounded host diagnostic, never a refused boot.
  let doctor: DoctorReport | undefined;
  try {
    doctor = await runWorldDoctor(world, { home });
  } catch (err) {
    log.emit('world/doctor-failed', {
      reason: err instanceof Error ? err.name : 'Error',
    });
  }
  const frontier = await openFrontierJournal(home, {
    worldHead: () => world.headHash(), now: Date.now,
  });
  try {
    const webTools = webToolsFromProviders(providers, frontier.gate);
    const transport = new OpenAITransport({
      endpoint: credential.endpoint,
      key: credential.key,
      credentialId: credential.credentialId,
    });
    const adapter = new ProviderAdapter(transport, systemProviderPolicy, frontier.gate);
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
            }
            : {}),
        }),
        sandbox: sandbox !== false,
      }),
    });
    const driver = await NodeDriver.open(home, uid, wrapHandler(runtime.handler, log), world, {
      knownTypes: C13_EVENT_TYPES,
      hooks: runtime.hooks,
      ...(pollMs !== undefined ? { worldPollMs: pollMs } : {}),
      ...(fencePort !== undefined ? { fence: fencePort } : {}),
      ...(doctor !== undefined ? { doctor } : {}),
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
      await frontier.close();
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
      world, frontier, runtime, driver, config: effective,
      webTools: webTools !== undefined, worldState,
      fence: fencePort !== undefined ? 'available' : 'unavailable',
      close,
    };
  } catch (err) {
    await frontier.close().catch(() => {});
    throw err;
  }
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
    const hygiene = await bootHygiene(attach.root);
    if (hygiene.failed.length > 0) {
      // A leaf that survived the thaw/kill keeps a possibly frozen process on
      // disk: never boot silently over it. The names are leaf basenames, never
      // paths; the reason is bounded like every host diagnostic.
      const names = hygiene.failed.slice(0, 8).join(',');
      log.emit('host/degraded', {
        home, uid, reason: singleLine(`boot-thaw-failed: ${names}`, 200),
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
  readonly compose?: (options: CellOptions) => Promise<Cell>;
  readonly now?: () => number;
  readonly proc?: ProcessHandlersTarget;
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
async function resolveInitialConfig(options: HostOptions): Promise<AgentConfig> {
  const { home, uid, command, model, heading, charterFile } = options;
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
 * runs in the plan's order: the home checks, the config gate (a pure fold with
 * no lock, so a refused start never creates and removes an owner record), the
 * owner, the credential read, then the composition. The owner precedes the
 * credential read and compose so `pause` can target a booting host.
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
 * `HostConfigError` maps to `2` (a refused configuration), everything else to
 * `1`; `UsageError` is a CLI-only error and never reaches here. The lifetime
 * never calls `process.exit` and never rejects `done`: the caller owns the
 * process exit, and a host that cannot start is a resolved code, not a throw.
 */
export function startHost(options: HostOptions, deps: HostDeps = {}): HostHandle {
  const { home, uid, command, sandbox, pollMs, log } = options;
  let stopRequested = false;
  let faulted = false;
  let cell: Cell | null = null;
  let owner: OwnerHandle | null = null;
  let clearKeepAlive: (() => void) | null = null;
  let detach: (() => void) | null = null;

  const stop = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    cell?.driver.stop('stop-requested');
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
      const config = await resolveInitialConfig(options);
      owner = await acquireOwner(home, {
        uid, command, ...(deps.now !== undefined ? { now: deps.now } : {}),
        sandbox: sandbox === false ? 'off' : 'landlock',
      });
      // Read the launch mode before the attach moves this process into svc/.
      const launchMode = detectLaunchMode();
      const cellSandbox = await attachSandbox(home, uid, sandbox, log, deps);
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
          ...(fenceFact === 'available'
            ? {}
            : { fenceReason: sandbox === false ? 'sandbox-off' : 'no-cell-cgroup' }),
        });
      } catch {
        // The owner record is liveness metadata, not a truth artifact: a failed
        // annotate must not turn a boot into a failure. `host/boot` still
        // carries the fact and the diagnostic names the step only.
        log.emit('host/degraded', { home, uid, reason: 'owner-annotate-failed' });
      }
      const providers = await loadProviderStore(home);
      const credential = llmCredentialFrom(providers);
      cell = await (deps.compose ?? composeCell)({
        home, uid, config, credential, providers, sandbox: cellSandbox, log,
        ...(deps.fence !== undefined ? { fence: deps.fence } : {}),
        ...(pollMs !== undefined ? { pollMs } : {}),
      });
      log.emit('host/boot', {
        home, uid, command, model: cell.config.model,
        webTools: cell.webTools ? 'tavily' : 'off',
        sandbox: sandbox === false ? 'off' : 'landlock',
        launch: launchMode,
        limits: cellSandbox !== false && cellSandbox.leafLimits !== undefined
          ? 'available' : 'unavailable',
        reap: launchMode,
        // The commit fence is a host-lifetime fact, never per-commit: a host
        // that cannot fence commits unfenced and says so here.
        fence: cell.fence,
        // The replayed degraded-world sidecar, read at composition: a status
        // projection, never a second truth.
        world: cell.worldState.degraded ? 'degraded' : 'healthy',
      });
      if (stopRequested) cell.driver.stop('stop-requested');
      await cell.driver.run();
    } catch (err) {
      code = err instanceof HostConfigError ? 2 : 1;
      log.emit('host/error', {
        error: errorName(err),
        ...(err instanceof HostConfigError ? { message: err.message } : {}),
      });
    } finally {
      // Both cleanup steps can reject, and neither may replace the code the
      // failure itself earned: a host that cannot close its cell or release its
      // owner has still failed, but the journal is the record of why.
      if (cell !== null) {
        try {
          await cell.close();
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
