import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../journal/index.js';
import { sha256HexOf } from '../../journal/canon.js';
import { canonicalBytes } from '../artifacts.js';
import { canonicalMessagesBytes } from '../../provider/wire.js';
import type {
  CompactionStart, CompactionSummary, Source, SurfaceGroup,
} from '../contracts.js';
import { Surface, SurfacePolicyError } from '../surface.js';

/**
 * Surface unit tests: provenance (every source resolves), exact membership, the
 * heading as node 0 (single source of truth) and defensive copies.
 */

const GENESIS = '0'.repeat(64);

function makeLookup(): {
  readonly lookup: (source: Source) => EventEnvelope | null;
  readonly add: (type: string, seq: number, data?: EventEnvelope['data']) => Source;
  readonly receipts: Map<string, EventEnvelope>;
} {
  const receipts = new Map<string, EventEnvelope>();
  const add = (type: string, seq: number, data: EventEnvelope['data'] = {}): Source => {
    const hash = seq.toString(16).padStart(64, '0');
    receipts.set(`${seq}:${hash}`, {
      v: 0, type, seq, time: 1, prev_hash: GENESIS, hash, data,
    });
    return { seq, hash };
  };
  const lookup = (source: Source): EventEnvelope | null =>
    receipts.get(`${source.seq}:${source.hash}`) ?? null;
  return { lookup, add, receipts };
}

function userGroup(id: Source, sources: Source[]): SurfaceGroup {
  return {
    id, kind: 'perception', turn: 0,
    messages: [{ role: 'user', content: 'perceived' }], sources,
  };
}

describe('Surface heading', () => {
  it('derives the snapshot heading from node 0 and rewrites it in place', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'original heading', source: heading }, lookup);
    expect(surface.snapshot().heading).toEqual({ text: 'original heading', source: heading });
    expect(surface.snapshot().nodes).toHaveLength(1);
    expect(surface.snapshot().nodes[0]?.group.kind).toBe('heading');
    expect(surface.snapshot().nodes[0]?.group.messages[0]).toEqual(
      { role: 'system', content: 'original heading' },
    );

    const next = add('system/message', 1);
    surface.replaceHeading('updated heading', next);
    expect(surface.snapshot().heading).toEqual({ text: 'updated heading', source: next });
    expect(surface.snapshot().nodes[0]?.group.messages[0]).toEqual(
      { role: 'system', content: 'updated heading' },
    );
  });

  it('refuses a heading rewrite not tied to a system/message receipt', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    const notConfig = add('world/perception', 1);
    expect(() => surface.replaceHeading('x', notConfig)).toThrow(SurfacePolicyError);
    const unknown: Source = { seq: 99, hash: 'a'.repeat(64) };
    expect(() => surface.replaceHeading('x', unknown)).toThrow(SurfacePolicyError);
  });
});

describe('Surface append provenance and membership', () => {
  it('appends groups with contiguous positions and resolving sources', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    const perception = add('world/perception', 1);
    const assistant = add('assistant/message', 2);
    const call = add('tool/call', 3);
    surface.append(userGroup(perception, [perception]));
    surface.append({
      id: assistant, kind: 'dialogue', turn: 0,
      messages: [{ role: 'assistant', content: null, tool_calls: [] }],
      sources: [assistant, call],
    });
    expect(surface.snapshot().nodes.map((node) => node.position)).toEqual([0, 1, 2]);
    expect(surface.snapshot().nodes.map((node) => node.group.kind))
      .toEqual(['heading', 'perception', 'dialogue']);
  });

  it('refuses empty sources, an unknown source and a duplicate group id', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    const perception = add('world/perception', 1);
    expect(() => surface.append(userGroup(perception, []))).toThrow(SurfacePolicyError);

    const forged: Source = { seq: perception.seq, hash: 'b'.repeat(64) };
    expect(() => surface.append(userGroup(perception, [forged]))).toThrow(SurfacePolicyError);

    surface.append(userGroup(perception, [perception]));
    expect(() => surface.append(userGroup(perception, [perception]))).toThrow(SurfacePolicyError);
  });

  it('refuses a heading append and a group whose id is not among its sources', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    expect(() => surface.append({
      id: heading, kind: 'heading', turn: 0, messages: [], sources: [heading],
    })).toThrow(SurfacePolicyError);

    const perception = add('world/perception', 1);
    expect(() => surface.append(userGroup(perception, [add('world/perception', 2)])))
      .toThrow(SurfacePolicyError);
  });
});

