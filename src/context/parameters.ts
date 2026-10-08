import type { JsonValue } from '../journal/index.js';
import { toJson } from './artifacts.js';

/**
 * The one model-parameter contract shared by configuration validation and wire
 * serialization (kernel.md §4).
 *
 * This module is the single source of the permitted provider dialect —
 * `temperature`, `top_p`, `max_tokens` and `stop` — and of each key's bound.
 * `validateAgentConfig` and `serializeWire` both call it, so a configuration
 * that is accepted can always be serialized and no consumer can disagree about
 * what is sendable. Every other key, in particular any
 * `model`/`messages`/`tools`/`stream`/`n`/HTTP/auth/header/endpoint override, is
 * refused; the whitelist is never widened per provider dialect.
 *
 * The copy is validated and deeply frozen by the shared `toJson` helper, so the
 * returned parameters are canonical JSON that a caller cannot mutate.
 */

export type ProviderParameters = { readonly [key: string]: JsonValue };

/** A typed parameter refusal; `key` names the offending key, or null for a non-object root. */
export class ParameterError extends Error {
  constructor(readonly key: string | null, message: string) {
    super(message);
    this.name = 'ParameterError';
  }
}

function refuse(key: string | null, message: string): never {
  throw new ParameterError(key, message);
}

function finiteRange(value: JsonValue, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    refuse(key, `${key}: expected a finite number in [${min}, ${max}]`);
  }
  return value;
}

function positiveSafeInt(value: JsonValue, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    refuse(key, `${key}: expected a positive safe integer`);
  }
  return value;
}

function stopValue(value: JsonValue, key: string): JsonValue {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length >= 1 && value.length <= 4
    && value.every((item): item is string => typeof item === 'string')) {
    return value;
  }
  return refuse(key, `${key}: expected a string or one to four strings`);
}

/**
 * Validates untrusted model parameters against the shared whitelist and bounds,
 * returning a frozen JSON copy. A non-object root, an unsupported key or a
 * value outside its bound is refused; nothing is dropped silently.
 */
export function validateProviderParameters(value: unknown): ProviderParameters {
  let copied: JsonValue;
  try {
    copied = toJson(value);
  } catch (err) {
    return refuse(null, `expected a JSON object: ${err instanceof Error ? err.message : 'not JSON'}`);
  }
  if (typeof copied !== 'object' || copied === null || Array.isArray(copied)) {
    return refuse(null, 'expected an object');
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(copied as Record<string, JsonValue>)) {
    switch (key) {
      case 'temperature': out[key] = finiteRange(entry, key, 0, 2); break;
      case 'top_p': out[key] = finiteRange(entry, key, 0, 1); break;
      case 'max_tokens': out[key] = positiveSafeInt(entry, key); break;
      case 'stop': out[key] = stopValue(entry, key); break;
      default: return refuse(key, `unsupported parameter ${JSON.stringify(key)}`);
    }
  }
  return toJson(out) as ProviderParameters;
}
