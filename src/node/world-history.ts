import { GitCommandError } from './errors.js';
import {
  FIELD, MAX_GIT_STDERR_BYTES, assertHash, commitExists, isAncestor, spawnGit, verifyCommit,
  type WorldIo,
} from './world-git.js';
import type { CommitRange, WorldCommitInfo, WorldRange } from './world-types.js';

/**
 * The world's history reads: which commits HEAD carries that a watermark does
 * not, whether someone other than one node wrote any of them, the exact git
 * version, a commit's first parent, and a bounded verified traversal of a range.
 *
 * Every function here is a free function over `WorldIo` — the repository's
 * paths, its `-c` overrides and its policy seams — so a read can be exercised
 * against a double without constructing a repository. The process layer is
 * `world-git.ts`, which also holds the revision primitives these reads are built
 * from; the repository that owns the policy is `world.ts`.
 *
 * Every HEAD read goes through `io.head()` and never the `readHead` primitive:
 * the repository binds `head` to its own `headHash()`, which is the seam a test
 * double overrides, and routing a read around it would both skip that seam and
 * — inside `readHead`, which calls `io.git` — recurse.
 */

/** The `git log` format the parser reads: hash, author name. */
const LOG_FORMAT = `--format=%H${FIELD}%an`;

/**
 * The longest author record the wake scan will hold while waiting for its
 * terminator. A uid is at most 128 characters, so a longer record cannot be
 * this node's author: it is answered as foreign rather than buffered without
 * bound.
 */
const MAX_AUTHOR_RECORD_CHARS = 4096;

/** Parses one `LOG_FORMAT` line. */
function parseCommit(line: string): WorldCommitInfo {
  const [hash = '', author = ''] = line.split(FIELD);
  return { hash, author };
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
export async function commitsSince(
  io: WorldIo, from: string | null,
): Promise<WorldCommitInfo[]> {
  const head = await io.head();
  // No HEAD, or HEAD unmoved: the range is empty without asking git for it.
  if (head === null || head === from) return [];
  try {
    const out = await io.git(['log', LOG_FORMAT, from === null ? 'HEAD' : `${from}..HEAD`]);
    const commits = out.split('\n').filter((line) => line !== '').map(parseCommit).reverse();
    if (commits.length === 0 && from !== null && (await isAncestor(io, head, from))) {
      return commitsSince(io, null);
    }
    return commits;
  } catch (err) {
    // The watermark is not a reachable object any more (a rewritten history,
    // a gc). The node cannot prove it has seen the current history, so it is
    // given all of it: a spurious wake costs a turn, a missed commit costs a
    // fact, and the two are not symmetric.
    if (from !== null && err instanceof GitCommandError) return commitsSince(io, null);
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
export async function hasForeignCommit(
  io: WorldIo, from: string | null, author: string,
): Promise<boolean> {
  const head = await io.head();
  if (head === null || head === from) return false;
  try {
    const scan = await foreignAuthorIn(
      io, from === null ? ['HEAD'] : [`${from}..HEAD`], author);
    if (scan === 'foreign') return true;
    // An empty `head !== from` range cannot be forward movement: HEAD may have
    // moved backward behind the watermark (a peer's force-reset). The node
    // cannot prove what it has seen, so the whole history answers instead.
    if (from !== null && scan === 'empty' && (await isAncestor(io, head, from))) {
      return (await foreignAuthorIn(io, ['HEAD'], author)) === 'foreign';
    }
    return false;
  } catch (err) {
    if (from !== null && err instanceof GitCommandError) return hasForeignCommit(io, null, author);
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
function foreignAuthorIn(
  io: WorldIo, spec: readonly string[], author: string,
): Promise<'foreign' | 'empty' | 'self-only'> {
  const args = [...io.baseArgs(), 'log', '--format=format:%an%x00', ...spec];
  return new Promise<'foreign' | 'empty' | 'self-only'>((resolvePromise, reject) => {
    const child = spawnGit(args, { cwd: io.path });
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
    child.on('error', (err) => settle(
      new GitCommandError(args, null, String(err), { kind: 'spawn' }), 'empty',
    ));
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
      else settle(new GitCommandError(args, code, stderr, { kind: 'exit' }), 'empty');
    });
  });
}

/**
 * The exact stdout of `git --version`, trailing line ending trimmed. Recorded
 * in every perception so replay can reject a differing exact version rather
 * than promising byte equality across arbitrary versions (T4 step 2).
 */
export async function readGitVersion(io: WorldIo): Promise<string> {
  return (await io.git(['--version'])).replace(/\r?\n$/, '');
}

/** The first parent of `commit`, or null for a root. Merge patches use it (T4 step 3). */
export async function firstParent(io: WorldIo, commit: string): Promise<string | null> {
  const out = (await io.git(['show', '-s', '--format=%P', commit])).trim();
  const first = out.split(' ')[0] ?? '';
  return first === '' ? null : first;
}

/** Author names for a batch of hashes, keyed by full hash. */
async function authorsOf(
  io: WorldIo, hashes: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (hashes.length === 0) return map;
  const out = await io.git(['log', '--no-walk=unsorted', LOG_FORMAT, ...hashes]);
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
export async function commitsIn(
  io: WorldIo, range: WorldRange, maxCommits: number,
): Promise<CommitRange> {
  if (!Number.isSafeInteger(maxCommits) || maxCommits < 1 || maxCommits > 4096) {
    throw new Error(`maxCommits must be an integer in [1, 4096], got ${maxCommits}`);
  }
  if (range.from !== null) await assertHash(io, 'from', range.from);
  if (range.to !== null) await assertHash(io, 'to', range.to);

  if (range.to === null) {
    return { commits: [], effectiveFrom: null, fallback: 'none', listTruncated: false };
  }
  if (range.from !== null && range.from === range.to) {
    return { commits: [], effectiveFrom: range.from, fallback: 'none', listTruncated: false };
  }
  await verifyCommit(io, range.to);

  let base: string | null = range.from;
  let fallback: 'none' | 'unreachable-from' = 'none';
  if (range.from !== null) {
    if (!(await commitExists(io, range.from)) || !(await isAncestor(io, range.from, range.to))) {
      base = null;
      fallback = 'unreachable-from';
    }
  }

  const spec = base === null ? range.to : `${base}..${range.to}`;
  const out = await io.git(['rev-list', '--topo-order', `--max-count=${maxCommits + 1}`, spec]);
  const newest = out.split('\n').filter((line) => line !== '');
  const listTruncated = newest.length > maxCommits;
  // rev-list is newest-first; the extra oldest commit is dropped and the rest
  // reversed to oldest-first deterministic topology.
  const selectedNewest = listTruncated ? newest.slice(0, maxCommits) : newest;
  const selectedOldest = [...selectedNewest].reverse();
  const authors = await authorsOf(io, selectedOldest);
  const commits = selectedOldest.map((hash) => ({ hash, author: authors.get(hash) ?? '' }));
  return { commits, effectiveFrom: base, fallback, listTruncated };
}
