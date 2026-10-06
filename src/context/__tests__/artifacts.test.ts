import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  BlobStore, JournalWriter, MAX_BLOB_BYTES, canonicalizeJson, isBlobRef,
} from '../../journal/index.js';
import type { EventEnvelope } from '../../journal/index.js';
import { sha256HexOf } from '../../journal/canon.js';
import { payloadOfCanonicalBytes, useTempHome } from '../../journal/__tests__/helpers.js';
import { createBoundaryGate } from '../../node/gate.js';
import type { GateCallbacks, GateScope, BoundaryGate } from '../../node/gate.js';
import { createBoundaryRegistry } from '../events.js';
import { C13_EVENT_TYPES } from '../events.js';
import { canonicalBytes, resolveArtifact, resolveStored, toJson } from '../artifacts.js';
import { loadVerifiedEvents, ArtifactMismatchError } from '../loader.js';
import type { VerifiedEvent, VerifiedEvents } from '../loader.js';
import type { ArtifactChunk, ArtifactRef, ArtifactManifest, Source, WorldPerception } from '../contracts.js';

const home = useTempHome('c13-artifacts-');

const GENESIS = '0'.repeat(64);

/** A structurally-valid `EventEnvelope` for hand-built verified sequences. */
function envelope(over: Partial<EventEnvelope> & { type: string; data: EventEnvelope['data'] }):
EventEnvelope {
  return { v: 0, seq: 0, time: 1, prev_hash: GENESIS, hash: GENESIS, ...over };
}

const verified = (e: EventEnvelope): VerifiedEvent => ({ ...e, raw: e });

const wp = (text: string): WorldPerception => ({
  uid: 'n1', range: { from: null, to: null }, effectiveFrom: null, fallback: 'none',
  renderer: { policy: 'commit-patches-v1', gitVersion: 'git version 2.43.0', attrSource: 'to' },
  maxBytes: 32768, maxCommits: 4096, listTruncated: false,
  commits: [], included: [], omittedOwn: [], text, truncated: false,
});

interface GateHarness {
  readonly writer: JournalWriter;
  readonly gate: BoundaryGate;
  readonly receipts: Map<string, EventEnvelope>;
  readonly close: () => void;
}

async function openGate(): Promise<GateHarness> {
  const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
  const controller = new AbortController();
  const receipts = new Map<string, EventEnvelope>();
  const record = (e: EventEnvelope): EventEnvelope => {
    receipts.set(`${e.seq}:${e.hash}`, e);
    return e;
  };
  const lookup = (s: Source): EventEnvelope | null => receipts.get(`${s.seq}:${s.hash}`) ?? null;
  const callbacks: GateCallbacks = {
    append: (type, data) => record(writer.append(type, data as never)),
    flush: () => writer.flush(),
    lookup,
    readBlob: (hash) => new BlobStore(home()).get(hash),
    now: () => 1,
  };
  const scope: GateScope = { phase: 'turn', turn: 0, signal: controller.signal, lookup };
  const created = createBoundaryGate(createBoundaryRegistry(), scope, callbacks);
  return { writer, gate: created.gate, receipts, close: created.close };
}

async function readAll(): Promise<VerifiedEvents> {
  return loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES);
}

describe('toJson', () => {
  it('returns a deep, frozen copy that does not alias the input', () => {
    const input = { a: [1, { b: 'x' }], c: null };
    const json = toJson(input);
    expect(json).toEqual(input);
    expect(Object.isFrozen(json)).toBe(true);
    const arr = json as { a: unknown[] };
    expect(Object.isFrozen(arr.a)).toBe(true);
    input.a[0] = 99;
    expect((json as { a: number[] }).a[0]).toBe(1);
  });

  it('rejects undefined, non-finite numbers and lone surrogates', () => {
    expect(() => toJson({ a: undefined })).toThrow();
    expect(() => toJson({ a: Number.NaN })).toThrow();
    expect(() => toJson({ a: Infinity })).toThrow();
    expect(() => toJson('\uD800')).toThrow();
    expect(() => toJson({ a: 'ok\uDC00' })).toThrow();
  });

  it('rejects cycles and non-plain objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => toJson(cyclic)).toThrow();
    expect(() => toJson(new Date())).toThrow();
    expect(() => toJson(new Map())).toThrow();
    expect(() => toJson(Buffer.from('x'))).toThrow();
    class Thing { public x = 1; }
    expect(() => toJson(new Thing())).toThrow();
  });
});

