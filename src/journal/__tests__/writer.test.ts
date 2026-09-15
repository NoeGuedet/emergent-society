import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter, SessionAlreadyOwnedError, JournalClosedError, TornTailError } from '../writer.js';
import { repair, ChainBreakError, JournalReader } from '../reader.js';
import { encodeBatch } from '../framing.js';
import { verifyEvent, makeEvent, envelopeJson, GENESIS_HASH } from '../envelope.js';
import { CLAIM_CHECK_THRESHOLD, MAX_BLOB_BYTES, BlobStore } from '../blobs.js';
import { canonicalizeJson } from '../canon.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cell-writer-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('JournalWriter', () => {
  it('appends chained, verifiable events with contiguous seq', async () => {
    let t = 1789000000000;
    const w = await JournalWriter.open(home, 'n1', { now: () => t++ });
    const e0 = w.append('test/ping', { n: 0 });
    const e1 = w.append('test/ping', { n: 1 });
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(e1.prev_hash).toBe(e0.hash);
    expect(verifyEvent(e0)).toBe(true);
    expect(verifyEvent(e1)).toBe(true);
    await w.close();
  });
  it('persists events durably after flush', async () => {
    const now = 1789000000000;
    const w = await JournalWriter.open(home, 'n1', { now: () => now });
    w.append('test/ping', { n: 0 });
    await w.flush();
    // One event, one frame: the file is exactly the frame for that envelope.
    const expected = encodeBatch([canonicalizeJson(envelopeJson(makeEvent({
      type: 'test/ping', data: { n: 0 }, seq: 0, time: now, prevHash: GENESIS_HASH,
    })))]);
    const onDisk = await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'));
    expect(onDisk.equals(expected)).toBe(true);
    await w.close();
  });
  it('rejects a second writer on the same journal', async () => {
    const w = await JournalWriter.open(home, 'n1');
    await expect(JournalWriter.open(home, 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
    await w.close();
  });
  it('resumes seq and prev_hash after close and reopen', async () => {
    let w = await JournalWriter.open(home, 'n1');
    const e0 = w.append('test/ping', { n: 0 });
    await w.close();
    w = await JournalWriter.open(home, 'n1');
    const e1 = w.append('test/ping', { n: 1 });
    expect(e1.seq).toBe(1);
    expect(e1.prev_hash).toBe(e0.hash);
    await w.close();
  });
  it('claim-checks oversized payloads into the blob store', async () => {
    const w = await JournalWriter.open(home, 'n1');
    const e = w.append('test/big', { payload: 'a'.repeat(CLAIM_CHECK_THRESHOLD) });
    const data = e.data as { blob?: string; size?: number };
    expect(typeof data.blob).toBe('string');
    expect(data.size).toBeGreaterThanOrEqual(CLAIM_CHECK_THRESHOLD);
    await w.close();
  });
  it('flips the claim-check branch exactly at the canonical byte threshold', async () => {
    // The canonical form is `{"payload":"<s>"}`, 14 bytes of framing.
    const framingBytes = Buffer.byteLength(canonicalizeJson({ payload: '' }), 'utf8');
    for (const [delta, claimed] of [[-1, false], [0, true], [1, true]] as const) {
      const payload = 'a'.repeat(CLAIM_CHECK_THRESHOLD - framingBytes + delta);
      const w = await JournalWriter.open(home, `b${delta}`, { batchWindowMs: 60_000 });
      const e = w.append('test/big', { payload });
      expect(typeof (e.data as { blob?: unknown }).blob === 'string').toBe(claimed);
      await w.close();
    }
  });
  it('measures the threshold and the reported size in UTF-8 bytes, not code units', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    // 6 000 code units but 18 000 UTF-8 bytes: over the 16 384-byte threshold.
    const payload = '€'.repeat(6000);
    const bytes = Buffer.byteLength(canonicalizeJson({ payload }), 'utf8');
    expect(bytes).toBeGreaterThan(CLAIM_CHECK_THRESHOLD);
    const e = w.append('test/big', { payload });
    const data = e.data as { blob: string; size: number };
    await w.flush();
    await w.close();
    const blob = await new BlobStore(home).get(data.blob);
    expect(data.size).toBe(bytes);
    expect(blob.length).toBe(bytes);
  });
  it('marks a payload past MAX_BLOB_BYTES truncated, with the original size', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    const payload = 'a'.repeat(MAX_BLOB_BYTES + 10);
    const e = w.append('test/big', { payload });
    const data = e.data as { blob: string; size: number; truncated?: boolean };
    const expectedSize = Buffer.byteLength(canonicalizeJson({ payload }), 'utf8');
    expect(data.truncated).toBe(true);
    expect(data.size).toBe(expectedSize);
    await w.flush();
    await w.close();
    expect((await new BlobStore(home).get(data.blob)).length).toBe(MAX_BLOB_BYTES);
  });
  it('does not mark a payload between the threshold and MAX_BLOB_BYTES truncated', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    const e = w.append('test/big', { payload: 'a'.repeat(CLAIM_CHECK_THRESHOLD * 2) });
    const data = e.data as { blob: string; size: number; truncated?: boolean };
    expect(data.truncated).toBeUndefined();
    await w.close();
  });
});

