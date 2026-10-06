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
 * The renderer identity (`policy`, exact `gitVersion`, `attrSource`) is recorded
 * so replay can reject an incompatible policy or a differing exact git version
 * rather than promising byte equality across arbitrary versions.
 */

/** The recorded renderer policy constant; the perception is only replayable for an equal policy. */
export const RENDER_POLICY = 'commit-patches-v1' as const;

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
const AGGREGATE_NOTICE = 'rendering truncated; remaining selected commits not shown';

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
  const appendNotice = (text: string): void => {
    const chunk = `\n${text}`;
    const size = byteLength(chunk);
    if (notices + size > TAIL_RESERVE) return;
    parts.push(chunk);
    notices += size;
  };

  const preamble: string[] = [];
  if (rangeInfo.fallback === 'unreachable-from') preamble.push(FALLBACK_NOTICE);
  if (rangeInfo.listTruncated) preamble.push(LIST_TRUNCATED_NOTICE);
  if (omittedOwn.length > 0) preamble.push(ATTRIBUTION_NOTICE);
  const preambleText = preamble.map((line) => `${line}\n`).join('');

  // A preamble that cannot fit makes no per-commit claim: only the aggregate
  // omission notice is emitted and counted.
  if (preambleText !== '' && byteLength(preambleText) > workingLimit) {
    const aggregate = `${AGGREGATE_NOTICE}\n`;
    appendNotice(aggregate);
    return build(uid, range, rangeInfo, gitVersion, maxBytes, maxCommits, {
      text: parts.join(''), included: [], omittedOwn, truncated: true,
    });
  }
  appendWork(preambleText);

  let remainingSelected = 0;
  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i] as RecordedCommit;

    if (commit.author === uid) {
      const line = `commit ${commit.hash} author ${uid} omitted: own commit\n`;
      if (!appendWork(line)) {
        remainingSelected = commits.length - i;
        truncated = true;
        break;
      }
      continue;
    }

    const parent = await world.firstParent(commit.hash);
    const header = `commit ${commit.hash}\nauthor ${commit.author}\n` +
      `${parent === null ? 'parent none' : `parent ${parent}`}\n`;
    if (!appendWork(header)) {
      remainingSelected = commits.length - i;
      truncated = true;
      break;
    }
    // The header is complete, so this commit's patch is presented as at least an
    // empty prefix: it counts as included even if the patch is cut at its start.
    included.push(commit.hash);

    const remainingWork = workingLimit - work;
    if (remainingWork <= 0) {
      truncated = true;
      appendNotice('patch truncated after 0 bytes\n');
      remainingSelected = commits.length - (i + 1);
      break;
    }

    const capture: DiffCapture = await world.diff({ from: parent, to: commit.hash }, remainingWork);
    appendWork(capture.text);
    if (capture.truncated) {
      truncated = true;
      appendNotice(`patch truncated after ${capture.bytesRetained} bytes\n`);
      remainingSelected = commits.length - (i + 1);
      break;
    }
  }

  const stop = remainingSelected > 0;
  if (stop) appendNotice(`${AGGREGATE_NOTICE}\n`);

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
