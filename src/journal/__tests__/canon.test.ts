import { describe, it, expect } from 'vitest';
import { canonicalizeJson, copyJsonValue, sha256Hex, NonCanonicalizableError } from '../canon.js';

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
  it('rejects non-plain objects that would canonicalize lossily', () => {
    for (const value of [
      new Date(0), new Map([['a', 1]]), new Set([1]), /re/,
      new (class Widget { x = 1; })(),
    ]) {
      expect(() => canonicalizeJson({ v: value } as never)).toThrow(NonCanonicalizableError);
    }
  });
  it('accepts a null-prototype object, whose keys are plain', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['a'] = 1;
    expect(canonicalizeJson(bare as never)).toBe('{"a":1}');
  });
  it('names the location of a refused value', () => {
    expect(() => canonicalizeJson({ s: '\uD800' })).toThrow(/\$\.s/);
  });
});

describe('lossless JSON fidelity', () => {
  it('preserves an own __proto__ key through canonicalization', () => {
    expect(canonicalizeJson(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe('{"__proto__":{"x":1},"a":2}');
    expect(canonicalizeJson(JSON.parse('{"__proto__":1}'))).toBe('{"__proto__":1}');
  });

  it('refuses an own enumerable accessor without evaluating it', () => {
    let calls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'a', {
      enumerable: true, configurable: true,
      get() { calls += 1; return 1; },
    });
    expect(() => canonicalizeJson(input as never)).toThrow(NonCanonicalizableError);
    expect(calls).toBe(0);
  });

  it('refuses an accessor named toJSON without evaluating it', () => {
    let calls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'toJSON', {
      enumerable: false, configurable: true,
      get() { calls += 1; return () => 'x'; },
    });
    expect(() => canonicalizeJson(input as never)).toThrow(NonCanonicalizableError);
    expect(calls).toBe(0);
  });

  it('refuses a non-enumerable callable toJSON without invoking it', () => {
    let calls = 0;
    const input: Record<string, unknown> = { a: 1 };
    Object.defineProperty(input, 'toJSON', {
      enumerable: false, configurable: true,
      value: () => { calls += 1; return 'x'; },
    });
    expect(() => canonicalizeJson(input as never)).toThrow(NonCanonicalizableError);
    expect(calls).toBe(0);
  });

  it('refuses a callable toJSON on an array without invoking it', () => {
    let calls = 0;
    const input: unknown[] = [1, 2];
    (input as unknown as Record<string, unknown>)['toJSON'] = () => { calls += 1; return 'x'; };
    expect(() => canonicalizeJson(input as never)).toThrow(NonCanonicalizableError);
    expect(calls).toBe(0);
  });

  it('refuses an inherited Object.prototype conversion hook without invoking it', () => {
    let calls = 0;
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true, writable: true,
      value: () => { calls += 1; return {}; },
    });
    try {
      expect(() => canonicalizeJson({ a: 1 })).toThrow(NonCanonicalizableError);
    } finally {
      delete (Object.prototype as Record<string, unknown>)['toJSON'];
    }
    expect(calls).toBe(0);
  });

  it('refuses an inherited Array.prototype conversion hook without invoking it', () => {
    let calls = 0;
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true, writable: true,
      value: () => { calls += 1; return []; },
    });
    try {
      expect(() => canonicalizeJson([1] as never)).toThrow(NonCanonicalizableError);
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)['toJSON'];
    }
    expect(calls).toBe(0);
  });

  it('refuses a lone surrogate in a key as consistently as in a value', () => {
    expect(() => canonicalizeJson(JSON.parse('{"\\uD800":1}') as never)).toThrow(NonCanonicalizableError);
    expect(() => canonicalizeJson({ s: '\uD800' })).toThrow(NonCanonicalizableError);
  });

  it('preserves a valid astral pair exactly', () => {
    expect(canonicalizeJson({ s: 'a\u{1F600}b' })).toBe('{"s":"a\u{1F600}b"}');
  });

  it('rejects a sparse array, an extra own array property and a symbol member', () => {
    const sparse: unknown[] = new Array(3);
    sparse[0] = 1;
    sparse[2] = 3;
    expect(() => canonicalizeJson(sparse as never)).toThrow(NonCanonicalizableError);
    const extra: unknown[] = [1];
    (extra as unknown as Record<string, unknown>)['foo'] = 2;
    expect(() => canonicalizeJson(extra as never)).toThrow(NonCanonicalizableError);
    const sym = Symbol('s');
    const withSymbol: Record<string, unknown> = { a: 1 };
    (withSymbol as unknown as Record<symbol, unknown>)[sym] = 2;
    expect(() => canonicalizeJson(withSymbol as never)).toThrow(NonCanonicalizableError);
  });

  it('accepts a shared non-cyclic subobject and rejects a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalizeJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalizeJson(cyclic as never)).toThrow(NonCanonicalizableError);
  });

  it('keeps exact canonical bytes and SHA-256 of a known fixture', () => {
    const canonical = canonicalizeJson({ b: 1, a: { d: 2, c: 3 } });
    expect(canonical).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(sha256Hex(canonical)).toBe('78d48859c3252943aab7306f76c80f3f07783582e05ab8f944ce0696f2dbfc67');
  });
});

