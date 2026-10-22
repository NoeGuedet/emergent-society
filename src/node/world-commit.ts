import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNodeUid } from '../journal/index.js';
import { NOOP, delay } from '../util.js';
import { GitCommandError, WorldHeadError, WorldReconciliationError } from './errors.js';
import {
  FIELD, commitExists, emptyTree, hashLength, isAncestor, isFullHex, treeOf, type WorldIo,
} from './world-git.js';
import type { WorldCommitInfo } from './world-types.js';

/**
 * The commit-per-turn machinery: staging the working tree, building one commit
 * from git plumbing, moving the branch with a compare-and-swap, and the
 * reconciliation search that finds a turn's own commit after an interruption.
 *
 * Every function here is a free function over `WorldIo` — the repository's
 * paths, its `-c` overrides and its policy seams — so a commit can be exercised
 * against a double without constructing a repository. The process layer is
 * `world-git.ts`, which also holds the revision primitives this module is built
 * from; the repository that owns the policy is `world.ts` (whose open runs the
 * trust checks from `world-trust.ts`).
 *
 * Every HEAD read goes through `io.head()` and the staged-nothing question
 * through `io.nothingStaged()`: those are the repository's seams (and the
 * prototypes a test double replaces), and routing the implementations around
 * them would both skip the seam and recurse — `nothingStaged` below does its
 * git work through `io.git`, never through `io.nothingStaged`.
 */

/** The `git log` format the reconciliation parser reads: hash, author name, subject. */
const RECONCILE_FORMAT = `--format=%H${FIELD}%an${FIELD}%s`;

/**
 * Commit attempts before a lock that will not free — or a branch that will not
 * stop moving — is reported as a failure. One commit per turn (§5.2) takes tens
 * of milliseconds, so a short bounded wait covers a peer's turn-end; longer means
 * something is wedged.
 */
const COMMIT_ATTEMPTS = 4;

/** Wait before commit attempt n, linear: 25, 50, 75 ms. */
const COMMIT_RETRY_MS = 25;

/**
 * Commits scanned when finding an interrupted turn's own commit. The search
 * range is the turn's opening base to HEAD, so it holds the turn's own commit
 * and the few peers that landed while it ran. A range past this bound is
 * refused, not truncated: a bounded walk that stopped early could miss a second
 * matching commit and so choose one of several.
 */
const MAX_RECONCILE_SCAN = 4096;

/** What git says when another process holds the index or the ref, or when a branch compare-and-swap loses its race. */
const LOCK_CONTENTION = /index\.lock|cannot lock ref|Another git process seems to be running/i;

/**
 * Commit serialization, keyed by the repo's canonical root. Two drivers
 * sharing one world must not interleave the staging and publishing of a
 * commit: without the queue both stage the same index and one loses git's
 * index lock or its compare-and-swap, which is a turn whose effects were never
 * attributed. The discipline is the journal's single-writer rule applied one
 * level up — the resource is shared, so the queue is per resource, not per
 * driver. Writers *outside* this process (another kernel, the human's git) are
 * handled by the bounded retry in `commitRetrying`.
 *
 * The map is module-level, not per repository: two instances opened on the same
 * root must share the queue. An entry lives only while a commit is queued or
 * running (`serialize` prunes it), so the map does not grow with every world a
 * long-lived process opens.
 */
export const commitQueues = new Map<string, Promise<void>>();

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
 * Commits the working tree as one commit authored by `author`.
 *
 * A turn that changed nothing commits nothing and returns null — an empty
 * commit would move HEAD for no fact, and would turn every idle turn into a
 * wake for every other node (§5.4). `.gitignore` is honoured: a node that
 * keeps a file out of the world's history is a choice the journal still
 * records, and the git layer is meant to show what the society shares.
 *
 * @returns a commit this node authored, or null when this call produced none
 * of its own — the hash is the one git created for this call, so it can never
 * be a peer's.
 * @throws InvalidNodeUidError when `author` is not a safe node uid; the
 * validation precedes the queue and every git effect.
 * @throws WorldHeadError when HEAD is detached or not a local branch, or when
 * it switches branch during the commit; the kernel publishes to one named
 * branch and refuses to guess.
 * @throws GitCommandError when git fails, including a lock another process
 * holds past the bounded retries; the caller decides whether that ends the
 * run (an unattributed effect is not a fact to shrug off).
 */
