import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter } from '../writer.js';
import { JournalReader, ChainBreakError, repair } from '../reader.js';
import { UnknownEventTypeError, computeHash } from '../envelope.js';
import { canonicalizeJson } from '../canon.js';
import { encodeBatch } from '../framing.js';

const KNOWN = new Set(['test/ping']);
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cell-reader-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function logPath(node = 'n1'): string {
  return join(home, `nodes/${node}/journal.v0.jsonl.zstd`);
}

async function collect(r: JournalReader, fromSeq = 0) {
  const out = [];
  for await (const e of r.events(fromSeq)) out.push(e);
  return out;
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
  it('resumes from a watermark while still verifying the whole chain', async () => {
    const w = await JournalWriter.open(home, 'n1');
    w.append('test/ping', { n: 0 });
    w.append('test/ping', { n: 1 });
    w.append('test/ping', { n: 2 });
    await w.close();
    const r = await JournalReader.open(home, 'n1', KNOWN);
    expect((await collect(r, 1)).map((e) => e.seq)).toEqual([1, 2]);
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
});