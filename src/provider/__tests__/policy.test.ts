import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { systemProviderPolicy } from '../policy.js';

/**
 * Production timing policy tests: the delay is cancellable and never resolves
 * early, a pre-aborted signal rejects without arming a timer, an abort rejects
 * and clears the timer, and `schedule` fires once with a working clear.
 *
 * The abort-listener removal on both paths (resolve and abort) is a §4 contract
 * note rather than a test here: Node's `AbortSignal` exposes no listener count,
 * and spying on the prototype would be a global mutation.
 */

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('delay does not resolve before the requested time', async () => {
  let done = false;
  const p = systemProviderPolicy.delay(250, new AbortController().signal);
  void p.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(249);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await p;
  expect(done).toBe(true);
});

it('delay rejects on a pre-aborted signal', async () => {
  const c = new AbortController();
  c.abort();
  await expect(systemProviderPolicy.delay(10, c.signal)).rejects.toThrow('cancelled');
});

it('delay rejects and clears its timer on abort', async () => {
  const c = new AbortController();
  const p = systemProviderPolicy.delay(1000, c.signal);
  c.abort();
  await expect(p).rejects.toThrow('cancelled');
  expect(vi.getTimerCount()).toBe(0);
});

it('schedule fires once and its clear prevents the callback', async () => {
  let fired = 0;
  systemProviderPolicy.schedule(50, () => { fired += 1; });
  await vi.advanceTimersByTimeAsync(50); expect(fired).toBe(1);
  const clear = systemProviderPolicy.schedule(50, () => { fired += 1; });
  clear(); await vi.advanceTimersByTimeAsync(50); expect(fired).toBe(1);
});
