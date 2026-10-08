import type { EventEnvelope } from '../journal/index.js';
import { sha256HexOf } from '../journal/canon.js';
import { canonicalMessagesBytes } from '../provider/wire.js';
import type { GateScope } from '../node/gate.js';
import { canonicalBytes, toJson } from './artifacts.js';
import { createBoundaryRegistry } from './events.js';
import {
  MAX_COMPACTION_SOURCES, SAME, candidateIdentity, groupCitations, isBalancedGroup, sameSourceSet,
  sortUnique,
} from './groups.js';
import type {
  ChatMessage, CompactionStart, CompactionSummary, Source, SurfaceGroup, SurfaceNode, SurfaceSnapshot,
} from './contracts.js';

/**
 * The provenance-bearing surface (kernel.md §4): the ordered, committed context
 * groups the assembler turns into history. Node 0 is the heading — the single
 * source of truth for `SurfaceSnapshot.heading` — so a heading rewrite can never
 * drift from the emitted group list. Every `Source` the surface records is a
 * real receipt: `append`/`replace` resolve each claimed source through `lookup`,
 * they do not trust a shape.
 */
export class SurfacePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfacePolicyError';
  }
}

/** The shared boundary registry: the one `compaction/summary` shape validator. */
const REGISTRY = createBoundaryRegistry();
const SIGNAL = new AbortController().signal;

/** Byte-for-byte canonical equality of two payloads. */
function sameCanonical(a: unknown, b: unknown): boolean {
  return Buffer.from(canonicalBytes(a)).equals(Buffer.from(canonicalBytes(b)));
}

function groupType(kind: SurfaceGroup['kind']): string | null {
  switch (kind) {
    case 'perception': return 'world/perception';
    case 'dialogue': return 'assistant/message';
    case 'summary': return 'compaction/summary';
    case 'heading': return 'system/message';
    default: return null;
  }
}

function headingText(group: SurfaceGroup): string {
  const first = group.messages[0];
  return first !== undefined && first.role === 'system' ? first.content : '';
}

export class Surface {
  private readonly lookup: (source: Source) => EventEnvelope | null;
  /** Index 0 is the heading node; positions are the array indexes. */
  private readonly groups: SurfaceGroup[];

  constructor(
    heading: { readonly text: string; readonly source: Source },
    lookup: (source: Source) => EventEnvelope | null,
  ) {
    this.lookup = lookup;
    const group: SurfaceGroup = toJson({
      id: heading.source, kind: 'heading', turn: 0,
      messages: [{ role: 'system', content: heading.text }], sources: [heading.source],
    }) as unknown as SurfaceGroup;
    this.groups = [group];
  }

  private receipt(source: Source, where: string): EventEnvelope {
    const envelope = this.lookup(source);
    if (envelope === null) {
      throw new SurfacePolicyError(`${where}: unknown source ${source.seq}:${source.hash}`);
    }
    return envelope;
  }

  private revision(): string {
    const heading = { text: headingText(this.groups[0]!), source: this.groups[0]!.id };
    const nodes: SurfaceNode[] = this.groups.map((group, position) => ({ position, group }));
    return sha256HexOf(Buffer.from(canonicalBytes({ heading, nodes })));
  }

  snapshot(): SurfaceSnapshot {
    const head = this.groups[0]!;
    const heading = { text: headingText(head), source: head.id };
    const nodes: SurfaceNode[] = this.groups.map((group, position) => ({ position, group }));
    const revision = this.revision();
    return toJson({ heading, nodes, revision }) as unknown as SurfaceSnapshot;
  }

  /** Current revision — the value a compaction candidate must still match. */
  get currentRevision(): string {
    return this.revision();
  }

