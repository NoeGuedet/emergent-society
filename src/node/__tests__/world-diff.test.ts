import { describe, expect, it } from 'vitest';
import { GitCommandError } from '../errors.js';
import { commitAs, useWorld } from './helpers.js';

/**
 * The bounded, pinned history primitives (T4): `commitsIn` traversal and the
 * hermetic `diff` net-range renderer. These are the node-side units; the
 * per-commit perception composition lives in `src/context/__tests__/diff.test.ts`.
 */

const fixture = useWorld('node-world-diff-');

const MISSING = 'a'.repeat(40);

describe('WorldRepo.commitsIn', () => {
  it('serves the whole history oldest-first with authors, from null', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const c2 = await commitAs(world, 'n2', { 'b.txt': 'two\n' });
    const c3 = await commitAs(world, 'n1', { 'c.txt': 'three\n' });

    expect(await world.commitsIn({ from: null, to: c3 }, 4096)).toEqual({
      commits: [
        { hash: c1, author: 'n1' },
        { hash: c2, author: 'n2' },
        { hash: c3, author: 'n1' },
      ],
      effectiveFrom: null,
      fallback: 'none',
      listTruncated: false,
    });
  });

  it('serves an exclusive reachable range and pins effectiveFrom to the requested from', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const c2 = await commitAs(world, 'n2', { 'b.txt': 'two\n' });
    const c3 = await commitAs(world, 'n1', { 'c.txt': 'three\n' });

    const range = await world.commitsIn({ from: c1, to: c3 }, 4096);
    expect(range.commits.map((c) => c.hash)).toEqual([c2, c3]);
    expect(range.effectiveFrom).toBe(c1);
    expect(range.fallback).toBe('none');
    expect(range.listTruncated).toBe(false);
  });

  it('falls back to full history when from does not exist, reporting the explicit fallback', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const c2 = await commitAs(world, 'n2', { 'b.txt': 'two\n' });

    const range = await world.commitsIn({ from: MISSING, to: c2 }, 4096);
    expect(range.commits.map((c) => c.hash)).toEqual([c1, c2]);
    expect(range.effectiveFrom).toBeNull();
    expect(range.fallback).toBe('unreachable-from');
  });

  it('falls back when from exists but is not an ancestor of to', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const c2 = await commitAs(world, 'n2', { 'b.txt': 'two\n' });
    const c3 = await commitAs(world, 'n1', { 'c.txt': 'three\n' });

    // `from` names a real commit that is not on to's first-parent chain: it is
    // unreachable as a traversal base, so the whole history is shown.
    const range = await world.commitsIn({ from: c2, to: c1 }, 4096);
    expect(range.commits.map((c) => c.hash)).toEqual([c1]);
    expect(range.effectiveFrom).toBeNull();
    expect(range.fallback).toBe('unreachable-from');
    // c3 still exists; the range asked for `to: c1`, so c3 is not in it.
    expect(await world.commitsIn({ from: null, to: c3 }, 4096)).toBeDefined();
  });

  it('rejects a nonexistent to hash instead of falling back', async () => {
    const { world } = fixture();
    await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    await expect(world.commitsIn({ from: null, to: MISSING }, 4096))
      .rejects.toBeInstanceOf(GitCommandError);
  });

  it('treats null/equal endpoints as empty', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    expect(await world.commitsIn({ from: null, to: null }, 4096)).toEqual({
      commits: [], effectiveFrom: null, fallback: 'none', listTruncated: false,
    });
    expect(await world.commitsIn({ from: c1, to: c1 }, 4096)).toEqual({
      commits: [], effectiveFrom: c1, fallback: 'none', listTruncated: false,
    });
  });

  it('truncates the selected list to the newest maxCommits, oldest-first', async () => {
    const { world } = fixture();
    const hashes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      hashes.push(await commitAs(world, `n${i}`, { [`f${i}.txt`]: `${i}\n` }));
    }
    const range = await world.commitsIn({ from: null, to: hashes[4] ?? null }, 3);
    expect(range.listTruncated).toBe(true);
    expect(range.commits.map((c) => c.hash)).toEqual([hashes[2], hashes[3], hashes[4]]);
    expect(range.commits.map((c) => c.author)).toEqual(['n2', 'n3', 'n4']);
    expect(range.effectiveFrom).toBeNull();
    expect(range.fallback).toBe('none');
  });

  it('rejects a malformed hash and an out-of-range maxCommits', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    await expect(world.commitsIn({ from: 'xyz', to: c1 }, 4096)).rejects.toThrow(/invalid from hash/);
    await expect(world.commitsIn({ from: null, to: c1 }, 0)).rejects.toThrow(/maxCommits/);
    await expect(world.commitsIn({ from: null, to: c1 }, 4097)).rejects.toThrow(/maxCommits/);
  });
});

describe('WorldRepo.diff', () => {
  it('renders the additions of a first commit from the empty tree', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const capture = await world.diff({ from: null, to: c1 }, 4096);
    expect(capture.truncated).toBe(false);
    expect(capture.bytesRetained).toBe(Buffer.byteLength(capture.text, 'utf8'));
    expect(capture.text).toContain('diff --git a/a.txt b/a.txt');
    expect(capture.text).toContain('+one');
  });

  it('renders the net change across a range', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const c2 = await commitAs(world, 'n2', { 'a.txt': 'two\n', 'b.txt': 'new\n' });
    const capture = await world.diff({ from: c1, to: c2 }, 4096);
    expect(capture.text).toContain('-one');
    expect(capture.text).toContain('+two');
    expect(capture.text).toContain('+new');
  });

  it('treats same-hash and null endpoints as empty', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    expect(await world.diff({ from: c1, to: c1 }, 4096)).toEqual({
      text: '', truncated: false, bytesRetained: 0,
    });
    expect(await world.diff({ from: null, to: null }, 4096)).toEqual({
      text: '', truncated: false, bytesRetained: 0,
    });
  });

  it('uses the empty tree when from is missing, and rejects a missing to', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const capture = await world.diff({ from: MISSING, to: c1 }, 4096);
    expect(capture.text).toContain('+one');
    await expect(world.diff({ from: null, to: MISSING }, 4096)).rejects.toBeInstanceOf(GitCommandError);
  });

  it('bounds emission at maxBytes with a truncated flag and exact byte accounting', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'big.txt': `${'line\n'.repeat(4000)}` });
    const capture = await world.diff({ from: null, to: c1 }, 4096);
    expect(capture.truncated).toBe(true);
    expect(capture.bytesRetained).toBeLessThanOrEqual(4096);
    expect(capture.bytesRetained).toBe(Buffer.byteLength(capture.text, 'utf8'));
  });
});
