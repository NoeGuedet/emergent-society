import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNodeUid } from '../journal/index.js';
import { singleLine } from '../text.js';
import { NOOP, delay } from '../util.js';
import { GitCommandError, WorldHeadError, WorldReconciliationError } from './errors.js';
import { DEFAULT_COMMIT_LIMITS, type CommitLimits } from './limits.js';
import {
  FIELD, MAX_GIT_OUTPUT_BYTES, commitExists, emptyTree, hashLength, isAncestor, isFullHex,
  treeOf, type WorldIo,
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

/**
 * The nested-repository walk's own path budget, in UTF-8 bytes. A child
 * directory whose absolute path is longer than this is NOT descended and NOT
 * ignored: it is refused as the typed `walk-too-deep`. Excluding it from `add`
 * would silently drop content git can still reach by relative paths (a
 * relative mkdir/chdir chain can legally pass PATH_MAX, and a nested
 * repository there makes `add` fail on its unborn HEAD); a skip would leave the
 * effect unattributed. A refusal keeps the kernel alive, tells the model which
 * subtree is outside the commit, and leaves the content for it to move or
 * remove. The root is never refused by the budget: its readdir is the walk's
 * entry point, and a root past PATH_MAX fails typed from readdir itself.
 */
const MAX_WALK_PATH_BYTES = 3800;

/**
 * One raw filesystem failure of the nested-repository walk. The walk runs
 * before any git child exists, so its errors are not `GitCommandError`s; this
 * class is how they cross into the classifier as a typed refusal instead of
 * escaping as a driver error (which would kill the kernel and leave the turn
 * open, making every later boot fail). The detail carries the relative path,
 * never the absolute one: the walk is the one model-visible source of a
 * peer-authored path.
 */
export class WorldWalkError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string,
    readonly rel: string,
  ) {
    super(`world walk ${operation} failed (${code}): ${rel === '' ? '.' : rel}`);
    this.name = 'WorldWalkError';
  }
}

/**
 * One pre-add or post-add budget overrun. It carries the refusal's own reason
 * and a bounded detail, so `commitAllRefused` classifies it as the typed
 * `budget` without a second mapping: the walk runs before any git child, and
 * the staged budget runs after `add` with the index deliberately left staged
 * for the operator or the agent to shrink.
 */
export class CommitBudgetError extends Error {
  readonly reason = 'budget' as const;
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'CommitBudgetError';
  }
}

/**
 * What a held lock looks like: git's own index/ref contention, a lost
 * compare-and-swap, or the world flock's reserved conflict exit (the wrapper
 * rewrites it into this same wording). All of them are retryable: the holder
 * is another turn-end, and the commit machinery retries the whole attempt.
 */
const LOCK_CONTENTION =
  /index\.lock|cannot lock ref|Another git process seems to be running|world lock is held/i;

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
 * The typed shape of a refused commit: what stopped the commit path, in a
 * bounded form a local-log event and a status projection can carry.
 *
 * A refusal is not an error path with a different label — it is the commit
 * boundary's answer for every failure the boundary can name, so the driver can
 * end the turn `waiting` (the kernel survives) instead of relabelling a git
 * failure as `driver-error`. `git-exit` is a command that ran and refused,
 * `git-spawn` a child that never started, `git-timeout`/`git-abort` a child the
 * process layer ended, `output-cap` the kernel's own output bound, `walk-eacces`
 * and `walk-failure` the world walk's raw filesystem failure (a permission
 * errno, or any other errno — the walk is not a `GitCommandError`),
 * `walk-too-deep` a child past the walk's path budget (refused, never silently
 * excluded from the commit), `world-head` a HEAD the kernel cannot publish to
 * (detached, outside `refs/heads/`, or switched during the attempt), and
 * `budget`/`freeze-timeout` the later commit-boundary budgets and fence.
 */
export type CommitRefusal = {
  readonly reason: 'walk-eacces' | 'walk-failure' | 'walk-too-deep' | 'git-exit' | 'git-spawn'
    | 'git-timeout' | 'git-abort' | 'output-cap' | 'world-head' | 'budget' | 'freeze-timeout';
  readonly detail: string;
};

/**
 * The closed refusal vocabulary: the reasons this module classifies plus the
 * ones a later commit-boundary stage throws already typed (the staged budget,
 * the fence), which `isCommitRefusal` must pass through.
 */
const COMMIT_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'walk-eacces', 'walk-failure', 'walk-too-deep', 'git-exit', 'git-spawn', 'git-timeout',
  'git-abort', 'output-cap', 'world-head', 'budget', 'freeze-timeout',
]);

/** The rendered detail bound: one bounded line, never a payload. */
export const MAX_COMMIT_REFUSAL_DETAIL = 300;

