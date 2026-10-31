import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitCommandError } from '../errors.js';
import {
  failureOf, MUTATING_GIT_SUBCOMMANDS, isMutatingGit, probeWorldLock, runGit, runGitWithStdin,
  worldIndexLockPath, worldLockPath, type WorldLockState,
} from '../world-git.js';
import { classifyCommitFailure, commitAllRefused } from '../world-commit.js';
import { writeWorldFile } from './helpers.js';
import { useWorld, type WorldFixture } from './helpers.js';

/**
 * The C3 process policy against a REAL flock and a fake `git`/`flock` on PATH:
 * the mutating flock wrapper (exec form, derived lock path, held-lock
 * contention), the per-call deadlines (kill the whole flock process group,
 * await the close, type the failure), and the timeout's proven-stale
 * `index.lock` cleanup.
 *
 * A fake binary on PATH is the seam: it needs no production switch, and the
 * tests can make a git child sleep or a flock disappear without touching the
 * host. The real git is still the fallback in the fake scripts, so nothing here
 * re-implements git.
 */

const REAL_GIT = '/usr/bin/git';
const fixture = useWorld('node-world-flock-');
let root = '';
let originalPath: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'es-flock-bin-'));
  originalPath = process.env['PATH'];
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  await rm(root, { recursive: true, force: true });
  root = '';
});

/** Installs executable fake binaries and puts them first on PATH. */
async function fakeBins(files: Record<string, string>): Promise<string> {
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const path = join(bin, name);
    await writeFile(path, body, 'utf8');
    await chmod(path, 0o755);
  }
  process.env['PATH'] = `${bin}:${originalPath ?? '/usr/bin:/bin'}`;
  return bin;
}

/** A git shim that delegates every call to the real git, sleeping when a marker exists. */
function sleepyGit(marker: string): string {
  return `#!/bin/sh
for a in "$@"; do
  case "$a" in
    write-tree|add|hash-object) if [ -e "${marker}" ]; then sleep 30; fi ;;
  esac
done
exec ${REAL_GIT} "$@"
`;
}

/** A git shim that creates the index or a ref lock and then sleeps. */
function lockingGit(marker: string, ref: string): string {
  const touch = ref === ''
    ? ': > "$gd/index.lock"'
    : `mkdir -p "$gd/${ref.slice(0, ref.lastIndexOf('/'))}" && : > "$gd/${ref}.lock"`;
  return `#!/bin/sh
gd=""
prev=""
for a in "$@"; do
  case "$prev" in --git-dir) gd="$a" ;; esac
  prev="$a"
done
if [ -e "${marker}" ] && [ -n "$gd" ]; then
  ${touch}
  sleep 30
fi
exec ${REAL_GIT} "$@"
`;
}

/** A flock shim that records its argv and then execs the wrapped command. */
function loggingFlock(log: string): string {
  return `#!/bin/sh
printf '%s\\n' "$@" >> "${log}"
shift 4
exec "$@"
`;
}

const baseArgs = (fixtureRef: WorldFixture): readonly string[] => fixtureRef.world.gitBaseArgs();

describe('the world lock path derives from the call, never from a home', () => {
  it('is join(dirname(git-dir), ".es", "world.lock") and refuses a call without the pair', () => {
    const { world } = fixture();
    const lock = worldLockPath(baseArgs(fixture()));
    expect(lock).toBe(join(dirname(world.gitDir), '.es', 'world.lock'));
    expect(lock.endsWith('/.es/world.lock')).toBe(true);
    expect(worldLockPath(['--git-dir', '/tmp/x/world.git', 'add', '--all']))
      .toBe('/tmp/x/.es/world.lock');
    expect(() => worldLockPath(['add', '--all'])).toThrow(/--git-dir/);
  });

  it('names the mutating subcommands and no read', () => {
    expect([...MUTATING_GIT_SUBCOMMANDS].sort())
      .toEqual(['add', 'commit-tree', 'update-index', 'update-ref', 'write-tree']);
    expect(isMutatingGit(['--git-dir', '/g', 'add', '--all'])).toBe(true);
    expect(isMutatingGit(['--git-dir', '/g', '-c', 'x=y', 'update-ref', 'r', 'a'])).toBe(true);
    expect(isMutatingGit(['--git-dir', '/g', 'log', '--format=%H'])).toBe(false);
  });
});

