import { canonicalizeJson } from '../journal/index.js';
import type { JsonValue } from '../journal/index.js';
import { sha256HexOf } from '../journal/canon.js';
import type { ArtifactRef, ArtifactChunk, ArtifactManifest, Stored } from './contracts.js';
import { ArtifactMismatchError } from './loader.js';
import type { VerifiedEvent, VerifiedEvents } from './loader.js';

/**
 * The one serialization and artifact-resolution path of the context assembler.
 *
 * `toJson` is the runtime validator behind every journaled payload: a payload
 * with no canonical JSON form (undefined, non-finite numbers, cycles, non-plain
 * objects, lone surrogates) is refused rather than coerced, and the returned
 * value is a deep copy so an exported snapshot never aliases internal state.
 */

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function copy(value: unknown, path: string, seen: Set<object>): JsonValue {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      if (typeof value === 'string' && hasLoneSurrogate(value)) {
        throw new Error(`lone surrogate at ${path}`);
      }
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
      return value;
    case 'object':
      break;
    default:
      throw new Error(`${typeof value} at ${path}`);
  }
  if (value === null) return null;
  if (seen.has(value)) throw new Error(`circular reference at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = value.map((item, i) => copy(item, `${path}[${i}]`, seen));
      return Object.freeze(out) as unknown as JsonValue;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`non-plain object at ${path}`);
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = copy(item, `${path}.${key}`, seen);
    }
    return Object.freeze(out);
  } finally {
    seen.delete(value);
  }
}

/** Returns a validated deep JSON copy, recursively frozen at every ordinary object/array. */
export function toJson(value: unknown): JsonValue {
  return copy(value, '$', new Set());
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
export function resolveArtifact(events: VerifiedEvents, ref: ArtifactRef): Uint8Array {
  if (!isRecord(ref) || ref.kind !== 'c13-artifact') mismatch('manifest');
  const index = new Map<string, VerifiedEvent>();
  for (const event of events) index.set(`${event.seq}:${event.hash}`, event);
  const manifestEvent = index.get(`${ref.manifest.seq}:${ref.manifest.hash}`);
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
    const event = index.get(`${part.seq}:${part.hash}`);
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
  events: VerifiedEvents, value: Stored<T>, validate: (value: unknown) => T,
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
