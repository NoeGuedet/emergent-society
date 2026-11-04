import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { HUMAN_AUTHOR, ensureDurableDirectory } from '../journal/index.js';
import { singleLine } from '../text.js';
import { delay } from '../util.js';
import { GitCommandError, WorldHeadError } from './errors.js';
import { LOCK_CONTENTION } from './world-commit.js';
import {
  chmodFd,
  lstatAt,
  openLeafAt,
  openPinnedParent,
  openPinnedRoot,
  realpathFd,
  renameAt,
  unlinkAt,
  WorldFsError,
  WorldFsMissingError,
} from './world-fs.js';
import {
  emptyTree, hashLength, readHead, runGit, runGitWithStdin, treeOf, type WorldIo,
} from './world-git.js';
import type { WorldRepo } from './world.js';
import type { ObjectFormat } from './world-types.js';

/**
 * The human's ratification: the ONE world-writing act outside a node's turn.
 *
 * `direct --path <world-relative> --file <abs>` validates the operator's bytes
 * elsewhere (the host command: regular file, UTF-8, bounded, `providers.json`
 * refused by path AND inode) and hands them here. This module owns the commit
 * machinery only — nothing in it reads the operator's path, so there is no
 * TOCTOU between the validated bytes and the object that the commit carries:
 * the bytes are hashed through git STDIN (`hash-object -w --stdin`).
 *
 * THE AUDITED SHAPE, clause by clause:
 *
 * - **A fresh private index per attempt.** `GIT_INDEX_FILE` is a unique temp in
 *   `<home>/.es` (the same filesystem, owner-only, derived from the opened git
 *   dir the way the world flock is), seeded with `read-tree` at the CURRENT
 *   HEAD — or an EMPTY index for an unborn HEAD, whose commit is a ROOT commit
 *   (no `-p`, the zero-oid CAS; the kernel's own `commitOnce` precedent). The
 *   temp index is unlinked in a `finally`, and its name is unique, so a crashed
 *   run's stale index can never poison the next.
 * - **The mode rule.** `100644` for a new file; `ls-tree HEAD -- <path>` for an
 *   existing one; an existing NON-REGULAR entry (a symlink `120000`, a gitlink
 *   `160000`, a directory `040000`) is a TEACHING REFUSAL, never a silent
 *   tree/worktree disagreement. `update-index --add --cacheinfo <mode>,<blob>,
 *   <path>` writes that one entry.
 * - **The tree, then the parent it was actually built on.** `write-tree`, then
 *   a comparison against `treeOf` of the parent this attempt READ (not HEAD as
 *   it may have moved): an identical tree commits nothing.
 * - **The author `human` — one deliberate, auditable bypass of
 *   `assertNodeUid`.** This is that named seam: the uid reservation (no node may
 *   ever be `human`) is what makes the author trustworthy, so the commit path's
 *   usual uid validation is not applied to the reserved ratifier. `commit-tree`
 *   carries BOTH identity pairs (author and committer, the derived email; the
 *   global config is neutralized by the git process layer), with an explicit
 *   `-c commit.gpgsign=false -c core.hooksPath=/dev/null`, so a hostile
 *   `GIT_AUTHOR_NAME` in the operator's environment is overridden.
 * - **The compare-and-swap, and the whole-attempt retry.** `update-ref` expects
 *   the parent this attempt built on (or the all-zero object id for an unborn
 *   branch). Contention — a held world/index lock, a moving ref — re-seeds the
 *   WHOLE attempt: the parent is re-read, the index re-seeded at it, the tree
 *   rebuilt, the commit recreated. A stale tree is therefore impossible and a
 *   peer that landed between attempts becomes the new parent. NEVER `add --all`,
 *   NEVER the shared index for the commit, NEVER `git commit` (it writes
 *   `.git/COMMIT_EDITMSG`, which concurrent commits race on).
 * - **Materialize-first ordering.** The bytes are pre-written to a temp in
 *   `<home>/.es` BEFORE the CAS; after the CAS the worktree copy is renamed into
 *   place IMMEDIATELY through the contained chain (the no-follow walk from the
 *   world root, the pinned parent fd, the `fstat`/`realpath` proof, the
 *   temp+rename), and ONLY after a successful rename is that one entry staged
 *   into the SHARED index — the optional redundant step. An index-known,
 *   worktree-absent path is exactly what a peer's `add --all` stages as a
 *   DELETION, so staging before the rename would manufacture the scar. The
 *   materialized copy also carries the committed entry's EXEC BIT (a `100755`
 *   entry is chmod'ed 0755 through the pre-written temp; an already-identical
 *   file whose exec bit drifted is fixed in place), so a node's next `add --all`
 *   never stages a silent `mode change 100755 => 100644`.
 *   The delete-scar window is NARROWED, TRANSIENT and SELF-HEALING, never closed: a
 *   peer's `add --all` inside the window still writes a tree without this path
 *   (the scar); the worktree keeps the file and the next `add --all` restores it.
 * - **The unchanged path MATERIALIZES.** An identical tree commits nothing, but
 *   "commit nothing" after a worktree deletion would leave that deletion to the
 *   next node commit — so when the worktree copy is absent or diverged it is
 *   materialized from the same validated bytes, and the caller prints the
 *   no-commit sentence. The unchanged path stages NOTHING into the shared index:
 *   no commit was made, so no index entry is owed.
 * - **Post-CAS failure precedence.** The commit's landing decides the outcome:
 *   a failed rename or a failed shared-index update is a NAMED WARNING on the
 *   returned outcome, never a silent half-act and never a failed exit code when
 *   the ref moved.
 * - **No transaction lock.** The world flock is the kernel's own per-invocation,
 *   non-blocking `flock -n` around each mutating child (exit 75 → typed
 *   contention → the bounded retry above). The stated cost: `direct`'s git calls
 *   can make a node's turn-end commit REFUSE (typed, self-retried), and a node's
 *   turn-end commit can make `direct` refuse the same way.
 *
 * The private index is written under the world flock too (the process layer's
 * rule is per-subcommand, not per-index); that costs one lock acquisition per
 * child and keeps every mutating child in the one serialization the kernel
 * already relies on. The only lock-free children are the read plumbing
 * (`read-tree`, `hash-object`, `ls-tree`, `rev-parse`, `symbolic-ref`).
 */

