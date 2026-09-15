import { HASH_RE } from './canon.js';
import { FORMAT_VERSION, GENESIS_HASH, assertKnownType, verifyEvent, type EventEnvelope } from './envelope.js';
import type { ScannedBatch } from './framing.js';
import { CorruptionError } from './errors.js';

/**
 * Chain verification, shared by the reader and the writer's `resume`.
 *
 * One iterator enforces every rule of the chain — format version, seq
 * contiguity, `prev_hash` linkage, hash recomputation, known-type refusal — so
 * a log that verifies for one of them verifies identically for the other. Any
 * violation is a typed `ChainBreakError` naming the seq.
 */
export class ChainBreakError extends CorruptionError {
  constructor(public readonly seq: number, reason: string) {
    super(`hash chain broken at seq ${seq}: ${reason}`);
  }
}

/** The frozen v0 envelope key set; a field outside it refuses to rebuild. */
const ENVELOPE_KEYS = new Set(['v', 'type', 'seq', 'time', 'prev_hash', 'hash', 'ignorable', 'data']);

/**
 * Parses one canonical log line into an envelope. A line that is not a JSON
 * object, that carries a key outside the frozen v0 set, or whose `prev_hash` /
 * `hash` is not 64 lowercase hex characters is refused here, so the caller sees
 * a typed `ChainBreakError` rather than a raw `TypeError` — and an injected
 * top-level field can never ride along unnoticed.
 */
export function parseEnvelope(line: string, seq: number): EventEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ChainBreakError(seq, 'line is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ChainBreakError(seq, 'line is not a JSON object');
  }
  const e = parsed as Record<string, unknown>;
  for (const key of Object.keys(e)) {
    if (!ENVELOPE_KEYS.has(key)) throw new ChainBreakError(seq, `unknown envelope field "${key}"`);
  }
  if (typeof e['prev_hash'] !== 'string' || !HASH_RE.test(e['prev_hash'])) {
    throw new ChainBreakError(seq, 'prev_hash is not 64 lowercase hex characters');
  }
  if (typeof e['hash'] !== 'string' || !HASH_RE.test(e['hash'])) {
    throw new ChainBreakError(seq, 'hash is not 64 lowercase hex characters');
  }
  return e as unknown as EventEnvelope;
}

/**
 * Walks decoded batches, enforcing format version, seq contiguity, `prev_hash`
 * linkage and hash recomputation, and mutating `state` as it goes. The reader
 * and the writer's `resume` share it, so both apply identical rules; `known` is
 * null on the resume path, which only needs the chain itself to be intact.
 */
/**
 * Chain state carried across a verification pass. `firstHash` is set on the
 * first event seen, so a caller resuming a journal learns the chain's root from
 * the same walk that verified it — there is no separate peek at the first line.
 */
export interface ChainState {
  prevHash: string;
  seq: number;
  /** The hash of the first event of the chain, or null while none was seen. */
  firstHash: string | null;
}

export function* verifyChain(
  batches: ScannedBatch[],
  known: ReadonlySet<string> | null,
  state: ChainState,
): Generator<EventEnvelope> {
  for (const batch of batches) {
    for (const line of batch.lines) {
      const e = parseEnvelope(line, state.seq);
      // A format change (v: 1) is a different file, never an in-place
      // mutation, so a v-mismatch means the reader must refuse to rebuild.
      if (e.v !== FORMAT_VERSION) {
        throw new ChainBreakError(e.seq, `unsupported format version ${e.v}`);
      }
      if (e.seq !== state.seq) throw new ChainBreakError(e.seq, `expected seq ${state.seq}`);
      if (e.prev_hash !== state.prevHash) throw new ChainBreakError(e.seq, 'prev_hash mismatch');
      if (!verifyEvent(e)) throw new ChainBreakError(e.seq, 'hash recomputation failed');
      if (known !== null) assertKnownType(e.type, e.ignorable ?? false, known);
      state.firstHash ??= e.hash;
      state.prevHash = e.hash;
      state.seq += 1;
      yield e;
    }
  }
}

/** The genesis chain state a log is verified from. */
export function genesisState(): ChainState {
  return { prevHash: GENESIS_HASH, seq: 0, firstHash: null };
}

/**
 * Walks the whole chain, discarding the events, and returns the resulting
 * state. The writer's `resume` uses this: it needs only the verified tail and
 * root, not the events themselves.
 */
export function verifyAll(
  batches: ScannedBatch[],
  known: ReadonlySet<string> | null,
  state: ChainState,
): ChainState {
  for (const _ of verifyChain(batches, known, state)) { /* consume */ }
  return state;
}
