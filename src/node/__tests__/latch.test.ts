import { describe, expect, it } from 'vitest';
import { WakeLatch } from '../latch.js';

const PARKED = 'parked';
const WOKEN = 'woken';

async function raceTimeout(p: Promise<void>): Promise<string> {
  return Promise.race([
    p.then(() => WOKEN),
    new Promise<string>((r) => setTimeout(() => r(PARKED), 25)),
  ]);
}

describe('WakeLatch', () => {
  it('parks a consumer until a request arrives', async () => {
    const latch = new WakeLatch();
    const waiting = latch.wait();
    expect(await raceTimeout(waiting)).toBe(PARKED); // still parked after 25 ms
    latch.request();
    await waiting; // resolves
  });

  it('consumes an already-armed request without parking', async () => {
    const latch = new WakeLatch();
    latch.request();
    expect(await raceTimeout(latch.wait())).toBe(WOKEN);
  });

  it('coalesces: only the first request reports itself', () => {
    const latch = new WakeLatch();
    expect(latch.request()).toBe(true);
    expect(latch.request()).toBe(false);
  });

  it('clear() drops an unconsumed request', async () => {
    const latch = new WakeLatch();
    latch.request();
    latch.clear();
    expect(await raceTimeout(latch.wait())).toBe(PARKED);
  });
});
