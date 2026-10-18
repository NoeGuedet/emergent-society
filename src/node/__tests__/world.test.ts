import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import {
  chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InvalidNodeUidError } from '../../journal/index.js';
import {
  GitCommandError, UnsafeWorldPathError, WorldHeadError, WorldNotARepoError,
} from '../errors.js';
import { WorldRepo, gitEnv, type WorldCommitInfo } from '../world.js';
import {
  commitAs, committedContent, committedPaths, gitIn, gitRaw, useWorld, worldLog, writeWorldFile,
} from './helpers.js';

const fixture = useWorld('node-world-');

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** Runs git against the opened world with stdin — for hand-crafted objects only. */
function gitWithInput(world: WorldRepo, args: readonly string[], input: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', [...world.gitBaseArgs(), ...args], { cwd: world.path, env: gitEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(stderr));
    });
    child.stdin.end(input);
  });
}

/** The index lock path of a world repo. */
function indexLock(world: WorldRepo): string {
  return join(world.gitDir, 'index.lock');
}

/** The number of live entries in the per-repo commit queue (a white-box probe). */
function commitQueueSize(): number {
  return (WorldRepo as unknown as { commitQueues: Map<string, unknown> }).commitQueues.size;
}

/** The real git binary, resolved from PATH before any wrapper is installed on it. */
function realGitPath(): string {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'git');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next PATH entry */ }
  }
  throw new Error('git is not on PATH');
}

/**
 * Installs a `git` wrapper in a test-owned directory, to be prepended to PATH.
 * This is the child-process boundary of the git dependency: production resolves
 * git through PATH — the controlled environment strips git *context* variables,
 * never PATH — so a wrapper here coordinates real git invocations without
 * mocking the kernel.
 */
async function installGitShim(root: string, name: string, body: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'git'), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, 'git'), 0o755);
  return dir;
}

/**
 * The observable for the config-injection tests: a git clean filter that runs as
 * an external command during `add` if the injected config reaches git. It drops
 * a marker and returns a distinguishable payload, so both "an external command
 * ran" and "the blob is not the raw file" are observable on the *current*
 * plumbing path (`add --all` then `write-tree`/`commit-tree`).
 */
