import type { EventEnvelope, JsonValue } from '../journal/index.js';
import {
  MAX_BLOB_BYTES, assertBlobBytes, assertBlobRefReadable, canonicalizeJson, isBlobRef,
  throwBlobReadError,
} from '../journal/index.js';
import { sha256HexOf } from '../journal/canon.js';
import type {
  ArtifactChunk, ArtifactManifest, ArtifactRef, Source, Stored,
} from '../context/contracts.js';
import type { VerifiedEvent, VerifiedEvents } from '../context/loader.js';
import type { TurnContext } from './driver.js';

/**
 * The trusted boundary gate (T1 factory / T2 driver).
 *
 * Only trusted C1.3 kernel handlers receive this gate; it is not an agent
 * facade and establishes no non-bypassable boundary. It owns chunking, manifests
 * and the inline threshold so a handler never sees the writer, and its `flush`
 * is a durable barrier: every pending event whose journaled data is a
 * claim-check reference is read back and digest/size-verified before any effect.
 *
 * The node→context edge is type-only (`VerifiedEvent(s)` above), erased at
 * runtime, so this module's runtime graph pulls in only the journal.
 * `BlobIntegrityError` is the journal's own corruption kind, so this gate and
 * `src/context/loader.ts` name one error without a node→context value edge.
 */

/** Extended by declaration merging from `src/context/events.ts` with the C1.3 vocabulary. */
export interface BoundaryDataMap {}
export type BoundaryType = Extract<keyof BoundaryDataMap, string>;

export type GateScope = {
  readonly phase: 'ready' | 'turn';
  /** `ready` scope always uses `turn: null`; `turn` scope requires a nonnegative safe integer. */
  readonly turn: number | null;
  /** The gate's single cancellation signal; `gate.signal === scope.signal`. */
  readonly signal: AbortSignal;
  /** Must be reference-identical to `GateCallbacks.lookup`; the factory rejects a mismatch. */
  readonly lookup: (source: Source) => EventEnvelope | null;
};

export type BoundaryRegistry = {
  readonly [K in BoundaryType]: (data: unknown, scope: GateScope) => JsonValue;
};

export class GateClosedError extends Error {
  constructor() {
    super('boundary gate is closed');
    this.name = 'GateClosedError';
  }
}

export interface BoundaryGate {
  readonly signal: AbortSignal;
  append<K extends BoundaryType>(type: K, data: BoundaryDataMap[K]): Source;
  flush(): Promise<void>;
  /** `complete` defaults to `true`; an incomplete producer passes `false` explicitly. */
  capture(bytes: Uint8Array, encoding: 'utf8' | 'binary', complete?: boolean): Promise<ArtifactRef>;
  store<T>(value: T): Promise<Stored<T>>;
}

export type DurableWatermark = { readonly seq: number; readonly hash: string };

export type GateCallbacks = {
  /** Writer-backed append; the gate validates through the registry first. */
  readonly append: (type: string, data: JsonValue) => EventEnvelope;
  readonly flush: () => Promise<void>;
  /** Receipt lookup over the journal inventory, including pending receipts. */
  readonly lookup: (source: Source) => EventEnvelope | null;
  /**
   * Reads a claim-check blob's bytes as a fresh copy or throws the raw fs error.
   * The gate maps a missing blob (ENOENT) and a short/mismatched blob to
   * `BlobIntegrityError`; any other read failure (EACCES, EIO, invalid hash)
   * propagates unchanged as the environment problem it is.
   */
  readonly readBlob: (hash: string) => Promise<Uint8Array>;
  readonly now: () => number;
};

/** The driver's trusted hooks (T2). `readHistory`/`readBlob` are required when hooks exist. */
export interface DriverHooks {
  readonly registry: BoundaryRegistry;
  onDurable(events: readonly VerifiedEvent[]): Promise<void>;
  onReady(gate: BoundaryGate): Promise<void>;
  onTurnStart(ctx: TurnContext): Promise<void>;
  readHistory: (home: string, uid: string, knownTypes: ReadonlySet<string>) => Promise<VerifiedEvents>;
  readBlob: (hash: string) => Promise<Uint8Array>;
}

/** Fixed artifact ingest ceiling (algorithm 2); lower runtime limits apply before capture. */
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
/** Artifact chunks are 64 KiB of raw bytes; base64 keeps split points from corrupting UTF-8. */
const CHUNK_BYTES = 64 * 1024;
/** Bounded batch so a giant capture cannot pin unbounded pending journal/blob memory. */
const CHUNK_BATCH = 8;
/** Metadata headroom so an inline wrapper's event stays below `MAX_BLOB_BYTES`. */
const INLINE_HEADROOM = 4 * 1024;

class Gate implements BoundaryGate {
  private closed = false;
  /** Envelopes created by this gate whose claim-check blobs must still be verified. */
  private pending: EventEnvelope[] = [];

  constructor(
    private readonly registry: BoundaryRegistry,
    private readonly scope: GateScope,
    private readonly callbacks: GateCallbacks,
  ) {}

  get signal(): AbortSignal {
    return this.scope.signal;
  }

  private assertOpen(): void {
    if (this.closed) throw new GateClosedError();
  }

