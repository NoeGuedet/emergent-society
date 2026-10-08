import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { canonicalMessagesBytes, serializeWire } from '../wire.js';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import { validateProviderParameters } from '../../context/parameters.js';
import type { ChatMessage, FunctionCall, RequestPlan, Source } from '../../context/contracts.js';
import type { JsonValue } from '../../journal/index.js';

/**
 * Wire serializer tests: the single canonical byte encoding of a plan. They
 * assert the parsed JSON shape — key presence and absence — never the physical
 * key order of `JSON.stringify`, since the wire is JCS.
 */

const ID = { turn: 0, ordinal: 0 } as const;
const CONFIG: Source = { seq: 0, hash: '0'.repeat(64) };

function call(id: string): FunctionCall {
  return { id, type: 'function', function: { name: 'execute', arguments: '{"cmd":"ls"}' } };
}

function plan(over: Partial<RequestPlan> = {}): RequestPlan {
  return {
    id: ID, config: CONFIG, stateHash: 'a'.repeat(64),
    model: 'mock-model', parameters: { temperature: 0 },
    policy: {
      stepsPerTurn: 8, compactAfterBytes: 1, keepRecentGroups: 0, maxAttempts: 1,
      retryDelayMs: 0, requestTimeoutMs: 1, shellTimeoutMs: 1, killGraceMs: 1,
      maxCaptureBytes: 1, maxRequestBytes: 1, maxShellCaptureBytes: 1, shellDrainMs: 1,
      maxDiffBytes: 512, maxCommits: 1, maxAssistantBytes: 256, maxToolResultBytes: 256,
      maxToolArgumentBytes: 1, maxCallsPerResponse: 1,
    },
    tools: [{
      name: 'execute', description: 'run', parameters: { type: 'object' },
    }],
    toolsHash: 'b'.repeat(64),
    sections: [
      { name: 'tools', cache: 'stable', sources: [] },
      { name: 'charter', cache: 'stable', sources: [] },
      { name: 'heading', cache: 'stable', sources: [] },
      { name: 'history', cache: 'advance', sources: [] },
      { name: 'queue', cache: 'volatile', sources: [] },
    ],
    history: [], queue: [], charter: 'charter text', heading: 'heading text',
    ...over,
  };
}

function parse(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
}

function messages(bytes: Uint8Array): Array<Record<string, unknown>> {
  return parse(bytes)['messages'] as Array<Record<string, unknown>>;
}

describe('serializeWire: top-level shape', () => {
  it('emits model, supported parameters, OpenAI tools, messages, stream=false and n=1', () => {
    const wire = parse(serializeWire(plan({ parameters: { temperature: 0.5, top_p: 0.9 } })));
    expect(wire['model']).toBe('mock-model');
    expect(wire['temperature']).toBe(0.5);
    expect(wire['top_p']).toBe(0.9);
    expect(wire['stream']).toBe(false);
    expect(wire['n']).toBe(1);
    expect(wire['tools']).toEqual([{
      type: 'function',
      function: { name: 'execute', description: 'run', parameters: { type: 'object' } },
    }]);
  });

  it('refuses reserved and unknown parameters', () => {
    for (const key of ['model', 'messages', 'tools', 'stream', 'n', 'temperature_override', 'headers', 'endpoint', 'api_key']) {
      expect(() => serializeWire(plan({ parameters: { [key]: 1 } })))
        .toThrow(new RegExp(`refus.*${key}|${key}.*refus`));
    }
  });

  it('bounds the permitted parameter values', () => {
    expect(() => serializeWire(plan({ parameters: { temperature: 3 } }))).toThrow(/temperature/);
    expect(() => serializeWire(plan({ parameters: { temperature: -0.1 } }))).toThrow(/temperature/);
    expect(() => serializeWire(plan({ parameters: { top_p: 2 } }))).toThrow(/top_p/);
    expect(() => serializeWire(plan({ parameters: { max_tokens: 0 } }))).toThrow(/max_tokens/);
    expect(() => serializeWire(plan({ parameters: { max_tokens: 1.5 } }))).toThrow(/max_tokens/);
    expect(() => serializeWire(plan({ parameters: { stop: ['a', 'b', 'c', 'd', 'e'] } }))).toThrow(/stop/);
    expect(() => serializeWire(plan({ parameters: { stop: 7 } }))).toThrow(/stop/);
    expect(parse(serializeWire(plan({ parameters: { stop: 'stop' } })))['stop']).toBe('stop');
    expect(parse(serializeWire(plan({ parameters: { stop: ['a', 'b'] } })))['stop']).toEqual(['a', 'b']);
  });
});

