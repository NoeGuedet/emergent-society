import { lstat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, syncPath } from '../journal/index.js';
import { singleLine } from '../text.js';

/**
 * The durable degraded-world sidecar: `<home>/world-state.json`.
 *
 * It is a projection, not a record. The local log's `world/commit-refused`
 * event is the node's fact, and `status` may not open the node's log (nor may
 * it read the frontier, which is exchange-only), so the one legal home for a
 * fact `status` can project is a small kernel-owned file in the cell home.
 * The driver writes it at refusal time, before the local writer closes; the
 * host reads it at composition and `status` reads it read-only; it is cleared
 * only when a commit is known to have succeeded — a fresh attempt here, or the
 * interrupted turn's own landed commit found at boot reconcile. W2's ledger
 * supersedes it forward-only.
 *
 * The read is total, like the owner record: a missing, malformed, unreadable
 * or non-regular file is healthy, never a throw. A symlink is refused as
 * observed rather than followed, and an unknown key is malformed. The write is
 * atomic (the journal's fsync-and-rename helper) and owner-only (0600): a crash
 * leaves the previous state or the new one, never a torn file.
 */

/** The one basename this module spells. */
export const WORLD_STATE_BASENAME = 'world-state.json';

/** The on-disk shape: one version, one state bit, an optional reason and time. */
export type WorldState = {
  readonly v: 1;
  readonly degraded: boolean;
  readonly reason?: string;
  readonly at?: number;
};

/** The healthy value a missing or malformed file reads as. */
export const HEALTHY_WORLD_STATE: WorldState = Object.freeze({ v: 1, degraded: false });

/** The sidecar path for one cell home. */
export function worldStatePath(home: string): string {
  return join(home, WORLD_STATE_BASENAME);
}

/** One bounded reason label: status renders it, so it never grows a payload. */
const MAX_REASON_CODE_POINTS = 120;

/**
 * The largest sidecar this kernel writes (a version, a flag, a bounded reason
 * and a timestamp are well under 1 KiB). A larger file is not ours: it reads as
 * healthy before a single byte is parsed, so a hostile or damaged home cannot
 * turn a status report into an unbounded read.
 */
const MAX_SIDECAR_BYTES = 4096;

function boundedReason(reason: string): string {
  return singleLine(reason, MAX_REASON_CODE_POINTS);
}

/**
 * Total validation: only the four known keys, `v === 1`, a boolean `degraded`,
 * an optional string `reason` and an optional nonnegative safe-int `at`.
 * Anything else is `null`, never a throw.
 */
function parseWorldState(raw: unknown): WorldState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (!keys.every((key) => ['v', 'degraded', 'reason', 'at'].includes(key))) return null;
  if (fields['v'] !== 1) return null;
  const degraded = fields['degraded'];
  if (typeof degraded !== 'boolean') return null;
  const reasonValue = fields['reason'];
  if (reasonValue !== undefined && typeof reasonValue !== 'string') return null;
  const atValue = fields['at'];
  if (atValue !== undefined
    && (typeof atValue !== 'number' || !Number.isSafeInteger(atValue) || atValue < 0)) {
    return null;
  }
  if (reasonValue === undefined && atValue === undefined) {
    return { v: 1, degraded };
  }
  if (reasonValue === undefined) {
    return { v: 1, degraded, at: atValue as number };
  }
  if (atValue === undefined) {
    return { v: 1, degraded, reason: reasonValue };
  }
  return { v: 1, degraded, reason: reasonValue, at: atValue };
}

/**
 * Reads the sidecar. Total: every absent, non-regular, unreadable, malformed
 * or invalid file reads as healthy, because the sidecar is a projection that
 * must never make a cell unreadable or a status report fail.
 */
export async function readWorldState(home: string): Promise<WorldState> {
  const path = worldStatePath(home);
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return HEALTHY_WORLD_STATE;
  }
  if (!entry.isFile() || entry.size > MAX_SIDECAR_BYTES) return HEALTHY_WORLD_STATE;
  try {
    const parsed = parseWorldState(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (parsed === null) return HEALTHY_WORLD_STATE;
    // The writer bounds the reason, but the reader cannot trust the file: a
    // reason planted by a same-uid actor is re-bounded exactly like a written
    // one, so `status --json` can never emit an unbounded or formatting value.
    return parsed.reason === undefined
      ? parsed
      : { ...parsed, reason: boundedReason(parsed.reason) };
  } catch {
    return HEALTHY_WORLD_STATE;
  }
}

/**
 * Publishes the degraded state atomically (0600, fsync, rename) and makes the
 * rename's directory entry durable. Called at refusal time, before the node's
 * writer closes.
 */
export async function markWorldDegraded(
  home: string, reason: string, at: number = Date.now(),
): Promise<void> {
  const state: WorldState = { v: 1, degraded: true, reason: boundedReason(reason), at };
  await atomicWriteFile(worldStatePath(home), JSON.stringify(state));
  // The rename is durable only once the directory entry is; the journal's own
  // atomic-write helper says so, and this file has no batch flush to lean on.
  await syncPath(home);
}

/** Clears the degraded state: a commit known to have succeeded is the only writer. */
export async function clearWorldState(home: string): Promise<void> {
  let removed = false;
  try {
    await unlink(worldStatePath(home));
    removed = true;
  } catch (err) {
    // A missing sidecar is already healthy; every other failure (EACCES/EIO)
    // propagates so the caller can decide, never silently keep stale state.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // The unlink is durable only once the removal's directory entry is: the write
  // fsyncs, so the clear must too, or a crash can resurrect a stale sidecar.
  if (removed) await syncPath(home);
}
