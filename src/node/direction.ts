import { runGit } from './world-git.js';
import { GitCommandError } from './errors.js';
import type { WorldRepo } from './world.js';

/**
 * The world's ratified direction.
 *
 * The direction is a world file, not a journal field: the human ratifies a
 * revision by committing `DIRECTION.md` authored as `human`. A node's own
 * commit of the same file is a draft — it is in the world's history (the
 * archive is that history, never a duplicate copy) but it is not authoritative
 * until the human ratifies it. The kernel pins the content of the latest
 * human-authored commit that touched the file, so agent zero can draft freely
 * without moving the direction.
 *
 * The read is two ordinary git reads (`log -- DIRECTION.md` then
 * `show <commit>:DIRECTION.md`), bounded by the world's git deadlines; the
 * content is capped at `DIRECTION_MAX_BYTES` so the pinned prefix stays a
 * bounded, cache-stable block. A world with no ratified direction, or an empty
 * one, returns null and the runtime falls back to the journaled heading.
 */

/** The world path the human ratifies. */
export const DIRECTION_PATH = 'DIRECTION.md';

/** The pinned block's byte ceiling: a direction, not a document dump. */
export const DIRECTION_MAX_BYTES = 8192;

/** One ratified direction: the ratifying commit and its pinned text. */
export type DirectionPin = {
  readonly commit: string;
  readonly text: string;
};

/** Reads the latest human-ratified `DIRECTION.md`, or null when none exists. */
export async function readRatifiedDirection(
  world: WorldRepo, timeoutMs?: number,
): Promise<DirectionPin | null> {
  const git = (args: readonly string[]): Promise<string> => runGit(
    world.path, [...world.gitBaseArgs(), ...args], undefined, timeoutMs,
  );
  // An unborn repository has no history to search: no direction, not a failure.
  try {
    await git(['rev-parse', '--verify', 'HEAD']);
  } catch (err) {
    if (err instanceof GitCommandError && err.kind === 'exit') return null;
    throw err;
  }
  // Newest first; the first commit authored by the human is the ratified one.
  const log = await git(['log', '--format=%H%x00%an', '--', DIRECTION_PATH]);
  let commit: string | null = null;
  for (const line of log.split('\n')) {
    if (line === '') continue;
    const [hash = '', author = ''] = line.split('\0');
    if (author === HUMAN_AT_WORLD) {
      commit = hash;
      break;
    }
  }
  if (commit === null) return null;
  const raw = await git(['show', `${commit}:${DIRECTION_PATH}`]);
  const text = boundDirection(raw);
  if (text === null) return null;
  return { commit, text };
}

/** The one author name the human ratifier commits under (see the uid reservation). */
const HUMAN_AT_WORLD = 'human';

/** Bounds the pinned text at a code-point boundary; an empty direction is null. */
function boundDirection(raw: string): string | null {
  if (raw.trim() === '') return null;
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length <= DIRECTION_MAX_BYTES) return raw;
  // Cut by code points, never inside one: decode the bounded prefix and drop a
  // trailing replacement character a split would have produced.
  let text = bytes.subarray(0, DIRECTION_MAX_BYTES).toString('utf8');
  if (text.endsWith('\uFFFD')) text = text.slice(0, -1);
  return `${text}\n\n[the direction is longer than ${DIRECTION_MAX_BYTES} bytes; the rest is truncated]`;
}
