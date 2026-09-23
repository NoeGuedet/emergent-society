import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GitCommandError, UnsafeWorldPathError, WorldNotARepoError } from '../errors.js';
import { WorldRepo } from '../world.js';
import {
  commitAs, committedContent, committedPaths, gitIn, useWorld, worldLog, writeWorldFile,
} from './helpers.js';

const fixture = useWorld('node-world-');

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** The index lock path of a world repo. */
function indexLock(world: WorldRepo): string {
  return join(world.path, '.git', 'index.lock');
}

/**
 * A second writer in a second process: the shape of another kernel, or of a
 * hand at a terminal. It writes and commits in a loop, tolerating a lock the
 * kernel holds — its files are picked up by a later round or by the kernel's
 * final commit, which is what "no lost commit" means here.
 */
const PEER_SCRIPT = `
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [dir, uid, rounds] = process.argv.slice(2);
const email = uid + '@world.local';
const env = { ...process.env,
  GIT_AUTHOR_NAME: uid, GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: uid, GIT_COMMITTER_EMAIL: email };
const run = (args, options = {}) => new Promise((resolve) => {
  execFile('git', args, { cwd: dir, ...options }, () => resolve());
});
for (let i = 0; i < Number(rounds); i += 1) {
  await writeFile(join(dir, uid + '-' + i + '.md'), uid + ' ' + i + '\\n');
  await run(['add', '--all']);
  await run(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', uid + ' ' + i], { env });
}
`;

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
      { hash: first?.hash, author: 'n1' },
      { hash: second, author: 'n2' },
      { hash: third, author: 'n3' },
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

  it('waits out a lock another process holds, and commits once it frees', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    // A peer's turn-end in flight: git refuses to create the index lock.
    await writeFile(indexLock(world), '');
    const committing = world.commitAll('n1', 'turn 0');
    await delay(15);
    await rm(indexLock(world));
    const commit = await committing;
    expect(commit?.author).toBe('n1');
    expect(await worldLog(world)).toEqual([`${commit?.hash} n1`]);
  });

  it('reports a lock held past the bounded retries instead of retrying forever', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    await writeFile(indexLock(world), '');
    await expect(world.commitAll('n1', 'turn 0')).rejects.toThrow(/index\.lock/);
    await rm(indexLock(world));
    expect(await world.headHash()).toBeNull();
  });

  it('names its own commit when another process commits behind it', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'n1/a.md', 'mine');
    type Loose = { commitsSince(from: string | null): Promise<unknown> };
    const loose = world as unknown as Loose;
    const real = loose.commitsSince.bind(world);
    // A peer commits between our commit and our read of HEAD: the newest commit
    // is not ours any more. Naming it would join this turn's journal entry to
    // another node's turn.
    const spy = vi.spyOn(loose, 'commitsSince').mockImplementation(async (from: string | null) => {
      await commitAs(world, 'n2', { 'n2/theirs.md': 'theirs' });
      spy.mockRestore();
      return real(from);
    });
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit?.author).toBe('n1');
    const log = await worldLog(world);
    expect(log.map((line) => line.split(' ')[1])).toEqual(['n1', 'n2']);
    expect(log.some((line) => line.startsWith(commit?.hash ?? 'nope'))).toBe(true);
  });

  it('records no commit when a peer takes the staged tree first', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'n1/a.md', 'mine');
    type Loose = { nothingStaged(): Promise<boolean> };
    const loose = world as unknown as Loose;
    const real = loose.nothingStaged.bind(world);
    // The peer commits the very tree we staged, between our check and our
    // commit: `git commit` then exits 1 with an empty stderr.
    const spy = vi.spyOn(loose, 'nothingStaged').mockImplementation(async () => {
      const staged = await real();
      await commitAs(world, 'n2', {});
      spy.mockRestore();
      return staged;
    });
    expect(await world.commitAll('n1', 'turn 0')).toBeNull();
    expect((await worldLog(world)).map((line) => line.split(' ')[1])).toEqual(['n2']);
    // The effect is in the world all the same: attribution is commit-granular
    // (kernel.md §5.2), and the journal still records that this turn wrote it.
    expect(await committedContent(world, 'n1/a.md')).toBe('mine');
  });

  it('survives a second process committing to the same world', async () => {
    const { world } = fixture();
    // One commit before the peer exists, so the invariant "the kernel's own
    // commit is in the world" holds whatever the race does to the rest.
    await writeWorldFile(world, 'n1/before.md', 'before');
    const first = await world.commitAll('n1', 'turn -1');
    expect(first?.author).toBe('n1');
    if (first === null) throw new Error('the world refused its first commit');
    const mine = [first];

    const script = join(dirname(world.path), 'peer.mjs');
    await writeFile(script, PEER_SCRIPT);
    const peer = spawn(process.execPath, [script, world.path, 'peer', '30'], { stdio: 'ignore' });
    const exited = new Promise<void>((resolvePromise, rejectPromise) => {
      peer.on('exit', () => { resolvePromise(); });
      peer.on('error', rejectPromise);
    });

    // Ten turns' worth of commits, racing the peer for the index and the ref.
    for (let i = 0; i < 10; i += 1) {
      await writeWorldFile(world, `n1/${i}.md`, String(i));
      const commit = await world.commitAll('n1', `turn ${i}`);
      if (commit !== null) mine.push(commit);
    }
    await exited;
    // Whatever the peer left staged is still the world's: the kernel's own
    // commit picks it up rather than leaving it unattributed.
    await world.commitAll('n1', 'final');

    // No death, and never a foreign hash: every commit this node named is one it
    // authored, and every commit it named is really in the world's history.
    expect(mine.length).toBeGreaterThan(0);
    const history = await worldLog(world);
    const hashes = new Set(history.map((line) => line.split(' ')[0]));
    for (const commit of mine) {
      expect(commit.author).toBe('n1');
      expect(hashes.has(commit.hash)).toBe(true);
    }
    expect(history.every((line) => line.endsWith(' n1') || line.endsWith(' peer'))).toBe(true);

    // No lost commit: every file either writer produced is in HEAD's tree.
    const tree = new Set((await gitIn(world.path, ['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n').filter((line) => line !== ''));
    for (let i = 0; i < 10; i += 1) expect(tree.has(`n1/${i}.md`)).toBe(true);
    for (let i = 0; i < 30; i += 1) expect(tree.has(`peer-${i}.md`)).toBe(true);
  }, 30_000);

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

  it('reports a missing world directory in the node error family', async () => {
    const absent = join(tmpdir(), `node-absent-${process.pid}-${Date.now()}`);
    await expect(WorldRepo.open(absent)).rejects.toBeInstanceOf(WorldNotARepoError);
    await expect(WorldRepo.init(absent)).resolves.toBeInstanceOf(WorldRepo);
    await rm(absent, { recursive: true, force: true });
  });

  it('refuses $HOME and a broad root as the world', async () => {
    await expect(WorldRepo.open(homedir())).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await expect(WorldRepo.open('/')).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await expect(WorldRepo.open(tmpdir())).rejects.toBeInstanceOf(UnsafeWorldPathError);
  });

  it('refuses a symlink that resolves to $HOME, before anything is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-link-'));
    const link = join(root, 'world');
    await symlink(homedir(), link);
    // The safeguard is about the directory the kernel would really commit, not
    // about the string it was handed: `init` must refuse before `git init`.
    await expect(WorldRepo.open(link)).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await expect(WorldRepo.init(link)).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await rm(root, { recursive: true, force: true });
  });

  it('follows a symlink to a dedicated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-link-'));
    const target = join(root, 'real-world');
    await WorldRepo.init(target);
    const link = join(root, 'linked-world');
    await symlink(target, link);
    const world = await WorldRepo.open(link);
    // The repo is addressed by its canonical path, which is also the key the
    // commit queue and the watcher are shared by.
    expect(world.path).toBe(await realpath(target));
    await rm(root, { recursive: true, force: true });
  });

  it('initializes a repo with the untracked cache enabled', async () => {
    const { world } = fixture();
    expect((await gitIn(world.path, ['config', 'core.untrackedCache'])).trim()).toBe('true');
  });
});
