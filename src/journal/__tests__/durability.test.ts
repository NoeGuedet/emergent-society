import { describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readlink, rm, open as openFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter, JournalPoisonedError, JournalClosedError } from '../writer.js';
import { BlobStore } from '../blobs.js';
import { JournalReader } from '../reader.js';
import { headPath, nodeDir } from '../layout.js';
import {
  BIG_PAYLOAD_CHARS, collectEvents, injectBlobPut, KNOWN_TYPES, logPath, useTempHome, withFailingWrite,
} from './helpers.js';

const home = useTempHome('cell-spine-');

/**
 * Makes every `FileHandle#sync` whose real path satisfies `predicate` fail with
 * an EIO, and returns a restore callback. The fd is resolved through `/proc`, so
 * the injection lands on the directory the kernel was actually asked to flush.
 */
async function failSyncsTo(
  predicate: (path: string) => boolean, message: string,
): Promise<() => void> {
  const probe = await openFile(join(home(), 'sync-probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const real = proto.sync;
  const spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: FileHandle) {
    if (predicate(await readlink(`/proc/self/fd/${this.fd}`))) {
      throw Object.assign(new Error(message), { code: 'EIO' });
    }
    return real.call(this);
  });
  return () => spy.mockRestore();
}

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

describe('durable directory creation', () => {
  it('opens under a home that does not exist yet, proving its chain', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'cell-spine-home-'));
    try {
      const missingHome = join(outer, 'cell');
      // The existing API accepts an absent home: it is created and proven, not
      // rejected by a new pre-existing-home precondition.
      const w = await JournalWriter.open(missingHome, 'n1', { batchWindowMs: 60_000 });
      w.append('test/ping', { n: 0 });
      await w.flush();
      await w.close();
      expect((await collectEvents(missingHome)).map((e) => e.seq)).toEqual([0]);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });
  it('never commits an event whose blob shard is not durable (parent fsync EIO)', async () => {
    const blobsDir = join(home(), 'blobs');
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    const e = w.append('test/big', { payload: 'a'.repeat(BIG_PAYLOAD_CHARS) });
    const blobHash = (e.data as { blob: string }).blob;
    const restore = await failSyncsTo((p) => p === blobsDir, 'injected parent fsync EIO');
    try {
      await expect(w.flush()).rejects.toThrow('injected parent fsync EIO');
    } finally {
      restore();
    }
    // The shard entry was never made durable, so the event referencing it must
    // not be committed: the log is still empty.
    expect((await readFile(logPath(home()))).length).toBe(0);
    expect(await collectEvents(home())).toEqual([]);
    // Once the parent can be fsynced again, the same batch commits for real.
    await w.flush();
    await w.close();
    expect(await new BlobStore(home()).has(blobHash)).toBe(true);
    expect((await collectEvents(home())).map((ev) => ev.seq)).toEqual([0]);
  });
});

describe('disposable head checkpoint', () => {
  it('keeps a durable batch when the head cannot be written (direct flush)', async () => {
    const failures: Error[] = [];
    const w = await JournalWriter.open(home(), 'n1', {
      batchWindowMs: 60_000, onError: (e) => failures.push(e),
    });
    w.append('test/ping', { n: 0 });
    // A directory occupies the head's path, so the atomic rename must fail.
    await mkdir(headPath(nodeDir(home(), 'n1')), { recursive: true });
    // The batch is already fsynced into the log, so the flush resolves and the
    // head failure is only a diagnostic — not a lost batch.
    await w.flush();
    expect(failures.length).toBeGreaterThan(0);
    expect((await collectEvents(home())).map((e) => e.seq)).toEqual([0]);
    // The writer is still usable: fixing the path lets the next flush rebuild it.
    await rm(headPath(nodeDir(home(), 'n1')), { recursive: true });
    w.append('test/ping', { n: 1 });
    await w.flush();
    await w.close();
    expect((await collectEvents(home())).map((e) => e.seq)).toEqual([0, 1]);
    const r = await JournalReader.open(home(), 'n1', { knownTypes: KNOWN_TYPES });
    expect((await r.head())?.count).toBe(2);
  });

  it('surfaces a head failure from the timer path without losing the durable batch', async () => {
    let signal!: () => void;
    const headFailed = new Promise<void>((resolve) => { signal = resolve; });
    const failures: Error[] = [];
    const w = await JournalWriter.open(home(), 'n1', {
      batchWindowMs: 5, onError: (e) => { failures.push(e); signal(); },
    });
    await mkdir(headPath(nodeDir(home(), 'n1')), { recursive: true });
    w.append('test/ping', { n: 0 });
    // Wait for the write-behind timer's callback rather than sleeping.
    await headFailed;
    expect(failures.length).toBeGreaterThan(0);
    expect((await collectEvents(home())).map((e) => e.seq)).toEqual([0]);
    await rm(headPath(nodeDir(home(), 'n1')), { recursive: true });
    w.append('test/ping', { n: 1 });
    await w.flush();
    await w.close();
    expect((await collectEvents(home())).map((e) => e.seq)).toEqual([0, 1]);
  });

  it('does not let a throwing onError callback masquerade as a lost batch', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let signal!: () => void;
      const headFailed = new Promise<void>((resolve) => { signal = resolve; });
      const w = await JournalWriter.open(home(), 'n1', {
        batchWindowMs: 5,
        onError: () => { signal(); throw new Error('head callback boom'); },
      });
      await mkdir(headPath(nodeDir(home(), 'n1')), { recursive: true });
      w.append('test/ping', { n: 0 });
      await headFailed;
      // Give any rejection escaping the callback a chance to surface.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      // The authoritative log still holds the batch the callback was reporting on.
      expect((await collectEvents(home())).map((e) => e.seq)).toEqual([0]);
      await rm(headPath(nodeDir(home(), 'n1')), { recursive: true });
      w.append('test/ping', { n: 1 });
      await w.flush();
      await w.close();
      expect((await collectEvents(home())).map((e) => e.seq)).toEqual([0, 1]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
