import { Buffer } from 'node:buffer';
import type { TurnOpening } from './driver.js';
import type { TurnTrigger } from './events.js';

/**
 * The modern opening receipt's ONE wire formatter (wake v1).
 *
 * A logical request's ordinal-0 system line states physical opening facts, not
 * a continuously fresh "now": `openedAt` is the actual `turn/start` envelope
 * time the driver captured, and the elapsed value comes from the preceding
 * RECORDED `turn/end` envelope time. It never reads a clock, so a barrier, I/O
 * or provider queue that delays delivery cannot make the line stale by
 * construction and no send-time sampling enters the pure assembler.
 *
 * The template is ASCII and bounded well below 256 UTF-8 bytes. A date outside
 * the four-digit UTC ISO range, and any non-finite/unsafe/negative elapsed,
 * renders the honest `unavailable` token instead of a false zero or a truncated
 * number. There is deliberately no arbitrary truncation: every admitted value
 * fits the pinned template.
 */

/** The pinned ceiling for the rendered opening receipt, in UTF-8 bytes. */
export const OPENING_RECEIPT_MAX_BYTES = 256;

/** The strict four-digit UTC ISO form the template admits. */
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The opening instant as normalized UTC ISO, or `unavailable`. */
function utcIso(value: number): string {
  if (!Number.isSafeInteger(value)) return 'unavailable';
  let iso: string;
  try {
    iso = new Date(value).toISOString();
  } catch {
    return 'unavailable';
  }
  // A year outside 0000..9999 renders the expanded six-digit form; the pinned
  // template's date domain is the four-digit one.
  return UTC_ISO_RE.test(iso) ? iso : 'unavailable';
}

/**
 * The elapsed-since-last-recorded-end value: a non-negative safe integer, or
 * `unavailable` for no preceding end and every non-finite/unsafe/negative
 * delta. A backwards clock is unavailable, never a clamped measured zero.
 */
function elapsed(value: number | null): string {
  return value !== null && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : 'unavailable';
}

/**
 * Renders the exact ordinal-0 opening receipt:
 * `Kernel turn receipt: opened_at=<UTC ISO or unavailable>; trigger=<TurnTrigger>; since_last_recorded_end_ms=<integer or unavailable>.`
 * The trigger is the driver's trusted enum. Pure and deterministic.
 */
export function renderOpeningReceipt(opening: TurnOpening, trigger: TurnTrigger): string {
  const receipt = 'Kernel turn receipt: opened_at=' + utcIso(opening.openedAt)
    + `; trigger=${trigger}; since_last_recorded_end_ms=`
    + `${elapsed(opening.sinceLastRecordedEndMs)}.`;
  // By construction: the four-digit ISO (24), the trusted trigger and a
  // 16-digit safe integer fit. A violation is a programming error, not a wire
  // value to truncate.
  if (Buffer.byteLength(receipt, 'utf8') > OPENING_RECEIPT_MAX_BYTES) {
    throw new Error('opening receipt exceeds its 256-byte ceiling');
  }
  return receipt;
}
