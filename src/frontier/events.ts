import {
  CLAIM_CHECK_THRESHOLD, HASH_RE, canonicalizeJson, copyJsonValue, type JsonValue,
} from '../journal/index.js';
import { isRecord } from '../util.js';

/**
 * The frontier journal's event vocabulary and its input validators.
 *
 * Three event types — `http/request`, `http/response`, `http/incomplete` —
 * describe one kernel-mediated HTTP exchange each, and nothing about the
 * agentic system: no node, turn, provider, model, token or cost field can be
 * expressed here, and the validators refuse unknown keys so one cannot be
 * smuggled in. The vocabulary is registered only for the frontier journal: it
 * does not merge into the shared `EventDataMap` (that map is the local log's
 * typed surface), so the frontier module owns its own map and the gate's
 * typing.
 *
 * Every body is a blob reference (`BodyRef`), never bytes: the event payload
 * stays small enough that the writer never claim-checks it, identical bodies
 * are stored once, and the boot-time orphan scan never has to resolve a blob to
 * find a call id. The size rule is enforced on the canonical payload — the
 * writer's own unit — against `CLAIM_CHECK_THRESHOLD`, imported rather than
 * restated. The structural bounds beneath it (URL bytes, credential count and
 * id length, filtered header values, the method token's alphabet) exist so that
 * check never fires on a legitimate event; `method` is deliberately the one
 * field with no structural length bound, and therefore where an oversized
 * event is assembled without a structural refusal hiding the backstop.
 *
 * Two layers validate: `validateFrontierEvent` checks an assembled payload (the
 * coherence table included), while `validateBeginInput`/`validateOutcome` check
 * what a producer hands the gate. The gate validates both, in that order, so a
 * refusal happens before any blob or event exists.
 *
 * The schema primitives (`record`, `onlyKeys`, `text`, `bool`, `safeInt`,
 * `array`) repeat the C1.3 validator idiom rather than importing it: the
 * frontier sits below the context layer and must not depend on it. The
 * duplication is bounded to those six; anything shape-specific lives here once.
 *
 * Every refusal throws `FrontierValidationError`. Nothing here reads a clock or
 * touches the filesystem: a payload either validates to its frozen data form or
 * it does not.
 */

/** A frontier call or group id: a fresh `crypto.randomUUID()` minted by the gate. */
export type CallId = string;

/** The body reference: the blob always holds the exact bytes. */
export type BodyRef = {
  readonly encoding: 'utf8' | 'binary';  // a producer-declared interpretation label
  readonly sha256: string;               // digest of the exact bytes = the blob address
  readonly bytes: number;                // byte length of the exact bytes
  readonly complete: boolean;            // false when the producer captured a bounded prefix
};

/** One credential use, by id and placement — never by value. */
type CredentialUse = {
  readonly id: string;
  readonly where: 'authorization';
};

/** The wire facts of one mediated HTTP request, durable before the send. */
export type HttpRequest = {
  readonly call: CallId;
  readonly group: CallId;            // shared by every attempt of one logical operation
  readonly attempt: number;          // 0-based, supplied by the caller, validated by the gate
  readonly method: string;           // 'POST' today; the vocabulary does not forbid others
  readonly url: string;              // scheme://host/path — no query, no fragment, no userinfo
  readonly headers: Readonly<Record<string, string>>;   // allowlist only
  readonly credentials: readonly CredentialUse[];
  readonly body: BodyRef;            // a request body is always complete (the bytes exist before the send)
  readonly world_head: string | null; // the world HEAD the kernel observed — best-effort
};

/** The terminal outcome of one call, durable before the caller proceeds. */
export type HttpResponse = {
  readonly call: CallId;
  readonly status: number | null;    // null when no HTTP status was received
  readonly headers: Readonly<Record<string, string>>;   // allowlist only
  readonly body: BodyRef;            // the received capture (possibly empty or partial)
  readonly timing: { readonly durationMs: number };     // gate-measured begin→complete
  readonly error: { readonly code: FrontierErrorCode } | null;
};

