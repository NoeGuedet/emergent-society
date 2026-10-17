import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../journal/index.js';
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
  'request/plan': { id: null, value: { kind: 'inline', value: {} } },
  'request/refused': { id: null, bytes: 1, limit: 2, phase: 'plan' },
  'request/wire': { id: null, attempt: 0, body: null },
  'response/raw': { id: null, attempt: 0, status: 200, body: null, complete: true },
  'request/usage': { id: null, attempt: 0, value: {} },
  'assistant/message': { id: null, value: { kind: 'inline', value: {} } },
  'assistant/attempt': { id: null, attempt: 0, failure: null, terminal: false },
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
