import { describe, it, expect, vi } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { JournalWriter, SessionAlreadyOwnedError, JournalClosedError, TornTailError } from '../writer.js';
import { repair, JournalReader } from '../reader.js';
import { ChainBreakError } from '../verify.js';
import { encodeBatch } from '../framing.js';
import { verifyEvent, makeEvent, eventLine, GENESIS_HASH } from '../envelope.js';
import {
  CLAIM_CHECK_THRESHOLD, MAX_BLOB_BYTES, BlobStore, ReservedBlobRefError, isBlobRef,
} from '../blobs.js';
import { canonicalizeJson, NonCanonicalizableError } from '../canon.js';
import { headPath, journalPath, lockPath, nodeDir, ownerPath } from '../layout.js';
import {
  appendTear, BIG_PAYLOAD_CHARS, collectEvents, EPOCH, forgedEnvelope, logPath, rewriteLog,
  useTempHome, withFailingWrite,
} from './helpers.js';

const home = useTempHome('cell-writer-');

/** Writes a lock file for the current test's node. */
async function writeLock(dir: string, contents: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(lockPath(dir), contents);
}

describe('JournalWriter', () => {
  it('appends chained, verifiable events with contiguous seq', async () => {
    let t = EPOCH;
    const w = await JournalWriter.open(home(), 'n1', { now: () => t++ });
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
    const w = await JournalWriter.open(home(), 'n1', { now: () => EPOCH });
    w.append('test/ping', { n: 0 });
    await w.flush();
    // One event, one frame: the file is exactly the frame for that envelope.
    const expected = encodeBatch([eventLine(makeEvent({
      type: 'test/ping', data: { n: 0 }, seq: 0, time: EPOCH, prevHash: GENESIS_HASH,
    }))]);
    const onDisk = await readFile(logPath(home()));
    expect(onDisk.equals(expected)).toBe(true);
    await w.close();
  });
  it('rejects a second writer on the same journal', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    await expect(JournalWriter.open(home(), 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
    await w.close();
  });
  it('resumes seq and prev_hash after close and reopen', async () => {
    let w = await JournalWriter.open(home(), 'n1');
    const e0 = w.append('test/ping', { n: 0 });
    await w.close();
    w = await JournalWriter.open(home(), 'n1');
    const e1 = w.append('test/ping', { n: 1 });
    expect(e1.seq).toBe(1);
    expect(e1.prev_hash).toBe(e0.hash);
    await w.close();
  });
  it('claim-checks oversized payloads into the blob store', async () => {
    const w = await JournalWriter.open(home(), 'n1');
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
      const input = { payload };
      const node = `b${delta}`;
      const w = await JournalWriter.open(home(), node, { batchWindowMs: 60_000 });
      const e = w.append('test/big', input);
      // Both sides of the boundary are asserted by shape, not only by whether
      // some `blob` key exists: a produced reference must pass `isBlobRef`.
      expect(isBlobRef(e.data)).toBe(claimed);
      if (!claimed) expect(e.data).toEqual(input);
      await w.close();
      // And the event round-trips through the reader's verified resolution:
      // the original payload comes back on both sides of the threshold.
      const r = await JournalReader.open(home(), node, {
        knownTypes: new Set(['test/big']), resolveBlobs: true,
      });
      const events = [];
      for await (const ev of r.events()) events.push(ev);
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toEqual(input);
    }
  });
  it('measures the threshold and the reported size in UTF-8 bytes, not code units', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    // 6 000 code units but 18 000 UTF-8 bytes: over the 16 384-byte threshold.
    const payload = '€'.repeat(6000);
    const bytes = Buffer.byteLength(canonicalizeJson({ payload }), 'utf8');
    expect(bytes).toBeGreaterThan(CLAIM_CHECK_THRESHOLD);
    const e = w.append('test/big', { payload });
    const data = e.data as { blob: string; size: number };
    await w.flush();
    await w.close();
    const blob = await new BlobStore(home()).get(data.blob);
    expect(data.size).toBe(bytes);
    expect(blob.length).toBe(bytes);
  });
  it('marks a payload past MAX_BLOB_BYTES truncated, with the original size', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    const payload = 'a'.repeat(MAX_BLOB_BYTES + 10);
    const e = w.append('test/big', { payload });
    const data = e.data as { blob: string; size: number; truncated?: boolean };
    const expectedSize = Buffer.byteLength(canonicalizeJson({ payload }), 'utf8');
    expect(data.truncated).toBe(true);
    expect(data.size).toBe(expectedSize);
    await w.flush();
    await w.close();
    expect((await new BlobStore(home()).get(data.blob)).length).toBe(MAX_BLOB_BYTES);
  });
  it('does not mark a payload between the threshold and MAX_BLOB_BYTES truncated', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    const e = w.append('test/big', { payload: 'a'.repeat(CLAIM_CHECK_THRESHOLD * 2) });
    const data = e.data as { blob: string; size: number; truncated?: boolean };
    expect(data.truncated).toBeUndefined();
    await w.close();
  });
  it('treats a caller-shaped { blob, size } below the threshold as data', async () => {
    // The writer only substitutes a reference for payloads at or past the
    // threshold, so a small pair with the same keys is ordinary data and must
    // round-trip untouched (the reader must not resolve it either).
    const payload = { blob: 'a'.repeat(64), size: 5 };
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    const e = w.append('test/ping', payload);
    expect(e.data).toEqual(payload);
    await w.close();
    const events = [];
    for await (const ev of (await JournalReader.open(home(), 'n1', {
      knownTypes: new Set(['test/ping']),
    })).events()) events.push(ev);
    expect(events[0]?.data).toEqual(payload);
  });
  it('refuses a root payload shaped like a blob reference', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    expect(() => w.append('test/ping', {
      blob: 'a'.repeat(64), size: CLAIM_CHECK_THRESHOLD,
    })).toThrow(ReservedBlobRefError);
    // Refused before seq advances: the writer is still clean and usable.
    expect(w.append('test/ping', { n: 0 }).seq).toBe(0);
    await w.close();
  });
  it('keeps the canonical copy, not the caller object, in the returned envelope', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    const payload = { nested: { n: 1 }, list: [1, 2] };
    const e = w.append('test/ping', payload);
    payload.nested.n = 99;
    payload.list.push(3);
    expect(e.data).toEqual({ nested: { n: 1 }, list: [1, 2] });
    expect(verifyEvent(e)).toBe(true);
    await w.close();
  });
  it('rolls back the blob of an append refused after claimCheck', async () => {
    // A non-finite time makes `makeEvent` throw in canonicalization, after the
    // payload has already been registered as a pending blob. That registration
    // must be rolled back: otherwise the next flush writes a blob no event names.
    let time = Number.NaN;
    const w = await JournalWriter.open(home(), 'n1', { now: () => time, batchWindowMs: 60_000 });
    expect(() => w.append('test/big', { payload: 'a'.repeat(BIG_PAYLOAD_CHARS) }))
      .toThrow(NonCanonicalizableError);
    time = EPOCH;
    await w.flush();
    // An orphaned blob would have created the store and been drained here.
    await expect(readdir(join(home(), 'blobs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readFile(logPath(home()))).length).toBe(0);
    // The refusal consumed no seq and left the writer usable.
    expect(w.append('test/ping', { n: 0 }).seq).toBe(0);
    await w.close();
    expect((await collectEvents(home())).map((e) => e.seq)).toEqual([0]);
  });
  it('creates journal directories 0700 and files 0600', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await w.flush();
    const dir = nodeDir(home(), 'n1');
    // The journal's own tree and every file in it are owner-only, regardless of
    // the process umask. The owner record is written by the lock guard process.
    expect((await stat(join(home(), 'nodes'))).mode & 0o777).toBe(0o700);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(journalPath(dir))).mode & 0o777).toBe(0o600);
    expect((await stat(headPath(dir))).mode & 0o777).toBe(0o600);
    expect((await stat(ownerPath(dir))).mode & 0o777).toBe(0o600);
    await w.close();
  });
});

