import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseDoctorReport, quarantineDir, runWorldDoctor, type DoctorReport,
} from '../world-doctor.js';
import { probeWorldLock, runGitWithStdin, worldLockPath } from '../world-git.js';
import { commitAllRefused } from '../world-commit.js';
import type { WorldRepo } from '../world.js';
import { commitAs, gitIn, useWorld, writeWorldFile } from './helpers.js';

/**
 * The world doctor against a real repository and a real flock: the live lock
 * is kept and the proven-stale one is removed by age under the flock; a dirty
 * tree and tracked unreadable paths are REPORTED (the commit stays typed); an
 * untracked unstageable file is quarantined within the bounds and only with a
 * free-space proof; the index is validated structurally only; and a failing
 * world still produces a report with no lock or child left behind.
 */

const fixture = useWorld('node-world-doctor-');
const holders: ChildProcess[] = [];

afterEach(() => {
  for (const holder of holders.splice(0)) {
    if (holder.pid === undefined) continue;
    try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

/** A free-space probe that proves the disk is healthy (the host may be below the floor). */
const plenty = async (): Promise<{ bytes: number; inodes: number }> => ({
  bytes: 100 * 1024 ** 3, inodes: 1_000_000,
});

/** Holds the world flock for the duration of one test. */
async function holdLock(world: WorldRepo): Promise<void> {
  const lock = worldLockPath(world.gitBaseArgs());
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const holder = spawn('/usr/bin/flock', ['-n', lock, 'sleep', '30'], {
    stdio: 'ignore', detached: true,
  });
  holders.push(holder);
  await waitForLock(world, 'held');
}

async function waitForLock(
  world: WorldRepo, expected: 'free' | 'held', timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probeWorldLock(world.gitBaseArgs()) === expected) return;
    if (Date.now() > deadline) throw new Error(`world lock never became ${expected}`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

async function setAge(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

const indexLockOf = (world: WorldRepo): string => join(world.gitDir, 'index.lock');

describe('the world lock: live kept, proven-stale removed under the flock', () => {
  it('reports a fresh clean world and serializes a valid report', async () => {
    const { world, home } = fixture();
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report).toMatchObject({
      lock: 'free',
      indexLock: 'absent',
      index: { readable: true, unmerged: 0, missingBlobs: 0, blobsChecked: true },
      dirty: { known: true, tracked: 0, untracked: 0, truncated: false },
      trackedUnreadable: [],
      quarantine: { files: 0, bytes: 0, paths: [], truncated: false },
      freeSpace: { state: 'ok' },
    });
    expect(parseDoctorReport(report)).toEqual(report);
    // The production free-space path is `statfs(home)`: a real number and one
    // of the two known states (this host may be below the 20 GiB floor).
    const live = await runWorldDoctor(world, { home });
    expect(['ok', 'low']).toContain(live.freeSpace.state);
    expect(typeof live.freeSpace.bytes).toBe('number');
  });

  it('opens no writer: the doctor leaves the node journal absent', async () => {
    const { world, home } = fixture();
    await runWorldDoctor(world, { home, freeSpace: plenty });
    await expect(lstat(join(home, 'nodes'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a live lock and its index.lock untouched', async () => {
    const { world, home } = fixture();
    const indexLock = indexLockOf(world);
    await writeFile(indexLock, '');
    await setAge(indexLock, 60 * 60 * 1000);
    await holdLock(world);
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report.lock).toBe('held');
    expect(report.indexLock).toBe('kept');
    expect((await lstat(indexLock)).isFile()).toBe(true);
  });

  it('removes a stale index.lock only by age, under the flock', async () => {
    const { world, home } = fixture();
    const indexLock = indexLockOf(world);
    await writeFile(indexLock, '');
    await setAge(indexLock, 60 * 60 * 1000);
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report.lock).toBe('free');
    expect(report.indexLock).toBe('removed');
    await expect(lstat(indexLock)).rejects.toMatchObject({ code: 'ENOENT' });
    // The flock was released with the helper: the lock is free afterwards.
    expect(await probeWorldLock(world.gitBaseArgs())).toBe('free');
  });

  it('keeps a fresh index.lock (the age rule, not existence)', async () => {
    const { world, home } = fixture();
    const indexLock = indexLockOf(world);
    await writeFile(indexLock, '');
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report.indexLock).toBe('kept');
    expect((await lstat(indexLock)).isFile()).toBe(true);
  });

  it('records unverifiable and removes nothing when flock is absent', async () => {
    const { world, home } = fixture();
    const indexLock = indexLockOf(world);
    await writeFile(indexLock, '');
    await setAge(indexLock, 60 * 60 * 1000);
    const report = await runWorldDoctor(world, {
      home, freeSpace: plenty, flock: join(home, 'no-such-flock'),
    });
    expect(report.lock).toBe('unverifiable');
    expect(report.indexLock).toBe('unverifiable');
    expect((await lstat(indexLock)).isFile()).toBe(true);
  });
});

describe('the index is validated structurally only', () => {
  it('reports unmerged stages without touching them', async () => {
    const { world, home } = fixture();
    const base = world.gitBaseArgs();
    const blob = async (content: string): Promise<string> => (
      await runGitWithStdin(
        world.path, [...base, 'hash-object', '-w', '--stdin'], Buffer.from(content),
      )
    ).trim();
    const ours = await blob('ours\n');
    const theirs = await blob('theirs\n');
    const baseBlob = await blob('base\n');
    const lines = [
      `100644 ${baseBlob} 1\tconflict.txt`,
      `100644 ${ours} 2\tconflict.txt`,
      `100644 ${theirs} 3\tconflict.txt`,
      '',
    ].join('\n');
    await runGitWithStdin(
      world.path, [...base, 'update-index', '--index-info'], Buffer.from(lines),
    );
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report.index.readable).toBe(true);
    expect(report.index.unmerged).toBe(3);
    // Structural only: the unmerged index is reported, never "repaired".
    const listed = await gitIn(world, ['ls-files', '--unmerged']);
    expect(listed.split('\n').filter((line) => line !== '')).toHaveLength(3);
  });

  it('reports a named blob that is missing from the object store', async () => {
    const { world, home } = fixture();
    await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const blob = (await gitIn(world, ['rev-parse', 'HEAD:a.txt'])).trim();
    await unlink(join(world.gitDir, 'objects', blob.slice(0, 2), blob.slice(2)));
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report.index.readable).toBe(true);
    expect(report.index.blobsChecked).toBe(true);
    expect(report.index.missingBlobs).toBe(1);
  });

  it('is never compared to HEAD: a staged path is reported dirty, not corrupt', async () => {
    const { world, home } = fixture();
    await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    await writeWorldFile(world, 'b.txt', 'two\n');
    await gitIn(world, ['add', 'b.txt']);
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report.index).toMatchObject({ readable: true, unmerged: 0, missingBlobs: 0 });
    expect(report.dirty).toMatchObject({ known: true, tracked: 1, untracked: 0 });
  });
});

describe('the dirty tree and tracked unreadable paths are reported, never skipped', () => {
  it('counts tracked and untracked dirt without touching either', async () => {
    const { world, home } = fixture();
    await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    await writeFile(join(world.path, 'a.txt'), 'changed\n');
    await writeWorldFile(world, 'untracked.txt', 'new\n');
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report.dirty.known).toBe(true);
    expect(report.dirty.tracked).toBe(1);
    expect(report.dirty.untracked).toBe(1);
    expect(await gitIn(world, ['status', '--porcelain'])).toContain('a.txt');
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports a tracked unreadable path and leaves the commit typed',
    async () => {
      const { world, home } = fixture();
      await commitAs(world, 'n1', { 'locked.txt': 'x\n' });
      const locked = join(world.path, 'locked.txt');
      await chmod(locked, 0o000);
      try {
        const report = await runWorldDoctor(world, { home, freeSpace: plenty });
        expect(report.trackedUnreadable).toEqual(['locked.txt']);
        const attempt = await commitAllRefused(() => world.commitAll('n1', 'turn 1'));
        // No per-path skip exists in `add --all`: the commit is typed, the
        // kernel survives, and the path stays reported for the operator.
        expect(attempt.commit).toBeNull();
        expect(attempt.refusal).not.toBeNull();
        expect(['git-exit', 'walk-eacces']).toContain(attempt.refusal?.reason);
      } finally {
        await chmod(locked, 0o600).catch(() => {});
      }
    },
  );
  it.skipIf(process.getuid?.() === 0)(
    'omits a tracked unreadable path with no representable single-line label',
    async () => {
      const { world, home } = fixture();
      // ' ' is a legal git path; `singleLine` collapses it to '', which the
      // report's own validator rejects. The doctor must omit the label instead
      // of writing a report its fold can never accept.
      await commitAs(world, 'n1', { ' ': 'x\n' });
      const blank = join(world.path, ' ');
      await chmod(blank, 0o000);
      try {
        const report = await runWorldDoctor(world, { home, freeSpace: plenty });
        expect(report.trackedUnreadable).toEqual([]);
        // The report the writer emits is exactly the report the fold accepts.
        expect(parseDoctorReport(report)).toEqual(report);
      } finally {
        await chmod(blank, 0o600).catch(() => {});
      }
    },
  );
  it.skipIf(process.getuid?.() === 0)(
    'omits every tracked label the validator would reject (/, .., over-long)',
    async () => {
      const { world, home } = fixture();
      // Legal git names whose collapsed labels the replay validator rejects:
      // ' /x' trims to a leading '/', ' ..' trims to '..', and 101 emoji are
      // 101 code points but 202 UTF-16 units (the validator's unit). Before the
      // shared rule the doctor threw and lost the WHOLE report on each boot.
      const longDir = '😀'.repeat(50);
      const longFile = '😀'.repeat(51);
      const rel = {
        leading: ' /x',
        traversing: ' ..',
        long: `${longDir}/${longFile}`,
      };
      await commitAs(world, 'n1', { [rel.leading]: 'x\n', [rel.traversing]: 'x\n', [rel.long]: 'x\n' });
      const paths = [
        join(world.path, rel.leading),
        join(world.path, rel.traversing),
        join(world.path, rel.long),
      ];
      for (const path of paths) await chmod(path, 0o000);
      try {
        const report = await runWorldDoctor(world, { home, freeSpace: plenty });
        expect(report.trackedUnreadable).toEqual([]);
        // The report validates and still carries every other diagnostic.
        expect(parseDoctorReport(report)).toEqual(report);
        expect(report.dirty.known).toBe(true);
        expect(report.index.readable).toBe(true);
        // The offending labels alone are omitted — the files are untouched.
        for (const path of paths) expect((await lstat(path)).isFile()).toBe(true);
      } finally {
        for (const path of paths) await chmod(path, 0o600).catch(() => {});
      }
    },
  );
});

describe('untracked unstageable paths are quarantined, bounded and free-space gated', () => {
  it.skipIf(process.getuid?.() === 0)(
    'moves an unreadable untracked file aside and keeps the recovery commit intact',
    async () => {
      const { world, home } = fixture();
      const before = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
      const bad = join(world.path, 'bad.txt');
      await writeFile(bad, '');
      await chmod(bad, 0o000);
      const report = await runWorldDoctor(world, { home, freeSpace: plenty });
      expect(report.quarantine.files).toBe(1);
      expect(report.quarantine.paths).toEqual(['bad.txt']);
      expect(report.quarantine.truncated).toBe(false);
      await expect(lstat(bad)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(quarantineDir(home))).toEqual(['bad.txt']);
      // The doctor never moves HEAD and the named-turn recovery commit is not
      // touched: a later commit still succeeds and moves HEAD by its own hash.
      expect(await world.headHash()).toBe(before);
      await writeWorldFile(world, 'good.md', 'ok\n');
      const attempt = await commitAllRefused(() => world.commitAll('n1', 'turn 1'));
      expect(attempt.refusal).toBeNull();
      expect(attempt.commit).not.toBeNull();
      expect(await world.headHash()).toBe(attempt.commit?.hash);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'stops at the quarantine count bound and reports the truncation',
    async () => {
      const { world, home } = fixture();
      for (const name of ['one.txt', 'two.txt']) {
        const path = join(world.path, name);
        await writeFile(path, '');
        await chmod(path, 0o000);
      }
      const report = await runWorldDoctor(world, {
        home, freeSpace: plenty, quarantineMaxFiles: 1,
      });
      expect(report.quarantine.files).toBe(1);
      expect(report.quarantine.truncated).toBe(true);
      expect(await readdir(quarantineDir(home))).toHaveLength(1);
      const left = (await readdir(world.path)).filter((name) => name !== 'world.git');
      expect(left.filter((name) => name.endsWith('.txt'))).toHaveLength(1);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'refuses to move anything when free space is low or unverifiable',
    async () => {
      const { world, home } = fixture();
      const bad = join(world.path, 'bad.txt');
      await writeFile(bad, '');
      await chmod(bad, 0o000);
      const low = await runWorldDoctor(world, {
        home, freeSpace: async () => ({ bytes: 1, inodes: 1 }),
      });
      expect(low.freeSpace.state).toBe('low');
      expect(low.quarantine.files).toBe(0);
      expect(low.quarantine.truncated).toBe(true);
      expect((await lstat(bad)).isFile()).toBe(true);

      const unknown = await runWorldDoctor(world, {
        home, freeSpace: async () => null,
      });
      expect(unknown.freeSpace.state).toBe('unverifiable');
      expect(unknown.quarantine.files).toBe(0);
      expect((await lstat(bad)).isFile()).toBe(true);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'omits a quarantine path with no representable label and does not move it',
    async () => {
      const { world, home } = fixture();
      const blank = join(world.path, ' ');
      await writeFile(blank, '');
      await chmod(blank, 0o000);
      try {
        const report = await runWorldDoctor(world, { home, freeSpace: plenty });
        // `files === paths.length` stays true because the unrepresentable path
        // is neither labelled nor moved.
        expect(report.quarantine).toEqual({
          files: 0, bytes: 0, paths: [], truncated: false,
        });
        expect(parseDoctorReport(report)).toEqual(report);
        expect((await lstat(blank)).isFile()).toBe(true);
      } finally {
        await chmod(blank, 0o600).catch(() => {});
        await rm(blank, { force: true }).catch(() => {});
      }
    },
  );
});

describe('a failing world is a report, never a refused boot', () => {
  it('reports the failure and leaves no lock or helper behind', async () => {
    const { world, home } = fixture();
    await rm(world.gitDir, { recursive: true, force: true });
    const report = await runWorldDoctor(world, { home, freeSpace: plenty });
    expect(report.lock).toBe('free');
    expect(report.index.readable).toBe(false);
    expect(report.dirty.known).toBe(false);
    expect(await probeWorldLock(world.gitBaseArgs())).toBe('free');
  });

  it('never throws for a world fact (the flock probe included)', async () => {
    const { world, home } = fixture();
    await expect(runWorldDoctor(world, {
      home, flock: join(home, 'missing-flock'), freeSpace: plenty,
    })).resolves.toMatchObject({ lock: 'unverifiable' });
  });
});

describe('the report validator', () => {
  const valid = (): DoctorReport => ({
    lock: 'free',
    indexLock: 'absent',
    index: { readable: true, unmerged: 0, missingBlobs: 0, blobsChecked: true },
    dirty: { tracked: 0, untracked: 0, truncated: false, known: true },
    trackedUnreadable: [],
    quarantine: { files: 0, bytes: 0, paths: [], truncated: false },
    freeSpace: { state: 'ok', bytes: 1 },
  });

  it('accepts a valid report and rejects every malformed variant', () => {
    expect(parseDoctorReport(valid())).toEqual(valid());
    expect(parseDoctorReport({ ...valid(), extra: true })).toBeNull();
    expect(parseDoctorReport({ ...valid(), lock: 'maybe' })).toBeNull();
    expect(parseDoctorReport({ ...valid(), indexLock: 'deleted' })).toBeNull();
    expect(parseDoctorReport({ ...valid(), index: { ...valid().index, unmerged: -1 } }))
      .toBeNull();
    expect(parseDoctorReport({ ...valid(), dirty: { ...valid().dirty, tracked: 1.5 } }))
      .toBeNull();
    expect(parseDoctorReport({ ...valid(), trackedUnreadable: ['x'.repeat(500)] }))
      .toBeNull();
    expect(parseDoctorReport({
      ...valid(),
      quarantine: { files: 2, bytes: 0, paths: ['a'], truncated: false },
    })).toBeNull();
    expect(parseDoctorReport({
      ...valid(),
      freeSpace: { state: 'ok', bytes: null },
    })).toBeNull();
    expect(parseDoctorReport(null)).toBeNull();
    expect(parseDoctorReport([])).toBeNull();
  });
});
