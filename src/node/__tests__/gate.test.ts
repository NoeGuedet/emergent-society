import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  BlobIntegrityError, BlobStore, JournalWriter, MAX_BLOB_BYTES, TruncatedBlobError,
  isBlobRef, isCorruption, isRetryable,
} from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { useTempHome } from '../../journal/__tests__/helpers.js';
import { createBoundaryRegistry } from '../../context/events.js';
import { defaultAgentConfig } from '../../context/config.js';
import { toJson } from '../../context/artifacts.js';
import type { Source } from '../../context/contracts.js';
import { createBoundaryGate, GateClosedError } from '../gate.js';
import type {
  BoundaryRegistry, GateCallbacks, GateScope,
} from '../gate.js';

const home = useTempHome('c13-gate-');

interface Harness {
  readonly writer: JournalWriter;
  readonly receipts: Map<string, EventEnvelope>;
  readonly scope: GateScope;
  readonly callbacks: GateCallbacks;
  readonly created: ReturnType<typeof createBoundaryGate>;
  readonly controller: AbortController;
}

async function harness(
  phase: 'ready' | 'turn',
  turn: number | null,
  overrides: {
    readBlob?: GateCallbacks['readBlob'];
    registry?: BoundaryRegistry;
    append?: GateCallbacks['append'];
  } = {},
): Promise<Harness> {
  const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
  const controller = new AbortController();
  const receipts = new Map<string, EventEnvelope>();
  const record = (e: EventEnvelope): EventEnvelope => {
    receipts.set(`${e.seq}:${e.hash}`, e);
    return e;
  };
  const lookup = (s: Source): EventEnvelope | null => receipts.get(`${s.seq}:${s.hash}`) ?? null;
  const callbacks: GateCallbacks = {
    append: overrides.append ?? ((type, data) => record(writer.append(type, data as never))),
    flush: () => writer.flush(),
    lookup,
    readBlob: overrides.readBlob ?? ((hash: string) => new BlobStore(home()).get(hash)),
    now: () => 1,
  };
  const scope: GateScope = { phase, turn, signal: controller.signal, lookup };
  const created = createBoundaryGate(overrides.registry ?? createBoundaryRegistry(), scope, callbacks);
  return { writer, receipts, scope, callbacks, created, controller };
}

