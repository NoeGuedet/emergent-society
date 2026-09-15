import { canonicalizeJson, sha256Hex, type JsonValue } from './canon.js';

/**
 * The event envelope and its hash chain.
 *
 * Every event is `SHA-256(prev_hash || canon(payload))`, so the log is
 * append-only by construction: rewriting any event breaks every hash after it.
 * The field set is frozen at v0 and extended only by declaration merging into
 * `EventDataMap`, which is what makes the event union a compile-time contract
 * rather than a convention.
 */
export const FORMAT_VERSION = 0;
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Extended by declaration merging in later plans, e.g.
 * `declare module './envelope.js' { interface EventDataMap { 'node/boot': { … } } }`.
 */
export interface EventDataMap {}

/** The registered event types, or `string` while none is registered yet. */
export type EventType = keyof EventDataMap extends never ? string : keyof EventDataMap;

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

export function makeEvent<T extends string>(input: {
  type: T;
  data: EventDataFor<T>;
  seq: number;
  time: number;
  prevHash: string;
  ignorable?: boolean;
}): EventEnvelope<EventDataFor<T>> {
  const unsigned: Omit<EventEnvelope, 'hash'> = {
    v: FORMAT_VERSION, type: input.type, seq: input.seq, time: input.time,
    prev_hash: input.prevHash, data: input.data as JsonValue,
    ...(input.ignorable !== undefined ? { ignorable: input.ignorable } : {}),
  };
  return { ...unsigned, hash: computeHash(unsigned) } as EventEnvelope<EventDataFor<T>>;
}

export function verifyEvent(e: EventEnvelope): boolean {
  const { hash, ...unsigned } = e;
  return computeHash(unsigned) === hash;
}

/**
 * The frozen envelope viewed as a JSON value, for canonicalization. The
 * envelope's own shape is by construction JSON (scalars, hex strings and a
 * `JsonValue` payload), but its TypeScript interface carries optional members
 * that no index signature admits, so the conversion is named here once rather
 * than cast at every call site.
 */
export function envelopeJson(e: EventEnvelope): JsonValue {
  return e as unknown as JsonValue;
}

export class UnknownEventTypeError extends Error {
  constructor(public readonly eventType: string) {
    super(`unknown non-ignorable event type: ${eventType} — refusing to rebuild`);
    this.name = 'UnknownEventTypeError';
  }
}

export function assertKnownType(
  type: string, ignorable: boolean, known: ReadonlySet<string>,
): void {
  if (!known.has(type) && !ignorable) throw new UnknownEventTypeError(type);
}
