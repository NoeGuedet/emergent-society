import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { JournalError } from './errors.js';

/**
 * Canonical bytes and hashes: the journal's one serialization.
 *
 * RFC 8785 (JCS) is frozen before the first event, so the string this module
 * produces for a value *is* its identity in the log — the hash chain is computed
 * over it, and a value whose canonical form would be lossy is refused rather
 * than serialized to something the caller did not intend.
 */

/** The shape of every hash in the journal: lowercase hex SHA-256. */
export const HASH_RE = /^[0-9a-f]{64}$/;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export class NonCanonicalizableError extends JournalError {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`value is not canonicalizable: ${reason}`, options);
  }
}

/**
 * `canonicalize@5` silently drops members it cannot serialize (they would be
 * `undefined` after `JSON.stringify`), raises a bare `Error` on non-finite
 * numbers, and calls any `toJSON` it finds; `JSON.stringify` likewise consults
 * getters. The journal must never accept a value whose canonical form would be
 * lossy or would run caller code, so those cases are refused up front with a
 * typed error and `canonicalizeJson` only ever serializes a plain copy.
 */

/** A canonical array index is `0` or a decimal integer in `[1, 2^32 - 1)`. */
const MAX_ARRAY_INDEX = 4294967295;

const hasOwn = Object.prototype.hasOwnProperty;

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isArrayIndex(key: string): boolean {
  if (key === '0') return true;
  if (key.length === 0 || key.charCodeAt(0) < 0x31 || key.charCodeAt(0) > 0x39) return false;
  for (let i = 1; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x30 || code > 0x39) return false;
  }
  return Number(key) < MAX_ARRAY_INDEX;
}

/**
 * The class name behind a refused value, read from a prototype descriptor
 * rather than `value.constructor`: a caller getter named `constructor` must not
 * run just to build an error message.
 */
function safeClassName(value: object): string {
  let proto: object | null = Object.getPrototypeOf(value) as object | null;
  while (proto !== null) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'constructor');
    if (desc !== undefined && 'value' in desc && typeof desc.value === 'function') {
      const name = (desc.value as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0) return name;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return 'unknown';
}

/**
 * Refuses any callable or accessor `toJSON` on the value or its prototype chain
 * without invoking it. Both `canonicalize@5` and `JSON.stringify` consult
 * `toJSON`, so a hook would let caller code replace the value's JSON form; a
 * hook inherited from `Object.prototype`/`Array.prototype` counts too.
 */
function assertNoConversionHook(value: object, path: string): void {
  const own = Object.getOwnPropertyDescriptor(value, 'toJSON');
  if (own !== undefined && ('get' in own || 'set' in own || typeof own.value === 'function')) {
    throw new NonCanonicalizableError(`toJSON conversion at ${path}`);
  }
  let proto: object | null = Object.getPrototypeOf(value) as object | null;
  while (proto !== null) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'toJSON');
    if (desc !== undefined && ('get' in desc || 'set' in desc || typeof desc.value === 'function')) {
      throw new NonCanonicalizableError(`inherited toJSON conversion at ${path}`);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
}

function assertNoEnumerableSymbols(value: object, path: string): void {
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true) {
      throw new NonCanonicalizableError(`symbol member at ${path}`);
    }
  }
}

/**
 * Defines an own enumerable data property. Assignment would route a key named
 * `__proto__` (which `JSON.parse` creates as an ordinary own property) through
 * `Object.prototype`'s setter and mutate the copy's prototype instead.
 */
