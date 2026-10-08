import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InvalidNodeUidError } from '../../journal/errors.js';
import {
  GitCommandError, UnsafeWorldPathError, WorldHeadError, WorldNotARepoError,
} from '../errors.js';
import { WorldRepo, type WorldCommitInfo } from '../world.js';
import {
  commitAs, committedContent, committedPaths, gitIn, useWorld, worldLog, writeWorldFile,
} from './helpers.js';

const fixture = useWorld('node-world-');

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** The index lock path of a world repo. */
function indexLock(world: WorldRepo): string {
  return join(world.path, '.git', 'index.lock');
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

const [dir, uid, rounds] = process.argv.slice(2);
const email = uid + '@world.local';
const env = { ...process.env,
  GIT_AUTHOR_NAME: uid, GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: uid, GIT_COMMITTER_EMAIL: email };
const TOLERATED_STDERR = /index\\.lock|cannot lock ref|Another git process seems to be running|nothing to commit/i;
const report = join(dir, 'peer-unexpected.txt');
let unexpected = 0;
const run = (args, options = {}) => new Promise((resolve) => {
  execFile('git', args, { cwd: dir, ...options }, (err, _out, stderr) => {
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
    expect((await gitIn(world.path, ['log', '-1', '--format=%an', commit?.hash ?? 'nope'])).trim()).toBe('n1');
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
    const peer: ChildProcess = spawn(process.execPath, [script, world.path, 'peer', '30'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
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
      const tree = new Set((await gitIn(world.path, ['ls-tree', '-r', '--name-only', 'HEAD']))
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
    expect((await gitIn(world.path, ['log', '--format=%an <%ae>'])).trim())
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

  it('ignores an inherited GIT_DIR and commits the world it was opened on', async () => {
    const { world } = fixture();
    const other = await WorldRepo.init(join(dirname(world.path), 'world-b'));
    await writeWorldFile(world, 'a.txt', 'one');
    vi.stubEnv('GIT_DIR', join(other.path, '.git'));
    try {
      const commit = await world.commitAll('n1', 'turn 0');
      expect(commit?.author).toBe('n1');
      // The world moved; the repo the environment pointed at did not. The
      // assertions go through the kernel's own calls, whose environment is
      // controlled — the raw test helper would still inherit the stubbed var.
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
    const hooks = join(world.path, '.git', 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\nprintf "hijacked\\n" > "$1"\n');
    await chmod(join(hooks, 'prepare-commit-msg'), 0o755);
    await writeWorldFile(world, 'a.txt', 'one');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit).not.toBeNull();
    expect((await gitIn(world.path, ['log', '--format=%s'])).trim()).toBe('turn 0');
  });

  it('refuses a world that is the real path of a symlinked HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-home-'));
    const realHome = join(root, 'real-home');
    const link = join(root, 'home-link');
    await mkdir(realHome, { recursive: true });
    await symlink(realHome, link);
    vi.stubEnv('HOME', link);
    try {
      // HOME itself is a symlink: `homedir()` returns the link, so the guard must
      // resolve it before comparing, or the 200 GB safeguard is bypassed.
      await expect(WorldRepo.open(realHome)).rejects.toBeInstanceOf(UnsafeWorldPathError);
      await expect(WorldRepo.init(realHome)).rejects.toBeInstanceOf(UnsafeWorldPathError);
      await expect(WorldRepo.open(link)).rejects.toBeInstanceOf(UnsafeWorldPathError);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a linked worktree of the world repo', async () => {
    const { world } = fixture();
    await commitAs(world, 'n2', { 'a.txt': 'one' });
    const linked = join(dirname(world.path), 'linked-worktree');
    await gitIn(world.path, ['worktree', 'add', '--detach', linked]);
    // A linked worktree shares the world's object database and refs but has its
    // own git dir; accepting it would make the wake predicate and the diff read
    // a tree the kernel does not own.
    await expect(WorldRepo.open(linked)).rejects.toBeInstanceOf(WorldNotARepoError);
  });

  it('refuses a repository with a separated git dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-sep-'));
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await gitIn(repo, ['init', '--separate-git-dir', join(root, 'gitdir')]);
    await expect(WorldRepo.open(repo)).rejects.toBeInstanceOf(WorldNotARepoError);
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a world whose .git is a symlink to another repository', async () => {
    // A symlinked `.git` resolves to a real git dir elsewhere, so a realpath
    // comparison cannot see it: the world would share and write another
    // repository's objects and refs. The dedicated-repo contract needs the
    // entry itself to be a real directory, checked with lstat.
    const root = await mkdtemp(join(tmpdir(), 'node-gitlink-'));
    const real = join(root, 'real');
    const world = join(root, 'world');
    await mkdir(world, { recursive: true });
    await WorldRepo.init(real);
    await symlink(join(real, '.git'), join(world, '.git'));
    try {
      await expect(WorldRepo.open(world)).rejects.toBeInstanceOf(WorldNotARepoError);
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
      await WorldRepo.init(world);
      await chmod(secret, 0o000);
      vi.stubEnv('HOME', join(secret, 'home'));
      try {
        await expect(WorldRepo.open(world)).rejects.toMatchObject({ code: 'EACCES' });
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
    await gitIn(world.path, ['checkout', '--detach', '--quiet', 'HEAD']);
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
    const commitMessageFile = join(world.path, '.git', 'COMMIT_EDITMSG');
    await rm(commitMessageFile, { force: true });
    await mkdir(commitMessageFile, { recursive: true });
    await writeWorldFile(world, 'a.txt', 'one');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit?.author).toBe('n1');
    expect((await gitIn(world.path, ['log', '--format=%s', '-1'])).trim()).toBe('turn 0');
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
      `printf 'COLLIDER\\n' > '${world.path}/.git/COMMIT_EDITMSG' 2>/dev/null`,
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
    expect((await gitIn(world.path, ['log', '--format=%s', '-1'])).trim()).toBe('turn 0');
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
    const body = [
      `if [ ! -f '${once}' ]; then`,
      '  case " $* " in',
      '    *" commit-tree "*)',
      `      '${real}' "$@"`,
      '      out=$?',
      `      : > '${once}'`,
      `      ref=$('${real}' symbolic-ref -q HEAD)`,
      `      old=$('${real}' rev-parse --verify "$ref")`,
      `      tree=$('${real}' rev-parse --verify "$ref^{tree}")`,
      `      p=$(${peer} '${real}' -c commit.gpgsign=false commit-tree "$tree" -p "$old" -m 'peer advance')`,
      `      ${peer} '${real}' update-ref "$ref" "$p" "$old"`,
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
    const tree = new Set((await gitIn(world.path, ['ls-tree', '-r', '--name-only', 'HEAD']))
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
      `    *" commit-tree "*) : > '${once}'; '${real}' symbolic-ref HEAD refs/heads/other ;;`,
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
    expect((await gitIn(world.path, ['rev-parse', '--verify', 'refs/heads/main'])).trim())
      .toBe(base?.hash);
  });

  it('commits on an unborn branch through the compare-and-swap path', async () => {
    const { world } = fixture();
    // A fresh world: HEAD is a symbolic ref to an unborn branch, so the CAS
    // expects the all-zero object id of the repository's SHA-1 format.
    expect(await world.headHash()).toBeNull();
    expect((await gitIn(world.path, ['rev-parse', '--show-object-format'])).trim()).toBe('sha1');
    await writeWorldFile(world, 'a.txt', 'one');
    const commit = await world.commitAll('n1', 'turn 0');
    expect(commit?.author).toBe('n1');
    expect(commit?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(await world.headHash()).toBe(commit?.hash);
  });

  it('sizes the zero object id from a SHA-256 repository format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'node-sha256-'));
    const dir = join(root, 'world');
    await mkdir(dir, { recursive: true });
    await gitIn(dir, ['init', '--quiet', '--object-format=sha256', '--initial-branch=main']);
    try {
      const world = await WorldRepo.open(dir);
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
