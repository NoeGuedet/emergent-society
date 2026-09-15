import { describe, it, expect } from 'vitest';
import { canonicalizeJson, sha256Hex, NonCanonicalizableError } from '../canon.js';

describe('canonicalizeJson (RFC 8785)', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalizeJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('uses shortest round-trip number form', () => {
    expect(canonicalizeJson({ n: 1e21 })).toBe('{"n":1e+21}');
  });
  it('rejects undefined', () => {
    expect(() => canonicalizeJson({ a: undefined } as never)).toThrow(NonCanonicalizableError);
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalizeJson(NaN)).toThrow(NonCanonicalizableError);
  });
  it('rejects bigint, functions and symbols', () => {
    expect(() => canonicalizeJson({ a: 1n } as never)).toThrow(NonCanonicalizableError);
    expect(() => canonicalizeJson({ a: () => 1 } as never)).toThrow(NonCanonicalizableError);
    expect(() => canonicalizeJson({ a: Symbol('s') } as never)).toThrow(NonCanonicalizableError);
  });
  it('rejects a circular structure', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => canonicalizeJson(cyc as never)).toThrow(NonCanonicalizableError);
  });
  it('rejects a lone surrogate', () => {
    expect(() => canonicalizeJson({ s: '\uD800' })).toThrow(NonCanonicalizableError);
  });
});

describe('sha256Hex', () => {
  it('matches the known empty-string digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});