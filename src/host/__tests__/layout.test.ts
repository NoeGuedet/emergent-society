import { access, chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assertCellLayout, assertHomeOutsideCheckout, assertHomePermissions, cellPaths, initHome,
} from '../layout.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
/** Assigned by each case that needs a temp home; `''` when the case has none. */
let home = '';

afterEach(async () => { if (home !== '') await rm(home, { recursive: true, force: true }); });

it('cellPaths derives the kernel literals and validates the uid', () => {
  expect(cellPaths('/h', 'node-0')).toEqual({
    home: '/h', world: '/h/world', gitDir: '/h/world.git',
    frontierDir: '/h/frontier', nodeDir: '/h/nodes/node-0',
    nodeLogFile: '/h/nodes/node-0/log.v0.jsonl.zstd',
    providersFile: '/h/providers.json', ownerFile: '/h/host.json',
  });
  expect(() => cellPaths('/h', '../x')).toThrow(/invalid node uid/);
});

it('initHome creates 0700, is idempotent, and never creates providers.json', async () => {
  home = await mkdtemp(join(tmpdir(), 'es-home-'));
  const a = await initHome(home);
  expect(a.created).toBe(true);
  expect((await stat(home)).mode & 0o077).toBe(0);
  const b = await initHome(home);
  expect(b.created).toBe(false);
  await expect(access(join(home, 'providers.json'))).rejects.toThrow();
  await expect(assertCellLayout(home)).resolves.toBeUndefined();
});

it('refuses a partial layout and a home inside the checkout', async () => {
  home = await mkdtemp(join(tmpdir(), 'es-home-'));
  await mkdir(join(home, 'world'), { recursive: true });
  await expect(initHome(home)).rejects.toThrow(/partial cell layout/);
  await expect(assertHomeOutsideCheckout(join(repoRoot, 'tmp-cell')))
    .rejects.toThrow(/home must be outside the project checkout/);
  const link = join(home, 'repo-link');
  await symlink(repoRoot, link);
  await expect(assertHomeOutsideCheckout(join(link, 'x')))
    .rejects.toThrow(/home must be outside the project checkout/);
});

it('refuses a pre-existing permissive or foreign home and a non-directory', async () => {
  home = await mkdtemp(join(tmpdir(), 'es-home-'));
  await chmod(home, 0o755);
  await expect(assertHomePermissions(home)).rejects.toThrow(/chmod 700/);
  await chmod(home, 0o700);
  await expect(assertHomePermissions(home)).resolves.toBeUndefined();
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    try { await expect(assertHomePermissions(home)).rejects.toThrow(/owned by the host uid/); }
    finally { spy.mockRestore(); }
  }
  const file = join(home, 'not-a-dir');
  await writeFile(file, '');
  await expect(assertHomePermissions(file)).rejects.toThrow(/home must be a directory/);
});
