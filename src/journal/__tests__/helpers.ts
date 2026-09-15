import { afterEach, beforeEach, vi } from 'vitest';
import { appendFile, mkdtemp, rm, open as openFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from '../blobs.js';
import { canonicalizeJson } from '../canon.js';
import { encodeBatch, scanBatches } from '../framing.js';
import { journalPath, nodeDir } from '../layout.js';
import { JournalReader } from '../reader.js';
import type { EventEnvelope } from '../envelope.js';

/**
 * Shared scaffolding for the journal suite: temp-home lifecycle, log fixtures,
 * and the spies that simulate I/O failure. Each helper exists because at least
 * two suites needed the same byte-exact setup; anything used once stays local.
 */

// Named constants for fixtures, so a magic value is defined once and greppable.
export const EPOCH = 1789000000000;
export const FAKE_HASH = 'f'.repeat(64);
export const WRONG_HASH = 'a'.repeat(64);
export const KNOWN_TYPES = new Set(['test/ping', 'test/big']);
export const BIG_PAYLOAD_CHARS = 20000;

/**
 * Installs a temp home for the enclosing suite and removes it afterwards. The
 * returned getter reads the current path, so the value is fresh per test.
 */
export function useTempHome(prefix: string): () => string {
  let home = '';
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), prefix)); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });
  return () => home;
}

/** The canonical log path of a node inside `home`. */
export function logPath(home: string, node = 'n1'): string {
  return journalPath(nodeDir(home, node));
}

/** Collects every event the reader serves, optionally from a watermark. */
export async function collectEvents(
  home: string, known: ReadonlySet<string> = KNOWN_TYPES, node = 'n1', fromSeq = 0,
): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  const r = await JournalReader.open(home, node, { knownTypes: known });
  for await (const e of r.events(fromSeq)) out.push(e);
  return out;
}

/** Collects events, returning the error they raised instead of throwing. */
export async function collectFailure(
  r: JournalReader, fromSeq = 0,
): Promise<Error> {
  try {
    for await (const _ of r.events(fromSeq)) { /* consume */ }
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the reader to reject');
}

/** A fragment of a frame — what a half-written tail looks like on disk. */
export function tearFragment(bytes = 9): Buffer {
  return encodeBatch(['{"torn":true}']).subarray(0, bytes);
}

/** Appends a torn fragment to a node's log. */
export async function appendTear(home: string, bytes = 9): Promise<void> {
  await appendFile(logPath(home), tearFragment(bytes));
}

/** A self-consistent-looking but forged v0 envelope, for chain tampering tests. */
export function forgedEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 0, type: 'test/ping', seq: 1, time: 1,
    prev_hash: FAKE_HASH, hash: FAKE_HASH, data: {}, ...over,
  });
}

/** Rebuilds a log from its decoded lines, optionally rewriting one of them. */
export async function rewriteLog(
  path: string, mutate: (lines: string[]) => string[],
): Promise<void> {
  const { batches } = scanBatches(await readFile(path));
  const lines = batches.flatMap((b) => b.lines);
  await writeFile(path, encodeBatch(mutate(lines)));
}

/** A payload whose canonical form is exactly `bytes` UTF-8 bytes. */
export function payloadOfCanonicalBytes(bytes: number): { payload: string } {
  const framing = Buffer.byteLength(canonicalizeJson({ payload: '' }), 'utf8');
  return { payload: 'a'.repeat(bytes - framing) };
}

/** The shared prototype behind every `FileHandle`, for spying on fs primitives. */
export async function fileHandleProto(home: string): Promise<{
  write: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
  sync: () => Promise<void>;
}> {
  const probe = await openFile(join(home, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as {
    write: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
    sync: () => Promise<void>;
  };
  await probe.close();
  return proto;
}

/** Replaces `FileHandle.prototype.write` for the duration of `fn`. */
export async function withFailingWrite<T>(
  home: string, fn: () => Promise<T>, failCount = 1,
): Promise<T> {
  const proto = await fileHandleProto(home);
  const real = proto.write;
  let failures = failCount;
  const spy = vi.spyOn(proto, 'write').mockImplementation(async function (
    this: unknown, ...args: unknown[]
  ) {
    if (failures > 0) { failures -= 1; throw new Error('injected EIO'); }
    return real.apply(this, args);
  });
  try { return await fn(); } finally { spy.mockRestore(); }
}

/** Counts every `FileHandle#sync` call while `fn` runs. */
export async function countSyncs<T>(
  home: string, fn: () => Promise<T>,
): Promise<{ result: T; syncs: number }> {
  const proto = await fileHandleProto(home);
  const spy = vi.spyOn(proto, 'sync');
  try {
    const result = await fn();
    return { result, syncs: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Replaces `BlobStore.prototype.put`. `failAt` makes that call index (1-based)
 * reject once; `slowAt` delays it; `alwaysFail` rejects every call. The spy is
 * restored by `useTempHome`'s `afterEach`.
 */
export function injectBlobPut(opts: {
  failAt?: number;
  slowAt?: number;
  slowMs?: number;
  alwaysFail?: boolean;
  error?: string;
} = {}): void {
  const { failAt, slowAt, slowMs = 50, alwaysFail = false, error = 'injected blob write failure' } = opts;
  const real = BlobStore.prototype.put;
  let calls = 0;
  // `real` is captured before the spy replaces the method, so the patched
  // implementation can still do the actual write.
  vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (
    this: BlobStore, content: Buffer,
  ) {
    calls += 1;
    if (alwaysFail || calls === failAt) throw new Error(error);
    if (calls === slowAt) await new Promise((r) => setTimeout(r, slowMs));
    return real.call(this, content);
  });
}
