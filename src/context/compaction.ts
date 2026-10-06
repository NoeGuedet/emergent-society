import { sha256HexOf } from '../journal/canon.js';
import { canonicalMessagesBytes } from '../provider/wire.js';
import { canonicalBytes, toJson } from './artifacts.js';
import type { BoundaryGate } from '../node/gate.js';
import type { ContextFold } from './fold.js';
import type {
  ChatMessage, CompactionStart, CompactionSummary, ProjectionState, Source, SurfaceGroup,
} from './contracts.js';

/**
 * Transactional compaction of whole committed groups (kernel.md §4).
 *
 * `selectCompaction` is the pure policy: it picks the contiguous oldest eligible
 * committed groups (positions >= 1, never the heading pin, never an open or
 * queued group) while keeping the recent tail (`policy.keepRecentGroups`), and
 * only when the committed history has reached `policy.compactAfterBytes` and the
 * single-notice replacement is *strictly* smaller than the encoded shadow it
 * removes. The replacement is the wire's own message encoder
 * (`canonicalMessagesBytes`), so the comparison is the exact bytes the model
 * would receive. A prior summary is cited by its own summary receipt; ancestry
 * stays durable through that receipt instead of being recursively flattened, and
 * a transaction never cites more than `MAX_COMPACTION_SOURCES` receipts.
 *
 * `runCompaction` is the durable transaction: append `start` + barrier, recheck
 * revision/span/balance after the await, append `summary` + barrier, recheck, then
 * append `end` with the actual summary receipt + barrier. The fold alone applies
 * the replacement, and only after a valid durable `end`. A stale candidate is
 * aborted (no replacement); an orphaned transaction from a crash (start and/or
 * summary without an end) is aborted first, so it can never be restarted into a
 * duplicate `compaction/start`. A fatal flush propagates: the transaction never
 * reports `applied` and never writes further into a failed writer.
 */

/** The one replacement notice (kernel.md §4); the removed span is replaced by this user message. */
export const COMPACTION_NOTICE = 'Older committed context was removed; externalize what must survive.';

/**
 * The per-transaction citation bound: at most this many source receipts are named,
 * so a marker's canonical payload can never grow toward `MAX_BLOB_BYTES`. The span
 * stops growing (keeping that group in the recent tail) rather than truncating.
 */
const MAX_COMPACTION_SOURCES = 4096;

const SAME = (a: Source, b: Source): boolean => a.seq === b.seq && a.hash === b.hash;

