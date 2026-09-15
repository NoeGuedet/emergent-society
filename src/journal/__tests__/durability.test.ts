import { describe, it, expect, vi } from 'vitest';
import { JournalWriter, JournalPoisonedError, JournalClosedError } from '../writer.js';
import { BlobStore } from '../blobs.js';
import {
  BIG_PAYLOAD_CHARS, collectEvents, injectBlobPut, KNOWN_TYPES, useTempHome, withFailingWrite,
} from './helpers.js';

const home = useTempHome('cell-spine-');

describe('durability spine', () => {
  it('a failed flush loses no event and corrupts no chain (retry semantics)', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await expect(withFailingWrite(home(), () => w.flush(), 1)).rejects.toThrow('injected EIO');
    await w.flush();
    await w.close();
    const events = await collectEvents(home(), KNOWN_TYPES);
    expect(events.map((e) => e.seq)).toEqual([0]);
    expect(events.map((e) => e.data)).toEqual([{ n: 0 }]);
  });
  it('the same batch failing twice in a row poisons the writer', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await expect(withFailingWrite(home(), () => w.flush(), 1)).rejects.toThrow('injected EIO');
    await expect(withFailingWrite(home(), () => w.flush(), 1)).rejects.toThrow('injected EIO');
    expect(() => w.append('test/ping', { n: 1 })).toThrow(JournalPoisonedError);
    await expect(w.flush()).rejects.toThrow(JournalPoisonedError);
    await w.close().catch(() => {});
  });
  it('a write-behind failure surfaces on the next append', async () => {
    const seen: Error[] = [];
    const w = await JournalWriter.open(home(), 'n1', {
      batchWindowMs: 5, onError: (e) => seen.push(e),
    });
    await withFailingWrite(home(), async () => {
      w.append('test/ping', { n: 0 });
      await vi.waitFor(() => { expect(seen.length).toBeGreaterThan(0); });
    }, 1);
    expect(() => w.append('test/ping', { n: 1 })).toThrow('injected EIO');
    await w.close().catch(() => {});
  });
  it('mutating a payload after append cannot desync the hash from the bytes', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    const payload = { n: 0 };
    const e = w.append('test/ping', payload);
    payload.n = 999;
    await w.flush();
    await w.close();
    const events = await collectEvents(home(), KNOWN_TYPES);
    expect(events[0]!.data).toEqual({ n: 0 });
    expect(events[0]!.hash).toBe(e.hash);
  });
  it('waits for a blob whose append landed during the blob await', async () => {
    injectBlobPut({ slowAt: 2, slowMs: 40 });
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    const e0 = w.append('test/big', { payload: 'a'.repeat(BIG_PAYLOAD_CHARS) });
    const flushing = w.flush();
    const e1 = w.append('test/big', { payload: 'b'.repeat(BIG_PAYLOAD_CHARS) });
    await flushing;
    await w.flush();
    await w.close();
    const store = new BlobStore(home());
    for (const e of [e0, e1]) {
      expect(await store.has((e.data as { blob: string }).blob)).toBe(true);
    }
  });
  it('refuses an append that races close() and still releases the lock', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    const closing = w.close();
    expect(() => w.append('test/ping', { n: 1 })).toThrow(JournalClosedError);
    await closing;
    const w2 = await JournalWriter.open(home(), 'n1');
    await w2.close();
  });
  it('releases the lock even when close() flushes into a failure', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await expect(withFailingWrite(home(), () => w.close(), 1)).rejects.toThrow('injected EIO');
    const w2 = await JournalWriter.open(home(), 'n1');
    await w2.close();
  });
});