describe('createBoundaryGate', () => {
  it('rejects a scope whose lookup is not reference-identical to callbacks.lookup', async () => {
    const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
    const append = vi.fn((type: string, data: JsonValue): EventEnvelope =>
      writer.append(type, data as never));
    const lookupA = (): EventEnvelope | null => null;
    const lookupB = (): EventEnvelope | null => null;
    const scope: GateScope = {
      phase: 'ready', turn: null, signal: new AbortController().signal, lookup: lookupA,
    };
    const callbacks: GateCallbacks = {
      append, flush: () => writer.flush(), lookup: lookupB,
      readBlob: () => Promise.resolve(new Uint8Array()), now: () => 1,
    };
    expect(() => createBoundaryGate(createBoundaryRegistry(), scope, callbacks)).toThrow();
    expect(append).not.toHaveBeenCalled();
    await writer.close();
  });

  it('exposes the scope signal and rejects an invalid scope', async () => {
    const h = await harness('turn', 0);
    try {
      expect(h.created.gate.signal).toBe(h.scope.signal);
      const writer = h.writer;
      const lookup = h.scope.lookup;
      const bad = (scope: GateScope): void => {
        createBoundaryGate(createBoundaryRegistry(), scope, {
          append: (t, d) => writer.append(t, d as never),
          flush: () => writer.flush(), lookup, readBlob: () => Promise.resolve(new Uint8Array()),
          now: () => 1,
        });
      };
      expect(() => bad({ phase: 'ready', turn: 0, signal: h.scope.signal, lookup })).toThrow();
      expect(() => bad({ phase: 'turn', turn: null, signal: h.scope.signal, lookup })).toThrow();
      expect(() => bad({ phase: 'turn', turn: -1, signal: h.scope.signal, lookup })).toThrow();
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });
});

describe('BoundaryGate.append', () => {
  it('rejects an unknown or Node lifecycle event type before the writer', async () => {
    const h = await harness('turn', 0);
    try {
      const spy = vi.spyOn(h.writer, 'append');
      expect(() => h.created.gate.append('turn/end' as never, {} as never)).toThrow();
      expect(() => h.created.gate.append('node/boot' as never, {} as never)).toThrow();
      expect(() => h.created.gate.append('not/a/type' as never, {} as never)).toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });

  it('validates payload shape before the writer', async () => {
    const h = await harness('turn', 0);
    try {
      const spy = vi.spyOn(h.writer, 'append');
      expect(() => h.created.gate.append('request/wire', {
        id: { turn: 0, ordinal: 0 }, attempt: 0, body: { bad: true },
      } as never)).toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });

  it('rejects a boundary payload root that looks like a journal BlobRef', async () => {
    const permissive: BoundaryRegistry = {
      'artifact/chunk': (data: unknown): JsonValue => toJson(data),
    } as unknown as BoundaryRegistry;
    const h = await harness('turn', 0, { registry: permissive });
    try {
      const spy = vi.spyOn(h.writer, 'append');
      expect(() => h.created.gate.append(
        'artifact/chunk' as never,
        { blob: 'a'.repeat(64), size: 5 } as never,
      )).toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });

  it('enforces turn scope on a turn-scoped payload', async () => {
    const h = await harness('turn', 0);
    try {
      expect(() => h.created.gate.append('world/perception', {
        turn: 1, range: { from: null, to: null },
        value: { kind: 'inline', value: { uid: 'n1' } },
      } as never)).toThrow();
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });

  it('revokes every method after close', async () => {
    const h = await harness('ready', null);
    h.created.close();
    try {
      expect(() => h.created.gate.append('system/message', {} as never)).toThrow(GateClosedError);
      await expect(h.created.gate.flush()).rejects.toThrow(GateClosedError);
      await expect(h.created.gate.capture(new Uint8Array(), 'utf8')).rejects.toThrow(GateClosedError);
      await expect(h.created.gate.store({ a: 1 })).rejects.toThrow(GateClosedError);
    } finally {
      await h.writer.close();
    }
  });
});

describe('BoundaryGate.flush durable barrier', () => {
  it('verifies every pending claim-check blob, not only capture/store refs', async () => {
    const readBlob = vi.fn((hash: string) => new BlobStore(home()).get(hash));
    const h = await harness('ready', null, { readBlob });
    try {
      const config = { ...defaultAgentConfig(), charter: 'c'.repeat(100 * 1024) };
      const source = h.created.gate.append('system/message', {
        version: 1, value: { kind: 'inline', value: config },
      });
      const env = h.receipts.get(`${source.seq}:${source.hash}`);
      expect(env && isBlobRef(env.data)).toBe(true);
      const ref = env?.data as { blob: string };
      await h.created.gate.flush();
      expect(readBlob).toHaveBeenCalledWith(ref.blob);
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });

  it('throws BlobIntegrityError when a claim-check blob is missing', async () => {
    const h = await harness('ready', null, {
      readBlob: () => Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })),
    });
    try {
      const config = { ...defaultAgentConfig(), charter: 'c'.repeat(100 * 1024) };
      h.created.gate.append('system/message', {
        version: 1, value: { kind: 'inline', value: config },
      });
      await expect(h.created.gate.flush()).rejects.toThrow();
      await expect(h.created.gate.flush()).rejects.toMatchObject({ name: 'BlobIntegrityError' });
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });

  it('rethrows a non-ENOENT blob read failure as a retryable environment error', async () => {
    // EACCES and EIO are environment failures: they must keep their own type and
    // must not be reclassified as corruption just because they cross the barrier.
    for (const code of ['EACCES', 'EIO']) {
      const h = await harness('ready', null, {
        readBlob: () => Promise.reject(Object.assign(new Error(`injected ${code}`), { code })),
      });
      try {
        const config = { ...defaultAgentConfig(), charter: 'c'.repeat(100 * 1024) };
        h.created.gate.append('system/message', {
          version: 1, value: { kind: 'inline', value: config },
        });
        const err = await h.created.gate.flush().catch((e: unknown) => e);
        expect(err).not.toBeInstanceOf(BlobIntegrityError);
        expect(isCorruption(err)).toBe(false);
        expect(isRetryable(err)).toBe(true);
        expect((err as { code?: string }).code).toBe(code);
      } finally {
        h.created.close();
        await h.writer.close();
      }
    }
  });

  it('rejects a flagged truncated reference before any effect, even if digest and size match', async () => {
    // The gate's preflight refuses a BlobRef root and the writer never flags at
    // or below the ceiling, so the staged append stands in for the one path that
    // can: a direct writer's receipt. The blob is written for real, so its digest
    // and byte length match the reference exactly and only the flag can reject.
    const body = Buffer.alloc(MAX_BLOB_BYTES, 0x61);
    const blob = await new BlobStore(home()).put(body);
    const forged: EventEnvelope = {
      v: 0, type: 'system/message', seq: 0, time: 1, prev_hash: '0'.repeat(64),
      hash: 'a'.repeat(64),
      data: { blob, size: body.length, truncated: true },
    };
    const h = await harness('ready', null, { append: () => forged });
    try {
      h.created.gate.append('system/message', {
        version: 1, value: { kind: 'inline', value: defaultAgentConfig() },
      } as never);
      await expect(h.created.gate.flush()).rejects.toThrow(TruncatedBlobError);
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });

  it('does not deadlock on a chunked capture that exceeds a batch', async () => {
    const h = await harness('turn', 0);
    try {
      const input = Buffer.alloc(1_500_000, 0x41);
      const ref = await h.created.gate.capture(input, 'binary');
      expect(ref.bytes).toBe(input.length);
      await h.created.gate.flush();
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });

  it('refuses a capture beyond the 32 MiB ingest ceiling', async () => {
    const h = await harness('turn', 0);
    try {
      const tooBig = Buffer.alloc(32 * 1024 * 1024 + 1);
      await expect(h.created.gate.capture(tooBig, 'binary')).rejects.toThrow();
    } finally {
      h.created.close();
      await h.writer.close();
    }
  });
});
