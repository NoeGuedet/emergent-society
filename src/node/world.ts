import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { WorldNotARepoError } from './errors.js';
import {
  commitAll as commitWorkingTree, commitQueues, commitsForTurn as findTurnCommits,
  nothingStaged as stagedNothing,
} from './world-commit.js';
import { renderDiff } from './world-diff.js';
import { readHead, runGit, runGitWithStdin, type WorldIo } from './world-git.js';
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
 * The git CLI is driven as an external process, never through a library:
 * `world-git.ts`'s header owns the rationale (the commit must be auditable byte
 * for byte), and the process layer — the controlled environment, the output
 * bound and the spawn lifecycle — lives there. The path safeguards and the
 * three trust layers `open` runs live in `world-trust.ts`;
 * the history reads — the wake range, the author scan, the bounded traversal —
 * live in `world-history.ts`; the hermetic patch renderer lives in
 * `world-diff.ts`; the commit machinery — staging, the plumbing commit, the
 * queue and the reconciliation search — lives in `world-commit.ts`; the shared
 * data shapes live in `world-types.ts`; this module owns the repository's policy
 * and is the façade over all six (the five behavioural siblings plus the data
 * shapes in `world-types.ts`).
 *
 * The git directory lives *outside* the world (`<home>/world.git` in
 * production): confinement makes the world agent-writable, and a writable git
 * configuration, hook set or ref store would let the shell execute code as the
 * kernel through the kernel's own git calls. `open` therefore verifies the
 * external pair and the git dir's trust inputs on every start.
 */

/**
 * The world repository: HEAD reads for the wake predicate, and the serialized
 * commit-per-turn that closes a node's turn.
 */
export class WorldRepo {
  /**
   * The commit queue itself lives at module level in `world-commit.ts`: one
   * queue per canonical root, so two instances opened on the same world share
   * it, and a finished entry is pruned here when it is the map's tail. This is
   * the queue's handle on the class surface, not a second copy.
   */
  static readonly commitQueues = commitQueues;

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
   * The staged-nothing question the commit machinery asks (`world-commit.ts`):
   * a one-line delegate kept as a prototype method because `io.nothingStaged`
   * binds to it, and the prototype is what a test double spies on.
   */
  private async nothingStaged(): Promise<boolean> {
    return stagedNothing(this.io);
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

  /** See `readGitVersion`. */
  async gitVersion(): Promise<string> {
    return readGitVersion(this.io);
  }

  /** See `firstParent`. */
  async firstParent(commit: string): Promise<string | null> {
    return firstParentOf(this.io, commit);
  }

  /** See `commitsIn`. */
  async commitsIn(range: WorldRange, maxCommits: number): Promise<CommitRange> {
    return traverseCommitsIn(this.io, range, maxCommits);
  }

  /** See `renderDiff`. */
  async diff(range: WorldRange, maxBytes: number): Promise<DiffCapture> {
    return renderDiff(this.io, range, maxBytes);
  }

  /**
   * Commits the working tree as one commit authored by `author`, or null when
   * the turn changed nothing (`world-commit.ts` for the queue, the bounded
   * retry and the plumbing commit).
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
    return commitWorkingTree(this.io, author, message);
  }

  /**
   * The commits a node authored for one turn, reachable from HEAD but not from
   * the turn's opening `base` — the search that reconciles an interrupted turn
   * whose own commit landed and whose closer did not (kernel.md §3). Every
   * match is returned; choosing among several is the caller's job
   * (`world-commit.ts` for the candidate test and the bound).
   *
   * @throws WorldReconciliationError when the base is unreachable or the walk is
   * bounded out.
   */
  async commitsForTurn(
    base: string | null, uid: string, turn: number,
  ): Promise<readonly WorldCommitInfo[]> {
    return findTurnCommits(this.io, base, uid, turn);
  }
}
