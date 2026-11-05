import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RunsStore } from '../cockpit/runs.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ID = '33333333-3333-4333-8333-333333333333';

it('refuses a symlinked UUID run directory even with a valid outside manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'es-cockpit-runs-'));
  roots.push(root);
  const runsRoot = join(root, 'runs');
  const outside = join(root, 'outside');
  await mkdir(runsRoot, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, 'run.json'), JSON.stringify({
    v: 0, id: ID, label: 'outside', heading: 'Outside.',
    nodeModel: 'm', gatewayModel: 'g', nodeCount: 1, spawn: false, createdAt: 1,
  }), { mode: 0o600 });
  await symlink(outside, join(runsRoot, ID));

  const store = await RunsStore.open(runsRoot);
  await expect(store.read(ID)).rejects.toThrow(/pinned directory/);
  await expect(store.paths(ID)).rejects.toThrow(/pinned directory/);
  expect(await store.list()).toEqual([]);
});

it('refuses a symlinked runs root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'es-cockpit-runs-root-'));
  roots.push(root);
  const real = join(root, 'real');
  const link = join(root, 'link');
  await mkdir(real, { mode: 0o700 });
  await symlink(real, link);
  await expect(RunsStore.open(link)).rejects.toThrow(/runs root/);
});