  append<K extends BoundaryType>(type: K, data: BoundaryDataMap[K]): Source {
    this.assertOpen();
    const validator = (this.registry as Record<
      string, ((data: unknown, scope: GateScope) => JsonValue) | undefined
    >)[type];
    if (typeof validator !== 'function') {
      throw new Error(`unknown boundary event type: ${JSON.stringify(type)}`);
    }
    const validated = validator(data, this.scope);
    this.preflight(validated);
    const envelope = this.callbacks.append(type, validated);
    this.pending.push(envelope);
    return { seq: envelope.seq, hash: envelope.hash };
  }

  /** Refuses a payload whose canonical event data reaches the v0 ceiling, or an exact BlobRef root. */
  private preflight(validated: JsonValue): void {
    if (isBlobRef(validated)) {
      throw new Error('boundary payload root must not be a journal BlobRef');
    }
    const bytes = Buffer.byteLength(canonicalizeJson(validated), 'utf8');
    if (bytes >= MAX_BLOB_BYTES) {
      throw new Error(`boundary payload canonical size ${bytes} reaches MAX_BLOB_BYTES`);
    }
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.callbacks.flush();
    await this.verifyPending();
  }

  async capture(
    bytes: Uint8Array, encoding: 'utf8' | 'binary', complete = true,
  ): Promise<ArtifactRef> {
    this.assertOpen();
    return this.captureBytes(Buffer.from(bytes), encoding, complete);
  }

  async store<T>(value: T): Promise<Stored<T>> {
    this.assertOpen();
    const canonical = canonicalizeJson(value as JsonValue);
    const bytes = Buffer.from(canonical, 'utf8');
    if (bytes.length + INLINE_HEADROOM < MAX_BLOB_BYTES) {
      return { kind: 'inline', value: JSON.parse(canonical) as T };
    }
    const ref = await this.captureBytes(bytes, 'utf8', true);
    return { kind: 'artifact-json', ref };
  }

  private async captureBytes(
    bytes: Buffer, encoding: 'utf8' | 'binary', complete: boolean,
  ): Promise<ArtifactRef> {
    if (!Number.isSafeInteger(bytes.length) || bytes.length > MAX_CAPTURE_BYTES) {
      throw new Error(`artifact exceeds the ${MAX_CAPTURE_BYTES}-byte capture ceiling`);
    }
    const copy = Buffer.from(bytes);
    const artifact = sha256HexOf(copy);
    const parts: Source[] = [];
    let inBatch = 0;
    for (let offset = 0, index = 0; offset < copy.length; offset += CHUNK_BYTES, index += 1) {
      const chunk: ArtifactChunk = {
        artifact, index, base64: copy.subarray(offset, offset + CHUNK_BYTES).toString('base64'),
      };
      const envelope = this.callbacks.append('artifact/chunk', chunk);
      this.pending.push(envelope);
      parts.push({ seq: envelope.seq, hash: envelope.hash });
      inBatch += 1;
      // Bounded batches flush the journal/blob memory; they never re-enter gate.flush.
      if (inBatch === CHUNK_BATCH) {
        await this.callbacks.flush();
        inBatch = 0;
      }
    }
    const manifest: ArtifactManifest = {
      artifact, sha256: artifact, bytes: copy.length, encoding, complete, parts,
    };
    const end = this.callbacks.append('artifact/end', manifest);
    this.pending.push(end);
    await this.callbacks.flush();
    await this.verifyPending();
    const manifestSource: Source = { seq: end.seq, hash: end.hash };
    return { kind: 'c13-artifact', manifest: manifestSource, sha256: artifact, bytes: copy.length, encoding, complete };
  }

  /**
   * The durable barrier's verification step: for every pending event whose raw
   * journaled data is a claim-check `BlobRef`, refuse a flagged truncated prefix
   * before any read, then read the blob back and require the digest and byte
   * length to match. A missing blob (ENOENT) becomes `BlobIntegrityError`; any
   * other read failure keeps its own type rather than being called corruption.
   */
  private async verifyPending(): Promise<void> {
    const batch = this.pending;
    for (const envelope of batch) {
      if (!isBlobRef(envelope.data)) continue;
      const ref = envelope.data;
      assertBlobRefReadable(ref);
      let bytes: Uint8Array;
      try {
        bytes = await this.callbacks.readBlob(ref.blob);
      } catch (err) {
        // Only a missing blob (ENOENT) becomes an integrity error; EACCES/EIO
        // keep their own type so an environment failure is not called corruption.
        throwBlobReadError(ref, err);
      }
      assertBlobBytes(ref, Buffer.from(bytes));
    }
    this.pending = this.pending.slice(batch.length);
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * The one internal gate constructor. Exported for T1 unit tests and T2; never
 * re-exported from the public surface (it exposes no writer and no factory).
 * Requires the validator seam and the callback wiring to share one lookup
 * function by reference identity, and validates the scope before any append.
 */
export function createBoundaryGate(
  registry: BoundaryRegistry, scope: GateScope, callbacks: GateCallbacks,
): { readonly gate: BoundaryGate; readonly close: () => void } {
  if (scope.lookup !== callbacks.lookup) {
    throw new Error('GateScope.lookup must be reference-identical to GateCallbacks.lookup');
  }
  if (scope.phase === 'ready') {
    if (scope.turn !== null) throw new Error('ready scope requires turn: null');
  } else if (scope.phase === 'turn') {
    if (!Number.isSafeInteger(scope.turn) || (scope.turn as number) < 0) {
      throw new Error('turn scope requires a nonnegative safe-integer turn');
    }
  } else {
    throw new Error('gate scope has an unknown phase');
  }
  const gate = new Gate(registry, scope, callbacks);
  return { gate, close: () => { gate.close(); } };
}
