import { createHash } from 'node:crypto';
import { MAX_HEARTBEAT_SECONDS } from '../context/contracts.js';

/**
 * The modern wake policy's pure cadence math (wake v1).
 *
 * Cadence is a per-node wall-clock grid, not a consumption clock and not a
 * home-wide quiet predicate: the phase is the first unsigned 32-bit big-endian
 * word of SHA-256(uid) modulo the period in milliseconds, and the grid instants
 * are `k * periodMs + phase`. The hash reduces collisions; it proves nothing
 * about fairness (two uids may share a phase), and it is never journaled.
 *
 * At a park the driver chooses the first grid instant at or after
 * `parkNow + CADENCE_REST_MS`. The rest band is a technical spacing, not a
 * count budget: a grid point inside the band is SKIPPED, never owed or
 * replayed, and there is no loop over missed intervals. The arithmetic is
 * closed over safe integers; anything a wall clock can do that would produce a
 * non-finite or unsafe instant returns null, and the driver then arms no
 * cadence and reports one bounded `WakeClockUnavailableError` instead of
 * scheduling NaN/negative/overflow.
 */

/** The cadence-only minimum technical rest at actual park: one second. */
export const CADENCE_REST_MS = 1000;

const PERIOD_MS = 1000;

/** Whether a value is a valid cadence period in seconds (positive, in domain). */
export function isCadencePeriod(heartbeatSeconds: number): boolean {
  return Number.isSafeInteger(heartbeatSeconds)
    && heartbeatSeconds > 0
    && heartbeatSeconds <= MAX_HEARTBEAT_SECONDS;
}

/**
 * The deterministic phase for one uid and period: SHA-256(uid)'s first
 * unsigned 32-bit big-endian word modulo `periodMs`. The caller must pass a
 * positive safe-integer period; the period's own domain is validated by
 * `isCadencePeriod` before it is derived.
 */
export function cadencePhaseMs(uid: string, periodMs: number): number {
  if (!Number.isSafeInteger(periodMs) || periodMs <= 0) {
    throw new RangeError('cadence period must be a positive safe integer');
  }
  const digest = createHash('sha256').update(uid, 'utf8').digest();
  return digest.readUInt32BE(0) % periodMs;
}

/**
 * The first cadence grid instant at or after `parkNow + CADENCE_REST_MS`, or
 * null when the clock/period/due cannot be represented safely.
 *
 * One floor division, never a loop over missed slots: a node that was active
 * for an hour or down for a week wakes at the next future slot, and the slots
 * it missed are covered/skipped, never queued as debt. A grid point exactly at
 * the rest boundary is eligible; one inside the rest band is skipped.
 */
export function nextCadenceDueMs(
  uid: string, heartbeatSeconds: number, parkNow: number,
): number | null {
  if (!isCadencePeriod(heartbeatSeconds)) return null;
  if (!Number.isSafeInteger(parkNow) || parkNow < 0) return null;
  const periodMs = heartbeatSeconds * PERIOD_MS;
  if (!Number.isSafeInteger(periodMs) || periodMs <= 0) return null;
  const eligible = parkNow + CADENCE_REST_MS;
  if (!Number.isSafeInteger(eligible)) return null;
  const phase = cadencePhaseMs(uid, periodMs);
  // The grid instant with k = ceil((eligible - phase) / periodMs). For a
  // non-negative eligible this can land exactly on the boundary (eligible) or
  // before it only when phase < eligible and k resolved to 0; the correction is
  // one step, not an interval walk.
  let k = Math.ceil((eligible - phase) / periodMs);
  if (!Number.isSafeInteger(k)) return null;
  let due = k * periodMs + phase;
  if (!Number.isSafeInteger(due)) return null;
  if (due < eligible) {
    k += 1;
    due = k * periodMs + phase;
    if (!Number.isSafeInteger(due)) return null;
  }
  if (due < eligible || due > Number.MAX_SAFE_INTEGER) return null;
  return due;
}