export type FrontierErrorCode =
  | 'http'          // a non-200 status was received
  | 'network'       // transport failure (no status, or an in-stream failure with a known status)
  | 'timeout'       // the caller's own timeout (a status may be known for an in-stream cut)
  | 'cancelled'     // the caller's abort — no response was processed
  | 'body-limit'    // the capture hit the byte bound (status may be known, body is a prefix)
  | 'local';        // the kernel's own machinery failed before the exchange could begin
                    // (nothing was handed to the transport)

/** Boot-time reconciliation: a request with no terminal record. A fact, not a guess. */
export type HttpIncomplete = { readonly call: CallId };

export interface FrontierEventDataMap {
  'http/request': HttpRequest;
  'http/response': HttpResponse;
  'http/incomplete': HttpIncomplete;
}

export const FRONTIER_EVENT_TYPES: ReadonlySet<string> =
  new Set(['http/request', 'http/response', 'http/incomplete']);

/** What the gate accepts from a producer before it assembles the request event. */
export type FrontierRequestInput = {
  readonly group?: CallId;            // omitted on attempt 0 (the gate mints call+group)
  readonly attempt?: number;          // default 0
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;   // already filtered
  readonly credentials?: readonly CredentialUse[];
  readonly body: Uint8Array;
  readonly encoding: 'utf8' | 'binary';                 // the producer's label for its bytes
};

export type FrontierCall = { readonly call: CallId; readonly group: CallId };

/** What the gate accepts from a producer to close a call. */
export type FrontierOutcome = {
  readonly status: number | null;
  readonly headers?: Readonly<Record<string, string>>;   // already filtered; default {}
  readonly body: Uint8Array;
  readonly encoding: 'utf8' | 'binary';
  readonly complete: boolean;
  readonly error?: FrontierErrorCode;                    // required when status is null
};

/**
 * A payload that will not be journaled. It is a caller/shape refusal, not
 * damage to the log, so it is not part of the journal's corruption family: the
 * gate stops the exchange before anything crosses the frontier.
 */
export class FrontierValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FrontierValidationError';
  }
}

/**
 * The largest request body the gate will journal (and therefore send). It
 * equals the node gate's capture ceiling, but the equality is pinned node-side:
 * this module never imports `node/`.
 */
export const FRONTIER_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** A journaled URL is RFC 3986 characters and at most 4 KiB. */
export const FRONTIER_MAX_URL_BYTES = 4096;

/** At most four credential uses ride one request. */
export const FRONTIER_MAX_CREDENTIALS = 4;

/** A credential id is the registry key, at most 64 characters. */
export const FRONTIER_MAX_CREDENTIAL_ID = 64;

/** A journaled header value is at most this many code points, truncation mark included. */
export const HEADER_VALUE_LIMIT = 128;

/** The exact marker appended to a truncated header value. */
export const HEADER_TRUNCATION_MARK = '…[truncated]';

/**
 * The world HEAD a request stamps: a 40- or 64-character lowercase hex commit
 * hash, or null when it could not be read. The gate normalizes its best-effort
 * stamp with this same object, so a bad stamp reads as null, never as a refusal.
 */
export const WORLD_HEAD_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Request headers that may be journaled. Values never include credentials. */
export const FRONTIER_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'content-type', 'accept', 'anthropic-version',
]);

/** Response headers that may be journaled. */
export const FRONTIER_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-type', 'request-id', 'x-request-id', 'retry-after',
]);

// --- the validator primitives, in the C1.3 idiom ---------------------------------