  /**
   * Resolves a durable `compaction/summary` receipt's own payload through the one
   * shared registry shape, so the applied summary is the recorded value — never a
   * caller-supplied object of the same shape.
   */
  private durableSummary(data: unknown, turn: number): CompactionSummary {
    const scope: GateScope = { phase: 'turn', turn, signal: SIGNAL, lookup: this.lookup };
    try {
      return REGISTRY['compaction/summary'](data, scope) as unknown as CompactionSummary;
    } catch (err) {
      throw new SurfacePolicyError(
        'replaceCommitted: durable summary is not a valid compaction/summary: '
        + (err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Appends a committed group. The group's id and every claimed source must
   * resolve to a real receipt of the declared type; an empty or unresolvable
   * source list, a duplicate id and a direct heading append all reject.
   */
  append(group: SurfaceGroup): void {
    if (group.kind === 'heading') {
      throw new SurfacePolicyError('append: heading may only be rewritten, not appended');
    }
    const expected = groupType(group.kind);
    if (expected === null) throw new SurfacePolicyError('append: unknown group kind');
    if (this.groups.some((existing) => SAME(existing.id, group.id))) {
      throw new SurfacePolicyError(`append: duplicate group id ${group.id.seq}:${group.id.hash}`);
    }
    if (group.sources.length === 0) {
      throw new SurfacePolicyError('append: a group needs at least one source receipt');
    }
    const idReceipt = this.receipt(group.id, 'append.id');
    if (idReceipt.type !== expected) {
      throw new SurfacePolicyError(`append: group id is ${idReceipt.type}, expected ${expected}`);
    }
    if (!group.sources.some((source) => SAME(source, group.id))) {
      throw new SurfacePolicyError('append: the group id is not among its sources');
    }
    for (const source of group.sources) this.receipt(source, 'append.source');
    this.groups.push(toJson(group) as unknown as SurfaceGroup);
  }

  /** Rewrites node 0 in place; the emitted snapshot heading derives from it. */
  replaceHeading(text: string, source: Source): void {
    if (typeof text !== 'string') throw new SurfacePolicyError('replaceHeading: text must be a string');
    const envelope = this.receipt(source, 'replaceHeading');
    if (envelope.type !== 'system/message') {
      throw new SurfacePolicyError(`replaceHeading: source is ${envelope.type}, expected system/message`);
    }
    this.groups[0] = toJson({
      id: source, kind: 'heading', turn: 0,
      messages: [{ role: 'system', content: text }], sources: [source],
    }) as unknown as SurfaceGroup;
  }

  /**
   * Applies a completed compaction, verifying the whole transaction at apply time
   * and *before* any mutation: the candidate's revision must still equal the
   * surface revision, its id must be the hash of its own five fields, the summary
   * must name the same id and cite exactly the candidate's sources, the named
   * groups must be a real, contiguous, balanced span outside the heading pin, the
   * candidate's sources must be exactly the sorted unique citations of that span
   * (a prior summary cited by its own receipt, never flattened), the recorded
   * shadowBytes/shadowHash must equal the real canonical encoding of the span,
   * `replacementBytes` must equal the encoded summary message and be strictly
   * smaller than that real shadow, and every claimed receipt must resolve. A false
   * field is refused even when the id, revision and journal chain are otherwise
   * coherent; nothing is replaced.
   */
  replaceCommitted(
    candidate: CompactionStart, summary: CompactionSummary, summarySource: Source,
  ): void {
    if (candidate.revision !== this.revision()) {
      throw new SurfacePolicyError('replaceCommitted: candidate revision is stale');
    }
    if (candidate.id !== candidateIdentity(candidate)) {
      throw new SurfacePolicyError('replaceCommitted: candidate id does not match its fields');
    }
    if (summary.id !== candidate.id) {
      throw new SurfacePolicyError('replaceCommitted: summary id does not match the candidate');
    }
    if (!sameSourceSet(summary.sources, candidate.sources)) {
      throw new SurfacePolicyError('replaceCommitted: summary sources do not match the candidate');
    }
    if (candidate.groupIds.length === 0) {
      throw new SurfacePolicyError('replaceCommitted: no group ids');
    }
    if (candidate.sources.length === 0) {
      throw new SurfacePolicyError('replaceCommitted: no source receipts');
    }
    if (candidate.sources.length > MAX_COMPACTION_SOURCES) {
      throw new SurfacePolicyError(
        `replaceCommitted: candidate cites more than ${MAX_COMPACTION_SOURCES} receipts`);
    }

    const positions: number[] = [];
    const seenPositions = new Set<number>();
    for (const id of candidate.groupIds) {
      const position = this.groups.findIndex((group) => SAME(group.id, id));
      if (position < 0) {
        throw new SurfacePolicyError(`replaceCommitted: group ${id.seq}:${id.hash} is not on the surface`);
      }
      if (seenPositions.has(position)) {
        throw new SurfacePolicyError('replaceCommitted: duplicate group id in candidate');
      }
      seenPositions.add(position);
      positions.push(position);
    }
    const first = Math.min(...positions);
    if (first === 0) {
      throw new SurfacePolicyError('replaceCommitted: a candidate may not span the heading pin');
    }
    const sorted = [...positions].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== first + i) {
        throw new SurfacePolicyError('replaceCommitted: candidate groups are not contiguous');
      }
    }

    // The real span, in surface order: its balance, its citations and its encoded
    // shadow are re-derived from the durable groups, never trusted from the record.
    const messages: ChatMessage[] = [];
    const citations: Source[] = [];
    for (const position of sorted) {
      const group = this.groups[position]!;
      if (!isBalancedGroup(group)) {
        throw new SurfacePolicyError('replaceCommitted: a selected group is not a balanced unit');
      }
      for (const message of group.messages) messages.push(message);
      for (const source of groupCitations(group)) citations.push(source);
    }
    const derived = sortUnique(citations);
    if (derived.length !== candidate.sources.length) {
      throw new SurfacePolicyError('replaceCommitted: candidate sources are not the group citations');
    }
    for (let i = 0; i < derived.length; i++) {
      if (!SAME(derived[i]!, candidate.sources[i]!)) {
        throw new SurfacePolicyError('replaceCommitted: candidate sources are not the group citations');
      }
    }
    const shadow = canonicalMessagesBytes(messages);
    if (shadow.length !== candidate.shadowBytes) {
      throw new SurfacePolicyError(
        'replaceCommitted: candidate shadowBytes do not match the real span');
    }
    if (sha256HexOf(Buffer.from(shadow)) !== candidate.shadowHash) {
      throw new SurfacePolicyError('replaceCommitted: candidate shadowHash does not match the real span');
    }
    if (summary.replacementBytes !== canonicalMessagesBytes([summary.message]).length) {
      throw new SurfacePolicyError(
        'replaceCommitted: summary replacementBytes does not match the encoded summary');
    }
    if (summary.replacementBytes >= shadow.length) {
      throw new SurfacePolicyError(
        'replaceCommitted: replacement is not strictly smaller than the shadow',
      );
    }

    const summaryReceipt = this.receipt(summarySource, 'replaceCommitted.summary');
    if (summaryReceipt.type !== 'compaction/summary') {
      throw new SurfacePolicyError('replaceCommitted: summary source is not compaction/summary');
    }
    // Bind the applied summary to the durable receipt's own data: the caller's
    // payload is accepted only when it is byte-identical to the recorded
    // `compaction/summary`, and the spliced group is built from that recorded value.
    const durable = this.durableSummary(summaryReceipt.data, this.groups[first]!.turn);
    if (!sameCanonical(durable, summary)) {
      throw new SurfacePolicyError(
        'replaceCommitted: summary does not match its durable compaction/summary receipt');
    }
    for (const source of candidate.sources) this.receipt(source, 'replaceCommitted.source');

    const summaryGroup: SurfaceGroup = toJson({
      id: summarySource, kind: 'summary', turn: this.groups[first]!.turn,
      messages: [durable.message],
      sources: sortUnique([summarySource, ...durable.sources]),
    }) as unknown as SurfaceGroup;
    this.groups.splice(first, sorted.length, summaryGroup);
  }
}
