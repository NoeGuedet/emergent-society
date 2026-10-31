import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GitCommandError, type GitFailureKind } from './errors.js';
import {
  GIT_ADD_TIMEOUT_MS, GIT_PLUMBING_TIMEOUT_MS,
} from './limits.js';
import type { ObjectFormat } from './world-types.js';

/**
 * The git process layer: one controlled environment, one output bound, one
 * spawn lifecycle. The policy that decides *which* commands the kernel runs
 * stays with the repository (`world.ts`); this module only decides how a `git`
 * child is started and how its failure is reported. Alongside the spawn
 * primitives it hosts the io-level revision primitives (`readHead`,
 * `commitExists`, `isAncestor`, `treeOf`, `emptyTree`, `assertHash`,
 * `verifyCommit`, `hashLength`, `isFullHex`) so the higher-level siblings share
 * one implementation rather than importing one another for them: they encode
 * the *meaning* of a git exit status, not the choice of command.
 *
 * The git CLI is driven through `child_process` rather than a library: the
 * commit is a mechanism the kernel must be able to audit byte for byte, and
 * `git` is the only implementation of git whose behavior is a fact.
 *
 * `spawnGit` is deliberately minimal — it applies the controlled environment
 * and nothing else, with the child in its own process group so the consumer's
 * deadline/cap kill (`killGitTree`) reaches every descendant. The two streaming
 * consumers keep their own decode/accumulate/kill loops, because they diverge
 * too far to share more: the author scan reads utf8 strings with a
 * character-bounded stderr and SIGTERM, while the diff renderer decodes
 * `Buffer`s against a byte cap, bounds stderr in bytes and uses SIGKILL.
 *
 * `runGit`/`runGitWithStdin` own the commit-path process policy: a per-call
 * deadline (30 s for `add`, 10 s otherwise), the world flock around the
 * mutating subcommands, and — after a timed-out stager is reaped — a bounded,
 * flock-guarded cleanup of a provably stale `index.lock`. The lock path is
 * derived from the call's own `--git-dir` (`worldLockPath`), not from a home:
 * `world.ts` is a protected surface and `WorldIo` carries no home.
 */

/** Git's field separator inside a `--format` line: a control character no uid or hash carries. */
export const FIELD = '\x1f';

/**
 * Output bound for every git call. It is a refusal, not a truncation: the child
 * is killed when the bound is passed, so a `git log` over a long history fails
 * loudly rather than parsing as a short-but-complete one.
 */
export const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/** stderr kept from a failed bounded render: a diagnostic, never the payload (§T4). */
export const MAX_GIT_STDERR_BYTES = 8 * 1024;

/** The world lock directory and file, world-adjacent to the external git dir. */
export const WORLD_LOCK_DIR = '.es';
export const WORLD_LOCK_NAME = 'world.lock';

/**
 * The git subcommands that mutate the index or a ref. They are the commands
 * the world flock serializes across kernels and processes: two concurrent
 * stagers on one index would otherwise lose a turn's effects. `init` and the
 * read plumbing are deliberately absent — the kernel init runs before any
 * world exists, and reads take no lock (the commit's compare-and-swap is the
 * publish guard).
 */
export const MUTATING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add', 'update-index', 'write-tree', 'commit-tree', 'update-ref',
]);

/** The flock binary: a declared host prerequisite, shared with the journal lock. */
export const FLOCK_COMMAND = 'flock';

/** `flock -E`: the reserved conflict exit, so a held lock is never read as git's status. */
export const FLOCK_CONFLICT_EXIT = 75;

/** The SIGTERM→SIGKILL grace after a git deadline: the forked git must not survive the flock parent. */
const GIT_KILL_GRACE_MS = 1_000;

/** The bounded wait for one flock helper (probe, cleanup): it never blocks on a peer. */
const FLOCK_HELPER_TIMEOUT_MS = 10_000;

/**
 * The first non-option argument after the repository pair and the `-c`
 * overrides — the git subcommand. It is the process layer's one reading of
 * `argv` (the policy that builds `argv` stays in `world.ts` / `world-commit.ts`).
 */
export function gitSubcommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--git-dir' || arg === '--work-tree' || arg === '-c') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

