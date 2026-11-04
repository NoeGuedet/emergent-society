import {
  chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import { WorldRepo } from '../../node/world.js';
import {
  EXECUTION_MARKER_FILE, VM_NETWORK_FILE, assertExecutionStartable,
  classifyFreshVolumeRoot, hasVmEvidence,
} from '../execution.js';
import { startHost, type HostOptions } from '../host.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';

/**
 * The fresh-root emptiness rule and the evidence-scan IO guard, isolated behind
 * one partial `node:fs/promises` metadata fetch (the test user cannot own a real
 * root:root `lost+found`, and no sudo is used). Only the metadata of the one
 * named path is synthesized; every other filesystem call is the real module.
 */
const mockState = vi.hoisted(() => ({ fakeRoot: '', eaccesPath: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rawLstat = actual.lstat as (path: string) => Promise<import('node:fs').Stats>;
  const lstat = (async (path: string) => {
    if (mockState.eaccesPath !== '' && String(path) === mockState.eaccesPath) {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    const info = await rawLstat(path);
    if (mockState.fakeRoot === '' || String(path) !== mockState.fakeRoot) return info;
    const fake = Object.assign(Object.create(Object.getPrototypeOf(info)), info);
    fake.uid = 0;
    fake.gid = 0;
    fake.mode = 0o40700;
    return fake;
  }) as unknown as typeof actual.lstat;
  return { ...actual, lstat };
});

const homes: string[] = [];

afterEach(async () => {
  mockState.fakeRoot = '';
  mockState.eaccesPath = '';
  for (const home of homes.splice(0)) {
    // The unreadable-directory fixture chmods its own entry back: restore it so
    // the cleanup can descend.
    await chmod(join(home, 'vm', 'lost+found'), 0o700).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'es-exec-evidence-'));
  homes.push(dir);
  return dir;
}

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function hostRefusal(
  home: string,
): Promise<{ code: number; attach: number; config: number }> {
  const log = createHostLog(() => {});
  let attach = 0;
  let config = 0;
  const options: HostOptions = {
    home, uid: 'node-0', command: 'start', sandbox: {}, pollMs: 0, log,
    model: 'model-x', heading: 'heading',
  };
  const handle = startHost(options, {
    installSignals: false, keepAlive: false,
    attachToCell: async () => {
      attach += 1;
      return { ok: false as const, reason: 'test-stub' };
    },
    readInitialConfig: async () => {
      config += 1;
      return validateAgentConfig({ ...defaultAgentConfig(), model: 'model-x' });
    },
  });
  return { code: await handle.done, attach, config };
}

async function makeVolumeHome(): Promise<string> {
  const home = await realpath(await makeHome());
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  await mkdir(join(home, 'vm'), { mode: 0o700 });
  await chmod(join(home, 'vm'), 0o700);
  return home;
}

async function makeLostFound(home: string): Promise<string> {
  const lostFound = join(home, 'vm', 'lost+found');
  await mkdir(lostFound, { mode: 0o700 });
  await chmod(lostFound, 0o700);
  return lostFound;
}

it('a non-empty root:root lost+found is damaged, never pristine evidence', async () => {
  const home = await makeVolumeHome();
  const lostFound = await makeLostFound(home);
  await writeFile(join(lostFound, 'kept'), 'x');
  mockState.fakeRoot = lostFound;

  expect(await classifyFreshVolumeRoot(join(home, 'vm'))).toBe('damaged');
  await expect(hasVmEvidence(home)).resolves.toBe(true);
  await expect(assertExecutionStartable(home, { noSandbox: false }))
    .rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(initHome(home)).rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(absent(join(home, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);

  const refusal = await hostRefusal(home);
  expect(refusal.code).toBe(2);
  expect(refusal.attach).toBe(0);
  expect(refusal.config).toBe(0);
  // The root-owned shape is never adopted, modified or removed.
  expect((await readdir(lostFound))).toEqual(['kept']);
});

it('an unreadable root:root lost+found is damaged, never pristine evidence', async () => {
  const home = await makeVolumeHome();
  const lostFound = await makeLostFound(home);
  await writeFile(join(lostFound, 'kept'), 'x');
  mockState.fakeRoot = lostFound;
  await chmod(lostFound, 0o000);

  expect(await classifyFreshVolumeRoot(join(home, 'vm'))).toBe('damaged');
  await expect(hasVmEvidence(home)).resolves.toBe(true);
  await expect(initHome(home)).rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(absent(join(home, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  expect((await lstat(lostFound)).isDirectory()).toBe(true);
});

it('an unreadable network-record presence refuses typed instead of reading absence', async () => {
  const home = await makeVolumeHome();
  mockState.eaccesPath = join(home, '.es', VM_NETWORK_FILE);

  await expect(hasVmEvidence(home)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(assertExecutionStartable(home, { noSandbox: false }))
    .rejects.toThrow(/execution\/layout-damaged/);
  await expect(initHome(home)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(home, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);

  const refusal = await hostRefusal(home);
  expect(refusal.code).toBe(2);
  expect(refusal.attach).toBe(0);
  expect(refusal.config).toBe(0);
});
