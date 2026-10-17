import { sha256HexOf } from '../journal/index.js';
import { canonicalMessagesBytes } from '../provider/wire.js';
import { canonicalBytes } from './artifacts.js';
import type {
  ChatMessage, CompactionStart, Source, SurfaceGroup, SurfaceNode,
} from './contracts.js';

/**
 * The neutral shared helpers of committed-group handling (kernel.md §4).
 *
 * The surface (the consumer that applies a compaction) and the compaction policy
 * (the producer that selects one) must agree, byte for byte, on what a balanced
 * group is, which receipts it cites, how a candidate's identity is derived, and
 * which spans are legal (`validateCompactionSpan`).
 * Keeping those in one module that imports neither `surface` nor `compaction`
 * avoids a `surface → compaction → fold` value cycle while still having a single
 * home for the rules.
 */

/**
 * The per-transaction citation bound: at most this many source receipts are named,
 * so a marker's canonical payload can never grow toward `MAX_BLOB_BYTES`. The span
 * stops growing (keeping that group in the recent tail) rather than truncating.
 */
export const MAX_COMPACTION_SOURCES = 4096;

/** Receipt identity: the journal identity of a recorded event. */
export const SAME = (a: Source, b: Source): boolean => a.seq === b.seq && a.hash === b.hash;