/** Whether one git invocation mutates the index or a ref (and so takes the world flock). */
export function isMutatingGit(args: readonly string[]): boolean {
  const subcommand = gitSubcommand(args);
  return subcommand !== null && MUTATING_GIT_SUBCOMMANDS.has(subcommand);
}

/** The `--git-dir` value of one git invocation, or null when the pair is absent. */
export function gitDirOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--git-dir') {
      const value = args[i + 1];
      return value === undefined || value === '' ? null : value;
    }
  }
  return null;
}

/**
 * The world's commit lock path, derived from the call's own `--git-dir`
 * argument: `<dirname(git-dir)>/.es/world.lock`.
 *
 * It is world-adjacent rather than home-based on purpose. `WorldIo` and
 * `world.ts` are protected surfaces (the same derivation is used by the
 * mutating git children and the doctor), and the derivation yields
 * `<home>/.es/world.lock` in production (`<home>/world.git`) as well as a
 * fixture's `root/.es/world.lock` (`root/world.git`) without either side
 * knowing a home.
 *
 * @throws Error when the invocation carries no `--git-dir` value — a
 * programming error, never a world fact.
 */
export function worldLockPath(args: readonly string[]): string {
  const gitDir = gitDirOf(args);
  if (gitDir === null) {
    throw new Error('world lock path: the git arguments carry no --git-dir value');
  }
  return join(dirname(gitDir), WORLD_LOCK_DIR, WORLD_LOCK_NAME);
}

/** The git dir's `index.lock`: the one lock a timed-out or crashed stager can leave behind. */
export function worldIndexLockPath(args: readonly string[]): string | null {
  const gitDir = gitDirOf(args);
  return gitDir === null ? null : join(gitDir, 'index.lock');
}

/**
 * The ref lock files an `update-ref` child may create: the named ref's lock and
 * `packed-refs.lock`. Only `refs/heads/` and `refs/tags/` are named (the world
 * publishes a local branch); a computed path that escapes the git dir is
 * refused rather than removed.
 */
export function worldRefLockPaths(args: readonly string[]): string[] {
  if (gitSubcommand(args) !== 'update-ref') return [];
  const gitDir = gitDirOf(args);
  if (gitDir === null) return [];
  const index = args.indexOf('update-ref');
  const ref = args.slice(index + 1).find((arg) => !arg.startsWith('-'));
  if (ref === undefined || !/^refs\/(heads|tags)\//u.test(ref)) return [];
  const base = resolve(gitDir);
  const named = resolve(base, `${ref}.lock`);
  if (!named.startsWith(`${base}/`)) return [];
  return [named, join(base, 'packed-refs.lock')];
}

/** Every lock file a mutating child may create during this invocation. */
export function attemptLockPaths(args: readonly string[]): string[] {
  const index = worldIndexLockPath(args);
  const paths = index === null ? [] : [index];
  for (const path of worldRefLockPaths(args)) {
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** The pre-spawn inode of each existing lock path; an absent path is simply absent. */
export async function snapshotLocks(paths: readonly string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const path of paths) {
    try {
      const entry = await lstat(path);
      if (entry.isFile()) snapshot.set(path, `${entry.dev}:${entry.ino}`);
    } catch {
      // Absent: a file that appears later is the child's.
    }
  }
  return snapshot;
}

/**
 * Removes the lock files that appeared (or were replaced) during one mutating
 * attempt, under the world flock. A path that already existed with the same
 * inode is left alone: it is not this child's lock, and a human's live lock is
 * not distinguishable from a stale one by mtime alone (the doctor's age rule
 * owns that decision). The reserved conflict exit means a live kernel writer
 * holds the flock, so the files are left.
 */
export async function maybeRemoveAttemptLocks(
  args: readonly string[], snapshot: ReadonlyMap<string, string>,
  opts: { readonly flock?: string } = {},
): Promise<IndexLockCleanup> {
  const index = worldIndexLockPath(args);
  if (index === null) return 'unverifiable';
  const changed: string[] = [];
  for (const path of attemptLockPaths(args)) {
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      continue;
    }
    if (!entry.isFile()) continue;
    const prior = snapshot.get(path);
    if (prior !== undefined && prior === `${entry.dev}:${entry.ino}`) continue;
    changed.push(path);
  }
  if (changed.length === 0) return 'kept';
  let lockPath: string;
  try {
    lockPath = worldLockPath(args);
    await ensureWorldLockDir(lockPath);
  } catch {
    return 'unverifiable';
  }
  const outcome = await runCommand(
    opts.flock ?? FLOCK_COMMAND,
    flockArgv(lockPath, ['rm', '-f', '--', ...changed]),
    {
      cwd: dirname(lockPath),
      env: gitEnv(),
      timeoutMs: FLOCK_HELPER_TIMEOUT_MS,
      stdoutCap: 0,
      stderrCap: MAX_GIT_STDERR_BYTES,
      group: true,
    },
  );
  if (outcome.spawnError !== null || outcome.timedOut) return 'unverifiable';
  if (outcome.code === 0) return 'removed';
  if (outcome.code === FLOCK_CONFLICT_EXIT) return 'kept';
  return 'unverifiable';
}

/**
 * Creates the lock directory owner-only (0700) before flock touches the lock
 * file. The external binary would otherwise create the file with the umask's
 * modes; an existing directory is left as it is (the home layout already owns
 * it, and re-moding would race a peer).
 */
async function ensureWorldLockDir(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
}

/** The per-call git deadline: `add` gets the longer staging bound, everything else the plumbing bound. */
export function gitTimeoutMs(args: readonly string[]): number {
  return gitSubcommand(args) === 'add' ? GIT_ADD_TIMEOUT_MS : GIT_PLUMBING_TIMEOUT_MS;
}

/**
 * The git context variables the kernel strips from every call. Each one lets an
 * inherited environment point git at a different repository, index, object store
 * or namespace — the difference between committing the world and committing
 * somewhere the kernel was never asked to touch. Two of them are config-injection
 * channels that need no file at all: `GIT_CONFIG_COUNT` with its
 * `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` entries, and `GIT_CONFIG_PARAMETERS`
 * (a shell-quoted `-c` list). Either can set `core.*` — a clean filter, an
 * fsmonitor, hooks — which git would then run unlogged.
 */
export const GIT_ENV_STRIP: readonly string[] = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  // A replace ref lets `.git/refs/replace/*` project a forged commit in place
  // of the physical one; this variable would redirect where git looks for them.
  'GIT_REPLACE_REF_BASE',
];

