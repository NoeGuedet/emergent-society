import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter } from '../writer.js';
import { JournalReader, ChainBreakError, repair } from '../reader.js';
import { UnknownEventTypeError, computeHash } from '../envelope.js';
import { canonicalizeJson } from '../canon.js';
import { encodeBatch, scanBatches, CorruptFrameError } from '../framing.js';
import { headPath, journalPath, nodeDir } from '../layout.js';

const KNOWN = new Set(['test/ping']);
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cell-reader-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function logPath(node = 'n1'): string {
  return journalPath(nodeDir(home, node));
}

async function collect(r: JournalReader, fromSeq = 0) {
  const out = [];
  for await (const e of r.events(fromSeq)) out.push(e);
  return out;
}

/** Rebuilds the log from its decoded lines, optionally rewriting one of them. */
async function rewriteLog(
  path: string, mutate: (lines: string[]) => string[],
): Promise<void> {
  const { batches } = scanBatches(await readFile(path));
  const lines = batches.flatMap((b) => b.lines);
  await writeFile(path, encodeBatch(mutate(lines)));
}

/**
 * Collects events and returns the typed error they raised. Asserts on the error
 * object directly: `message` is non-enumerable on `Error`, so a
 * `toMatchObject({ message })` assertion would silently never match.
 */
async function collectFailure(r: JournalReader): Promise<ChainBreakError> {
  try {
    await collect(r);
  } catch (err) {
    return err as ChainBreakError;
  }
  throw new Error('expected the reader to reject');
}

describe('JournalReader', () => {
  it('reads back exactly what was written', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    await w.close();
    const events = await collect(await JournalReader.open(home, 'n1', KNOWN));
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });
  it('detects a broken chain', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const forged = JSON.stringify({
      v: 0, type: 'test/ping', seq: 1, time: 1, prev_hash: 'f'.repeat(64),
      hash: 'f'.repeat(64), data: {},
    });
    await appendFile(logPath(), encodeBatch([forged]));
    const r = await JournalReader.open(home, 'n1', KNOWN);
    await expect(collect(r)).rejects.toThrow(ChainBreakError);
  });
  it('refuses an unknown non-ignorable type', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('future/thing', { n: 0 });
    await w.close();
    const r = await JournalReader.open(home, 'n1', KNOWN);
    await expect(collect(r)).rejects.toThrow(UnknownEventTypeError);
  });
  it('repair discards a torn trailing fragment', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const path = logPath();
    const before = (await readFile(path)).length;
    await appendFile(path, encodeBatch(['{"torn":true}']).subarray(0, 9));
    const { tornBytes } = await repair(home, 'n1');
    expect(tornBytes).toBe(9);
    expect((await readFile(path)).length).toBe(before);
    const events = await collect(await JournalReader.open(home, 'n1', KNOWN));
    expect(events).toHaveLength(1);
  });
});

describe('JournalReader verification and repair edges', () => {
  it('yields nothing for a journal that was never written', async () => {
    const r = await JournalReader.open(home, 'absent', KNOWN);
    expect(await collect(r)).toEqual([]);
    expect(await r.head()).toBeNull();
  });
  it('serves the head checkpoint written by the flush barrier', async () => {
    const w = await JournalWriter.open(home, 'n1');
    const e0 = w.append('test/ping', { n: 0 });
    const e1 = w.append('test/ping', { n: 1 });
    await w.flush();
    const head = await (await JournalReader.open(home, 'n1', KNOWN)).head();
    expect(head).toEqual({ first_hash: e0.hash, last_hash: e1.hash, count: 2, ts: expect.any(Number) });
    await w.close();
  });
  it('returns null for a malformed head instead of trusting its shape', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.flush();
    await w.close();
    const r = await JournalReader.open(home, 'n1', KNOWN);
    for (const bad of ['null', '[]', '{"count":2}', '{"first_hash":"x","last_hash":"y","count":-1,"ts":1}', 'not json']) {
      await writeFile(headPath(nodeDir(home, 'n1')), bad);
      expect(await r.head()).toBeNull();
    }
  });
  it('resumes from a watermark while still verifying the whole chain', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    w.append('test/ping', { n: 2 });
    await w.close();
    const r = await JournalReader.open(home, 'n1', KNOWN);
    expect((await collect(r, 1)).map((e) => e.seq)).toEqual([1, 2]);
  });
  it('treats a negative fromSeq as 0 and a beyond-end fromSeq as empty', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    await w.close();
    const r = await JournalReader.open(home, 'n1', KNOWN);
    expect((await collect(r, -5)).map((e) => e.seq)).toEqual([0, 1]);
    expect(await collect(r, 99)).toEqual([]);
  });
  it('refuses a format version other than v0 even when the chain is intact', async () => {
    const w = await JournalWriter.open(home, 'n1');
    const e0 = w.append('test/ping', { n: 0 });
    await w.close();
    const unsigned = { v: 1, type: 'test/ping', seq: 1, time: 1789000000001, prev_hash: e0.hash, data: {} };
    const line = canonicalizeJson({ ...unsigned, hash: computeHash(unsigned as never) } as never);
    await appendFile(logPath(), encodeBatch([line]));
    const r = await JournalReader.open(home, 'n1', KNOWN);
    await expect(collect(r)).rejects.toThrow(ChainBreakError);
  });
  it('tolerates an unknown ignorable type', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('future/thing', { n: 0 }, { ignorable: true });
    await w.close();
    const events = await collect(await JournalReader.open(home, 'n1', KNOWN));
    expect(events).toHaveLength(1);
  });
  it('rebuilds past a torn tail without repairing first', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await appendFile(logPath(), encodeBatch(['{"torn":true}']).subarray(0, 9));
    const events = await collect(await JournalReader.open(home, 'n1', KNOWN));
    expect(events).toHaveLength(1);
  });
  it('repair is a no-op on an intact journal', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const before = (await readFile(logPath())).length;
    expect(await repair(home, 'n1')).toEqual({ tornBytes: 0 });
    expect((await readFile(logPath())).length).toBe(before);
  });
  it('repair is a no-op on a missing journal', async () => {
    expect(await repair(home, 'nope')).toEqual({ tornBytes: 0 });
  });
  it('repair is idempotent after a real tear', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await appendFile(logPath(), encodeBatch(['{"torn":true}']).subarray(0, 9));
    expect(await repair(home, 'n1')).toEqual({ tornBytes: 9 });
    expect(await repair(home, 'n1')).toEqual({ tornBytes: 0 });
  });
});

