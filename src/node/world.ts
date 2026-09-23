import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { GitCommandError, UnsafeWorldPathError, WorldNotARepoError } from './errors.js';

/**
 * The world is one git repository (kernel.md §7): the only communication
 * channel, committed by the kernel at the end of every node turn with the git
 * author set to the node's uid, so a commit's author names the node whose turn
 * closed it. Nothing here is a tool — an agent cannot end a turn without its
 * effects being committed and attributed.
 *
 * Attribution is commit-granular, not file-granular: one shared working tree
 * means a turn-end commit can carry a peer's in-flight writes as well as its
 * own (§5.2).
 *
 * The git CLI is driven through `child_process` rather than a library: the
 * commit is a mechanism the kernel must be able to audit byte for byte, and
 * `git` is the only implementation of git whose behavior is a fact.
 */

/** Git's field separator inside a `--format` line: a control character no uid or hash carries. */
const FIELD = '\x1f';

/** The `git log` format the parser reads: hash, author name. */
const LOG_FORMAT = `--format=%H${FIELD}%an`;

/**
 * Output bound for every git call. It is a refusal, not a truncation: the child
 * is killed when the bound is passed, so a `git log` over a long history fails
 * loudly rather than parsing as a short-but-complete one.
 */
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Commit attempts before a lock that will not free is reported as a failure.
 * One commit per turn (§5.2) takes tens of milliseconds, so a short bounded
 * wait covers a peer's turn-end; longer means something is wedged.
 */
const COMMIT_ATTEMPTS = 4;

/** Wait before commit attempt n, linear: 25, 50, 75 ms. */
const COMMIT_RETRY_MS = 25;

/** What git says when another process holds the index or the ref. */
const LOCK_CONTENTION = /index\.lock|cannot lock ref|Another git process seems to be running/i;

/** One commit of the world's history, as the wake predicate and the journal need it. */
export interface WorldCommitInfo {
  readonly hash: string;
  /** The commit's author name — the uid of the node whose turn produced it. */
  readonly author: string;
}

/**
 * A range of the world's history: `from` is a node's wake watermark (the last
 * commit it has seen; null before it has ever perceived the world), `to` is
 * HEAD. It is what the journal records about a turn's perception and what the
 * C1.3 assembler turns into the diff a wake presents (kernel.md §4, §5.2).
 *
 * A type alias rather than an interface, deliberately: this shape is journaled
 * in `turn/start` data, and only a type alias is assignable to the `JsonValue`
 * index signature the envelope requires.
 */
export type WorldRange = {
  readonly from: string | null;
  readonly to: string | null;
};

/**
 * Runs one git command in the world and returns its stdout.
 *
 * @throws GitCommandError on any non-zero exit or spawn failure, carrying the
 * exit code and stderr so a caller can tell a policy failure (an unborn branch,
 * a staged-nothing index) from an environment one.
 */
async function git(dir: string, args: readonly string[], env?: Record<string, string>): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(
      'git', [...args],
      {
        cwd: dir,
        ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
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

const delay = (ms: number): Promise<void> => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, ms);
});

/** Parses one `LOG_FORMAT` line. */
function parseCommit(line: string): WorldCommitInfo {
  const [hash = '', author = ''] = line.split(FIELD);
  return { hash, author };
}

/**
 * The git identity of a node's commit: name and email both carry the uid, so
 * the wake predicate reads authorship off the commit itself (§5.2). The email
 * is derived because git insists on one, and sanitized because a uid is not
 * constrained to email syntax.
 */
