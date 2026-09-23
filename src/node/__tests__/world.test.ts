import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCommandError, UnsafeWorldPathError, WorldNotARepoError } from '../errors.js';
import { WorldRepo } from '../world.js';
import {
  commitAs, committedContent, committedPaths, gitIn, useWorld, worldLog, writeWorldFile,
} from './helpers.js';

const fixture = useWorld('node-world-');

describe('the world repo', () => {
  it('starts unborn and holds no commit', async () => {
    const { world } = fixture();
    expect(await world.headHash()).toBeNull();
    expect(await world.commitsSince(null)).toEqual([]);
  });

  it('commits the working tree with the node uid as author', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'notes/a.md', 'hello');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit).not.toBeNull();
    expect(commit?.author).toBe('n1');
    expect(commit?.parent).toBeNull();
    expect(await world.headHash()).toBe(commit?.hash);
    expect(await committedPaths(world)).toEqual(['notes/a.md']);
    expect(await committedContent(world, 'notes/a.md')).toBe('hello');
    // The identity is read back from git, not assumed: authorship in git is the
    // fact the wake predicate reads.
    expect(await worldLog(world)).toEqual([`${commit?.hash} n1`]);
  });

  it('returns null and moves nothing when the tree is unchanged', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    const first = await world.commitAll('n1', 'turn 0');
    expect(await world.commitAll('n1', 'turn 1')).toBeNull();
    expect(await world.headHash()).toBe(first?.hash);
    expect(await worldLog(world)).toHaveLength(1);
  });

  it('commits a deletion', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    await world.commitAll('n1', 'turn 0');
    await rm(join(world.path, 'a.txt'));
    expect(await world.commitAll('n1', 'turn 1')).not.toBeNull();
    expect(await committedContent(world, 'a.txt')).toBeNull();
  });

  it('honours .gitignore: a file the world does not track is not committed', async () => {
    // A documented choice, not an accident: the git layer shows what the
    // society shares, and a node that keeps a file out of it still has its
    // writes journaled.
    const { world } = fixture();
    await writeWorldFile(world, '.gitignore', 'scratch/\n');
    await world.commitAll('n1', 'turn 0');
    await writeWorldFile(world, 'scratch/private.txt', 'x');
    expect(await world.commitAll('n1', 'turn 1')).toBeNull();
  });

  it('serves a range oldest first, with the author of each commit', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    const first = await world.commitAll('n1', 'turn 0');
    const second = await commitAs(world, 'n2', { 'b.txt': 'two' });
    const third = await commitAs(world, 'n3', { 'c.txt': 'three' });

    expect(await world.commitsSince(null)).toEqual([
      { hash: first?.hash, author: 'n1', parent: null },
      { hash: second, author: 'n2', parent: first?.hash },
      { hash: third, author: 'n3', parent: second },
    ]);
    // The range is exclusive of the watermark: what HEAD has that it does not.
    expect((await world.commitsSince(first?.hash ?? null)).map((c) => c.author)).toEqual(['n2', 'n3']);
    expect(await world.commitsSince(third)).toEqual([]);
  });

  it('serves the whole history when the watermark is no longer reachable', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    await world.commitAll('n1', 'turn 0');
    // A hash that names nothing: a rewritten history or a gc'd object. The node
    // cannot prove what it has seen, so it is given everything.
    expect((await world.commitsSince('a'.repeat(40))).map((c) => c.author)).toEqual(['n1']);
  });

  it('serializes concurrent commits so the loser waits instead of failing', async () => {
    const { world } = fixture();
    // Two writers on one working tree, which is what two drivers sharing the
    // world are. Unserialized, git's index lock turns one of them into a failed
    // commit — a turn whose effects were never attributed.
    await writeWorldFile(world, 'a.txt', 'one');
    const results = await Promise.all([
      world.commitAll('n1', 'turn 0'), world.commitAll('n2', 'turn 0'),
    ]);
    expect(results.filter((c) => c !== null)).toHaveLength(1);
    expect(await worldLog(world)).toHaveLength(1);
  });

  it('serializes the commits of two instances over the same repo', async () => {
    const { world } = fixture();
    const second = await WorldRepo.open(world.path);
    await writeWorldFile(world, 'a.txt', 'one');
    const results = await Promise.all([
      world.commitAll('n1', 'turn 0'), second.commitAll('n2', 'turn 0'),
    ]);
    expect(results.filter((c) => c !== null)).toHaveLength(1);
    expect(await worldLog(world)).toHaveLength(1);
  });

  it('surfaces a git failure as a typed error', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    await world.commitAll('n1', 'turn 0');
    await rm(join(world.path, '.git'), { recursive: true, force: true });
    await expect(world.headHash()).rejects.toBeInstanceOf(GitCommandError);
  });

  it('refuses a directory that is not a git repository root', async () => {
    const { world } = fixture();
    const plain = await mkdtemp(join(tmpdir(), 'node-plain-'));
    await expect(WorldRepo.open(plain)).rejects.toBeInstanceOf(WorldNotARepoError);
    // A world that is a subdirectory of another repository would commit the
    // tree above it at every turn-end (kernel.md §7).
    await mkdir(join(world.path, 'nested'), { recursive: true });
    await expect(WorldRepo.open(join(world.path, 'nested')))
      .rejects.toBeInstanceOf(WorldNotARepoError);
    await rm(plain, { recursive: true, force: true });
  });

  it('refuses $HOME and a broad root as the world', async () => {
    await expect(WorldRepo.open(homedir())).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await expect(WorldRepo.open('/')).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await expect(WorldRepo.open(tmpdir())).rejects.toBeInstanceOf(UnsafeWorldPathError);
  });

  it('initializes a repo with the untracked cache enabled', async () => {
    const { world } = fixture();
    expect((await gitIn(world.path, ['config', 'core.untrackedCache'])).trim()).toBe('true');
  });
});
