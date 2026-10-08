import {
  BlobIntegrityError, BlobStore, JournalReader, assertBlobRefReadable, isBlobRef,
  parseBlobJson, throwBlobReadError,
} from '../journal/index.js';
import type { EventEnvelope } from '../journal/index.js';
import type { Source } from './contracts.js';

/**
 * The one C1.3 claim-check resolution path. This loader opens a raw reader (the
 * chain verifies the exact journaled bytes), then resolves each reference
 * through the journal's verified read — refusing a truncated reference, proving
 * digest and byte length, and parsing the JSON body — while retaining the raw
 * envelope so provenance identity stays `(raw.seq, raw.hash)`.
 *
 * `BlobIntegrityError` is the journal's own corruption kind (blobs.ts),
 * re-exported here where every loader consumer names it; the reader with
 * `resolveBlobs: true` now applies the same verified read.
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
 * claim-check reference through the journal's verified read: a flagged
 * truncated reference, a digest or length mismatch, or a non-JSON body is a
 * typed corruption error. A missing blob file is wrapped in
 * `BlobIntegrityError` rather than surfacing a raw ENOENT; any other read
 * failure (EACCES, EIO, invalid hash) propagates with its own type.
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
    // Refuse a flagged prefix before the read, so a truncated reference is
    // never resolved as whole regardless of what its blob file contains.
    assertBlobRefReadable(ref);
    let bytes: Buffer;
    try {
      bytes = await blobs.get(ref.blob);
    } catch (err) {
      // Only a missing blob is an integrity failure; EACCES/EIO/InvalidBlobHash
      // keep their own type and cause.
      throwBlobReadError(ref, err);
    }
    out.push({ ...event, data: parseBlobJson(ref, bytes), raw: event });
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