/** The reserved author every ratification commits under (the layout's human). */
export const RATIFY_AUTHOR: string = HUMAN_AUTHOR;

/** The commit subject's fixed first word. */
export const RATIFY_SUBJECT = 'ratify';

/** The reserved ratifier's email (derived exactly as a node's would be). */
export const RATIFY_EMAIL = 'human@world.local';

/** Attempts before a held lock or a moving ref is reported (the kernel's 4). */
const RATIFY_ATTEMPTS = 4;

/** Wait before attempt n, linear: 25, 50, 75 ms (the kernel's retry discipline). */
const RATIFY_RETRY_MS = 25;

/** The rendered warning bound: one bounded line each, never a payload. */
const MAX_WARNING_CHARS = 300;

/** Both identity pairs, explicit: a hostile environment never decides the author. */
export const RATIFY_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: RATIFY_AUTHOR,
  GIT_AUTHOR_EMAIL: RATIFY_EMAIL,
  GIT_COMMITTER_NAME: RATIFY_AUTHOR,
  GIT_COMMITTER_EMAIL: RATIFY_EMAIL,
};

/**
 * A refusal of the ratification's TARGET — a committed non-regular entry that
 * this act will not silently turn into a file. It is the operator's input, so
 * the CLI maps it to exit 2.
 */
export class RatifyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RatifyRefusedError';
  }
}

/**
 * The home could not be written for the ratification (the `.es` temp or the
 * private index). It is a runtime failure (exit 1): the stated same-uid
 * assumption failed — the host running as another uid leaves a 0600/0700 home
 * this process cannot write, and the refusal is bounded and path-free.
 */
export class RatifyIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RatifyIoError';
  }
}

/**
 * The world moved while an attempt was deciding (a peer's commit landed between
 * the HEAD read and the unchanged conclusion): the attempt is re-seeded, never
 * a stale conclusion. It rides the same bounded retry as lock/CAS contention.
 */
class RatifyRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RatifyRetryError';
  }
}

