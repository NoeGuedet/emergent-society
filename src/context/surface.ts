import type { EventEnvelope } from '../journal/index.js';
import { sha256HexOf } from '../journal/canon.js';
import { canonicalBytes, toJson } from './artifacts.js';
import type {
  CompactionStart, CompactionSummary, Source, SurfaceGroup, SurfaceNode, SurfaceSnapshot,
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

const SAME = (a: Source, b: Source): boolean => a.seq === b.seq && a.hash === b.hash;

function groupType(kind: SurfaceGroup['kind']): string | null {
  switch (kind) {
    case 'perception': return 'world/perception';
    case 'dialogue': return 'assistant/message';
    case 'summary': return 'compaction/summary';
    case 'heading': return 'system/message';
    default: return null;
  }
}

function sortUnique(sources: readonly Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    const key = `${source.seq}:${source.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  out.sort((a, b) => (a.seq - b.seq) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return out;
}

/** Order-insensitive set equality of two receipt lists, compared canonically. */
function sameSourceSet(a: readonly Source[], b: readonly Source[]): boolean {
  const left = sortUnique(a);
  const right = sortUnique(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!SAME(left[i]!, right[i]!)) return false;
  }
  return true;
}

/** The transaction identity: the hash of the durable start's own five fields. */
function candidateIdentity(candidate: CompactionStart): string {
  return sha256HexOf(Buffer.from(canonicalBytes({
    revision: candidate.revision, groupIds: candidate.groupIds, sources: candidate.sources,
    shadowHash: candidate.shadowHash, shadowBytes: candidate.shadowBytes,
  })));
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
   * Applies a completed compaction: the contiguous run of committed groups named
   * by `candidate.groupIds` (never node 0, the pin) is replaced by one summary
   * group and positions are reindexed. The candidate's revision must still equal
   * the surface revision at apply time, its id must be the hash of its own
   * fields, the summary must name the same id and cite exactly the candidate's
   * sources, and the replacement must be strictly smaller than the shadow — a
   * durable end that fails any of these is refused and nothing is replaced.
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
    if (summary.replacementBytes >= candidate.shadowBytes) {
      throw new SurfacePolicyError(
        'replaceCommitted: replacement is not strictly smaller than the shadow',
      );
    }
    const summaryReceipt = this.receipt(summarySource, 'replaceCommitted.summary');
    if (summaryReceipt.type !== 'compaction/summary') {
      throw new SurfacePolicyError('replaceCommitted: summary source is not compaction/summary');
    }
    if (candidate.groupIds.length === 0) {
      throw new SurfacePolicyError('replaceCommitted: no group ids');
    }
    if (candidate.sources.length === 0) {
      throw new SurfacePolicyError('replaceCommitted: no source receipts');
    }
    for (const source of candidate.sources) this.receipt(source, 'replaceCommitted.source');

    const positions: number[] = [];
    const seen = new Set<number>();
    for (const id of candidate.groupIds) {
      const position = this.groups.findIndex((group) => SAME(group.id, id));
      if (position < 0) {
        throw new SurfacePolicyError(`replaceCommitted: group ${id.seq}:${id.hash} is not on the surface`);
      }
      if (seen.has(position)) {
        throw new SurfacePolicyError('replaceCommitted: duplicate group id in candidate');
      }
      seen.add(position);
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

    const summaryGroup: SurfaceGroup = toJson({
      id: summarySource, kind: 'summary', turn: this.groups[first]!.turn,
      messages: [summary.message],
      sources: sortUnique([summarySource, ...summary.sources]),
    }) as unknown as SurfaceGroup;
    this.groups.splice(first, sorted.length, summaryGroup);
  }
}
