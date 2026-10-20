import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertLayoutNames, frontierLayout, nodeLayout } from '../layout.js';
import { InvalidJournalLayoutError, InvalidNodeUidError } from '../errors.js';
import { JournalWriter, SessionAlreadyOwnedError } from '../writer.js';
import { JournalReader, repairIn } from '../reader.js';
import { acquireLock } from '../lock.js';
import type { EventEnvelope } from '../envelope.js';
import {
  BIG_PAYLOAD_CHARS, EPOCH, KNOWN_TYPES, tearFragment, useTempHome,
} from './helpers.js';

const home = useTempHome('cell-layout-');

async function collect(r: JournalReader): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  for await (const e of r.events()) out.push(e);
  return out;
}

describe('journal layouts', () => {
  it('lays the frontier out in frontier/ with the journal.v0 names', () => {
    expect(frontierLayout('/h')).toEqual({
      home: '/h',
      dir: '/h/frontier',
      label: 'frontier',
      logFile: 'journal.v0.jsonl.zstd',
      headFile: 'journal.v0.head',
      lockFile: 'journal.v0.lock',
      ownerFile: 'journal.v0.owner',
    });
  });

  it('lays a node out in nodes/<uid>/ with the log.v0 names', () => {
    expect(nodeLayout('/h', 'n1')).toEqual({
      home: '/h',
      dir: '/h/nodes/n1',
      label: 'n1',
      logFile: 'log.v0.jsonl.zstd',
      headFile: 'log.v0.head',
      lockFile: 'log.v0.lock',
      ownerFile: 'log.v0.owner',
    });
  });

  it('validates the uid through nodeLayout', () => {
    expect(() => nodeLayout('/h', '../escape')).toThrow(InvalidNodeUidError);
    expect(() => nodeLayout('/h', '')).toThrow(InvalidNodeUidError);
  });

  it('writes a node log at log.v0.jsonl.zstd with log.v0 sidecars', async () => {
    const layout = nodeLayout(home(), 'n1');
    const w = await JournalWriter.open(home(), 'n1', { now: () => EPOCH });
    w.append('test/ping', { n: 0 });
    await w.flush();
    expect((await readdir(layout.dir)).sort()).toEqual([
      layout.headFile, layout.lockFile, layout.logFile, layout.ownerFile,
    ].sort());
    for (const name of [layout.headFile, layout.lockFile, layout.logFile, layout.ownerFile]) {
      expect(existsSync(join(layout.dir, name))).toBe(true);
      expect(existsSync(join(layout.dir, name.replace('log.v0', 'journal.v0')))).toBe(false);
    }
    await w.close();
  });

  it('writes a frontier log in frontier/ and shares the home blob store', async () => {
    const layout = frontierLayout(home());
    const w = await JournalWriter.openIn(layout);
    w.append('test/big', { payload: 'a'.repeat(BIG_PAYLOAD_CHARS) });
    await w.close();
    expect(existsSync(join(layout.dir, layout.logFile))).toBe(true);
    expect(existsSync(join(layout.dir, 'log.v0.jsonl.zstd'))).toBe(false);
    expect((await readdir(join(layout.home, 'blobs'))).length).toBeGreaterThan(0);
    // The frontier's events resolve their claim-check through the same store.
    const r = await JournalReader.openIn(layout, { knownTypes: KNOWN_TYPES, resolveBlobs: true });
    const events = await collect(r);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ payload: 'a'.repeat(BIG_PAYLOAD_CHARS) });
  });

  it('repairs a torn tail in the frontier log', async () => {
    const layout = frontierLayout(home());
    const w = await JournalWriter.openIn(layout);
    w.append('test/ping', { n: 0 });
    await w.close();
    const log = join(layout.dir, layout.logFile);
    const clean = (await readFile(log)).length;
    await appendFile(log, tearFragment(9));
    expect(await repairIn(layout)).toEqual({ tornBytes: 9 });
    expect((await readFile(log)).length).toBe(clean);
    const r = await JournalReader.openIn(layout, { knownTypes: KNOWN_TYPES });
    expect(await collect(r)).toHaveLength(1);
  });

  it('repairIn creates nothing for a journal that does not exist', async () => {
    const layout = frontierLayout(home());
    expect(await repairIn(layout)).toEqual({ tornBytes: 0 });
    expect(existsSync(layout.dir)).toBe(false);
  });

  it('delegates the (home, uid) forms to the node layout', async () => {
    const layout = nodeLayout(home(), 'n1');
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    expect(existsSync(join(layout.dir, layout.logFile))).toBe(true);
    const r = await JournalReader.open(home(), 'n1', { knownTypes: KNOWN_TYPES });
    expect(await collect(r)).toHaveLength(1);
  });

  it('accepts the names of both production layouts', () => {
    expect(() => assertLayoutNames(nodeLayout('/h', 'n1'))).not.toThrow();
    expect(() => assertLayoutNames(frontierLayout('/h'))).not.toThrow();
  });

  it('refuses unsafe and duplicate names at every open path', async () => {
    const base = frontierLayout(home());
    const unsafe = [
      // Escape from layout.dir, by separator or by traversal.
      { logFile: '../escape' },
      { headFile: '..' },
      { lockFile: 'a/b' },
      // A control character is not a file name a diagnostic can carry.
      { ownerFile: 'bad\u0001name' },
      // The head rename would replace the log.
      { headFile: base.logFile },
      // The owner rename would replace the flocked sidecar inode.
      { lockFile: base.ownerFile },
    ];
    for (const over of unsafe) {
      const layout = { ...base, ...over };
      expect(() => assertLayoutNames(layout)).toThrow(InvalidJournalLayoutError);
      await expect(JournalWriter.openIn(layout)).rejects.toBeInstanceOf(InvalidJournalLayoutError);
      await expect(JournalReader.openIn(layout, { knownTypes: KNOWN_TYPES }))
        .rejects.toBeInstanceOf(InvalidJournalLayoutError);
      await expect(repairIn(layout)).rejects.toBeInstanceOf(InvalidJournalLayoutError);
    }
    // Refused before any filesystem effect, including the disappearance probe.
    expect(existsSync(base.dir)).toBe(false);
  });

  it('names the frontier, never a node, in a lock failure', async () => {
    const layout = frontierLayout(home());
    await mkdir(layout.dir, { recursive: true });
    const held = await acquireLock(layout);
    try {
      const err = await JournalWriter.openIn(layout).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionAlreadyOwnedError);
      expect((err as Error).message).toContain('journal "frontier"');
      expect((err as Error).message).not.toContain('node');
    } finally {
      await held.release();
    }
  });
});