function sortUnique(sources: readonly Source[]): Source[] {
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

function noticeMessage(): Extract<ChatMessage, { role: 'user' }> {
  return { role: 'user', content: COMPACTION_NOTICE };
}

/**
 * A group is balanced when its messages are a complete unit: a dialogue is an
 * assistant followed by exactly its advertised results, in call order; a
 * perception or summary group is a single user message. An unbalanced group is
 * never selected for removal (assistant + all results is indivisible).
 */
function isBalanced(group: SurfaceGroup): boolean {
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

/** The canonical identity of a candidate: the five fields the transaction ID hashes. */
function candidateIdentity(candidate: CompactionStart): string {
  return sha256HexOf(Buffer.from(canonicalBytes({
    revision: candidate.revision,
    groupIds: candidate.groupIds,
    sources: candidate.sources,
    shadowHash: candidate.shadowHash,
    shadowBytes: candidate.shadowBytes,
  })));
}

/** The sorted, deduplicated union of the accumulated receipts and one group's receipts. */
function mergeSources(existing: readonly Source[], incoming: readonly Source[]): Source[] {
  const merged: Source[] = [];
  for (const source of existing) merged.push({ seq: source.seq, hash: source.hash });
  for (const source of incoming) merged.push({ seq: source.seq, hash: source.hash });
  return sortUnique(merged);
}

/**
 * The receipts one selected group contributes to a transaction. A non-summary
 * group cites its stored sources. A summary group is cited by its own summary
 * receipt only: its transitive ancestry is resolved through that durable receipt
 * at verification time, never recursively flattened into every later marker.
 */
function groupCitations(group: SurfaceGroup): Source[] {
  if (group.kind === 'summary') return [{ seq: group.id.seq, hash: group.id.hash }];
  return group.sources;
}

/**
 * Selects the next compaction, or null when none is warranted. Pure: it reads the
 * folded projection, journals nothing and performs no I/O.
 */
export function selectCompaction(state: ProjectionState): CompactionStart | null {
  const surface = state.surface;
  const config = state.config;
  if (surface === null || config === null) return null;
  const policy = config.value.policy;

  // Committed groups only: the heading pin (position 0) is never eligible, and
  // the open turn and queue are not on the surface at all.
  const committed: SurfaceGroup[] = [];
  for (const node of surface.nodes) {
    if (node.group.kind !== 'heading') committed.push(node.group);
  }
  if (committed.length === 0) return null;

  const history: ChatMessage[] = [];
  for (const group of committed) {
    for (const message of group.messages) history.push(message);
  }
  if (canonicalMessagesBytes(history).length < policy.compactAfterBytes) return null;

  const keep = Math.min(policy.keepRecentGroups, committed.length);
  const eligible = committed.slice(0, committed.length - keep);
  if (eligible.length === 0) return null;

  const chosen: SurfaceGroup[] = [];
  const sources: Source[] = [];
  for (const group of eligible) {
    if (!isBalanced(group)) return null;
    const merged = mergeSources(sources, groupCitations(group));
    if (merged.length > MAX_COMPACTION_SOURCES) break;
    chosen.push(group);
    sources.length = 0;
    for (const source of merged) sources.push(source);
  }
  if (chosen.length === 0) return null;

  const shadowMessages: ChatMessage[] = [];
  for (const group of chosen) {
    for (const message of group.messages) shadowMessages.push(message);
  }
  const shadow = canonicalMessagesBytes(shadowMessages);
  // Strictly smaller or no transaction: a replacement that is not smaller would
  // never reduce the wire, so the policy must not repeat it forever.
  if (canonicalMessagesBytes([noticeMessage()]).length >= shadow.length) return null;

  const candidate = {
    revision: surface.revision,
    groupIds: chosen.map((group) => ({ seq: group.id.seq, hash: group.id.hash })),
    sources,
    shadowHash: sha256HexOf(Buffer.from(shadow)),
    shadowBytes: shadow.length,
  };
  const id = sha256HexOf(Buffer.from(canonicalBytes(candidate)));
  return toJson({ id, ...candidate }) as unknown as CompactionStart;
}

/**
 * Re-derives the candidate from the current state: the revision must still match,
 * the identity must be the hash of its own five fields, the span must still be
 * the same contiguous committed groups with the same receipts, the shadow must
 * re-encode to the recorded bytes, and the replacement must still be strictly
 * smaller. Any drift is stale.
 */
function transactionValid(state: ProjectionState, candidate: CompactionStart): boolean {
  const surface = state.surface;
  if (surface === null || candidate.revision !== surface.revision) return false;
  if (candidate.id !== candidateIdentity(candidate)) return false;
  if (candidate.groupIds.length === 0 || candidate.sources.length === 0) return false;
  if (candidate.sources.length > MAX_COMPACTION_SOURCES) return false;

  const indexes: number[] = [];
  const groups: SurfaceGroup[] = [];
  for (const id of candidate.groupIds) {
    const index = surface.nodes.findIndex((node) => SAME(node.group.id, id));
    if (index < 1) return false;
    indexes.push(index);
    groups.push(surface.nodes[index]!.group);
  }
  for (let i = 1; i < indexes.length; i++) {
    if (indexes[i] !== indexes[i - 1]! + 1) return false;
  }

  const messages: ChatMessage[] = [];
  const sources: Source[] = [];
  for (const group of groups) {
    if (!isBalanced(group)) return false;
    for (const message of group.messages) messages.push(message);
    for (const source of groupCitations(group)) sources.push(source);
  }
  const ordered = sortUnique(sources);
  if (ordered.length !== candidate.sources.length) return false;
  for (let i = 0; i < ordered.length; i++) {
    if (!SAME(ordered[i]!, candidate.sources[i]!)) return false;
  }
  const shadow = canonicalMessagesBytes(messages);
  if (shadow.length !== candidate.shadowBytes) return false;
  if (sha256HexOf(Buffer.from(shadow)) !== candidate.shadowHash) return false;
  if (canonicalMessagesBytes([noticeMessage()]).length >= candidate.shadowBytes) return false;
  return true;
}

async function abortStale(gate: BoundaryGate, id: string): Promise<'aborted'> {
  gate.append('compaction/abort', { id, reason: 'stale' });
  await gate.flush();
  return 'aborted';
}

/**
 * Runs one compaction transaction against `gate`.
 *
 * Orphan recovery comes first: a durable `start` (with or without `summary`) that
 * never ended is aborted with reason `orphan` before any new selection, which is
 * safe in ready scope (`compaction/abort` is scope-agnostic) and prevents a
 * duplicate `compaction/start`. It then appends `start`, `summary` and `end`, each
 * behind a durable barrier, rechecking the candidate after every await; a stale
 * candidate aborts with no replacement.
 */
export async function runCompaction(
  fold: ContextFold, gate: BoundaryGate,
): Promise<'applied' | 'skipped' | 'aborted'> {
  const orphans = fold.orphanCompactions();
  if (orphans.length > 0) {
    for (const orphan of orphans) {
      gate.append('compaction/abort', { id: orphan.id, reason: 'orphan' });
    }
    await gate.flush();
    return 'aborted';
  }

  const candidate = selectCompaction(fold.snapshot());
  if (candidate === null) return 'skipped';

  gate.append('compaction/start', candidate);
  await gate.flush();
  if (!transactionValid(fold.snapshot(), candidate)) return abortStale(gate, candidate.id);

  const message = noticeMessage();
  const summary: CompactionSummary = {
    id: candidate.id,
    message,
    sources: candidate.sources,
    replacementBytes: canonicalMessagesBytes([message]).length,
  };
  const summarySource = gate.append('compaction/summary', summary);
  await gate.flush();
  if (!transactionValid(fold.snapshot(), candidate)) return abortStale(gate, candidate.id);

  // Final validation with no await before the append: once `end` is appended, any
  // later config event is ordered after the completed replacement and updates the
  // pin normally instead of retroactively invalidating the transaction.
  if (!transactionValid(fold.snapshot(), candidate)) return abortStale(gate, candidate.id);
  gate.append('compaction/end', { id: candidate.id, summary: summarySource });
  await gate.flush();
  return 'applied';
}
