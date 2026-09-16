import { describe, expect, it } from 'vitest';
import { WakeLatch } from '../latch.js';

const PARKED = 'parked';
const WOKEN = 'woken';

/** Yields to the event loop once, so a resolution the microtask queue carries is observed. */
const yieldOnce = (): Promise<void> => new Promise((r) => { setImmediate(r); });

/**
 * Resolves WOKEN if `p` settles before the yield, PARKED otherwise. The yield
 * cannot itself resolve `p` in the parked cases, so the discrimination is
 * identical to a timeout, without a wall-clock delay.
 */
async function raceYield(p: Promise<void>): Promise<string> {
  return Promise.race([
    p.then(() => WOKEN),
    yieldOnce().then(() => PARKED),
  ]);
}

describe('WakeLatch', () => {
  it('parks a consumer until a request arrives', async () => {
    const latch = new WakeLatch();
    const waiting = latch.wait();
    expect(await raceYield(waiting)).toBe(PARKED); // still parked after an event-loop turn
    latch.request();
    await waiting; // resolves
  });

  it('consumes an already-armed request without parking', async () => {
    const latch = new WakeLatch();
    latch.request();
    expect(await raceYield(latch.wait())).toBe(WOKEN);
  });

  it('coalesces: only the first request reports itself', () => {
    const latch = new WakeLatch();
    expect(latch.request()).toBe(true);
    expect(latch.request()).toBe(false);
  });

  it('re-arms after a consume cycle', async () => {
    const latch = new WakeLatch();
    latch.request();
    await latch.wait(); // consumes the request
    // The consumed request must not leave the latch stuck reporting false:
    // the next request is again the one that arms it.
    expect(latch.request()).toBe(true);
    await latch.wait();
  });

  it('clear() drops an unconsumed request', async () => {
    const latch = new WakeLatch();
    latch.request();
    latch.clear();
    expect(await raceYield(latch.wait())).toBe(PARKED);
  });
});
