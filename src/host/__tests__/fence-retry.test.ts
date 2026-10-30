import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHostLog } from '../observe.js';

/**
 * The fence port's vanished-leaf branches, with the cgroup calls mocked so the
 * rare ENOENT windows are deterministic. The real freeze/thaw primitives and
 * the fake-cgroupfs behavior live in fence.test.ts / cgroups.test.ts; here the
 * question is only the port's decision after a leaf disappears: re-enumerate
 * and freeze the survivors once, or refuse when the node's own leaf is gone.
 */
const freezeSet = vi.hoisted(() => vi.fn());
const thawSet = vi.hoisted(() => vi.fn(async () => {}));
const ensureLeaf = vi.hoisted(() => vi.fn(async () => {}));
const listLeaves = vi.hoisted(() => vi.fn(async (): Promise<readonly string[]> => []));

vi.mock('../cgroups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cgroups.js')>();
  return { ...actual, freezeSet, thawSet, ensureLeaf, listLeaves };
});

import { createFencePort } from '../fence.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'es-fence-retry-'));
  freezeSet.mockReset();
  thawSet.mockReset();
  thawSet.mockResolvedValue(undefined);
  ensureLeaf.mockReset();
  ensureLeaf.mockResolvedValue(undefined);
  listLeaves.mockReset();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('retries once when a run leaf vanished and freezes the survivors', async () => {
  const node = join(root, 'node-node-0');
  await mkdir(node);
  const gone = join(root, 'run-gone'); // listed, but never created on disk
  listLeaves.mockResolvedValue([gone]);
  freezeSet
    .mockResolvedValueOnce({ ok: false, reason: 'freeze-write: ENOENT' })
    .mockResolvedValueOnce({ ok: true });
  const port = createFencePort({ root, uid: 'node-0', log: createHostLog(() => {}) });

  await expect(port.acquire()).resolves.toEqual({ fenced: true, leaves: 1 });
  expect(freezeSet).toHaveBeenCalledTimes(2);
  expect(freezeSet.mock.calls[1]![0]).toEqual([node]);
  await port.release();
});

it('refuses when the node leaf itself vanished rather than freezing a subset', async () => {
  listLeaves.mockResolvedValue([]);
  freezeSet.mockResolvedValueOnce({ ok: false, reason: 'freeze-write: ENOENT' });
  const port = createFencePort({ root, uid: 'node-0', log: createHostLog(() => {}) });

  const outcome = await port.acquire();
  expect(outcome).toMatchObject({ fenced: false, reason: 'freeze-failed' });
  if (!outcome.fenced) expect(outcome.detail).toBe('node-leaf-vanished');
  // The failed attempt thaws what it had, so the caller is never left frozen.
  expect(thawSet).toHaveBeenCalled();
  await port.release();
});