describe('serializeWire: exact assistant message shape', () => {
  it('omits tool_calls for a no-call assistant while preserving content null', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: null, tool_calls: [] }];
    const out = messages(serializeWire(plan({ history })));
    const assistant = out[2]!;
    expect(assistant).toEqual({ role: 'assistant', content: null });
    expect('tool_calls' in assistant).toBe(false);
  });

  it('emits the full tool_calls array for a two-call assistant', () => {
    const assistant: ChatMessage = { role: 'assistant', content: 'go', tool_calls: [call('c1'), call('c2')] };
    const out = messages(serializeWire(plan({ history: [assistant] })));
    expect(out[2]).toEqual({
      role: 'assistant', content: 'go',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'execute', arguments: '{"cmd":"ls"}' } },
        { id: 'c2', type: 'function', function: { name: 'execute', arguments: '{"cmd":"ls"}' } },
      ],
    });
    expect(out[2]!['tool_calls']).toHaveLength(2);
  });

  it('preserves tool_call_id and places history before queue', () => {
    const history: ChatMessage[] = [{ role: 'tool', content: 'done', tool_call_id: 'c1' }];
    const queue: ChatMessage[] = [{ role: 'user', content: 'perception' }];
    const out = messages(serializeWire(plan({ history, queue })));
    expect(out[2]).toEqual({ role: 'tool', content: 'done', tool_call_id: 'c1' });
    expect(out[3]).toEqual({ role: 'user', content: 'perception' });
  });
});

describe('serializeWire: purity', () => {
  it('does not mutate the plan', () => {
    const value = plan({
      history: [{ role: 'assistant', content: null, tool_calls: [call('c1')] }],
      queue: [{ role: 'user', content: 'x' }],
    });
    const before = JSON.parse(JSON.stringify(value)) as unknown;
    serializeWire(value);
    serializeWire(value);
    expect(JSON.parse(JSON.stringify(value))).toEqual(before);
  });

  it('canonicalizes deterministically independent of plan key insertion order', () => {
    const a = plan();
    const b = plan();
    expect(Buffer.from(serializeWire(a)).toString('utf8'))
      .toBe(Buffer.from(serializeWire(b)).toString('utf8'));
  });
});

describe('canonicalMessagesBytes: the shared message encoder', () => {
  it('encodes exactly as serializeWire encodes its message array', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ];
    const queue: ChatMessage[] = [{ role: 'user', content: 'p' }];
    const wire = messages(serializeWire(plan({ history, queue })));
    const encoded = JSON.parse(Buffer.from(canonicalMessagesBytes([...history, ...queue])).toString('utf8'));
    expect(encoded).toEqual(wire.slice(2));
  });
});

describe('serializeWire: the shared parameter contract', () => {
  it('emits the exact boundary literals the shared validator accepts', () => {
    const parameters = { temperature: 2, top_p: 1, max_tokens: 1, stop: ['a', 'b', 'c', 'd'] };
    const wire = parse(serializeWire(plan({ parameters })));
    expect(wire['temperature']).toBe(2);
    expect(wire['top_p']).toBe(1);
    expect(wire['max_tokens']).toBe(1);
    expect(wire['stop']).toEqual(['a', 'b', 'c', 'd']);
    expect(validateProviderParameters(parameters)).toEqual(parameters);
  });

  it('refuses exactly the parameter sets validateAgentConfig refuses', () => {
    const rejected: ReadonlyArray<Record<string, JsonValue>> = [
      { n: 2 }, { stream: true }, { foo: 1 }, { temperature: 3 },
      { top_p: 2 }, { max_tokens: 0 }, { stop: 7 },
    ];
    for (const parameters of rejected) {
      expect(() => validateAgentConfig({ ...defaultAgentConfig(), parameters })).toThrow();
      expect(() => serializeWire(plan({ parameters }))).toThrow();
    }
  });

  it('serializes every parameter a validated configuration accepts', () => {
    const parameters = { temperature: 0, top_p: 0.5, max_tokens: 4096, stop: 'end' };
    const config = validateAgentConfig({ ...defaultAgentConfig(), parameters });
    expect(config.parameters).toEqual(parameters);
    const wire = parse(serializeWire(plan({ parameters: config.parameters })));
    expect(wire['temperature']).toBe(0);
    expect(wire['top_p']).toBe(0.5);
    expect(wire['max_tokens']).toBe(4096);
    expect(wire['stop']).toBe('end');
  });
});
