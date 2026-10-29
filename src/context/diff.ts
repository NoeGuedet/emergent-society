import type {
  CommitRange, DiffCapture, RecordedCommit, WorldRepo, WorldRange,
} from '../node/world.js';
import type { WorldPerception } from './contracts.js';

/**
 * The bounded, pinned world perception the assembler presents (T4).
 *
 * `presentWorld` composes the selected commit metadata with an ordered,
 * per-commit foreign patch rendering. It never uses a whole-range net diff to
 * reconstruct per-commit activity: each foreign commit is rendered as its own
 * `first-parent-tree → commit-tree` call so an add followed by a remove is
 * preserved rather than cancelled. Own commits are never patched; they are
 * named in `omittedOwn` and as a per-commit omission line, honestly warning that
 * a closer's commit can sweep a peer's in-flight writes.
 *
 * Budgeting is NEWEST-first (the friction pass 2, policy v2): a wake must never
 * spend the byte budget on the oldest history and drop the commits that just
 * landed — the waking hand-off is the load-bearing view. The kept commits — a
 * contiguous newest suffix — are then emitted oldest-to-newest, so the reading
 * order stays chronological and byte-stable for a fixed budget; the omission
 * notice names the dropped count and the oldest omitted commit.
 *
 * The renderer identity (`policy`, exact `gitVersion`, `attrSource`) is recorded
 * so replay can reject an incompatible policy or a differing exact git version
 * rather than promising byte equality across arbitrary versions.
 */

/**
 * The current renderer policy: a journal recorded under this policy re-renders
 * byte-identically; a journal recorded under an older accepted policy still
 * validates and replays its recorded bytes (the registry accepts the set).
 */
export const RENDER_POLICY = 'commit-patches-v2' as const;

/** The attribute source: the attributes of the `to` tree, never the working tree. */
export const ATTR_SOURCE = 'to' as const;

/** UTF-8 bytes reserved at the tail for the final truncation/omission notices (T4 step 3). */
const TAIL_RESERVE = 128;

/** The minimum accepted `maxBytes`; below this the notice preamble cannot be honest. */
const MIN_MAX_BYTES = 512;

const FALLBACK_NOTICE = 'fallback: from unreachable; full history shown';
const LIST_TRUNCATED_NOTICE = 'commit-list truncated; oldest history omitted';
const ATTRIBUTION_NOTICE =
  'attribution: commit author names the closer; omitted own commits may contain peer in-flight writes';

/**
 * The one aggregate omission line: the dropped count and the oldest omitted
 * hash — the two facts a truncated wake must keep. `older` marks a partial drop
 * (some commits shown); when nothing was kept the wording drops "older".
 */
