import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { GitCommandError } from './errors.js';
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
 * and nothing else. The two streaming consumers keep their own
 * decode/accumulate/kill loops, because they diverge too far to share more: the
 * author scan reads utf8 strings with a character-bounded stderr and SIGTERM,
 * while the diff renderer decodes `Buffer`s against a byte cap, bounds stderr in
 * bytes and uses SIGKILL.
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
 * Runs one git command with `dir` as its working directory and returns stdout.
 *
 * @throws GitCommandError on any non-zero exit or spawn failure, carrying the
 * exit code and stderr so a caller can tell a policy failure (an unborn branch,
 * a staged-nothing index) from an environment one.
 */
export async function runGit(
  dir: string, args: readonly string[], env?: Record<string, string>,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(
      'git', [...args],
      {
        cwd: dir,
        env: gitEnv(env),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err !== null) {
          const code = (err as { code?: number | string }).code;
          reject(new GitCommandError(args, typeof code === 'number' ? code : null, stderr));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

/** Runs one git command feeding `input` on stdin and returns stdout (T4 empty-tree hash). */
export async function runGitWithStdin(
  dir: string, args: readonly string[], input: Uint8Array,
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', [...args], { cwd: dir, env: gitEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err) => reject(new GitCommandError(args, null, String(err))));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new GitCommandError(args, code, stderr));
    });
    child.stdin.end(input);
  });
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
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