describe('mutating git children run under the world flock', () => {
  it('runs flock -n -E 75 <lock> git <args> (exec form) and creates .es 0700', async () => {
    const f = fixture();
    const log = join(root, 'flock.log');
    await fakeBins({ flock: loggingFlock(log) });
    const args = [...baseArgs(f), 'write-tree'];
    await runGit(f.world.path, args);

    const recorded = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
    const lock = worldLockPath(baseArgs(f));
    expect(recorded.slice(0, 4)).toEqual(['-n', '-E', '75', lock]);
    expect(recorded.slice(4)).toEqual(['git', ...args]);
    const lockDir = await lstat(dirname(lock));
    expect(lockDir.isDirectory()).toBe(true);
    expect(lockDir.mode & 0o777).toBe(0o700);
  });

  it('never wraps a read in flock', async () => {
    const f = fixture();
    const log = join(root, 'flock.log');
    await fakeBins({ flock: loggingFlock(log) });
    await expect(runGit(f.world.path, [...baseArgs(f), 'rev-parse', '--verify', '--quiet', 'HEAD']))
      .rejects.toBeInstanceOf(GitCommandError);
    await expect(lstat(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('logs every mutating subcommand through flock', async () => {
    const f = fixture();
    const log = join(root, 'flock.log');
    await fakeBins({ flock: loggingFlock(log), git: '#!/bin/sh\nexit 0\n' });
    for (const subcommand of ['add', 'update-index', 'write-tree', 'commit-tree', 'update-ref']) {
      await unlink(log).catch(() => {});
      await runGit(f.world.path, [...baseArgs(f), subcommand, '--x']);
      const recorded = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
      expect(recorded.slice(0, 4)).toEqual(['-n', '-E', '75', worldLockPath(baseArgs(f))]);
      // The wrapper args keep the real git argv verbatim (and the classifier's
      // detail names the git subcommand, never the flock wrapper).
      expect(recorded.slice(4)).toEqual(['git', ...baseArgs(f), subcommand, '--x']);
    }
  });

  it('types a missing flock as git-spawn on the git arguments, never the wrapper', async () => {
    const f = fixture();
    // A PATH with no flock at all: the mutating command fails closed. (The
    // fake git is on the same PATH, so only flock is absent.)
    const bin = await fakeBins({ git: `#!/bin/sh\nexec ${REAL_GIT} "$@"\n` });
    process.env['PATH'] = bin;
    const args = [...baseArgs(f), 'add', '--all', '--', '.'];
    let caught: unknown;
    try {
      await runGit(f.world.path, args);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    const error = caught as GitCommandError;
    expect(error.kind).toBe('spawn');
    expect(error.args).toEqual(args);
    expect(error.stderr).toMatch(/flock/);
    expect(classifyCommitFailure(error)).toMatchObject({ reason: 'git-spawn' });
    expect(classifyCommitFailure(error)?.detail).toMatch(/^git add could not be spawned/);
  });
});

describe('contention: a held world lock is retried, never a hang', () => {
  it('commits after the holder releases (the bounded retry classifies the conflict)', async () => {
    const f = fixture();
    const lock = worldLockPath(baseArgs(f));
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const holder = spawn('/usr/bin/flock', ['-n', lock, 'sleep', '30'], {
      stdio: 'ignore', detached: true,
    });
    try {
      await waitForLock(baseArgs(f), 'held');
      await writeWorldFile(f.world, 'notes.md', 'after contention');
      const release = setTimeout(() => { process.kill(-holder.pid!, 'SIGKILL'); }, 60);
      const attempt = await commitAllRefused(() => f.world.commitAll('n1', 'turn 0'));
      clearTimeout(release);
      expect(attempt.refusal).toBeNull();
      expect(attempt.commit).not.toBeNull();
    } finally {
      try { process.kill(-holder.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('refuses typed after the bounded retries while the lock stays held', async () => {
    const f = fixture();
    const lock = worldLockPath(baseArgs(f));
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const holder = spawn('/usr/bin/flock', ['-n', lock, 'sleep', '30'], {
      stdio: 'ignore', detached: true,
    });
    try {
      await waitForLock(baseArgs(f), 'held');
      await writeWorldFile(f.world, 'notes.md', 'held');
      const attempt = await commitAllRefused(() => f.world.commitAll('n1', 'turn 0'));
      expect(attempt.refusal).toMatchObject({ reason: 'git-exit' });
      expect(attempt.refusal?.detail).toMatch(/world lock is held/);
    } finally {
      try { process.kill(-holder.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
});

describe('deadlines: the child is killed, its close awaited, the failure typed', () => {
  it('bounded write-tree: timeout, the lock freed, then the same call succeeds', async () => {
    const f = fixture();
    const marker = join(root, 'sleep');
    await writeFile(marker, '');
    await fakeBins({ git: sleepyGit(marker) });
    const args = [...baseArgs(f), 'write-tree'];
    const started = Date.now();
    let caught: unknown;
    try {
      await runGit(f.world.path, args, undefined, 250);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect((caught as GitCommandError).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(8_000);
    // The flock parent's close is the waitpid proof: its forked git inherited
    // the lock descriptor, so a free lock means the whole group is gone.
    expect(await probeWorldLock(baseArgs(f))).toBe('free');
    await unlink(marker);
    const tree = await runGit(f.world.path, args, undefined, 8_000);
    expect(tree.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('classifies a runGitWithStdin timeout and reaps the child', async () => {
    const f = fixture();
    const marker = join(root, 'sleep');
    await writeFile(marker, '');
    await fakeBins({ git: sleepyGit(marker) });
    await expect(runGitWithStdin(
      f.world.path, [...baseArgs(f), 'hash-object', '-t', 'tree', '--stdin'],
      Buffer.alloc(0), 250,
    )).rejects.toMatchObject({ kind: 'timeout' });
    await unlink(marker);
    const tree = await runGitWithStdin(
      f.world.path, [...baseArgs(f), 'hash-object', '-t', 'tree', '--stdin'],
      Buffer.alloc(0), 8_000,
    );
    expect(tree.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('survives an early-exiting git child while 2 MiB of stdin is still buffered', async () => {
    const f = fixture();
    // A git child that never drains its stdin and is deadline-killed: the
    // pending pipe write fails with EPIPE. Without a `child.stdin` error
    // listener Node 24 turns that into an uncaught stream error that kills the
    // kernel process; the typed timeout must win and this test must survive.
    await fakeBins({ git: '#!/bin/sh\nsleep 30\n' });
    const input = Buffer.alloc(2 * 1024 * 1024, 0x61);
    await expect(runGitWithStdin(
      f.world.path, [...baseArgs(f), 'cat-file', '--batch-check'], input, 250,
    )).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('pins the output-cap ordering deterministically (code 0, signal null, capped)', () => {
    // The live cap below always kills a still-writing child, so its outcome is
    // a signal and the old code-0-first order would pass it too. The actual
    // edge — a child that exits 0 at the very moment the cap is crossed — is
    // pinned here with a synthetic outcome, the pure classifier's input.
    const error = failureOf(['log'], {
      code: 0, signal: null, stdout: '', stderr: '',
      outputCapped: true, timedOut: false, spawnError: null,
    }, false);
    expect(error).toBeInstanceOf(GitCommandError);
    expect(error?.outputCapped).toBe(true);
    expect(classifyCommitFailure(error)).toMatchObject({ reason: 'output-cap' });
  });

  it('refuses truncated stdout when a child crosses the output cap', async () => {
    const f = fixture();
    // Behavioral check only: more than the 64 MiB bound, then the handler kills
    // the still-writing child and the capped prefix is a refusal, never a
    // complete fact. The code-0-at-the-cap ordering is pinned above.
    await fakeBins({ git: '#!/bin/sh\n/usr/bin/head -c 80000000 /dev/zero\n' });
    let caught: unknown;
    try {
      await runGit(f.world.path, [...baseArgs(f), 'log'], undefined, 30_000);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect((caught as GitCommandError).outputCapped).toBe(true);
    expect(classifyCommitFailure(caught)).toMatchObject({ reason: 'output-cap' });
  }, 60_000);

  it('removes the index.lock its own timed-out child created, under the flock', async () => {
    const f = fixture();
    const marker = join(root, 'sleep');
    await writeFile(marker, '');
    await fakeBins({ git: lockingGit(marker, '') });
    const indexPath = worldIndexLockPath(baseArgs(f))!;
    await expect(runGit(f.world.path, [...baseArgs(f), 'add', '--all', '--', '.'], undefined, 250))
      .rejects.toMatchObject({ kind: 'timeout' });
    // The child created the lock after the snapshot, so it is the child's own
    // lock and the cleanup removes it; the next attempt is not wedged.
    await expect(lstat(indexPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a pre-existing index.lock, even an old one (the doctor owns staleness)', async () => {
    const f = fixture();
    const marker = join(root, 'sleep');
    await writeFile(marker, '');
    await fakeBins({ git: sleepyGit(marker) });
    const indexPath = worldIndexLockPath(baseArgs(f))!;
    await writeFile(indexPath, '');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(indexPath, old, old);
    await expect(runGit(f.world.path, [...baseArgs(f), 'add', '--all', '--', '.'], undefined, 250))
      .rejects.toMatchObject({ kind: 'timeout' });
    // The lock predates the attempt: it is not this child's, and a human's live
    // lock is not distinguishable by mtime; the doctor's age rule removes it.
    expect((await lstat(indexPath)).isFile()).toBe(true);
  });

  it('removes the ref lock its own timed-out update-ref created', async () => {
    const f = fixture();
    const marker = join(root, 'sleep');
    await writeFile(marker, '');
    await fakeBins({ git: lockingGit(marker, 'refs/heads/main') });
    const refLock = join(f.world.gitDir, 'refs/heads/main.lock');
    await expect(runGit(f.world.path, [
      ...baseArgs(f), 'update-ref', 'refs/heads/main', 'a'.repeat(40), '0'.repeat(40),
    ], undefined, 250)).rejects.toMatchObject({ kind: 'timeout' });
    await expect(lstat(refLock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

/** Polls the non-blocking lock probe until it reports `expected`. */
async function waitForLock(
  args: readonly string[], expected: WorldLockState, timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeWorldLock(args) === expected) return;
    if (Date.now() > deadline) throw new Error(`lock never became ${expected}`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

// The real flock is a declared prerequisite; make the assumption explicit.
it('has the declared flock prerequisite on PATH', () => {
  expect(() => execFileSync('flock', ['--version'], { stdio: 'ignore' })).not.toThrow();
});