function defineDataProperty(target: object, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * A validated, stable, collision-free deep copy of a JSON value: only own
 * enumerable data properties of plain objects and full arrays are read, no
 * accessor or `toJSON` hook is ever evaluated, and anything a JSON round trip
 * would lose (non-finite numbers, holes, extra array members, symbols, lone
 * surrogates) is refused. Shared non-cyclic subobjects are duplicated.
 *
 * Each container is checked against its *output* prototype chain as well as its
 * source's. The output is always `Object.prototype`- or `Array.prototype`-rooted
 * even when the source is null-prototype, so without that second check a
 * null-prototype source could yield a copy that inherits a polluted
 * `Object.prototype.toJSON` and gets converted during serialization.
 *
 * This is a data-only copy at a trusted boundary, not a non-bypassable one: an
 * exotic object (a `Proxy`) that misreports its descriptors is out of scope.
 */
export function copyJsonValue(value: unknown): JsonValue {
  return copy(value, '$', new Set());
}

function copy(value: unknown, path: string, seen: Set<object>): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean': return value;
    case 'string':
      if (hasLoneSurrogate(value)) {
        throw new NonCanonicalizableError(`lone surrogate in string at ${path}`);
      }
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new NonCanonicalizableError(`non-finite number at ${path}`);
      return value;
    case 'object': return copyContainer(value, path, seen);
    case 'undefined': throw new NonCanonicalizableError(`undefined at ${path}`);
    case 'function': throw new NonCanonicalizableError(`function at ${path}`);
    case 'symbol': throw new NonCanonicalizableError(`symbol at ${path}`);
    case 'bigint': throw new NonCanonicalizableError(`bigint at ${path}`);
    default: throw new NonCanonicalizableError(`${typeof value} at ${path}`);
  }
}

function copyContainer(value: object, path: string, seen: Set<object>): JsonValue {
  if (seen.has(value)) throw new NonCanonicalizableError(`circular reference at ${path}`);
  seen.add(value);
  try {
    return Array.isArray(value) ? copyArray(value, path, seen) : copyObject(value, path, seen);
  } finally {
    seen.delete(value);
  }
}

function copyObject(value: object, path: string, seen: Set<object>): JsonValue {
  // Only plain objects and arrays have a JSON form. A `Date`, `Map`, `Set`,
  // `RegExp` or class instance would serialize to something else entirely
  // (an ISO string, `{}`), i.e. silently lossy — the one forbidden outcome.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new NonCanonicalizableError(`non-plain object (${safeClassName(value)}) at ${path}`);
  }
  assertNoConversionHook(value, path);
  assertNoEnumerableSymbols(value, path);
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    if (hasLoneSurrogate(key)) throw new NonCanonicalizableError(`lone surrogate in key at ${path}`);
    const desc = Object.getOwnPropertyDescriptor(value, key)!;
    if (desc.get !== undefined || desc.set !== undefined) {
      throw new NonCanonicalizableError(`accessor property at ${path}.${key}`);
    }
    defineDataProperty(out, key, copy(desc.value, `${path}.${key}`, seen));
  }
  // The output prototype chain, not the source's, is what `canonicalize` will
  // consult for `toJSON`; a null-prototype source has no chain to walk, so the
  // copy is re-checked here before it can inherit a polluted hook.
  assertNoConversionHook(out, path);
  return out;
}

function copyArray(value: unknown[], path: string, seen: Set<object>): JsonValue {
  assertNoConversionHook(value, path);
  assertNoEnumerableSymbols(value, path);
  const length = value.length;
  const out = new Array<JsonValue>(length);
  for (let i = 0; i < length; i++) {
    if (!hasOwn.call(value, i)) {
      throw new NonCanonicalizableError(`sparse array hole at ${path}[${i}]`);
    }
    const desc = Object.getOwnPropertyDescriptor(value, i)!;
    if (desc.get !== undefined || desc.set !== undefined) {
      throw new NonCanonicalizableError(`accessor property at ${path}[${i}]`);
    }
    defineDataProperty(out, String(i), copy(desc.value, `${path}[${i}]`, seen));
  }
  // Any other own enumerable string key on an array would be dropped by a JSON
  // round trip, so it is refused rather than silently lost.
  for (const key of Object.keys(value)) {
    if (isArrayIndex(key) && Number(key) < length) continue;
    throw new NonCanonicalizableError(`array has extra own property at ${path}.${key}`);
  }
  // A source array may have a custom prototype chain; the output is always
  // `Array.prototype`-rooted, so the copy is re-checked before serialization.
  assertNoConversionHook(out, path);
  return out;
}

export function canonicalizeJson(value: JsonValue): string {
  const stable = copyJsonValue(value);
  let result: string | undefined;
  try {
    result = canonicalize(stable);
  } catch (err) {
    throw new NonCanonicalizableError(
      err instanceof Error ? err.message : 'serialization failed',
      { cause: err },
    );
  }
  // Unreachable for a plain object/array root, but the library's type allows
  // `undefined` and the journal must never hash the string "undefined".
  if (result === undefined) throw new NonCanonicalizableError('top-level value has no JSON form');
  return result;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Lowercase hex SHA-256 of raw bytes — the digest of a stored blob. */
export function sha256HexOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}