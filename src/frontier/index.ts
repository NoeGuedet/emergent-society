/**
 * The frontier journal's public surface.
 *
 * The vocabulary and its validators come from `events.ts`; the gate and the
 * boot-time reconciliation come from `journal.ts`. Only two validators remain
 * barrel-visible: `validateFrontierEvent`, which checks an assembled payload
 * before it is journaled, and `validateFrontierUrl`. The two input validators
 * (`validateBeginInput`, `validateOutcome`) are module-internal to the gate and
 * are not part of this surface. The two typed refusals the gate raises are
 * exported here: `FrontierUnknownCallError` for a terminal whose call this
 * process never began, and `FrontierCorruptionError` for damaged journal
 * contents — the latter extends the journal's exported `CorruptionError`, so
 * `isCorruption()` classifies it.
 */

export type {
  BodyRef, CallId, FrontierCall, FrontierErrorCode, FrontierEventDataMap,
  FrontierOutcome, FrontierRequestInput, HttpIncomplete, HttpRequest, HttpResponse,
} from './events.js';
export {
  FRONTIER_EVENT_TYPES, FRONTIER_MAX_BODY_BYTES, FRONTIER_MAX_CREDENTIAL_ID,
  FRONTIER_MAX_CREDENTIALS, FRONTIER_MAX_URL_BYTES, FRONTIER_REQUEST_HEADERS,
  FRONTIER_RESPONSE_HEADERS, HEADER_TRUNCATION_MARK, HEADER_VALUE_LIMIT,
  WORLD_HEAD_RE, filterHeaders, validateFrontierEvent, validateFrontierUrl,
  FrontierValidationError,
} from './events.js';

export type { Frontier, FrontierJournal } from './journal.js';
export {
  FrontierCorruptionError, FrontierUnknownCallError, openFrontierJournal,
} from './journal.js';