/**
 * The controlled environment for every kernel git invocation. The redirecting
 * and config-injecting variables above are removed, system and global config are
 * neutralized, and the rest of the environment (PATH, locale — git needs both)
 * is inherited. A caller with an explicit policy (the hermetic diff renderer)
 * passes overrides, which win. Replace refs are neutralized as well, so the
 * kernel reads physical committed facts rather than a `refs/replace` projection
 * — intentionally, since a projection is not a durable fact of the world.
 * Lazy fetching is disabled outright: a promisor configuration plus one missing
 * object is enough to make ordinary plumbing run a configured transport helper,
 * i.e. arbitrary code as the kernel; with this variable git fails closed
 * ("bad tree object") instead of fetching. This is the single place that
 * decides a kernel git environment: the process environment is read, never
 * mutated. Exported so test fixtures acting as a second writer use the same
 * controlled environment the kernel does.
 */
export function gitEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_ENV_STRIP) delete env[key];
  for (const key of Object.keys(env)) {
    // `GIT_CONFIG_COUNT` names a list; its entries are `GIT_CONFIG_KEY_<n>` and
    // `GIT_CONFIG_VALUE_<n>`, so they are removed by prefix, whatever the count.
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // The kernel reads physical committed objects only: a `refs/replace` entry
    // is a projection, and every read command (log, rev-list, first-parent,
    // reconciliation, diff) must see the real author and subject.
    GIT_NO_REPLACE_OBJECTS: '1',
    // Defense in depth under the open-time refusal of promisor/partial-clone
    // configuration: a missing object must fail closed, never fetch.
    GIT_NO_LAZY_FETCH: '1',
    ...overrides,
  };
}

/**
 * What the io-level revision primitives need from a repository: its paths, the
 * pair and defense-in-depth overrides every call carries, and the three
 * operations whose *policy* (not mechanics) belongs to the repository — HEAD,
 * the staged-nothing question and the cached object format.
 *
 * `baseArgs` exposes the pair because a caller building `[..., 'log', ...]`
 * needs it, while the hermetic diff renderer must not get it (its `--git-dir`
 * must stay last-wins). `head` and `nothingStaged` are the seams a test double
 * overrides; `format` returns the format read once by the repository.
 */
