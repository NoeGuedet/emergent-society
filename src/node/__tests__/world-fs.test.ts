import {
  chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodFd,
  lstatAt,
  mkdirAt,
  openLeafAt,
  openPinnedDirAt,
  openPinnedParent,
  openPinnedRoot,
  realpathFd,
  renameAt,
  unlinkAt,
  WorldFsInvalidPathError,
  WorldFsMissingError,
  WorldFsProcUnavailableError,
  WorldFsUnsafeParentError,
} from '../world-fs.js';

/**
 * The fd-anchored helper (`world-fs.ts`): the root is resolved once, every
 * component below it is addressed through `/proc/self/fd/<parent>`, and a
 * parent swap after the pin cannot redirect a lookup, read, chmod, mkdir,
 * rename or unlink outside the pinned directory. The canaries are fake files
 * only; no real secret is touched.
 */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ root: string; world: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'es-world-fs-'));
  roots.push(root);
  const world = join(root, 'world');
  const outside = join(root, 'outside');
  await mkdir(world);
  await mkdir(outside);
  return { root, world, outside };
}

describe('the pinned root and its canonical proof', () => {
  it('resolves a legacy symlinked root once and proves the pinned fd canonical', async () => {
    const { root, world } = await fixture();
    await writeFile(join(world, 'a.txt'), 'hello\n');
    const alias = join(root, 'alias');
    await symlink(world, alias);
    const rootHandle = await openPinnedRoot(alias);
    try {
      expect(await realpathFd(rootHandle)).toBe(await realpath(world));
      const entry = await lstatAt(rootHandle.fd, 'a.txt');
      expect(entry.isFile()).toBe(true);
    } finally {
      await rootHandle.close();
    }
  });

  it('refuses a non-absolute root and a missing root with the typed family', async () => {
    await expect(openPinnedRoot('relative/path')).rejects.toBeInstanceOf(
      WorldFsInvalidPathError);
    const { root } = await fixture();
    await expect(openPinnedRoot(join(root, 'absent'))).rejects.toBeInstanceOf(
      WorldFsMissingError);
  });
});

describe('every later operation stays in the pinned directory after a parent swap', () => {
  it('lstat/open/chmod/mkdir/rename/unlink address the pinned dir, never the swapped path', async () => {
    const { world, outside } = await fixture();
    await mkdir(join(world, 'docs'));
    await writeFile(join(world, 'docs', 'x.txt'), 'inside bytes\n', { mode: 0o600 });
    await writeFile(join(outside, 'canary.txt'), 'outside bytes\n', { mode: 0o640 });
    const canaryBefore = await stat(join(outside, 'canary.txt'));

    const rootHandle = await openPinnedRoot(world);
    const parent = await openPinnedParent(rootHandle.fd, ['docs']);
    try {
      // The attacker swaps the pinned directory's name for a symlink to the
      // external canary after the pin. The fd authority must not move.
      await rename(join(world, 'docs'), join(world, 'docs.pinned'));
      await symlink(outside, join(world, 'docs'));

      const entry = await lstatAt(parent.fd, 'x.txt');
      expect(entry.isFile()).toBe(true);
      const leaf = await openLeafAt(parent.fd, 'x.txt', 0);
      try {
        expect(await leaf.readFile()).toEqual(Buffer.from('inside bytes\n'));
        await chmodFd(leaf, 0o640);
      } finally {
        await leaf.close();
      }
      expect(((await stat(join(world, 'docs.pinned', 'x.txt'))).mode & 0o777)).toBe(0o640);
      expect((await stat(join(outside, 'x.txt')).catch(() => null))).toBeNull();

      await mkdirAt(parent.fd, 'created');
      expect((await stat(join(world, 'docs.pinned', 'created'))).isDirectory()).toBe(true);
      expect((await stat(join(outside, 'created')).catch(() => null))).toBeNull();

      await renameAt(parent.fd, 'x.txt', parent.fd, 'y.txt');
      expect(await readFile(join(world, 'docs.pinned', 'y.txt'), 'utf8')).toBe('inside bytes\n');
      expect((await stat(join(outside, 'y.txt')).catch(() => null))).toBeNull();

      await unlinkAt(parent.fd, 'y.txt');
      expect(await stat(join(world, 'docs.pinned', 'y.txt')).catch(() => null)).toBeNull();
      expect((await stat(join(outside, 'y.txt')).catch(() => null))).toBeNull();
    } finally {
      await parent.close();
      await rootHandle.close();
    }
    // The external canary stays byte- and mode-identical.
    const canaryAfter = await stat(join(outside, 'canary.txt'));
    expect(await readFile(join(outside, 'canary.txt'), 'utf8')).toBe('outside bytes\n');
    expect(canaryAfter.mode & 0o777).toBe(canaryBefore.mode & 0o777);
  });
});

