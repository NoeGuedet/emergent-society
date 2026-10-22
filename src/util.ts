/**
 * The neutral shared primitives every layer parses and waits with.
 *
 * The context validators, the provider adapters and the tool dispatchers all need
 * the same non-throwing "plain JSON object" test, and the layers above need one
 * sleep primitive, one no-op callback and one wall-clock read instead of a local
 * copy per module. Keeping them below every layer avoids a provider → context
 * import (which would invert the layering) while still leaving exactly one
 * definition.
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

/** A timer promise: the one sleep primitive (terminal kill grace, commit retry). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** A no-op callback: a `.then` sink that swallows either branch by design. */
export const NOOP = (): void => {};

/**
 * The default wall clock, in epoch milliseconds: the kernel's shared `now`, and
 * the default for modules that take an injectable clock. It is not the only time
 * read — code without an injected clock (the terminal runtime, the journal lock
 * guard) calls `Date.now()` itself.
 */
export function systemClock(): number {
  return Date.now();
}