export interface WorldIo {
  readonly path: string;
  readonly gitDir: string;
  baseArgs(): readonly string[];
  head(): Promise<string | null>;
  nothingStaged(): Promise<boolean>;
  git(args: readonly string[], env?: Record<string, string>): Promise<string>;
  gitWithStdin(args: readonly string[], input: Uint8Array): Promise<string>;
  format(): Promise<ObjectFormat>;
}

/** Full-hex validation, sized to the repository's object format (T4 step 1). */
export function hashLength(format: ObjectFormat): number {
  return format === 'sha256' ? 64 : 40;
}

export function isFullHex(format: ObjectFormat, value: string): boolean {
  return value.length === hashLength(format) && /^[0-9a-f]+$/.test(value);
}

/**
 * The process-layer shape of one failed git child: why it failed and whether
 * the output bound, not the command, ended it.
 *
 * Before the discriminator, `GitCommandError` carried only
 * `exitCode: number | null`: a numeric code and a spawn failure were
 * distinguishable only by the null, and a timeout, an abort and the
 * output-bound kill had no name at all. This is the one classification; the
 * construction sites apply it rather than repeat it.
 */
export type GitFailure = {
  readonly kind: GitFailureKind;
  readonly outputCapped: boolean;
};

/**
 * Classifies one `execFile`/`spawn` failure without relying on a message.
 *
 * `timeout` is the process layer's own deadline (the `runGit`/
 * `runGitWithStdin` timer, or a streaming caller's); `abort` still has no
 * production producer in C3 (no signal is threaded into the git seam) and is
 * reserved for a future caller. The order below is load-bearing: a timeout
 * error carries both `killed`/`signal` and a string code (`ETIMEDOUT`), and
 * the kill is the stronger fact.
 */
export function classifyGitFailure(err: unknown): GitFailure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    readonly name?: unknown; readonly code?: unknown;
    readonly killed?: unknown; readonly signal?: unknown;
  };
  // `execFile`'s own maxBuffer guard raises a RangeError with this code; the
  // child was killed, but it is neither a deadline nor a spawn failure.
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return { kind: 'exit', outputCapped: true };
  }
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
    return { kind: 'abort', outputCapped: false };
  }
  // A process-layer kill first: `execFile`'s timeout sets `killed`, a
  // signal-killed child carries its signal. Both end the command, and either
  // may arrive with a string code (ETIMEDOUT), so they outrank the errno arm.
  if (e.killed === true) return { kind: 'timeout', outputCapped: false };
  if (typeof e.signal === 'string' && e.signal !== '') {
    return { kind: 'timeout', outputCapped: false };
  }
  // A string code left over is the spawn layer's errno (ENOENT, EACCES, ...);
  // a numeric code is git's own exit status.
  if (typeof e.code === 'string') return { kind: 'spawn', outputCapped: false };
  return { kind: 'exit', outputCapped: false };
}

/** One bounded child outcome: the raw process facts, never a decision. */
export type CommandOutcome = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputCapped: boolean;
  readonly timedOut: boolean;
  readonly spawnError: unknown;
};

type CommandOptions = {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly stdoutCap: number;
  readonly stderrCap: number;
  /** Kill the child's process group (flock forks the wrapped command). */
  readonly group: boolean;
  readonly stdin?: Uint8Array;
};

