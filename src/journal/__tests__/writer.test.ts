import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter, SessionAlreadyOwnedError, JournalClosedError, TornTailError } from '../writer.js';
import { repair } from '../reader.js';
import { encodeBatch } from '../framing.js';
import { verifyEvent } from '../envelope.js';
import { CLAIM_CHECK_THRESHOLD } from '../blobs.js';

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
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.flush();
    const size = (await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length;
    expect(size).toBeGreaterThan(0);
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
});

describe('JournalWriter durability and ownership', () => {
  it('does not persist a batch that has not reached the flush barrier', async () => {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    // No flush yet: the log file exists (created at open) but holds no events.
    const size = (await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length;
    expect(size).toBe(0);
    await w.flush();
    expect((await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length).toBeGreaterThan(0);
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
    expect((await readFile(join(home, 'nodes/n1/journal.v0.jsonl.zstd'))).length).toBeGreaterThan(0);
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
});