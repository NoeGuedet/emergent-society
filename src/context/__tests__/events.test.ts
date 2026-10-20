import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../journal/index.js';
import { createBoundaryGate } from '../../node/gate.js';
import type { GateScope } from '../../node/gate.js';
import { createBoundaryRegistry } from '../events.js';

/**
 * The boundary registry is the gate's only payload classifier: every registered
 * type must refuse a malformed payload rather than hand a bare cast to the fold.
 * The coverage assertion is driven from the registry's own keys, so a new type
 * without a negative case fails this suite instead of shipping untested.
 */

const registry = createBoundaryRegistry();

const scope: GateScope = {
  phase: 'turn', turn: 0, signal: new AbortController().signal, lookup: () => null,
};

const MALFORMED: Record<string, JsonValue> = {
  'artifact/chunk': { artifact: null, index: 0, base64: '' },
  'artifact/end': {
    artifact: null, sha256: 'a'.repeat(64), bytes: 0, encoding: 'utf8',
    complete: true, parts: [],
  },
  'system/message': { version: 0, value: null },
  'world/perception': { turn: 0, range: null, value: { kind: 'inline', value: {} } },
  'request/refused': { id: null, bytes: 1, limit: 2, phase: 'plan' },
  'assistant/message': { id: null, value: { kind: 'inline', value: {} } },
  'tool/call': { turn: 0, request: null, call: null },
  'tool/result': null,
  'compaction/start': { id: null },
  'compaction/summary': null,
  'compaction/end': null,
  'compaction/abort': null,
};

describe('boundary registry payload negatives', () => {
  it('has a malformed-payload case for every registered type', () => {
    expect(Object.keys(MALFORMED).sort()).toEqual(Object.keys(registry).sort());
    for (const type of Object.keys(registry)) {
      const validate = registry[type as keyof typeof registry];
      expect(() => validate(MALFORMED[type]!, scope), type).toThrow();
    }
  });

  it('refuses an unknown field even when the known fields are valid', () => {
    expect(() => registry['artifact/chunk']({
      artifact: 'a'.repeat(64), index: 0, base64: '', stray: true,
    }, scope)).toThrow(/unexpected key "stray"/);
  });
});

describe('boundary registry: the slimmed local vocabulary', () => {
  const REMOVED = [
    'request/plan', 'request/wire', 'response/raw', 'request/usage', 'assistant/attempt',
  ] as const;

  it.each(REMOVED)('no longer registers %s', (type) => {
    expect(registry).not.toHaveProperty(type);
  });

  it('refuses a local append of a removed type through the gate', () => {
    const callbacks = {
      append: () => { throw new Error('the gate must refuse before appending'); },
      flush: async () => {},
      lookup: () => null,
      readBlob: async () => new Uint8Array(),
      now: () => 1,
    };
    const lookup = callbacks.lookup;
    const { gate } = createBoundaryGate(
      registry, { phase: 'turn', turn: 0, signal: scope.signal, lookup }, callbacks,
    );
    expect(() => (gate.append as unknown as (type: string, data: JsonValue) => unknown)(
      'request/wire', { id: { turn: 0, ordinal: 0 }, attempt: 0, body: null },
    )).toThrow('unknown boundary event type: "request/wire"');
  });

  it('requires a nonempty frontierCall on the assistant projection', () => {
    const projection = (over: Record<string, unknown>): JsonValue => ({
      id: { turn: 0, ordinal: 0 },
      value: {
        kind: 'inline',
        value: {
          message: { role: 'assistant', content: 'hi', tool_calls: [] },
          contentTruncated: false,
          frontierCall: 'c1',
          ...over,
        },
      },
    }) as unknown as JsonValue;
    expect(() => registry['assistant/message'](projection({}), scope)).not.toThrow();
    expect(() => registry['assistant/message'](projection({ frontierCall: '' }), scope))
      .toThrow(/frontierCall.*nonempty/);
    // The retired raw back-pointer is not part of the projection shape.
    expect(() => registry['assistant/message'](
      projection({ raw: { kind: 'c13-artifact' } }), scope,
    )).toThrow(/unexpected key "raw"/);
  });

  it('accepts a null or nonempty frontierCall on tool/result', () => {
    const result = (over: Record<string, unknown>): JsonValue => ({
      turn: 0, request: { turn: 0, ordinal: 0 }, callId: 'c1',
      message: { role: 'tool', content: 'ok', tool_call_id: 'c1' },
      isError: false, raw: null, failure: null, synthetic: false,
      frontierCall: null,
      ...over,
    }) as unknown as JsonValue;
    expect(() => registry['tool/result'](result({}), scope)).not.toThrow();
    expect(() => registry['tool/result'](result({ frontierCall: 'call-1' }), scope)).not.toThrow();
    expect(() => registry['tool/result'](result({ frontierCall: '' }), scope))
      .toThrow(/frontierCall.*nonempty/);
  });
});
