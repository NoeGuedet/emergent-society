import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalWriter } from '../writer.js';
import { JournalReader, repair } from '../reader.js';

const KNOWN = new Set(['test/tick', 'test/big']);
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cell-integ-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('journal end to end', () => {
  it('1 000 events survive write, close, repair and verified replay', async () => {
    let w = await JournalWriter.open(home, 'node-0', { batchWindowMs: 10 });
    for (let i = 0; i < 1000; i++) {
      w.append('test/tick', { i });
      if (i % 100 === 0) await w.flush(); // the barrier, as the driver will call it
    }
    await w.close();

    await repair(home, 'node-0');

    const r = await JournalReader.open(home, 'node-0', KNOWN);
    let count = 0;
    for await (const e of r.events()) {
      expect(e.seq).toBe(count);
      count += 1;
    }
    expect(count).toBe(1000);

    const head = await r.head();
    expect(head?.count).toBe(1000);

    // The journal accepts a new writer after the previous one closed.
    w = await JournalWriter.open(home, 'node-0');
    const e = w.append('test/tick', { i: 1000 });
    expect(e.seq).toBe(1000);
    await w.close();
  });
});