/**
 * The neutral shared predicates every layer parses with.
 *
 * The context validators, the provider adapters and the tool dispatchers all need
 * the same non-throwing "plain JSON object" test. Keeping it below all of them
 * avoids a provider → context import (which would invert the layering) while
 * still leaving exactly one definition.
 */

/** True for a non-null, non-array object — the shape every JSON parser narrows to. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
