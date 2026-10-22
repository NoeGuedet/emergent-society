import { describe, expect, it } from 'vitest';
import { delay, NOOP, systemClock } from '../util.js';

describe('micro utilities', () => {
  it('delay resolves after roughly the requested time', async () => {
    const before = Date.now();
    await delay(20);
    expect(Date.now() - before).toBeGreaterThanOrEqual(15);
  });
  it('NOOP is a callable no-op', () => {
    expect(NOOP()).toBeUndefined();
  });
  it('systemClock returns the current epoch milliseconds', () => {
    expect(Math.abs(systemClock() - Date.now())).toBeLessThan(50);
  });
});