/** One ratification's outcome: the commit (or none), its shape, its warnings. */
export type RatifyOutcome = {
  /** `committed` when the ref moved; `unchanged` when the tree already held it. */
  readonly kind: 'committed' | 'unchanged';
  /** The commit this call created — null on the unchanged path. */
  readonly commit: string | null;
  /** The parent this attempt actually built on (null for a root commit). */
  readonly parent: string | null;
  /** Whether a worktree copy was renamed into place. */
  readonly materialized: boolean;
  /** Whether the shared index was staged with this one entry. */
  readonly staged: boolean;
  /** Bounded, named divergences after the decision (never a silent half-act). */
  readonly warnings: readonly string[];
};

/** Everything one ratification needs; the seams are test-only interleaves. */
export type RatifyOptions = {
  /** The validated world-relative tree path. */
  readonly path: string;
  /** The validated file bytes, hashed through git stdin. */
  readonly bytes: Uint8Array;
  readonly message?: string;
  /** Runs after `commit-tree` and before `update-ref` (the CAS-interleave seam). */
  readonly beforePublish?: (parent: string | null) => Promise<void>;
  /** Runs after a successful CAS and before the worktree rename (the scar seam). */
  readonly afterPublish?: (commit: string) => Promise<void>;
  /**
   * Test-only (`runDirect` never forwards it): fires exactly once after
   * `openPinnedRoot(io.path)` and before any `openPinnedParent`/`mkdirAt`/parent
   * traversal. The materialize mkdir canary.
   */
  readonly afterRootPin?: (pin: { readonly fd: number; readonly rootPath: string }) => Promise<void>;
  /**
   * Test-only: the distinct later seam for `readExisting`/exec-bit `chmodFd`/
   * `renameAt`; fires exactly once after the final parent pin and before the
   * leaf `lstatAt`/read, never after an intermediate directory pin.
   */
  readonly afterPinned?: (pin: {
    readonly fd: number; readonly root: string; readonly rel: string;
  }) => Promise<void>;
  /** Test-only: the proc-filesystem root used by every pinned materialize call. */
  readonly procRoot?: string;
};

/**
 * The opened repository as the `WorldIo` the plumbing needs, without a new
 * method on the protected `WorldRepo`: its public pair and HEAD, and this
 * repository's own git invocations through the process layer (the controlled
 * environment, the deadlines, the world flock).
 */
export function worldIoOf(repo: WorldRepo): WorldIo {
  let format: ObjectFormat | null = null;
  return {
    path: repo.path,
    gitDir: repo.gitDir,
    baseArgs: () => repo.gitBaseArgs(),
    head: () => repo.headHash(),
    nothingStaged: async () => {
      try {
        await runGit(repo.path, [...repo.gitBaseArgs(), 'diff', '--cached', '--quiet']);
        return true;
      } catch (err) {
        if (err instanceof GitCommandError && err.exitCode === 1) return false;
        throw err;
      }
    },
    git: (args, env) => runGit(repo.path, [...repo.gitBaseArgs(), ...args], env),
    gitWithStdin: (args, input) => runGitWithStdin(
      repo.path, [...repo.gitBaseArgs(), ...args], input),
    format: async () => {
      if (format !== null) return format;
      const out = (await runGit(
        repo.path, [...repo.gitBaseArgs(), 'rev-parse', '--show-object-format'],
      )).trim();
      format = out === 'sha256' ? 'sha256' : 'sha1';
      return format;
    },
  };
}

/**
 * Writes the validated bytes to the home's `.es` temp and commits them.
 *
 * @throws RatifyIoError when the home's `.es` cannot be written (the same-uid
 * assumption's failure mode), RatifyRefusedError for a non-regular committed
 * entry, WorldHeadError for a detached/foreign HEAD, and GitCommandError for a
 * git failure — including contention held past the bounded retries. Whenever a
 * throw escapes, no ref moved.
 */
