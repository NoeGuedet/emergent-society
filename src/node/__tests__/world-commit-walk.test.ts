import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WorldRepo } from '../world.js';
import { commitAllRefused } from '../world-commit.js';

/**
 * The nested-repository walk against a real repository: the L1 regression.
 *
 * The walk is the commit path's only raw filesystem read and it runs before any
 * git child. Every errno it can raise must leave the boundary as a typed
 * refusal; a path past PATH_MAX (which a relative mkdir/chdir chain can build
 * legally) must be refused as `walk-too-deep`, never readdir'd and never
 * silently excluded from the commit. Before the fix, ENAMETOOLONG was
 * rethrown, the driver ended `driver-error`, and the open turn made every later
 * boot fail.
 */
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'es-walk-'));
});

afterEach(() => {
  if (root === '') return;
  // Node's rm resolves absolute paths and fails ENAMETOOLONG on the chain
  // built below; GNU rm walks it with openat/chdir.
  execFileSync('rm', ['-rf', root], { stdio: 'ignore' });
  root = '';
});

it('refuses a world path past the walk budget instead of readdir-ing it', async () => {
  const repo = await WorldRepo.init(join(root, 'world'), { gitDir: join(root, 'world.git') });
  // 22 levels of 200 bytes: the absolute path passes Linux's PATH_MAX (4096)
  // while every component stays under NAME_MAX. The chain is built with
  // relative mkdir/chdir in a child shell — exactly what the confined shell can
  // do — never by changing this process's cwd, which other suites share.
  execFileSync('bash', ['-c',
    'n=$(printf "d%.0s" {1..200}); for i in $(seq 1 22); do mkdir "$n" && cd "$n" || exit 1; done',
  ], { cwd: repo.path, stdio: 'ignore' });

  // The over-budget subtree is refused typed, not skipped: the kernel survives,
  // and the relative path reaches the model without the absolute world root.
  const attempt = await commitAllRefused(() => repo.commitAll('n1', 'turn 0'));
  expect(attempt.refusal).toMatchObject({ reason: 'walk-too-deep' });
  expect(attempt.refusal?.detail).toMatch(/^world walk walk failed \(ETOODEEP\): d{200}\//);
  expect(attempt.refusal?.detail).not.toContain(repo.path);
});

it('refuses a deep unborn nested repo as walk-too-deep, never a git-exit wedge', async () => {
  const repo = await WorldRepo.init(join(root, 'world'), { gitDir: join(root, 'world.git') });
  // 20 levels of 200 bytes: the absolute path is over the 3800 walk budget, but
  // the relative path is still under PATH_MAX, so git itself can reach the
  // bottom. An unborn nested repository there made `git add --all` fail with
  // "does not have a commit checked out" (a misleading git-exit refusal); the
  // walk now refuses the subtree itself, before any git child exists.
  execFileSync('bash', ['-c',
    'n=$(printf "d%.0s" {1..200}); for i in $(seq 1 20); do mkdir "$n" && cd "$n" || exit 1; done; git init -q .',
  ], { cwd: repo.path, stdio: 'ignore' });
  const attempt = await commitAllRefused(() => repo.commitAll('n1', 'turn 0'));
  expect(attempt.refusal).toMatchObject({ reason: 'walk-too-deep' });
  expect(attempt.refusal?.detail).toMatch(/^world walk walk failed \(ETOODEEP\): d{200}\//);
});

it.skipIf(process.getuid?.() === 0)(
  'classifies an unreadable world directory as a typed walk refusal',
  async () => {
    const repo = await WorldRepo.init(join(root, 'world'), { gitDir: join(root, 'world.git') });
    const locked = join(repo.path, 'locked');
    await mkdir(locked);
    await writeFile(join(locked, 'file.txt'), 'invisible');
    await chmod(locked, 0o000);
    try {
      const attempt = await commitAllRefused(() => repo.commitAll('n1', 'turn 0'));
      // The walk stops before any git child exists; the relative path reaches
      // the detail, never the absolute world path.
      expect(attempt.refusal).toMatchObject({ reason: 'walk-eacces' });
      expect(attempt.refusal?.detail).toContain('locked');
      expect(attempt.refusal?.detail).not.toContain(repo.path);
    } finally {
      await chmod(locked, 0o700);
    }
  },
);
