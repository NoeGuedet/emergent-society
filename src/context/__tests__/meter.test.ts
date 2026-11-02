import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { canonicalBytes } from '../artifacts.js';
import {
  DEFAULT_TOKEN_TRIGGER, MAX_MODEL_CONTEXT_TOKENS, METER_BLOCK_OVERHEAD, METER_CHARS_PER_TOKEN,
  headerDigest, meterFires, meterHeadroom, meterPercent, meterThreshold, meterTotal,
  priceMessage, priceMessages, priceSystemText, priceTools, priceWire, surfacePriceAtSample,
  usageWithinWindow,
} from '../meter.js';
import type { ChatMessage, MeterUsage, ToolSchema } from '../contracts.js';
import type { JsonValue } from '../../journal/index.js';

/**
 * The token meter's pure pins (A2/A4): the estimator's exact arithmetic over the
 * wire's composition, the request-header identity, the anchor's adoption rule,
 * the threshold table with its clamp edges, and the input-is-the-wire negative
 * pin. The runtime-level rows (the trigger at the plan site, the journaled
 * accounting) live beside the loop harness.
 */

const tool = (name: string, description: string): ToolSchema => ({
  name, description, parameters: { type: 'object', properties: {}, additionalProperties: false },
});

/** The wire's own wrapped tool array, restated in the test only to pin the wrapper. */
function wrapped(tools: readonly ToolSchema[]): string {
  return JSON.stringify(tools.map((entry) => ({
    type: 'function',
    function: {
      name: entry.name, description: entry.description, parameters: entry.parameters,
    },
  })));
}

const USAGE = (promptTokens: number, completionTokens: number): MeterUsage => ({
  promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cachedTokens: null,
});

describe('the estimator: the exact DSH arithmetic over the wire shapes', () => {
  it('fixes the density and the block overhead', () => {
    expect(METER_CHARS_PER_TOKEN).toBe(4);
    expect(METER_BLOCK_OVERHEAD).toBe(4);
    expect(MAX_MODEL_CONTEXT_TOKENS).toBe(4_194_304);
  });

  it.each<readonly [string, ChatMessage, number]>([
    ['an empty system prompt prices nothing, not even framing', { role: 'system', content: '' }, 0],
    ['a system prompt is density plus role framing, no block overhead',
      { role: 'system', content: 'abcdefgh' }, 2 + 4],
    ['a user message is one text block plus role framing',
      { role: 'user', content: 'abcdefgh' }, 2 + 4 + 4],
    ['a tool result prices like a user block',
      { role: 'tool', content: 'abcdefgh', tool_call_id: 'c1' }, 2 + 4 + 4],
    ['an assistant text is one text block plus role framing',
      { role: 'assistant', content: 'abcdefgh', tool_calls: [] }, 2 + 4 + 4],
    ['an assistant with null content prices only its role',
      { role: 'assistant', content: null, tool_calls: [] }, 4],
    ['a tool call prices name and arguments at density plus one block',
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"cmd":"true"}' } }],
      }, 4 + 1 + 4 + 4],
    ['a content-only assistant with a call prices both',
      {
        role: 'assistant', content: 'abcdefgh',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{}' } }],
      }, 4 + 2 + 4 + (1 + 1 + 4)],
  ])('prices %s', (_name, message, tokens) => {
    expect(priceMessage(message)).toBe(tokens);
  });

  it('is additive: a message array is the sum of its messages', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'abcdefgh' },
      { role: 'user', content: 'ijkl' },
      { role: 'assistant', content: null, tool_calls: [] },
    ];
    expect(priceMessages(messages)).toBe(
      priceMessage(messages[0]!) + priceMessage(messages[1]!) + priceMessage(messages[2]!));
    expect(priceMessages([])).toBe(0);
  });

  it('prices the tools as the WIRE\'S WRAPPED array, never the raw schemas', () => {
    const tools = [tool('t', 'd'.repeat(40))];
    const raw = Math.ceil(JSON.stringify(tools).length / 4) + 4;
    const wire = Math.ceil(wrapped(tools).length / 4) + 4;
    expect(wire).toBeGreaterThan(raw);
    expect(priceTools(tools)).toBe(wire);
    expect(priceTools(tools)).not.toBe(raw);
    expect(priceTools([])).toBe(0);
  });

  it('marks the residual: chars/4 underprices CJK, which the headroom absorbs', () => {
    // 100 CJK code points are 300 UTF-8 bytes; the estimator sees 100 UTF-16
    // units and prices the block at 25 tokens plus framing. The real provider
    // count is higher (DSH's own admission); the CJK text is a stated residual.
    const cjk = '漢'.repeat(100);
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(300);
    expect(priceSystemText(cjk)).toBe(25 + 4);
    expect(priceSystemText(cjk) * 4).toBeLessThan(Buffer.byteLength(cjk, 'utf8'));
  });
});