export async function commitAll(
  io: WorldIo, author: string, message: string,
): Promise<WorldCommitInfo | null> {
  // The author becomes the commit's git identity, so it must be a uid the
  // kernel can vouch for: a separator or a control character here is a
  // malformed identity, and this is where it is refused — before the queue,
  // before `add`, before anything exists to undo. History already written by
  // someone else is never re-validated: foreign author names stay facts.
  assertNodeUid(author);
  return serialize(io.path, () => commitRetrying(io, author, message));
}

/**
 * The commits a node authored for one turn, reachable from HEAD but not from
 * the turn's opening `base` — the search that reconciles an interrupted turn
 * whose own commit landed and whose closer did not (kernel.md §3).
 *
 * The candidate must carry the exact uid and the exact subject `turn N`: a
 * prefixed, suffixed, substring or trimmed label is not a candidate, and a
 * commit by another node with the same subject is not one either. Author and
 * subject are a jointure, not a cryptographic identity (C1.4 owns that); this
 * narrows the history to the candidates and does not choose among them.
 *
 * `base` null means the turn opened on an unborn branch, so the whole reachable
 * history is after it. A non-null `base` that is missing, malformed or no
 * longer an ancestor of HEAD fails closed rather than falling back to all
 * history; a walk past the bound fails closed rather than truncating. Every
 * match is returned, in git's log order: exactly-one-vs-several is the caller's
 * decision, not this search's (`NodeDriver.open` refuses more than one). The
 * compare-and-swap loser of a failed publish is unreachable from HEAD, so it is
 * never a candidate, and nothing here mutates history or runs gc.
 *
 * @throws WorldReconciliationError when the base is unreachable or the walk is
 * bounded out.
 */
export async function commitsForTurn(
  io: WorldIo, base: string | null, uid: string, turn: number,
): Promise<readonly WorldCommitInfo[]> {
  const subject = `turn ${turn}`;
  const head = await io.head();
  if (head === null) {
    if (base !== null) {
      throw new WorldReconciliationError(
        `interrupted turn ${turn}: base ${base} is unreachable on an unborn branch`);
    }
    return [];
  }
  if (base !== null) {
    if (!isFullHex(await io.format(), base)) {
      throw new WorldReconciliationError(
        `interrupted turn ${turn}: base ${JSON.stringify(base)} is not a full commit id`);
    }
    if (!(await commitExists(io, base)) || !(await isAncestor(io, base, head))) {
      throw new WorldReconciliationError(
        `interrupted turn ${turn}: base ${base} is not an ancestor of HEAD`);
    }
  }
  const spec = base === null ? head : `${base}..${head}`;
  const out = await io.git([
    'log', `--max-count=${MAX_RECONCILE_SCAN + 1}`, RECONCILE_FORMAT, spec,
  ]);
  const lines = out.split('\n').filter((line) => line !== '');
  if (lines.length > MAX_RECONCILE_SCAN) {
    throw new WorldReconciliationError(
      `interrupted turn ${turn}: more than ${MAX_RECONCILE_SCAN} commits after its opening`);
  }
  const matches: WorldCommitInfo[] = [];
  for (const line of lines) {
    const [hash = '', author = '', found = ''] = line.split(FIELD);
    if (author === uid && found === subject) matches.push({ hash, author });
  }
  return matches;
}

/**
 * One commit, retried while another process holds git's lock or moves the
 * branch — another kernel's turn-end, or the human's commit (§5.1). The
 * in-process queue serializes this kernel's drivers; the lock and the
 * compare-and-swap serialize everyone else, and contention held past the
 * bounded wait is reported rather than retried forever.
 *
 * The whole attempt is retried, never a fragment: the parent commit is
 * re-read, the tree re-snapshotted and the commit re-created against the new
 * parent, so a peer commit that landed in between is kept, not overwritten.
 * Only lock/compare-and-swap contention is retryable; any other git or read
 * failure surfaces unchanged.
 */
