import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { JournalWriter } from '../writer.js';
import { BlobStore, CLAIM_CHECK_THRESHOLD, MAX_BLOB_BYTES } from '../blobs.js';
import { repair } from '../reader.js';
import { canonicalizeJson } from '../canon.js';
import {
  appendTear, countSyncs, logPath, payloadOfCanonicalBytes, useTempHome,
} from './helpers.js';

const home = useTempHome('cell-pin-');

describe('fsync discipline', () => {
  it('fsyncs at least once on every successful flush', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    const { syncs } = await countSyncs(home(), () => w.flush());
    // The log write is fsynced, plus the head checkpoint's tmp file and dir.
    expect(syncs).toBeGreaterThanOrEqual(1);
    await w.close();
  });
  it('fsyncs after a repair that actually truncates', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const before = (await readFile(logPath(home()))).length;
    await appendTear(home());
    const { result, syncs } = await countSyncs(home(), () => repair(home(), 'n1'));
    expect(result).toEqual({ tornBytes: 9 });
    expect((await readFile(logPath(home()))).length).toBe(before);
    // The truncation and its directory entry are both made durable.
    expect(syncs).toBeGreaterThanOrEqual(2);
  });
  it('does not fsync on a repair that finds nothing to truncate', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const { syncs } = await countSyncs(home(), () => repair(home(), 'n1'));
    expect(syncs).toBe(0);
  });
});

describe('claim-check byte boundaries', () => {
  it('flips inline → blob exactly at CLAIM_CHECK_THRESHOLD bytes', async () => {
    for (const [delta, claimed] of [[-1, false], [0, true], [1, true]] as const) {
      const input = payloadOfCanonicalBytes(CLAIM_CHECK_THRESHOLD + delta);
      expect(Buffer.byteLength(canonicalizeJson(input), 'utf8')).toBe(CLAIM_CHECK_THRESHOLD + delta);
      const w = await JournalWriter.open(home(), `t${delta}`, { batchWindowMs: 60_000 });
      const e = w.append('test/big', input);
      expect(typeof (e.data as { blob?: unknown }).blob === 'string').toBe(claimed);
      await w.close();
    }
  });

  it('flips truncated exactly at MAX_BLOB_BYTES bytes', async () => {
    for (const [delta, truncated] of [[-1, false], [0, true], [1, true]] as const) {
      const input = payloadOfCanonicalBytes(MAX_BLOB_BYTES + delta);
      expect(Buffer.byteLength(canonicalizeJson(input), 'utf8')).toBe(MAX_BLOB_BYTES + delta);
      const w = await JournalWriter.open(home(), `x${delta}`, { batchWindowMs: 60_000 });
      const e = w.append('test/big', input);
      const data = e.data as { truncated?: boolean; size: number; blob: string };
      expect(data.truncated === true).toBe(truncated);
      expect(data.size).toBe(MAX_BLOB_BYTES + delta);
      await w.close();
    }
  });
});

describe('blob immutability', () => {
  it('does not rewrite an existing blob', async () => {
    const store = new BlobStore(home());
    const hash = await store.put(Buffer.from('stable'));
    const before = await stat(join(home(), 'blobs', hash.slice(0, 2), hash));
    await new Promise((r) => setTimeout(r, 10));
    await store.put(Buffer.from('stable'));
    const after = await stat(join(home(), 'blobs', hash.slice(0, 2), hash));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