describe('JournalWriter durability and ownership', () => {
  it('does not persist a batch that has not reached the flush barrier', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    // No flush yet: the log file exists (created at open) but holds no events.
    const size = (await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length;
    expect(size).toBe(0);
    await w.flush();
    const flushed = (await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length;
    expect(flushed).toBeGreaterThan(0);
    await w.close();
  });
  it('writes the batch when the write-behind window elapses', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 10 });
    w.append('test/ping', { n: 0 });
    await vi.waitFor(async () => {
      const size = (await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length;
      expect(size).toBeGreaterThan(0);
    });
    await w.close();
  });
  it('is idempotent: a second flush writes nothing more', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.flush();
    const size = (await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length;
    await w.flush();
    expect((await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length).toBe(size);
    await w.close();
  });
  it('serializes concurrent flushes without duplicating events', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    await Promise.all([w.flush(), w.flush(), w.flush()]);
    const lines = (await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd')));
    expect(lines.length).toBeGreaterThan(0);
    // Reopen and count: duplicated events would break seq contiguity.
    await w.close();
    const w2 = await JournalWriter.open(home, 'n1');
    const e = w2.append('test/ping', { n: 2 });
    expect(e.seq).toBe(2);
    await w2.close();
  });
  it('keeps the pending batch on disk when close flushes it', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await w.close();
    const events = [];
    for await (const e of (await JournalReader.open(home, 'n1', new Set(['test/ping']))).events()) {
      events.push(e);
    }
    expect(events.map((e) => e.seq)).toEqual([0]);
  });
  it('rejects appends after close', async () => {
    const w = await JournalWriter.open(home, 'n1');
    await w.close();
    expect(() => w.append('test/ping', { n: 0 })).toThrow(JournalClosedError);
  });
  it('refuses to open over a torn tail instead of burying it', async () => {
    const { appendFile } = await import('node:fs/promises');
    let w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await appendFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'), encodeBatch(['x']).subarray(0, 9));
    await expect(JournalWriter.open(home, 'n1')).rejects.toThrow(TornTailError);
    // The failed open releases its lock, so repair() + reopen recovers.
    expect(await repair(home, 'n1')).toEqual({ tornBytes: 9 });
    w = await JournalWriter.open(home, 'n1');
    expect(w.append('test/ping', { n: 1 }).seq).toBe(1);
    await w.close();
  });
  it('takes over a lock whose owner is dead', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(home, 'nodes/n1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'journal.v0.lock'), '999999999');
    const w = await JournalWriter.open(home, 'n1');
    await w.close();
  });
  it('refuses to resume onto a forged but decodable tail', async () => {
    const { writeFile } = await import('node:fs/promises');
    let w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const path = join(home, 'nodes/n1/journal.v0.jsonl.zstd');
    const { readFile } = await import('node:fs/promises');
    const { scanBatches } = await import('../framing.js');
    const { batches } = scanBatches(await readFile(path));
    const lines = batches.flatMap((b) => b.lines);
    const forged = JSON.stringify({
      v: 0, type: 'test/ping', seq: 1, time: 1, prev_hash: 'f'.repeat(64),
      hash: 'f'.repeat(64), data: {},
    });
    await writeFile(path, encodeBatch([...lines, forged]));
    await expect(JournalWriter.open(home, 'n1')).rejects.toThrow(ChainBreakError);
  });
  it.skipIf(process.getuid?.() === 0)(
    'refuses to resume when the log is unreadable instead of forking from genesis',
    async () => {
      const { chmod } = await import('node:fs/promises');
      const w = await JournalWriter.open(home, 'n1');
      w.append('test/ping', { n: 0 });
      await w.close();
      // Write-only: the append handle still opens, so the failure is isolated
      // to `resume`'s read. (Skipped as root, which bypasses permissions.)
      await chmod(join(home, 'nodes/n1/journal.v0.jsonl.zstd'), 0o200);
      try {
        await expect(JournalWriter.open(home, 'n1')).rejects.toThrow();
      } finally {
        await chmod(join(home, 'nodes/n1/journal.v0.jsonl.zstd'), 0o600);
      }
    },
  );
  it('refuses a lock held by the current live process', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(home, 'nodes/n1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'journal.v0.lock'), JSON.stringify({
      pid: process.pid, startedAt: await currentProcessStartTime(),
    }));
    await expect(JournalWriter.open(home, 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
  });
  it('takes over a lock whose PID was recycled by an unrelated process', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(home, 'nodes/n1');
    await mkdir(dir, { recursive: true });
    // The PID is alive (ours) but the recorded start time cannot match, so the
    // lock belongs to a process that is gone.
    await writeFile(join(dir, 'journal.v0.lock'), JSON.stringify({
      pid: process.pid, startedAt: 1,
    }));
    const w = await JournalWriter.open(home, 'n1');
    await w.close();
  });
  it('takes over a lock whose contents are garbage', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(home, 'nodes/n1');
    await mkdir(dir, { recursive: true });
    for (const garbage of ['', 'abc', '0', '-1', '9999999999999', '{"pid":']) {
      await writeFile(join(dir, 'journal.v0.lock'), garbage);
      const w = await JournalWriter.open(home, 'n1');
      await w.close();
    }
  });
});

async function currentProcessStartTime(): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const stat = await readFile('/proc/self/stat', 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}