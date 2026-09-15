import { canonicalizeJson, sha256Hex, type JsonValue } from './canon.js';

export const FORMAT_VERSION = 0;
export const GENESIS_HASH = '0'.repeat(64);

/** Extended by declaration merging in later plans. */
export interface EventDataMap {}
export type EventType = keyof EventDataMap | (string & {});

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

export function computeHash(e: Omit<EventEnvelope, 'hash'>): string {
  const payload: Record<string, JsonValue> = {
    v: e.v, type: e.type, seq: e.seq, time: e.time, data: e.data,
  };
  if (e.ignorable !== undefined) payload['ignorable'] = e.ignorable;
  return sha256Hex(e.prev_hash + canonicalizeJson(payload as JsonValue));
}

export function makeEvent(input: {
  type: string; data: JsonValue; seq: number; time: number; prevHash: string; ignorable?: boolean;
}): EventEnvelope {
  const unsigned: Omit<EventEnvelope, 'hash'> = {
    v: FORMAT_VERSION, type: input.type, seq: input.seq, time: input.time,
    prev_hash: input.prevHash, data: input.data,
    ...(input.ignorable !== undefined ? { ignorable: input.ignorable } : {}),
  };
  return { ...unsigned, hash: computeHash(unsigned) };
}

export function verifyEvent(e: EventEnvelope): boolean {
  const { hash, ...unsigned } = e;
  return computeHash(unsigned) === hash;
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