async function installEvilCleanFilter(root: string): Promise<{ marker: string; script: string }> {
  const marker = join(root, 'clean-filter-ran');
  const script = join(root, 'evil-clean.sh');
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nprintf 'FILTERED\\n'\n`);
  await chmod(script, 0o755);
  return { marker, script };
}

/** Writes a worktree that would run the evil clean filter if its config applied. */
async function writeFilteredWorktree(world: WorldRepo): Promise<void> {
  await writeWorldFile(world, '.gitattributes', '*.payload filter=evil\n');
  await writeWorldFile(world, 'data.payload', 'raw\n');
}

/**
 * A second writer in a second process: the shape of another kernel, or of a
 * hand at a terminal. It writes and commits in a loop, tolerating a lock the
 * kernel holds — its files are picked up by a later round or by the kernel's
 * final commit, which is what "no lost commit" means here.
 *
 * The tolerated set is exactly the two non-cooperative facts of a shared repo:
 * git's index/ref lock, and the `COMMIT_EDITMSG` collision that two concurrent
 * `git commit -m` invocations can cause (git writes the message to that shared
 * file and reads it back; a peer can empty it in between — the root cause this
 * task diagnoses). Any other error is a fixture bug and exits non-zero, so the
 * test never shrugs one off; the collision itself is asserted separately, at a
 * controlled boundary, rather than through this nondeterministic peer.
 */
const PEER_SCRIPT = `
import { execFile } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [dir, gitDir, uid, rounds] = process.argv.slice(2);
const email = uid + '@world.local';
const env = { ...process.env,
  GIT_AUTHOR_NAME: uid, GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: uid, GIT_COMMITTER_EMAIL: email };
const TOLERATED_STDERR = /index\\.lock|cannot lock ref|Another git process seems to be running|nothing to commit/i;
const report = join(dir, 'peer-unexpected.txt');
let unexpected = 0;
const PAIR = ['--git-dir', gitDir, '--work-tree', dir];
const run = (args, options = {}) => new Promise((resolve) => {
  execFile('git', [...PAIR, ...args], { cwd: dir, ...options }, (err, _out, stderr) => {
    // The tolerated outcomes are exactly the non-cooperative facts of a shared
    // working tree: git's index/ref lock, the kernel's branch compare-and-swap
    // losing to this peer, and "nothing to commit" — which --quiet signals as
    // exit 1 with an empty stderr, the same signal the kernel's own commit reads.
    // A message-file collision is no longer tolerated: the kernel commits through
    // plumbing that never touches COMMIT_EDITMSG, so it cannot collide with this
    // peer, and the peer is the only writer of that file.
    const nothingToCommit = (err && err.code === 1 && stderr.trim() === '');
    if (err && !nothingToCommit && !TOLERATED_STDERR.test(stderr)) {
      unexpected += 1;
      appendFile(report, 'git ' + args.join(' ') + ': ' + stderr + '\\n').catch(() => {});
    }
    resolve();
  });
});
for (let i = 0; i < Number(rounds); i += 1) {
  await writeFile(join(dir, uid + '-' + i + '.md'), uid + ' ' + i + '\\n');
  await run(['add', '--all']);
  await run(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', uid + ' ' + i], { env });
}
if (unexpected > 0) process.stderr.write(await readFile(report, 'utf8').catch(() => ''));
process.exit(unexpected === 0 ? 0 : 1);
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

  it('serves the whole history when HEAD moved backward behind the watermark', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    const first = await world.commitAll('n1', 'turn 0');
    const second = await commitAs(world, 'n2', { 'b.txt': 'two' });
    // A peer's force-reset to an ancestor leaves HEAD !== watermark but an empty
    // `watermark..HEAD` range. That is not "no movement": the node cannot prove
    // it has seen this history, so it is given the whole of it.
    await gitIn(world, ['reset', '--hard', first?.hash ?? '']);
    expect((await world.commitsSince(second)).map((c) => c.hash)).toEqual([first?.hash]);
  });

  it('answers the wake predicate from authors without materializing the range', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    const first = await world.commitAll('n1', 'turn 0');
    const second = await commitAs(world, 'n2', { 'b.txt': 'two' });
    expect(await world.hasForeignCommit(null, 'n1')).toBe(true);
    expect(await world.hasForeignCommit(first?.hash ?? null, 'n1')).toBe(true);
    expect(await world.hasForeignCommit(first?.hash ?? null, 'n2')).toBe(false);
    expect(await world.hasForeignCommit(second, 'n1')).toBe(false);
    expect(await world.hasForeignCommit(second, 'n2')).toBe(false);
    // An unreachable watermark is unprovable, so the whole history answers.
    expect(await world.hasForeignCommit('a'.repeat(40), 'n1')).toBe(true);
  });

  it('stops the author scan at the first foreign commit in a long history', async () => {
    const { world } = fixture();
    for (let i = 0; i < 16; i += 1) {
      await writeWorldFile(world, `own/${i}.md`, String(i));
      await world.commitAll('n1', `turn ${i}`);
    }
    // A history of this node's own commits alone is silent.
    expect(await world.hasForeignCommit(null, 'n1')).toBe(false);
    const head = await commitAs(world, 'n2', { 'n2/last.md': 'last' });
    // The newest commit is foreign, so the streamed scan answers without walking
    // the sixteen own commits behind it.
    expect(await world.hasForeignCommit(null, 'n1')).toBe(true);
    expect(await world.hasForeignCommit(head, 'n1')).toBe(false);
  });

  it('classifies an author record past the bound as foreign', async () => {
    const { world } = fixture();
    // The stream stops buffering an identity this long: a record over 4096 chars
    // without its NUL separator cannot be a node uid, so it answers foreign and
    // kills the scan rather than holding it in memory. git accepts the name.
    const long = 'x'.repeat(5000);
    await commitAs(world, long, { 'long/a.md': 'a' });
    expect(await world.hasForeignCommit(null, 'n1')).toBe(true);
  });

  it('treats a hand-crafted empty author as foreign, never as silence', async () => {
    const { world } = fixture();
    const first = await commitAs(world, 'n2', { 'a.txt': 'one' });
    const tree = (await gitIn(world, ['rev-parse', `${first}^{tree}`])).trim();
    // A raw commit object outside the kernel's writer: `author <>` has no name,
    // so `%an` is the empty string. `--literally` is required because fsck would
    // otherwise refuse to write the deliberately malformed object.
    const raw = `tree ${tree}\nparent ${first}\nauthor <> 1700000000 +0000\n`
      + 'committer n2 <n2@world.local> 1700000000 +0000\n\nempty author\n';
    const crafted = (await gitWithInput(
      world, ['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], raw,
    )).trim();
    await gitIn(world, ['update-ref', 'refs/heads/main', crafted]);
    // commitsSince reports the empty author as ''; the wake predicate refuses an
    // unprovable author, so the two agree instead of the latter missing a wake.
    expect((await world.commitsSince(first)).map((c) => c.author)).toEqual(['']);
    expect(await world.hasForeignCommit(first, 'n2')).toBe(true);
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
    const second = await WorldRepo.open(world.path, { gitDir: world.gitDir });
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

  it('returns the exact commit it authored, not a peer commit landing after it', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'n1/a.md', 'mine');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit?.author).toBe('n1');
    // A peer commits behind it: HEAD is the peer's now, but the hash this call
    // named is its own, read back from git, and the peer's is untouched.
    const peer = await commitAs(world, 'n2', { 'n2/theirs.md': 'theirs' });
    expect(await world.headHash()).toBe(peer);
    expect(commit?.hash).not.toBe(peer);
    expect(await worldLog(world)).toEqual([`${commit?.hash} n1`, `${peer} n2`]);
    expect((await gitIn(world, ['log', '-1', '--format=%an', commit?.hash ?? 'nope'])).trim()).toBe('n1');
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
    // The peer inherits the controlled git environment, so its own `process.env`
    // (spread into the commit env below) cannot carry a host GIT_DIR or config.
    const peer: ChildProcess = spawn(
      process.execPath, [script, world.path, world.gitDir, 'peer', '30'],
      { stdio: ['ignore', 'ignore', 'pipe'], env: gitEnv() });
    let peerStderr = '';
    peer.stderr?.on('data', (chunk: Buffer) => { peerStderr += chunk.toString('utf8'); });
    let exitCode: number | null = null;
    const exited = new Promise<void>((resolvePromise, rejectPromise) => {
      peer.on('exit', (code) => { exitCode = code; resolvePromise(); });
      peer.on('error', rejectPromise);
    });

    try {
      // Ten turns' worth of commits, racing the peer for the index and the ref.
      let contended = 0;
      for (let i = 0; i < 10; i += 1) {
        await writeWorldFile(world, `n1/${i}.md`, String(i));
        try {
          const commit = await world.commitAll('n1', `turn ${i}`);
          if (commit !== null) mine.push(commit);
        } catch (err) {
          // The one permitted loss is the one the kernel documents: contention
          // (index/ref lock, or this peer winning the branch compare-and-swap)
          // held past the bounded retries is *reported*, not retried forever.
          // The round names no commit; its writes stay in the tree for the final
          // commit to pick up. Anything else is a real failure.
          const isContended = err instanceof GitCommandError
            && /index\.lock|cannot lock ref|Another git process seems to be running/i.test(err.stderr);
          if (!isContended) throw err;
          contended++;
        }
      }
      await exited;
      // The peer must have died of its own accord, not of an ignored fixture
      // error: its non-zero exit is a fact this test refuses to swallow.
      if (exitCode !== 0) {
        throw new Error(`peer exited ${exitCode} with unexpected git errors:\n${peerStderr}`);
      }
      // Whatever the peer left staged is still the world's: the kernel's own
      // commit picks it up rather than leaving it unattributed.
      await world.commitAll('n1', 'final');

      // No death, and never a foreign hash: every commit this node named is one it
      // authored, and every commit it named is really in the world's history.
      expect(mine.length, `named commits ${mine.length}, lock losses ${contended}`).toBeGreaterThan(0);
      const history = await worldLog(world);
      const hashes = new Set(history.map((line) => line.split(' ')[0]));
      for (const commit of mine) {
        expect(commit.author).toBe('n1');
        expect(hashes.has(commit.hash)).toBe(true);
      }
      expect(history.every((line) => line.endsWith(' n1') || line.endsWith(' peer'))).toBe(true);

      // No lost commit: every file either writer produced is in HEAD's tree.
      const tree = new Set((await gitIn(world, ['ls-tree', '-r', '--name-only', 'HEAD']))
        .split('\n').filter((line) => line !== ''));
      for (let i = 0; i < 10; i += 1) expect(tree.has(`n1/${i}.md`)).toBe(true);
      for (let i = 0; i < 30; i += 1) expect(tree.has(`peer-${i}.md`)).toBe(true);
    } finally {
      // Teardown must never race a live writer: a peer still committing while
      // the fixture removes the root is how the ENOTEMPTY teardown flake arose.
      // Kill only the child this test owns, and wait for it to be reaped.
      if (peer.exitCode === null && peer.signalCode === null) {
        peer.kill('SIGKILL');
        await exited.catch(() => {});
      }
    }
  }, 30_000);

  it('surfaces a git failure as a typed error', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    await world.commitAll('n1', 'turn 0');
    await rm(world.gitDir, { recursive: true, force: true });
    await expect(world.headHash()).rejects.toBeInstanceOf(GitCommandError);
  });

  it('refuses a directory that is not a git repository root', async () => {
    const { world } = fixture();
    const plain = await mkdtemp(join(tmpdir(), 'node-plain-'));
    // There is no git directory at all: a legacy world, refused with the
    // sanitizing migration in the message.
    await expect(WorldRepo.open(plain, { gitDir: join(plain, 'absent.git') }))
      .rejects.toBeInstanceOf(WorldNotARepoError);
    // A world that is a subdirectory of another repository would commit the
    // tree above it at every turn-end (kernel.md §7); the pair check refuses it
    // because the external git dir records the surrounding root as its worktree.
    await mkdir(join(world.path, 'nested'), { recursive: true });
    await expect(WorldRepo.open(join(world.path, 'nested'), { gitDir: world.gitDir }))
      .rejects.toBeInstanceOf(WorldNotARepoError);
    await rm(plain, { recursive: true, force: true });
  });

  it('reports a missing world directory in the node error family', async () => {
    const absent = join(tmpdir(), `node-absent-${process.pid}-${Date.now()}`);
    const gitDir = `${absent}-git`;
    await expect(WorldRepo.open(absent, { gitDir })).rejects.toBeInstanceOf(WorldNotARepoError);
    const world = await WorldRepo.init(absent, { gitDir });
    expect(world.gitDir).toBe(await realpath(gitDir));
    await rm(absent, { recursive: true, force: true });
    await rm(gitDir, { recursive: true, force: true });
  });

  it('refuses $HOME and a broad root as the world', async () => {
    // The world guard runs before the git dir is touched, so the dummy value
    // only has to exist as a path.
    const gitDir = join(tmpdir(), 'node-dummy.git');
    await expect(WorldRepo.open(homedir(), { gitDir })).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await expect(WorldRepo.open('/', { gitDir })).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await expect(WorldRepo.open(tmpdir(), { gitDir })).rejects.toBeInstanceOf(UnsafeWorldPathError);
  });

  it('refuses a symlink that resolves to $HOME, before anything is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-link-'));
    const link = join(root, 'world');
    await symlink(homedir(), link);
    // The safeguard is about the directory the kernel would really commit, not
    // about the string it was handed: `init` must refuse before `git init`.
    const gitDir = join(root, 'world.git');
    await expect(WorldRepo.open(link, { gitDir })).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await expect(WorldRepo.init(link, { gitDir })).rejects.toBeInstanceOf(UnsafeWorldPathError);
    await rm(root, { recursive: true, force: true });
  });

  it('follows a symlink to a dedicated directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-link-'));
    const target = join(root, 'real-world');
    const gitDir = join(root, 'real-world.git');
    await WorldRepo.init(target, { gitDir });
    const link = join(root, 'linked-world');
    await symlink(target, link);
    const world = await WorldRepo.open(link, { gitDir });
    // The repo is addressed by its canonical path, which is also the key the
    // commit queue and the watcher are shared by.
    expect(world.path).toBe(await realpath(target));
    await rm(root, { recursive: true, force: true });
  });

  it('initializes a repo with the untracked cache enabled', async () => {
    const { world } = fixture();
    expect((await gitIn(world, ['config', 'core.untrackedCache'])).trim()).toBe('true');
  });

  it('refuses an invalid uid as the commit author before any effect', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    await expect(world.commitAll('../escape', 'turn 0')).rejects.toBeInstanceOf(InvalidNodeUidError);
    // No `add`, no commit, no staged index: validation precedes every effect.
    expect(await world.headHash()).toBeNull();
    expect(await world.commitsSince(null)).toEqual([]);
  });

  it('writes a valid dotted/hyphenated/underscored uid as the exact git author', async () => {
    // A valid uid must survive as itself through git's identity fields — no
    // sanitizing, no punctuation loss — or the wake predicate could not match it.
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    const commit = await world.commitAll('a.b-c_1', 'turn 0');
    expect(commit?.author).toBe('a.b-c_1');
    expect((await gitIn(world, ['log', '--format=%an <%ae>'])).trim())
      .toBe('a.b-c_1 <a.b-c_1@world.local>');
  });

  it('retains a foreign git author name on read rather than rejecting it', async () => {
    // A human's name is an external fact the git layer must preserve: only the
    // kernel's own writes are constrained to uids, never history already made.
    const { world } = fixture();
    const human = await commitAs(world, 'Ada Human', { 'a.txt': 'one' });
    expect(await world.commitsSince(null)).toEqual([{ hash: human, author: 'Ada Human' }]);
    expect((await world.commitsIn({ from: null, to: human }, 4096)).commits)
      .toEqual([{ hash: human, author: 'Ada Human' }]);
  });

  it('ignores an inherited GIT_DIR pointing at another repository\'s git dir', async () => {
    const { world } = fixture();
    const other = await WorldRepo.init(
      join(dirname(world.path), 'world-b'), { gitDir: join(dirname(world.path), 'world-b.git') });
    await writeWorldFile(world, 'a.txt', 'one');
    vi.stubEnv('GIT_DIR', other.gitDir);
    try {
      const commit = await world.commitAll('n1', 'turn 0');
      expect(commit?.author).toBe('n1');
      // The world moved; the repo the environment pointed at did not. The
      // assertions go through the kernel's own calls; `helpers.gitIn` applies the
      // same controlled environment, so either path ignores the stubbed var.
      expect(await world.headHash()).toBe(commit?.hash);
      expect(await world.commitsSince(null)).toEqual([{ hash: commit?.hash, author: 'n1' }]);
      expect(await other.headHash()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores injected GIT_CONFIG_COUNT/KEY/VALUE config on the current commit path', async () => {
    // A clean filter configured through the injected list would be an external
    // command git runs during `add` — an observable effect on the *new* plumbing
    // path, unlike a hook (which `commit-tree` can never run regardless of env).
    const { world } = fixture();
    const root = dirname(world.path);
    const { marker, script } = await installEvilCleanFilter(root);
    await writeFilteredWorktree(world);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'filter.evil.clean');
    vi.stubEnv('GIT_CONFIG_VALUE_0', script);
    let commit: WorldCommitInfo | null = null;
    try {
      commit = await world.commitAll('n1', 'turn 0');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(commit?.author).toBe('n1');
    await expect(stat(marker)).rejects.toThrow();
    // The blob is the raw file, not the filter's output.
    expect(await committedContent(world, 'data.payload')).toBe('raw\n');
  });

  it('ignores a host gitconfig that configures a clean filter', async () => {
    const { world } = fixture();
    const root = dirname(world.path);
    const { marker, script } = await installEvilCleanFilter(root);
    const cfg = join(root, 'global.gitconfig');
    await writeFile(cfg, `[filter "evil"]\n\tclean = ${script}\n`);
    await writeFilteredWorktree(world);
    vi.stubEnv('GIT_CONFIG_GLOBAL', cfg);
    let commit: WorldCommitInfo | null = null;
    try {
      commit = await world.commitAll('n1', 'turn 0');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(commit?.author).toBe('n1');
    await expect(stat(marker)).rejects.toThrow();
    expect(await committedContent(world, 'data.payload')).toBe('raw\n');
  });

  it('strips GIT_CONFIG_PARAMETERS so an injected clean filter never runs on add', async () => {
    // `GIT_CONFIG_PARAMETERS` is git's other `-c`-equivalent env channel (a
    // shell-quoted list), and it is honoured by every call without a
    // command-line counterpart — `add --all` among them.
    const { world } = fixture();
    const root = dirname(world.path);
    const { marker, script } = await installEvilCleanFilter(root);
    await writeFilteredWorktree(world);
    vi.stubEnv('GIT_CONFIG_PARAMETERS', `'filter.evil.clean=${script}'`);
    let commit: WorldCommitInfo | null = null;
    try {
      commit = await world.commitAll('n1', 'turn 0');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(commit?.author).toBe('n1');
    await expect(stat(marker)).rejects.toThrow();
    expect(await committedContent(world, 'data.payload')).toBe('raw\n');
  });

  it('ignores a world hook that rewrites the shared COMMIT_EDITMSG file', async () => {
    // Characterization of the hook policy, not proof of the env strip: the
    // plumbing commit runs no hooks at all, so this holds with or without
    // `core.hooksPath`. It still guards a regression back to `git commit`, and it
    // is the deterministic boundary proof of why `git commit` used to be unsafe:
    // git writes the message to `.git/COMMIT_EDITMSG` and reads it back, so any
    // writer of that file can hijack the message.
    const { world } = fixture();
    const hooks = join(world.gitDir, 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\nprintf "hijacked\\n" > "$1"\n');
    await chmod(join(hooks, 'prepare-commit-msg'), 0o755);
    await writeWorldFile(world, 'a.txt', 'one');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit).not.toBeNull();
    expect((await gitIn(world, ['log', '--format=%s'])).trim()).toBe('turn 0');
  });

  it('refuses a world that is the real path of a symlinked HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-home-'));
    const realHome = join(root, 'real-home');
    const link = join(root, 'home-link');
    await mkdir(realHome, { recursive: true });
    await symlink(realHome, link);
    vi.stubEnv('HOME', link);
    const gitDir = join(root, 'dummy.git');
    try {
      // HOME itself is a symlink: `homedir()` returns the link, so the guard must
      // resolve it before comparing, or the 200 GB safeguard is bypassed.
      await expect(WorldRepo.open(realHome, { gitDir })).rejects.toBeInstanceOf(UnsafeWorldPathError);
      await expect(WorldRepo.init(realHome, { gitDir })).rejects.toBeInstanceOf(UnsafeWorldPathError);
      await expect(WorldRepo.open(link, { gitDir })).rejects.toBeInstanceOf(UnsafeWorldPathError);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a linked worktree of the world repo', async () => {
    const { world } = fixture();
    await commitAs(world, 'n2', { 'a.txt': 'one' });
    const linked = join(dirname(world.path), 'linked-worktree');
    await gitIn(world, ['worktree', 'add', '--detach', linked]);
    // A linked worktree carries a `.git` gitfile, not a git dir of its own, and
    // the real external git dir records the world root as its worktree: the pair
    // check refuses the linked path.
    await expect(WorldRepo.open(linked, { gitDir: world.gitDir }))
      .rejects.toBeInstanceOf(WorldNotARepoError);
  });

  it('refuses a repository with a separated git dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-sep-'));
    const repo = join(root, 'repo');
    const gitDir = join(root, 'gitdir');
    await mkdir(repo, { recursive: true });
    await gitRaw(repo, ['init', '--separate-git-dir', gitDir]);
    // The separated git dir carries no absolute `core.worktree`, so the pair
    // cannot be verified.
    await expect(WorldRepo.open(repo, { gitDir })).rejects.toBeInstanceOf(WorldNotARepoError);
    await rm(root, { recursive: true, force: true });
  });

  it('ignores an in-world .git entry (directory, file or symlink)', async () => {
    // The kernel addresses its external git dir explicitly, so a root-level
    // `.git` the agent creates - or one carried over from a legacy world - is
    // never read. Refusing it would hand the shell a permanent boot denial via
    // `mkdir .git`; the git dir's trust is what is checked, not the worktree.
    const root = await mkdtemp(join(tmpdir(), 'node-gitlink-'));
    const world = join(root, 'world');
    const gitDir = join(root, 'world.git');
    await WorldRepo.init(world, { gitDir });
    const entry = join(world, '.git');
    const expectOpens = async (): Promise<void> => {
      const reopened = await WorldRepo.open(world, { gitDir });
      expect(reopened.gitDir).toBe(await realpath(gitDir));
    };
    try {
      await mkdir(entry, { recursive: true });
      await expectOpens();
      await rm(entry, { recursive: true, force: true });
      await writeFile(entry, 'gitdir: /nonexistent\n');
      await expectOpens();
      await rm(entry);
      const other = join(root, 'other.git');
      await mkdir(other, { recursive: true });
      await symlink(other, entry);
      await expectOpens();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'propagates an unreadable HOME instead of guessing the safeguard comparison',
    async () => {
      // `realpathOrSelf` must swallow only ENOENT: an EACCES on HOME is an
      // environment failure, and hiding it behind a string comparison would
      // silently weaken the dedicated-directory safeguard.
      const root = await mkdtemp(join(tmpdir(), 'node-home-eacces-'));
      const secret = join(root, 'secret');
      const world = join(root, 'world');
      await mkdir(secret, { recursive: true });
      const gitDir = join(root, 'world.git');
      await WorldRepo.init(world, { gitDir });
      await chmod(secret, 0o000);
      vi.stubEnv('HOME', join(secret, 'home'));
      try {
        await expect(WorldRepo.open(world, { gitDir })).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        vi.unstubAllEnvs();
        await chmod(secret, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('drops a finished commit queue without disturbing a later queued commit', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    const results = await Promise.all([
      world.commitAll('n1', 'turn 0'), world.commitAll('n2', 'turn 1'), world.commitAll('n3', 'turn 2'),
    ]);
    // One commit and two no-ops: serially queued, not raced. A queue entry that
    // is pruned while a later commit still points at it would let that later
    // commit run concurrently with a peer.
    expect(results.filter((c) => c !== null)).toHaveLength(1);
    expect(await worldLog(world)).toHaveLength(1);
    await new Promise((r) => { setImmediate(r); });
    expect(commitQueueSize()).toBe(0);
  });

  it('refuses to commit when HEAD is detached', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'a.txt', 'one');
    const first = await world.commitAll('n1', 'turn 0');
    expect(first).not.toBeNull();
    await gitIn(world, ['checkout', '--detach', '--quiet', 'HEAD']);
    await writeWorldFile(world, 'b.txt', 'two');
    // The kernel publishes to one named branch; a detached HEAD has none, so it
    // fails closed rather than guessing which ref to move.
    await expect(world.commitAll('n1', 'turn 1')).rejects.toBeInstanceOf(WorldHeadError);
    expect(await world.headHash()).toBe(first?.hash);
  });

  it('commits the exact message even when the shared COMMIT_EDITMSG is unusable', async () => {
    // The strongest deterministic form of the collision the flake hit: the file
    // `git commit` writes and reads back cannot be opened for writing at all.
    // A kernel that commits through it fails; one that uses plumbing does not
    // look at it.
    const { world } = fixture();
    const commitMessageFile = join(world.gitDir, 'COMMIT_EDITMSG');
    await rm(commitMessageFile, { force: true });
    await mkdir(commitMessageFile, { recursive: true });
    await writeWorldFile(world, 'a.txt', 'one');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit?.author).toBe('n1');
    expect((await gitIn(world, ['log', '--format=%s', '-1'])).trim()).toBe('turn 0');
  });

  it('keeps PATH and commits the exact message under a collider at the git boundary', async () => {
    const { world } = fixture();
    const root = dirname(world.path);
    const marker = join(root, 'shim-ran');
    const collider = join(root, 'collider-message.txt');
    const real = realGitPath();
    // The wrapper is the child-process boundary. Every invocation marks itself
    // and lets a foreign writer own COMMIT_EDITMSG; for a `git commit` it serves
    // that foreign message, which is exactly the read-back the race hits.
    const body = [
      `printf 'ran\\n' >> '${marker}'`,
      `printf 'COLLIDER\\n' > '${collider}'`,
      'case " $* " in',
      `  *" commit "*) exec '${real}' -c commit.gpgsign=false commit --quiet --no-verify --file '${collider}' ;;`,
      'esac',
      `printf 'COLLIDER\\n' > '${world.gitDir}/COMMIT_EDITMSG' 2>/dev/null`,
      `exec '${real}' "$@"`,
    ].join('\n');
    const shimDir = await installGitShim(root, 'shim-bin', body);
    await writeWorldFile(world, 'a.txt', 'one');
    vi.stubEnv('PATH', `${shimDir}:${process.env['PATH'] ?? ''}`);
    let commit: WorldCommitInfo | null = null;
    try {
      commit = await world.commitAll('n1', 'turn 0');
      // PATH survived the controlled environment: the wrapper really ran.
      expect(await readFile(marker, 'utf8')).toContain('ran');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(commit?.author).toBe('n1');
    expect((await gitIn(world, ['log', '--format=%s', '-1'])).trim()).toBe('turn 0');
  });

  it('retries a compare-and-swap conflict and keeps both histories', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'base.txt', 'base');
    const base = await world.commitAll('n1', 'base');
    expect(base).not.toBeNull();

    const root = dirname(world.path);
    const once = join(root, 'cas-once');
    const real = realGitPath();
    const peer = 'GIT_AUTHOR_NAME=peer GIT_AUTHOR_EMAIL=peer@world.local '
      + 'GIT_COMMITTER_NAME=peer GIT_COMMITTER_EMAIL=peer@world.local';
    // After the kernel builds its commit object, an external kernel advances the
    // branch with a plumbing commit of the same tree (an empty change), exactly
    // once: the CAS must lose, and the retry must keep both histories.
    const pair = `'${real}' --git-dir '${world.gitDir}' --work-tree '${world.path}'`;
    const body = [
      `if [ ! -f '${once}' ]; then`,
      '  case " $* " in',
      '    *" commit-tree "*)',
      `      '${real}' "$@"`,
      '      out=$?',
      `      : > '${once}'`,
      `      ref=$(${pair} symbolic-ref -q HEAD)`,
      `      old=$(${pair} rev-parse --verify "$ref")`,
      `      tree=$(${pair} rev-parse --verify "$ref^{tree}")`,
      `      p=$(${peer} ${pair} -c commit.gpgsign=false commit-tree "$tree" -p "$old" -m 'peer advance')`,
      `      ${peer} ${pair} update-ref "$ref" "$p" "$old"`,
      '      exit $out ;;',
      '  esac',
      'fi',
      `exec '${real}' "$@"`,
    ].join('\n');
    const shimDir = await installGitShim(root, 'cas-shim', body);
    vi.stubEnv('PATH', `${shimDir}:${process.env['PATH'] ?? ''}`);
    let commit: WorldCommitInfo | null = null;
    try {
      await writeWorldFile(world, 'ours.txt', 'ours');
      commit = await world.commitAll('n1', 'turn 0');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(commit?.author).toBe('n1');
    expect(commit?.hash).not.toBe(base?.hash);
    const log = await worldLog(world);
    // The peer's advance and the kernel's commit are both retained, the kernel's
    // rebased onto the peer's by the whole-attempt retry.
    expect(log.map((line) => line.split(' ')[1])).toEqual(['n1', 'peer', 'n1']);
    // The returned hash is ours and is in history — never the peer's.
    expect(log.some((line) => line.startsWith(commit?.hash ?? 'nope'))).toBe(true);
    // No file is lost: HEAD holds the base and both writers' files.
    const tree = new Set((await gitIn(world, ['ls-tree', '-r', '--name-only', 'HEAD']))
      .split('\n').filter((line) => line !== ''));
    expect(tree.has('base.txt')).toBe(true);
    expect(tree.has('ours.txt')).toBe(true);
  });

  it('refuses to publish when HEAD switches branch during the commit', async () => {
    const { world } = fixture();
    await writeWorldFile(world, 'base.txt', 'base');
    const base = await world.commitAll('n1', 'base');
    const root = dirname(world.path);
    const once = join(root, 'switch-once');
    const real = realGitPath();
    const body = [
      `if [ ! -f '${once}' ]; then`,
      '  case " $* " in',
      `    *" commit-tree "*) : > '${once}'; '${real}' --git-dir '${world.gitDir}' --work-tree '${world.path}' symbolic-ref HEAD refs/heads/other ;;`,
      '  esac',
      'fi',
      `exec '${real}' "$@"`,
    ].join('\n');
    const shimDir = await installGitShim(root, 'switch-shim', body);
    await writeWorldFile(world, 'ours.txt', 'ours');
    vi.stubEnv('PATH', `${shimDir}:${process.env['PATH'] ?? ''}`);
    try {
      // A host checkout lands between the snapshot and the publish: publishing
      // would move a branch HEAD no longer names, so it fails closed.
      await expect(world.commitAll('n1', 'turn 0')).rejects.toBeInstanceOf(WorldHeadError);
    } finally {
      vi.unstubAllEnvs();
    }
    // The branch the kernel snapshotted did not move to its commit.
    expect((await gitIn(world, ['rev-parse', '--verify', 'refs/heads/main'])).trim())
      .toBe(base?.hash);
  });

  it('commits on an unborn branch through the compare-and-swap path', async () => {
    const { world } = fixture();
    // A fresh world: HEAD is a symbolic ref to an unborn branch, so the CAS
    // expects the all-zero object id of the repository's SHA-1 format.
    expect(await world.headHash()).toBeNull();
    expect((await gitIn(world, ['rev-parse', '--show-object-format'])).trim()).toBe('sha1');
    await writeWorldFile(world, 'a.txt', 'one');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit?.author).toBe('n1');
    expect(commit?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(await world.headHash()).toBe(commit?.hash);
  });

  it('sizes the zero object id from a SHA-256 repository format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-sha256-'));
    const dir = join(root, 'world');
    const gitDir = join(root, 'world.git');
    await mkdir(dir, { recursive: true });
    await gitRaw(dir, [
      '--git-dir', gitDir, '--work-tree', dir,
      'init', '--quiet', '--object-format=sha256', '--initial-branch=main',
    ]);
    try {
      const world = await WorldRepo.open(dir, { gitDir });
      await writeWorldFile(world, 'a.txt', 'one');
      const first = await world.commitAll('n1', 'turn 0');
      expect(first?.hash).toMatch(/^[0-9a-f]{64}$/);
      // The second commit exercises the existing-branch CAS on the same format.
      await writeWorldFile(world, 'b.txt', 'two');
      const second = await world.commitAll('n1', 'turn 1');
      expect(second?.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await world.headHash()).toBe(second?.hash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The attack and migration battery for the external git dir (arbitration 11).
 * Each test reproduces an escape the in-world git dir allowed, or the migration
 * a legacy world needs, against a real git repository.
 */
describe('the world git trust layers', () => {
  /** Creates a world and its external git dir under a fresh temp root. */
  async function freshWorld(prefix: string): Promise<{ root: string; world: WorldRepo }> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const world = await WorldRepo.init(join(root, 'world'), { gitDir: join(root, 'world.git') });
    return { root, world };
  }

  it('keeps the clean-filter escape closed', async () => {
    const { world } = fixture();
    const root = dirname(world.path);
    const marker = join(root, 'clean-canary');
    const script = join(root, 'clean.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nprintf 'FILTERED\\n'\n`);
    await chmod(script, 0o755);
    // The attack the in-world git dir made possible: the agent writes the
    // repository config and a selecting attribute, and the kernel's `add`
    // would run the filter as the kernel. The kernel's explicit --git-dir never
    // reads this entry, so the filter has no configuration at all.
    const stray = join(world.path, '.git');
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, 'config'), `[filter "x"]\n\tclean = ${script}\n`);
    await writeFile(join(world.path, '.gitattributes'), '*.payload filter=x\n');
    await writeFile(join(world.path, 'data.payload'), 'raw\n');

    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit?.author).toBe('n1');
    await expect(stat(marker)).rejects.toThrow();
    expect(await committedContent(world, 'data.payload')).toBe('raw\n');
  });

  it('keeps a worktree .git and nested repos out of history', async () => {
    const { world } = fixture();
    const stray = join(world.path, '.git');
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, 'config'), '[filter "x"]\n\tclean = /bin/true\n');

    // A committed nested repository is staged as a 160000 gitlink by a plain
    // `add --all`; its object lives only in the agent's repo, so the durable
    // tree would reference an unresolvable object.
    const nested = join(world.path, 'my sub');
    await mkdir(nested, { recursive: true });
    await gitRaw(nested, ['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(nested, 'inside.txt'), 'nested\n');
    await gitRaw(nested, ['add', '--all']);
    const inner = gitEnv({
      GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'agent@world.local',
      GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'agent@world.local',
    });
    await gitRaw(nested, ['commit', '--quiet', '-m', 'nested commit'], inner);
    await writeWorldFile(world, 'note.txt', 'note\n');

    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit).not.toBeNull();
    const paths = await committedPaths(world);
    expect(paths).toContain('note.txt');
    expect(paths.filter((rel) => rel === '.git' || rel.startsWith('.git/'))).toEqual([]);
    expect(paths.filter((rel) => rel === 'my sub' || rel.startsWith('my sub/'))).toEqual([]);
    const listing = await gitIn(world, ['ls-tree', '-r', 'HEAD']);
    expect(listing).not.toContain('160000');
    expect(await committedContent(world, 'my sub/inside.txt')).toBeNull();
    // The stray root `.git` must not deny a later boot.
    await expect(WorldRepo.open(world.path, { gitDir: world.gitDir }))
      .resolves.toBeInstanceOf(WorldRepo);
  });

  it('refuses a mismatched pair, a relative worktree and a failing scan', async () => {
    const a = await freshWorld('node-pair-a-');
    const b = await freshWorld('node-pair-b-');
    try {
      // B's root with A's git dir: A's config names A's root as its worktree.
      await expect(WorldRepo.open(b.world.path, { gitDir: a.world.gitDir }))
        .rejects.toBeInstanceOf(WorldNotARepoError);
      // A relative `core.worktree` resolves against the git dir: refused rather
      // than guessed in either direction.
      await gitIn(a.world, ['config', 'core.worktree', '../relative']);
      await expect(WorldRepo.open(a.world.path, { gitDir: a.world.gitDir }))
        .rejects.toBeInstanceOf(WorldNotARepoError);
      // A cyclic include makes the scan exit nonzero: a refusal, never "empty".
      await gitIn(a.world, ['config', 'core.worktree', a.world.path]);
      await gitIn(a.world, ['config', 'include.path', join(a.world.gitDir, 'config')]);
      await expect(WorldRepo.open(a.world.path, { gitDir: a.world.gitDir }))
        .rejects.toBeInstanceOf(WorldNotARepoError);
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(b.root, { recursive: true, force: true });
    }
  });

  it('refuses every untrusted git-dir shape, and opens past the loose-object budget', async () => {
    const commitOnce = async (world: WorldRepo): Promise<void> => {
      await writeWorldFile(world, 'a.txt', 'one');
      await world.commitAll('n1', 'turn 0');
    };
    const variants: ReadonlyArray<{
      readonly name: string;
      readonly sabotage: (world: WorldRepo) => Promise<void>;
    }> = [
      {
        name: 'a filter key',
        sabotage: async (world) => { await gitIn(world, ['config', 'filter.x.clean', '/bin/true']); },
      },
      {
        name: 'config.worktree content',
        sabotage: async (world) => {
          await gitIn(world, ['config', 'extensions.worktreeConfig', 'true']);
          await writeFile(join(world.gitDir, 'config.worktree'),
            '[filter "y"]\n\tclean = /bin/true\n');
        },
      },
      {
        name: 'extensions.worktreeConfig',
        sabotage: async (world) => {
          await gitIn(world, ['config', 'extensions.worktreeConfig', 'true']);
        },
      },
      {
        name: 'an include.path',
        sabotage: async (world) => {
          const extra = join(world.path, 'extra.cfg');
          await writeFile(extra, '[filter "z"]\n\tclean = /bin/true\n');
          await gitIn(world, ['config', 'include.path', extra]);
        },
      },
      {
        name: 'a symlinked config',
        sabotage: async (world) => {
          const config = join(world.gitDir, 'config');
          await rename(config, join(world.gitDir, 'config.real'));
          await symlink('config.real', config);
        },
      },
      {
        name: 'a symlinked hooks directory',
        sabotage: async (world) => {
          await rename(join(world.gitDir, 'hooks'), join(world.gitDir, 'hooks.real'));
          await symlink('hooks.real', join(world.gitDir, 'hooks'));
        },
      },
      {
        name: 'a symlinked refs/heads',
        sabotage: async (world) => {
          await rename(join(world.gitDir, 'refs', 'heads'), join(world.gitDir, 'heads.real'));
          await symlink('heads.real', join(world.gitDir, 'refs', 'heads'));
        },
      },
      {
        name: 'a hardlinked branch ref',
        sabotage: async (world) => {
          await commitOnce(world);
          await link(join(world.gitDir, 'refs', 'heads', 'main'),
            join(world.gitDir, 'heads-alias'));
        },
      },
      {
        name: 'info/grafts',
        sabotage: async (world) => {
          await writeFile(join(world.gitDir, 'info', 'grafts'), '');
        },
      },
      {
        name: 'shallow',
        sabotage: async (world) => {
          await writeFile(join(world.gitDir, 'shallow'), '');
        },
      },
      {
        name: 'objects/info/alternates',
        sabotage: async (world) => {
          await writeFile(join(world.gitDir, 'objects', 'info', 'alternates'), '/tmp\n');
        },
      },
      {
        name: 'log.showSignature',
        sabotage: async (world) => { await gitIn(world, ['config', 'log.showSignature', 'true']); },
      },
      {
        name: 'remote.*.promisor',
        sabotage: async (world) => {
          await gitIn(world, ['config', 'remote.origin.promisor', 'true']);
        },
      },
    ];

    for (const variant of variants) {
      const { root, world } = await freshWorld('node-trust-');
      try {
        await variant.sabotage(world);
        await expect(
          WorldRepo.open(world.path, { gitDir: world.gitDir }), variant.name,
        ).rejects.toBeInstanceOf(WorldNotARepoError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    // The budget counts metadata, not loose-object payload: ten thousand and
    // one payload files is an ordinary long-lived world, not an attack.
    const { root, world } = await freshWorld('node-budget-');
    try {
      const dir = join(world.gitDir, 'objects', 'aa');
      await mkdir(dir, { recursive: true });
      const names = Array.from({ length: 10_001 }, (_, i) => i.toString(16).padStart(38, '0'));
      for (let at = 0; at < names.length; at += 256) {
        await Promise.all(names.slice(at, at + 256).map(
          (name) => writeFile(join(dir, name), '')));
      }
      await expect(WorldRepo.open(world.path, { gitDir: world.gitDir }))
        .resolves.toBeInstanceOf(WorldRepo);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('kills the lazy-fetch escape at the scan and at the belt', async () => {
    // Layer 1: a promisor or partial-clone configuration never gets as far as
    // a missing object.
    for (const [key, value] of [
      ['remote.origin.promisor', 'true'],
      ['extensions.partialClone', 'origin'],
    ] as const) {
      const { root, world } = await freshWorld('node-lazy-scan-');
      try {
        await gitIn(world, ['config', key, value]);
        await expect(WorldRepo.open(world.path, { gitDir: world.gitDir }))
          .rejects.toBeInstanceOf(WorldNotARepoError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    // Layer 4: even a configuration written after open must fail closed. The
    // fixture is live — without the belt the transport helper really runs.
    const { world } = fixture();
    const root = dirname(world.path);
    const canary = join(root, 'lazy-canary');
    const helper = join(root, 'lazy-helper.sh');
    await writeFile(helper, `#!/bin/sh\ntouch '${canary}'\n`);
    await chmod(helper, 0o755);
    await writeWorldFile(world, 'a.txt', 'hello\n');
    await world.commitAll('n1', 'turn 0');
    // `protocol.ext.allow=always` is required: git's own default refuses `ext`,
    // and without it the test would prove nothing.
    await gitIn(world, ['config', 'protocol.ext.allow', 'always']);
    await gitIn(world, ['config', 'remote.origin.url', `ext::${helper}`]);
    await gitIn(world, ['config', 'remote.origin.promisor', 'true']);
    await gitIn(world, ['config', 'extensions.partialClone', 'origin']);
    const tree = (await gitIn(world, ['rev-parse', 'HEAD^{tree}'])).trim();
    await rm(join(world.gitDir, 'objects', tree.slice(0, 2), tree.slice(2)), { force: true });

    // Positive control: an empty GIT_NO_LAZY_FETCH disables the belt.
    await expect(gitIn(world, ['diff', '--cached', '--quiet'],
      gitEnv({ GIT_NO_LAZY_FETCH: '' }))).rejects.toThrow();
    expect((await stat(canary)).isFile()).toBe(true);
    await rm(canary, { force: true });

    // The belt: `gitEnv` carries GIT_NO_LAZY_FETCH, so git fails closed rather
    // than fetching — and the helper never runs.
    await expect(gitIn(world, ['diff', '--cached', '--quiet'])).rejects.toThrow();
    await expect(stat(canary)).rejects.toThrow();
  }, 30_000);

  it('makes a planted git-dir hook inert at publish', async () => {
    const { world } = fixture();
    const canary = join(dirname(world.path), 'hook-canary');
    const hooks = join(world.gitDir, 'hooks');
    await mkdir(hooks, { recursive: true });
    const hook = join(hooks, 'reference-transaction');
    await writeFile(hook, `#!/bin/sh\ntouch '${canary}'\n`);
    await chmod(hook, 0o755);

    await writeWorldFile(world, 'a.txt', 'one');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit?.author).toBe('n1');
    // The blanket `-c core.hooksPath=/dev/null` covers `update-ref`'s hook.
    await expect(stat(canary)).rejects.toThrow();
  });

  it('commits past an unborn nested repository', async () => {
    const { world } = fixture();
    const sub = join(world.path, 'sub');
    await mkdir(sub, { recursive: true });
    await gitRaw(sub, ['init', '--quiet', '--initial-branch=main']);
    await writeWorldFile(world, 'note.txt', 'note\n');

    // A plain `add --all` fails the whole turn with "does not have a commit
    // checked out"; the pathspec exclusion is what keeps the turn committable.
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit).not.toBeNull();
    const paths = await committedPaths(world);
    expect(paths).toContain('note.txt');
    expect(paths.filter((rel) => rel === 'sub' || rel.startsWith('sub/'))).toEqual([]);
  });
});