export async function ratify(io: WorldIo, options: RatifyOptions): Promise<RatifyOutcome> {
  const home = dirname(io.gitDir);
  const esDir = join(home, '.es');
  // The home itself must accept the ratification's operator-side artifacts
  // (`.es`, the temp write and the shared-index staging). A pre-existing `.es`
  // on a marker-bearing home would otherwise hide a home the running uid
  // cannot write; the bounded RatifyIoError is the same refusal as the
  // `.es`-creation failure below.
  try {
    await access(home, fsConstants.W_OK);
  } catch (err) {
    throw new RatifyIoError(
      `the home is not writable (${codeOf(err)}); a ratification needs`
      + ' a home owned by the running uid');
  }
  try {
    await ensureDurableDirectory(esDir, home);
  } catch (err) {
    throw new RatifyIoError(
      `the home's .es directory could not be created (${codeOf(err)}); a ratification needs`
      + ' a home owned by the running uid');
  }
  const tempName = `direct-write.${randomHex()}.tmp`;
  const temp = join(esDir, tempName);
  try {
    await writeTemp(temp, options.bytes);
  } catch (err) {
    throw new RatifyIoError(
      `the home's .es directory could not be written (${codeOf(err)}); a ratification needs`
      + ' a home owned by the running uid');
  }
  try {
    // The one hash: git never re-reads the operator's path, so the object the
    // commit carries is exactly the validated bytes (no TOCTOU).
    const blob = (await io.gitWithStdin(
      ['hash-object', '-w', '--stdin'], options.bytes,
    )).trim();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await ratifyOnce(io, {
          path: options.path,
          bytes: options.bytes,
          blob,
          message: options.message ?? `${RATIFY_SUBJECT} ${options.path}`,
          temp,
          esDir,
          ...(options.beforePublish !== undefined
            ? { beforePublish: options.beforePublish } : {}),
          ...(options.afterPublish !== undefined ? { afterPublish: options.afterPublish } : {}),
          ...(options.afterRootPin !== undefined ? { afterRootPin: options.afterRootPin } : {}),
          ...(options.afterPinned !== undefined ? { afterPinned: options.afterPinned } : {}),
          ...(options.procRoot !== undefined ? { procRoot: options.procRoot } : {}),
        });
      } catch (err) {
        if (!isContention(err) || attempt >= RATIFY_ATTEMPTS) throw err;
        await delay(RATIFY_RETRY_MS * attempt);
      }
    }
  } finally {
    // The temp is gone when the rename moved it; the pinned unlink is the
    // unchanged path's and the failure path's cleanup, and a stale temp can
    // never poison a later run (the name is unique per call). A missing /proc
    // leaves the bounded, uniquely named residue in `.es` rather than falling
    // back to a path.
    await unlinkPinned(esDir, tempName, options.procRoot);
  }
}

/** One attempt's whole input: a re-attempt re-derives every HEAD-dependent fact. */
type AttemptInput = {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly blob: string;
  readonly message: string;
  readonly temp: string;
  readonly esDir: string;
  readonly beforePublish?: (parent: string | null) => Promise<void>;
  readonly afterPublish?: (commit: string) => Promise<void>;
  readonly afterRootPin?: (pin: { readonly fd: number; readonly rootPath: string }) => Promise<void>;
  readonly afterPinned?: (pin: {
    readonly fd: number; readonly root: string; readonly rel: string;
  }) => Promise<void>;
  readonly procRoot?: string;
};

/**
 * One complete attempt: the parent read, the private index seeded at it, the
 * one entry, the tree, the unchanged question, the commit, the CAS, and the
 * materialize-first tail. The private index is unlinked in a `finally`, before
 * the retry can re-seed a fresh one.
 */
