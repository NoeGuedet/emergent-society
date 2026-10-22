import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { assertNodeUid } from '../journal/index.js';
import {
  GitCommandError, WorldHeadError, WorldNotARepoError, WorldReconciliationError,
} from './errors.js';
import { renderDiff } from './world-diff.js';
import {
  FIELD, commitExists, emptyTree, hashLength, isAncestor, isFullHex, readHead, runGit,
  runGitWithStdin, treeOf, type WorldIo,
} from './world-git.js';
import {
  commitsIn as traverseCommitsIn, commitsSince as listCommitsSince,
  firstParent as firstParentOf, hasForeignCommit as detectForeignCommit, readGitVersion,
} from './world-history.js';
import {
  assertDedicated, assertExternalGitDir, canonicalWorldPath, lstatOrNull, migrationNote,
  verifyGitDirTrust,
} from './world-trust.js';
import type {
  CommitRange, DiffCapture, ObjectFormat, WorldCommitInfo, WorldRange,
} from './world-types.js';

export { gitEnv } from './world-git.js';
export { realpathOrSelf } from './world-trust.js';
export type { WorldCommitInfo, WorldRange, DiffCapture, RecordedCommit, CommitRange } from './world-types.js';

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
 * The git CLI is driven as an external process rather than through a library:
 * the commit is a mechanism the kernel must be able to audit byte for byte, and
 * `git` is the only implementation of git whose behavior is a fact. The process
 * layer — the controlled environment, the output bound and the spawn lifecycle
 * — lives in `world-git.ts`; the path safeguards and the three trust layers
 * `open` runs live in `world-trust.ts`; the history reads — the wake range, the
 * author scan, the bounded traversal — live in `world-history.ts`; the hermetic
 * patch renderer lives in `world-diff.ts`; this module owns the repository's
 * policy and is the façade over all four.
 *
 * The git directory lives *outside* the world (`<home>/world.git` in
 * production): confinement makes the world agent-writable, and a writable git
 * configuration, hook set or ref store would let the shell execute code as the
 * kernel through the kernel's own git calls. `open` therefore verifies the
 * external pair and the git dir's trust inputs on every start.
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

const delay = (ms: number): Promise<void> => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, ms);
});

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

const NOOP = (): void => {};

/**
 * The world repository: HEAD reads for the wake predicate, and the serialized
 * commit-per-turn that closes a node's turn.
 */
export class WorldRepo {
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
   * An entry lives only while a commit is queued or running (`serialize` prunes
   * it), so the map does not grow with every world a long-lived process opens.
   */
  private static readonly commitQueues = new Map<string, Promise<unknown>>();

  /**
   * What the `world-*` siblings need from this repository: its paths, the pair
   * and defense-in-depth `-c`s every call carries, and the three policy seams.
   * `head` and `nothingStaged` are bound to this object's methods deliberately —
   * a test double replaces those on the prototype, and every free function's
   * HEAD read and staged-nothing question must stay observable there.
   */
  private readonly io: WorldIo;

  private constructor(readonly path: string, readonly gitDir: string) {
    // Built in the body, never as a field initializer: an initializer runs before
    // the parameter properties are assigned, so `path`/`gitDir` would be unset
    // (TS2729).
    let cachedFormat: ObjectFormat | null = null;
    this.io = {
      path: this.path,
      gitDir: this.gitDir,
      baseArgs: () => this.gitBaseArgs(),
      head: () => this.headHash(),
      nothingStaged: () => this.nothingStaged(),
      git: (args, env) => this.git(args, env),
      gitWithStdin: (args, input) => this.gitWithStdin(args, input),
      // Only the resolved format is memoized: a failed `rev-parse` must be
      // retried by the next call, so a rejection is never cached.
      format: async () => {
        if (cachedFormat !== null) return cachedFormat;
        const out = (await this.git(['rev-parse', '--show-object-format'])).trim();
        cachedFormat = out === 'sha256' ? 'sha256' : 'sha1';
        return cachedFormat;
      },
    };
  }

