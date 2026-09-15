import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, open as openFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter, JournalClosedError, JournalPoisonedError } from '../writer.js';
import { JournalReader, repair } from '../reader.js';
import { BlobStore } from '../blobs.js';
import { encodeBatch, scanBatches, CorruptFrameError } from '../framing.js';
import { headPath, journalPath, nodeDir } from '../layout.js';

const KNOWN = new Set(['test/ping', 'test/big']);
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cell-gaps-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

function logPath(node = 'n1'): string {
  return journalPath(nodeDir(home, node));
}

async function collectEvents(node = 'n1') {
  const out = [];
  for await (const e of (await JournalReader.open(home, node, { knownTypes: KNOWN })).events()) out.push(e);
  return out;
}

/** Replaces `BlobStore.prototype.put` so that the Nth call rejects once. */
function failPutOnce(failIndex: number): BlobStore {
  const real = BlobStore.prototype.put;
  let calls = 0;
  vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (
    this: BlobStore, content: Buffer,
  ) {
    calls += 1;
    if (calls === failIndex) throw new Error('injected blob write failure');
    return real.call(this, content);
  });
  return new BlobStore(home);
}

describe('blob durability gaps', () => {
  it('never commits an event whose blob was not written (failed put is retried)', async () => {
    const store = failPutOnce(1);
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    const e = w.append('test/big', { payload: 'a'.repeat(20000) });
    const blobHash = (e.data as { blob: string }).blob;
    await expect(w.flush()).rejects.toThrow('injected blob write failure');
    // The event was not committed: the log is still empty.
    expect((await readFile(logPath())).length).toBe(0);
    // The next flush retries the blob, then commits the event with it durable.
    await w.flush();
    await w.close();
    expect(await store.has(blobHash)).toBe(true);
    const events = await collectEvents();
    expect(events.map((ev) => (ev.data as { blob: string }).blob)).toEqual([blobHash]);
  });
  it('deduplicates a blob referenced by several events in one burst', async () => {
    const real = BlobStore.prototype.put;
    const spy = vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (
      this: BlobStore, content: Buffer,
    ) {
      return real.call(this, content);
    });
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    const payload = 'b'.repeat(20000);
    w.append('test/big', { payload });
    w.append('test/big', { payload });
    await w.flush();
    await w.close();
    expect(spy.mock.calls.length).toBe(1);
  });
  it('caps concurrent blob writes', async () => {
    const real = BlobStore.prototype.put;
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (
      this: BlobStore, content: Buffer,
    ) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return real.call(this, content);
    });
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    for (let i = 0; i < 12; i++) w.append('test/big', { payload: String(i).repeat(20000) });
    await w.flush();
    await w.close();
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
  it('removes its temporary file when a blob write fails', async () => {
    const real = BlobStore.prototype.put;
    vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (
      this: BlobStore, content: Buffer,
    ) {
      // Fail after the tmp file has been created.
      const hash = (await import('node:crypto')).createHash('sha256').update(content).digest('hex');
      const dir = join(home, 'blobs', hash.slice(0, 2));
      const { mkdir, open } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      const handle = await open(join(dir, `${hash}.tmp-probe`), 'wx');
      await handle.close();
      return real.call(this, content).then(() => { throw new Error('injected after write'); });
    });
    const store = new BlobStore(home);
    await expect(store.put(Buffer.from('x'))).rejects.toThrow('injected after write');
    const leaked = (await readdir(join(home, 'blobs/00'), { recursive: true }).catch(() => []))
      .filter((name) => String(name).endsWith('.tmp'));
    expect(leaked).toEqual([]);
  });
});

describe('length-prefix corruption', () => {
  it('treats a corrupted prefix mid-file as corruption, not a torn tail', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const w2 = await JournalWriter.open(home, 'n1');
    w2.append('test/ping', { n: 1 });
    await w2.close();
    const w3 = await JournalWriter.open(home, 'n1');
    w3.append('test/ping', { n: 2 });
    await w3.close();

    const raw = await readFile(logPath());
    const { batches } = scanBatches(raw);
    expect(batches).toHaveLength(3);
    // Corrupt the second frame's length prefix into an overrun: the payload
    // behind it is intact, so this is prefix corruption, not a torn tail.
    const second = batches[1]!;
    const corrupt = Buffer.from(raw);
    corrupt.writeUInt32LE(0xfffffff0, second.offset);
    let caught: unknown;
    try { scanBatches(corrupt); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(CorruptFrameError);
    expect((caught as CorruptFrameError).offset).toBe(second.offset);
  });
  it('repairs a genuinely half-written trailing frame', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const raw = await readFile(logPath());
    // A real partial write: a whole second frame cut in half.
    const half = encodeBatch(['{"cut":true}']).subarray(0, 9);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(logPath(), half);
    const { tornBytes } = await repair(home, 'n1');
    expect(tornBytes).toBe(9);
    expect((await readFile(logPath())).length).toBe(raw.length);
    const events = await collectEvents();
    expect(events).toHaveLength(1);
  });
  it('refuses to repair a corrupted prefix and deletes nothing', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const w2 = await JournalWriter.open(home, 'n1');
    w2.append('test/ping', { n: 1 });
    await w2.flush();
    await w2.close();
    const raw = await readFile(logPath());
    const { batches } = scanBatches(raw);
    const corrupt = Buffer.from(raw);
    corrupt.writeUInt32LE(0xfffffff0, batches[1]!.offset);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(logPath(), corrupt);
    await expect(repair(home, 'n1')).rejects.toThrow(CorruptFrameError);
    expect((await readFile(logPath())).length).toBe(corrupt.length);
  });
  it('still reports a frame whose prefix announces more than remains as torn', async () => {
    const { batches, tornBytes } = scanBatches(Buffer.concat([
      encodeBatch(['ok']), encodeBatch(['cut']).subarray(0, 9),
    ]));
    expect(batches.map((b) => b.lines)).toEqual([['ok']]);
    expect(tornBytes).toBe(9);
  });
});