describe('canonicalBytes', () => {
  it('is the RFC-8785 canonical UTF-8 of the value', () => {
    const bytes = canonicalBytes({ b: 1, a: 2 });
    expect(Buffer.from(bytes).toString('utf8')).toBe('{"a":2,"b":1}');
    expect(bytes).toEqual(Buffer.from(canonicalizeJson({ b: 1, a: 2 }), 'utf8'));
  });

  it('rejects values with no canonical JSON form', () => {
    expect(() => canonicalBytes({ a: undefined })).toThrow();
    expect(() => canonicalBytes({ a: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe('capture, resolveArtifact and manifest verification', () => {
  it('round-trips a chunked artifact through capture and resolveArtifact', async () => {
    const h = await openGate();
    try {
      const input = Buffer.alloc(200 * 1024, 0x61);
      const ref = await h.gate.capture(input, 'binary');
      expect(ref.kind).toBe('c13-artifact');
      expect(ref.bytes).toBe(input.length);
      expect(ref.sha256).toBe(sha256HexOf(input));
      expect(ref.complete).toBe(true);
      await h.gate.flush();
      await h.writer.close();
      const events = await readAll();
      expect(Buffer.from(resolveArtifact(events, ref)).equals(input)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('records one contiguous chunk event per 64 KiB with a matching manifest', async () => {
    const h = await openGate();
    try {
      const input = Buffer.alloc(160 * 1024 + 7, 0x62);
      const ref = await h.gate.capture(input, 'binary');
      await h.gate.flush();
      await h.writer.close();
      const events = await readAll();
      const chunks = events.filter((e) => e.type === 'artifact/chunk');
      expect(chunks).toHaveLength(3);
      expect(chunks.map((e) => (e.data as ArtifactChunk).index)).toEqual([0, 1, 2]);
      // A 64 KiB base64 chunk is past the claim-check threshold: the raw
      // envelope carries a reference, and the resolved form carries the chunk.
      expect(isBlobRef(chunks[0]?.raw.data)).toBe(true);
      const manifestEvent = events.find((e) => e.seq === ref.manifest.seq);
      expect(manifestEvent?.type).toBe('artifact/end');
      const manifest = manifestEvent?.data as ArtifactManifest;
      expect(manifest.artifact).toBe(ref.sha256);
      expect(manifest.sha256).toBe(ref.sha256);
      expect(manifest.bytes).toBe(input.length);
      expect(manifest.encoding).toBe('binary');
      expect(manifest.complete).toBe(true);
      expect(manifest.parts).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it('names the mismatching field when a ref disagrees with its manifest', async () => {
    const h = await openGate();
    try {
      const ref = await h.gate.capture(Buffer.from('hello artifact'), 'utf8');
      await h.gate.flush();
      await h.writer.close();
      const events = await readAll();
      const fields = [
        [{ ...ref, sha256: 'a'.repeat(64) }, 'sha256'],
        [{ ...ref, bytes: ref.bytes + 1 }, 'bytes'],
        [{ ...ref, encoding: 'binary' }, 'encoding'],
        [{ ...ref, complete: false }, 'complete'],
        [{ ...ref, manifest: { seq: 999, hash: 'b'.repeat(64) } }, 'manifest'],
      ] as const;
      for (const [bad, field] of fields) {
        try {
          resolveArtifact(events, bad as ArtifactRef);
          throw new Error('expected ArtifactMismatchError');
        } catch (err) {
          expect(err).toBeInstanceOf(ArtifactMismatchError);
          expect((err as ArtifactMismatchError).field).toBe(field);
        }
      }
    } finally {
      h.close();
    }
  });

  it('rejects a forged chunk receipt, a wrong chunk order and invalid base64', () => {
    const manifestEvent = envelope({
      type: 'artifact/end', seq: 2, hash: 'c'.repeat(64),
      data: {
        artifact: sha256HexOf(Buffer.from('ab')), sha256: sha256HexOf(Buffer.from('ab')),
        bytes: 2, encoding: 'utf8', complete: true,
        parts: [
          { seq: 0, hash: 'd'.repeat(64) }, { seq: 1, hash: 'e'.repeat(64) },
        ],
      },
    });
    const good0 = envelope({
      type: 'artifact/chunk', seq: 0, hash: 'd'.repeat(64),
      data: { artifact: sha256HexOf(Buffer.from('ab')), index: 0, base64: Buffer.from('a').toString('base64') },
    });
    const good1 = envelope({
      type: 'artifact/chunk', seq: 1, hash: 'e'.repeat(64),
      data: { artifact: sha256HexOf(Buffer.from('ab')), index: 1, base64: Buffer.from('b').toString('base64') },
    });
    const ref: ArtifactRef = {
      kind: 'c13-artifact',
      manifest: { seq: 2, hash: 'c'.repeat(64) },
      sha256: sha256HexOf(Buffer.from('ab')), bytes: 2, encoding: 'utf8', complete: true,
    };
    const base: VerifiedEvents = [verified(manifestEvent), verified(good0), verified(good1)];
    expect(Buffer.from(resolveArtifact(base, ref)).toString('utf8')).toBe('ab');

    // Forged: a part receipt that is not in the verified sequence.
    const forgedParts = envelope({
      type: 'artifact/end', seq: 2, hash: 'c'.repeat(64),
      data: { ...(manifestEvent.data as object), parts: [{ seq: 9, hash: 'f'.repeat(64) }] },
    });
    expect(() => resolveArtifact([verified(forgedParts), verified(good0), verified(good1)], ref))
      .toThrow(ArtifactMismatchError);

    // Wrong order: the chunk at index 0 is not the first part.
    const swapped = envelope({
      type: 'artifact/end', seq: 2, hash: 'c'.repeat(64),
      data: {
        ...(manifestEvent.data as object),
        parts: [{ seq: 1, hash: 'e'.repeat(64) }, { seq: 0, hash: 'd'.repeat(64) }],
      },
    });
    expect(() => resolveArtifact([verified(swapped), verified(good0), verified(good1)], ref))
      .toThrow(ArtifactMismatchError);

    // Invalid base64.
    const badChunk = envelope({
      type: 'artifact/chunk', seq: 0, hash: 'd'.repeat(64),
      data: { artifact: sha256HexOf(Buffer.from('ab')), index: 0, base64: 'not base64!!' },
    });
    expect(() => resolveArtifact([verified(manifestEvent), verified(badChunk), verified(good1)], ref))
      .toThrow(ArtifactMismatchError);
  });

  it('rejects a ref whose manifest receipt is missing', () => {
    const ref: ArtifactRef = {
      kind: 'c13-artifact', manifest: { seq: 5, hash: 'a'.repeat(64) },
      sha256: 'a'.repeat(64), bytes: 0, encoding: 'utf8', complete: true,
    };
    expect(() => resolveArtifact([], ref)).toThrow(ArtifactMismatchError);
  });
});

describe('resolveStored', () => {
  it('returns an inline value unchanged through the validator', async () => {
    const h = await openGate();
    try {
      const stored = await h.gate.store({ payload: 'small' });
      expect(stored.kind).toBe('inline');
      await h.gate.flush();
      await h.writer.close();
      const events = await readAll();
      const value = resolveStored(events, stored, (v) => v as { payload: string });
      expect(value).toEqual({ payload: 'small' });
    } finally {
      h.close();
    }
  });

  it('resolves an artifact-json value from its chunks', async () => {
    const h = await openGate();
    try {
      const big = { payload: 'z'.repeat(MAX_BLOB_BYTES) };
      const stored = await h.gate.store(big);
      expect(stored.kind).toBe('artifact-json');
      await h.gate.flush();
      await h.writer.close();
      const events = await readAll();
      const value = resolveStored(events, stored, (v) => v as { payload: string });
      expect(value.payload.length).toBe(big.payload.length);
    } finally {
      h.close();
    }
  });
});

describe('size thresholds', () => {
  /** A valid `world/perception` payload whose event data canonicalizes to exactly `n` bytes. */
  function perceptionData(n: number): unknown {
    const fixed = Buffer.byteLength(canonicalizeJson({
      turn: 0, range: { from: null, to: null },
      value: { kind: 'inline', value: wp('') },
    }), 'utf8');
    return {
      turn: 0, range: { from: null, to: null },
      value: { kind: 'inline', value: wp('a'.repeat(n - fixed)) },
    };
  }

  it('append refuses canonical data at or past MAX_BLOB_BYTES before the writer', async () => {
    const h = await openGate();
    try {
      const spy = vi.spyOn(h.writer, 'append');
      h.gate.append('world/perception', perceptionData(MAX_BLOB_BYTES - 1) as never);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(() => h.gate.append('world/perception', perceptionData(MAX_BLOB_BYTES) as never))
        .toThrow();
      expect(() => h.gate.append('world/perception', perceptionData(MAX_BLOB_BYTES + 1) as never))
        .toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  it('capture round-trips the exact threshold boundaries', async () => {
    const h = await openGate();
    try {
      for (const n of [MAX_BLOB_BYTES - 1, MAX_BLOB_BYTES, MAX_BLOB_BYTES + 1]) {
        const bytes = Buffer.alloc(n, 0x7a);
        const ref = await h.gate.capture(bytes, 'binary');
        expect(ref.bytes).toBe(n);
      }
      await h.gate.flush();
      await h.writer.close();
      const events = await readAll();
      expect(events.filter((e) => e.type === 'artifact/end')).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it('store chooses artifact-json when the inline wrapper would exceed the headroom', async () => {
    const h = await openGate();
    try {
      const { payload } = payloadOfCanonicalBytes(MAX_BLOB_BYTES - 1);
      const stored = await h.gate.store({ payload });
      expect(stored.kind).toBe('artifact-json');
    } finally {
      h.close();
    }
  });
});