async function ratifyOnce(io: WorldIo, input: AttemptInput): Promise<RatifyOutcome> {
  const ref = await headRef(io);
  const parent = await readHead(io);
  const parentTree = parent === null ? await emptyTree(io) : await treeOf(io, parent);
  const index = join(input.esDir, `direct-index.${randomHex()}.tmp`);
  try {
    const env = { GIT_INDEX_FILE: index };
    // The fresh index is seeded at the parent THIS attempt read: a peer that
    // lands later is picked up by the retry's own re-read.
    if (parent === null) await io.git(['read-tree', '--empty'], env);
    else await io.git(['read-tree', parent], env);
    const mode = await entryMode(io, parent, input.path);
    await io.git(
      ['update-index', '--add', '--cacheinfo', mode, input.blob, input.path], env);
    const tree = (await io.git(['write-tree'], env)).trim();
    if (tree === parentTree) {
      // The unchanged conclusion is about the parent THIS attempt read: a peer
      // that landed in between makes it stale, so the attempt is re-seeded (the
      // sentence "the pin did not move" must be true of the world's HEAD).
      if (await readHead(io) !== parent) {
        throw new RatifyRetryError('the world moved while the ratification compared its tree');
      }
      const worktree = await materialize(io, input.path, input.bytes, input.temp, mode, {
        ...(input.afterRootPin !== undefined ? { afterRootPin: input.afterRootPin } : {}),
        ...(input.afterPinned !== undefined ? { afterPinned: input.afterPinned } : {}),
        ...(input.procRoot !== undefined ? { procRoot: input.procRoot } : {}),
      });
      const materialized = worktree.ok ? worktree.moved : false;
      return {
        kind: 'unchanged',
        commit: null,
        parent,
        materialized,
        staged: false,
        warnings: worktree.ok
          ? []
          : [boundWarning(
            `the worktree copy was not materialized (${worktree.reason}); the pin is unchanged`
            + ' and the next add --all restores it')],
      };
    }
    // THE ONE NAMED BYPASS of `assertNodeUid`: RATIFY_AUTHOR is the reserved
    // `human`, which no node may bear — the reservation is what makes the author
    // trustworthy, so this commit path deliberately skips the uid validation.
    const commit = (await io.git([
      '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null',
      'commit-tree', tree,
      ...(parent === null ? [] : ['-p', parent]),
      '-m', input.message,
    ], RATIFY_IDENTITY)).trim();
    if (input.beforePublish !== undefined) await input.beforePublish(parent);
    await publish(io, ref, parent, commit);
    if (input.afterPublish !== undefined) await input.afterPublish(commit);
    // MATERIALIZE-FIRST: the CAS has landed, so the worktree copy follows at
    // once through the pinned chain; the shared index is staged only after a
    // successful rename (see the module header).
    const warnings: string[] = [];
    const worktree = await materialize(io, input.path, input.bytes, input.temp, mode, {
      ...(input.afterRootPin !== undefined ? { afterRootPin: input.afterRootPin } : {}),
      ...(input.afterPinned !== undefined ? { afterPinned: input.afterPinned } : {}),
      ...(input.procRoot !== undefined ? { procRoot: input.procRoot } : {}),
    });
    let staged = false;
    if (worktree.ok) {
      try {
        await io.git(['update-index', '--add', '--cacheinfo', mode, input.blob, input.path]);
        staged = true;
      } catch (err) {
        warnings.push(boundWarning(
          `the commit landed, but staging ${input.path} in the shared index failed`
          + ` (${codeOf(err)}); the next add --all restores it`));
      }
    } else {
      warnings.push(boundWarning(
        `the commit landed, but the worktree copy was not materialized (${worktree.reason});`
        + ' index staging skipped when the rename failed'));
    }
    return {
      kind: 'committed',
      commit,
      parent,
      materialized: worktree.ok ? worktree.moved : false,
      staged,
      warnings,
    };
  } finally {
    // The private index and its lock: a crashed run's stale file must never
    // poison the next, and a retry seeds a NEW one. The cleanup is pinned to
    // `.es` so a /proc failure leaves only the bounded residue.
    await unlinkPinned(input.esDir, basename(index), input.procRoot);
    await unlinkPinned(input.esDir, `${basename(index)}.lock`, input.procRoot);
  }
}

/**
 * The git command that failed is contention when its stderr carries the
 * kernel's own contention wording (`world-commit.ts`): git's index/ref lock, a
 * lost compare-and-swap, or the world flock's reserved conflict message. The
 * regex is imported rather than copied, so the two retry loops cannot drift.
 */
function isContention(err: unknown): boolean {
  return err instanceof RatifyRetryError
    || (err instanceof GitCommandError && LOCK_CONTENTION.test(err.stderr));
}

/**
 * The local branch HEAD names, or a refusal when HEAD is not one. The same
 * policy as the turn-end commit (`world-commit.ts`'s `headRef`): publish to one
 * named branch and never guess; the re-check immediately before the update is
 * what makes a branch switch fail closed.
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
 * Moves the branch with a compare-and-swap against the parent this attempt
 * built on — or the all-zero object id while the branch is unborn. A peer
 * commit landed in between makes the update fail (which the retry reads as
 * contention) instead of being overwritten.
 */