/** One plan-shaped value: the wire parts plus the canonical-only fields. */
function plan(over: Partial<{
  charter: string; heading: string; substrate: string; history: ChatMessage[];
  queue: ChatMessage[]; tools: ToolSchema[]; model: string;
  parameters: { readonly [key: string]: JsonValue };
}> = {}) {
  return {
    id: { turn: 0, ordinal: 0 },
    config: { seq: 1, hash: '0'.repeat(64) },
    stateHash: 'a'.repeat(64),
    model: over.model ?? 'mock-model',
    parameters: over.parameters ?? { temperature: 0 },
    tools: over.tools ?? [tool('t', 'd'.repeat(40))],
    toolsHash: 'b'.repeat(64),
    sections: [
      { name: 'tools', cache: 'stable', sources: [{ seq: 1, hash: '0'.repeat(64) }] },
      { name: 'charter', cache: 'stable', sources: [{ seq: 1, hash: '0'.repeat(64) }] },
      { name: 'heading', cache: 'stable', sources: [{ seq: 1, hash: '0'.repeat(64) }] },
      { name: 'history', cache: 'advance', sources: [{ seq: 2, hash: 'c'.repeat(64) }] },
      { name: 'queue', cache: 'volatile', sources: [] },
    ],
    history: over.history ?? [{ role: 'user' as const, content: 'hello there' }],
    queue: over.queue ?? [],
    charter: over.charter ?? 'You are node-0. Act in the world.',
    heading: over.heading ?? 'Work on the current shared direction.',
    ...(over.substrate !== undefined ? { substrate: over.substrate } : {}),
  };
}

