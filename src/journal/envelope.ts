import { canonicalizeJson, sha256Hex, type JsonValue } from './canon.js';
import { JournalError } from './errors.js';

/**
 * The event envelope and its hash chain.
 *
 * Every event is `SHA-256(prev_hash || canon(payload))`, so the log is
 * append-only by construction: rewriting any event breaks every hash after it.
 * The field set is frozen at v0 and extended only by declaration merging into
 * `EventDataMap`, which is what makes the event union a compile-time contract
 * rather than a convention.
 */

/**
 * The envelope format version. It is frozen from the genesis event: a change to
 * the field set or the hashing formula means `v: 1` in a *new* file, never an
 * in-place mutation of an existing log — which is what lets a reader refuse a
 * mismatched `v` outright instead of guessing at a compatibility shim.
 */
export const FORMAT_VERSION = 0;

/** `prev_hash` of the first event of a node's chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Extended by declaration merging in later plans, e.g.
 * `declare module './envelope.js' { interface EventDataMap { 'node/boot': { … } } }`.
 */
export interface EventDataMap {}

export interface EventEnvelope<T extends JsonValue = JsonValue> {
  v: number;
  type: string;
  seq: number;
  time: number;
  prev_hash: string;
  hash: string;
  ignorable?: boolean;
  data: T;
}

/**
 * `data` for an event type: the registered shape when `EventDataMap` declares
 * it, `JsonValue` otherwise — so a registered type is checked, while a type not
 * yet registered stays usable at the runtime boundary.
 */
export type EventDataFor<T extends string> = T extends keyof EventDataMap
  ? EventDataMap[T]
  : JsonValue;

/** The discriminated union of every registered event, derived from `EventDataMap`. */
export type AnyEvent = {
  [K in keyof EventDataMap]: EventEnvelope<EventDataMap[K]> & { type: K };
}[keyof EventDataMap];

export function computeHash(e: Omit<EventEnvelope, 'hash'>): string {
  const payload: Record<string, JsonValue> = {
    v: e.v, type: e.type, seq: e.seq, time: e.time, data: e.data,
  };
  if (e.ignorable !== undefined) payload['ignorable'] = e.ignorable;
  return sha256Hex(e.prev_hash + canonicalizeJson(payload));
}

/**
 * Builds and hashes one event.
 *
 * `ignorable` is spread in only when the caller passed it: the frozen format
 * distinguishes *absent* (the type is required — a reader that does not know it
 * refuses to rebuild) from explicit `false`, so that convention is written once
 * here rather than repeated at every construction site.
 */
export function makeEvent<T extends string>(input: {
  type: T;
  data: EventDataFor<T>;
  seq: number;
  time: number;
  prevHash: string;
  ignorable?: boolean;
}): EventEnvelope<EventDataFor<T>> {
  const { type, data, seq, time, prevHash, ignorable } = input;
  const unsigned: Omit<EventEnvelope, 'hash'> = {
    v: FORMAT_VERSION, type, seq, time, prev_hash: prevHash, data: data as JsonValue,
    ...(ignorable !== undefined ? { ignorable } : {}),
  };
  return { ...unsigned, hash: computeHash(unsigned) } as EventEnvelope<EventDataFor<T>>;
}

export function verifyEvent(e: EventEnvelope): boolean {
  const { hash, ...unsigned } = e;
  return computeHash(unsigned) === hash;
}

/**
 * The canonical line for an event — exactly the bytes the log stores and the
 * hash was computed over. Capturing it once at append is what stops a later
 * mutation of the payload from desynchronizing the persisted bytes from the
 * chained hash.
 *
 * The envelope's shape is by construction JSON (scalars, hex strings and a
 * `JsonValue` payload), but its interface carries optional members no index
 * signature admits, so the conversion is named here rather than cast at the
 * call site.
 */
export function eventLine(e: EventEnvelope): string {
  return canonicalizeJson(e as unknown as JsonValue);
}

export class UnknownEventTypeError extends JournalError {
  constructor(public readonly eventType: string) {
    super(`unknown non-ignorable event type: ${eventType} — refusing to rebuild`);
  }
}

export function assertKnownType(
  type: string, ignorable: boolean, known: ReadonlySet<string>,
): void {
  if (!known.has(type) && !ignorable) throw new UnknownEventTypeError(type);
}