  /**
   * Opens the world repository rooted at `dir`, with its kernel-owned git dir.
   *
   * The pair is verified on every open (arbitration 11): the git dir must live
   * outside the world, its configuration must come wholly from its own
   * `config`, its metadata tree must be free of symlinks and multi-linked
   * files, and git itself must confirm that `core.worktree` names this root and
   * that the pair resolves to the given git dir. An in-world `.git` entry is
   * ignored: the kernel addresses its git dir explicitly, and refusing the
   * stray entry would hand the shell a permanent boot-denial via `mkdir .git`.
   *
   * @throws UnsafeWorldPathError when `dir` resolves to `$HOME` or a broad root,
   * or when the git dir does.
   * @throws WorldNotARepoError when the world is not a directory, the git dir
   * is absent or overlaps the world, or any trust layer refuses — always with
   * the offending key/file and the sanitizing migration in the message.
   */
  static async open(dir: string, opts: { readonly gitDir: string }): Promise<WorldRepo> {
    const root = await canonicalWorldPath(dir);
    const rootEntry = await lstat(root);
    if (!rootEntry.isDirectory()) {
      throw new WorldNotARepoError(root, 'the world root is not a directory');
    }
    const given = resolve(opts.gitDir);
    let gitDir: string;
    try {
      gitDir = await realpath(given);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      throw new WorldNotARepoError(
        root, `the git directory ${given} does not exist. ${migrationNote(root, given)}`);
    }
    if (!(await lstat(gitDir)).isDirectory()) {
      throw new WorldNotARepoError(root, `the git directory ${gitDir} is not a directory`);
    }
    assertExternalGitDir(root, gitDir);
    await assertDedicated(gitDir);
    // Layers 1–3 — the config scan, the metadata battery and the pair check.
    await verifyGitDirTrust(root, gitDir);
    return new WorldRepo(root, gitDir);
  }

  /**
   * Creates the world repository with an external git dir. The kernel owns
   * this, not a node: the world exists before the first node boots.
   *
   * The initial branch is pinned rather than left to `init.defaultBranch`: the
   * kernel runs git under a controlled environment (see `gitEnv`), so a host
   * gitconfig must not decide the world's branch any more than it decides the
   * kernel's identity. The untracked cache is enabled because it is the one
   * index extension that is a pure win here; the FSMonitor is not (unavailable
   * on Linux, §7).
   *
   * @throws UnsafeWorldPathError when the world or the git dir is `$HOME` or a
   * broad root.
   * @throws WorldNotARepoError when the git dir overlaps the world or the world
   * already carries a `.git` entry.
   */
  static async init(dir: string, opts: { readonly gitDir: string }): Promise<WorldRepo> {
    // The directory is created first, then resolved and checked: `mkdir` on a
    // symlink to `$HOME` is a no-op, so nothing is written before the refusal.
    const given = resolve(dir);
    await mkdir(given, { recursive: true });
    const path = await canonicalWorldPath(given);
    // The git dir's parent is created first; the leaf is created only after the
    // containment check, so a refused init leaves no git dir behind. The
    // lexical check runs before the parent exists; the canonical one after.
    const requested = resolve(opts.gitDir);
    assertExternalGitDir(path, requested);
    await mkdir(dirname(requested), { recursive: true });
    const gitDir = join(await realpath(dirname(requested)), basename(requested));
    assertExternalGitDir(path, gitDir);
    await assertDedicated(gitDir);
    await mkdir(gitDir);
    if (await lstatOrNull(join(path, '.git')) !== null) {
      throw new WorldNotARepoError(
        path,
        `the world already contains a .git entry and cannot be re-initialized in place. `
          + migrationNote(path, gitDir));
    }
    await runGit(path, ['--git-dir', gitDir, '--work-tree', path, 'init', '--quiet', '--initial-branch=main']);
    await runGit(path, ['--git-dir', gitDir, '--work-tree', path, 'config', 'core.untrackedCache', 'true']);
    return WorldRepo.open(path, { gitDir });
  }

  /**
   * The pair and defense-in-depth `-c`s prepended to every kernel git call on
   * the opened repo (layer 4): the explicit pair keeps git off the worktree's
   * `.git`, the signature override stops `log`/`show` from running a configured
   * `gpg.program` over a signed commit, and the hooks override covers the
   * `reference-transaction` hook `update-ref` runs.
   */
  gitBaseArgs(): readonly string[] {
    return [
      '--git-dir', this.gitDir, '--work-tree', this.path,
      '-c', 'log.showSignature=false', '-c', 'core.hooksPath=/dev/null',
    ];
  }

  /**
   * Runs one git command against the opened repo with the pair and the
   * defense-in-depth overrides prepended.
   */
  private async git(args: readonly string[], env?: Record<string, string>): Promise<string> {
    return runGit(this.path, [...this.gitBaseArgs(), ...args], env);
  }