async function publish(
  io: WorldIo, ref: string, parent: string | null, commit: string,
): Promise<void> {
  const current = await headRef(io);
  if (current !== ref) {
    throw new WorldHeadError(`HEAD switched from ${ref} to ${current} during a ratification`);
  }
  const expected = parent ?? '0'.repeat(hashLength(await io.format()));
  await io.git(['update-ref', ref, commit, expected]);
}

/**
 * The mode of the committed entry at `path`, or `100644` for a new file.
 *
 * An existing entry must be a regular blob; a symlink, a gitlink or a
 * directory is a teaching refusal — a ratification never silently replaces a
 * link's target semantics or turns a submodule into a file.
 */
async function entryMode(io: WorldIo, parent: string | null, path: string): Promise<string> {
  if (parent === null) return '100644';
  const listing = await io.git(['ls-tree', '-z', parent, '--', path]);
  const entry = parseTreeEntry(listing);
  if (entry === null) return '100644';
  if (entry.mode === '120000') {
    throw new RatifyRefusedError(
      `${path} is a symlink in the committed tree (mode 120000); a ratification writes`
      + ' a regular file — remove or rename the link first');
  }
  if (entry.mode === '160000' || entry.type === 'commit') {
    throw new RatifyRefusedError(
      `${path} is a submodule entry in the committed tree (mode 160000); a ratification`
      + ' writes a regular file');
  }
  if (entry.mode === '040000' || entry.type === 'tree') {
    throw new RatifyRefusedError(
      `${path} is a directory in the committed tree; a ratification writes a regular file`);
  }
  if (entry.mode !== '100644' && entry.mode !== '100755') {
    throw new RatifyRefusedError(
      `${path} has mode ${entry.mode} in the committed tree; a ratification writes a regular`
      + ' file (mode 100644 or 100755)');
  }
  if (entry.type !== 'blob') {
    throw new RatifyRefusedError(
      `${path} is a ${entry.type} in the committed tree, not a file`);
  }
  return entry.mode;
}

/** One `ls-tree -z` entry for an exact path (at most one; NUL-separated). */
type TreeEntry = {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
};

function parseTreeEntry(listing: string): TreeEntry | null {
  const end = listing.indexOf('\0');
  const record = end === -1 ? listing : listing.slice(0, end);
  if (record === '') return null;
  const tab = record.indexOf('\t');
  const meta = tab === -1 ? record : record.slice(0, tab);
  const [mode, type, oid] = meta.split(' ');
  if (mode === undefined || type === undefined || oid === undefined) return null;
  return { mode, type, oid };
}

/** One worktree materialization's answer: moved, or already in place, or why not. */
type Materialized =
  | { readonly ok: true; readonly moved: boolean }
  | { readonly ok: false; readonly reason: string };

/** The materialize-only test seams (never set by the CLI or a production caller). */
type MaterializeSeams = {
  readonly afterRootPin?: (pin: { readonly fd: number; readonly rootPath: string }) => Promise<void>;
  readonly afterPinned?: (pin: {
    readonly fd: number; readonly root: string; readonly rel: string;
  }) => Promise<void>;
  readonly procRoot?: string;
};

/**
 * Renames the pre-written temp over the worktree path through the fd-anchored
 * chain, or reports that the worktree already holds the bytes.
 *
 * The chain (`src/node/world-fs.ts`): `openPinnedRoot(io.path)` is the ONLY
 * root-path `realpath`; `afterRootPin` fires there, before any parent walk or
 * `mkdirAt`. Every parent component is `lstatAt`'d and opened
 * `O_DIRECTORY|O_NOFOLLOW` through the pinned parent fd, missing ones are
 * created with `mkdirAt` (EEXIST success, reopen once), and the final
 * `lstatAt`/comparison read/exec-bit `chmodFd`/`renameAt` address the pinned
 * parent only. The containment proof is `realpathFd` compared against the
 * pinned root's own fd (never a `realpath` of a selected parent path). The
 * pre-CAS temp WRITE stays the host-owned path in `.es`; only its post-CAS
 * chmod and cleanup are pinned.
 *
 * Failures are returned, never thrown: they happen after the CAS, and the
 * commit's landing decides the outcome (A6's post-CAS precedence). A `/proc`
 * failure here is one named warning with the landed hash preserved, never a
 * path fallback.
 */
