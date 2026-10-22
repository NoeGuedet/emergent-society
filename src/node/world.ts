import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { assertNodeUid } from '../journal/index.js';
import { utf8Prefix } from '../text.js';
import {
  GitCommandError, WorldHeadError, WorldNotARepoError, WorldReconciliationError,
} from './errors.js';
import {
  FIELD, MAX_GIT_STDERR_BYTES, hashLength, isFullHex, runGit, runGitWithStdin, spawnGit,
} from './world-git.js';
import {
  assertDedicated, assertExternalGitDir, canonicalWorldPath, lstatOrNull, migrationNote,
  verifyGitDirTrust,
} from './world-trust.js';
import type {
  BoundedText, CommitRange, DiffCapture, ObjectFormat, WorldCommitInfo, WorldRange,
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
 * `open` runs live in `world-trust.ts`; this module owns the repository's policy.
 *
 * The git directory lives *outside* the world (`<home>/world.git` in
 * production): confinement makes the world agent-writable, and a writable git
 * configuration, hook set or ref store would let the shell execute code as the
 * kernel through the kernel's own git calls. `open` therefore verifies the
 * external pair and the git dir's trust inputs on every start.
 */

/** The `git log` format the parser reads: hash, author name, subject. */
const LOG_FORMAT = `--format=%H${FIELD}%an`;
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
 * The longest author record the wake scan will hold while waiting for its
 * terminator. A uid is at most 128 characters, so a longer record cannot be
 * this node's author: it is answered as foreign rather than buffered without
 * bound.
 */
const MAX_AUTHOR_RECORD_CHARS = 4096;

/**
 * The hermetic diff flag set (T4 step 5). `-c` are git global options and must
 * precede the subcommand; `-O/dev/null` is itself a diff option and must follow
 * it — the plan's prose lists it first, but git 2.43.0 rejects `-O` before the
 * subcommand ("unknown option"), so it is placed after `diff`, which is the only
 * position git accepts. The flag set is otherwise exactly the contract's.
 */
const HERMETIC_CONFIG: readonly string[] = [
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'color.ui=false',
  '-c', 'core.quotePath=true',
  '-c', 'diff.algorithm=myers',
  '-c', 'diff.renames=false',
  '-c', 'diff.submodule=short',
  '-c', 'diff.interHunkContext=0',
];

const HERMETIC_DIFF_ARGS: readonly string[] = [
  'diff', '-O/dev/null', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
  '--no-indent-heuristic', '--full-index', '--unified=3', '--inter-hunk-context=0',
  '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/',
];

/** What git says when another process holds the index or the ref, or when a branch compare-and-swap loses its race. */
const LOCK_CONTENTION = /index\.lock|cannot lock ref|Another git process seems to be running/i;

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

  /** The repo's object format, read once: hash validity depends on it (T4 step 1). */
  private objectFormat: ObjectFormat | null = null;

  private constructor(readonly path: string, readonly gitDir: string) {}

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
  private async gitWithStdin(args: readonly string[], input: Buffer): Promise<string> {
    return runGitWithStdin(this.path, [...this.gitBaseArgs(), ...args], input);
  }

  /**
   * The commit HEAD points at, or null while the branch is unborn (the world
   * exists but holds no commit yet).
   *
   * @throws GitCommandError when git itself fails.
   */
  async headHash(): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
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
   *
   * HEAD can move *backward* behind the watermark: a peer force-resets the
   * branch to an ancestor. Then HEAD !== `from` while `from..HEAD` is empty, and
   * an empty range is not "no movement" — the node cannot prove it has seen this
   * history either, so it is given all of it. The ancestor test runs only for an
   * empty range; a non-empty one is ordinary forward movement.
   */
  async commitsSince(from: string | null): Promise<WorldCommitInfo[]> {
    const head = await this.headHash();
    // No HEAD, or HEAD unmoved: the range is empty without asking git for it.
    if (head === null || head === from) return [];
    try {
      const out = await this.git(['log', LOG_FORMAT, from === null ? 'HEAD' : `${from}..HEAD`]);
      const commits = out.split('\n').filter((line) => line !== '').map(parseCommit).reverse();
      if (commits.length === 0 && from !== null && (await this.isAncestor(head, from))) {
        return this.commitsSince(null);
      }
      return commits;
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
   * Whether HEAD carries a commit `from` does not that someone other than
   * `author` wrote — the wake predicate's whole question (kernel.md §5.2),
   * answered without materializing the range.
   *
   * The author stream is read line by line and the child is stopped at the first
   * foreign author, so memory is bounded by one line however long the history
   * is: a fresh node joining a large world, or an unreachable watermark, cannot
   * overflow the exec bound and park forever on a swallowed failure.
   *
   * Watermark physics mirrors `commitsSince`: an unmoved HEAD is no movement; a
   * watermark git can no longer resolve is unprovable, so the whole history is
   * scanned; a non-zero exit after the first read retries the whole history; and
   * an empty range under a moved HEAD is checked for a backward reset (HEAD an
   * ancestor of the watermark), which is likewise scanned in full.
   *
   * @throws GitCommandError when git fails and there is no watermark to blame.
   */
  async hasForeignCommit(from: string | null, author: string): Promise<boolean> {
    const head = await this.headHash();
    if (head === null || head === from) return false;
    try {
      const scan = await this.foreignAuthorIn(
        from === null ? ['HEAD'] : [`${from}..HEAD`], author);
      if (scan === 'foreign') return true;
      // An empty `head !== from` range cannot be forward movement: HEAD may have
      // moved backward behind the watermark (a peer's force-reset). The node
      // cannot prove what it has seen, so the whole history answers instead.
      if (from !== null && scan === 'empty' && (await this.isAncestor(head, from))) {
        return (await this.foreignAuthorIn(['HEAD'], author)) === 'foreign';
      }
      return false;
    } catch (err) {
      if (from !== null && err instanceof GitCommandError) return this.hasForeignCommit(null, author);
      throw err;
    }
  }

  /**
   * Whether `spec`'s history holds an author other than `author`, from the
   * streamed `git log --format=format:%an%x00`. At most one partial record and
   * bounded stderr are held, and the child is killed as soon as a foreign record
   * is seen. The stream is not a bounded render of history: it is an existence
   * test, so stopping early is the answer, not a truncation. `empty`
   * distinguishes an empty range from one whose commits are all the node's own.
   *
   * The record separator is NUL, not LF, so a commit with an empty author is a
   * record of its own: an unprovable author is classified foreign (a spurious
   * wake costs a turn; a missed commit costs a fact), exactly as `commitsSince`
   * reports the empty author as `''` and the wake predicate refuses it.
   */
  private foreignAuthorIn(
    spec: readonly string[], author: string,
  ): Promise<'foreign' | 'empty' | 'self-only'> {
    const args = [...this.gitBaseArgs(), 'log', '--format=format:%an%x00', ...spec];
    return new Promise<'foreign' | 'empty' | 'self-only'>((resolvePromise, reject) => {
      const child = spawnGit(args, { cwd: this.path });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let partial = '';
      let stderr = '';
      let seen = false;
      let settled = false;
      const settle = (
        failure: GitCommandError | null, answer: 'foreign' | 'empty' | 'self-only',
      ): void => {
        if (settled) return;
        settled = true;
        if (failure !== null) reject(failure);
        else resolvePromise(answer);
      };
      const foreign = (record: string): boolean => {
        // `format:` separates records with LF; the record itself carries none.
        const name = record.startsWith('\n') ? record.slice(1) : record;
        // An empty author cannot be proven to be this node: foreign.
        return name === '' || name !== author;
      };
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        partial += chunk;
        let end = partial.indexOf('\0');
        while (end !== -1) {
          const record = partial.slice(0, end);
          partial = partial.slice(end + 1);
          seen = true;
          if (foreign(record)) {
            child.kill();
            settle(null, 'foreign');
            return;
          }
          end = partial.indexOf('\0');
        }
        // An unterminated record past the bound cannot be a uid: answer foreign
        // rather than hold an unbounded identity in memory.
        if (partial.length > MAX_AUTHOR_RECORD_CHARS) {
          child.kill();
          settle(null, 'foreign');
        }
      });
      child.stderr.on('data', (chunk: string) => {
        const room = MAX_GIT_STDERR_BYTES - stderr.length;
        if (room > 0) stderr += chunk.slice(0, room);
      });
      child.on('error', (err) => settle(new GitCommandError(args, null, String(err)), 'empty'));
      child.on('close', (code) => {
        if (settled) return;
        // A trailing record without its separator is only possible from a
        // truncated stream; classify it the same conservative way.
        if (partial !== '') {
          seen = true;
          if (foreign(partial)) {
            settle(null, 'foreign');
            return;
          }
        }
        if (code === 0) settle(null, seen ? 'self-only' : 'empty');
        else settle(new GitCommandError(args, code, stderr), 'empty');
      });
    });
  }

  /** The repository's object format, read from git once and cached. */
  private async format(): Promise<ObjectFormat> {
    if (this.objectFormat === null) {
      const out = (await this.git(['rev-parse', '--show-object-format'])).trim();
      this.objectFormat = out === 'sha256' ? 'sha256' : 'sha1';
    }
    return this.objectFormat;
  }

  /**
   * The exact stdout of `git --version`, trailing line ending trimmed. Recorded
   * in every perception so replay can reject a differing exact version rather
   * than promising byte equality across arbitrary versions (T4 step 2).
   */
  async gitVersion(): Promise<string> {
    return (await this.git(['--version'])).replace(/\r?\n$/, '');
  }

  /** The first parent of `commit`, or null for a root. Merge patches use it (T4 step 3). */
  async firstParent(commit: string): Promise<string | null> {
    const out = (await this.git(['show', '-s', '--format=%P', commit])).trim();
    const first = out.split(' ')[0] ?? '';
    return first === '' ? null : first;
  }

  /** Refuses a hash that is not full hex in the repository's object format. */
  private async assertHash(value: string, where: 'from' | 'to'): Promise<void> {
    if (!isFullHex(await this.format(), value)) {
      throw new Error(`invalid ${where} hash: ${value}`);
    }
  }

  /** Verifies `commit` names a commit; a missing object propagates the git failure (T4 step 1). */
  private async verifyCommit(commit: string): Promise<void> {
    await this.git(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  }

  /** Whether `commit` exists as a commit: the only "missing" signal is git's exit 1. */
  private async commitExists(commit: string): Promise<boolean> {
    try {
      await this.verifyCommit(commit);
      return true;
    } catch (err) {
      // Exit 1 is git's "unknown revision"; anything else (EIO/EACCES/spawn) is
      // an environment failure and must not be mistaken for a missing object.
      if (err instanceof GitCommandError && err.exitCode === 1) return false;
      throw err;
    }
  }

  /** Whether `from` is an ancestor of `to`; exits 0/1 carry the answer, else fail. */
  private async isAncestor(from: string, to: string): Promise<boolean> {
    try {
      await this.git(['merge-base', '--is-ancestor', from, to]);
      return true;
    } catch (err) {
      if (err instanceof GitCommandError && err.exitCode === 1) return false;
      throw err;
    }
  }

  /** The empty-tree object hash, generated from empty stdin; never a hardcoded SHA-1. */
  private async emptyTree(): Promise<string> {
    return (await this.gitWithStdin(['hash-object', '-t', 'tree', '--stdin'], Buffer.alloc(0))).trim();
  }

  /** The tree object of a commit; a missing object propagates the git failure. */
  private async treeOf(commit: string): Promise<string> {
    return (await this.git(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`])).trim();
  }

  /** Author names for a batch of hashes, keyed by full hash. */
  private async authorsOf(hashes: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (hashes.length === 0) return map;
    const out = await this.git(['log', '--no-walk=unsorted', LOG_FORMAT, ...hashes]);
    for (const line of out.split('\n')) {
      if (line === '') continue;
      const commit = parseCommit(line);
      map.set(commit.hash, commit.author);
    }
    return map;
  }

  /**
   * A bounded, verified traversal of `range` (T4 step 1–3): the newest
   * `maxCommits` commits from oldest-first topology, the verified traversal base
   * and the reason a fallback happened. A `from` that is missing or not an
   * ancestor of `to` falls back to full history; only those two explicit
   * outcomes do — git environment failures propagate.
   */
  async commitsIn(range: WorldRange, maxCommits: number): Promise<CommitRange> {
    if (!Number.isSafeInteger(maxCommits) || maxCommits < 1 || maxCommits > 4096) {
      throw new Error(`maxCommits must be an integer in [1, 4096], got ${maxCommits}`);
    }
    if (range.from !== null) await this.assertHash(range.from, 'from');
    if (range.to !== null) await this.assertHash(range.to, 'to');

    if (range.to === null) {
      return { commits: [], effectiveFrom: null, fallback: 'none', listTruncated: false };
    }
    if (range.from !== null && range.from === range.to) {
      return { commits: [], effectiveFrom: range.from, fallback: 'none', listTruncated: false };
    }
    await this.verifyCommit(range.to);

    let base: string | null = range.from;
    let fallback: 'none' | 'unreachable-from' = 'none';
    if (range.from !== null) {
      if (!(await this.commitExists(range.from)) || !(await this.isAncestor(range.from, range.to))) {
        base = null;
        fallback = 'unreachable-from';
      }
    }

    const spec = base === null ? range.to : `${base}..${range.to}`;
    const out = await this.git(['rev-list', '--topo-order', `--max-count=${maxCommits + 1}`, spec]);
    const newest = out.split('\n').filter((line) => line !== '');
    const listTruncated = newest.length > maxCommits;
    // rev-list is newest-first; the extra oldest commit is dropped and the rest
    // reversed to oldest-first deterministic topology.
    const selectedNewest = listTruncated ? newest.slice(0, maxCommits) : newest;
    const selectedOldest = [...selectedNewest].reverse();
    const authors = await this.authorsOf(selectedOldest);
    const commits = selectedOldest.map((hash) => ({ hash, author: authors.get(hash) ?? '' }));
    return { commits, effectiveFrom: base, fallback, listTruncated };
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
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error(`maxBytes must be a positive integer, got ${maxBytes}`);
    }
    if (range.from !== null) await this.assertHash(range.from, 'from');
    if (range.to !== null) await this.assertHash(range.to, 'to');

    if (range.to === null) return { text: '', truncated: false, bytesRetained: 0 };
    if (range.from !== null && range.from === range.to) {
      return { text: '', truncated: false, bytesRetained: 0 };
    }

    const toTree = await this.treeOf(range.to);
    const fromTree = range.from === null
      ? await this.emptyTree()
      : (await this.commitExists(range.from) ? await this.treeOf(range.from) : await this.emptyTree());

    const scratch = await this.openScratchView();
    let result: BoundedText | undefined;
    let failed = false;
    let failure: unknown;
    try {
      const env: Record<string, string> = {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        LC_ALL: 'C',
        GIT_ATTR_SOURCE: range.to,
      };
      const args = [`--git-dir=${scratch}`, ...HERMETIC_CONFIG, ...HERMETIC_DIFF_ARGS, fromTree, toTree, '--'];
      result = await this.streamDiff(args, env, maxBytes);
    } catch (err) {
      failed = true;
      failure = err;
    }
    // The scratch view is always removed, but a render failure outranks a
    // cleanup failure so the original git error is never masked by `rm`.
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (err) {
      if (!failed) {
        failed = true;
        failure = err;
      }
    }
    if (failed) throw failure;
    return result!;
  }

  /**
   * Creates the isolated bare metadata view: a temporary GIT_DIR whose
   * `objects/info/alternates` points at the world's object database (shared, no
   * repository copy), with no `info/attributes` and an empty config. A failure
   * here rejects, so the renderer never silently falls back to the world.
   */
  private async openScratchView(): Promise<string> {
    const scratch = await mkdtemp(join(tmpdir(), 'c13-render-'));
    await mkdir(join(scratch, 'objects', 'info'), { recursive: true });
    await mkdir(join(scratch, 'refs'), { recursive: true });
    await writeFile(join(scratch, 'objects', 'info', 'alternates'), `${join(this.gitDir, 'objects')}\n`);
    // The scratch git dir is explicit (`--git-dir=`), so git derives the object
    // format from *its* config, not the world's. An empty config means "sha1"
    // and rejects a sha256 world's 64-hex ids, so the scratch view declares the
    // world's own format (validated by `format()`; no other setting is read).
    const format = await this.format();
    await writeFile(join(scratch, 'config'), format === 'sha256'
      ? '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n'
      : '');
    await writeFile(join(scratch, 'HEAD'), 'ref: refs/heads/main\n');
    return scratch;
  }

  /**
   * Streams one hermetic diff to at most `maxBytes` decoded UTF-8 bytes. Invalid
   * bytes become deterministic U+FFFD; hitting the cap kills the child and is
   * the only accepted truncation, while any other nonzero exit or signal is an
   * error. stderr is bounded and never the payload.
   *
   * The scratch view is this call's sole git dir (`--git-dir=`), so the pair is
   * deliberately absent here: git's last-wins rule would let a `--git-dir` after
   * the scratch one mask it. Only the two defense-in-depth overrides are
   * prepended.
   */
  private streamDiff(
    args: readonly string[], env: Record<string, string>, maxBytes: number,
  ): Promise<BoundedText> {
    return new Promise<BoundedText>((resolvePromise, rejectPromise) => {
      const child = spawnGit([
        '-c', 'log.showSignature=false', '-c', 'core.hooksPath=/dev/null', ...args,
      ], { cwd: this.path, env });
      const decoder = new TextDecoder('utf-8');
      let text = '';
      let bytes = 0;
      let truncated = false;
      let capped = false;
      let stderr = Buffer.alloc(0);

      child.stdout.on('data', (chunk: Buffer) => {
        if (capped) return;
        const decoded = decoder.decode(chunk, { stream: true });
        const prefix = utf8Prefix(decoded, maxBytes - bytes);
        text += prefix.text;
        bytes += prefix.bytes;
        if (prefix.text.length < decoded.length) {
          capped = true;
          truncated = true;
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const room = MAX_GIT_STDERR_BYTES - stderr.length;
        if (room > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, room)]);
      });
      child.on('error', (err) => {
        if (!capped) rejectPromise(new GitCommandError(args, null, String(err)));
      });
      child.on('close', (code, signal) => {
        if (capped) {
          resolvePromise({ text, truncated: true, bytesRetained: bytes });
          return;
        }
        // Flush the streaming decoder: a truncated input sequence becomes its
        // deterministic U+FFFD, and the tail is bounded like the rest.
        const tail = decoder.decode();
        if (tail !== '') {
          const prefix = utf8Prefix(tail, maxBytes - bytes);
          text += prefix.text;
          bytes += prefix.bytes;
          if (prefix.text.length < tail.length) truncated = true;
        }
        if (signal !== null || code !== 0) {
          rejectPromise(new GitCommandError(args, code ?? null, stderr.toString('utf8')));
          return;
        }
        resolvePromise({ text, truncated, bytesRetained: bytes });
      });
    });
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
      if (!isFullHex(await this.format(), base)) {
        throw new WorldReconciliationError(
          `interrupted turn ${turn}: base ${JSON.stringify(base)} is not a full commit id`);
      }
      if (!(await this.commitExists(base)) || !(await this.isAncestor(base, head))) {
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
    const parentTree = before === null ? await this.emptyTree() : await this.treeOf(before);
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
    const expected = before ?? '0'.repeat(hashLength(await this.format()));
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
