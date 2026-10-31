import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
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

it('refuses when a run leaf cannot be statted instead of reporting it vanished', async () => {
  if (process.getuid?.() === 0) return; // root ignores 000 modes
  const node = join(root, 'node-node-0');
  await mkdir(node);
  // A listed run leaf whose parent is unsearchable: lstat fails EACCES, which is
  // not evidence the leaf vanished. Fencing the survivors and reporting
  // `fenced: true` would leave that Run un-frozen inside the critical section.
  const locked = join(root, 'locked');
  const bad = join(locked, 'run-bad');
  await mkdir(locked);
  await mkdir(bad);
  await chmod(locked, 0o000);
  // The bad leaf is returned by BOTH enumerations (the first list and the
  // vanished-leaf retry), so the retry really lstat's it. Pre-fix the catch
  // dropped it, the survivor set changed to [node], and the second freezeSet
  // succeeded — `fenced: true` with the Run un-frozen. The pre-fix code must
  // therefore fail this test on the outcome, not merely on a detail string.
  listLeaves.mockResolvedValue([bad]);
  freezeSet
    .mockResolvedValueOnce({ ok: false, reason: 'freeze-write: ENOENT' })
    .mockResolvedValueOnce({ ok: true });
  const port = createFencePort({ root, uid: 'node-0', log: createHostLog(() => {}) });
  try {
    const outcome = await port.acquire();
    expect(outcome).toMatchObject({ fenced: false, reason: 'freeze-failed' });
    if (!outcome.fenced) expect(outcome.detail).toBe('EACCES');
    // The failed attempt never retried with a subset: it thawed and refused
    // after the first freeze attempt (the retry's freeze is never reached).
    expect(freezeSet).toHaveBeenCalledTimes(1);
    expect(thawSet).toHaveBeenCalled();
  } finally {
    await chmod(locked, 0o700);
    await port.release();
  }
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
