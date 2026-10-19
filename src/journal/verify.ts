import { HASH_RE, NonCanonicalizableError } from './canon.js';
import {
  FORMAT_VERSION, GENESIS_HASH, assertKnownType, eventLine, verifyEvent, type EventEnvelope,
} from './envelope.js';
import type { ScannedBatch } from './framing.js';
import { CorruptionError } from './errors.js';

/**
 * Chain verification, shared by the reader and the writer's `resume`.
 *
 * One iterator enforces every rule of the chain — format version, canonical
 * line encoding, seq contiguity, `prev_hash` linkage, hash recomputation,
 * known-type refusal — so a log that verifies for one of them verifies
 * identically for the other. Any violation is a typed `ChainBreakError` naming
 * the seq.
 */
export class ChainBreakError extends CorruptionError {
  constructor(public readonly seq: number, reason: string) {
    super(`hash chain broken at seq ${seq}: ${reason}`);
  }
}

/** The frozen v0 envelope key set; a field outside it refuses to rebuild. */
const ENVELOPE_KEYS = new Set(['v', 'type', 'seq', 'time', 'prev_hash', 'hash', 'ignorable', 'data']);

/**
 * Parses one canonical log line into an envelope, refusing anything that is not
 * exactly the frozen v0 shape: a non-object, a key outside the v0 set, a missing
 * or mistyped required field, a non-boolean `ignorable`, or a `prev_hash`/`hash`
 * that is not 64 lowercase hex characters. Every refusal is a typed
 * `ChainBreakError`, so a caller never sees a raw `TypeError`, an injected
 * top-level field can never ride along unnoticed, and a damaged line is
 * classified as corruption rather than crashing on an unvalidated field.
 *
 * `seq` is the expected position in the chain (the reader's next seq), used for
 * every message: the event's own `seq` is not trusted until it is validated, so
 * a malformed line still reports a meaningful position instead of `undefined`.
 * A parsed line is plain JSON data — no accessor can have survived `JSON.parse`.
 */
function parseEnvelope(line: string, seq: number): EventEnvelope {
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
  if (typeof e['v'] !== 'number') throw new ChainBreakError(seq, 'v is not a number');
  // JSON.parse('1e999') is Infinity: `typeof === 'number'` alone would let it
  // through to a canonicality refusal, which would misdescribe a malformed
  // version as an uncanonicalizable payload.
  if (!Number.isFinite(e['v'])) throw new ChainBreakError(seq, 'v is not a finite number');
  if (typeof e['type'] !== 'string') throw new ChainBreakError(seq, 'type is not a string');
  const eventSeq = e['seq'];
  if (typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq) || eventSeq < 0) {
    throw new ChainBreakError(seq, 'seq is not a nonnegative safe integer');
  }
  // The documented format is epoch-millisecond wall clock, which may be
  // fractional, so only finiteness is required — never an invented integer time.
  if (typeof e['time'] !== 'number' || !Number.isFinite(e['time'])) {
    throw new ChainBreakError(seq, 'time is not a finite number');
  }
  if (typeof e['prev_hash'] !== 'string' || !HASH_RE.test(e['prev_hash'])) {
    throw new ChainBreakError(seq, 'prev_hash is not 64 lowercase hex characters');
  }
  if (typeof e['hash'] !== 'string' || !HASH_RE.test(e['hash'])) {
    throw new ChainBreakError(seq, 'hash is not 64 lowercase hex characters');
  }
  if (!Object.hasOwn(e, 'data')) throw new ChainBreakError(seq, 'data is missing');
  if (Object.hasOwn(e, 'ignorable') && typeof e['ignorable'] !== 'boolean') {
    throw new ChainBreakError(seq, 'ignorable is not a boolean');
  }
  return e as unknown as EventEnvelope;
}

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

/**
 * Walks decoded batches, enforcing format version, canonical line encoding,
 * seq contiguity, `prev_hash` linkage and hash recomputation, and mutating
 * `state` as it goes. The reader and the writer's `resume` share it, so both
 * apply identical rules; `known` is null on the resume path, which only needs
 * the chain itself to be intact.
 */
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
      // Checked before canonicality: the version is the primary diagnosis for
      // a line this reader was never meant to understand.
      if (e.v !== FORMAT_VERSION) {
        throw new ChainBreakError(state.seq, `unsupported format version ${e.v}`);
      }
      // The hash authenticates the parsed value, not the bytes on disk: a
      // re-indented, duplicate-key or alternate-escape line parses to the same
      // event while storing different bytes. The writer only ever writes
      // `eventLine(e)`, so a line that is not that exact encoding was not
      // produced by the journal and must be refused rather than reinterpreted.
      //
      // This is also where an uncanonicalizable payload (a lone surrogate, a
      // non-finite number) is refused: `eventLine` canonicalizes the whole
      // envelope, so a value with no RFC 8785 form cannot reach `verifyEvent`.
      let canonicalLine: string;
      try {
        canonicalLine = eventLine(e);
      } catch (err) {
        if (err instanceof NonCanonicalizableError) {
          throw new ChainBreakError(state.seq, 'data is not canonicalizable JSON');
        }
        throw err;
      }
      if (canonicalLine !== line) {
        throw new ChainBreakError(state.seq, 'line is not the canonical encoding');
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
