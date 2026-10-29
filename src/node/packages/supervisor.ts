import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteFile, ensureDurableDirectory, readFileOrNull, sha256HexOf, syncPath,
} from '../../journal/index.js';
import { nodeDir } from '../../journal/index.js';
import {
  buildRunSandboxSpec, probeSandbox, SandboxUnavailableError,
} from '../tools/sandbox.js';
import type { TerminalPort } from '../tools/terminal.js';
import type { WebTools } from '../tools/web.js';
import {
  MAX_ERROR_DETAIL_BYTES, MAX_FRAME_BYTES, PACKAGE_READY_TIMEOUT_MS,
} from './constants.js';
import {
  FrameDecoder, writeFrame, type ProtocolFrame,
} from './protocol.js';
import type { DeclaredTool, RegisteredTool, RegistrationVerdict } from './registry.js';
import { createRunRegistry } from './registry.js';

/**
 * The confined Run supervisor (kernel.md, the sandbox and local-log sections):
 * the kernel-side half of the facade — it spawns the child through the
 * vendored launcher under the Run policy, drives the protocol, owns the
 * deadlines, and tears down fail-closed.
 *
 * Invariants this module owns:
 * - **Verify-then-use** — the kernel writes `package.js` from the stored
 *   bytes and passes the source digest in argv; the child refuses to
 *   evaluate a single guest byte on any mismatch.
 * - **The one-run slot is reserved synchronously** — a second concurrent
 *   start refuses `busy` before any leaf exists, and every failure path
 *   reaps the leaf it created.
 * - **Deadlines** — `run/ready` within `PACKAGE_READY_TIMEOUT_MS`, one
 *   invoke within `shellTimeoutMs` (its svc calls included); both are
 *   injected-clock deadlines, a blown deadline tears the Run down, and the
 *   slot reopens synchronously with the refusal.
 * - **The drain rule** — child exit starts teardown, but an in-flight
 *   invoke's verdict waits for stdout EOF: a child that emits its last
 *   `tool/result` then exits closes `ok`, never crashed. Every child stream
 *   and the process itself carry error handlers; EPIPE after kill is expected.
 * - **Crash facts are honest** — a kernel-initiated teardown (a stop, a
 *   blown deadline, a protocol refusal) never also journals a `crashed`
 *   fact: only a child that died on its own does.
 * - **Disposal completes kernel-side** — unregister, then `run/dispose`
 *   issued fire-and-forget (never awaited: a child that fills the pipe and
 *   stops reading cannot stall it), then a `killGraceMs` grace, then
 *   SIGKILL. A failure teardown skips the grace: the contract is broken.
 *
 * What this module never does: inherit `process.env` (the child env is
 * exactly `{HOME, TMPDIR}`, both the leaf), grant the world or the home,
 * journal a source byte or a command text (the `package/service` event is
 * digest-only), send an unbounded frame (svc results are bounded to the
 * frame cap), or trust the child's own good behavior — the kernel-side
 * frame validation is the boundary.
 */

/** The supervisor's outbound ports: its journaled facts and the registry's. */
export type RunSupervisorEvents = {
  readonly effect: (payload: {
    readonly id: string; readonly runId: string;
    readonly kind: 'tool-registered'; readonly tool: string;
  }) => void;
  readonly error: (payload: {
    readonly id: string; readonly runId: string | null;
    readonly code: 'corrupt' | 'crashed' | 'timeout' | 'protocol';
    readonly detail: string;
  }) => void;
  readonly service: (payload: {
    readonly id: string; readonly runId: string;
    readonly service: 'execute' | 'web_search' | 'web_fetch';
    readonly subjectHash: string; readonly ok: boolean; readonly status: string;
  }) => void;
};