function omissionNotice(count: number, oldest: string | null, older: boolean): string {
  return `rendering truncated; ${count} ${older ? 'older ' : ''}commit(s) not shown`
    + (oldest === null ? '' : ` (oldest omitted ${oldest.slice(0, 12)})`) + '\n';
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Renders the opening perception of `range` for `uid` at the given budgets.
 *
 * @throws when `maxBytes`/`maxCommits` are out of range, an endpoint hash is
 * malformed or `to` does not exist, or the isolated renderer cannot run — the
 * renderer fails closed rather than falling back to the working tree.
 */
export async function presentWorld(
  world: WorldRepo, uid: string, range: WorldRange, maxBytes: number, maxCommits: number,
): Promise<WorldPerception> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_MAX_BYTES) {
    throw new Error(`maxBytes must be an integer >= ${MIN_MAX_BYTES}, got ${maxBytes}`);
  }
  if (!Number.isSafeInteger(maxCommits) || maxCommits < 1 || maxCommits > 4096) {
    throw new Error(`maxCommits must be an integer in [1, 4096], got ${maxCommits}`);
  }

  const gitVersion = await world.gitVersion();
  const rangeInfo = await world.commitsIn(range, maxCommits);
  const commits = rangeInfo.commits;
  const omittedOwn = commits.filter((commit) => commit.author === uid).map((commit) => commit.hash);

  const parts: string[] = [];
  // `work` bounds the preamble+headers+patches; `notices` bounds the tail reserve.
  let work = 0;
  let notices = 0;
  const included: string[] = [];
  let truncated = false;
  const workingLimit = maxBytes - TAIL_RESERVE;

  const appendWork = (text: string): boolean => {
    const size = byteLength(text);
    if (work + size > workingLimit) return false;
    parts.push(text);
    work += size;
    return true;
  };
  // A deterministic LF precedes every notice, so a notice never glues onto
  // already-captured patch bytes that were cut mid-line. The separator is an
  // emitted byte and is counted inside maxBytes (against the tail reserve).
  // Budgeting is separated from emission so the aggregate — the only textual
  // statement that commits were dropped — is reserved FIRST and can never be
  // the notice a full reserve drops; the worst case fits with headroom (an
  // aggregate chunk is at most 83 bytes, a patch notice at most 37 under the
  // 1 MiB maxDiffBytes ceiling: 120 of the 128-byte reserve).
  const budgetNotice = (text: string): string | null => {
    const chunk = `\n${text}`;
    const size = byteLength(chunk);
    if (notices + size > TAIL_RESERVE) return null;
    notices += size;
    return chunk;
  };

  const preamble: string[] = [];
  if (rangeInfo.fallback === 'unreachable-from') preamble.push(FALLBACK_NOTICE);
  if (rangeInfo.listTruncated) preamble.push(LIST_TRUNCATED_NOTICE);
  if (omittedOwn.length > 0) preamble.push(ATTRIBUTION_NOTICE);
  const preambleText = preamble.map((line) => `${line}\n`).join('');

  // A preamble that cannot fit makes no per-commit claim: only the aggregate
  // omission notice is emitted and counted. Under validated bounds this is
  // unreachable (the largest preamble is 192 bytes against the smallest
  // working limit of 384), but the branch stays so a future bound change
  // degrades honestly instead of silently dropping the preamble.
  if (preambleText !== '' && byteLength(preambleText) > workingLimit) {
    const aggregate = budgetNotice(omissionNotice(commits.length,
      commits.length > 0 ? (commits[0] as RecordedCommit).hash : null, false));
    if (aggregate !== null) parts.push(aggregate);
    return build(uid, range, rangeInfo, gitVersion, maxBytes, maxCommits, {
      text: parts.join(''), included: [], omittedOwn, truncated: true,
    });
  }
  appendWork(preambleText);

  // Newest-first budgeting: walk from the newest commit backward, keeping whole
  // commits until the budget is exhausted; the kept suffix is emitted
  // oldest-to-newest below. The preamble already consumed part of the working
  // budget, so the walk starts there; the dropped commits are always a
  // contiguous oldest prefix, which the omission notice counts from `commits[0]`.
  type Block = { readonly commit: RecordedCommit; readonly text: string; readonly own: boolean };
  const kept: Block[] = [];
  let keptBytes = work;
  let omittedOlder = 0;
  let patchNotice: string | null = null;
  for (let i = commits.length - 1; i >= 0; i -= 1) {
    const commit = commits[i] as RecordedCommit;

    if (commit.author === uid) {
      const line = `commit ${commit.hash} author ${uid} omitted: own commit\n`;
      if (keptBytes + byteLength(line) > workingLimit) {
        omittedOlder = i + 1;
        truncated = true;
        break;
      }
      keptBytes += byteLength(line);
      kept.push({ commit, text: line, own: true });
      continue;
    }

    const parent = await world.firstParent(commit.hash);
    const header = `commit ${commit.hash}\nauthor ${commit.author}\n` +
      `${parent === null ? 'parent none' : `parent ${parent}`}\n`;
    if (keptBytes + byteLength(header) > workingLimit) {
      omittedOlder = i + 1;
      truncated = true;
      break;
    }
    keptBytes += byteLength(header);
    // The header is complete, so this commit's patch is presented as at least an
    // empty prefix: it counts as included even if the patch is cut at its start.
    const remainingWork = workingLimit - keptBytes;
    if (remainingWork <= 0) {
      truncated = true;
      kept.push({ commit, text: header, own: false });
      patchNotice = 'patch truncated after 0 bytes\n';
      omittedOlder = i;
      break;
    }

    const capture: DiffCapture = await world.diff({ from: parent, to: commit.hash }, remainingWork);
    keptBytes += byteLength(capture.text);
    kept.push({ commit, text: header + capture.text, own: false });
    if (capture.truncated) {
      truncated = true;
      patchNotice = `patch truncated after ${capture.bytesRetained} bytes\n`;
      omittedOlder = i;
      break;
    }
  }
  // The aggregate is budgeted first (see budgetNotice): a full tail reserve
  // drops the lesser patch notice, never the statement that commits were
  // omitted.
  const aggregate = omittedOlder > 0
    ? budgetNotice(omissionNotice(omittedOlder,
      (commits[0] as RecordedCommit).hash, kept.length > 0))
    : null;
  const patchChunk = patchNotice !== null ? budgetNotice(patchNotice) : null;
  kept.reverse();
  for (let i = 0; i < kept.length; i += 1) {
    const block = kept[i] as Block;
    parts.push(block.text);
    if (!block.own) included.push(block.commit.hash);
    // The truncated commit is always the oldest kept, so its notice follows
    // the cut patch tail immediately — the adjacency the pre-v2 order had,
    // now after the first emitted block instead of the last.
    if (i === 0 && patchChunk !== null) parts.push(patchChunk);
  }
  if (aggregate !== null) parts.push(aggregate);

  return build(uid, range, rangeInfo, gitVersion, maxBytes, maxCommits, {
    text: parts.join(''), included, omittedOwn, truncated,
  });
}

interface Rendered {
  readonly text: string;
  readonly included: string[];
  readonly omittedOwn: string[];
  readonly truncated: boolean;
}

/** Assembles the immutable perception from the traversal metadata and rendered text. */
function build(
  uid: string, range: WorldRange, rangeInfo: CommitRange,
  gitVersion: string, maxBytes: number, maxCommits: number, rendered: Rendered,
): WorldPerception {
  return {
    uid,
    range,
    effectiveFrom: rangeInfo.effectiveFrom,
    fallback: rangeInfo.fallback,
    renderer: { policy: RENDER_POLICY, gitVersion, attrSource: ATTR_SOURCE },
    maxBytes,
    maxCommits,
    listTruncated: rangeInfo.listTruncated,
    commits: rangeInfo.commits,
    included: rendered.included,
    omittedOwn: rendered.omittedOwn,
    text: rendered.text,
    truncated: rendered.truncated,
  };
}