describe('JournalWriter durability and ownership', () => {
  it('does not persist a batch that has not reached the flush barrier', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    // No flush yet: the log file exists (created at open) but holds no events.
    const size = (await readFile(logPath(home()))).length;
    expect(size).toBe(0);
    await w.flush();
    const flushed = (await readFile(logPath(home()))).length;
    expect(flushed).toBeGreaterThan(0);
    await w.close();
  });
  it('writes the batch when the write-behind window elapses', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 10 });
    w.append('test/ping', { n: 0 });
    await vi.waitFor(async () => {
      const size = (await readFile(logPath(home()))).length;
      expect(size).toBeGreaterThan(0);
    });
    await w.close();
  });
  it('is idempotent: a second flush writes nothing more', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.flush();
    const size = (await readFile(logPath(home()))).length;
    await w.flush();
    expect((await readFile(logPath(home()))).length).toBe(size);
    await w.close();
  });
  it('serializes concurrent flushes without duplicating events', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    await Promise.all([w.flush(), w.flush(), w.flush()]);
    const lines = (await readFile(logPath(home())));
    expect(lines.length).toBeGreaterThan(0);
    // Reopen and count: duplicated events would break seq contiguity.
    await w.close();
    const w2 = await JournalWriter.open(home(), 'n1');
    const e = w2.append('test/ping', { n: 2 });
    expect(e.seq).toBe(2);
    await w2.close();
  });
  it('keeps the pending batch on disk when close flushes it', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await w.close();
    const events = [];
    for await (const e of (await JournalReader.open(home(), 'n1', { knownTypes: new Set(['test/ping']) })).events()) {
      events.push(e);
    }
    expect(events.map((e) => e.seq)).toEqual([0]);
  });
  it('shares one in-flight close between concurrent callers', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    const first = w.close();
    const second = w.close();
    // The same completion, not an early resolve while the first still flushes.
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });
  it('rejects every concurrent closer when the final flush fails', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    const outcomes = await withFailingWrite(home(), () =>
      Promise.allSettled([w.close(), w.close()]));
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    const a = outcomes[0] as PromiseRejectedResult;
    const b = outcomes[1] as PromiseRejectedResult;
    expect(a.reason).toBe(b.reason);
    expect((a.reason as Error).message).toContain('injected EIO');
  });
  it('rejects appends after close', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    await w.close();
    expect(() => w.append('test/ping', { n: 0 })).toThrow(JournalClosedError);
  });
  it('refuses to open over a torn tail instead of burying it', async () => {
    let w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await appendTear(home());
    await expect(JournalWriter.open(home(), 'n1')).rejects.toThrow(TornTailError);
    // The failed open releases its lock, so repair() + reopen recovers.
    expect(await repair(home(), 'n1')).toEqual({ tornBytes: 9 });
    w = await JournalWriter.open(home(), 'n1');
    expect(w.append('test/ping', { n: 1 }).seq).toBe(1);
    await w.close();
  });
  it('takes over a lock whose owner is dead', async () => {
    await writeLock(nodeDir(home(), 'n1'), '999999999');
    const w = await JournalWriter.open(home(), 'n1');
    await w.close();
  });
  it('refuses to resume onto a forged but decodable tail', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await rewriteLog(journalPath(nodeDir(home(), 'n1')), (lines) => [...lines, forgedEnvelope()]);
    const err = await JournalWriter.open(home(), 'n1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainBreakError);
    // Canonically encoded, so the linkage is what refuses the resume.
    expect((err as ChainBreakError).message).toContain('prev_hash mismatch');
  });
  it.skipIf(process.getuid?.() === 0)(
    'refuses to resume when the log is unreadable instead of forking from genesis',
    async () => {
      const { chmod } = await import('node:fs/promises');
      const w = await JournalWriter.open(home(), 'n1');
      w.append('test/ping', { n: 0 });
      await w.close();
      // Write-only: the append handle still opens, so the failure is isolated
      // to `resume`'s read. (Skipped as root, which bypasses permissions.)
      await chmod(logPath(home()), 0o200);
      try {
        await expect(JournalWriter.open(home(), 'n1')).rejects.toThrow();
      } finally {
        await chmod(logPath(home()), 0o600);
      }
    },
  );
  it('refuses a lock held by the current live process', async () => {
    await writeLock(nodeDir(home(), 'n1'), JSON.stringify({
      pid: process.pid, startedAt: await currentProcessStartTime(),
    }));
    await expect(JournalWriter.open(home(), 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
  });
  it('takes over a lock whose PID was recycled by an unrelated process', async () => {
    // The PID is alive (ours) but the recorded start time cannot match, so the
    // lock belongs to a process that is gone.
    await writeLock(nodeDir(home(), 'n1'), JSON.stringify({ pid: process.pid, startedAt: 1 }));
    const w = await JournalWriter.open(home(), 'n1');
    await w.close();
  });
  it('takes over a lock whose contents are garbage', async () => {
    for (const garbage of ['', 'abc', '0', '-1', '9999999999999', '{"pid":']) {
      await writeLock(nodeDir(home(), 'n1'), garbage);
      const w = await JournalWriter.open(home(), 'n1');
      await w.close();
    }
  });
});

async function currentProcessStartTime(): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const stat = await readFile('/proc/self/stat', 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}
