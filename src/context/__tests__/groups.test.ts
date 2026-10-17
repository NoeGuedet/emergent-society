import { describe, expect, it } from 'vitest';
import { sha256HexOf } from '../../journal/canon.js';
import { canonicalBytes } from '../artifacts.js';
import {
  candidateIdentity, groupCitations, isBalancedGroup, sameSourceSet, sortUnique,
} from '../groups.js';
import type {
  CompactionStart, FunctionCall, Source, SurfaceGroup,
} from '../contracts.js';

/**
 * The producer/consumer contract of committed groups (kernel.md §4): the
 * compaction policy selects a span and the surface applies it, so both must
 * agree byte for byte on source identity, citation, balance and candidate
 * identity. These tests pin that shared vocabulary directly.
 */

const src = (seq: number, hash = seq.toString(16).padStart(64, '0')): Source => ({ seq, hash });

const call = (id: string): FunctionCall =>
  ({ id, type: 'function', function: { name: 'execute', arguments: '{}' } });

function group(over: Partial<SurfaceGroup> & Pick<SurfaceGroup, 'kind'>): SurfaceGroup {
  const id = over.id ?? src(1);
  return {
    id, turn: 0, sources: [id], ...over,
    messages: over.messages ?? [],
  };
}

describe('sortUnique: the one canonical receipt ordering', () => {
  it.each([
    { name: 'empty', input: [] as Source[], expected: [] as Source[] },
    {
      name: 'sorts by seq then hash',
      input: [src(2, 'b'.repeat(64)), src(1, 'c'.repeat(64)), src(2, 'a'.repeat(64))],
      expected: [src(1, 'c'.repeat(64)), src(2, 'a'.repeat(64)), src(2, 'b'.repeat(64))],
    },
    {
      name: 'eliminates exact duplicates',
      input: [src(2), src(1), src(2), src(1)],
      expected: [src(1), src(2)],
    },
    {
      name: 'keeps same-seq receipts with different hashes',
      input: [src(1, 'b'.repeat(64)), src(1, 'a'.repeat(64))],
      expected: [src(1, 'a'.repeat(64)), src(1, 'b'.repeat(64))],
    },
    {
      name: 'accepts any iterable',
      input: new Set([src(0), src(0)]),
      expected: [src(0)],
    },
  ])('$name', ({ input, expected }) => {
    expect(sortUnique(input)).toEqual(expected);
  });

  it('returns fresh source objects, never aliases of the input', () => {
    const input = { seq: 1, hash: 'a'.repeat(64) };
    const out = sortUnique([input]);
    expect(out[0]).toEqual(input);
    expect(out[0]).not.toBe(input);
  });
});

describe('sameSourceSet: order-insensitive set equality', () => {
  const a = src(1, 'a'.repeat(64));
  const b = src(2, 'b'.repeat(64));
  const c = src(3, 'c'.repeat(64));

  it.each([
    { name: 'empty sets are equal', left: [] as Source[], right: [] as Source[], expected: true },
    { name: 'order never matters', left: [a, b, c], right: [c, a, b], expected: true },
    { name: 'duplicates are ignored', left: [a, a, b], right: [b, a], expected: true },
    { name: 'a missing receipt differs', left: [a, b], right: [a], expected: false },
    { name: 'an extra receipt differs', left: [a], right: [a, b], expected: false },
    {
      name: 'same seq with a different hash differs',
      left: [a], right: [{ seq: a.seq, hash: 'f'.repeat(64) }], expected: false,
    },
    { name: 'same hash with a different seq differs', left: [a], right: [{ seq: 9, hash: a.hash }], expected: false },
  ])('$name', ({ left, right, expected }) => {
    expect(sameSourceSet(left, right)).toBe(expected);
  });
});

