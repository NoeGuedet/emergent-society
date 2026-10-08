import { describe, expect, it } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNodeUid, nodeDir } from '../layout.js';
import { InvalidNodeUidError, JournalError } from '../errors.js';
import { JournalWriter } from '../writer.js';
import { JournalReader, repair } from '../reader.js';
import { KNOWN_TYPES, useTempHome } from './helpers.js';

const home = useTempHome('cell-uid-');

/**
 * A uid is a technical identifier, not a free agent name (kernel.md §3): it is
 * one path segment under `home/nodes/` and a git author at the same time, so it
 * must be a string that is safe in both worlds and stable across a round trip.
 */

const VALID = ['n1', 'A', '0', 'a.b-c_1', 'a-b_c.d', 'x'.repeat(128)];
const INVALID = [
  '', ' ', 'a b',
  '/', 'a/b', 'a\\b', '..', '.', 'a/../b', '..\\..',
  '-a', '.a', '_a', '+a',
  'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb',
  'a:b', 'a*b', 'a?b', 'a"b', 'a<b',
  'x'.repeat(129),
];

describe('assertNodeUid', () => {
  it('accepts technical identifiers with hyphens, underscores and dots', () => {
    for (const uid of VALID) expect(assertNodeUid(uid)).toBe(uid);
  });

  it('refuses separators, traversal, control characters, empty and overlong ids', () => {
    for (const uid of INVALID) {
      expect(() => assertNodeUid(uid), JSON.stringify(uid)).toThrow(InvalidNodeUidError);
    }
  });

  it('is part of the journal error family', () => {
    const err = new InvalidNodeUidError('a/b', 'x');
    expect(err).toBeInstanceOf(JournalError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidNodeUidError');
    expect(err.uid).toBe('a/b');
  });

  it('round-trips a valid uid through the path builder as one segment', () => {
    expect(nodeDir('/home', 'a.b-c_1')).toBe(join('/home', 'nodes', 'a.b-c_1'));
    expect(() => nodeDir('/home', '../../etc/passwd')).toThrow(InvalidNodeUidError);
  });
});

describe('uid validation happens before any filesystem effect', () => {
  it('creates nothing through the writer, the reader or repair', async () => {
    const h = home();
    await expect(JournalWriter.open(h, '../escape')).rejects.toBeInstanceOf(InvalidNodeUidError);
    await expect(JournalReader.open(h, '../escape', { knownTypes: KNOWN_TYPES }))
      .rejects.toBeInstanceOf(InvalidNodeUidError);
    await expect(repair(h, '../escape')).rejects.toBeInstanceOf(InvalidNodeUidError);
    // Nothing was created at all — not a stray `nodes` directory, and certainly
    // not a path outside the home.
    expect(await readdir(h)).toEqual([]);
  });

  it('writes and reads a valid dotted/hyphenated/underscored uid', async () => {
    const h = home();
    const w = await JournalWriter.open(h, 'a.b-c_1');
    w.append('test/ping', { n: 0 });
    await w.close();
    expect(await readdir(h)).toEqual(['nodes']);

    const r = await JournalReader.open(h, 'a.b-c_1', { knownTypes: KNOWN_TYPES });
    const seqs: number[] = [];
    for await (const e of r.events()) seqs.push(e.seq);
    expect(seqs).toEqual([0]);
  });
});
