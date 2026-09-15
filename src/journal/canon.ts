import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export class NonCanonicalizableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`value is not canonicalizable: ${reason}`, options);
    this.name = 'NonCanonicalizableError';
  }
}

/**
 * `canonicalize@5` silently drops members it cannot serialize (they would be
 * `undefined` after `JSON.stringify`) and raises a bare `Error` on non-finite
 * numbers. The journal must never accept a value whose canonical form is
 * lossy, so we reject those cases up front with a typed error, then map any
 * residual serialization failure (cycles, lone surrogates) onto the same type.
 */
function assertJsonValue(value: unknown, path: string, seen: Set<object>): void {
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) {
        throw new NonCanonicalizableError(`non-finite number at ${path}`);
      }
      return;
    case 'undefined':
      throw new NonCanonicalizableError(`undefined at ${path}`);
    case 'function':
      throw new NonCanonicalizableError(`function at ${path}`);
    case 'symbol':
      throw new NonCanonicalizableError(`symbol at ${path}`);
    case 'bigint':
      throw new NonCanonicalizableError(`bigint at ${path}`);
    case 'object':
      break;
    default:
      return;
  }
  if (value === null) return;
  // Only plain objects and arrays have a JSON form. A `Date`, `Map`, `Set`,
  // `RegExp` or class instance would be serialized to something else entirely
  // (an ISO string, `{}`), i.e. silently lossy — the module's one forbidden
  // outcome — so those are refused rather than coerced.
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new NonCanonicalizableError(`non-plain object (${constructorName(value)}) at ${path}`);
  }
  if (seen.has(value)) throw new NonCanonicalizableError(`circular reference at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertJsonValue(value[i], `${path}[${i}]`, seen);
    }
  } else {
    for (const [k, v] of Object.entries(value)) {
      assertJsonValue(v, `${path}.${k}`, seen);
    }
  }
  seen.delete(value);
}

function constructorName(value: object): string {
  return value.constructor?.name ?? 'unknown';
}

export function canonicalizeJson(value: JsonValue): string {
  assertJsonValue(value, '$', new Set());
  let result: string | undefined;
  try {
    result = canonicalize(value);
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