/**
 * One bounded, single-line refusal detail: control characters become spaces
 * and the code-point count is capped. The event payload and the rendered
 * carrier both come through here, so neither can grow with a git stderr or a
 * path from a hostile world.
 */
export function boundedRefusalDetail(detail: string): string {
  // The strip class and the cap live in the shared text boundary; the rendered
  // line is model-visible, so it must not carry a character that can forge a
  // second line or reorder it visually.
  return singleLine(detail, MAX_COMMIT_REFUSAL_DETAIL);
}

/** The one model-visible rendering of a refusal: one bounded line. */
export function renderCommitRefusal(refusal: CommitRefusal): string {
  return `commit refused (${refusal.reason}): ${boundedRefusalDetail(refusal.detail)}`;
}

/** True for a value already carrying the refusal shape (a later stage's throw). */
export function isCommitRefusal(value: unknown): value is CommitRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as { readonly reason?: unknown; readonly detail?: unknown };
  return typeof fields.reason === 'string'
    && COMMIT_REFUSAL_REASONS.has(fields.reason)
    && typeof fields.detail === 'string';
}

/**
 * Classifies one failure of the whole commit path into a typed refusal, or
 * `null` when it is not a class this boundary can name (a programming error, a
 * malformed uid, a reconciliation ambiguity) — the caller decides, and the
 * classifier never swallows.
 *
 * The sources are recognized by shape and class, not by one shared predicate:
 * a typed refusal passes through by its fields, a `GitCommandError` by its
 * class and process kind, a `WorldHeadError` by its class, and the
 * nested-repository walk's raw filesystem failure (any errno: EACCES, EPERM,
 * ENAMETOOLONG, EIO, EMFILE…) by its class or code, since it fails before any
 * git child exists. A raw errno that escapes the walk is the same class.
 */
export function classifyCommitFailure(err: unknown): CommitRefusal | null {
  if (isCommitRefusal(err)) {
    return { reason: err.reason, detail: boundedRefusalDetail(err.detail) };
  }
  // HEAD that cannot be published to is a property of the world, not of a git
  // command: it must be a refusal so the driver parks and retries (the branch
  // may return) instead of dying as a driver error.
  if (err instanceof WorldHeadError) {
    return { reason: 'world-head', detail: boundedRefusalDetail(err.reason) };
  }
  if (err instanceof WorldWalkError) {
    return {
      reason: err.code === 'ETOODEEP'
        ? 'walk-too-deep'
        : isWalkPermissionCode(err.code) ? 'walk-eacces' : 'walk-failure',
      detail: boundedRefusalDetail(err.message),
    };
  }
  if (err instanceof GitCommandError) {
    const label = gitLabel(err.args);
    if (err.outputCapped) {
      return {
        reason: 'output-cap',
        detail: boundedRefusalDetail(
          `${label} output exceeded ${MAX_GIT_OUTPUT_BYTES} bytes`),
      };
    }
    switch (err.kind) {
      case 'spawn':
        return {
          reason: 'git-spawn',
          detail: boundedRefusalDetail(`${label} could not be spawned: ${err.stderr}`),
        };
      case 'timeout':
        return { reason: 'git-timeout', detail: boundedRefusalDetail(`${label} timed out`) };
      case 'abort':
        return { reason: 'git-abort', detail: boundedRefusalDetail(`${label} was aborted`) };
      case 'exit':
        return {
          reason: 'git-exit',
          detail: boundedRefusalDetail(
            `${label} exited ${err.exitCode ?? 'unknown'}: ${err.stderr}`),
        };
    }
  }
  // The walk is the only raw filesystem read in the commit path; a raw errno
  // that escapes it is still the same class. Only an errno-shaped string is
  // accepted: Node's `ERR_*` codes are programming errors and must stay loud
  // (rethrown by `commitAllRefused`), never be swallowed as a refusal.
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)
    && code !== 'ENOENT' && code !== 'ENOTDIR') {
    return {
      reason: isWalkPermissionCode(code) ? 'walk-eacces' : 'walk-failure',
      detail: boundedRefusalDetail(err instanceof Error ? err.message : String(err)),
    };
  }
  return null;
}

/** Whether one errno is the walk's permission class (the reason that predates `walk-failure`). */
function isWalkPermissionCode(code: string): boolean {
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * The git subcommand of one failed call, skipping the `--git-dir`/`--work-tree`
 * pair and any `-c key=value` the repository prefixes. A detail that named
 * `args[0]` would say `git --git-dir exited 128` on every production failure.
 */
function gitLabel(args: readonly string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--git-dir' || arg === '--work-tree' || arg === '-c') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return `git ${arg}`;
  }
  return 'git';
}