function identity(author: string): Record<string, string> {
  const email = `${author.replace(/[^A-Za-z0-9._-]/g, '-')}@world.local`;
  return {
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * Refuses a world that is not a dedicated directory (kernel.md §7, the first
 * safeguard): `$HOME` and broad roots are what turns a commit-per-turn kernel
 * into the documented 200 GB incident.
 *
 * @throws UnsafeWorldPathError.
 */
function assertDedicated(path: string): string {
  const depth = path.split(sep).filter((part) => part !== '').length;
  if (path === resolve(homedir()) || depth < 2) throw new UnsafeWorldPathError(path);
  return path;
}

/**
 * The canonical path of a world directory, checked as such. The check runs on
 * the *resolved* path: a symlink to `$HOME` is a way to be handed `$HOME`
 * without spelling it, and the safeguard is about the directory the kernel
 * would really commit, not about the string it was given.
 *
 * @throws UnsafeWorldPathError when the resolved path is `$HOME` or a broad root.
 * @throws WorldNotARepoError when the directory does not exist.
 */
async function canonicalWorldPath(dir: string): Promise<string> {
  const given = resolve(dir);
  let path: string;
  try {
    path = await realpath(given);
  } catch (err) {
    // A world directory that is not there is a configuration fact, not a crash:
    // it is reported in this module's family rather than as a raw fs error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new WorldNotARepoError(given);
    throw err;
  }
  return assertDedicated(path);
}

const NOOP = (): void => {};

/**
 * The world repository: HEAD reads for the wake predicate, and the serialized
 * commit-per-turn that closes a node's turn.
 */
export class WorldRepo {
  /**
   * Commit serialization, keyed by the repo's canonical root. Two drivers
   * sharing one world must not interleave `add`/`commit`: git's index lock
   * turns the loser of that race into a failed commit, which is a turn whose
   * effects were never attributed. The discipline is the journal's single-writer
   * rule applied one level up — the resource is shared, so the queue is per
   * resource, not per driver. Writers *outside* this process (another kernel,
   * the human's git) are handled by the bounded retry in `commitRetrying`.
   */
  private static readonly commitQueues = new Map<string, Promise<unknown>>();

  private constructor(readonly path: string) {}

  /**
   * Opens the world repository rooted at `dir`.
   *
   * @throws UnsafeWorldPathError when `dir` resolves to `$HOME` or a broad root.
   * @throws WorldNotARepoError when `dir` does not exist, or is not the root of
   * a git repository — including the case where it is a *subdirectory* of one,
   * which would make every turn-end commit the surrounding repository's tree.
   */
  static async open(dir: string): Promise<WorldRepo> {
    const root = await canonicalWorldPath(dir);
    let toplevel: string;
    try {
      toplevel = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw new WorldNotARepoError(root);
    }
    if (resolve(toplevel) !== root) throw new WorldNotARepoError(root);
    return new WorldRepo(root);
  }

  /**
   * Creates the world repository. The kernel owns this, not a node: the world
   * exists before the first node boots.
   *
   * The untracked cache is enabled because it is the one index extension that
   * is a pure win here; the FSMonitor is not (unavailable on Linux, §7).
   */
  static async init(dir: string): Promise<WorldRepo> {
    // The directory is created first, then resolved and checked: `mkdir` on a
    // symlink to `$HOME` is a no-op, so nothing is written before the refusal.
    const given = resolve(dir);
    await mkdir(given, { recursive: true });
    const path = await canonicalWorldPath(given);
    await git(path, ['init', '--quiet']);
    await git(path, ['config', 'core.untrackedCache', 'true']);
    return WorldRepo.open(path);
  }

  /**
   * The commit HEAD points at, or null while the branch is unborn (the world
   * exists but holds no commit yet).
   *
   * @throws GitCommandError when git itself fails.
   */
  async headHash(): Promise<string | null> {
    try {
      return (await git(this.path, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
    } catch (err) {
      // `--quiet` makes the unborn-branch failure an exit 1 with no message:
      // the one git failure here that is a fact about the world, not a fault.
      if (err instanceof GitCommandError && err.exitCode === 1) return null;
      throw err;
    }
  }

  /**
   * The commits HEAD carries that `from` does not, oldest first. `from` null
   * means the whole history — the perception of a node that has never looked.
   *
   * A range is also the wake unit: several commits landing before a node looks
   * again are one list, hence one wake (§5.2).
   */
  async commitsSince(from: string | null): Promise<WorldCommitInfo[]> {
    const head = await this.headHash();
    // No HEAD, or HEAD unmoved: the range is empty without asking git for it.
    if (head === null || head === from) return [];
    try {
      const out = await git(this.path, ['log', LOG_FORMAT, from === null ? 'HEAD' : `${from}..HEAD`]);
      return out.split('\n').filter((line) => line !== '').map(parseCommit).reverse();
    } catch (err) {
      // The watermark is not a reachable object any more (a rewritten history,
      // a gc). The node cannot prove it has seen the current history, so it is
      // given all of it: a spurious wake costs a turn, a missed commit costs a
      // fact, and the two are not symmetric.
      if (from !== null && err instanceof GitCommandError) return this.commitsSince(null);
      throw err;
    }
  }

  /**
   * Commits the working tree as one commit authored by `author`.
   *
   * A turn that changed nothing commits nothing and returns null — an empty
   * commit would move HEAD for no fact, and would turn every idle turn into a
   * wake for every other node (§5.4). `.gitignore` is honoured: a node that
   * keeps a file out of the world's history is a choice the journal still
   * records, and the git layer is meant to show what the society shares.
   *
   * @returns a commit this node authored, or null when this call produced none
   * of its own — never a peer's, see `ownCommit`.
   * @throws GitCommandError when git fails, including a lock another process
   * holds past the bounded retries; the caller decides whether that ends the
   * run (an unattributed effect is not a fact to shrug off).
   */
  async commitAll(author: string, message: string): Promise<WorldCommitInfo | null> {
    return this.serialize(() => this.commitRetrying(author, message));
  }

  /**
   * One commit, retried while another process holds git's lock — another
   * kernel's turn-end, or the human's commit (§5.1). The in-process queue
   * serializes this kernel's drivers; the lock is what serializes everyone
   * else, and a lock held past the bounded wait is reported rather than
   * retried forever.
   */
  private async commitRetrying(author: string, message: string): Promise<WorldCommitInfo | null> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.commitOnce(author, message);
      } catch (err) {
        const contended = err instanceof GitCommandError && LOCK_CONTENTION.test(err.stderr);
        if (!contended || attempt >= COMMIT_ATTEMPTS) throw err;
        await delay(COMMIT_RETRY_MS * attempt);
      }
    }
  }

  private async commitOnce(author: string, message: string): Promise<WorldCommitInfo | null> {
    const before = await this.headHash();
    await git(this.path, ['add', '--all']);
    if (await this.nothingStaged()) return null;
    try {
      // `-c commit.gpgsign=false --no-verify`: the kernel's commit must depend
      // neither on the host's git configuration nor on a hook an agent could
      // have written into the world.
      await git(
        this.path,
        ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '--message', message],
        identity(author),
      );
    } catch (err) {
      // Exit 1 with nothing on stderr is git's "nothing to commit": another
      // process took the tree between our `add` and our `commit`, so this turn
      // has nothing left of its own to record.
      if (err instanceof GitCommandError && err.exitCode === 1 && err.stderr.trim() === '') return null;
      throw err;
    }
    return this.ownCommit(before, author);
  }

  /**
   * The commit this call produced, or null when it produced none of its own.
   *
   * Reading HEAD is not enough: another process can commit between ours and the
   * read, and the hash a `turn/end` journals must be a commit *this* node
   * authored — a peer's hash there would join the journal to the wrong turn. So
   * the range from the HEAD observed before the commit is searched for the
   * newest commit of ours. When a peer's commit swept our writes instead, there
   * is none of ours to name, and the turn records no commit: attribution is
   * commit-granular (§5.2), and naming a peer's commit would be worse than
   * naming none.
   */
  private async ownCommit(before: string | null, author: string): Promise<WorldCommitInfo | null> {
    const range = await this.commitsSince(before);
    return range.filter((commit) => commit.author === author).at(-1) ?? null;
  }

  /** Whether the index matches HEAD, so a commit would have nothing to record. */
  private async nothingStaged(): Promise<boolean> {
    try {
      await git(this.path, ['diff', '--cached', '--quiet']);
      return true;
    } catch (err) {
      // Exit 1 is git's "there are differences", not a failure.
      if (err instanceof GitCommandError && err.exitCode === 1) return false;
      throw err;
    }
  }

  /**
   * Runs `task` after every commit already queued on this repo has finished.
   * The queue is kept alive across failures: a commit that failed must not wedge
   * the next turn's.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const previous = WorldRepo.commitQueues.get(this.path) ?? Promise.resolve();
    const next = previous.then(task, task);
    WorldRepo.commitQueues.set(this.path, next.then(NOOP, NOOP));
    return next;
  }
}
