import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFencePort } from '../fence.js';
import { createHostLog } from '../observe.js';

/**
 * The production fence port against a fake cgroupfs: a temp directory whose
 * leaves carry `cgroup.freeze`/`cgroup.events` files. The port's contract is
 * testable there without a live cgroup — the freeze wait, the timeout, the
 * thaw, the leaf enumeration and the one bounded `host/fence` line per acquire.
 * The real cgroup transition (`frozen 1`) is covered by cgroups.test.ts and the
 * real-cell control by fence-integration.test.ts.
 *
 * The fake leaf files are static: `cgroup.events` says what the wait should
 * observe, and `cgroup.freeze` records what the port wrote. An empty leaf with
 * no events file is the "vanished" shape the freeze wait treats as gone.
 */

let root = '';
const lines: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'es-fence-port-'));
  lines.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function log() {
  return createHostLog((line) => lines.push(line));
}

/** The port's one diagnostic line per acquire, parsed. */
function fenceLines(): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'host/fence');
}

it('freezes the created node leaf plus every run leaf and logs one bounded line', async () => {
  const run = join(root, 'run-a');
  await mkdir(run);
  // The Run leaf reports frozen immediately; the node leaf is created by the
  // port (its missing events file is the empty/vanished shape).
  await writeFile(join(run, 'cgroup.events'), 'frozen 1\n');
  const port = createFencePort({ root, uid: 'node-0', log: log() });
  const outcome = await port.acquire();
  expect(outcome).toEqual({ fenced: true, leaves: 2 });
  expect((await readFile(join(root, 'node-node-0', 'cgroup.freeze'), 'utf8')).trim()).toBe('1');
  expect((await readFile(join(run, 'cgroup.freeze'), 'utf8')).trim()).toBe('1');
  expect(fenceLines()).toEqual([{ event: 'host/fence', state: 'fenced', leaves: 2, ms: expect.any(Number) }]);
  // A path never enters the diagnostic line.
  expect(JSON.stringify(fenceLines())).not.toContain(root);
  await port.release();
  expect((await readFile(join(root, 'node-node-0', 'cgroup.freeze'), 'utf8')).trim()).toBe('0');
  expect((await readFile(join(run, 'cgroup.freeze'), 'utf8')).trim()).toBe('0');
  // Idempotent: a second release writes nothing it no longer holds.
  await port.release();
});

it('freezes an empty node leaf and reports one leaf', async () => {
  const node = join(root, 'node-node-0');
  await mkdir(node);
  await writeFile(join(node, 'cgroup.events'), 'frozen 1\n');
  const port = createFencePort({ root, uid: 'node-0', log: log() });
  expect(await port.acquire()).toEqual({ fenced: true, leaves: 1 });
  expect(fenceLines()).toEqual([{ event: 'host/fence', state: 'fenced', leaves: 1, ms: expect.any(Number) }]);
  await port.release();
});

it('maps a freeze that never lands to freeze-failed after thawing', async () => {
  const node = join(root, 'node-node-0');
  await mkdir(node);
  await writeFile(join(node, 'cgroup.events'), 'frozen 0\n');
  const port = createFencePort({ root, uid: 'node-0', log: log() });
  const started = Date.now();
  const outcome = await port.acquire();
  expect(outcome).toMatchObject({ fenced: false, reason: 'freeze-failed' });
  if (!outcome.fenced) expect(outcome.detail).toContain('freeze-timeout');
  // The 2 s LIMITS deadline is the freeze bound, and the port thaws on failure:
  // no caller is ever left frozen by a refused commit attempt.
  expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  expect((await readFile(join(node, 'cgroup.freeze'), 'utf8')).trim()).toBe('0');
  expect(fenceLines()).toEqual([
    { event: 'host/fence', state: 'freeze-failed', leaves: 1, ms: expect.any(Number) },
  ]);
  expect(JSON.stringify(fenceLines())).not.toContain(root);
  await port.release();
});

it('skips a vanished run leaf instead of failing the fence', async () => {
  // A `run-*` entry listed and then gone before the freeze write would be an
  // ENOENT write; listLeaves prunes entries that are not directories, and the
  // freeze wait treats a vanished events file as gone (a frozen run is already
  // over). Here: one real run leaf and one stale non-directory entry.
  await mkdir(join(root, 'run-live'));
  await writeFile(join(root, 'run-live', 'cgroup.events'), 'frozen 1\n');
  await writeFile(join(root, 'run-gone'), 'not a leaf');
  const port = createFencePort({ root, uid: 'node-0', log: log() });
  expect(await port.acquire()).toEqual({ fenced: true, leaves: 2 });
  await port.release();
});
