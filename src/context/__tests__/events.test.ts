import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../journal/index.js';
import type { EventEnvelope } from '../../journal/index.js';
import { createBoundaryGate } from '../../node/gate.js';
import type { GateScope } from '../../node/gate.js';
import { C13_EVENT_TYPES, createBoundaryRegistry, eventIgnorableDefault } from '../events.js';

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
  'package/define': { id: null, name: 'p', purpose: 'x', sourceBytes: 1 },
  'package/run': { id: null, runId: 'r', sandbox: 'landlock' },
  'package/stop': { id: null, runId: 'r', reason: 'verb' },
  'package/undefine': { id: null },
  'package/effect': { id: null, runId: 'r', kind: 'tool-registered', tool: 't' },
  'package/error': null,
  'package/service': null,
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

// The C1.5 package vocabulary (kernel.md, the sandbox and local-log sections):
// seven ignorable event types, each validated at the gate, each carrying no
// package source bytes and no credential — only identities, names, digests and
// bounded sanitized detail.
describe('boundary registry: the package event vocabulary', () => {
  const id = 'a'.repeat(64);
  const runId = 'b'.repeat(32);
  const subjectHash = 'c'.repeat(64);

  it('accepts and canonicalizes each well-formed package payload', () => {
    const cases: ReadonlyArray<readonly [string, JsonValue]> = [
      ['package/define', { id, name: 'grep_world', purpose: 'search the world', sourceBytes: 120 }],
      ['package/run', { id, runId, sandbox: 'landlock' }],
      ['package/run', { id, runId, sandbox: 'off' }],
      ['package/stop', { id, runId, reason: 'verb' }],
      ['package/stop', { id, runId, reason: 'host-stop' }],
      ['package/undefine', { id }],
      ['package/effect', { id, runId, kind: 'tool-registered', tool: 'grep_world' }],
      ['package/error', { id, runId, code: 'crashed', detail: 'exit status 1' }],
      ['package/error', { id, runId: null, code: 'corrupt', detail: '' }],
      // `runId` may be omitted outright (design §8): a boot-time corrupt error
      // has no Run; the omitted key and the explicit null are one form.
      ['package/error', { id, code: 'corrupt', detail: '' }],
      ['package/service', { id, runId, service: 'execute', subjectHash, ok: true, status: 'completed' }],
      ['package/service', { id, runId, service: 'web_fetch', subjectHash, ok: false, status: 'denied' }],
    ];
    for (const [type, data] of cases) {
      const validate = registry[type as keyof typeof registry];
      expect(() => validate(data, scope), type).not.toThrow();
    }
  });

  it('refuses every out-of-vocabulary enum value', () => {
    expect(() => registry['package/run']({ id, runId, sandbox: 'sandbox' }, scope))
      .toThrow(/sandbox/);
    expect(() => registry['package/stop']({ id, runId, reason: 'crash' }, scope))
      .toThrow(/reason/);
    expect(() => registry['package/effect'](
      { id, runId, kind: 'unregistered', tool: 't' }, scope,
    )).toThrow(/kind/);
    expect(() => registry['package/error']({ id, runId, code: 'exploded', detail: '' }, scope))
      .toThrow(/code/);
    expect(() => registry['package/service'](
      { id, runId, service: 'model_call', subjectHash, ok: true, status: '' }, scope,
    )).toThrow(/service/);
  });

  it('refuses malformed identities and non-safe-integer byte counts', () => {
    expect(() => registry['package/define'](
      { id: 'short', name: 'n', purpose: 'p', sourceBytes: 1 }, scope,
    )).toThrow(/id/);
    expect(() => registry['package/run']({ id, runId: 'z', sandbox: 'off' }, scope))
      .toThrow(/runId/);
    expect(() => registry['package/define'](
      { id, name: 'n', purpose: 'p', sourceBytes: -1 }, scope,
    )).toThrow(/sourceBytes/);
  });

  it('bounds the declared strings (name, purpose, tool)', () => {
    const longName = 'x'.repeat(65);
    const longPurpose = 'y'.repeat(513);
    expect(() => registry['package/define'](
      { id, name: longName, purpose: 'p', sourceBytes: 1 }, scope,
    )).toThrow(/name/);
    expect(() => registry['package/define'](
      { id, name: 'n', purpose: longPurpose, sourceBytes: 1 }, scope,
    )).toThrow(/purpose/);
    expect(() => registry['package/effect'](
      { id, runId, kind: 'tool-registered', tool: longName }, scope,
    )).toThrow(/tool/);
  });

  it('bounds and sanitizes the error detail (no control characters, 1 KiB cap)', () => {
    expect(() => registry['package/error'](
      { id, runId, code: 'crashed', detail: 'bad\x00byte' }, scope,
    )).toThrow(/detail/);
    expect(() => registry['package/error'](
      { id, runId, code: 'crashed', detail: 'x'.repeat(1025) }, scope,
    )).toThrow(/detail/);
    expect(() => registry['package/service'](
      { id, runId, service: 'execute', subjectHash, ok: true, status: 'y'.repeat(1025) }, scope,
    )).toThrow(/status/);
    // Newlines and tabs are journalable; NUL and other C0 bytes are not.
    expect(() => registry['package/error'](
      { id, runId, code: 'crashed', detail: 'line\nand\ttab' }, scope,
    )).not.toThrow();
  });

  it('refuses a non-boolean ok on the service event', () => {
    expect(() => registry['package/service'](
      { id, runId, service: 'execute', subjectHash, ok: 'yes', status: '' }, scope,
    )).toThrow(/ok/);
  });

  it('never admits package source bytes or a stray field into a payload', () => {
    expect(() => registry['package/define'](
      { id, name: 'n', purpose: 'p', sourceBytes: 1, source: 'return {}' }, scope,
    )).toThrow(/unexpected key "source"/);
  });

  it('marks every package type ignorable and every prior type non-ignorable', () => {
    for (const type of Object.keys(registry)) {
      expect(eventIgnorableDefault(type), type)
        .toBe(type.startsWith('package/') ? true : false);
    }
    expect(eventIgnorableDefault('request/wire')).toBe(false);
  });

  it('includes the package family in the reader-known type set', () => {
    for (const type of [
      'package/define', 'package/run', 'package/stop', 'package/undefine',
      'package/effect', 'package/error', 'package/service',
    ]) {
      expect(C13_EVENT_TYPES.has(type), type).toBe(true);
    }
  });

  it('forwards the per-type ignorable default through the gate', () => {
    const forwarded: { type: string; opts: unknown }[] = [];
    const envelope = {
      v: 0, type: 'x', seq: 1, time: 1, prev_hash: '0'.repeat(64),
      hash: 'f'.repeat(64), data: {},
    } as unknown as EventEnvelope;
    const callbacks = {
      append: (type: string, _data: JsonValue, opts?: { ignorable?: boolean }) => {
        forwarded.push({ type, opts });
        return envelope;
      },
      flush: async () => {},
      lookup: () => null,
      readBlob: async () => new Uint8Array(),
      now: () => 1,
    };
    const lookup = callbacks.lookup;
    const { gate } = createBoundaryGate(
      registry, { phase: 'ready', turn: null, signal: scope.signal, lookup }, callbacks,
    );
    gate.append('package/define', {
      id, name: 'grep_world', purpose: 'search the world', sourceBytes: 120,
    });
    expect(forwarded).toEqual([{ type: 'package/define', opts: { ignorable: true } }]);
    gate.append('compaction/abort', { id: 'x', reason: 'stale' });
    expect(forwarded[1]).toEqual({ type: 'compaction/abort', opts: { ignorable: false } });
  });
});
