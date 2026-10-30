import {
  lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Records the directory fsyncs the module performs, so the clear's durability
 * (and the write's) is observable without inspecting the filesystem.
 */
const syncPathCalls = vi.hoisted(() => [] as string[]);
vi.mock('../../journal/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../journal/index.js')>();
  return {
    ...actual,
    syncPath: async (path: string): Promise<void> => {
      syncPathCalls.push(path);
      await actual.syncPath(path);
    },
  };
});

import {
  HEALTHY_WORLD_STATE, WORLD_STATE_BASENAME, clearWorldState, markWorldDegraded,
  readWorldState, worldStatePath,
} from '../world-state.js';

/**
 * The durable degraded-world sidecar: a 0600 atomic projection written at
 * refusal time and cleared only by a successful commit. Its read is total —
 * a damaged, absent or non-regular file is healthy, never a throw — so a
 * damaged home can still be reported on.
 */
let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'es-world-state-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('reads a missing sidecar as healthy', async () => {
  await expect(readWorldState(home)).resolves.toEqual(HEALTHY_WORLD_STATE);
});

it('writes 0600 atomically and reads the degraded fact back', async () => {
  await markWorldDegraded(home, 'git-exit', 1234);
  const path = worldStatePath(home);
  expect(path).toBe(join(home, WORLD_STATE_BASENAME));
  const info = await stat(path);
  expect(info.mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    v: 1, degraded: true, reason: 'git-exit', at: 1234,
  });
  await expect(readWorldState(home)).resolves.toEqual({
    v: 1, degraded: true, reason: 'git-exit', at: 1234,
  });
  // No temp file outlives the rename.
  expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

it('bounds the reason to one line', async () => {
  await markWorldDegraded(home, `git-exit\n${'x'.repeat(1000)}`, 1);
  const state = await readWorldState(home);
  expect(state.degraded).toBe(true);
  expect(state.reason).not.toMatch(/[\n\t]/);
  expect(Array.from(state.reason ?? '')).toHaveLength(120);
});

it('is total: malformed, invalid, unknown-key and non-regular files read healthy', async () => {
  const path = worldStatePath(home);
  await writeFile(path, 'not json', { mode: 0o600 });
  await expect(readWorldState(home)).resolves.toEqual(HEALTHY_WORLD_STATE);
  await writeFile(path, JSON.stringify({ v: 1, degraded: 'yes' }), { mode: 0o600 });
  await expect(readWorldState(home)).resolves.toEqual(HEALTHY_WORLD_STATE);
  await writeFile(path, JSON.stringify({ v: 1, degraded: true, extra: 1 }), { mode: 0o600 });
  await expect(readWorldState(home)).resolves.toEqual(HEALTHY_WORLD_STATE);
  await rm(path);
  const target = join(home, 'target.json');
  await writeFile(target, JSON.stringify({ v: 1, degraded: true, reason: 'git-exit' }));
  await symlink(target, path);
  // A link is observed, never followed: it is not a sidecar this kernel wrote.
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  await expect(readWorldState(home)).resolves.toEqual(HEALTHY_WORLD_STATE);
});

it('reads a directory at the sidecar path as healthy', async () => {
  // The lstat probe refuses anything that is not a regular file, so a directory
  // (or a device/fifo) reads healthy rather than making a report fail.
  await mkdir(worldStatePath(home));
  await expect(readWorldState(home)).resolves.toEqual(HEALTHY_WORLD_STATE);
});

it('clears only by the explicit successful-commit clear', async () => {
  syncPathCalls.length = 0;
  await markWorldDegraded(home, 'walk-eacces', 1);
  // The write makes its rename durable.
  expect(syncPathCalls).toEqual([home]);
  syncPathCalls.length = 0;
  await clearWorldState(home);
  // The unlink is durable too: a crash must not resurrect the stale sidecar.
  expect(syncPathCalls).toEqual([home]);
  await expect(readWorldState(home)).resolves.toEqual(HEALTHY_WORLD_STATE);
  // Clearing an already-healthy home is a no-op and fsyncs nothing.
  syncPathCalls.length = 0;
  await expect(clearWorldState(home)).resolves.toBeUndefined();
  expect(syncPathCalls).toEqual([]);
});
