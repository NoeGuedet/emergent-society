import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JournalWriter } from '../writer.js';
import { BlobStore, CLAIM_CHECK_THRESHOLD, MAX_BLOB_BYTES } from '../blobs.js';
import { JournalReader, repair } from '../reader.js';
import { canonicalizeJson } from '../canon.js';
import { eventLine, verifyEvent, type EventEnvelope } from '../envelope.js';
import { scanBatches, encodeBatch } from '../framing.js';
import { headPath, journalPath, nodeDir } from '../layout.js';
import {
  appendTear, countSyncs, fileHandleProto, logPath, payloadOfCanonicalBytes, useTempHome,
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
  it('fsyncs the directory again after unlinking the stale head', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.flush();
    await w.close();
    await appendTear(home());
    const dir = nodeDir(home(), 'n1');
    // Record whether the head still exists each time the node's directory is
    // fsynced: the unlink is itself a directory metadata change, so the last
    // sync of `dir` must happen after it, or a crash can resurrect a head
    // whose count points past the truncation.
    const headAtDirSync: boolean[] = [];
    const proto = await fileHandleProto(home());
    const real = proto.sync;
    const spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: { fd: number }) {
      if ((await readlink(`/proc/self/fd/${this.fd}`)) === dir) {
        headAtDirSync.push(existsSync(headPath(dir)));
      }
      return real.call(this);
    });
    try {
      expect(await repair(home(), 'n1')).toEqual({ tornBytes: 9 });
    } finally {
      spy.mockRestore();
    }
    expect(headAtDirSync[0]).toBe(true);
    expect(headAtDirSync.at(-1)).toBe(false);
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

/**
 * The frozen v0 format contract.
 *
 * These literals were generated once from the v0 implementation and must NEVER
 * be regenerated from production code. A change to the envelope field set, the
 * hash formula (`SHA-256(prev_hash || canon(v, type, seq, time, [ignorable],
 * data))`), the 4-byte little-endian length prefix, the zstd magic or the
 * canonical line encoding means `v: 1` in a *new* file; existing journals must
 * keep verifying. Recomputing the expectation with the code under test would
 * let such a breaking change stay green while bricking every journal on disk.
 */
describe('frozen v0 format vectors', () => {
  const GOLDEN_LINE = '{"data":{"n":0},"hash":"884aa5961f456930b0cc6d1e7d989149e31eedbc37a2a9c506064c7ec51f4f65","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":0,"time":1789000000000,"type":"test/ping","v":0}';
  const GOLDEN_HASH = '884aa5961f456930b0cc6d1e7d989149e31eedbc37a2a9c506064c7ec51f4f65';
  const GOLDEN_FRAME_HEX = '8c00000028b52ffd24dffd030012891c1b80b73ab6dfc9b045e4fff842848426b82e42b6bb91882847511f014dee979f0f90230144a5e3f79d1ce24faa6b68df8423fee4bed0cacf53b0b421f9f962852ad07add9e62c9723de500b7f408d88d52ab42ea14b64690bd974426654b1588e96256ce7d6f286cfc34b947ceec39323c13030000d1c4e5815216ce31e962d5';

  it('verifies the hard-coded envelope line and its hard-coded hash', () => {
    const e = JSON.parse(GOLDEN_LINE) as EventEnvelope;
    expect(e.hash).toBe(GOLDEN_HASH);
    // `verifyEvent` re-derives the hash from the v0 field set: a changed field
    // set or formula makes this false even though the line still parses.
    expect(verifyEvent(e)).toBe(true);
    // The canonical line is part of the contract too: a reader must accept
    // exactly these bytes, not merely a re-encoded equivalent.
    expect(eventLine(e)).toBe(GOLDEN_LINE);
  });

  it('decodes the hard-coded frame through scanBatches and the real reader', async () => {
    const frame = Buffer.from(GOLDEN_FRAME_HEX, 'hex');
    // Pins the length prefix, zstd magic and compressed bytes as one literal.
    expect(scanBatches(frame)).toEqual({
      batches: [{ offset: 0, size: frame.length, lines: [GOLDEN_LINE] }],
      tornBytes: 0,
    });
    const dir = nodeDir(home(), 'golden');
    await mkdir(dir, { recursive: true });
    await writeFile(journalPath(dir), frame);
    const r = await JournalReader.open(home(), 'golden', {
      knownTypes: new Set(['test/ping']),
    });
    const events: EventEnvelope[] = [];
    for await (const e of r.events()) events.push(e);
    expect(events).toEqual([JSON.parse(GOLDEN_LINE)]);
  });

  it('re-encodes the golden line to the pinned frame on the writer side', () => {
    // Pins COMPRESS_OPTIONS, the checksum flag and the split-free frame layout:
    // a writer drift must break this literal, not merely a reader's tolerance.
    expect(encodeBatch([GOLDEN_LINE]).toString('hex')).toBe(GOLDEN_FRAME_HEX);
  });
});