/** The deduplicated receipts, in `(seq, hash)` order — the one canonical ordering. */
export function sortUnique(sources: Iterable<Source>): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    const key = `${source.seq}:${source.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ seq: source.seq, hash: source.hash });
  }
  out.sort((a, b) => (a.seq - b.seq) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return out;
}

/** Order-insensitive set equality of two receipt lists, compared canonically. */
export function sameSourceSet(a: readonly Source[], b: readonly Source[]): boolean {
  const left = sortUnique(a);
  const right = sortUnique(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!SAME(left[i]!, right[i]!)) return false;
  }
  return true;
}

/**
 * A group is balanced when its messages are a complete unit: a dialogue is an
 * assistant followed by exactly its advertised results, in call order; a
 * perception or summary group is a single user message; a heading is never a
 * removable unit. An unbalanced group is never a legal compaction span
 * (assistant + all results is indivisible).
 */
export function isBalancedGroup(group: SurfaceGroup): boolean {
  switch (group.kind) {
    case 'heading':
      return false;
    case 'perception':
    case 'summary': {
      const only = group.messages[0];
      return group.messages.length === 1 && only !== undefined && only.role === 'user';
    }
    default: {
      const assistant = group.messages[0];
      if (assistant === undefined || assistant.role !== 'assistant') return false;
      if (group.messages.length !== 1 + assistant.tool_calls.length) return false;
      for (let i = 0; i < assistant.tool_calls.length; i++) {
        const message = group.messages[i + 1];
        const call = assistant.tool_calls[i];
        if (message === undefined || call === undefined) return false;
        if (message.role !== 'tool' || message.tool_call_id !== call.id) return false;
      }
      return true;
    }
  }
}

/**
 * The receipts one selected group contributes to a transaction. A non-summary
 * group cites its stored sources. A summary group is cited by its own summary
 * receipt only: its transitive ancestry is resolved through that durable receipt
 * at verification time, never recursively flattened into every later marker.
 */
export function groupCitations(group: SurfaceGroup): Source[] {
  if (group.kind === 'summary') return [{ seq: group.id.seq, hash: group.id.hash }];
  return group.sources;
}

/** The canonical identity of a candidate: the five fields the transaction id hashes. */
export function candidateIdentity(candidate: CompactionStart): string {
  return sha256HexOf(Buffer.from(canonicalBytes({
    revision: candidate.revision, groupIds: candidate.groupIds, sources: candidate.sources,
    shadowHash: candidate.shadowHash, shadowBytes: candidate.shadowBytes,
  })));
}

/** The heading pin a surface's revision and snapshot derive from. */
export function surfaceHeading(
  groups: readonly SurfaceGroup[],
): { readonly text: string; readonly source: Source } {
  const head = groups[0];
  if (head === undefined) throw new Error('surface heading requires a heading pin');
  const first = head.messages[0];
  return {
    text: first !== undefined && first.role === 'system' ? first.content : '',
    source: head.id,
  };
}

/** The canonical surface revision: a pure function of the heading pin and nodes. */
export function surfaceRevision(groups: readonly SurfaceGroup[]): string {
  const heading = surfaceHeading(groups);
  const nodes: SurfaceNode[] = groups.map((group, position) => ({ position, group }));
  return sha256HexOf(Buffer.from(canonicalBytes({ heading, nodes })));
}

/** A replacement is legal only when it is strictly smaller than the span it removes. */
export function replacementFits(replacementBytes: number, shadowBytes: number): boolean {
  return replacementBytes < shadowBytes;
}

/** The first invariant a candidate span fails; the applier maps each to its message. */
export type CompactionSpanFailure =
  | { readonly code: 'revision' }
  | { readonly code: 'identity' }
  | { readonly code: 'no-group-ids' }
  | { readonly code: 'no-sources' }
  | { readonly code: 'too-many-sources'; readonly max: number }
  | { readonly code: 'unknown-group'; readonly id: Source }
  | { readonly code: 'duplicate-group' }
  | { readonly code: 'heading-pin' }
  | { readonly code: 'non-contiguous' }
  | { readonly code: 'unbalanced' }
  | { readonly code: 'citations' }
  | { readonly code: 'shadow-bytes' }
  | { readonly code: 'shadow-hash' };

/** The real, re-derived span and its encoded shadow, or the first broken invariant. */
export type CompactionSpanVerdict =
  | {
      readonly ok: true;
      readonly first: number;
      readonly length: number;
      readonly span: readonly SurfaceGroup[];
      readonly shadow: Buffer;
    }
  | { readonly ok: false; readonly reason: CompactionSpanFailure };

/**
 * The one definition of a legal compaction span, shared by the producer
 * (`compaction.ts`) and the applier (`surface.ts`). It re-derives everything
 * from the durable groups: the revision and candidate identity must still name
 * this surface, the named groups must be a distinct, contiguous, balanced span
 * outside the heading pin, the candidate sources must be exactly that span's
 * canonical citations, and the recorded shadow bytes/hash must be the real
 * encoding. The replacement-size rule is the separate `replacementFits`, so
 * each caller compares its own replacement value against the real shadow.
 */
export function validateCompactionSpan(
  groups: readonly SurfaceGroup[], candidate: CompactionStart,
): CompactionSpanVerdict {
  if (candidate.revision !== surfaceRevision(groups)) {
    return { ok: false, reason: { code: 'revision' } };
  }
  if (candidate.id !== candidateIdentity(candidate)) {
    return { ok: false, reason: { code: 'identity' } };
  }
  if (candidate.groupIds.length === 0) return { ok: false, reason: { code: 'no-group-ids' } };
  if (candidate.sources.length === 0) return { ok: false, reason: { code: 'no-sources' } };
  if (candidate.sources.length > MAX_COMPACTION_SOURCES) {
    return { ok: false, reason: { code: 'too-many-sources', max: MAX_COMPACTION_SOURCES } };
  }

  // Positions are the surface indexes; duplicate ids and a span touching node 0
  // are refused before contiguity, so each observable failure has one reason.
  const positions: number[] = [];
  const seen = new Set<number>();
  for (const id of candidate.groupIds) {
    const position = groups.findIndex((group) => SAME(group.id, id));
    if (position < 0) return { ok: false, reason: { code: 'unknown-group', id } };
    if (seen.has(position)) return { ok: false, reason: { code: 'duplicate-group' } };
    seen.add(position);
    positions.push(position);
  }
  positions.sort((a, b) => a - b);
  const first = positions[0]!;
  if (first === 0) return { ok: false, reason: { code: 'heading-pin' } };
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== positions[i - 1]! + 1) {
      return { ok: false, reason: { code: 'non-contiguous' } };
    }
  }

  const span: SurfaceGroup[] = [];
  const messages: ChatMessage[] = [];
  const citations: Source[] = [];
  for (const position of positions) {
    const group = groups[position]!;
    if (!isBalancedGroup(group)) return { ok: false, reason: { code: 'unbalanced' } };
    span.push(group);
    for (const message of group.messages) messages.push(message);
    for (const source of groupCitations(group)) citations.push(source);
  }
  const derived = sortUnique(citations);
  if (derived.length !== candidate.sources.length) {
    return { ok: false, reason: { code: 'citations' } };
  }
  for (let i = 0; i < derived.length; i++) {
    if (!SAME(derived[i]!, candidate.sources[i]!)) {
      return { ok: false, reason: { code: 'citations' } };
    }
  }
  const shadow = Buffer.from(canonicalMessagesBytes(messages));
  if (shadow.length !== candidate.shadowBytes) {
    return { ok: false, reason: { code: 'shadow-bytes' } };
  }
  if (sha256HexOf(shadow) !== candidate.shadowHash) {
    return { ok: false, reason: { code: 'shadow-hash' } };
  }
  return { ok: true, first, length: positions.length, span, shadow };
}