async function materialize(
  io: WorldIo, treePath: string, bytes: Uint8Array, temp: string, mode: string,
  seams: MaterializeSeams = {},
): Promise<Materialized> {
  const segments = treePath.split('/');
  const base = segments.pop();
  if (base === undefined || base === '') {
    return failed('the tree path has no file name');
  }
  const pinOptions = seams.procRoot !== undefined ? { procRoot: seams.procRoot } : {};
  const esDir = dirname(temp);
  const tempName = basename(temp);
  let root: FileHandle;
  try {
    root = await openPinnedRoot(io.path, pinOptions);
  } catch (err) {
    return failed(`the world root could not be resolved (${worldFsLabel(err)})`);
  }
  try {
    if (seams.afterRootPin !== undefined) {
      await seams.afterRootPin({ fd: root.fd, rootPath: io.path });
    }
    let parent: FileHandle;
    try {
      parent = await openPinnedParent(root.fd, segments, { create: true, ...pinOptions });
    } catch (err) {
      return failed(`a parent component could not be pinned (${worldFsLabel(err)})`);
    }
    try {
      let rootReal: string;
      let parentReal: string;
      try {
        rootReal = await realpathFd(root, pinOptions);
        parentReal = await realpathFd(parent, pinOptions);
      } catch (err) {
        return failed(`the parent directory could not be pinned (${worldFsLabel(err)})`);
      }
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
        return failed('the parent directory resolves outside the world');
      }
      let info;
      try {
        info = await parent.stat();
      } catch (err) {
        return failed(`the parent directory could not be inspected (${codeOf(err)})`);
      }
      if (!info.isDirectory()) return failed('the parent path is not a directory');
      // The distinct later seam: after the FINAL parent pin, before the leaf
      // lstat/read. Never fired after an intermediate directory pin.
      if (seams.afterPinned !== undefined) {
        await seams.afterPinned({ fd: parent.fd, root: io.path, rel: segments.join('/') });
      }
      const existing = await readExistingPinned(parent.fd, base, bytes, mode, pinOptions);
      if (existing.state === 'equal') {
        // The bytes match; git's exec bit must match too, or the next add --all
        // stages a silent `mode change 100755 => 100644`.
        if (existing.execMatches) return { ok: true, moved: false };
        const fixed = await setExecutablePinned(
          parent.fd, base, mode === '100755', pinOptions);
        if (fixed !== null) return failed(fixed);
        return { ok: true, moved: false };
      }
      if (existing.state === 'directory') return failed('the target path is a directory');
      let es: FileHandle;
      try {
        es = await openPinnedRoot(esDir, pinOptions);
      } catch (err) {
        return failed(`the .es temp directory could not be pinned (${worldFsLabel(err)})`);
      }
      try {
        // The temp is 0600: an existing 100755 entry must be materialized
        // executable, or the rename would flip the ratified mode (git tracks
        // the exec bit; the next add --all would stage the change).
        if (mode === '100755') {
          let tempHandle: FileHandle;
          try {
            tempHandle = await openLeafAt(
              es.fd, tempName, fsConstants.O_RDONLY, pinOptions);
          } catch (err) {
            return failed(`the executable mode could not be set (${worldFsLabel(err)})`);
          }
          try {
            await chmodFd(tempHandle, 0o755);
          } catch (err) {
            return failed(`the executable mode could not be set (${worldFsLabel(err)})`);
          } finally {
            await tempHandle.close().catch(() => {});
          }
        }
        try {
          await renameAt(es.fd, tempName, parent.fd, base, pinOptions);
        } catch (err) {
          return failed(`the rename failed (${worldFsLabel(err)})`);
        }
      } finally {
        await es.close().catch(() => {});
      }
      return { ok: true, moved: true };
    } finally {
      await parent.close().catch(() => {});
    }
  } finally {
    await root.close().catch(() => {});
  }
}

/** One failed materialization: the caller states the landing fact, the reason is here. */
function failed(reason: string): Materialized {
  return { ok: false, reason };
}