describe('writer lifecycle guards', () => {
  it('rejects (does not throw synchronously) when flush() is called after close()', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    // Total in promise style: the guard is a rejection, never a sync throw.
    let threw = false;
    let promise: Promise<void>;
    try {
      promise = w.flush();
    } catch {
      threw = true;
      promise = Promise.resolve();
    }
    expect(threw).toBe(false);
    await expect(promise!).rejects.toThrow(JournalClosedError);
  });
  it('does not raise an uncaught exception when a stale timer fires after close()', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    const realPut = BlobStore.prototype.put;
    try {
      // The first blob write is slow, so the burst is still draining while a
      // second append arms a fresh timer and close() sets `closed`.
      let slow = true;
      vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (
        this: BlobStore, content: Buffer,
      ) {
        if (slow) { slow = false; await new Promise((r) => setTimeout(r, 120)); }
        return realPut.call(this, content);
      });
      const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 20 });
      w.append('test/big', { payload: 'a'.repeat(20000) });
      const flushing = w.flush();
      // Let flushOnce clear the first timer and start awaiting the slow blob.
      await new Promise((r) => setTimeout(r, 5));
      // A second append arms a fresh window whose timer outlives close().
      w.append('test/big', { payload: 'b'.repeat(20000) });
      const closing = w.close();
      // Wait past the batch window for the stale timer to fire.
      await new Promise((r) => setTimeout(r, 60));
      await flushing.catch(() => {});
      await closing.catch(() => {});
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      vi.restoreAllMocks();
    }
  });
  it('poisons the writer when a blob write keeps failing', async () => {
    const real = BlobStore.prototype.put;
    vi.spyOn(BlobStore.prototype, 'put').mockImplementation(async function (
      this: BlobStore, _content: Buffer,
    ) {
      void real;
      throw new Error('blob store is permanently unavailable');
    });
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/big', { payload: 'a'.repeat(20000) });
    await expect(w.flush()).rejects.toThrow('blob store is permanently unavailable');
    await expect(w.flush()).rejects.toThrow('blob store is permanently unavailable');
    expect(() => w.append('test/ping', { n: 1 })).toThrow(JournalPoisonedError);
    await expect(w.flush()).rejects.toThrow(JournalPoisonedError);
    await w.close().catch(() => {});
  });
  it.skipIf(process.getuid?.() === 0)('poisons the writer when the rollback truncate fails', async () => {
    const { chmod } = await import('node:fs/promises');
    const probe = await openFile(join(home, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe) as {
      write: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
    };
    await probe.close();
    const writeSpy = vi.spyOn(proto, 'write').mockImplementation(async function (
      this: unknown, ..._args: unknown[]
    ) {
      throw new Error('injected EIO');
    });
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    // The file handle keeps its write permission, but `truncate` re-resolves
    // the path, so removing write permission makes only the rollback fail.
    await chmod(logPath(), 0o400);
    await expect(w.flush()).rejects.toThrow();
    await chmod(logPath(), 0o600);
    writeSpy.mockRestore();
    expect(() => w.append('test/ping', { n: 1 })).toThrow(JournalPoisonedError);
    await w.close().catch(() => {});
  });
});

describe('head checkpoint tmp files', () => {
  it('leaves no tmp file behind when the head rename fails', async () => {
    const { mkdir } = await import('node:fs/promises');
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    // A directory occupies the head's path, so the atomic rename must fail.
    await mkdir(headPath(nodeDir(home, 'n1')), { recursive: true });
    await expect(w.flush()).rejects.toThrow();
    const leaked = (await readdir(nodeDir(home, 'n1'))).filter((n) => n.endsWith('.tmp'));
    expect(leaked).toEqual([]);
    await w.close().catch(() => {});
  });
});