  /** Runs one git command feeding `input` on stdin, with the same prefix. */
  private async gitWithStdin(args: readonly string[], input: Uint8Array): Promise<string> {
    return runGitWithStdin(this.path, [...this.gitBaseArgs(), ...args], input);
  }

  /**
   * The commit HEAD points at, or null while the branch is unborn (the world
   * exists but holds no commit yet).
   *
   * @throws GitCommandError when git itself fails.
   */
  async headHash(): Promise<string | null> {
    return readHead(this.io);
  }

  /**
   * The commits HEAD carries that `from` does not, oldest first; `from` null is
   * the whole history — the perception of a node that has never looked
   * (`world-history.ts` for the watermark physics).
   */
  async commitsSince(from: string | null): Promise<WorldCommitInfo[]> {
    return listCommitsSince(this.io, from);
  }

  /**
   * Whether HEAD carries a commit `from` does not that someone other than
   * `author` wrote — the wake predicate's whole question (kernel.md §5.2),
   * answered without materializing the range (`world-history.ts`).
   *
   * @throws GitCommandError when git fails and there is no watermark to blame.
   */
  async hasForeignCommit(from: string | null, author: string): Promise<boolean> {
    return detectForeignCommit(this.io, from, author);
  }

  /**
   * The exact stdout of `git --version`, trailing line ending trimmed. Recorded
   * in every perception so replay can reject a differing exact version rather
   * than promising byte equality across arbitrary versions (T4 step 2).
   */
  async gitVersion(): Promise<string> {
    return readGitVersion(this.io);
  }

  /** The first parent of `commit`, or null for a root. Merge patches use it (T4 step 3). */
  async firstParent(commit: string): Promise<string | null> {
    return firstParentOf(this.io, commit);
  }

  /**
   * A bounded, verified traversal of `range` (T4 step 1–3): the newest
   * `maxCommits` commits from oldest-first topology, the verified traversal base
   * and the reason a fallback happened. A `from` that is missing or not an
   * ancestor of `to` falls back to full history; only those two explicit
   * outcomes do — git environment failures propagate.
   */
  async commitsIn(range: WorldRange, maxCommits: number): Promise<CommitRange> {
    return traverseCommitsIn(this.io, range, maxCommits);
  }

