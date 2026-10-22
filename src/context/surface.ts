import { KernelError } from '../errors.js';
import type { EventEnvelope } from '../journal/index.js';
import { canonicalMessagesBytes } from '../provider/wire.js';
import type { GateScope } from '../node/gate.js';
import { canonicalBytes, toJson } from './artifacts.js';
import { createBoundaryRegistry } from './events.js';
import {
  SAME, replacementFits, sameSourceSet, sortUnique, surfaceHeading, surfaceRevision,
  validateCompactionSpan,
} from './groups.js';
import type { CompactionSpanFailure } from './groups.js';
import type {
  CompactionStart, CompactionSummary, Source, SurfaceGroup, SurfaceSnapshot,
} from './contracts.js';

/**
 * The provenance-bearing surface (kernel.md §4): the ordered, committed context
 * groups the assembler turns into history. Node 0 is the heading — the single
 * source of truth for `SurfaceSnapshot.heading` — so a heading rewrite can never
 * drift from the emitted group list. Every `Source` the surface records is a
 * real receipt: `append`/`replace` resolve each claimed source through `lookup`,
 * they do not trust a shape.
 */
export class SurfacePolicyError extends KernelError {
  constructor(message: string) {
    super(message);
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

/** The applier's exact message for each rejected span invariant. */
function spanError(reason: CompactionSpanFailure): SurfacePolicyError {
  switch (reason.code) {
    case 'revision':
      return new SurfacePolicyError('replaceCommitted: candidate revision is stale');
    case 'identity':
      return new SurfacePolicyError('replaceCommitted: candidate id does not match its fields');
    case 'no-group-ids':
      return new SurfacePolicyError('replaceCommitted: no group ids');
    case 'no-sources':
      return new SurfacePolicyError('replaceCommitted: no source receipts');
    case 'too-many-sources':
      return new SurfacePolicyError(
        `replaceCommitted: candidate cites more than ${reason.max} receipts`);
    case 'unknown-group':
      return new SurfacePolicyError(
        `replaceCommitted: group ${reason.id.seq}:${reason.id.hash} is not on the surface`);
    case 'duplicate-group':
      return new SurfacePolicyError('replaceCommitted: duplicate group id in candidate');
    case 'heading-pin':
      return new SurfacePolicyError('replaceCommitted: a candidate may not span the heading pin');
    case 'non-contiguous':
      return new SurfacePolicyError('replaceCommitted: candidate groups are not contiguous');
    case 'unbalanced':
      return new SurfacePolicyError('replaceCommitted: a selected group is not a balanced unit');
    case 'citations':
      return new SurfacePolicyError('replaceCommitted: candidate sources are not the group citations');
    case 'shadow-bytes':
      return new SurfacePolicyError(
        'replaceCommitted: candidate shadowBytes do not match the real span');
    case 'shadow-hash':
      return new SurfacePolicyError(
        'replaceCommitted: candidate shadowHash does not match the real span');
  }
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
    return surfaceRevision(this.groups);
  }

  snapshot(): SurfaceSnapshot {
    const heading = surfaceHeading(this.groups);
    const nodes = this.groups.map((group, position) => ({ position, group }));
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
   * and *before* any mutation. The span itself is the producer's own shared
   * verdict (`validateCompactionSpan`): revision, identity, a contiguous balanced
   * span outside the heading pin, exactly that span's sorted unique citations
   * (a prior summary cited by its own receipt, never flattened), and the real
   * shadow bytes/hash. The applier then binds the summary: it must name the same
   * id, cite exactly the candidate's sources, have `replacementBytes` equal the
   * encoded summary message, and be strictly smaller than the real shadow; every
   * claimed receipt must resolve. A false field is refused even when the id,
   * revision and journal chain are otherwise coherent; nothing is replaced.
   */
  replaceCommitted(
    candidate: CompactionStart, summary: CompactionSummary, summarySource: Source,
  ): void {
    // One shared verdict with the producer: every span invariant (revision,
    // identity, contiguity, balance, citations, shadow) is re-derived from the
    // durable groups before anything is read from the caller's summary.
    const verdict = validateCompactionSpan(this.groups, candidate);
    if (!verdict.ok) throw spanError(verdict.reason);

    if (summary.id !== candidate.id) {
      throw new SurfacePolicyError('replaceCommitted: summary id does not match the candidate');
    }
    if (!sameSourceSet(summary.sources, candidate.sources)) {
      throw new SurfacePolicyError('replaceCommitted: summary sources do not match the candidate');
    }
    if (summary.replacementBytes !== canonicalMessagesBytes([summary.message]).length) {
      throw new SurfacePolicyError(
        'replaceCommitted: summary replacementBytes does not match the encoded summary');
    }
    if (!replacementFits(summary.replacementBytes, verdict.shadow.length)) {
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
    const durable = this.durableSummary(summaryReceipt.data, this.groups[verdict.first]!.turn);
    if (!sameCanonical(durable, summary)) {
      throw new SurfacePolicyError(
        'replaceCommitted: summary does not match its durable compaction/summary receipt');
    }
    for (const source of candidate.sources) this.receipt(source, 'replaceCommitted.source');

    const summaryGroup: SurfaceGroup = toJson({
      id: summarySource, kind: 'summary', turn: this.groups[verdict.first]!.turn,
      messages: [durable.message],
      sources: sortUnique([summarySource, ...durable.sources]),
    }) as unknown as SurfaceGroup;
    this.groups.splice(verdict.first, verdict.length, summaryGroup);
  }
}
