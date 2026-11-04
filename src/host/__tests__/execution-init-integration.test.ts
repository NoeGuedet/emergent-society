import {
  chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WorldRepo } from '../../node/world.js';
import {
  EXECUTION_MARKER_FILE, VM_NETWORK_FILE, assertVmVolumes,
} from '../execution.js';
import { initHome } from '../layout.js';

/**
 * The `initMarkedHome` callsite integration: the post-init volume guard, the
 * network-record read and the world-pair validation must each be reachable on
 * the real path. Only the mounted-root check is stubbed (this suite cannot
 * create ext4 mounts unprivileged); every other guard is the real module. A
 * deletion of any one callsite changes the observed refusal.
 */
vi.mock('../execution.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../execution.js')>();
  return {
    ...actual,
    assertVmVolumes: vi.fn(async () => {}),
  };
});

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'es-exec-init-'));
  homes.push(dir);
  return dir;
}

async function makeEs(home: string): Promise<void> {
  await mkdir(join(home, '.es'), { mode: 0o700, recursive: true });
  await chmod(join(home, '.es'), 0o700);
}

async function writeMarker(home: string, imagePath: string): Promise<void> {
  await makeEs(home);
  const path = join(home, '.es', EXECUTION_MARKER_FILE);
  await writeFile(path, JSON.stringify({
    v: 1, backend: 'vm-qemu', createdAt: 1,
    image: { path: imagePath, sha256: 'a'.repeat(64), bytes: 1 },
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeNetwork(home: string): Promise<void> {
  const canonical = await realpath(home);
  await makeEs(home);
  const path = join(home, '.es', VM_NETWORK_FILE);
  await writeFile(path, JSON.stringify({
    v: 1, home: canonical, id: 'ab12cd', n: 1,
    interface: 'estapab12cd', bridge: 'esbrab12cd',
    guest: { addr: '10.200.1.2', prefix: 30, gateway: '10.200.1.1' },
    dns: '1.1.1.1', mac: '02:00:00:00:00:01',
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function setupVmHome(): Promise<{ home: string; image: string }> {
  const imageDir = await realpath(await makeHome());
  const image = join(imageDir, 'base.qcow2');
  const home = await makeHome();
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  await mkdir(join(home, 'vm'), { mode: 0o700 });
  await chmod(join(home, 'vm'), 0o700);
  await writeNetwork(home);
  await writeMarker(home, image);
  return { home, image };
}

async function markerSnapshot(home: string) {
  const path = join(home, '.es', EXECUTION_MARKER_FILE);
  return {
    bytes: await readFile(path),
    ino: (await stat(path)).ino,
    worldIno: (await stat(join(home, 'world'))).ino,
    gitIno: (await stat(join(home, 'world.git'))).ino,
    head: await readFile(join(home, 'world.git', 'HEAD')),
  };
}

async function expectMarkerUnchanged(home: string, before: Awaited<ReturnType<typeof markerSnapshot>>) {
  const after = await markerSnapshot(home);
  expect(after.bytes).toEqual(before.bytes);
  expect(after.ino).toBe(before.ino);
  expect(after.worldIno).toBe(before.worldIno);
  expect(after.gitIno).toBe(before.gitIno);
  expect(after.head).toEqual(before.head);
}

it('a valid vm-marker re-init reaches the real post-init lost+found guard', async () => {
  const { home, image } = await setupVmHome();
  const before = await markerSnapshot(home);
  const lostFound = join(home, 'vm', 'lost+found');
  await mkdir(lostFound, { mode: 0o700 });
  await chmod(lostFound, 0o700);

  await expect(initHome(home, { backend: 'vm-qemu', imagePath: image }))
    .rejects.toThrow(/post-init lost\+found/);
  expect(vi.mocked(assertVmVolumes)).toHaveBeenCalledWith(home);
  // The guard is read-only: the entry stays and no marker/world byte moves.
  expect((await lstat(lostFound)).isDirectory()).toBe(true);
  await expectMarkerUnchanged(home, before);
});

it('a valid vm-marker re-init with a missing network record reaches the real read', async () => {
  const imageDir = await realpath(await makeHome());
  const image = join(imageDir, 'base.qcow2');
  const home = await makeHome();
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  await mkdir(join(home, 'vm'), { mode: 0o700 });
  await chmod(join(home, 'vm'), 0o700);
  await writeMarker(home, image);
  const before = await markerSnapshot(home);

  await expect(initHome(home, { backend: 'vm-qemu', imagePath: image }))
    .rejects.toThrow(/execution\/network-record-absent/);
  expect(vi.mocked(assertVmVolumes)).toHaveBeenCalledWith(home);
  await expectMarkerUnchanged(home, before);
});

it('a valid vm-marker re-init with an invalid world.git reaches the real pair validation', async () => {
  const { home, image } = await setupVmHome();
  const before = await markerSnapshot(home);
  // Replace the valid external non-bare gitdir with a raw empty directory: the
  // pair is both-present but not a repository, so only assertBothValid can
  // refuse it on this path.
  await rm(join(home, 'world.git'), { recursive: true, force: true });
  await mkdir(join(home, 'world.git'), { mode: 0o700 });

  await expect(initHome(home, { backend: 'vm-qemu', imagePath: image }))
    .rejects.toThrow(/execution\/layout-damaged/);
  expect(vi.mocked(assertVmVolumes)).toHaveBeenCalledWith(home);
  expect(await readFile(join(home, '.es', EXECUTION_MARKER_FILE))).toEqual(before.bytes);
  expect((await stat(join(home, '.es', EXECUTION_MARKER_FILE))).ino).toBe(before.ino);
});