/** Delivers a signal to the child or, for a group command, to every process it forked. */
function killTree(
  child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals, group: boolean,
): void {
  if (group && child.pid !== undefined) {
    try {
      // `flock <lock> git …` forks git in the same (detached) process group.
      // Killing only flock would leave the git child holding the lock.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone; the single-child kill below is the backstop.
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/**
 * One spawned child with this module's whole process policy: the controlled
 * environment is the caller's, stdout/stderr are byte-bounded, the deadline is
 * a SIGTERM then SIGKILL escalation, and the promise settles only on `close` —
 * the close is the waitpid proof that no child of ours is still writing.
 *
 * The group kill exists because `flock <lock> git …` forks the wrapped command
 * (measured): a signal to flock alone would leave git running with the lock
 * descriptor inherited, so the timeout would not be a bound at all.
 */
function runCommand(
  file: string, argv: readonly string[], opts: CommandOptions,
): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolvePromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(file, [...argv], {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        detached: opts.group,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolvePromise({
        code: null, signal: null, stdout: '', stderr: String(err),
        outputCapped: false, timedOut: false, spawnError: err,
      });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputCapped = false;
    let timedOut = false;
    let spawnError: unknown = null;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;
    const deadline = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM', opts.group);
      graceTimer = setTimeout(() => killTree(child, 'SIGKILL', opts.group), GIT_KILL_GRACE_MS);
    }, opts.timeoutMs);
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (graceTimer !== null) clearTimeout(graceTimer);
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        outputCapped,
        timedOut,
        spawnError,
      });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (outputCapped) return;
      const room = opts.stdoutCap - stdoutBytes;
      if (chunk.length > room) {
        if (room > 0) {
          stdout.push(chunk.subarray(0, room));
          stdoutBytes += room;
        }
        outputCapped = true;
        // The output bound is a refusal, not a truncation: stop the child.
        killTree(child, 'SIGKILL', opts.group);
        return;
      }
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const room = opts.stderrCap - stderrBytes;
      if (room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderr.push(part);
      stderrBytes += part.length;
    });
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (code, signal) => settle(code, signal));
    // A child that exits or is deadline-killed before draining a large stdin
    // makes the pending pipe write fail with EPIPE. Without a listener Node
    // raises an uncaught 'error' on the stream and kills the kernel process;
    // the outcome is still the close's to classify (typically the typed
    // `timeout`), so the stream error is recorded and ignored.
    child.stdin.on('error', () => {
      // EPIPE after an early exit or a deadline kill: the close classifies the
      // outcome, and an unhandled stream 'error' would kill the kernel process.
    });
    child.stdin.end(opts.stdin);
  });
}

/**
 * Maps one process outcome to the typed git failure, or null for success.
 *
 * A flock conflict is rewritten into the contention wording the commit retry
 * classifies (`world-commit.ts`'s LOCK_CONTENTION), so a held world lock is
 * retried rather than reported as a git policy failure. flock's own startup
 * exits (64 usage, 66 no input, 69 unavailable — the wrapped command could not
 * execute) are the spawn class, exactly as a missing git binary is.
 *
 * Exported so the output-cap ordering is pinned deterministically: a synthetic
 * `{code: 0, signal: null, outputCapped: true}` cannot be produced reliably
 * through a live child (the cap kills the writer before it can exit 0).
 */
export function failureOf(
  args: readonly string[], outcome: CommandOutcome, flockWrapped: boolean,
): GitCommandError | null {
  if (outcome.spawnError !== null) {
    return new GitCommandError(
      args, null, String(outcome.spawnError), classifyGitFailure(outcome.spawnError),
    );
  }
  if (outcome.outputCapped) {
    // The bound is checked BEFORE the success return: a child that exits 0 at
    // the very moment the cap is crossed must still be a refusal, never a
    // truncated-but-successful shorter fact (the group kill is a no-op once it
    // has exited, so the close cannot be relied on to carry a signal).
    return new GitCommandError(
      args, outcome.code, outcome.stderr, { kind: 'exit', outputCapped: true },
    );
  }
  if (outcome.code === 0 && outcome.signal === null) return null;
  if (outcome.timedOut || outcome.signal !== null) {
    // The one process-layer classification: a kill is a `timeout` there too,
    // so a direct kill and Node's own timeout cannot drift apart.
    const classified = classifyGitFailure({
      code: outcome.code, killed: outcome.timedOut, signal: outcome.signal,
    });
    return new GitCommandError(args, outcome.code, outcome.stderr, {
      kind: classified.kind, outputCapped: classified.outputCapped,
    });
  }
  if (flockWrapped && outcome.code === FLOCK_CONFLICT_EXIT) {
    return new GitCommandError(
      args, outcome.code,
      `flock: the world lock is held by another writer; ${outcome.stderr}`,
      { kind: 'exit' },
    );
  }
  if (flockWrapped && (outcome.code === 64 || outcome.code === 66 || outcome.code === 69)) {
    return new GitCommandError(args, outcome.code, outcome.stderr, { kind: 'spawn' });
  }
  return new GitCommandError(
    args, outcome.code, outcome.stderr,
    classifyGitFailure({ code: outcome.code, killed: false, signal: outcome.signal }),
  );
}

