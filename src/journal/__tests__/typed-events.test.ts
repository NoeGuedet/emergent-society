import { describe, it, expect, expectTypeOf } from 'vitest';

// Declaration merging is how later plans register their event types. This is the
// proof that the registration actually constrains the compiler: the payload
// shapes below are enforced, not merely documented.
declare module '../envelope.js' {
  interface EventDataMap {
    'test/typed': { n: number };
    'test/text': { text: string };
  }
}

import { makeEvent, GENESIS_HASH, type AnyEvent } from '../envelope.js';
import { JournalWriter } from '../writer.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('EventDataMap declaration merging', () => {
  it('accepts a payload that matches its registered type', () => {
    const e = makeEvent({ type: 'test/typed', data: { n: 1 }, seq: 0, time: 1, prevHash: GENESIS_HASH });
    expectTypeOf(e.data).toEqualTypeOf<{ n: number }>();
    expect(e.data.n).toBe(1);
  });

  it('rejects a payload that does not match its registered type', () => {
    // @ts-expect-error `n` must be a number for `test/typed`
    makeEvent({ type: 'test/typed', data: { n: 'wrong' }, seq: 0, time: 1, prevHash: GENESIS_HASH });
    // @ts-expect-error `text` is required for `test/text`
    makeEvent({ type: 'test/text', data: {}, seq: 0, time: 1, prevHash: GENESIS_HASH });
    expect(true).toBe(true);
  });

  it('narrows the appended payload type at the writer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cell-typed-'));
    try {
      const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
      const e = w.append('test/typed', { n: 1 });
      expect(e.data.n).toBe(1);
      // @ts-expect-error a string is not assignable to `test/typed`'s `n: number`
      w.append('test/typed', { n: 'wrong' });
      await w.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('derives a real discriminated union from EventDataMap', () => {
    const e = makeEvent({ type: 'test/typed', data: { n: 1 }, seq: 0, time: 1, prevHash: GENESIS_HASH });
    const union: AnyEvent = e as AnyEvent;
    // Narrowing on `type` narrows `data` — the union is not inert.
    if (union.type === 'test/typed') {
      expectTypeOf(union.data).toEqualTypeOf<{ n: number }>();
      expect(union.data.n).toBe(1);
    }
    expect(true).toBe(true);
  });

  it('still allows an unregistered type at the runtime boundary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cell-typed-'));
    try {
      const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
      const e = w.append('not/registered', { anything: true });
      expect(e.data).toEqual({ anything: true });
      await w.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