function fail(where: string, message: string): never {
  throw new FrontierValidationError(`invalid ${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(where, 'expected an object');
  return value;
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(where, `unexpected key ${JSON.stringify(key)}`);
  }
}

function text(value: unknown, where: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    fail(where, nonEmpty ? 'expected a nonempty string' : 'expected a string');
  }
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(where, 'expected a boolean');
  return value;
}

function safeInt(value: unknown, where: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(where, `expected a safe integer >= ${min}`);
  }
  return value;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, 'expected an array');
  return value as unknown[];
}

/** The header bound is measured in code points on both sides of the gate. */
function codePoints(value: string): number {
  return Array.from(value).length;
}

function hash(value: unknown, where: string): string {
  const digest = text(value, where);
  if (!HASH_RE.test(digest)) fail(where, 'expected 64 lowercase hex characters');
  return digest;
}

function encodingOf(value: unknown, where: string): 'utf8' | 'binary' {
  if (value !== 'utf8' && value !== 'binary') fail(where, "expected 'utf8' or 'binary'");
  return value;
}

/**
 * `tchar` per RFC 7230, and nothing else: no separator, no whitespace. The
 * token's length is left to the canonical-size backstop.
 */
const METHOD_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function methodOf(value: unknown, where: string): string {
  const method = text(value, where);
  if (!METHOD_TOKEN_RE.test(method)) fail(where, 'expected an RFC 7230 token');
  return method;
}

/**
 * The RFC 3986 character repertoire: unreserved, sub-delims, gen-delims and the
 * percent sign (which must introduce a two-hex-digit escape). Space, `"`, `<`,
 * `>`, `\`, `^`, `` ` ``, `{`, `|`, `}`, `%` misuse and every non-ASCII
 * character are outside the grammar and refused.
 */
const URL_CHARS_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const BAD_PERCENT_RE = /%(?![0-9A-Fa-f]{2})/;
const URL_RE = /^(https?):\/\/([^/?#]+)(\/[^?#]*)$/;
const AUTHORITY_RE =
  /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9\-._~!$&'()*+,;=%]+)(?::[0-9]{1,5})?$/;

/**
 * The one frontier URL predicate: `https?://host/path` with no query string, no
 * fragment and no userinfo, so no credential can ride a URL at all. It returns
 * the validated string unchanged and throws `FrontierValidationError`
 * otherwise. The providers factory applies this same object at construction, so
 * a misconfigured endpoint is refused once, loudly, and `begin` can never
 * discover a URL problem the constructor missed.
 */
export function validateFrontierUrl(url: string): string {
  if (typeof url !== 'string') fail('frontier url', 'expected a string');
  if (Buffer.byteLength(url, 'utf8') > FRONTIER_MAX_URL_BYTES) {
    fail('frontier url', `expected at most ${FRONTIER_MAX_URL_BYTES} bytes`);
  }
  if (!URL_CHARS_RE.test(url)) fail('frontier url', 'expected only RFC 3986 characters');
  if (BAD_PERCENT_RE.test(url)) fail('frontier url', 'invalid percent escape');
  const match = URL_RE.exec(url);
  if (match === null) {
    fail('frontier url', 'expected https://host/path with no query string, fragment or userinfo');
  }
  const authority = match[2]!;
  if (authority.includes('@')) fail('frontier url', 'userinfo is not allowed');
  if (!AUTHORITY_RE.test(authority)) fail('frontier url', 'expected a valid host');
  return url;
}

// --- shared payload fragments ----------------------------------------------------

function callOf(value: unknown, where: string): CallId {
  return text(value, where);
}

function statusOf(value: unknown, where: string): number | null {
  return value === null ? null : safeInt(value, where, 0);
}

const FRONTIER_ERROR_CODES = {
  http: true, network: true, timeout: true, cancelled: true, 'body-limit': true, local: true,
} satisfies Record<FrontierErrorCode, true>;

function errorCodeOf(value: unknown, where: string): FrontierErrorCode {
  const code = text(value, where);
  if (!Object.hasOwn(FRONTIER_ERROR_CODES, code)) {
    fail(where, `unknown error code ${JSON.stringify(code)}`);
  }
  return code as FrontierErrorCode;
}

function bodyRefOf(value: unknown, where: string): BodyRef {
  const o = record(value, where);
  onlyKeys(o, ['encoding', 'sha256', 'bytes', 'complete'], where);
  return {
    encoding: encodingOf(o['encoding'], `${where}.encoding`),
    sha256: hash(o['sha256'], `${where}.sha256`),
    bytes: safeInt(o['bytes'], `${where}.bytes`, 0),
    complete: bool(o['complete'], `${where}.complete`),
  };
}

function worldHeadOf(value: unknown, where: string): string | null {
  if (value === null) return null;
  const head = text(value, where);
  if (!WORLD_HEAD_RE.test(head)) {
    fail(where, 'expected 40 or 64 lowercase hex characters, or null');
  }
  return head;
}

/**
 * The allowlist and the value bound, enforced again at append: a producer that
 * bypassed `filterHeaders` is refused, so an `authorization`, `cookie`,
 * `set-cookie` or `x-api-key` value can never reach the journal by this path.
 */
function headersOf(
  value: unknown, where: string, allowed: ReadonlySet<string>,
): Record<string, string> {
  const o = record(value, where);
  const out: Record<string, string> = {};
  for (const name of Object.keys(o)) {
    if (!allowed.has(name)) fail(where, `header ${JSON.stringify(name)} is not allowlisted`);
    const headerValue = text(o[name], `${where}.${name}`, false);
    if (codePoints(headerValue) > HEADER_VALUE_LIMIT) {
      fail(`${where}.${name}`, `expected at most ${HEADER_VALUE_LIMIT} code points`);
    }
    out[name] = headerValue;
  }
  return out;
}

function credentialsOf(value: unknown, where: string): readonly CredentialUse[] {
  const entries = array(value, where);
  if (entries.length > FRONTIER_MAX_CREDENTIALS) {
    fail(where, `expected at most ${FRONTIER_MAX_CREDENTIALS} entries`);
  }
  return entries.map((entry, index) => {
    const at = `${where}[${index}]`;
    const o = record(entry, at);
    onlyKeys(o, ['id', 'where'], at);
    const id = text(o['id'], `${at}.id`);
    if (codePoints(id) > FRONTIER_MAX_CREDENTIAL_ID) {
      fail(`${at}.id`, `expected at most ${FRONTIER_MAX_CREDENTIAL_ID} characters`);
    }
    if (o['where'] !== 'authorization') fail(`${at}.where`, "must be 'authorization'");
    return { id, where: 'authorization' as const };
  });
}

function bytesOf(value: unknown, where: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail(where, 'expected bytes');
  return value;
}

/** The codes a terminal with no status may carry: no response was processed. */
const NO_STATUS_CODES: ReadonlySet<FrontierErrorCode> =
  new Set(['network', 'timeout', 'cancelled', 'local']);

/**
 * The status/error coherence table, in one place. `status: null` admits only the
 * no-response codes; `http` names a non-200 status; a non-200 status needs an
 * error; a complete body means the exchange finished and was read whole, so it
 * admits only `null` or `http`; and `local` is strictly pre-send.
 */
function assertCoherent(
  where: string, status: number | null, code: FrontierErrorCode | null, complete: boolean,
): void {
  if (status === null && (code === null || !NO_STATUS_CODES.has(code))) {
    fail(where, 'a null status requires error network, timeout, cancelled or local');
  }
  if (code === 'http' && (status === null || status === 200)) {
    fail(where, "error 'http' requires a non-null, non-200 status");
  }
  if (status !== null && status !== 200 && code === null) {
    fail(where, 'a non-200 status requires an error');
  }
  if (status === 200 && code === null && !complete) {
    fail(where, 'a 200 with no error requires a complete body');
  }
  if (complete && code !== null && code !== 'http') {
    fail(where, "a complete body admits only error null or 'http'");
  }
  if (code === 'body-limit' && complete) {
    fail(where, "error 'body-limit' requires an incomplete body");
  }
  if (code === 'local' && (status !== null || complete)) {
    fail(where, "error 'local' requires status null and an incomplete body");
  }
  if (status === null && complete) {
    fail(where, 'a null status requires an incomplete body');
  }
}

// --- the event payload validators -------------------------------------------------

function requestEvent(data: unknown): HttpRequest {
  const where = 'http/request';
  const o = record(data, where);
  onlyKeys(o, [
    'call', 'group', 'attempt', 'method', 'url', 'headers', 'credentials', 'body', 'world_head',
  ], where);
  const body = bodyRefOf(o['body'], `${where}.body`);
  if (!body.complete) fail(`${where}.body.complete`, 'a request body is always complete');
  return {
    call: callOf(o['call'], `${where}.call`),
    group: callOf(o['group'], `${where}.group`),
    attempt: safeInt(o['attempt'], `${where}.attempt`, 0),
    method: methodOf(o['method'], `${where}.method`),
    url: validateFrontierUrl(text(o['url'], `${where}.url`)),
    headers: headersOf(o['headers'], `${where}.headers`, FRONTIER_REQUEST_HEADERS),
    credentials: credentialsOf(o['credentials'], `${where}.credentials`),
    body,
    world_head: worldHeadOf(o['world_head'], `${where}.world_head`),
  };
}

function responseEvent(data: unknown): HttpResponse {
  const where = 'http/response';
  const o = record(data, where);
  onlyKeys(o, ['call', 'status', 'headers', 'body', 'timing', 'error'], where);
  const status = statusOf(o['status'], `${where}.status`);
  const body = bodyRefOf(o['body'], `${where}.body`);
  const error = responseErrorOf(o['error'], `${where}.error`);
  assertCoherent(where, status, error === null ? null : error.code, body.complete);
  return {
    call: callOf(o['call'], `${where}.call`),
    status,
    headers: headersOf(o['headers'], `${where}.headers`, FRONTIER_RESPONSE_HEADERS),
    body,
    timing: durationOf(o['timing'], `${where}.timing`),
    error,
  };
}

function responseErrorOf(value: unknown, where: string): HttpResponse['error'] {
  if (value === null) return null;
  if (!isRecord(value)) fail(where, 'expected null or an object');
  const o = value;
  onlyKeys(o, ['code'], where);
  return { code: errorCodeOf(o['code'], `${where}.code`) };
}

function durationOf(value: unknown, where: string): { readonly durationMs: number } {
  const o = record(value, where);
  onlyKeys(o, ['durationMs'], where);
  const durationMs = o['durationMs'];
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    fail(`${where}.durationMs`, 'expected a finite non-negative number');
  }
  return { durationMs };
}

function incompleteEvent(data: unknown): HttpIncomplete {
  const where = 'http/incomplete';
  const o = record(data, where);
  onlyKeys(o, ['call'], where);
  return { call: callOf(o['call'], `${where}.call`) };
}

/**
 * The final measure: the payload's canonical UTF-8 bytes must stay below the
 * writer's claim-check threshold, so a frontier event is never claim-checked and
 * the orphan scan never resolves a blob. A payload that cannot be canonicalized
 * at all is refused here too, with the same typed error.
 */
function canonicalPayload(type: string, value: unknown): JsonValue {
  let copy: JsonValue;
  let canonical: string;
  try {
    copy = copyJsonValue(value);
    canonical = canonicalizeJson(copy);
  } catch (err) {
    throw new FrontierValidationError(
      `invalid ${type}: payload is not canonicalizable`, { cause: err });
  }
  if (Buffer.byteLength(canonical, 'utf8') >= CLAIM_CHECK_THRESHOLD) {
    fail(type, `canonical payload reaches ${CLAIM_CHECK_THRESHOLD} bytes`);
  }
  return copy;
}

/**
 * Validates a **payload** for a known frontier type and returns its validated
 * canonical data form. The envelope (`seq`/`time`/`hash`) belongs to the writer,
 * never to the validator; nothing here reads a clock.
 */
export function validateFrontierEvent(type: string, data: unknown): JsonValue {
  if (!FRONTIER_EVENT_TYPES.has(type)) {
    fail('frontier event', `unknown type ${JSON.stringify(type)}`);
  }
  switch (type) {
    case 'http/request': return canonicalPayload(type, requestEvent(data));
    case 'http/response': return canonicalPayload(type, responseEvent(data));
    case 'http/incomplete': return canonicalPayload(type, incompleteEvent(data));
    default: return fail('frontier event', `unknown type ${JSON.stringify(type)}`);
  }
}

// --- the input validators ---------------------------------------------------------

/**
 * Validates what a producer hands `begin`. `world_head` is refused here because
 * the gate stamps it: an input cannot claim a world state the kernel did not
 * observe. An `attempt` above zero requires its `group` — a retry with no
 * group would be a fresh logical operation wearing an attempt number.
 */
export function validateBeginInput(input: unknown): FrontierRequestInput {
  const where = 'begin input';
  const o = record(input, where);
  onlyKeys(o, [
    'group', 'attempt', 'method', 'url', 'headers', 'credentials', 'body', 'encoding',
  ], where);
  const attempt = o['attempt'] === undefined ? 0 : safeInt(o['attempt'], `${where}.attempt`, 0);
  const group = o['group'] === undefined ? undefined : callOf(o['group'], `${where}.group`);
  if (attempt > 0 && group === undefined) fail(where, 'attempt > 0 requires a group');
  const headers = headersOf(o['headers'], `${where}.headers`, FRONTIER_REQUEST_HEADERS);
  const credentials = o['credentials'] === undefined
    ? []
    : credentialsOf(o['credentials'], `${where}.credentials`);
  return {
    method: methodOf(o['method'], `${where}.method`),
    url: validateFrontierUrl(text(o['url'], `${where}.url`)),
    headers,
    credentials,
    body: bytesOf(o['body'], `${where}.body`),
    encoding: encodingOf(o['encoding'], `${where}.encoding`),
    attempt,
    ...(group === undefined ? {} : { group }),
  };
}

/**
 * Validates what a producer hands `complete`: the same coherence table the
 * assembled terminal must satisfy, applied to the input before any blob exists.
 */
export function validateOutcome(outcome: unknown): FrontierOutcome {
  const where = 'outcome';
  const o = record(outcome, where);
  onlyKeys(o, ['status', 'headers', 'body', 'encoding', 'complete', 'error'], where);
  const status = statusOf(o['status'], `${where}.status`);
  const complete = bool(o['complete'], `${where}.complete`);
  const error = o['error'] === undefined
    ? undefined
    : errorCodeOf(o['error'], `${where}.error`);
  assertCoherent(where, status, error ?? null, complete);
  const base = {
    status,
    headers: o['headers'] === undefined
      ? {}
      : headersOf(o['headers'], `${where}.headers`, FRONTIER_RESPONSE_HEADERS),
    body: bytesOf(o['body'], `${where}.body`),
    encoding: encodingOf(o['encoding'], `${where}.encoding`),
    complete,
  };
  return error === undefined ? base : { ...base, error };
}

// --- the header filter ------------------------------------------------------------

const TRUNCATION_MARK_LENGTH = codePoints(HEADER_TRUNCATION_MARK);

/**
 * Lowercases names, keeps the direction's allowlist, and truncates values to
 * `HEADER_VALUE_LIMIT` code points with the mark included, so a provider can
 * never make `complete` throw through a header. The cut is by code point, never
 * a UTF-16 unit, so a truncated value is always well-formed Unicode and the
 * canonical writer never refuses it. On a case collision after lowercasing, the
 * last value wins.
 */
export function filterHeaders(
  headers: Readonly<Record<string, string>>, direction: 'request' | 'response',
): Record<string, string> {
  const allowed = direction === 'request' ? FRONTIER_REQUEST_HEADERS
    : direction === 'response' ? FRONTIER_RESPONSE_HEADERS
    : fail('filterHeaders', `unknown direction ${JSON.stringify(direction)}`);
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) continue;
    const points = Array.from(value);
    out[name] = points.length <= HEADER_VALUE_LIMIT
      ? value
      : points.slice(0, HEADER_VALUE_LIMIT - TRUNCATION_MARK_LENGTH).join('')
        + HEADER_TRUNCATION_MARK;
  }
  return out;
}