/** The injected supervisor inputs; null ports are the allowedTools inheritance. */
export type RunSupervisorDeps = {
  readonly home: string;
  readonly uid: string;
  /** The loud opt-out: an unconfined child, honestly reported by inspect. */
  readonly sandbox: boolean;
  readonly shellTimeoutMs: number;
  readonly killGraceMs: number;
  /** The node's own shell capture bound — svc/execute inherits the same limit. */
  readonly maxShellCaptureBytes: number;
  readonly now: () => number;
  /** Schedules a deadline; returns its cancel handle. Tests inject a manual clock. */
  readonly schedule: (ms: number, callback: () => void) => () => void;
  /** The node's own confined terminal, or null when `execute` is not allowed. */
  readonly terminal: TerminalPort | null;
  /** The node's own web tools, or null when neither web tool is allowed. */
  readonly web: WebTools | null;
  readonly events: RunSupervisorEvents;
  /** The bootstrap artifact; default is the compiled sibling, tests pass the .ts source. */
  readonly bootstrapPath?: string;
  readonly launcherPath?: string;
};

/** The compiled bootstrap beside this module; tests inject the .ts source. */
const DEFAULT_BOOTSTRAP = fileURLToPath(new URL('./run-bootstrap.js', import.meta.url));

/** The bootstrap's declared exit codes (the contract the child half owns). */
const EXIT_DIGEST_MISMATCH = 1;
const EXIT_BAD_DECLARATION = 3;

/**
 * The svc-result budget: a service result frame must fit the protocol's
 * line cap with headroom for its envelope, so an oversized capture is
 * truncated with a marker instead of silently failing the write.
 */
const SVC_RESULT_BUDGET_BYTES = MAX_FRAME_BYTES - 4096;

/** The stderr ring the failure diagnostics read from. */
const MAX_STDERR_CAPTURE = 64 * 1024;

/** The verdict of one start: the declared surface, or a typed refusal. */
export type StartRunVerdict =
  | { readonly ok: true; readonly runId: string; readonly tools: readonly RegisteredTool[] }
  | ({ readonly ok: false } & (
    | { readonly code: 'busy' }
    | { readonly code: 'spawn-failed'; readonly detail: string }
    | { readonly code: 'timeout' }
    | { readonly code: 'crashed'; readonly detail: string }
    | { readonly code: 'invalid-registration'; readonly detail: string }
    | { readonly code: 'name-conflict'; readonly names: readonly string[] }
  ));

/** The outcome of one funneled invoke, as the L4 handler maps it. */
export type InvokeVerdict =
  | { readonly status: 'ok'; readonly result: unknown }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'crashed' }
  | { readonly status: 'timeout' };

interface LiveRun {
  readonly runId: string;
  readonly packageId: string;
  readonly leaf: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly decoder: FrameDecoder;
  readonly invokeGuard: Guard;
  readonly svcGuard: Guard;
  readonly startedAt: number;
  stdoutClosed: boolean;
  exited: boolean;
  /** A failure teardown has begun (grace skipped; the contract is broken). */
  disposed: boolean;
  /** The kernel initiated this teardown: the exit is not a crash fact. */
  kernelStopped: boolean;
  /** The ready frame was accepted — post-ready exits are crash facts. */
  readied: boolean;
  startResolve: ((verdict: StartRunVerdict) => void) | null;
  invoke: {
    readonly callId: string;
    readonly settle: (verdict: InvokeVerdict) => void;
    readonly cancel: () => void;
  } | null;
  cancelReady: () => void;
}

/** The one-in-flight guard of one direction, in the supervisor's own shape. */
interface Guard {
  begin(id: string): boolean;
  settle(id: string): boolean;
}

function makeGuard(): Guard {
  let pending: string | null = null;
  return {
    begin(id: string): boolean {
      if (pending !== null) return false;
      pending = id;
      return true;
    },
    settle(id: string): boolean {
      if (pending !== id) return false;
      pending = null;
      return true;
    },
  };
}

/** Sanitized, bounded detail: control characters folded, capped by UTF-8 bytes. */
function boundDetail(text: string): string {
  const cleaned = text.replace(/[^\n\t\x20-\x7e\u00a0-\ufffd]/g, ' ');
  const bytes = Buffer.from(cleaned, 'utf8');
  if (bytes.length <= MAX_ERROR_DETAIL_BYTES) return cleaned;
  return bytes.subarray(0, MAX_ERROR_DETAIL_BYTES).toString('utf8');
}