/** The `flock -n -E 75 <lock> <command…>` argv (exec form, never a shell). */
function flockArgv(lockPath: string, command: readonly string[]): string[] {
  return ['-n', '-E', String(FLOCK_CONFLICT_EXIT), lockPath, ...command];
}

/**
 * Runs one git command with `dir` as its working directory and returns stdout.
 *
 * The deadline derives from the subcommand (`add` 30 s, plumbing 10 s) and may
 * be overridden for a test. A mutating subcommand runs as
 * `flock -n -E 75 <world.lock> git <args>` in exec form: the lock is the
 * cross-kernel serialization the in-process queue cannot provide, and a held
 * lock is retried as contention. Every child is spawned into its own process
 * group so the deadline kills the whole tree (`flock` forks the wrapped git, a
 * shell shim spawns `sleep`), and the promise settles only on `close`: the
 * close is the waitpid proof that nothing of this call is still writing.
 *
 * When the deadline expires the failure is classified `timeout`; the lock files
 * that APPEARED during the attempt (the reaped child's own index or ref lock,
 * compared by inode against a pre-spawn snapshot) are removed under the flock.
 * A lock that predates the attempt is never touched here — a live human's lock
 * is indistinguishable from a stale one, so the doctor's age rule owns it.
 *
 * @throws GitCommandError on any non-zero exit, spawn failure or deadline,
 * carrying the git arguments (never the flock wrapper), stderr and the
 * failure's `kind` so a caller can tell a policy failure (an unborn branch, a
 * staged-nothing index) from an environment one.
 */
export async function runGit(
  dir: string, args: readonly string[], env?: Record<string, string>,
  timeoutMs?: number,
): Promise<string> {
  const timeout = timeoutMs ?? gitTimeoutMs(args);
  const mutating = isMutatingGit(args);
  let file = 'git';
  let argv: readonly string[] = [...args];
  if (mutating) {
    const lockPath = worldLockPath(args);
    try {
      await ensureWorldLockDir(lockPath);
    } catch (err) {
      throw new GitCommandError(args, null, String(err), { kind: 'spawn' });
    }
    file = FLOCK_COMMAND;
    argv = flockArgv(lockPath, ['git', ...args]);
  }
  // The snapshot is taken BEFORE the child exists: a lock absent now and
  // present after the timeout is the child's, whatever its mtime says.
  const locks = mutating ? attemptLockPaths(args) : [];
  const snapshot = locks.length === 0 ? new Map<string, string>() : await snapshotLocks(locks);
  const outcome = await runCommand(file, argv, {
    cwd: dir,
    env: gitEnv(env),
    timeoutMs: timeout,
    stdoutCap: MAX_GIT_OUTPUT_BYTES,
    stderrCap: MAX_GIT_STDERR_BYTES,
    group: true,
  });
  const failure = failureOf(args, outcome, mutating);
  if (failure === null) return outcome.stdout;
  if (mutating && failure.kind === 'timeout') {
    // After the close (the child is reaped), re-acquire the lock non-blocking
    // and remove only the files that appeared during the attempt. The failure
    // is the commit's fact; the cleanup is best effort and never displaces it.
    await maybeRemoveAttemptLocks(args, snapshot).catch(() => {});
  }
  throw failure;
}

/**
 * Runs one git command feeding `input` on stdin and returns stdout (T4 empty-tree hash).
 *
 * Same deadline and failure classification as `runGit`; the stdin uses the
 * same exec-form flock when the subcommand mutates.
 */
export async function runGitWithStdin(
  dir: string, args: readonly string[], input: Uint8Array, timeoutMs?: number,
): Promise<string> {
  const timeout = timeoutMs ?? gitTimeoutMs(args);
  const mutating = isMutatingGit(args);
  let file = 'git';
  let argv: readonly string[] = [...args];
  if (mutating) {
    const lockPath = worldLockPath(args);
    try {
      await ensureWorldLockDir(lockPath);
    } catch (err) {
      throw new GitCommandError(args, null, String(err), { kind: 'spawn' });
    }
    file = FLOCK_COMMAND;
    argv = flockArgv(lockPath, ['git', ...args]);
  }
  const locks = mutating ? attemptLockPaths(args) : [];
  const snapshot = locks.length === 0 ? new Map<string, string>() : await snapshotLocks(locks);
  const outcome = await runCommand(file, argv, {
    cwd: dir,
    env: gitEnv(),
    timeoutMs: timeout,
    stdoutCap: Number.POSITIVE_INFINITY,
    stderrCap: Number.POSITIVE_INFINITY,
    group: true,
    stdin: input,
  });
  const failure = failureOf(args, outcome, mutating);
  if (failure === null) return outcome.stdout;
  if (failure.kind === 'timeout' && mutating) {
    await maybeRemoveAttemptLocks(args, snapshot).catch(() => {});
  }
  throw failure;
}

