import { sha256HexOf } from '../journal/canon.js';
import { canonicalBytes } from './artifacts.js';
import type { CompactionStart, Source, SurfaceGroup } from './contracts.js';

/**
 * The neutral shared helpers of committed-group handling (kernel.md §4).
 *
 * The surface (the consumer that applies a compaction) and the compaction policy
 * (the producer that selects one) must agree, byte for byte, on what a balanced
 * group is, which receipts it cites, and how a candidate's identity is derived.
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