describe('sha256Hex', () => {
  it('matches the known empty-string digest', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('copyJsonValue', () => {
  it('stores an own __proto__ key as data rather than changing the prototype', () => {
    const copy = copyJsonValue(JSON.parse('{"__proto__":{"x":1},"a":2}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    const desc = Object.getOwnPropertyDescriptor(copy, '__proto__');
    expect(desc?.enumerable).toBe(true);
    expect(desc?.value).toEqual({ x: 1 });
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('does not alias the input and duplicates a shared subobject', () => {
    const shared = { x: 1 };
    const copy = copyJsonValue({ a: shared, b: shared }) as { a: { x: number } };
    expect(copy).toEqual({ a: { x: 1 }, b: { x: 1 } });
    expect(copy.a).not.toBe(shared);
    shared.x = 99;
    expect(copy.a.x).toBe(1);
  });

  it('keeps __proto__ as a plain own key for a null-prototype input', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['__proto__'] = 'plain';
    const copy = copyJsonValue(bare) as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(copy, '__proto__')?.value).toBe('plain');
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  });

  it('refuses a setter-only accessor without evaluating it', () => {
    let calls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'a', {
      enumerable: true, configurable: true,
      set() { calls += 1; },
    });
    expect(() => copyJsonValue(input)).toThrow(NonCanonicalizableError);
    expect(calls).toBe(0);
  });

  it('does not invoke a constructor getter while reporting a non-plain object', () => {
    let calls = 0;
    const proto: Record<string, unknown> = {};
    Object.defineProperty(proto, 'constructor', {
      configurable: true,
      get() { calls += 1; return function Nope() { /* never called */ }; },
    });
    const value = Object.create(proto) as Record<string, unknown>;
    value['a'] = 1;
    expect(() => copyJsonValue(value)).toThrow(NonCanonicalizableError);
    expect(calls).toBe(0);
  });

  it('refuses a null-prototype input when its copy would inherit a polluted Object.prototype.toJSON', () => {
    let calls = 0;
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true, writable: true,
      value() { calls += 1; return 1; },
    });
    try {
      const bare = Object.create(null) as Record<string, unknown>;
      bare['a'] = 1;
      expect(() => copyJsonValue(bare)).toThrow(NonCanonicalizableError);
      expect(() => canonicalizeJson(bare as never)).toThrow(NonCanonicalizableError);
    } finally {
      delete (Object.prototype as Record<string, unknown>)['toJSON'];
    }
    expect(calls).toBe(0);
  });

  it('classifies array index keys at their boundaries', () => {
    const leadingZero: unknown[] = [1];
    Object.defineProperty(leadingZero, '01', {
      value: 2, enumerable: true, writable: true, configurable: true,
    });
    expect(() => copyJsonValue(leadingZero)).toThrow(NonCanonicalizableError);

    const beyondIndex: unknown[] = [1];
    Object.defineProperty(beyondIndex, '4294967295', {
      value: 2, enumerable: true, writable: true, configurable: true,
    });
    expect(() => copyJsonValue(beyondIndex)).toThrow(NonCanonicalizableError);

    expect(copyJsonValue([1, 2])).toEqual([1, 2]);
  });
});