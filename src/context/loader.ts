import { BlobStore, JournalReader, isBlobRef } from '../journal/index.js';
import type { EventEnvelope, JsonValue } from '../journal/index.js';
import { sha256HexOf } from '../journal/canon.js';
import { BlobIntegrityError } from '../node/gate.js';
import type { Source } from './contracts.js';

/**
 * The one C1.3 claim-check resolution path. Never call `resolveBlobs: true`:
 * that reader substitutes a payload for its reference *without* re-hashing or
 * size-checking the blob, and discards the raw reference the journal chained.
 * This loader opens a raw reader (the chain verifies the exact journaled bytes),
 * then verifies digest and byte length before parsing, retaining the raw
 * envelope so provenance identity stays `(raw.seq, raw.hash)`.
 *
 * `BlobIntegrityError` is defined in `src/node/gate.ts` (which must not take a
 * node→context value dependency) and re-exported here, where every loader
 * consumer names it.
 */

/** A chain-verified envelope with its payload resolved and its raw journaled form retained. */
export type VerifiedEvent = EventEnvelope & { readonly raw: EventEnvelope };
export type VerifiedEvents = readonly VerifiedEvent[];

export { BlobIntegrityError };

/** An `ArtifactRef` disagreed with its `artifact/end` manifest. */
export class ArtifactMismatchError extends Error {
  constructor(
    public readonly field: 'manifest' | 'sha256' | 'bytes' | 'encoding' | 'complete',
  ) {
    super('artifact reference does not match its manifest');
    this.name = 'ArtifactMismatchError';
  }
}

/**
 * Reads a node's journal raw, verifies the whole chain, and resolves every
 * claim-check reference after digest and size verification. A missing blob file
 * is wrapped in `BlobIntegrityError` rather than surfacing a raw ENOENT.
 */
export async function loadVerifiedEvents(
  home: string, uid: string, knownTypes: ReadonlySet<string>, fromSeq = 0,
): Promise<VerifiedEvents> {
  const reader = await JournalReader.open(home, uid, { knownTypes, resolveBlobs: false });
  const blobs = new BlobStore(home);
  const out: VerifiedEvent[] = [];
  for await (const event of reader.events(fromSeq)) {
    if (!isBlobRef(event.data)) {
      out.push({ ...event, raw: event });
      continue;
    }
    const ref = event.data;
    let bytes: Buffer;
    try {
      bytes = await blobs.get(ref.blob);
    } catch {
      throw new BlobIntegrityError(ref.blob, ref.size, 0);
    }
    if (sha256HexOf(bytes) !== ref.blob || bytes.length !== ref.size) {
      throw new BlobIntegrityError(ref.blob, ref.size, bytes.length);
    }
    const data = JSON.parse(bytes.toString('utf8')) as JsonValue;
    out.push({ ...event, data, raw: event });
  }
  return out;
}

/** The raw journaled envelopes, for consumers that re-serialize each line. */
export function rawEnvelopes(events: VerifiedEvents): readonly EventEnvelope[] {
  return events.map((event) => event.raw);
}

/** The provenance identity of a verified event: always the raw receipt. */
export function sourceOf(event: VerifiedEvent): Source {
  return { seq: event.raw.seq, hash: event.raw.hash };
}