describe('Surface replaceCommitted', () => {
  type CandidateFields = Omit<CompactionStart, 'id'>;
  const candidateId = (fields: CandidateFields): string =>
    sha256HexOf(Buffer.from(canonicalBytes(fields)));
  const withId = (fields: CandidateFields): CompactionStart =>
    ({ id: candidateId(fields), ...fields });

  /** Long enough that the notice is a strictly smaller replacement of its shadow. */
  const LONG_SHADOW = 'external evidence '.repeat(20);
  const NOTICE = 'Older committed context was removed.';

  function prepared(opts: {
    dialogueContent?: string; summaryContent?: string; durableSummary?: EventEnvelope['data'];
  } = {}): {
    surface: Surface; heading: Source; perception: Source; dialogue: Source;
    dialogueGroup: SurfaceGroup; summarySource: Source;
    candidate: CompactionStart; summary: CompactionSummary;
  } {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    const perception = add('world/perception', 1);
    const dialogue = add('assistant/message', 2);
    surface.append(userGroup(perception, [perception]));
    const dialogueGroup: SurfaceGroup = {
      id: dialogue, kind: 'dialogue', turn: 0,
      messages: [{
        role: 'assistant', content: opts.dialogueContent ?? LONG_SHADOW, tool_calls: [],
      }],
      sources: [dialogue],
    };
    surface.append(dialogueGroup);
    // A consistent baseline whose shadow fields are the *true* encoded shadow of
    // the selected span: every rejection case below breaks exactly one property.
    const shadow = Buffer.from(canonicalMessagesBytes(dialogueGroup.messages));
    const candidate = withId({
      revision: surface.currentRevision, groupIds: [dialogue], sources: [dialogue],
      shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length,
    });
    const message = { role: 'user' as const, content: opts.summaryContent ?? NOTICE };
    const summary: CompactionSummary = {
      id: candidate.id, message, sources: [dialogue],
      replacementBytes: canonicalMessagesBytes([message]).length,
    };
    // The durable receipt carries the real summary payload (mutable, since a test
    // may substitute a forged or invalid durable value).
    const summarySource = add(
      'compaction/summary', 3, (opts.durableSummary ?? summary) as EventEnvelope['data'],
    );
    return {
      surface, heading, perception, dialogue, dialogueGroup, summarySource, candidate, summary,
    };
  }

  it('replaces a committed group with a summary and reindexes positions', () => {
    const { surface, heading, summarySource, candidate, summary } = prepared();
    surface.replaceCommitted(candidate, summary, summarySource);
    const nodes = surface.snapshot().nodes;
    expect(nodes.map((node) => node.position)).toEqual([0, 1, 2]);
    expect(nodes[0]?.group.id).toEqual(heading);
    expect(nodes[2]?.group.kind).toBe('summary');
    expect(nodes[2]?.group.messages[0]?.content).toBe(summary.message.content);
  });

  it('refuses a stale candidate revision', () => {
    const { surface, summarySource, candidate, summary } = prepared();
    const stale = withId({
      revision: 'd'.repeat(64), groupIds: candidate.groupIds, sources: candidate.sources,
      shadowHash: candidate.shadowHash, shadowBytes: candidate.shadowBytes,
    });
    expect(() => surface.replaceCommitted(stale, { ...summary, id: stale.id }, summarySource))
      .toThrow(SurfacePolicyError);
  });

  it('refuses a candidate whose id does not match its fields', () => {
    const { surface, summarySource, candidate, summary } = prepared();
    const forged: CompactionStart = { ...candidate, shadowHash: 'f'.repeat(64) };
    expect(() => surface.replaceCommitted(forged, summary, summarySource)).toThrow(SurfacePolicyError);
  });

  it('refuses a summary whose id does not match the candidate', () => {
    const { surface, summarySource, candidate, summary } = prepared();
    expect(() => surface.replaceCommitted(candidate, { ...summary, id: 'other' }, summarySource))
      .toThrow(SurfacePolicyError);
  });

  it('refuses a summary whose sources do not match the candidate', () => {
    const { surface, summarySource, candidate, summary } = prepared();
    const foreign: Source = { seq: 999, hash: '9'.repeat(64) };
    expect(() => surface.replaceCommitted(
      candidate, { ...summary, sources: [foreign] }, summarySource,
    )).toThrow(SurfacePolicyError);
  });

  it('refuses a candidate whose shadow bytes or hash is not the real encoded span', () => {
    const { surface, summarySource, candidate, summary } = prepared();
    const before = surface.snapshot();
    const cases: ReadonlyArray<Partial<CandidateFields>> = [
      { shadowBytes: candidate.shadowBytes + 1 },
      { shadowHash: 'f'.repeat(64) },
    ];
    for (const over of cases) {
      const forged = withId({
        revision: candidate.revision, groupIds: candidate.groupIds, sources: candidate.sources,
        shadowHash: candidate.shadowHash, shadowBytes: candidate.shadowBytes, ...over,
      });
      expect(() => surface.replaceCommitted(
        forged, { ...summary, id: forged.id }, summarySource,
      )).toThrow(SurfacePolicyError);
    }
    expect(surface.snapshot()).toEqual(before);
  });

  it('refuses a candidate whose sources are not the real group citations', () => {
    const { surface, summarySource, candidate, summary } = prepared();
    const foreign: Source = { seq: 999, hash: '9'.repeat(64) };
    const forged = withId({
      revision: candidate.revision, groupIds: candidate.groupIds, sources: [foreign],
      shadowHash: candidate.shadowHash, shadowBytes: candidate.shadowBytes,
    });
    const before = surface.snapshot();
    expect(() => surface.replaceCommitted(
      forged, { ...summary, id: forged.id, sources: [foreign] }, summarySource,
    )).toThrow(SurfacePolicyError);
    expect(surface.snapshot()).toEqual(before);
  });

  it('refuses a summary whose replacementBytes is not the encoded summary message', () => {
    const { surface, summarySource, candidate, summary } = prepared();
    const off = summary.replacementBytes + 1;
    expect(off).toBeLessThan(candidate.shadowBytes);
    expect(() => surface.replaceCommitted(
      candidate, { ...summary, replacementBytes: off }, summarySource,
    )).toThrow(SurfacePolicyError);
  });

  it('refuses a replacement that is not strictly smaller than the real shadow', () => {
    // A tiny shadow (an empty assistant message) and a notice longer than it: the
    // recorded replacementBytes is correct yet not strictly smaller, so it aborts.
    const { surface, summarySource, candidate, summary } = prepared({
      dialogueContent: '', summaryContent: NOTICE.repeat(10),
    });
    expect(summary.replacementBytes).toBeGreaterThanOrEqual(candidate.shadowBytes);
    expect(() => surface.replaceCommitted(candidate, summary, summarySource))
      .toThrow(SurfacePolicyError);
  });

  it('refuses a selected group that is not a balanced assistant/results unit', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    const dialogue = add('assistant/message', 1);
    const callReceipt = add('tool/call', 2);
    const group: SurfaceGroup = {
      id: dialogue, kind: 'dialogue', turn: 0,
      messages: [{
        role: 'assistant', content: 'x',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'execute', arguments: '{}' } }],
      }],
      sources: [dialogue, callReceipt],
    };
    surface.append(group);
    const summarySource = add('compaction/summary', 3);
    const shadow = Buffer.from(canonicalMessagesBytes(group.messages));
    const candidate = withId({
      revision: surface.currentRevision, groupIds: [dialogue], sources: [dialogue, callReceipt],
      shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length,
    });
    const summary: CompactionSummary = {
      id: candidate.id, message: { role: 'user', content: NOTICE },
      sources: [dialogue, callReceipt],
      replacementBytes: canonicalMessagesBytes([{ role: 'user', content: NOTICE }]).length,
    };
    const before = surface.snapshot();
    expect(() => surface.replaceCommitted(candidate, summary, summarySource))
      .toThrow(SurfacePolicyError);
    expect(surface.snapshot()).toEqual(before);
  });

  it('refuses a candidate citing more than the 4096-receipt bound', () => {
    const { surface, summarySource, candidate, summary } = prepared();
    const many: Source[] = [];
    for (let i = 0; i < 4097; i++) many.push({ seq: 100 + i, hash: 'a'.repeat(64) });
    const forged = withId({
      revision: candidate.revision, groupIds: candidate.groupIds, sources: many,
      shadowHash: candidate.shadowHash, shadowBytes: candidate.shadowBytes,
    });
    const before = surface.snapshot();
    expect(() => surface.replaceCommitted(
      forged, { ...summary, id: forged.id, sources: many }, summarySource,
    )).toThrow(SurfacePolicyError);
    expect(surface.snapshot()).toEqual(before);
  });

  it('does not mutably apply a candidate whose summary is not a compaction/summary', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    const dialogue = add('assistant/message', 1);
    surface.append({
      id: dialogue, kind: 'dialogue', turn: 0,
      messages: [{ role: 'assistant', content: LONG_SHADOW, tool_calls: [] }],
      sources: [dialogue],
    });
    const wrong = add('world/perception', 2);
    const shadow = Buffer.from(canonicalMessagesBytes(
      [{ role: 'assistant', content: LONG_SHADOW, tool_calls: [] }],
    ));
    const candidate = withId({
      revision: surface.currentRevision, groupIds: [dialogue], sources: [dialogue],
      shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length,
    });
    const message = { role: 'user' as const, content: NOTICE };
    const summary: CompactionSummary = {
      id: candidate.id, message, sources: [dialogue],
      replacementBytes: canonicalMessagesBytes([message]).length,
    };
    const before = surface.snapshot();
    expect(() => surface.replaceCommitted(candidate, summary, wrong))
      .toThrow(SurfacePolicyError);
    expect(surface.snapshot()).toEqual(before);
  });

  it('refuses a summary whose content differs from its durable receipt', () => {
    // The forged summary shares the id, the sources and the exact encoded byte
    // length with the durable record — only the content differs — so every
    // candidate/shape check passes and only the receipt binding can refuse it.
    const { surface, summarySource, candidate, summary } = prepared();
    const forgedContent = `${summary.message.content.slice(0, -1)}!`;
    expect(forgedContent).not.toBe(summary.message.content);
    expect(canonicalMessagesBytes([{ role: 'user', content: forgedContent }]).length)
      .toBe(summary.replacementBytes);
    const forged: CompactionSummary = {
      ...summary, message: { role: 'user', content: forgedContent },
    };
    const before = surface.snapshot();
    expect(() => surface.replaceCommitted(candidate, forged, summarySource))
      .toThrow(SurfacePolicyError);
    expect(surface.snapshot()).toEqual(before);
  });

  it('refuses a durable summary receipt whose payload is not a valid summary', () => {
    const { surface, summarySource, candidate, summary } = prepared({
      durableSummary: {} as EventEnvelope['data'],
    });
    const before = surface.snapshot();
    expect(() => surface.replaceCommitted(candidate, summary, summarySource))
      .toThrow(SurfacePolicyError);
    expect(surface.snapshot()).toEqual(before);
  });

  it('refuses a candidate that spans the heading pin', () => {
    const { surface, heading, summarySource, candidate, summary } = prepared();
    const spanning = withId({
      revision: candidate.revision, groupIds: [heading], sources: [heading],
      shadowHash: candidate.shadowHash, shadowBytes: candidate.shadowBytes,
    });
    expect(() => surface.replaceCommitted(
      spanning, { ...summary, id: spanning.id, sources: [heading] }, summarySource,
    )).toThrow(SurfacePolicyError);
  });

  it('refuses non-contiguous group ids', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    const a = add('assistant/message', 1);
    const b = add('world/perception', 2);
    const c = add('assistant/message', 3);
    for (const [id, kind] of [[a, 'dialogue'], [b, 'perception'], [c, 'dialogue']] as const) {
      surface.append({
        id, kind, turn: 0,
        messages: kind === 'dialogue'
          ? [{ role: 'assistant' as const, content: 'x', tool_calls: [] }]
          : [{ role: 'user' as const, content: 'x' }],
        sources: [id],
      });
    }
    const summarySource = add('compaction/summary', 4);
    const candidate = withId({
      revision: surface.currentRevision, groupIds: [a, c], sources: [a, c],
      shadowHash: 'e'.repeat(64), shadowBytes: 100,
    });
    const summary: CompactionSummary = {
      id: candidate.id, message: { role: 'user', content: 's' }, sources: [a, c], replacementBytes: 1,
    };
    expect(() => surface.replaceCommitted(candidate, summary, summarySource))
      .toThrow(SurfacePolicyError);
  });
});

