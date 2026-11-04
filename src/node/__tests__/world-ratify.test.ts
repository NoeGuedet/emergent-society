import { Buffer } from 'node:buffer';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldRepo } from '../world.js';
import { ratify, worldIoOf } from '../world-ratify.js';
import { commitAs, gitIn } from './helpers.js';

/**
 * The B2a materialize canaries in the ACTUAL `ratify` core (a real git world,
 * not a mock). `RatifyOptions.afterRootPin` renames the already-pinned root and
 * puts a PLAIN fake directory at its old name, so the missing `notes/2026`
 * parents must be created through the pinned fd; a path-based mkdir writes into
 * the fake and fails the assertions. `RatifyOptions.afterPinned` is the
 * distinct later seam for the read/chmod/rename tail. The canaries are fake
 * files only — no key, no secret, no exploit.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

type Core = {
  readonly root: string;
  readonly home: string;
  readonly world: WorldRepo;
};

async function core(): Promise<Core> {
  const root = await mkdtemp(join(tmpdir(), 'es-ratify-core-'));
  roots.push(root);
  const world = await WorldRepo.init(join(root, 'world'), { gitDir: join(root, 'world.git') });
  const home = join(root, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  return { root, home, world };
}

describe('the materialize mkdir canary (afterRootPin)', () => {
  it('creates missing parents under the pinned root, commits the known hash, and never touches the fake root', async () => {
    const fx = await core();
    await commitAs(fx.world, 'n1', { 'base.txt': 'base\n' });
    const bytes = Buffer.from('the pinned ratification\n');
    let afterRootPinCalls = 0;
    let pinnedRoot = '';
    let published: string | null = null;
    const outcome = await ratify(worldIoOf(fx.world), {
      path: 'notes/2026/x.md',
      bytes,
      afterRootPin: async ({ rootPath }) => {
        afterRootPinCalls += 1;
        // The seam fires after the root pin and before any parent traversal:
        // `notes/` cannot exist yet under the pinned root.
        await expect(lstat(join(rootPath, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' });
        pinnedRoot = `${rootPath}.pinned`;
        await rename(rootPath, pinnedRoot);
        // A PLAIN directory, never a symlink: an early O_NOFOLLOW mask cannot
        // hide a path-based mkdir, which would write into this fake root.
        await mkdir(rootPath);
        await writeFile(join(rootPath, 'sentinel.txt'), 'fake canary\n', { mode: 0o640 });
      },
      afterPublish: async (commit) => {
        published = commit;
      },
    });
    expect(afterRootPinCalls).toBe(1);
    expect(outcome.kind).toBe('committed');
    expect(outcome.commit).not.toBeNull();
    expect(outcome.commit).toBe(published);
    expect(outcome.warnings.filter((warning) => /worktree copy was not materialized/.test(warning)))
      .toEqual([]);
    // The known base HEAD is the parent and the pin moved exactly once.
    expect(await fx.world.headHash()).toBe(published);
    // The path was created under the PINNED root, with the exact bytes.
    expect(await readFile(join(pinnedRoot, 'notes/2026/x.md'), 'utf8'))
      .toBe(bytes.toString('utf8'));
    expect((await gitIn(fx.world, ['show', 'HEAD:notes/2026/x.md']))).toBe(bytes.toString('utf8'));
    // The fake root the attacker named holds the sentinel only — no `notes`.
    expect(await lstat(join(fx.root, 'world', 'notes')).catch(() => null)).toBeNull();
    const sentinel = await stat(join(fx.root, 'world', 'sentinel.txt'));
    expect(sentinel.mode & 0o777).toBe(0o640);
    expect(await readFile(join(fx.root, 'world', 'sentinel.txt'), 'utf8')).toBe('fake canary\n');
  });
});

describe('the read/chmod/rename canary (afterPinned)', () => {
  it('materializes an executable entry in the pinned parent after a parent swap and leaves the canary intact', async () => {
    const fx = await core();
    await mkdir(join(fx.world.path, 'notes', 'docs'), { recursive: true });
    await writeFile(join(fx.world.path, 'notes', 'docs', 'x.md'), 'draft\n');
    await chmod(join(fx.world.path, 'notes', 'docs', 'x.md'), 0o755);
    await commitAs(fx.world, 'n1', {});
    expect((await gitIn(
      fx.world, ['ls-tree', 'HEAD', '--', 'notes/docs/x.md'])).trim().split(' ')[0])
      .toBe('100755');
    const canaryDir = join(fx.root, 'canary');
    await mkdir(canaryDir);
    await writeFile(join(canaryDir, 'x.md'), 'canary bytes\n', { mode: 0o644 });
    const bytes = Buffer.from('#!/bin/sh\necho ratified\n');
    let afterPinnedCalls = 0;
    let pinnedRel = '';
    const outcome = await ratify(worldIoOf(fx.world), {
      path: 'notes/docs/x.md',
      bytes,
      afterPinned: async ({ fd, rel }) => {
        afterPinnedCalls += 1;
        pinnedRel = rel;
        // The hook receives the FINAL parent fd (not an intermediate one):
        // the proof is the fd's own canonical path.
        expect(await realpath(`/proc/self/fd/${String(fd)}`))
          .toBe(join(fx.world.path, 'notes', 'docs'));
        // Swap the final parent's name for a symlink to the external canary.
        // The later lstat/read/chmod/rename must still use the fd.
        await rename(
          join(fx.world.path, 'notes', 'docs'), join(fx.world.path, 'notes', 'docs.pinned'));
        await symlink(canaryDir, join(fx.world.path, 'notes', 'docs'));
      },
    });
    expect(afterPinnedCalls).toBe(1);
    expect(pinnedRel).toBe('notes/docs');
    expect(outcome.kind).toBe('committed');
    expect(outcome.warnings).toEqual([]);
    const materialized = await readFile(join(fx.world.path, 'notes', 'docs.pinned', 'x.md'));
    expect(materialized).toEqual(bytes);
    expect(
      (await stat(join(fx.world.path, 'notes', 'docs.pinned', 'x.md'))).mode & 0o111,
    ).not.toBe(0);
    expect((await gitIn(fx.world, ['show', 'HEAD:notes/docs/x.md'])))
      .toBe(bytes.toString('utf8'));
    expect((await gitIn(
      fx.world, ['ls-tree', 'HEAD', '--', 'notes/docs/x.md'])).trim().split(' ')[0])
      .toBe('100755');
    // The canary outside the world is byte- and mode-identical and is still
    // reachable only through the attacker's symlink.
    expect(await readFile(join(canaryDir, 'x.md'), 'utf8')).toBe('canary bytes\n');
    expect(((await stat(join(canaryDir, 'x.md'))).mode & 0o777)).toBe(0o644);
    expect((await lstat(join(fx.world.path, 'notes', 'docs'))).isSymbolicLink()).toBe(true);
  });

  it('fixes a drifted exec bit on the pinned leaf after a parent swap, never the canary', async () => {
    const fx = await core();
    await mkdir(join(fx.world.path, 'notes', 'docs'), { recursive: true });
    const bytes = Buffer.from('#!/bin/sh\necho ratified\n');
    const pinnedLeaf = join(fx.world.path, 'notes', 'docs', 'x.md');
    await writeFile(pinnedLeaf, bytes);
    await chmod(pinnedLeaf, 0o755);
    await commitAs(fx.world, 'n1', {});
    expect((await gitIn(
      fx.world, ['ls-tree', 'HEAD', '--', 'notes/docs/x.md'])).trim().split(' ')[0])
      .toBe('100755');
    // The bytes already match; only the worktree's exec bit drifted. The
    // unchanged path must take setExecutablePinned, not the temp rename.
    await chmod(pinnedLeaf, 0o644);
    const canaryDir = join(fx.root, 'canary');
    await mkdir(canaryDir);
    await writeFile(join(canaryDir, 'x.md'), bytes, { mode: 0o644 });
    let afterPinnedCalls = 0;
    const outcome = await ratify(worldIoOf(fx.world), {
      path: 'notes/docs/x.md',
      bytes,
      afterPinned: async ({ fd, rel }) => {
        afterPinnedCalls += 1;
        expect(rel).toBe('notes/docs');
        expect(await realpath(`/proc/self/fd/${String(fd)}`))
          .toBe(join(fx.world.path, 'notes', 'docs'));
        // The swap the fd chain must survive: the later leaf open/chmod goes
        // through the pinned parent, so this canary's 0644 stays untouched.
        await rename(
          join(fx.world.path, 'notes', 'docs'), join(fx.world.path, 'notes', 'docs.pinned'));
        await symlink(canaryDir, join(fx.world.path, 'notes', 'docs'));
      },
    });
    expect(afterPinnedCalls).toBe(1);
    expect(outcome.kind).toBe('unchanged');
    expect(outcome.commit).toBeNull();
    expect(outcome.materialized).toBe(false);
    expect(outcome.warnings).toEqual([]);
    expect(await fx.world.headHash()).toBe(outcome.parent);
    // The pinned leaf is repaired in place; a path chmod would have hit the
    // attacker's symlink target instead.
    expect((await stat(join(fx.world.path, 'notes', 'docs.pinned', 'x.md'))).mode & 0o777)
      .toBe(0o755);
    expect(await readFile(join(fx.world.path, 'notes', 'docs.pinned', 'x.md'))).toEqual(bytes);
    expect(await readFile(join(canaryDir, 'x.md'))).toEqual(bytes);
    expect(((await stat(join(canaryDir, 'x.md'))).mode & 0o777)).toBe(0o644);
    expect((await lstat(join(fx.world.path, 'notes', 'docs'))).isSymbolicLink()).toBe(true);
  });
});

describe('a /proc absence after the CAS', () => {
  it('keeps the landed commit, emits the named warning, and never falls back to a path', async () => {
    const fx = await core();
    await commitAs(fx.world, 'n1', { 'base.txt': 'base\n' });
    const bytes = Buffer.from('landed despite no proc\n');
    const outcome = await ratify(worldIoOf(fx.world), {
      path: 'notes/x.md',
      bytes,
      procRoot: join(fx.root, 'no-proc'),
    });
    expect(outcome.kind).toBe('committed');
    expect(outcome.commit).not.toBeNull();
    expect(outcome.warnings.join('\n')).toContain('the worktree copy was not materialized');
    expect(outcome.warnings.join('\n')).toContain('proc-unavailable');
    expect(await fx.world.headHash()).toBe(outcome.commit);
    expect((await gitIn(fx.world, ['show', 'HEAD:notes/x.md']))).toBe(bytes.toString('utf8'));
    expect(await lstat(join(fx.world.path, 'notes/x.md')).catch(() => null)).toBeNull();
  });
});
