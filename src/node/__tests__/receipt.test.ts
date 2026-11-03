import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { OPENING_RECEIPT_MAX_BYTES, renderOpeningReceipt } from '../receipt.js';
import type { TurnTrigger } from '../events.js';

/**
 * The modern opening receipt's formatter (wake v1): exact template, normalized
 * UTC ISO, honest `unavailable` for every out-of-domain/backwards value, the
 * string (never numeric-clamped) elapsed, and the 256-byte bound. This is the
 * pure renderer; the loop's ordinal-0 placement and the driver's envelope-time
 * facts are pinned in loop.test.ts and driver-wake.test.ts.
 */

const T = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

describe('renderOpeningReceipt', () => {
  it('renders the exact pinned template with the actual opening time and elapsed', () => {
    expect(renderOpeningReceipt({ openedAt: T, sinceLastRecordedEndMs: 1234 }, 'cadence'))
      .toBe('Kernel turn receipt: opened_at=2023-11-14T22:13:20.000Z; trigger=cadence;'
        + ' since_last_recorded_end_ms=1234.');
    // Every trusted trigger renders as its enum token.
    for (const trigger of [
      'boot', 'wakeup', 'timer', 'conversation', 'chain', 'cadence',
    ] as const satisfies readonly TurnTrigger[]) {
      expect(renderOpeningReceipt({ openedAt: T, sinceLastRecordedEndMs: null }, trigger))
        .toContain(`trigger=${trigger}; since_last_recorded_end_ms=unavailable.`);
    }
  });

  it('renders unavailable for no prior end and every non-finite/unsafe/negative delta', () => {
    for (const elapsed of [null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1]) {
      expect(renderOpeningReceipt({ openedAt: T, sinceLastRecordedEndMs: elapsed }, 'boot'))
        .toContain('since_last_recorded_end_ms=unavailable.');
    }
    // A measured zero is a real fact, not unavailable.
    expect(renderOpeningReceipt({ openedAt: T, sinceLastRecordedEndMs: 0 }, 'timer'))
      .toContain('since_last_recorded_end_ms=0.');
  });

  it('renders unavailable for a date outside the four-digit ISO range, never a throw', () => {
    for (const openedAt of [
      Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER, 8.64e15 + 1,
    ]) {
      expect(renderOpeningReceipt({ openedAt, sinceLastRecordedEndMs: 0 }, 'wakeup'))
        .toContain('opened_at=unavailable;');
    }
    // Year 10000 is outside the pinned four-digit ISO form.
    expect(renderOpeningReceipt({
      openedAt: Date.UTC(10_000, 0, 1), sinceLastRecordedEndMs: 0,
    }, 'boot')).toContain('opened_at=unavailable;');
    // The epoch itself is a valid four-digit UTC instant.
    expect(renderOpeningReceipt({ openedAt: 0, sinceLastRecordedEndMs: null }, 'boot'))
      .toContain('opened_at=1970-01-01T00:00:00.000Z;');
  });

  it('is ASCII and bounded well under the 256-byte ceiling for every admitted form', () => {
    const values = [
      renderOpeningReceipt({
        openedAt: T, sinceLastRecordedEndMs: Number.MAX_SAFE_INTEGER,
      }, 'conversation'),
      renderOpeningReceipt({ openedAt: 0, sinceLastRecordedEndMs: 0 }, 'boot'),
      renderOpeningReceipt({
        openedAt: T, sinceLastRecordedEndMs: null,
      }, 'cadence'),
    ];
    for (const value of values) {
      expect(/^[\x20-\x7e]+$/.test(value)).toBe(true);
      expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(OPENING_RECEIPT_MAX_BYTES);
    }
  });
});