/** What a proven-stale `index.lock` cleanup did. */
export type IndexLockCleanup = 'absent' | 'removed' | 'kept' | 'unverifiable';

/** What a non-blocking world-lock probe found. */
export type WorldLockState = 'free' | 'held' | 'unverifiable';

/**
 * Probes the world flock without blocking and without mutating anything:
 * `flock -n -E 75 <world.lock> true` is free (exit 0), held (the reserved
 * conflict exit) or unverifiable (flock absent, a timeout, any other failure).
 * A held lock is NEVER removed — the doctor reports it, the commit retries it.
 */
export async function probeWorldLock(
  args: readonly string[], opts: { readonly flock?: string } = {},
): Promise<WorldLockState> {
  let lockPath: string;
  try {
    lockPath = worldLockPath(args);
    await ensureWorldLockDir(lockPath);
  } catch {
    return 'unverifiable';
  }
  const outcome = await runCommand(
    opts.flock ?? FLOCK_COMMAND, flockArgv(lockPath, ['true']),
    {
      cwd: dirname(lockPath),
      env: gitEnv(),
      timeoutMs: FLOCK_HELPER_TIMEOUT_MS,
      stdoutCap: 0,
      stderrCap: MAX_GIT_STDERR_BYTES,
      group: true,
    },
  );
  if (outcome.spawnError !== null || outcome.timedOut) return 'unverifiable';
  if (outcome.code === 0) return 'free';
  if (outcome.code === FLOCK_CONFLICT_EXIT) return 'held';
  return 'unverifiable';
}

/**
 * Removes `<git-dir>/index.lock` only when it provably predates
 * `staleBeforeMs`, and only while holding the world flock (`flock -n -E 75
 * <world.lock> rm -f -- <index.lock>`, exec form, never a shell).
 *
 * The flock is the cross-kernel proof: a mutating child only creates
 * `index.lock` after acquiring it, so a lock we hold excludes a live kernel
 * writer. A held lock means a live writer, so the file is left. Human git does
 * not take this flock — the declared residual — so the mtime proof is what
 * keeps a human's live lock; a fresh lock is never removed. Ref locks
 * (`refs/heads/<branch>.lock`, `packed-refs.lock`) are NOT this function's
 * case: the commit path's `maybeRemoveAttemptLocks` removes a ref lock its own
 * timed-out `update-ref` created (compared by inode against the pre-spawn
 * snapshot, under the same flock), and an `update-ref` timeout is then retried
 * as contention and finally refused typed; a ref lock that predates the
 * attempt is left, like the index lock here.
 *
 * `opts.flock` is the test seam for an absent binary; production resolves the
 * declared prerequisite from PATH.
 */
