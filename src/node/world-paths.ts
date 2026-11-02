import { Buffer } from 'node:buffer';
import { GitCommandError } from './errors.js';
import { GIT_READ_TIMEOUT_MS } from './limits.js';
import { runGit } from './world-git.js';

/**
 * The read-time path reader: which paths ONE commit changed, computed from the
 * world's git when a node reads its own history (`src/node/history.ts`).
 *
 * This is new plumbing, not a new method on the protected repository
 * (`world.ts`): it asks the world's own read plumbing for its worktree and
 * `--git-dir`/`--work-tree` pair and runs one `diff-tree` child through
 * `runGit`, exactly as `direction.ts` and the overlay's world-read do — the
 * kernel's controlled git environment, no lock, no mutation, no blob read.
 *
 * THE GIT BUDGET, priced rather than discovered: one history read spawns at
 * most ONE sequential `diff-tree` child per distinct committed turn entry in
 * its window, each under its own `GIT_READ_TIMEOUT_MS` (10 s) deadline. The
 * pathological ceiling is therefore `window × 10 s` (the history cap makes it
 * 64 × 10 s), and the children are SEQUENTIAL, never concurrent. The reads are
 * not wired to the turn's abort signal — `runGit` has no signal seam — so a
 * stop landing during a history read waits for at most the current child's
 * deadline before the result lands. This is the same non-cancellation residual
 * the perception render already carries (`context/diff.ts`'s per-commit patch
 * reads): a bounded wait, never a leaked child — `runGit` kills the whole
 * process group on the deadline and awaits its close.
 *
 * The failure modes are TYPED and never a throw: an unreachable or missing
 * commit (git's own "bad object", or a hash that is not full hex), a git
 * timeout, and any other git failure each render as the bounded "unreadable"
 * marker in the history entry. A history read never dies because the world's
 * object store moved.
 */

/**
 * The paths one commit may render before the self-clamp: the first 64 paths
 * (git's own path order) plus the omitted count. The cap bounds a turn entry
 * whose commit swept a whole tree (a first turn on a fresh world, or a refused
 * turn's deferred writes picked up by a recovery commit).
 */
export const MAX_COMMIT_PATHS = 64;

/**
 * The byte bound on the rendered path text in one entry: the first paths whose
 * UTF-8 bytes fit under 8 KiB. A single path can be filesystem-long, so the
 * count cap alone does not bound the entry; this one does.
 */
export const MAX_COMMIT_PATHS_BYTES = 8192;

/** The one per-read deadline; it is the process layer's plumbing read bound. */
export const COMMIT_PATHS_TIMEOUT_MS = GIT_READ_TIMEOUT_MS;

/** Why a commit's paths could not be read — three bounded classes, never a payload. */
export type CommitPathsFailure = 'missing' | 'timeout' | 'failed';

/** One typed read result: the clamped path list, or the bounded failure class. */
export type CommitPathsRead =
  | {
      readonly kind: 'paths';
      /** The first paths of the commit's changed set, in git's own order. */
      readonly paths: readonly string[];
      /** How many further paths the commit changed and this read did not render. */
      readonly omitted: number;
    }
  | { readonly kind: 'unreadable'; readonly reason: CommitPathsFailure };

/** The minimal world port this read needs (the overlay's world-read shape). */
export type WorldPathsRepo = {
  readonly path: string;
  gitBaseArgs(): readonly string[];
};

/** The test seam: a git runner already bound to the repo's pair, plus the timeout. */
export type CommitPathsOptions = {
  readonly timeoutMs?: number;
  /**
   * A caller-supplied git runner (tests only). Production always runs
   * `runGit(world.path, [...world.gitBaseArgs(), 'diff-tree', ...])` below.
   */
  readonly git?: (args: readonly string[], timeoutMs: number) => Promise<string>;
};

/**
 * A full-hash shape check before any git child runs: the recorded hash is
 * placed as `diff-tree`'s revision argument, and a value starting with `-`
 * would be read as an option. A malformed hash is a missing commit, never a
 * command line.
 */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Classifies one git failure without echoing its stderr (it can carry paths). */
function failureReason(err: unknown): CommitPathsFailure {
  if (err instanceof GitCommandError) {
    // Only the deadline is a timeout. An abort is a cancellation, not a
    // timeout — and it has no producer here yet (the documented
    // non-cancellation residual: no signal is threaded into this read), so it
    // falls into the honest 'failed' class rather than being mislabelled.
    if (err.kind === 'timeout') return 'timeout';
    // git's exit 128 is "bad object"/"unknown revision": the commit is gone
    // from the object store or was never there. Anything else is a read fault.
    if (err.kind === 'exit' && err.exitCode === 128) return 'missing';
    return 'failed';
  }
  return 'failed';
}

/**
 * Reads the paths ONE commit changed.
 *
 * The argv is the bounded, hermetic read: `--no-commit-id` drops the commit
 * line, `--name-only` keeps names (never patches, so no extra bytes), `-r`
 * recurses and `--root` makes a root commit render its whole tree (a first
 * turn on a fresh world). A no-op turn makes no commit, so an empty result is
 * an empty commit — rendered honestly by the caller, never guessed.
 */
export async function readCommitPaths(
  world: WorldPathsRepo, hash: string, opts: CommitPathsOptions = {},
): Promise<CommitPathsRead> {
  if (typeof hash !== 'string' || !FULL_HASH.test(hash)) {
    return { kind: 'unreadable', reason: 'missing' };
  }
  const timeoutMs = opts.timeoutMs ?? COMMIT_PATHS_TIMEOUT_MS;
  const runner = opts.git;
  const git = (args: readonly string[]): Promise<string> => runner !== undefined
    ? runner(args, timeoutMs)
    : runGit(world.path, [...world.gitBaseArgs(), ...args], undefined, timeoutMs);
  let output: string;
  try {
    output = await git([
      'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', hash,
    ]);
  } catch (err) {
    return { kind: 'unreadable', reason: failureReason(err) };
  }
  const all = output.split('\n').filter((line) => line !== '');
  const paths: string[] = [];
  let bytes = 0;
  for (const path of all) {
    if (paths.length >= MAX_COMMIT_PATHS) break;
    const size = Buffer.byteLength(path, 'utf8') + 1;
    if (paths.length > 0 && bytes + size > MAX_COMMIT_PATHS_BYTES) break;
    paths.push(path);
    bytes += size;
  }
  return { kind: 'paths', paths, omitted: Math.max(0, all.length - paths.length) };
}