  /**
   * The bounded, hermetic patch of one range (T4 step 4–6): a `from-tree →
   * to-tree` diff run against an isolated bare metadata view whose object
   * database is the world's, with the exact flag/env policy that removes the
   * working-tree attributes, `.git/info/attributes`, repo-local diff drivers
   * and host `diff.orderFile` as inputs. A `null`/missing `from` uses the empty
   * tree; a missing `to` rejects. The renderer fails closed: any failure to
   * build the view or run git rejects rather than falling back to the working
   * tree. Emission is capped at `maxBytes` decoded bytes with deterministic
   * U+FFFD replacement.
   */
  async diff(range: WorldRange, maxBytes: number): Promise<DiffCapture> {
    return renderDiff(this.io, range, maxBytes);
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
  async commitAll(author: string, message: string): Promise<WorldCommitInfo | null> {
    // The author becomes the commit's git identity, so it must be a uid the
    // kernel can vouch for: a separator or a control character here is a
    // malformed identity, and this is where it is refused — before the queue,
    // before `add`, before anything exists to undo. History already written by
    // someone else is never re-validated: foreign author names stay facts.
    assertNodeUid(author);
    return this.serialize(() => this.commitRetrying(author, message));
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
   * only refuses to guess.
   *
   * `base` null means the turn opened on an unborn branch, so the whole reachable
   * history is after it. A non-null `base` that is missing, malformed or no
   * longer an ancestor of HEAD fails closed rather than falling back to all
   * history; a walk past the bound fails closed rather than truncating. The
   * compare-and-swap loser of a failed publish is unreachable from HEAD, so it is
   * never a candidate, and nothing here mutates history or runs gc.
   *
   * @throws WorldReconciliationError when the base is unreachable, the walk is
   * bounded out, or the search cannot name one commit without guessing.
   */
  async commitsForTurn(
    base: string | null, uid: string, turn: number,
  ): Promise<readonly WorldCommitInfo[]> {
    const subject = `turn ${turn}`;
    const head = await this.headHash();
    if (head === null) {
      if (base !== null) {
        throw new WorldReconciliationError(
          `interrupted turn ${turn}: base ${base} is unreachable on an unborn branch`);
      }
      return [];
    }
    if (base !== null) {
      if (!isFullHex(await this.io.format(), base)) {
        throw new WorldReconciliationError(
          `interrupted turn ${turn}: base ${JSON.stringify(base)} is not a full commit id`);
      }
      if (!(await commitExists(this.io, base)) || !(await isAncestor(this.io, base, head))) {
        throw new WorldReconciliationError(
          `interrupted turn ${turn}: base ${base} is not an ancestor of HEAD`);
      }
    }
    const spec = base === null ? head : `${base}..${head}`;
    const out = await this.git([
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
  private async commitOnce(author: string, message: string): Promise<WorldCommitInfo | null> {
    const headRef = await this.headRef();
    const before = await this.headHash();
    // A world subdirectory the agent ran `git init` in is a *nested* repository,
    // and staging it would break the turn twice: an unborn one makes the whole
    // `add --all` fail ("does not have a commit checked out"), and a committed
    // one stages a `160000 commit <hash>` gitlink whose object lives only in the
    // agent's repo — a durable tree that references an unresolvable object and
    // whose subtree content is never committed. The pathspec exclusion is the
    // load-bearing half; the index sweep below is the belt.
    const nested = await this.nestedRepoDirs();
    await this.git([
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
    for (const rel of await this.stagedGitlinks()) {
      await this.git(['update-index', '--force-remove', '--', rel]);
    }
    if (await this.nothingStaged()) return null;
    const tree = (await this.git(['write-tree'])).trim();
    // The net-change guard: a tree identical to the parent's would be an empty
    // commit — a wake for every other node with no fact behind it (§5.4). The
    // empty tree stands in for an unborn branch's parent.
    const parentTree = before === null
      ? await emptyTree(this.io)
      : await treeOf(this.io, before);
    if (tree === parentTree) return null;
    // The commit object is created whether or not the branch can move; a
    // compare-and-swap loss leaves it unreferenced, and the retry makes a fresh
    // one. `-c commit.gpgsign=false -c core.hooksPath=/dev/null` keep the commit
    // independent of host configuration and of any hook — `commit-tree` runs no
    // hooks, and the explicit empty path also protects a future regression.
    const commit = (await this.git(
      [
        '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null',
        'commit-tree', tree,
        ...(before === null ? [] : ['-p', before]),
        '-m', message,
      ],
      identity(author),
    )).trim();
    await this.publish(headRef, before, commit);
    return { hash: commit, author };
  }

  /**
   * The world's directories that carry a `.git` entry (directory, file or
   * symlink), relative to the world root — the nested repositories an agent
   * created. The world root itself is skipped: a stray root-level `.git` is
   * never read by the explicit pair and is never staged by git.
   */
  private async nestedRepoDirs(): Promise<string[]> {
    const found: string[] = [];
    const visit = async (rel: string): Promise<void> => {
      const dir = rel === '' ? this.path : join(this.path, rel);
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
  private async stagedGitlinks(): Promise<string[]> {
    const links: string[] = [];
    for (const record of (await this.git(['ls-files', '--stage', '-z'])).split('\0')) {
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
  private async headRef(): Promise<string> {
    let ref: string;
    try {
      ref = (await this.git(['symbolic-ref', '--quiet', 'HEAD'])).trim();
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
   * Moves `headRef` from `before` to `commit` with a compare-and-swap.
   *
   * The expected old value is the parent this attempt was built on — or the
   * all-zero object id, sized by the repository's object format, when the branch
   * is unborn. A peer commit that landed in between makes the update fail
   * (`cannot lock ref … is at … but expected …`, which the retry loop reads as
   * contention) instead of being overwritten. HEAD is re-checked immediately
   * before the update so a branch switch during the attempt fails closed.
   */
  private async publish(headRef: string, before: string | null, commit: string): Promise<void> {
    const current = await this.headRef();
    if (current !== headRef) {
      throw new WorldHeadError(`HEAD switched from ${headRef} to ${current} during a commit`);
    }
    const expected = before ?? '0'.repeat(hashLength(await this.io.format()));
    await this.git(['update-ref', headRef, commit, expected]);
  }

  /** Whether the index matches HEAD, so a commit would have nothing to record. */
  private async nothingStaged(): Promise<boolean> {
    try {
      await this.git(['diff', '--cached', '--quiet']);
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
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const previous = WorldRepo.commitQueues.get(this.path) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(NOOP, NOOP);
    WorldRepo.commitQueues.set(this.path, settled);
    void settled.then(() => {
      if (WorldRepo.commitQueues.get(this.path) === settled) {
        WorldRepo.commitQueues.delete(this.path);
      }
    });
    return next;
  }
}
