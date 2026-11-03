import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CADENCE_REST_MS, cadencePhaseMs, isCadencePeriod, nextCadenceDueMs,
} from '../cadence.js';
import { MAX_HEARTBEAT_SECONDS } from '../../context/contracts.js';

/**
 * The pure cadence math: a per-uid phase grid selected at actual park, with a
 * one-second technical rest, no replay loop and one null contract for a clock
 * that cannot be represented safely.
 */

const uidWord = (uid: string): number =>
  createHash('sha256').update(uid, 'utf8').digest().readUInt32BE(0);

const PERIOD_S = 5;
const PERIOD_MS = PERIOD_S * 1000;
const NOW = 1_800_000_000_000;

describe('cadence phase', () => {
  it('is SHA-256(uid)\'s first u32BE modulo the period, stable per uid', () => {
    for (const uid of ['n1', 'node-0', 'node-17', 'ünicode']) {
      const phase = cadencePhaseMs(uid, PERIOD_MS);
      expect(phase).toBe(uidWord(uid) % PERIOD_MS);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(PERIOD_MS);
      expect(cadencePhaseMs(uid, PERIOD_MS)).toBe(phase);
    }
    // Collisions are allowed: the hash reduces them, it does not prove fairness.
    expect(cadencePhaseMs('n1', 1)).toBe(0);
  });
});

describe('nextCadenceDueMs', () => {
  it('is the first grid instant at or after park+rest, not now+period', () => {
    const phase = cadencePhaseMs('n1', PERIOD_MS);
    const due = nextCadenceDueMs('n1', PERIOD_S, NOW);
    expect(due).not.toBeNull();
    const eligible = NOW + CADENCE_REST_MS;
    expect(due!).toBeGreaterThanOrEqual(eligible);
    // A grid instant: grid = k*period + phase.
    expect((due! - phase) % PERIOD_MS).toBe(0);
    // The PREVIOUS grid instant is before eligibility: this is the first one.
    expect(due! - PERIOD_MS).toBeLessThan(eligible);
    // A uid with a non-zero phase distinguishes the grid from now+period.
    if (phase !== 0) expect(due!).not.toBe(NOW + PERIOD_MS);
  });

  it('accepts a grid point exactly at the rest boundary', () => {
    const phase = cadencePhaseMs('n1', PERIOD_MS);
    // Pick a grid instant far enough out (k >= 2) and put parkNow exactly
    // rest-ms before it. The boundary itself is eligible: no extra step.
    const grid = phase + 2 * PERIOD_MS;
    const parkNow = grid - CADENCE_REST_MS;
    expect(nextCadenceDueMs('n1', PERIOD_S, parkNow)).toBe(grid);
  });

  it('SKIPS a grid point inside the rest band: no replay and no debt', () => {
    const phase = cadencePhaseMs('n1', PERIOD_MS);
    const grid = phase + 3 * PERIOD_MS;
    // parkNow+1000 is one ms past the grid: the near point is inside the band,
    // so the next due is exactly one period later, never the missed slot.
    const parkNow = grid - (CADENCE_REST_MS - 1);
    expect(nextCadenceDueMs('n1', PERIOD_S, parkNow)).toBe(grid + PERIOD_MS);
  });

  it('takes one step over a huge forward jump, never a loop over missed slots', () => {
    const due = nextCadenceDueMs('n1', 3600, NOW + 30 * 24 * 3600 * 1000);
    expect(due).not.toBeNull();
    expect(due!).toBeGreaterThanOrEqual(NOW + 30 * 24 * 3600 * 1000 + CADENCE_REST_MS);
  });

  it('returns null for an invalid period or an unsafe clock, never NaN/overflow', () => {
    for (const badPeriod of [
      0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_HEARTBEAT_SECONDS + 1,
    ]) {
      expect(nextCadenceDueMs('n1', badPeriod, NOW)).toBeNull();
      expect(isCadencePeriod(badPeriod)).toBe(false);
    }
    for (const badNow of [
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5,
      Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 500,
    ]) {
      expect(nextCadenceDueMs('n1', PERIOD_S, badNow)).toBeNull();
    }
    expect(nextCadenceDueMs('n1', PERIOD_S, NOW)).not.toBeNull();
    // The full seven-day domain is still safely representable at ordinary now.
    expect(nextCadenceDueMs('n1', MAX_HEARTBEAT_SECONDS, NOW)).not.toBeNull();
  });
});