describe('the typed failures: missing, unsafe-parent and /proc', () => {
  it('separates a symlink/non-directory parent from a missing entry', async () => {
    const { world, outside } = await fixture();
    await writeFile(join(world, 'a-file'), 'x');
    await symlink(outside, join(world, 'link'));
    const rootHandle = await openPinnedRoot(world);
    try {
      await expect(openPinnedParent(rootHandle.fd, ['link'])).rejects.toBeInstanceOf(
        WorldFsUnsafeParentError);
      await expect(openPinnedParent(rootHandle.fd, ['a-file'])).rejects.toBeInstanceOf(
        WorldFsUnsafeParentError);
      await expect(openPinnedParent(rootHandle.fd, ['absent'])).rejects.toBeInstanceOf(
        WorldFsMissingError);
      await expect(lstatAt(rootHandle.fd, 'absent')).rejects.toBeInstanceOf(
        WorldFsMissingError);
      await expect(openLeafAt(rootHandle.fd, 'absent', 0)).rejects.toBeInstanceOf(
        WorldFsMissingError);
      // A missing entry is never the unsafe-parent arm and vice versa.
      await expect(lstatAt(rootHandle.fd, 'link')).resolves.toMatchObject({});
      expect((await lstatAt(rootHandle.fd, 'link')).isSymbolicLink()).toBe(true);
    } finally {
      await rootHandle.close();
    }
  });

  it('an unavailable procRoot is typed /proc-unavailable, never a missing entry', async () => {
    const { root, world } = await fixture();
    await writeFile(join(world, 'a.txt'), 'x');
    const rootHandle = await openPinnedRoot(world);
    const fakeProc = join(root, 'no-proc');
    try {
      await expect(lstatAt(rootHandle.fd, 'a.txt', { procRoot: fakeProc }))
        .rejects.toBeInstanceOf(WorldFsProcUnavailableError);
      await expect(openLeafAt(rootHandle.fd, 'a.txt', 0, { procRoot: fakeProc }))
        .rejects.toBeInstanceOf(WorldFsProcUnavailableError);
      await expect(openPinnedParent(rootHandle.fd, ['x'], { procRoot: fakeProc }))
        .rejects.toBeInstanceOf(WorldFsProcUnavailableError);
      await expect(realpathFd(rootHandle, { procRoot: fakeProc }))
        .rejects.toBeInstanceOf(WorldFsProcUnavailableError);
    } finally {
      await rootHandle.close();
    }
  });

  it('refuses invalid component names before touching the filesystem', async () => {
    const { world } = await fixture();
    const rootHandle = await openPinnedRoot(world);
    try {
      for (const name of ['', '.', '..', 'a/b', 'a\0b']) {
        await expect(lstatAt(rootHandle.fd, name)).rejects.toBeInstanceOf(
          WorldFsInvalidPathError);
      }
    } finally {
      await rootHandle.close();
    }
  });
});

describe('creation is idempotent and creation-only', () => {
  it('mkdirAt treats EEXIST as success and openPinnedDirAt reopens once', async () => {
    const { world } = await fixture();
    const rootHandle = await openPinnedRoot(world);
    try {
      await mkdirAt(rootHandle.fd, 'new-dir', { mode: 0o700 });
      await expect(mkdirAt(rootHandle.fd, 'new-dir', { mode: 0o700 })).resolves.toBeUndefined();
      const first = await openPinnedDirAt(rootHandle.fd, 'new-dir', { create: true, mode: 0o700 });
      await first.close();
      // The reopen arm: the directory already exists, so create:true is an
      // open, not a re-mode.
      await chmod(join(world, 'new-dir'), 0o755);
      const second = await openPinnedDirAt(rootHandle.fd, 'new-dir', {
        create: true, mode: 0o700,
      });
      await second.close();
      expect(((await stat(join(world, 'new-dir'))).mode & 0o777)).toBe(0o755);
    } finally {
      await rootHandle.close();
    }
  });
});

describe('handle cleanup', () => {
  it('closes the root and leaf handles it opens', async () => {
    const { world } = await fixture();
    await writeFile(join(world, 'a.txt'), 'x\n');
    const root = await openPinnedRoot(world);
    const rootFd = root.fd;
    const leaf = await openLeafAt(root.fd, 'a.txt', 0);
    const leafFd = leaf.fd;
    await leaf.close();
    await root.close();
    await expect(lstat(`/proc/self/fd/${String(leafFd)}`))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(`/proc/self/fd/${String(rootFd)}`))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
