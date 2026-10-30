import { mkdir, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commitAll, commitAllRefused, nothingStaged, type CommitRefusal,
} from '../world-commit.js';
import { DEFAULT_COMMIT_LIMITS, type CommitLimits } from '../limits.js';
import { runGit, runGitWithStdin, type WorldIo } from '../world-git.js';
import { WorldRepo } from '../world.js';
import { useWorld } from './helpers.js';

/**
 * The commit path's two budgets. The pre-add walk refuses a world too large or
 * a file too big BEFORE any git child exists (the walk runs first, so an empty
 * index is the proof that `add` never ran); the post-add staged budget refuses
 * after `add` and deliberately LEAVES THE INDEX STAGED. Both are the typed
 * `budget` refusal — the driver's existing refusal carrier, not a new one.
 *
 * The limits are injected parameters with production defaults: the boundary
 * tests use small values, while the incident sizes (26,497 files, a 2 GB
 * sparse file, a 300k-entry world) run against the production defaults.
 */

const fixture = useWorld('node-commit-budget-');

/** The open repository's io surface, exactly as the repository binds it. */
function ioOf(world: WorldRepo): WorldIo {
  const io: WorldIo = {
    path: world.path,
    gitDir: world.gitDir,
    baseArgs: () => world.gitBaseArgs(),
    head: () => world.headHash(),
    nothingStaged: () => nothingStaged(io),
    git: (args, env) => runGit(world.path, [...world.gitBaseArgs(), ...args], env),
    gitWithStdin: (args, input) =>
      runGitWithStdin(world.path, [...world.gitBaseArgs(), ...args], input),
    format: async () => 'sha1',
  };
  return io;
}

const budget = (overrides: Partial<CommitLimits>): CommitLimits => ({
  ...DEFAULT_COMMIT_LIMITS, ...overrides,
});

/** The staged paths the index holds; empty means no `add` ran in this attempt. */
async function stagedPaths(world: WorldRepo): Promise<string[]> {
  const out = await runGit(world.path, [...world.gitBaseArgs(), 'ls-files', '-z']);
  return out.split('\0').filter((path) => path !== '');
}

async function write(world: WorldRepo, rel: string, content: string): Promise<void> {
  const path = join(world.path, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe('the pre-add walk budget', () => {
  it('accepts exactly the entry bound', async () => {
    const { world } = fixture();
    for (let i = 0; i < 8; i += 1) await write(world, `f${i}.txt`, 'x');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxWalkEntries: 8 })),
    );
    expect(attempt.refusal).toBeNull();
    expect(attempt.commit).not.toBeNull();
  });

  it('refuses one entry over the bound, before any git child', async () => {
    const { world } = fixture();
    for (let i = 0; i < 9; i += 1) await write(world, `f${i}.txt`, 'x');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxWalkEntries: 8 })),
    );
    expect(attempt.refusal).toMatchObject({ reason: 'budget' });
    expect(attempt.refusal?.detail).toContain('exceeds 8 entries');
    // The walk runs before `add`: the index is untouched, so nothing was staged.
    expect(await stagedPaths(world)).toEqual([]);
    expect(await world.headHash()).toBeNull();
  });

  it('accepts a file exactly at the apparent-size bound', async () => {
    const { world } = fixture();
    await write(world, 'a.txt', 'abcd');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxFileApparentBytes: 4 })),
    );
    expect(attempt.refusal).toBeNull();
    expect(attempt.commit).not.toBeNull();
  });

  it('refuses a file one byte over the apparent-size bound', async () => {
    const { world } = fixture();
    await write(world, 'a.txt', 'abcde');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxFileApparentBytes: 4 })),
    );
    expect(attempt.refusal).toMatchObject({ reason: 'budget' });
    expect(attempt.refusal?.detail).toContain('5 bytes');
    expect(await stagedPaths(world)).toEqual([]);
  });

  it('refuses a 2 GB sparse file by apparent size before `add` (production limits)', async () => {
    const { world } = fixture();
    // A created-then-truncated file is sparse: apparent size over the cap, ~0 disk.
    const huge = join(world.path, 'huge.bin');
    await writeFile(huge, '');
    await truncate(huge, 2 * 1024 * 1024 * 1024);
    const attempt = await commitAllRefused(() => commitAll(ioOf(world), 'n1', 'turn 0'));
    expect(attempt.refusal).toMatchObject({ reason: 'budget' });
    expect(attempt.refusal?.detail).toContain(String(64 * 1024 * 1024));
    expect(await stagedPaths(world)).toEqual([]);
  });

  it('commits the 26,497-file incident world under the production defaults', { timeout: 120_000 }, async () => {
    const { world } = fixture();
    const total = 26_497;
    // A directory distribution, not one flat directory: the walk's one residual
    // is that a flat `readdir` is materialized before the entry count is known.
    for (let d = 0; d < 100; d += 1) await mkdir(join(world.path, `d${d}`), { recursive: true });
    for (let i = 0; i < total; i += 1) {
      await writeFile(join(world.path, `d${i % 100}`, `f${i}`), '');
    }
    const attempt = await commitAllRefused(() => commitAll(ioOf(world), 'n1', 'turn 0'));
    expect(attempt.refusal).toBeNull();
    expect(attempt.commit).not.toBeNull();
    expect(await world.headHash()).toBe(attempt.commit?.hash);
    expect(await stagedPaths(world)).toHaveLength(total);
  });

  it('refuses a 300k-entry world as a typed budget, not an OOM', { timeout: 180_000 }, async () => {
    const { world } = fixture();
    for (let d = 0; d < 30; d += 1) {
      const dir = join(world.path, `d${d}`);
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < 10_000; i += 1) await writeFile(join(dir, `f${i}`), '');
    }
    const attempt = await commitAllRefused(() => commitAll(ioOf(world), 'n1', 'turn 0'));
    expect(attempt.refusal).toMatchObject({ reason: 'budget' });
    expect(attempt.refusal?.detail).toContain('100000');
    expect(await stagedPaths(world)).toEqual([]);
    expect(await world.headHash()).toBeNull();
  });

  it('keeps the refusal detail bounded and host-relative', async () => {
    const { world } = fixture();
    await write(world, 'a.txt', 'abc');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxWalkEntries: 0 })),
    );
    const refusal: CommitRefusal | null = attempt.refusal;
    expect(refusal?.reason).toBe('budget');
    expect(refusal?.detail).not.toContain(world.path);
  });
});