describe('priceWire: the input is the wire', () => {
  it('is the hand sum of the system blocks, the messages and the tools', () => {
    const subject = plan({
      history: [
        { role: 'user', content: 'hello there' },
        { role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute', arguments: '{"cmd":"ls"}' } }] },
        { role: 'tool', content: 'a file', tool_call_id: 'c1' },
      ],
      queue: [{ role: 'system', content: 'notice' }],
    });
    const expected = priceSystemText(subject.charter) + priceSystemText(subject.heading)
      + priceMessages(subject.history) + priceMessages(subject.queue)
      + priceTools(subject.tools);
    expect(priceWire(subject)).toBe(expected);
  });

  it('prices the substrate block only when it is present', () => {
    const absent = plan();
    const present = plan({ substrate: 'The substrate this kernel serves — models: a, b' });
    expect(priceWire(present)).toBe(
      priceWire(absent) + priceSystemText(present.substrate!));
  });

  it('NEGATIVE PIN: never prices the plan\'s canonical bytes', () => {
    const subject = plan();
    const parts = priceWire(subject);
    const canonical = Math.ceil(canonicalBytes(subject).length / METER_CHARS_PER_TOKEN);
    // The canonical plan carries sections, receipts, a state hash and the raw
    // schemas; the wire carries none of them. The two numbers must not agree,
    // and the published one is the parts sum.
    expect(canonical).not.toBe(parts);
    expect(canonical).toBeGreaterThan(parts);
    expect(parts).toBe(priceWire(subject));
  });
});

describe('headerDigest: model + parameters + toolsHash, never the envelope', () => {
  it('is equal for equal headers and ignores the history (a growing surface still matches)', () => {
    const first = plan();
    const grown = plan({ history: [...first.history, { role: 'user', content: 'more' }] });
    expect(headerDigest(grown)).toBe(headerDigest(first));
  });

  it('changes on a model, a parameter or a tools edit', () => {
    const base = plan();
    expect(headerDigest(plan({ model: 'other-model' }))).not.toBe(headerDigest(base));
    expect(headerDigest(plan({ parameters: { temperature: 0.5 } }))).not.toBe(headerDigest(base));
    expect(headerDigest(plan({ tools: [tool('t', 'other')] }))).not.toBe(headerDigest(base));
    expect(headerDigest(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('surfacePriceAtSample and meterTotal: the anchor\'s rule', () => {
  const assistant: ChatMessage = { role: 'assistant', content: 'done', tool_calls: [] };

  it('samples the surface AFTER the completion is appended', () => {
    const subject = plan();
    expect(surfacePriceAtSample(subject, assistant))
      .toBe(priceWire(subject) + priceMessage(assistant));
  });

  it('adopts a covering usage and adds the surface delta', () => {
    const subject = plan();
    const sample = surfacePriceAtSample(subject, assistant);
    const usage = USAGE(sample + 1000, 0);
    const anchor = { headerDigest: headerDigest(subject), surfacePriceAtSample: sample, usage };
    // The delta on the second request: the surface grew by 40 tokens.
    const total = meterTotal({
      headerDigest: headerDigest(subject), surfacePrice: sample + 40, anchor,
    });
    expect(total).toEqual({ total: usage.totalTokens + 40, kind: 'usage' });
  });

  it('covers the estimate inclusively: usage === sample adopts', () => {
    const usage = USAGE(100, 0);
    const total = meterTotal({
      headerDigest: 'h',
      surfacePrice: 120,
      anchor: { headerDigest: 'h', surfacePriceAtSample: 100, usage },
    });
    expect(total).toEqual({ total: 120, kind: 'usage' });
  });

  it('falls back to the estimate wholesale on an under-report', () => {
    const usage = USAGE(10, 0);
    const total = meterTotal({
      headerDigest: 'h',
      surfacePrice: 120,
      anchor: { headerDigest: 'h', surfacePriceAtSample: 100, usage },
    });
    // Under a matching header the estimate path reduces to the current surface
    // price — the estimate stands wholesale.
    expect(total).toEqual({ total: 120, kind: 'estimate' });
  });

  it('falls back on a header mismatch (a tools/config edit invalidates the anchor)', () => {
    const usage = USAGE(10_000, 0);
    const total = meterTotal({
      headerDigest: 'changed',
      surfacePrice: 120,
      anchor: { headerDigest: 'h', surfacePriceAtSample: 100, usage },
    });
    expect(total).toEqual({ total: 120, kind: 'estimate' });
  });

  it('restarts from the estimate when there is no anchor at all', () => {
    expect(meterTotal({ headerDigest: 'h', surfacePrice: 77, anchor: null }))
      .toEqual({ total: 77, kind: 'estimate' });
  });
});

describe('the threshold table (A4)', () => {
  it('the 1M/256k arm: 69.4% at a 694,000-token threshold', () => {
    expect(meterHeadroom(1_000_000, DEFAULT_TOKEN_TRIGGER)).toBe(50_000);
    expect(meterThreshold(1_000_000, 256_000, DEFAULT_TOKEN_TRIGGER)).toBe(694_000);
    expect(meterPercent(1_000_000, 694_000)).toBe(69.4);
  });

  it('the 200k/32k arm: 76% at a 152,000-token threshold (the 16,000 headroom clamp)', () => {
    expect(meterHeadroom(200_000, DEFAULT_TOKEN_TRIGGER)).toBe(16_000);
    expect(meterThreshold(200_000, 32_000, DEFAULT_TOKEN_TRIGGER)).toBe(152_000);
    expect(meterPercent(200_000, 152_000)).toBe(76);
    expect(meterPercent(200_000, meterThreshold(200_000, 32_000, DEFAULT_TOKEN_TRIGGER)))
      .toBe(76);
  });

  it('clamps the headroom at both edges', () => {
    // A small window: 5%·W is below the 16,000 floor.
    expect(meterHeadroom(100_000, DEFAULT_TOKEN_TRIGGER)).toBe(16_000);
    // A huge window: 5%·W is above the 64,000 ceiling.
    expect(meterHeadroom(4_000_000, DEFAULT_TOKEN_TRIGGER)).toBe(64_000);
    expect(meterHeadroom(1_310_720, DEFAULT_TOKEN_TRIGGER)).toBe(64_000);
  });

  it('takes the ratio term when the reservation leaves more room, O = 0 included', () => {
    // O = 0: 200k − 0 − 16,000 leaves more room than the 80% ratio.
    expect(meterThreshold(200_000, 0, DEFAULT_TOKEN_TRIGGER)).toBe(160_000);
    expect(meterPercent(200_000, 160_000)).toBe(80);
  });

  it('floors the ratio term (integer arithmetic, no float in the journal)', () => {
    expect(meterThreshold(999_999, 0, DEFAULT_TOKEN_TRIGGER)).toBe(799_999);
  });

  it('honours a journaled rule other than the factory one', () => {
    const rule = {
      ratioPermille: 900,
      headroom: { ratioPermille: 100, minTokens: 1000, maxTokens: 2000 },
    };
    expect(meterHeadroom(100_000, rule)).toBe(2000);
    expect(meterThreshold(100_000, 10_000, rule)).toBe(88_000);
    expect(meterPercent(100_000, 88_000)).toBe(88);
    expect(meterPercent(0, 0)).toBe(0);
  });
});

describe('the trigger\'s comparison and the usage bound', () => {
  it('fires strictly above the threshold, never at it', () => {
    expect(meterFires(99, 100)).toBe(false);
    expect(meterFires(100, 100)).toBe(false);
    expect(meterFires(101, 100)).toBe(true);
  });

  it('bounds a usage at the declared window, flattening above it', () => {
    const usage = USAGE(60, 40);
    expect(usageWithinWindow(usage, 100)).toBe(usage);
    expect(usageWithinWindow(usage, 99)).toBeNull();
    // No declared window: only the structural cap applies.
    expect(usageWithinWindow(usage, undefined)).toBe(usage);
    expect(usageWithinWindow(null, 100)).toBeNull();
  });
});