async function commitRetrying(
  io: WorldIo, author: string, message: string,
): Promise<WorldCommitInfo | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await commitOnce(io, author, message);
    } catch (err) {
      const contended = err instanceof GitCommandError && LOCK_CONTENTION.test(err.stderr);
      if (!contended || attempt >= COMMIT_ATTEMPTS) throw err;
      await delay(COMMIT_RETRY_MS * attempt);
    }
  }
}

/**
 * One commit attempt, built from git plumbing rather than `git commit`.
 *
 * `git commit` writes the message to the repository-wide `.git/COMMIT_EDITMSG`
 * and reads it back, so two concurrent commits race on that one shared file —
 * the observed "empty commit message" abort and a commit whose message is
 * another writer's. `write-tree` + `commit-tree` + `update-ref` never touch
 * that file: the tree is a snapshot of the index, the message goes through
 * `-m`, and the branch moves with a compare-and-swap. The commit hash is known
 * directly from `commit-tree`, so no read-back of HEAD is needed — that read
 * could name a peer's commit. Index and working tree are only ever added to:
 * nothing is reset, and no object is pruned.
 */
async function commitOnce(
  io: WorldIo, author: string, message: string,
): Promise<WorldCommitInfo | null> {
  const ref = await headRef(io);
  const before = await io.head();
  // A world subdirectory the agent ran `git init` in is a *nested* repository,
  // and staging it would break the turn twice: an unborn one makes the whole
  // `add --all` fail ("does not have a commit checked out"), and a committed
  // one stages a `160000 commit <hash>` gitlink whose object lives only in the
  // agent's repo — a durable tree that references an unresolvable object and
  // whose subtree content is never committed. The pathspec exclusion is the
  // load-bearing half; the index sweep below is the belt.
  const nested = await nestedRepoDirs(io);
  await io.git([
    'add', '--all', '--', '.',
    ...nested.map((rel) => `:(exclude,literal)${rel}`),
  ]);
  // The belt: remove any gitlink that survived staging. `ls-files --stage -z`
  // is NUL-separated because a whitespace split would mangle a `my sub` path
  // and silently keep the gitlink; `--` before the path is required because a
  // `-`-prefixed path otherwise makes `update-index` no-op or error. The path
  // is passed verbatim: `update-index` takes literal file names, not
  // pathspecs, so a `*`/`?`/`[` in the path removes only that entry (adding
  // `:(literal)` here would name a nonexistent file and remove nothing).
  for (const rel of await stagedGitlinks(io)) {
    await io.git(['update-index', '--force-remove', '--', rel]);
  }
  if (await io.nothingStaged()) return null;
  const tree = (await io.git(['write-tree'])).trim();
  // The net-change guard: a tree identical to the parent's would be an empty
  // commit — a wake for every other node with no fact behind it (§5.4). The
  // empty tree stands in for an unborn branch's parent.
  const parentTree = before === null
    ? await emptyTree(io)
    : await treeOf(io, before);
  if (tree === parentTree) return null;
  // The commit object is created whether or not the branch can move; a
  // compare-and-swap loss leaves it unreferenced, and the retry makes a fresh
  // one. `-c commit.gpgsign=false -c core.hooksPath=/dev/null` keep the commit
  // independent of host configuration and of any hook — `commit-tree` runs no
  // hooks, and the explicit empty path also protects a future regression.
  const commit = (await io.git(
    [
      '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null',
      'commit-tree', tree,
      ...(before === null ? [] : ['-p', before]),
      '-m', message,
    ],
    identity(author),
  )).trim();
  await publish(io, ref, before, commit);
  return { hash: commit, author };
}