describe('the post-add staged budget', () => {
  it('accepts exactly the staged-path bound', async () => {
    const { world } = fixture();
    for (let i = 0; i < 3; i += 1) await write(world, `f${i}.txt`, 'x');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxStagedPaths: 3 })),
    );
    expect(attempt.refusal).toBeNull();
    expect(attempt.commit).not.toBeNull();
  });

  it('refuses one staged path over the bound, leaving the index staged', async () => {
    const { world } = fixture();
    for (let i = 0; i < 4; i += 1) await write(world, `f${i}.txt`, 'x');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxStagedPaths: 3 })),
    );
    expect(attempt.refusal).toMatchObject({ reason: 'budget' });
    expect(attempt.refusal?.detail).toContain('staged paths exceed 3');
    // The refusal is post-add: the index keeps everything `add` staged.
    expect(await stagedPaths(world)).toHaveLength(4);
    expect(await world.headHash()).toBeNull();
  });

  it('accepts exactly the staged-byte bound', async () => {
    const { world } = fixture();
    await write(world, 'a.txt', 'aaaa');
    await write(world, 'b.txt', 'bbbbbb');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxStagedBytes: 10 })),
    );
    expect(attempt.refusal).toBeNull();
    expect(attempt.commit).not.toBeNull();
  });

  it('refuses one staged byte over the bound, leaving the index staged', async () => {
    const { world } = fixture();
    await write(world, 'a.txt', 'aaaa');
    await write(world, 'b.txt', 'bbbbbbb');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 0', budget({ maxStagedBytes: 10 })),
    );
    expect(attempt.refusal).toMatchObject({ reason: 'budget' });
    expect(attempt.refusal?.detail).toContain('staged bytes exceed 10');
    expect(await stagedPaths(world)).toHaveLength(2);
    expect(await world.headHash()).toBeNull();
  });

  it('measures the turn delta, not the whole index: a large committed world commits one file', async () => {
    const { world } = fixture();
    for (let i = 0; i < 8; i += 1) await write(world, `base${i}.txt`, 'x');
    await commitAll(ioOf(world), 'n1', 'seed', budget({}));
    await write(world, 'delta.txt', 'y');
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 1', budget({ maxStagedPaths: 1 })),
    );
    // The world holds 9 committed paths; only the one-file delta is budgeted.
    expect(attempt.refusal).toBeNull();
    expect(attempt.commit).not.toBeNull();
  });

  it('does not refuse a no-op turn on a large committed world', async () => {
    const { world } = fixture();
    for (let i = 0; i < 8; i += 1) await write(world, `base${i}.txt`, 'x');
    await commitAll(ioOf(world), 'n1', 'seed', budget({}));
    const attempt = await commitAllRefused(
      () => commitAll(ioOf(world), 'n1', 'turn 1', budget({ maxStagedPaths: 1 })),
    );
    expect(attempt).toEqual({ commit: null, refusal: null });
  });
});