describe('Surface defensive copies', () => {
  it('does not alias internal state through an exported snapshot', () => {
    const { lookup, add } = makeLookup();
    const heading = add('system/message', 0);
    const surface = new Surface({ text: 'h', source: heading }, lookup);
    const perception = add('world/perception', 1);
    const group = userGroup(perception, [perception]);
    surface.append(group);
    // Mutating the caller's object after append must not reach stored state.
    (group.messages[0] as { content: string }).content = 'mutated';
    group.sources.push({ seq: 99, hash: 'a'.repeat(64) });
    const after = surface.snapshot();
    expect(after.nodes[1]?.group.messages[0]?.content).toBe('perceived');
    expect(after.nodes[1]?.group.sources).toEqual([perception]);
    // The emitted snapshot is a frozen copy: a caller cannot alias it back.
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.nodes)).toBe(true);
  });
});

describe('Surface shadow encoding (golden literal)', () => {
  /**
   * A hand-checked golden: the shadow the surface measures is the wire's own
   * message encoder output, pinned by literal bytes and a literal sha so the
   * accept cases above are not tautologically derived from the same function.
   */
  it('encodes the shadow with the wire message encoder, byte for byte', () => {
    const encoded = canonicalMessagesBytes([{ role: 'assistant', content: 'hi', tool_calls: [] }]);
    expect(Buffer.from(encoded).toString('utf8')).toBe('[{"content":"hi","role":"assistant"}]');
    expect(encoded.length).toBe(37);
    expect(sha256HexOf(Buffer.from(encoded)))
      .toBe('41672b307e432263fb23c6c110a718254ef13534dcedf7e27c8c37365adaa127');
  });
});