describe('JournalReader integrity', () => {
  it('rejects an event whose data was rewritten while prev_hash stayed intact', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    await w.close();
    await rewriteLog(logPath(), (lines) => {
      const e = JSON.parse(lines[1]!) as Record<string, unknown>;
      e['data'] = { n: 999 };
      return [lines[0]!, canonicalizeJson(e as never)];
    });
    const r = await JournalReader.open(home, 'n1', KNOWN);
    const err = await collectFailure(r);
    expect(err.name).toBe('ChainBreakError');
    expect(err.seq).toBe(1);
    expect(err.message).toContain('hash recomputation failed');
  });
  it('rejects a seq gap even when every hash is self-consistent', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    await w.close();
    await rewriteLog(logPath(), (lines) => {
      const e = JSON.parse(lines[1]!) as Record<string, unknown>;
      e['seq'] = 3;
      e['hash'] = computeHash(e as never);
      return [lines[0]!, canonicalizeJson(e as never)];
    });
    const r = await JournalReader.open(home, 'n1', KNOWN);
    const err = await collectFailure(r);
    expect(err.name).toBe('ChainBreakError');
    expect(err.seq).toBe(3);
    expect(err.message).toContain('expected seq 1');
  });
  it('rejects an event whose prev_hash was relinked to a well-formed but wrong hash', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    w.append('test/ping', { n: 2 });
    await w.close();
    // Event 2 is re-signed against a wrong-but-valid prev_hash: only the
    // linkage check stands between this and acceptance.
    await rewriteLog(logPath(), (lines) => {
      const e = JSON.parse(lines[2]!) as Record<string, unknown>;
      e['prev_hash'] = 'a'.repeat(64);
      e['hash'] = computeHash(e as never);
      return [lines[0]!, lines[1]!, canonicalizeJson(e as never)];
    });
    const r = await JournalReader.open(home, 'n1', KNOWN);
    const err = await collectFailure(r);
    expect(err.name).toBe('ChainBreakError');
    expect(err.seq).toBe(2);
    expect(err.message).toContain('prev_hash mismatch');
  });
  it('isolates the hash hex-format check from linkage', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    await w.close();
    // prev_hash is correct, so linkage passes; only the `hash` field is malformed.
    await rewriteLog(logPath(), (lines) => {
      const e = JSON.parse(lines[1]!) as Record<string, unknown>;
      e['hash'] = 'ZZ';
      return [lines[0]!, JSON.stringify(e)];
    });
    const r = await JournalReader.open(home, 'n1', KNOWN);
    const err = await collectFailure(r);
    expect(err.name).toBe('ChainBreakError');
    expect(err.message).toContain('hash is not 64 lowercase hex');
  });
  it('isolates the prev_hash hex-format check from linkage', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    await w.close();
    await rewriteLog(logPath(), (lines) => {
      const e = JSON.parse(lines[1]!) as Record<string, unknown>;
      e['prev_hash'] = 'not-hex';
      return [lines[0]!, JSON.stringify(e)];
    });
    const r = await JournalReader.open(home, 'n1', KNOWN);
    const err = await collectFailure(r);
    expect(err.name).toBe('ChainBreakError');
    expect(err.message).toContain('prev_hash is not 64 lowercase hex');
  });
  it('rejects a line that fails only JSON.parse', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    // `{oops` is neither valid JSON nor anything else: only the parse branch fires.
    await rewriteLog(logPath(), (lines) => [...lines, '{oops']);
    const r = await JournalReader.open(home, 'n1', KNOWN);
    const err = await collectFailure(r);
    expect(err.name).toBe('ChainBreakError');
    expect(err.message).toContain('not valid JSON');
  });
  it('round-trips the full envelope unchanged, including non-ASCII payloads', async () => {
    let t = 1789000000000;
    const w = await JournalWriter.open(home, 'n1', { now: () => t++ });
    const e0 = w.append('test/ping', { text: 'é日😀', nested: [1, { a: null }] });
    const e1 = w.append('test/ping', { n: 1 });
    await w.close();
    const events = await collect(await JournalReader.open(home, 'n1', KNOWN));
    expect(events).toEqual([e0, e1]);
  });
  it('refuses a line that is not a JSON object with a typed error', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await rewriteLog(logPath(), (lines) => [...lines, '42']);
    const r = await JournalReader.open(home, 'n1', KNOWN);
    await expect(collect(r)).rejects.toThrow(ChainBreakError);
  });
  it('refuses an envelope carrying a field outside the frozen v0 set', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await rewriteLog(logPath(), (lines) => {
      const e = JSON.parse(lines[0]!) as Record<string, unknown>;
      e['injected'] = 'evil';
      return [canonicalizeJson(e as never)];
    });
    const r = await JournalReader.open(home, 'n1', KNOWN);
    const err = await collectFailure(r);
    expect(err.name).toBe('ChainBreakError');
    expect(err.message).toContain('unknown envelope field');
  });
  it('rejects a hash that is not 64 lowercase hex characters', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await rewriteLog(logPath(), (lines) => {
      const e = JSON.parse(lines[0]!) as Record<string, unknown>;
      e['prev_hash'] = 'ZZ';
      return [canonicalizeJson(e as never)];
    });
    const r = await JournalReader.open(home, 'n1', KNOWN);
    await expect(collect(r)).rejects.toThrow(ChainBreakError);
  });
  it('throws a CorruptFrameError on a corrupt middle frame instead of serving a truncated history', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const w2 = await JournalWriter.open(home, 'n1');
    w2.append('test/ping', { n: 1 });
    await w2.flush();
    await w2.close();
    const w3 = await JournalWriter.open(home, 'n1');
    w3.append('test/ping', { n: 2 });
    await w3.close();

    const raw = await readFile(logPath());
    const { batches } = scanBatches(raw);
    expect(batches).toHaveLength(3);
    // Flip bytes inside the middle frame's compressed payload.
    const middle = batches[1]!;
    const corrupt = Buffer.from(raw);
    corrupt.fill(0xff, middle.offset + 4, middle.offset + middle.size);
    await writeFile(logPath(), corrupt);

    const r = await JournalReader.open(home, 'n1', KNOWN);
    await expect(collect(r)).rejects.toThrow(CorruptFrameError);
  });
  it('repair refuses interior corruption and deletes nothing', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const w2 = await JournalWriter.open(home, 'n1');
    w2.append('test/ping', { n: 1 });
    await w2.flush();
    await w2.close();

    const raw = await readFile(logPath());
    const { batches } = scanBatches(raw);
    const first = batches[0]!;
    const corrupt = Buffer.from(raw);
    corrupt.fill(0xff, first.offset + 4, first.offset + first.size);
    await writeFile(logPath(), corrupt);
    const lengthBefore = (await readFile(logPath())).length;

    await expect(repair(home, 'n1')).rejects.toThrow(CorruptFrameError);
    expect((await readFile(logPath())).length).toBe(lengthBefore);
  });
  it('throws on an unreadable log rather than mistaking it for genesis', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    // Replace the log with a directory: reading it fails with EISDIR, a
    // non-ENOENT error the reader must surface rather than treat as genesis.
    // This is root-independent, unlike a permission-based fixture.
    const { rm, mkdir } = await import('node:fs/promises');
    await rm(logPath());
    await mkdir(logPath());
    const r = await JournalReader.open(home, 'n1', KNOWN);
    await expect(collect(r)).rejects.toThrow();
  });
  it('repair deletes a stale head so it cannot serve a watermark past the truncation', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    const w2 = await JournalWriter.open(home, 'n1');
    w2.append('test/ping', { n: 1 });
    await w2.flush();
    await w2.close();
    expect((await (await JournalReader.open(home, 'n1', KNOWN)).head())?.count).toBe(2);
    await appendFile(logPath(), encodeBatch(['{"torn":true}']).subarray(0, 9));
    await repair(home, 'n1');
    expect(await (await JournalReader.open(home, 'n1', KNOWN)).head()).toBeNull();
  });
});
