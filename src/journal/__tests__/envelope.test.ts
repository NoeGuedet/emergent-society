import { describe, it, expect } from 'vitest';
import {
  GENESIS_HASH, makeEvent, verifyEvent, assertKnownType, UnknownEventTypeError,
} from '../envelope.js';

const base = { type: 'test/ping', data: { ok: true }, seq: 0, time: 1789000000000 };

describe('makeEvent / verifyEvent', () => {
  it('chains from the genesis hash', () => {
    const e = makeEvent({ ...base, prevHash: GENESIS_HASH });
    expect(e.v).toBe(0);
    expect(e.prev_hash).toBe(GENESIS_HASH);
    expect(verifyEvent(e)).toBe(true);
  });
  it('chains event n to event n-1', () => {
    const e0 = makeEvent({ ...base, prevHash: GENESIS_HASH });
    const e1 = makeEvent({ ...base, seq: 1, prevHash: e0.hash });
    expect(e1.prev_hash).toBe(e0.hash);
    expect(verifyEvent(e1)).toBe(true);
  });
  it('detects tampering with data', () => {
    const e = makeEvent({ ...base, prevHash: GENESIS_HASH });
    expect(verifyEvent({ ...e, data: { ok: false } })).toBe(false);
  });
  it('detects tampering with seq', () => {
    const e = makeEvent({ ...base, prevHash: GENESIS_HASH });
    expect(verifyEvent({ ...e, seq: 7 })).toBe(false);
  });
  it('is stable regardless of key insertion order', () => {
    const a = makeEvent({ ...base, data: { x: 1, y: 2 }, prevHash: GENESIS_HASH });
    const b = makeEvent({ ...base, data: { y: 2, x: 1 }, prevHash: GENESIS_HASH });
    expect(a.hash).toBe(b.hash);
  });
  it('omits ignorable from the payload when absent', () => {
    const absent = makeEvent({ ...base, prevHash: GENESIS_HASH });
    const explicitFalse = makeEvent({ ...base, prevHash: GENESIS_HASH, ignorable: false });
    expect(absent.hash).not.toBe(explicitFalse.hash);
    expect(verifyEvent(explicitFalse)).toBe(true);
  });
});

describe('assertKnownType', () => {
  const known = new Set(['test/ping']);
  it('accepts a known type', () => {
    expect(() => assertKnownType('test/ping', false, known)).not.toThrow();
  });
  it('refuses an unknown non-ignorable type', () => {
    expect(() => assertKnownType('future/thing', false, known)).toThrow(UnknownEventTypeError);
  });
  it('accepts an unknown ignorable type', () => {
    expect(() => assertKnownType('future/thing', true, known)).not.toThrow();
  });
});