/** The discriminated result of one commit attempt: a commit, or a typed refusal. */
export type CommitAttempt = {
  readonly commit: WorldCommitInfo | null;
  readonly refusal: CommitRefusal | null;
};

/**
 * Wraps one commit attempt (the driver's call into `WorldRepo.commitAll`) in
 * the one refusal classifier. It catches only failures the boundary can name;
 * anything else is rethrown unchanged, so a programming error stays loud.
 */
export async function commitAllRefused(
  attempt: () => Promise<WorldCommitInfo | null>,
): Promise<CommitAttempt> {
  try {
    return { commit: await attempt(), refusal: null };
  } catch (err) {
    const refusal = classifyCommitFailure(err);
    if (refusal === null) throw err;
    return { commit: null, refusal };
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
  limits: CommitLimits = DEFAULT_COMMIT_LIMITS,
): Promise<WorldCommitInfo | null> {
  // The author becomes the commit's git identity, so it must be a uid the
  // kernel can vouch for: a separator or a control character here is a
  // malformed identity, and this is where it is refused — before the queue,
  // before `add`, before anything exists to undo. History already written by
  // someone else is never re-validated: foreign author names stay facts.
  assertNodeUid(author);
  return serialize(io.path, () => commitRetrying(io, author, message, limits));
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
  io: WorldIo, author: string, message: string, limits: CommitLimits,
): Promise<WorldCommitInfo | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await commitOnce(io, author, message, limits);
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
  io: WorldIo, author: string, message: string, limits: CommitLimits,
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
  const nested = await nestedRepoDirs(io, limits);
  // A nested repository is excluded from the staging sweep: staging it would
  // either fail on its unborn HEAD or record a gitlink whose object lives only
  // in the agent's repo. The belt below removes any gitlink that survived.
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
  const staged = await stagedEntries(io);
  for (const entry of staged) {
    if (entry.mode === '160000') {
      await io.git(['update-index', '--force-remove', '--', entry.path]);
    }
  }
  // The staged budget is post-`add` and pre-`write-tree`: an overrun refuses
  // typed and leaves the index staged (never a reset), so the content stays
  // attributable and the operator or the agent can shrink it. It measures the
  // TURN'S staged delta against HEAD, never the whole index: a large but
  // already-committed world must keep committing one-file turns, and a no-op
  // turn must never hit the budget.
  await assertStagedBudget(io, await stagedDelta(io, before), limits);
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
 * created. The world root itself is skipped: a stray root-level `.git` is never
 * read by the explicit pair and is never staged by git.
 *
 * The walk is also the commit path's pre-add budget. `maxWalkEntries` is
 * enforced after each directory's readdir and before any descent — the one
 * residual is that Node has no streaming readdir, so a single flat directory
 * is materialized before the count is known (documented; the acceptance uses a
 * directory distribution). `maxFileApparentBytes` is checked with `lstat` on
 * regular files, so a sparse 2 GB file is refused by its apparent size before
 * `add` allocates anything; symlinks and special files are not measured (git
 * does not descend a symlink, and a FIFO can only be reached by the add's own
 * reader, which the add deadline bounds).
 *
 * A child past the walk's path budget is refused as `walk-too-deep`, not
 * skipped: the subtree may be git-reachable by relative paths, so dropping it
 * would be a silent partial commit; refusing keeps the effect attributable and
 * the kernel alive. A budget overrun is the typed `budget` for the same
 * reason: the world is larger than the commit boundary accepts, and the model
 * can shrink it rather than lose an effect to an unbounded walk.
 */
async function nestedRepoDirs(io: WorldIo, limits: CommitLimits): Promise<string[]> {
  const nested: string[] = [];
  let entriesSeen = 0;
  const visit = async (rel: string): Promise<void> => {
    const dir = rel === '' ? io.path : join(io.path, rel);
    // The root is never refused by the path budget: its readdir is the walk's
    // entry point, and a root past PATH_MAX fails typed from readdir below.
    if (rel !== '' && Buffer.byteLength(dir, 'utf8') > MAX_WALK_PATH_BYTES) {
      throw new WorldWalkError('walk', 'ETOODEEP', rel);
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A directory a peer removed between the readdir and the descent.
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw new WorldWalkError(
        'readdir', typeof code === 'string' ? code : 'unknown', rel,
      );
    }
    entriesSeen += entries.length;
    if (entriesSeen > limits.maxWalkEntries) {
      throw new CommitBudgetError(
        `world walk exceeds ${limits.maxWalkEntries} entries at ${rel === '' ? '.' : rel}`);
    }
    if (rel !== '' && entries.some((entry) => entry.name === '.git')) {
      nested.push(rel);
      return;
    }
    for (const entry of entries) {
      // Git's own metadata is not world content, and a symlink is not
      // descended by `add` either.
      if (entry.name === '.git') continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isFile()) {
        const abs = join(dir, entry.name);
        let stat;
        try {
          stat = await lstat(abs);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // A file a peer removed between the readdir and the stat is gone
          // from the commit too; any other errno is the walk's typed class.
          if (code === 'ENOENT' || code === 'ENOTDIR') continue;
          throw new WorldWalkError(
            'lstat', typeof code === 'string' ? code : 'unknown', childRel);
        }
        if (stat.isFile() && stat.size > limits.maxFileApparentBytes) {
          throw new CommitBudgetError(
            `world file is ${stat.size} bytes, over the ${limits.maxFileApparentBytes}-byte `
            + `per-file budget: ${childRel}`);
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      await visit(childRel);
    }
  };
  await visit('');
  return nested;
}

/** One parsed `git ls-files --stage -z` record. */
type StagedEntry = {
  readonly mode: string;
  readonly object: string;
  readonly stage: string;
  readonly path: string;
};

/** The staged index entries, NUL-separated so a whitespace path stays whole. */
async function stagedEntries(io: WorldIo): Promise<StagedEntry[]> {
  const entries: StagedEntry[] = [];
  for (const record of (await io.git(['ls-files', '--stage', '-z'])).split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    // `<mode> <object> <stage>\t<path>`: parse the metadata before the tab so
    // the stage never absorbs the path.
    const metadata = record.slice(0, tab).split(' ');
    if (metadata.length !== 3) continue;
    entries.push({
      mode: metadata[0]!,
      object: metadata[1]!,
      stage: metadata[2]!,
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

/** The turn's staged delta: changed paths and the new blob hashes behind them. */
type StagedDelta = {
  readonly paths: number;
  readonly objects: readonly string[];
};

/**
 * The TURN'S staged delta, not the whole index: `git diff --cached --raw -z
 * --no-renames` against HEAD gives one record per changed path with its new
 * blob hash (deletions carry the zero hash and contribute no bytes). An unborn
 * branch has no parent tree, so every staged entry is the delta.
 *
 * A rename is two records (`A` + `D`); the new path's blob size counts, the
 * deletion's zero does not. A mode-only change keeps its blob, so its content
 * size counts — the bound is the staging size, not the object-store delta.
 */
async function stagedDelta(io: WorldIo, before: string | null): Promise<StagedDelta> {
  if (before === null) {
    const entries = (await stagedEntries(io)).filter((entry) => entry.mode !== '160000');
    return { paths: entries.length, objects: entries.map((entry) => entry.object) };
  }
  const out = await io.git(['diff', '--cached', '--raw', '-z', '--no-renames']);
  const parts = out.split('\0');
  let paths = 0;
  const objects: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const meta = parts[i]!;
    if (!meta.startsWith(':')) continue;
    const fields = meta.slice(1).split(' ');
    if (fields.length !== 5) continue;
    const newHash = fields[3]!;
    const status = fields[4]!;
    const path = parts[i + 1] ?? '';
    i += 1;
    if (path === '') continue;
    paths += 1;
    if (status === 'D' || /^0+$/.test(newHash)) continue;
    objects.push(newHash);
  }
  return { paths, objects };
}

/**
 * The post-add budget: the turn's staged path count, then the summed blob
 * sizes of its new objects (`cat-file --batch-check` over their hashes, one
 * child on stdin). It never uses `diff --cached --numstat`: numstat's numbers
 * are line counts, not bytes, and a binary file is `-` there — the artifacts
 * that actually blow up a world would contribute nothing.
 *
 * A missing object is not a budget overrun: `--batch-check` reports `missing`,
 * the sum skips it, and `write-tree` fails typed on the structural problem.
 * The sum is per changed path (a blob at two paths counts twice), which is
 * conservative. The index is never touched here.
 */
async function assertStagedBudget(
  io: WorldIo, delta: StagedDelta, limits: CommitLimits,
): Promise<void> {
  if (delta.paths > limits.maxStagedPaths) {
    throw new CommitBudgetError(
      `staged paths exceed ${limits.maxStagedPaths}: ${delta.paths}`);
  }
  if (delta.objects.length === 0) return;
  const objects = delta.objects.join('\n') + '\n';
  const out = await io.gitWithStdin(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    Buffer.from(objects, 'utf8'),
  );
  let bytes = 0;
  for (const line of out.split('\n')) {
    const fields = line.split(' ');
    if (fields.length !== 3) continue;
    const size = Number(fields[2]);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    bytes += size;
    if (bytes > limits.maxStagedBytes) {
      throw new CommitBudgetError(
        `staged bytes exceed ${limits.maxStagedBytes}: ${bytes}`);
    }
  }
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
