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

/**
 * A loopback host may use plain `http:`; everything else must be `https:`, so a
 * misconfigured endpoint cannot send a Bearer credential in cleartext. Both the
 * provider transport and the web-tool credential store apply this one rule.
 * `URL.hostname` keeps IPv6 brackets, so `[::1]` is unwrapped first.
 */
export function isLoopback(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1) : hostname;
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127'
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
