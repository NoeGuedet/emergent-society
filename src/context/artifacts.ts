import { canonicalizeJson } from '../journal/index.js';
import type { JsonValue } from '../journal/index.js';
import { copyJsonValue, sha256HexOf } from '../journal/canon.js';
import type { ArtifactRef, ArtifactChunk, ArtifactManifest, Source, Stored } from './contracts.js';
import { ArtifactMismatchError } from './loader.js';
import type { VerifiedEvent, VerifiedEvents } from './loader.js';

/**
 * A resolved `(seq, hash)` index over chain-verified events. The fold keeps one
 * for its whole observed history and passes it to every resolution, so a lookup
 * is O(1) and a caller never rebuilds the map once per artifact. Passing an index
 * is authoritative: a receipt it does not contain is unresolved even when the
 * caller also holds a full history that does.
 */
export type VerifiedEventIndex = ReadonlyMap<string, VerifiedEvent>;

/** The one `(seq, hash)` key: the provenance identity of a verified event. */
export function eventKey(source: Source): string {
  return `${source.seq}:${source.hash}`;
}

/** Builds the `(seq, hash)` index from a verified sequence in one pass. */
export function buildEventIndex(events: VerifiedEvents): Map<string, VerifiedEvent> {
  const index = new Map<string, VerifiedEvent>();
  for (const event of events) index.set(eventKey(event.raw), event);
  return index;
}

function isEventIndex(value: VerifiedEvents | VerifiedEventIndex): value is VerifiedEventIndex {
  return !Array.isArray(value);
}

/** Uses an already-built index, or builds one from the sequence exactly once. */
function asIndex(events: VerifiedEvents | VerifiedEventIndex): VerifiedEventIndex {
  return isEventIndex(events) ? events : buildEventIndex(events);
}

/**
 * The one serialization and artifact-resolution path of the context assembler.
 *
 * `toJson` is the runtime validator behind every journaled payload: it delegates
 * to the journal's shared stable copy (which refuses undefined, non-finite
 * numbers, cycles, non-plain objects, accessors, `toJSON` hooks and lone
 * surrogates) and then freezes the result at every level, so an exported
 * snapshot never aliases internal state and cannot be mutated after export.
 */

function deepFreeze(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, JsonValue>)[key]!);
  }
  Object.freeze(value);
  return value;
}

/** Returns a validated deep JSON copy, recursively frozen at every ordinary object/array. */
export function toJson(value: unknown): JsonValue {
  return deepFreeze(copyJsonValue(value));
}

/** The RFC-8785 canonical UTF-8 bytes of a value — the exact measure the journal hashes. */
export function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalizeJson(toJson(value)), 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mismatch(field: ArtifactMismatchError['field']): never {
  throw new ArtifactMismatchError(field);
}

function decodeBase64(text: unknown): Buffer {
  if (typeof text !== 'string' || text.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    mismatch('manifest');
  }
  const bytes = Buffer.from(text as string, 'base64');
  if (bytes.toString('base64') !== text) mismatch('manifest');
  return bytes;
}

function manifestOf(event: VerifiedEvent): ArtifactManifest {
  if (event.type !== 'artifact/end') mismatch('manifest');
  const data = event.data;
  if (!isRecord(data)) mismatch('manifest');
  if (typeof data['artifact'] !== 'string' || typeof data['sha256'] !== 'string'
    || typeof data['bytes'] !== 'number' || typeof data['complete'] !== 'boolean'
    || (data['encoding'] !== 'utf8' && data['encoding'] !== 'binary')
    || !Array.isArray(data['parts'])) {
    mismatch('manifest');
  }
  return data as unknown as ArtifactManifest;
}

function chunkOf(event: VerifiedEvent): ArtifactChunk {
  if (event.type !== 'artifact/chunk') mismatch('manifest');
  const data = event.data;
  if (!isRecord(data) || typeof data['artifact'] !== 'string'
    || typeof data['index'] !== 'number' || typeof data['base64'] !== 'string') {
    mismatch('manifest');
  }
  return data as unknown as ArtifactChunk;
}

/**
 * Resolves a durable artifact from the verified event sequence. The reference
 * must agree with its `artifact/end` manifest on receipt identity, digest, byte
 * length, encoding and completeness; each part receipt must resolve to the
 * matching chunk; and the concatenation must re-hash to the manifest digest.
 */
export function resolveArtifact(
  events: VerifiedEvents | VerifiedEventIndex, ref: ArtifactRef,
): Uint8Array {
  if (!isRecord(ref) || ref.kind !== 'c13-artifact') mismatch('manifest');
  const index = asIndex(events);
  const manifestEvent = index.get(eventKey(ref.manifest));
  if (!manifestEvent) mismatch('manifest');
  const manifest = manifestOf(manifestEvent);
  if (manifest.artifact !== manifest.sha256) mismatch('manifest');
  if (ref.sha256 !== manifest.sha256) mismatch('sha256');
  if (ref.bytes !== manifest.bytes) mismatch('bytes');
  if (ref.encoding !== manifest.encoding) mismatch('encoding');
  if (ref.complete !== manifest.complete) mismatch('complete');

  const parts: Buffer[] = [];
  let total = 0;
  for (let i = 0; i < manifest.parts.length; i++) {
    const part = manifest.parts[i]!;
    const event = index.get(eventKey(part));
    if (!event) mismatch('manifest');
    const chunk = chunkOf(event!);
    if (chunk.index !== i || chunk.artifact !== manifest.artifact) mismatch('manifest');
    const bytes = decodeBase64(chunk.base64);
    parts.push(bytes);
    total += bytes.length;
  }
  const resolved = Buffer.concat(parts);
  if (total !== manifest.bytes || resolved.length !== manifest.bytes) mismatch('bytes');
  if (sha256HexOf(resolved) !== manifest.sha256) mismatch('sha256');
  return resolved;
}

/**
 * Resolves a `Stored<T>`: an inline value passes straight to `validate`; an
 * `artifact-json` value is decoded from its verified artifact bytes first.
 */
export function resolveStored<T>(
  events: VerifiedEvents | VerifiedEventIndex, value: Stored<T>, validate: (value: unknown) => T,
): T {
  if (!isRecord(value)) throw new Error('stored value is not a JSON object');
  if (value['kind'] === 'inline') return validate(value['value']);
  if (value['kind'] === 'artifact-json') {
    const ref = value['ref'] as ArtifactRef;
    const bytes = resolveArtifact(events, ref);
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return validate(parsed);
  }
  throw new Error('stored value has an unknown kind');
}