/**
 * Sets or clears the exec bit on an existing regular world file, through the
 * pinned leaf fd (the exec bit is the only mode git tracks). Returns a bounded
 * reason on failure, `null` on success.
 */
async function setExecutablePinned(
  parentFd: number, base: string, executable: boolean,
  options: { readonly procRoot?: string },
): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await openLeafAt(parentFd, base, fsConstants.O_RDONLY, options);
  } catch (err) {
    return `the worktree copy could not be opened to set its mode (${worldFsLabel(err)})`;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return 'the worktree copy is not a regular file';
    const current = info.mode & 0o777;
    const next = executable ? current | 0o111 : current & ~0o111;
    if (next === current) return null;
    await chmodFd(handle, next);
    return null;
  } catch (err) {
    return `the worktree copy's mode could not be set (${worldFsLabel(err)})`;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The worktree copy's content state relative to the validated bytes, plus its exec bit. */
type Existing = {
  readonly state: 'equal' | 'diverged' | 'absent' | 'directory' | 'other';
  /** The file's exec bit equals the committed entry's (`mode === '100755'`). */
  readonly execMatches: boolean;
};

async function readExistingPinned(
  parentFd: number, base: string, bytes: Uint8Array, mode: string,
  options: { readonly procRoot?: string },
): Promise<Existing> {
  const wantExec = mode === '100755';
  let entry;
  try {
    entry = await lstatAt(parentFd, base, options);
  } catch (err) {
    if (err instanceof WorldFsMissingError) return { state: 'absent', execMatches: false };
    return { state: 'other', execMatches: false };
  }
  if (entry.isDirectory()) return { state: 'directory', execMatches: false };
  if (!entry.isFile()) return { state: 'other', execMatches: false };
  if (entry.size !== bytes.length) {
    return { state: 'diverged', execMatches: modeMatches(entry.mode, wantExec) };
  }
  let handle: FileHandle;
  try {
    handle = await openLeafAt(parentFd, base, fsConstants.O_RDONLY, options);
  } catch {
    return { state: 'other', execMatches: false };
  }
  try {
    const info = await handle.stat();
    const existing = await handle.readFile();
    return {
      state: existing.equals(Buffer.from(bytes)) ? 'equal' : 'diverged',
      execMatches: modeMatches(info.mode, wantExec),
    };
  } catch {
    return { state: 'other', execMatches: false };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Best-effort pinned unlink of one `.es` artifact; a /proc failure leaves the bounded residue. */
async function unlinkPinned(
  dir: string, name: string, procRoot: string | undefined,
): Promise<void> {
  if (name === '' || name.includes('/')) return;
  const pinOptions = procRoot !== undefined ? { procRoot } : {};
  let root: FileHandle;
  try {
    root = await openPinnedRoot(dir, pinOptions);
  } catch {
    return;
  }
  try {
    await unlinkAt(root.fd, name, pinOptions);
  } catch {
    // The uniquely named residue in `.es` is bounded; never a path fallback.
  } finally {
    await root.close().catch(() => {});
  }
}

/** Whether one file mode's exec bit equals the committed entry's. */
function modeMatches(mode: number, wantExec: boolean): boolean {
  return ((mode & 0o111) !== 0) === wantExec;
}

/** Writes one temp file 0600, fsyncs it, and closes it (the durable pre-write). */
async function writeTemp(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** One bounded single-line warning (the rendered outcome's own bound). */
function boundWarning(text: string): string {
  return singleLine(text, MAX_WARNING_CHARS);
}

/** The errno code of a failure, or a bounded label; never a message with a path. */
function codeOf(err: unknown): string {
  if (err instanceof GitCommandError) return `git ${err.kind} failure`;
  if (err instanceof WorldFsError) return err.errno ?? err.reason;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unknown failure';
}

/** The bounded label of one pinned-helper failure. */
function worldFsLabel(err: unknown): string {
  if (err instanceof WorldFsError) {
    return err.reason === 'proc-unavailable' ? err.reason : (err.errno ?? err.reason);
  }
  return codeOf(err);
}

/** A fresh hex suffix for this process's temp names (one per call and attempt). */
function randomHex(): string {
  return randomBytes(8).toString('hex');
}