/**
 * The world's directories that carry a `.git` entry (directory, file or
 * symlink), relative to the world root — the nested repositories an agent
 * created. The world root itself is skipped: a stray root-level `.git` is
 * never read by the explicit pair and is never staged by git.
 */
async function nestedRepoDirs(io: WorldIo): Promise<string[]> {
  const found: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    const dir = rel === '' ? io.path : join(io.path, rel);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A directory a peer removed between the readdir and the descent.
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }
    if (rel !== '' && entries.some((entry) => entry.name === '.git')) {
      found.push(rel);
      return;
    }
    for (const entry of entries) {
      // Git's own metadata is not world content, and a symlink is not
      // descended by `add` either.
      if (entry.name === '.git' || !entry.isDirectory()) continue;
      await visit(rel === '' ? entry.name : `${rel}/${entry.name}`);
    }
  };
  await visit('');
  return found;
}

/** The staged paths whose index entry is a `160000` gitlink. */
async function stagedGitlinks(io: WorldIo): Promise<string[]> {
  const links: string[] = [];
  for (const record of (await io.git(['ls-files', '--stage', '-z'])).split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const space = record.indexOf(' ');
    if (tab === -1 || space === -1) continue;
    if (record.slice(0, space) === '160000') links.push(record.slice(tab + 1));
  }
  return links;
}

/**
 * The local branch HEAD names, or a refusal when HEAD is not one.
 *
 * The kernel publishes to a named branch and verifies it again immediately
 * before publishing; a detached HEAD, or one pointing outside
 * `refs/heads/`, fails closed rather than guessing which ref to move.
 * `symbolic-ref` is the only supported mechanism — git 2.43 has no
 * `update-ref --symref-verify` — so the check and the update are two commands.
 * Branch switching is outside the single-branch world contract: the window
 * between the two is documented, not promised closed against a concurrent
 * checkout.
 */
async function headRef(io: WorldIo): Promise<string> {
  let ref: string;
  try {
    ref = (await io.git(['symbolic-ref', '--quiet', 'HEAD'])).trim();
  } catch (err) {
    if (err instanceof GitCommandError && err.exitCode === 1) {
      throw new WorldHeadError('HEAD is detached, not a branch');
    }
    throw err;
  }
  if (!ref.startsWith('refs/heads/')) {
    throw new WorldHeadError(`HEAD names ${JSON.stringify(ref)}, not a local branch`);
  }
  return ref;
}

/**
 * Moves `ref` from `before` to `commit` with a compare-and-swap.
 *
 * The expected old value is the parent this attempt was built on — or the
 * all-zero object id, sized by the repository's object format, when the branch
 * is unborn. A peer commit that landed in between makes the update fail
 * (`cannot lock ref … is at … but expected …`, which the retry loop reads as
 * contention) instead of being overwritten. HEAD is re-checked immediately
 * before the update so a branch switch during the attempt fails closed.
 */
async function publish(
  io: WorldIo, ref: string, before: string | null, commit: string,
): Promise<void> {
  const current = await headRef(io);
  if (current !== ref) {
    throw new WorldHeadError(`HEAD switched from ${ref} to ${current} during a commit`);
  }
  const expected = before ?? '0'.repeat(hashLength(await io.format()));
  await io.git(['update-ref', ref, commit, expected]);
}

/**
 * Whether the index matches HEAD, so a commit would have nothing to record.
 *
 * Calls `io.git` and never `io.nothingStaged`, which the repository binds back
 * to this function: routing this question through that seam would recurse.
 */
export async function nothingStaged(io: WorldIo): Promise<boolean> {
  try {
    await io.git(['diff', '--cached', '--quiet']);
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
 *
 * A finished entry is pruned only while it is still the map's tail: if a later
 * commit queued behind it in the meantime, the map already names that later
 * promise and this one must not be removed out from under the chain.
 */
function serialize<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = commitQueues.get(root) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(NOOP, NOOP);
  commitQueues.set(root, settled);
  void settled.then(() => {
    if (commitQueues.get(root) === settled) {
      commitQueues.delete(root);
    }
  });
  return next;
}