describe('isBalancedGroup: exactly the units compaction may remove', () => {
  const assistant = (calls: FunctionCall[]) =>
    ({ role: 'assistant' as const, content: calls.length === 0 ? 'done' : null, tool_calls: calls });
  const tool = (id: string) => ({ role: 'tool' as const, content: 'ok', tool_call_id: id });

  it('never treats the heading pin as a removable unit', () => {
    const heading = group({
      kind: 'heading', messages: [{ role: 'system', content: 'direction' }],
    });
    expect(isBalancedGroup(heading)).toBe(false);
  });

  it.each([
    { name: 'one user message', kind: 'perception' as const, messages: [{ role: 'user' as const, content: 'x' }], expected: true },
    { name: 'one user message in a summary', kind: 'summary' as const, messages: [{ role: 'user' as const, content: 'x' }], expected: true },
    { name: 'zero messages', kind: 'perception' as const, messages: [], expected: false },
    {
      name: 'two user messages',
      kind: 'perception' as const,
      messages: [{ role: 'user' as const, content: 'x' }, { role: 'user' as const, content: 'y' }],
      expected: false,
    },
    { name: 'a non-user message', kind: 'summary' as const, messages: [{ role: 'system' as const, content: 'x' }], expected: false },
  ])('$name', ({ kind, messages, expected }) => {
    expect(isBalancedGroup(group({ kind, messages }))).toBe(expected);
  });

  it.each([
    {
      name: 'an assistant with no calls',
      messages: [assistant([])],
      expected: true,
    },
    {
      name: 'assistant followed by its results in call order',
      messages: [assistant([call('c1'), call('c2')]), tool('c1'), tool('c2')],
      expected: true,
    },
    {
      name: 'results out of call order',
      messages: [assistant([call('c1'), call('c2')]), tool('c2'), tool('c1')],
      expected: false,
    },
    {
      name: 'a missing result',
      messages: [assistant([call('c1'), call('c2')]), tool('c1')],
      expected: false,
    },
    {
      name: 'an extra result',
      messages: [assistant([call('c1')]), tool('c1'), tool('c2')],
      expected: false,
    },
    {
      name: 'a result bound to the wrong call id',
      messages: [assistant([call('c1')]), tool('c2')],
      expected: false,
    },
    {
      name: 'a user message first',
      messages: [{ role: 'user' as const, content: 'x' }],
      expected: false,
    },
    {
      name: 'an empty dialogue',
      messages: [],
      expected: false,
    },
  ])('dialogue: $name', ({ messages, expected }) => {
    expect(isBalancedGroup(group({ kind: 'dialogue', messages }))).toBe(expected);
  });
});

describe('groupCitations: a summary is cited by its own receipt only', () => {
  const own = src(10);
  const ancestor = src(5);

  it.each([
    {
      name: 'a perception cites its stored sources',
      kind: 'perception' as const,
      sources: [own, ancestor],
      expected: [own, ancestor],
    },
    {
      name: 'a dialogue cites its stored sources',
      kind: 'dialogue' as const,
      sources: [own, ancestor],
      expected: [own, ancestor],
    },
    {
      name: 'a heading cites its stored sources',
      kind: 'heading' as const,
      sources: [own],
      expected: [own],
    },
    {
      name: 'a summary cites only its own id, never its flattened ancestry',
      kind: 'summary' as const,
      sources: [own, ancestor],
      expected: [own],
    },
  ])('$name', ({ kind, sources, expected }) => {
    expect(groupCitations(group({ kind, id: own, sources }))).toEqual(expected);
  });

  it('does not deduplicate a non-summary citation list', () => {
    const cited = groupCitations(group({ kind: 'perception', id: own, sources: [own, own] }));
    expect(cited).toEqual([own, own]);
  });
});

describe('candidateIdentity: the five hashed fields and the excluded id', () => {
  const base: CompactionStart = {
    id: 'f'.repeat(64),
    revision: 'a'.repeat(64),
    groupIds: [src(1), src(2)],
    sources: [src(1), src(2), src(3)],
    shadowHash: 'b'.repeat(64),
    shadowBytes: 128,
  };

  it('hashes exactly revision, groupIds, sources, shadowHash and shadowBytes', () => {
    const expected = sha256HexOf(Buffer.from(canonicalBytes({
      revision: base.revision,
      groupIds: base.groupIds,
      sources: base.sources,
      shadowHash: base.shadowHash,
      shadowBytes: base.shadowBytes,
    })));
    expect(candidateIdentity(base)).toBe(expected);
  });

  it('is unchanged by the transaction id, which is derived rather than hashed', () => {
    expect(candidateIdentity({ ...base, id: '0'.repeat(64) })).toBe(candidateIdentity(base));
  });

  it.each([
    { name: 'revision', change: { revision: 'c'.repeat(64) } },
    { name: 'groupIds', change: { groupIds: [src(1)] } },
    { name: 'groupIds order', change: { groupIds: [src(2), src(1)] } },
    { name: 'sources', change: { sources: [src(1)] } },
    { name: 'sources order', change: { sources: [src(3), src(2), src(1)] } },
    { name: 'shadowHash', change: { shadowHash: 'd'.repeat(64) } },
    { name: 'shadowBytes', change: { shadowBytes: 129 } },
  ])('changes when $name changes', ({ change }) => {
    expect(candidateIdentity({ ...base, ...change })).not.toBe(candidateIdentity(base));
  });
});
