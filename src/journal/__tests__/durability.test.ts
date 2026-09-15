import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter, JournalPoisonedError, JournalClosedError } from '../writer.js';
import { JournalReader } from '../reader.js';
import { BlobStore } from '../blobs.js';

const KNOWN = new Set(['test/ping', 'test/big']);
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cell-spine-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

async function collectEvents() {
  const out = [];
  for await (const e of (await JournalReader.open(home, 'n1', KNOWN)).events()) out.push(e);
  return out;
}

/** Replaces FileHandle.prototype.write for the duration of `fn`. */
async function withFailingWrite<T>(fn: () => Promise<T>, failCount = 1): Promise<T> {
  const probe = await openFile(join(home, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as {
    write: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
  };
  await probe.close();
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

describe('durability spine', () => {
  it('a failed flush loses no event and corrupts no chain (retry semantics)', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await expect(withFailingWrite(() => w.flush(), 1)).rejects.toThrow('injected EIO');
    await w.flush();
    await w.close();
    const events = await collectEvents();
    expect(events.map((e) => e.seq)).toEqual([0]);
    expect(events.map((e) => e.data)).toEqual([{ n: 0 }]);
  });
  it('the same batch failing twice in a row poisons the writer', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await expect(withFailingWrite(() => w.flush(), 1)).rejects.toThrow('injected EIO');
    await expect(withFailingWrite(() => w.flush(), 1)).rejects.toThrow('injected EIO');
    expect(() => w.append('test/ping', { n: 1 })).toThrow(JournalPoisonedError);
    await expect(w.flush()).rejects.toThrow(JournalPoisonedError);
    await w.close().catch(() => {});
  });
  it('a write-behind failure surfaces on the next append', async () => {
    const seen: Error[] = [];
    const w = await JournalWriter.open(home, 'n1', {
      batchWindowMs: 5, onError: (e) => seen.push(e),
    });
    await withFailingWrite(async () => {
      w.append('test/ping', { n: 0 });
      await vi.waitFor(() => { expect(seen.length).toBeGreaterThan(0); });
    }, 1);
    expect(() => w.append('test/ping', { n: 1 })).toThrow('injected EIO');
    await w.close().catch(() => {});
  });
  it('mutating a payload after append cannot desync the hash from the bytes', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    const payload = { n: 0 };
    const e = w.append('test/ping', payload);
    payload.n = 999;
    await w.flush();
    await w.close();
    const events = await collectEvents();
    expect(events[0]!.data).toEqual({ n: 0 });
    expect(events[0]!.hash).toBe(e.hash);
  });
  it('waits for a blob whose append landed during the blob await', async () => {
    const realPut = BlobStore.prototype.put;
    let calls = 0;
    vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (
      this: BlobStore, content: Buffer,
    ) {
      calls += 1;
      if (calls === 2) await new Promise((r) => setTimeout(r, 40));
      return realPut.call(this, content);
    });
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    const e0 = w.append('test/big', { payload: 'a'.repeat(20000) });
    const flushing = w.flush();
    const e1 = w.append('test/big', { payload: 'b'.repeat(20000) });
    await flushing;
    await w.flush();
    await w.close();
    const store = new BlobStore(home);
    for (const e of [e0, e1]) {
      expect(await store.has((e.data as { blob: string }).blob)).toBe(true);
    }
  });
  it('refuses an append that races close() and still releases the lock', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    const closing = w.close();
    expect(() => w.append('test/ping', { n: 1 })).toThrow(JournalClosedError);
    await closing;
    const w2 = await JournalWriter.open(home, 'n1');
    await w2.close();
  });
  it('releases the lock even when close() flushes into a failure', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await expect(withFailingWrite(() => w.close(), 1)).rejects.toThrow('injected EIO');
    const w2 = await JournalWriter.open(home, 'n1');
    await w2.close();
  });
});