export async function maybeRemoveIndexLock(
  args: readonly string[], staleBeforeMs: number,
  opts: { readonly flock?: string } = {},
): Promise<IndexLockCleanup> {
  const indexPath = worldIndexLockPath(args);
  if (indexPath === null) return 'unverifiable';
  let entry;
  try {
    entry = await lstat(indexPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A peer removed it, or the git dir is gone: nothing was removed here.
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unverifiable';
  }
  // Never remove a lock we cannot prove stale: a symlink or special file is
  // observed as-is, and a lock at or after the attempt is a live writer's.
  if (!entry.isFile() || entry.mtimeMs >= staleBeforeMs) return 'kept';
  let lockPath: string;
  try {
    lockPath = worldLockPath(args);
    await ensureWorldLockDir(lockPath);
  } catch {
    return 'unverifiable';
  }
  const outcome = await runCommand(
    opts.flock ?? FLOCK_COMMAND,
    flockArgv(lockPath, ['rm', '-f', '--', indexPath]),
    {
      cwd: dirname(lockPath),
      env: gitEnv(),
      timeoutMs: FLOCK_HELPER_TIMEOUT_MS,
      stdoutCap: 0,
      stderrCap: MAX_GIT_STDERR_BYTES,
      group: true,
    },
  );
  if (outcome.spawnError !== null || outcome.timedOut) return 'unverifiable';
  if (outcome.code === 0) return 'removed';
  // The reserved conflict exit: a peer (or a human's flock) holds the lock.
  if (outcome.code === FLOCK_CONFLICT_EXIT) return 'kept';
  return 'unverifiable';
}

/**
 * Starts one `git` child under the controlled environment and returns it with
 * all three pipes connected. Nothing is decoded, bounded, killed or mapped here:
 * each streaming caller owns its own loop, so the shared piece stays exactly the
 * environment and the spawn flags. `opts.env` is the caller's overrides, not a
 * whole environment — dropping them would silently lose `GIT_ATTR_SOURCE` and
 * the `GIT_ENV_STRIP` hardening.
 */
export function spawnGit(
  args: readonly string[],
  opts: { readonly cwd: string; readonly env?: Record<string, string> },
): ChildProcessWithoutNullStreams {
  return spawn('git', args, {
    cwd: opts.cwd,
    env: gitEnv(opts.env),
    windowsHide: true,
    // Its own process group, so a streaming caller's deadline/cap kill reaches
    // every descendant of the git child (`killGitTree`), not just git itself.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Kills one `spawnGit` child and its descendants: the group is the unit,
 * because a git child may have spawned a helper that inherited the pipes — a
 * signal to git alone would leave the pipes open and the caller waiting past
 * its own deadline.
 */
export function killGitTree(
  child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGKILL',
): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone; the single-child kill below is the backstop.
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Refuses a hash that is not full hex in the repository's object format. */
export async function assertHash(
  io: WorldIo, where: 'from' | 'to', value: string,
): Promise<void> {
  if (!isFullHex(await io.format(), value)) {
    throw new Error(`invalid ${where} hash: ${value}`);
  }
}

/** Verifies `commit` names a commit; a missing object propagates the git failure (T4 step 1). */
export async function verifyCommit(io: WorldIo, commit: string): Promise<void> {
  await io.git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
}

/** Whether `commit` exists as a commit: the only "missing" signal is git's exit 1. */
export async function commitExists(io: WorldIo, commit: string): Promise<boolean> {
  try {
    await verifyCommit(io, commit);
    return true;
  } catch (err) {
    // Exit 1 is git's "unknown revision"; anything else (EIO/EACCES/spawn) is
    // an environment failure and must not be mistaken for a missing object.
    if (err instanceof GitCommandError && err.exitCode === 1) return false;
    throw err;
  }
}

/** Whether `from` is an ancestor of `to`; exits 0/1 carry the answer, else fail. */
export async function isAncestor(io: WorldIo, from: string, to: string): Promise<boolean> {
  try {
    await io.git(['merge-base', '--is-ancestor', from, to]);
    return true;
  } catch (err) {
    if (err instanceof GitCommandError && err.exitCode === 1) return false;
    throw err;
  }
}

/** The empty-tree object hash, generated from empty stdin; never a hardcoded SHA-1. */
export async function emptyTree(io: WorldIo): Promise<string> {
  return (await io.gitWithStdin(['hash-object', '-t', 'tree', '--stdin'], Buffer.alloc(0))).trim();
}

/** The tree object of a commit; a missing object propagates the git failure. */
export async function treeOf(io: WorldIo, commit: string): Promise<string> {
  return (await io.git(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`])).trim();
}

/**
 * The commit HEAD points at, or null while the branch is unborn.
 *
 * Calls `io.git` and never `io.head`: `head` is the repository's own seam (and
 * the prototype a test double replaces), and routing this primitive through it
 * would recurse.
 *
 * @throws GitCommandError when git itself fails.
 */
export async function readHead(io: WorldIo): Promise<string | null> {
  try {
    return (await io.git(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
  } catch (err) {
    // `--quiet` makes the unborn-branch failure an exit 1 with no message:
    // the one git failure here that is a fact about the world, not a fault.
    if (err instanceof GitCommandError && err.exitCode === 1) return null;
    throw err;
  }
}