/** Truncates a UTF-8 string to a byte budget, marking the cut. */
function truncateBytes(text: string, budget: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= budget) return text;
  return `${bytes.subarray(0, budget).toString('utf8')}…[truncated]`;
}

/**
 * Builds the supervisor over the injected ports. One instance owns the one
 * Run slot (`MAX_CONCURRENT_RUNS_PER_NODE = 1`); the registry is created
 * internally (its `effect` port rides the injected events) and exposed for
 * the funnel's dispatch-time lookup and L5's boot re-mount.
 */
export function createRunSupervisor(deps: RunSupervisorDeps): {
  startRun(packageId: string, source: Buffer): Promise<StartRunVerdict>;
  invokeTool(tool: RegisteredTool, args: unknown): Promise<InvokeVerdict>;
  /** Kernel-side disposal: unregister, notify fire-and-forget, grace, SIGKILL. */
  stopRun(): Promise<void>;
  readonly registry: {
    registerRun: (
      packageId: string, runId: string, declared: readonly DeclaredTool[],
    ) => RegistrationVerdict;
    unregisterRun: (runId: string) => void;
    lookup: (name: string) => RegisteredTool | null;
    tools: () => readonly RegisteredTool[];
    liveRunId: () => string | null;
  };
  liveRunId(): string | null;
  isIdle(): boolean;
} {
  const registry = createRunRegistry({ effect: deps.events.effect });
  const runsDir = join(nodeDir(deps.home, deps.uid), 'runs');
  const bootstrapSource = deps.bootstrapPath ?? DEFAULT_BOOTSTRAP;
  // Location-independent delivery: the leaf copy carries an explicit .mjs
  // (compiled) or .mts (type-stripped test source) extension, so Node never
  // walks ancestors for a package.json to decide the module type — an
  // ancestor the Run cannot read would kill the child before it starts.
  const bootstrapBase = bootstrapSource.split('/').pop() ?? 'run-bootstrap.js';
  if (bootstrapBase !== 'run-bootstrap.js' && bootstrapBase !== 'run-bootstrap.ts') {
    throw new Error(
      `the Run bootstrap must be run-bootstrap.js or run-bootstrap.ts, not ${bootstrapBase}`);
  }
  const bootstrapName = bootstrapBase.endsWith('.ts')
    ? 'run-bootstrap.mts' : 'run-bootstrap.mjs';

  let live: LiveRun | null = null;
  /** The synchronous slot reservation: a concurrent start refuses busy. */
  let starting = false;

  /** The failure path: the contract is broken — no grace, straight to SIGKILL. */
  function teardown(run: LiveRun): void {
    if (run.disposed) return;
    run.disposed = true;
    run.kernelStopped = true;
    run.cancelReady();
    registry.unregisterRun(run.runId);
    try { run.child.kill('SIGKILL'); } catch { /* already dead */ }
  }

  async function reapLeaf(leaf: string): Promise<void> {
    await rm(leaf, { recursive: true, force: true }).catch(() => {});
    await syncPath(dirname(leaf)).catch(() => {});
  }

  /** Frees the slot if this run still owns it. */
  function releaseSlot(run: LiveRun): void {
    if (live === run) live = null;
  }

  /**
   * The drain rule: the verdicts wait for BOTH exit and stdout EOF. A
   * pre-ready exit resolves the start refusal; a post-ready CHILD-INITIATED
   * exit appends the crash fact — a kernel-initiated teardown never does —
   * and settles the in-flight invoke as crashed.
   */
  function onDrained(run: LiveRun, code: number | null, stderr: string): void {
    const startResolve = run.startResolve;
    run.startResolve = null;
    if (startResolve !== null) {
      if (code === 125) {
        startResolve({ ok: false, code: 'spawn-failed', detail: boundDetail(stderr) });
      } else if (code === EXIT_BAD_DECLARATION) {
        startResolve({ ok: false, code: 'invalid-registration', detail: boundDetail(stderr) });
      } else if (code === EXIT_DIGEST_MISMATCH) {
        // The child refused its own package.js: no guest byte ran.
        startResolve({
          ok: false, code: 'crashed',
          detail: 'the child refused package.js: the source digest did not match',
        });
      } else {
        startResolve({ ok: false, code: 'crashed', detail: boundDetail(stderr) });
      }
      void reapLeaf(run.leaf);
      releaseSlot(run);
      return;
    }
    const invoke = run.invoke;
    run.invoke = null;
    // Capture the kernel-initiated status BEFORE the teardown marks it: the
    // crash fact belongs to a child that died on its own.
    const kernelInitiated = run.kernelStopped;
    teardown(run);
    if (run.readied && !kernelInitiated && code !== 0 && code !== null
      && code !== EXIT_DIGEST_MISMATCH) {
      deps.events.error({
        id: run.packageId, runId: run.runId, code: 'crashed',
        detail: boundDetail(stderr),
      });
    }
    invoke?.settle({ status: 'crashed' });
    void reapLeaf(run.leaf);
    releaseSlot(run);
  }

  return {
    registry,
    liveRunId: () => live?.runId ?? null,
    isIdle: () => live === null && !starting,

    async startRun(packageId: string, source: Buffer): Promise<StartRunVerdict> {
      // MAX_CONCURRENT_RUNS_PER_NODE = 1: the slot is reserved
      // synchronously, so a concurrent start refuses before any leaf or
      // child exists.
      if (live !== null || starting) return { ok: false, code: 'busy' };
      starting = true;
      try {
        const runId = randomBytes(16).toString('hex');
        const leaf = join(runsDir, runId);
        const bootstrapBytes = await readFileOrNull(bootstrapSource);
        if (bootstrapBytes === null) {
          return {
            ok: false, code: 'spawn-failed',
            detail: `the Run bootstrap ${bootstrapSource} is missing`,
          };
        }
        const sourceSha = sha256HexOf(source);

        // The leaf is kernel-created and shell-invisible; the bootstrap and
        // the hash-verified source are its only delivery path (dist/ is
        // unreadable under confinement). Any pre-spawn failure reaps it.
        const bootstrapLeaf = join(leaf, bootstrapName);
        const packageLeaf = join(leaf, 'package.js');
        let program: string;
        let argv: readonly string[];
        let env: { readonly HOME: string; readonly TMPDIR: string };
        try {
          await ensureDurableDirectory(leaf, deps.home);
          await atomicWriteFile(bootstrapLeaf, bootstrapBytes);
          await atomicWriteFile(packageLeaf, source);
          await syncPath(leaf);
          const interpreter = await realpath(process.execPath);
          const runArgs = [packageId, sourceSha, packageLeaf, join(leaf, 'output.log')];
          if (deps.sandbox) {
            const spec = await buildRunSandboxSpec({
              home: deps.home, uid: deps.uid, runLeaf: leaf, interpreterPath: interpreter,
              ...(deps.launcherPath !== undefined ? { launcherPath: deps.launcherPath } : {}),
            });
            await probeSandbox(spec);
            program = spec.launcherPath;
            argv = [...spec.grantArgs, '--', interpreter, bootstrapLeaf, ...runArgs];
            env = spec.env;
          } else {
            program = interpreter;
            argv = [bootstrapLeaf, ...runArgs];
            env = { HOME: leaf, TMPDIR: leaf };
          }
        } catch (err) {
          await reapLeaf(leaf);
          const detail = err instanceof SandboxUnavailableError
            ? err.message
            : err instanceof Error ? err.message : String(err);
          return { ok: false, code: 'spawn-failed', detail: boundDetail(detail) };
        }

        const child = spawn(program, [...argv], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // Constructed from nothing — never filtered `process.env`; the
          // allowlist is exactly the two leaf paths, so NODE_OPTIONS and
          // NODE_PATH are absent by construction.
          env: { HOME: env.HOME, TMPDIR: env.TMPDIR },
        }) as ChildProcessWithoutNullStreams;

        const run: LiveRun = {
          runId, packageId, leaf, child,
          decoder: new FrameDecoder(),
          invokeGuard: makeGuard(), svcGuard: makeGuard(),
          startedAt: deps.now(),
          stdoutClosed: false, exited: false, disposed: false,
          kernelStopped: false, readied: false,
          startResolve: null, invoke: null,
          cancelReady: () => {},
        };
        live = run;

        let stderrText = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderrText += chunk;
          if (stderrText.length > MAX_STDERR_CAPTURE) {
            stderrText = stderrText.slice(-MAX_STDERR_CAPTURE);
          }
        });
        child.stderr.on('error', () => { /* EPIPE-class: expected after kill */ });
        child.stdout.on('data', (chunk: Buffer) => {
          for (const outcome of run.decoder.push(chunk)) {
            onFrame(run, outcome);
          }
        });
        child.stdout.on('end', () => {
          run.stdoutClosed = true;
          if (run.exited) onDrained(run, child.exitCode, stderrText);
        });
        child.stdout.on('error', () => { /* EPIPE-class: the drain rule owns the verdict */ });
        child.stdin.on('error', () => { /* EPIPE after kill is expected */ });
        // An async spawn failure (ENOENT-class) resolves as spawn-failed; it
        // never crashes the kernel process.
        child.on('error', (err) => {
          const resolve = run.startResolve;
          run.startResolve = null;
          run.exited = true;
          run.stdoutClosed = true;
          teardown(run);
          resolve?.({
            ok: false, code: 'spawn-failed',
            detail: boundDetail(err instanceof Error ? err.message : String(err)),
          });
          run.invoke?.settle({ status: 'crashed' });
          run.invoke = null;
          void reapLeaf(run.leaf);
          releaseSlot(run);
        });
        child.on('exit', (code) => {
          run.exited = true;
          if (run.stdoutClosed) onDrained(run, code, stderrText);
        });

        run.cancelReady = deps.schedule(PACKAGE_READY_TIMEOUT_MS, () => {
          if (live !== run || run.exited || run.readied) return;
          const resolve = run.startResolve;
          run.startResolve = null;
          teardown(run);
          // The refusal means the Run no longer exists: the slot reopens
          // synchronously, never at the killed child's leisure.
          releaseSlot(run);
          deps.events.error({
            id: packageId, runId, code: 'timeout',
            detail: 'the child sent no run/ready within the ready deadline',
          });
          resolve?.({ ok: false, code: 'timeout' });
          void reapLeaf(run.leaf);
        });

        return new Promise<StartRunVerdict>((resolve) => {
          run.startResolve = resolve;
        });
      } finally {
        starting = false;
      }
    },

    async invokeTool(tool: RegisteredTool, args: unknown): Promise<InvokeVerdict> {
      const run = live;
      if (run === null || run.exited || run.disposed) return { status: 'crashed' };
      const callId = `invoke-${randomBytes(8).toString('hex')}`;
      if (!run.invokeGuard.begin(callId)) return { status: 'crashed' };
      return new Promise<InvokeVerdict>((resolve) => {
        let settled = false;
        const settle = (verdict: InvokeVerdict): void => {
          if (settled) return;
          settled = true;
          timer();
          run.invokeGuard.settle(callId);
          run.invoke = null;
          resolve(verdict);
        };
        const timer = deps.schedule(deps.shellTimeoutMs, () => {
          if (run.invoke !== null && run.invoke.callId === callId) {
            const elapsed = deps.now() - run.startedAt;
            if (!run.exited) teardown(run);
            releaseSlot(run);
            deps.events.error({
              id: run.packageId, runId: run.runId, code: 'timeout',
              detail: `the invoke of ${tool.name} exceeded the deadline`
                + ` (${elapsed} ms into the run)`,
            });
            settle({ status: 'timeout' });
          }
        });
        run.invoke = { callId, settle, cancel: timer };
        // The lookup→send race: a child that died before the IPC send
        // resolves crashed here, never hangs.
        writeFrame(run.child.stdin, {
          type: 'tool/invoke', callId, name: tool.name, args: args as never,
        }).catch(() => settle({ status: 'crashed' }));
      });
    },

    async stopRun(): Promise<void> {
      const run = live;
      if (run === null) return;
      live = null;
      registry.unregisterRun(run.runId);
      // The kernel initiates this teardown: the exit that follows is not a
      // crash fact.
      run.kernelStopped = true;
      // Fire-and-forget, never awaited: the SIGKILL escalation must not
      // depend on the child draining its pipe.
      void writeFrame(run.child.stdin, { type: 'run/dispose' })
        .catch(() => { /* the child is already gone */ });
      await new Promise<void>((resolve) => {
        const grace = deps.schedule(deps.killGraceMs, () => {
          try { run.child.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        });
        run.child.once('exit', () => { grace(); resolve(); });
      });
      // The drain path owns the crash-honesty and the leaf; give it a turn,
      // then reap regardless — disposal completes kernel-side.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      if (!run.exited) {
        run.kernelStopped = true;
        try { run.child.kill('SIGKILL'); } catch { /* already dead */ }
      }
      await reapLeaf(run.leaf);
    },
  };

  /** The frame router: kernel-side validation is the boundary. */
  function onFrame(
    run: LiveRun,
    outcome: { status: 'frame'; frame: ProtocolFrame }
      | { status: 'teardown'; reason: string },
  ): void {
    if (outcome.status === 'teardown') {
      const resolve = run.startResolve;
      run.startResolve = null;
      if (!run.exited) teardown(run);
      releaseSlot(run);
      if (run.readied || resolve !== null) {
        deps.events.error({
          id: run.packageId, runId: run.runId, code: 'protocol',
          detail: `frame teardown: ${outcome.reason}`,
        });
      }
      resolve?.({
        ok: false, code: 'crashed', detail: `protocol violation: ${outcome.reason}`,
      });
      run.invoke?.settle({ status: 'crashed' });
      run.invoke = null;
      void reapLeaf(run.leaf);
      return;
    }
    const frame = outcome.frame;
    switch (frame.type) {
      case 'run/ready': {
        const resolve = run.startResolve;
        run.startResolve = null;
        run.cancelReady();
        const verdict = registry.registerRun(run.packageId, run.runId, frame.tools);
        if (verdict.ok) {
          run.readied = true;
          resolve?.({ ok: true, runId: run.runId, tools: registry.tools() });
          return;
        }
        teardown(run);
        releaseSlot(run);
        if (verdict.code === 'name-conflict') {
          resolve?.({ ok: false, code: 'name-conflict', names: verdict.names });
        } else if (verdict.code === 'invalid-registration') {
          resolve?.({ ok: false, code: 'invalid-registration', detail: verdict.detail });
        } else {
          resolve?.({ ok: false, code: 'busy' });
        }
        void reapLeaf(run.leaf);
        return;
      }
      case 'tool/result': {
        const invoke = run.invoke;
        if (invoke === null || invoke.callId !== frame.callId) {
          if (!run.exited) teardown(run);
          releaseSlot(run);
          if (run.readied) {
            deps.events.error({
              id: run.packageId, runId: run.runId, code: 'protocol',
              detail: `tool/result without its invoke: ${frame.callId}`,
            });
          }
          void reapLeaf(run.leaf);
          return;
        }
        invoke.settle(frame.ok
          ? { status: 'ok', result: frame.result }
          : { status: 'error', message: frame.error });
        return;
      }
      case 'svc/execute':
      case 'svc/web_search':
      case 'svc/web_fetch': {
        void onServiceRequest(run, frame);
        return;
      }
      default: {
        if (!run.exited) teardown(run);
        releaseSlot(run);
        if (run.readied) {
          deps.events.error({
            id: run.packageId, runId: run.runId, code: 'protocol',
            detail: `unexpected frame from the child: ${frame.type}`,
          });
        }
        run.invoke?.settle({ status: 'crashed' });
        run.invoke = null;
        void reapLeaf(run.leaf);
        return;
      }
    }
  }

  async function onServiceRequest(
    run: LiveRun,
    frame: Extract<ProtocolFrame, { type: 'svc/execute' | 'svc/web_search' | 'svc/web_fetch' }>,
  ): Promise<void> {
    if (!run.readied) {
      // A service request before the accepted registration: svc is a handler
      // channel (the authoring contract), never a top-level one. The
      // declaration was not accepted, so no service may run (design §5.3).
      if (!run.exited) teardown(run);
      releaseSlot(run);
      deps.events.error({
        id: run.packageId, runId: run.runId, code: 'protocol',
        detail: `service request before an accepted registration: ${frame.callId}`,
      });
      void reapLeaf(run.leaf);
      return;
    }
    if (!run.svcGuard.begin(frame.callId)) {
      if (!run.exited) teardown(run);
      releaseSlot(run);
      deps.events.error({
        id: run.packageId, runId: run.runId, code: 'protocol',
        detail: `overlapping service request: ${frame.callId}`,
      });
      void reapLeaf(run.leaf);
      return;
    }
    const service = frame.type === 'svc/execute' ? 'execute' as const
      : frame.type === 'svc/web_search' ? 'web_search' as const : 'web_fetch' as const;
    const subject = frame.type === 'svc/execute' ? frame.cmd
      : frame.type === 'svc/web_search' ? frame.query : frame.url;
    const subjectHash = sha256HexOf(Buffer.from(subject, 'utf8'));
    let ok = false;
    let result: unknown;
    let status: string;
    if (frame.type === 'svc/execute') {
      if (deps.terminal === null) {
        status = 'denied';
        result = { status: 'denied' };
      } else {
        try {
          const outcome = await deps.terminal.run(frame.cmd, {
            timeoutMs: deps.shellTimeoutMs, killGraceMs: deps.killGraceMs,
            maxCaptureBytes: deps.maxShellCaptureBytes,
          }, new AbortController().signal);
          ok = outcome.status === 'completed';
          status = outcome.status;
          result = {
            status: outcome.status, exitCode: outcome.exitCode,
            output: truncateBytes(
              Buffer.from(outcome.output).toString('utf8'), SVC_RESULT_BUDGET_BYTES,
            ),
          };
        } catch (err) {
          ok = false;
          status = 'failed';
          result = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
        }
      }
    } else if (deps.web === null) {
      status = 'denied';
      result = { status: 'denied' };
    } else {
      try {
        const outcome = frame.type === 'svc/web_search'
          ? await deps.web.search(
            frame.query, 'maxResults' in frame ? frame.maxResults : undefined,
            new AbortController().signal,
          )
          : await deps.web.extract(frame.url, new AbortController().signal);
        ok = outcome.ok;
        status = outcome.ok ? 'completed' : 'failed';
        result = {
          ...(outcome.ok ? {} : { failure: outcome.failure }),
          body: truncateBytes(
            Buffer.from(outcome.body).toString('utf8'), SVC_RESULT_BUDGET_BYTES,
          ),
        };
      } catch (err) {
        ok = false;
        status = 'failed';
        result = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    }
    run.svcGuard.settle(frame.callId);
    deps.events.service({
      id: run.packageId, runId: run.runId,
      service, subjectHash, ok, status: status.slice(0, 64),
    });
    // The frame is bounded to the line cap before it is written: a service
    // outcome too large for the wire is truncated, never silently dropped.
    await writeFrame(run.child.stdin, ok
      ? { type: 'svc/result', callId: frame.callId, ok: true, result: result as never }
      : {
        type: 'svc/result', callId: frame.callId, ok: false,
        error: truncateBytes(JSON.stringify(result), SVC_RESULT_BUDGET_BYTES),
      }).catch(() => { /* the child is gone; the drain rule owns the verdict */ });
  }
}
