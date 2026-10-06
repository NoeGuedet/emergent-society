import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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

/** stderr kept from a failed bounded render: a diagnostic, never the payload (§T4). */
const MAX_GIT_STDERR_BYTES = 8 * 1024;

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

/** The object formats git may use; a hash's hex length is the discriminator. */
type ObjectFormat = 'sha1' | 'sha256';

/** One bounded render result: the emitted UTF-8 text, whether it stopped early, its byte length. */
interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytesRetained: number;
}

/**
 * The longest prefix of `s` whose UTF-8 encoding is at most `maxBytes`, cut on a
 * code-point boundary so truncation never splits a character.
 */
function utf8Prefix(s: string, maxBytes: number): { text: string; bytes: number } {
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i) ?? 0;
    const size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    i += cp > 0xffff ? 2 : 1;
  }
  return { text: s.slice(0, i), bytes };
}

/** Full-hex validation, sized to the repository's object format (T4 step 1). */
function hashLength(format: ObjectFormat): number {
  return format === 'sha256' ? 64 : 40;
}

function isFullHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/.test(value);
}

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
 * A bounded rendering of a world range (T4). `bytesRetained` counts the emitted
 * UTF-8 bytes of `text` after decoding/replacement, including headers and
 * notices — not an input byte count; `truncated` is true when emission stopped
 * before the whole bounded range was rendered. Type aliases, not interfaces:
 * these are journaled in `world/perception` and the envelope's `JsonValue`
 * constraint only admits alias-shaped object types.
 */
export type DiffCapture = {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytesRetained: number;
};

/** One recorded commit of a bounded range, as the perception records it. */
export type RecordedCommit = {
  readonly hash: string;
  readonly author: string;
};

/**
 * A bounded, verified traversal of the world's history (T4). `effectiveFrom` is
 * the requested `from` when reachable, else `null`; `listTruncated` records that
 * older commits were omitted rather than claiming a complete history.
 */
export type CommitRange = {
  readonly commits: RecordedCommit[];
  readonly effectiveFrom: string | null;
  readonly fallback: 'none' | 'unreachable-from';
  readonly listTruncated: boolean;
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

/** Runs one git command feeding `input` on stdin and returns stdout (T4 empty-tree hash). */
async function gitWithStdin(dir: string, args: readonly string[], input: Buffer): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('git', [...args], { cwd: dir, windowsHide: true });
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

  /** The repo's object format, read once: hash validity depends on it (T4 step 1). */
  private objectFormat: ObjectFormat | null = null;

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

  /** The visible git directory of the world (a normal non-worktree repository). */
  private gitDir(): string {
    return join(this.path, '.git');
  }

  /** The repository's object format, read from git once and cached. */
  private async format(): Promise<ObjectFormat> {
    if (this.objectFormat === null) {
      const out = (await git(this.path, ['rev-parse', '--show-object-format'])).trim();
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
    return (await git(this.path, ['--version'])).replace(/\r?\n$/, '');
  }

  /** The first parent of `commit`, or null for a root. Merge patches use it (T4 step 3). */
  async firstParent(commit: string): Promise<string | null> {
    const out = (await git(this.path, ['show', '-s', '--format=%P', commit])).trim();
    const first = out.split(' ')[0] ?? '';
    return first === '' ? null : first;
  }

  /** Refuses a hash that is not full hex in the repository's object format. */
  private async assertHash(value: string, where: 'from' | 'to'): Promise<void> {
    if (!isFullHex(value, hashLength(await this.format()))) {
      throw new Error(`invalid ${where} hash: ${value}`);
    }
  }

  /** Verifies `commit` names a commit; a missing object propagates the git failure (T4 step 1). */
  private async verifyCommit(commit: string): Promise<void> {
    await git(this.path, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
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
      await git(this.path, ['merge-base', '--is-ancestor', from, to]);
      return true;
    } catch (err) {
      if (err instanceof GitCommandError && err.exitCode === 1) return false;
      throw err;
    }
  }

  /** The empty-tree object hash, generated from empty stdin; never a hardcoded SHA-1. */
  private async emptyTree(): Promise<string> {
    return (await gitWithStdin(this.path, ['hash-object', '-t', 'tree', '--stdin'], Buffer.alloc(0))).trim();
  }

  /** The tree object of a commit; a missing object propagates the git failure. */
  private async treeOf(commit: string): Promise<string> {
    return (await git(this.path, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`])).trim();
  }

  /** Author names for a batch of hashes, keyed by full hash. */
  private async authorsOf(hashes: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (hashes.length === 0) return map;
    const out = await git(this.path, ['log', '--no-walk=unsorted', LOG_FORMAT, ...hashes]);
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
    const out = await git(this.path, ['rev-list', '--topo-order', `--max-count=${maxCommits + 1}`, spec]);
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
    try {
      const env: Record<string, string> = {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
        LC_ALL: 'C',
        GIT_ATTR_SOURCE: range.to,
      };
      const args = [`--git-dir=${scratch}`, ...HERMETIC_CONFIG, ...HERMETIC_DIFF_ARGS, fromTree, toTree, '--'];
      return await this.streamDiff(args, env, maxBytes);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
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
    await writeFile(join(scratch, 'objects', 'info', 'alternates'), `${join(this.gitDir(), 'objects')}\n`);
    await writeFile(join(scratch, 'config'), '');
    await writeFile(join(scratch, 'HEAD'), 'ref: refs/heads/main\n');
    return scratch;
  }

  /**
   * Streams one hermetic diff to at most `maxBytes` decoded UTF-8 bytes. Invalid
   * bytes become deterministic U+FFFD; hitting the cap kills the child and is
   * the only accepted truncation, while any other nonzero exit or signal is an
   * error. stderr is bounded and never the payload.
   */
  private streamDiff(
    args: readonly string[], env: Record<string, string>, maxBytes: number,
  ): Promise<BoundedText> {
    return new Promise<BoundedText>((resolvePromise, rejectPromise) => {
      const child = spawn('git', [...args], {
        cwd: this.path, env: { ...process.env, ...env }, windowsHide: true,
      });
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
