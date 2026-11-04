import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import { JournalWriter } from '../../journal/index.js';
import { WorldRepo } from '../../node/world.js';
import {
  EXECUTION_MARKER_FILE, VM_NETWORK_FILE, VM_OFFERING_MARKER,
  assertExecutionStartable, assertNoPostInitVolumeEntries, assertVmInitPrerequisites,
  assertVmVolumes, classifyFreshVolumeRoot, ensureExecutionDirectory, hasVmEvidence,
  parseExecutionMarker, parseVmNetworkRecord, pinExecutionImage, readExecutionMarker,
  readVmNetworkRecord, writeExecutionMarker,
  type VmNetworkRecord,
} from '../execution.js';
import { startHost, type HostOptions } from '../host.js';
import { assertCellLayout, initHome } from '../layout.js';
import { holdExclusiveLock } from '../../locked-append.js';
import { createHostLog } from '../observe.js';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function tempDir(prefix = 'es-exec-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  homes.push(dir);
  return dir;
}

async function makeHome(): Promise<string> {
  return await tempDir('es-exec-home-');
}

/** A canonical home carrying two 0700 volume roots on the ordinary tmp filesystem. */
async function makeVolumeHome(): Promise<string> {
  const home = await realpath(await makeHome());
  await mkdir(join(home, 'world'), { mode: 0o700 });
  await mkdir(join(home, 'vm'), { mode: 0o700 });
  await chmod(join(home, 'world'), 0o700);
  await chmod(join(home, 'vm'), 0o700);
  return home;
}

async function makeEs(home: string): Promise<void> {
  await mkdir(join(home, '.es'), { mode: 0o700 });
  await chmod(join(home, '.es'), 0o700);
}

async function writeMarker(home: string, value: unknown, mode = 0o600): Promise<void> {
  await makeEs(home);
  const path = join(home, '.es', EXECUTION_MARKER_FILE);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode });
  await chmod(path, mode);
}

async function writeNetwork(home: string, value: unknown, mode = 0o600): Promise<void> {
  await makeEs(home);
  const path = join(home, '.es', VM_NETWORK_FILE);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode });
  await chmod(path, mode);
}

function landlockMarker(): unknown {
  return { v: 1, backend: 'landlock', createdAt: 1 };
}

function vmMarker(imagePath: string): unknown {
  return {
    v: 1, backend: 'vm-qemu', createdAt: 1,
    image: { path: imagePath, sha256: 'a'.repeat(64), bytes: 1 },
  };
}

function recordFor(home: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, home, id: 'ab12cd', n: 1,
    interface: 'estapab12cd', bridge: 'esbrab12cd',
    guest: { addr: '10.200.1.2', prefix: 30, gateway: '10.200.1.1' },
    dns: '1.1.1.1', mac: '02:00:00:00:00:01',
    ...overrides,
  };
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

const execFileAsync = promisify(execFile);

/** A real POSIX FIFO, no root required (util-linux `mkfifo`). */
async function makeFifo(path: string): Promise<void> {
  await execFileAsync('mkfifo', [path]);
}

/**
 * The only effect a refused or no-op init may leave in `.es` is the stable init
 * lock (the plan's allowed lock metadata): never a marker, and no layout or
 * world artifact.
 */
async function expectOnlyInitLock(home: string): Promise<void> {
  const es = join(home, '.es');
  expect((await readdir(es)).sort()).toEqual(['init.lock']);
  expect((await stat(join(es, 'init.lock'))).mode & 0o777).toBe(0o600);
}

async function hostRefusal(
  home: string, command: 'start' | 'resume', sandbox: HostOptions['sandbox'],
): Promise<{ code: number; messages: string[]; attach: number; config: number }> {
  const lines: string[] = [];
  const log = createHostLog((line) => { lines.push(line); });
  let attach = 0;
  let config = 0;
  const options: HostOptions = {
    home, uid: 'node-0', command, sandbox, pollMs: 0, log,
    ...(command === 'start' ? { model: 'model-x', heading: 'heading' } : {}),
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
  const code = await handle.done;
  const messages = lines.map((line) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return typeof parsed['message'] === 'string' ? parsed['message'] : '';
  }).filter((message) => message !== '');
  return { code, messages, attach, config };
}

async function seedVmConfig(home: string): Promise<void> {
  const base = defaultAgentConfig();
  const config = validateAgentConfig({
    ...base,
    tools: base.tools.map((tool) => tool.name === 'execute'
      ? { ...tool, description: `${VM_OFFERING_MARKER} ${tool.description}` }
      : tool),
  });
  const writer = await JournalWriter.open(home, 'node-0', {});
  writer.append('system/message', {
    version: config.version,
    value: { kind: 'inline', value: config },
  });
  await writer.flush();
  await writer.close();
}

it('fresh init writes the landlock marker before the world and stays idempotent', async () => {
  const home = await makeHome();
  const original = WorldRepo.init.bind(WorldRepo);
  let markerBeforeWorld = false;
  const spy = vi.spyOn(WorldRepo, 'init').mockImplementation(async (dir, opts) => {
    markerBeforeWorld = (await readExecutionMarker(home)) !== null;
    return await original(dir, opts);
  });
  try {
    expect((await initHome(home)).created).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(markerBeforeWorld).toBe(true);
  const marker = await readExecutionMarker(home);
  expect(marker).toMatchObject({ v: 1, backend: 'landlock' });
  const markerStat = await stat(join(home, '.es', EXECUTION_MARKER_FILE));
  expect(markerStat.mode & 0o777).toBe(0o600);
  expect((await stat(join(home, '.es'))).mode & 0o777).toBe(0o700);
  await expect(absent(join(home, 'vm'))).resolves.toBe(true);
  await expect(absent(join(home, 'providers.json'))).resolves.toBe(true);
  await expect(assertCellLayout(home)).resolves.toBeUndefined();
  const repo = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  expect(await repo.headHash()).toBeNull();
  expect((await initHome(home)).created).toBe(false);
  expect((await stat(join(home, '.es', EXECUTION_MARKER_FILE))).ino).toBe(markerStat.ino);
  // The first root commit lands on the unborn branch without a reset.
  await writeFile(join(home, 'world', 'a.txt'), 'a\n');
  const commit = await repo.commitAll('node-0', 'root');
  expect(commit).not.toBeNull();
  expect(await repo.headHash()).toBe(commit!.hash);
});

it('a legacy markerless home is unchanged and a symlinked pair is still accepted', async () => {
  const home = await makeHome();
  const pair = join(home, 'pair');
  expect((await initHome(pair)).created).toBe(true);
  const legacy = await makeHome();
  await WorldRepo.init(join(legacy, 'world'), { gitDir: join(legacy, 'world.git') });
  expect((await initHome(legacy)).created).toBe(false);
  await expect(absent(join(legacy, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expectOnlyInitLock(legacy);
  await symlink(join(pair, 'world'), join(home, 'world'));
  await symlink(join(pair, 'world.git'), join(home, 'world.git'));
  expect((await initHome(home)).created).toBe(false);
  await expect(absent(join(home, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expectOnlyInitLock(home);
  await expect(assertCellLayout(home)).resolves.toBeUndefined();
});

it('refuses every partial layout with no marker and no adoption', async () => {
  const worldOnly = await makeHome();
  await mkdir(join(worldOnly, 'world'));
  await expect(initHome(worldOnly)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(initHome(worldOnly)).rejects.toThrow(/partial cell layout/);
  await expect(absent(join(worldOnly, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expectOnlyInitLock(worldOnly);

  // A non-empty world is never adopted, never completed and never modified.
  const populated = await makeHome();
  await mkdir(join(populated, 'world'));
  await writeFile(join(populated, 'world', 'keep.txt'), 'keep\n');
  await expect(initHome(populated)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(populated, 'world.git'))).resolves.toBe(true);
  await expect(absent(join(populated, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expectOnlyInitLock(populated);
  expect(await readFile(join(populated, 'world', 'keep.txt'), 'utf8')).toBe('keep\n');

  const gitOnly = await makeHome();
  await mkdir(join(gitOnly, 'world.git'));
  await expect(initHome(gitOnly)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(gitOnly, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expectOnlyInitLock(gitOnly);

  const invalid = await makeHome();
  await mkdir(join(invalid, 'world'));
  await mkdir(join(invalid, 'world.git'));
  await expect(initHome(invalid)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(invalid, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expectOnlyInitLock(invalid);
});

it('refuses a dangling world or world.git symlink before any marker or world write', async () => {
  const danglingWorld = await makeHome();
  await symlink(join(danglingWorld, 'missing-world'), join(danglingWorld, 'world'));
  await expect(initHome(danglingWorld)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(danglingWorld, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expect(absent(join(danglingWorld, 'world.git'))).resolves.toBe(true);
  expect((await lstat(join(danglingWorld, 'world'))).isSymbolicLink()).toBe(true);

  const danglingPair = await makeHome();
  await symlink(join(danglingPair, 'missing-world'), join(danglingPair, 'world'));
  await symlink(join(danglingPair, 'missing-world.git'), join(danglingPair, 'world.git'));
  await expect(initHome(danglingPair)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(danglingPair, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expectOnlyInitLock(danglingPair);
  expect((await lstat(join(danglingPair, 'world'))).isSymbolicLink()).toBe(true);
});

it('an invalid both-present pair is layout-damaged even for a VM request', async () => {
  const imageDir = await tempDir('es-exec-image-');
  const invalid = await makeHome();
  await mkdir(join(invalid, 'world'));
  await mkdir(join(invalid, 'world.git'));
  await expect(initHome(invalid, {
    backend: 'vm-qemu', imagePath: join(imageDir, 'base.qcow2'),
  })).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(invalid, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);

  // A valid marker-less legacy pair keeps the explicit non-upgrade refusal.
  const valid = await makeHome();
  await WorldRepo.init(join(valid, 'world'), { gitDir: join(valid, 'world.git') });
  await expect(initHome(valid, {
    backend: 'vm-qemu', imagePath: join(imageDir, 'base.qcow2'),
  })).rejects.toThrow(/execution\/marker-absent/);
  await expect(absent(join(valid, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
});

it('refuses an uncertain partial after the marker and never rebuilds the world', async () => {
  const home = await makeHome();
  await writeMarker(home, landlockMarker());
  const before = await readFile(join(home, '.es', EXECUTION_MARKER_FILE));
  await expect(initHome(home)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(home, 'world'))).resolves.toBe(true);
  await expect(absent(join(home, 'world.git'))).resolves.toBe(true);
  expect(await readFile(join(home, '.es', EXECUTION_MARKER_FILE))).toEqual(before);

  const worldOnly = await makeHome();
  await writeMarker(worldOnly, landlockMarker());
  await mkdir(join(worldOnly, 'world'));
  await expect(initHome(worldOnly)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(worldOnly, 'world.git'))).resolves.toBe(true);

  // The marker does not turn a both-present but invalid gitdir into a valid
  // home: the pair classification is the same typed zero-write refusal.
  const invalid = await makeHome();
  await writeMarker(invalid, landlockMarker());
  await mkdir(join(invalid, 'world'));
  await mkdir(join(invalid, 'world.git'));
  const invalidMarker = await readFile(join(invalid, '.es', EXECUTION_MARKER_FILE));
  await expect(initHome(invalid)).rejects.toThrow(/execution\/layout-damaged/);
  expect(await readFile(join(invalid, '.es', EXECUTION_MARKER_FILE))).toEqual(invalidMarker);
});

it('the init lock is exclusive: a second holder waits for the first release', async () => {
  const home = await makeHome();
  const es = await ensureExecutionDirectory(home);
  const path = join(es, 'init.lock');
  const first = await holdExclusiveLock(path);
  let secondHeld = false;
  const secondPromise = holdExclusiveLock(path).then((held) => {
    secondHeld = true;
    return held;
  });
  // The held descriptor is the guard: a peer cannot enter its critical section.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(secondHeld).toBe(false);
  await first.release();
  const second = await secondPromise;
  expect(secondHeld).toBe(true);
  await second.release();
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('a marker with a world.git-only pair is an uncertain partial, never completed', async () => {
  const home = await makeHome();
  await writeMarker(home, landlockMarker());
  await mkdir(join(home, 'world.git'));
  const before = await stat(join(home, '.es', EXECUTION_MARKER_FILE));
  const bytes = await readFile(join(home, '.es', EXECUTION_MARKER_FILE));
  await expect(initHome(home)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(home, 'world'))).resolves.toBe(true);
  await expect(absent(join(home, 'world.git', 'HEAD'))).resolves.toBe(true);
  const after = await stat(join(home, '.es', EXECUTION_MARKER_FILE));
  expect(after.ino).toBe(before.ino);
  expect(await readFile(join(home, '.es', EXECUTION_MARKER_FILE))).toEqual(bytes);
});

it('a matching marker is idempotent on a valid pair and never rewritten', async () => {
  const home = await makeHome();
  expect((await initHome(home)).created).toBe(true);
  const before = await stat(join(home, '.es', EXECUTION_MARKER_FILE));
  const bytes = await readFile(join(home, '.es', EXECUTION_MARKER_FILE));
  expect((await initHome(home)).created).toBe(false);
  const after = await stat(join(home, '.es', EXECUTION_MARKER_FILE));
  expect(after.ino).toBe(before.ino);
  expect(await readFile(join(home, '.es', EXECUTION_MARKER_FILE))).toEqual(bytes);
});

it('refuses an existing non-0700 .es directory with a typed layout refusal', async () => {
  const home = await makeHome();
  await mkdir(join(home, '.es'), { mode: 0o500 });
  await chmod(join(home, '.es'), 0o500);
  await expect(initHome(home)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(home, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expect(absent(join(home, 'world'))).resolves.toBe(true);
  // No silent repair: the directory keeps the mode it was found with.
  expect((await stat(join(home, '.es'))).mode & 0o777).toBe(0o500);
});

it('two concurrent inits serialize on the init lock: one creates, one is idempotent', async () => {
  const home = await makeHome();
  const results = await Promise.all([initHome(home), initHome(home)]);
  // The exclusive init lock covers the whole classification: the winner writes
  // the marker and the world pair, the loser waits, then observes the same
  // valid state and is idempotent. Never a second marker, a second world or a
  // raw EEXIST/partial-read refusal.
  expect(results.map((result) => result.created).sort()).toEqual([false, true]);
  expect(await readExecutionMarker(home)).toMatchObject({ v: 1, backend: 'landlock' });
  expect((await readdir(join(home, '.es'))).sort())
    .toEqual([EXECUTION_MARKER_FILE, 'init.lock']);
  await expect(assertCellLayout(home)).resolves.toBeUndefined();
  await expect(WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') }))
    .resolves.toBeDefined();
});

it('strictly refuses every malformed marker shape', async () => {
  const cases: readonly [string, unknown][] = [
    ['not JSON', '{'],
    ['trailing newline', `${JSON.stringify(landlockMarker())}\n`],
    ['duplicate key', '{"v":1,"backend":"landlock","createdAt":1,"backend":"landlock"}'],
    ['extra key', { ...(landlockMarker() as object), extra: true }],
    ['missing createdAt', { v: 1, backend: 'landlock' }],
    ['wrong version', { v: 2, backend: 'landlock', createdAt: 1 }],
    ['unknown backend', { v: 1, backend: 'off', createdAt: 1 }],
    ['landlock with image', { ...(landlockMarker() as object), image: { path: '/x', sha256: 'a'.repeat(64), bytes: 1 } }],
    ['vm without image', { v: 1, backend: 'vm-qemu', createdAt: 1 }],
    ['relative image', vmMarker('base.qcow2')],
    ['bad digest', { v: 1, backend: 'vm-qemu', createdAt: 1, image: { path: '/x/base.qcow2', sha256: 'A'.repeat(64), bytes: 1 } }],
    ['zero bytes', { v: 1, backend: 'vm-qemu', createdAt: 1, image: { path: '/x/base.qcow2', sha256: 'a'.repeat(64), bytes: 0 } }],
    ['bad createdAt', { v: 1, backend: 'landlock', createdAt: -1 }],
  ];
  for (const [label, value] of cases) {
    const home = await makeHome();
    await writeMarker(home, value);
    await expect(readExecutionMarker(home), label).rejects.toThrow(/execution\/marker-invalid/);
  }
});

it('refuses a marker under the home image path, a symlink, a directory, a mode, a uid and a size', async () => {
  const home = await makeHome();
  await writeMarker(home, vmMarker(join(home, 'base.qcow2')));
  await expect(readExecutionMarker(home)).rejects.toThrow(/execution\/marker-invalid/);

  const symlinkHome = await makeHome();
  const target = join(await tempDir('es-exec-marker-'), 'marker.json');
  await writeFile(target, JSON.stringify(landlockMarker()));
  await makeEs(symlinkHome);
  await symlink(target, join(symlinkHome, '.es', EXECUTION_MARKER_FILE));
  await expect(readExecutionMarker(symlinkHome)).rejects.toThrow(/execution\/marker-invalid/);

  const dirHome = await makeHome();
  await makeEs(dirHome);
  await mkdir(join(dirHome, '.es', EXECUTION_MARKER_FILE));
  await expect(readExecutionMarker(dirHome)).rejects.toThrow(/execution\/marker-invalid/);

  const modeHome = await makeHome();
  await writeMarker(modeHome, landlockMarker(), 0o644);
  await expect(readExecutionMarker(modeHome)).rejects.toThrow(/execution\/marker-invalid/);

  // A syntactically valid, schema-valid marker over the 4 KiB bound: without
  // the size guard the strict parser would accept it, so the bound is
  // genuinely exercised (a malformed over-size string would fail parsing
  // either way).
  const sizeHome = await makeHome();
  await writeMarker(sizeHome, vmMarker(`/tmp/${'a'.repeat(4200)}`));
  await expect(readExecutionMarker(sizeHome)).rejects.toThrow(/execution\/marker-invalid/);

  const uid = process.getuid?.();
  if (uid !== undefined) {
    const foreign = await makeHome();
    await writeMarker(foreign, landlockMarker());
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    try {
      await expect(readExecutionMarker(foreign)).rejects.toThrow(/execution\/marker-invalid/);
    } finally {
      spy.mockRestore();
    }
  }
});

it('refuses a real FIFO marker or network record promptly as non-regular', { timeout: 3000 }, async () => {
  // A FIFO has no size to pre-check: without the no-follow precheck the open
  // itself blocks forever waiting for the other end. The typed refusal must be
  // prompt for both host-owned records.
  const markerHome = await makeHome();
  await makeEs(markerHome);
  await makeFifo(join(markerHome, '.es', EXECUTION_MARKER_FILE));
  await expect(readExecutionMarker(markerHome)).rejects.toThrow(/execution\/marker-invalid/);
  expect((await lstat(join(markerHome, '.es', EXECUTION_MARKER_FILE))).isFIFO()).toBe(true);

  const networkHome = await makeHome();
  await makeEs(networkHome);
  await makeFifo(join(networkHome, '.es', VM_NETWORK_FILE));
  await expect(readVmNetworkRecord(networkHome))
    .rejects.toThrow(/execution\/network-record-invalid/);
  expect((await lstat(join(networkHome, '.es', VM_NETWORK_FILE))).isFIFO()).toBe(true);

  // The same read still accepts a valid regular marker.
  const regular = await makeHome();
  await initHome(regular);
  await expect(readExecutionMarker(regular)).resolves.toMatchObject({ backend: 'landlock' });
});

it('refuses a symlinked or FIFO init lock before opening it', { timeout: 3000 }, async () => {
  const linked = await makeHome();
  await makeEs(linked);
  const target = join(await tempDir('es-exec-lock-'), 'lock-target');
  await writeFile(target, 'x');
  await symlink(target, join(linked, '.es', 'init.lock'));
  await expect(holdExclusiveLock(join(linked, '.es', 'init.lock')))
    .rejects.toThrow(/kernel-owned line log/);
  await expect(initHome(linked)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(linked, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expect(absent(join(linked, 'world'))).resolves.toBe(true);

  const fifoHome = await makeHome();
  await makeEs(fifoHome);
  await makeFifo(join(fifoHome, '.es', 'init.lock'));
  await expect(holdExclusiveLock(join(fifoHome, '.es', 'init.lock')))
    .rejects.toThrow(/kernel-owned line log/);
  await expect(initHome(fifoHome)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(fifoHome, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expect(absent(join(fifoHome, 'world'))).resolves.toBe(true);
});

it('never overwrites an existing marker', async () => {
  const home = await makeHome();
  await writeMarker(home, landlockMarker());
  const before = await readFile(join(home, '.es', EXECUTION_MARKER_FILE));
  await expect(writeExecutionMarker(home, {
    v: 1, backend: 'landlock', createdAt: 2,
  })).rejects.toThrow(/execution\/marker-conflict/);
  expect(await readFile(join(home, '.es', EXECUTION_MARKER_FILE))).toEqual(before);
});

it('the landlock marker never contains an image and the off opt-out stays a runtime fact', async () => {
  const home = await makeHome();
  await initHome(home);
  const text = await readFile(join(home, '.es', EXECUTION_MARKER_FILE), 'utf8');
  expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['backend', 'createdAt', 'v']);
  expect(text).not.toContain('image');
  await expect(assertExecutionStartable(home, { noSandbox: false })).resolves.toBe('landlock');
  await expect(assertExecutionStartable(home, { noSandbox: true })).resolves.toBe('landlock');
});

it('refuses a vm-qemu marker on start and resume before any host effect', async () => {
  const imageDir = await tempDir('es-exec-image-');
  const home = await makeHome();
  await writeMarker(home, vmMarker(join(imageDir, 'base.qcow2')));
  await expect(assertExecutionStartable(home, { noSandbox: false }))
    .rejects.toThrow(/execution\/vm-not-activated/);
  await expect(assertExecutionStartable(home, { noSandbox: true }))
    .rejects.toThrow(/execution\/vm-no-sandbox/);

  for (const command of ['start', 'resume'] as const) {
    const refusal = await hostRefusal(home, command, {});
    expect(refusal.code).toBe(2);
    expect(refusal.messages.join('\n')).toMatch(/execution\/vm-not-activated/);
    expect(refusal.attach).toBe(0);
    expect(refusal.config).toBe(0);
    await expect(absent(join(home, 'chat.v0.jsonl'))).resolves.toBe(true);
    await expect(absent(join(home, 'conversation.v0.jsonl'))).resolves.toBe(true);
    await expect(absent(join(home, 'host.json'))).resolves.toBe(true);
    await expect(absent(join(home, 'frontier'))).resolves.toBe(true);
    await expect(absent(join(home, 'nodes'))).resolves.toBe(true);
    await expect(absent(join(home, 'providers.json'))).resolves.toBe(true);
  }
});

it('refuses --no-sandbox on a vm marker on both start and resume', async () => {
  const imageDir = await tempDir('es-exec-image-');
  const home = await makeHome();
  await writeMarker(home, vmMarker(join(imageDir, 'base.qcow2')));
  for (const command of ['start', 'resume'] as const) {
    const refusal = await hostRefusal(home, command, false);
    expect(refusal.code).toBe(2);
    expect(refusal.messages.join('\n')).toMatch(/execution\/vm-no-sandbox/);
    expect(refusal.attach).toBe(0);
  }
});

it('refuses a matching vm marker re-init with missing mounted roots, zero writes', async () => {
  const imageDir = await tempDir('es-exec-image-');
  const home = await makeHome();
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  await writeMarker(home, vmMarker(join(imageDir, 'base.qcow2')));
  const before = await readFile(join(home, '.es', EXECUTION_MARKER_FILE));
  await expect(initHome(home, {
    backend: 'vm-qemu', imagePath: join(imageDir, 'base.qcow2'),
  })).rejects.toThrow(/execution\/layout-damaged/);
  expect(await readFile(join(home, '.es', EXECUTION_MARKER_FILE))).toEqual(before);
  await expect(absent(join(home, 'vm'))).resolves.toBe(true);
});

it('refuses a vm-marker re-init with another image path or a changed pinned image', async () => {
  const imageDir = await realpath(await tempDir('es-exec-image-'));
  const image = join(imageDir, 'base.qcow2');
  const content = 'base-image';
  await writeFile(image, content);
  const digest = createHash('sha256').update(content).digest('hex');
  const bytes = Buffer.byteLength(content);
  const home = await makeHome();
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  await writeMarker(home, {
    v: 1, backend: 'vm-qemu', createdAt: 1,
    image: { path: image, sha256: digest, bytes },
  });
  const markerPath = join(home, '.es', EXECUTION_MARKER_FILE);
  const beforeBytes = await readFile(markerPath);
  const beforeIno = (await stat(markerPath)).ino;
  const worldIno = (await stat(join(home, 'world'))).ino;
  const gitIno = (await stat(join(home, 'world.git'))).ino;
  const head = await readFile(join(home, 'world.git', 'HEAD'));

  // A different requested base image is a conflict even with no inspector: the
  // marker's image path is the immutable identity, never a retry parameter.
  const other = join(imageDir, 'other.qcow2');
  await expect(initHome(home, { backend: 'vm-qemu', imagePath: other }))
    .rejects.toThrow(/execution\/marker-conflict/);
  const inspect = vi.fn(async () => ({ format: 'qcow2', backing: null, virtualBytes: 1024 }));
  await expect(initHome(home, { backend: 'vm-qemu', imagePath: other }, inspect))
    .rejects.toThrow(/execution\/marker-conflict/);
  expect(inspect).not.toHaveBeenCalled();

  // The same path with a tampered file re-pins the bytes and refuses the
  // changed identity; the old pin is never rewritten.
  await writeFile(image, 'evil-image');
  await expect(initHome(home, { backend: 'vm-qemu', imagePath: image }, inspect))
    .rejects.toThrow(/execution\/marker-conflict/);
  expect(inspect).toHaveBeenCalledWith(image);

  // Restoring the pinned bytes passes the image check and reaches the next
  // guard (the absent mounts): a matching pin is not refused as a conflict.
  await writeFile(image, content);
  await expect(initHome(home, { backend: 'vm-qemu', imagePath: image }, inspect))
    .rejects.toThrow(/execution\/layout-damaged/);
  expect(inspect).toHaveBeenCalledTimes(2);

  expect(await readFile(markerPath)).toEqual(beforeBytes);
  expect((await stat(markerPath)).ino).toBe(beforeIno);
  expect((await stat(join(home, 'world'))).ino).toBe(worldIno);
  expect((await stat(join(home, 'world.git'))).ino).toBe(gitIno);
  expect(await readFile(join(home, 'world.git', 'HEAD'))).toEqual(head);
  await expect(absent(join(home, 'vm'))).resolves.toBe(true);
});

it('refuses a marker conflict in both directions', async () => {
  const imageDir = await tempDir('es-exec-image-');
  const landlock = await makeHome();
  await initHome(landlock);
  await expect(initHome(landlock, {
    backend: 'vm-qemu', imagePath: join(imageDir, 'base.qcow2'),
  })).rejects.toThrow(/execution\/marker-conflict/);

  const vm = await makeHome();
  await writeMarker(vm, vmMarker(join(imageDir, 'base.qcow2')));
  await expect(initHome(vm)).rejects.toThrow(/execution\/marker-conflict/);
});

it('no mounted roots means an explicit VM init refuses layout-damaged and writes nothing', async () => {
  const imageDir = await tempDir('es-exec-image-');
  const home = await makeHome();
  const image = join(imageDir, 'base.qcow2');
  await expect(initHome(home, { backend: 'vm-qemu', imagePath: image }))
    .rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(home, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  await expectOnlyInitLock(home);
  await expect(absent(join(home, 'world'))).resolves.toBe(true);
  await expect(absent(join(home, 'vm'))).resolves.toBe(true);

  const worldOnly = await makeHome();
  await mkdir(join(worldOnly, 'world'));
  await expect(initHome(worldOnly, { backend: 'vm-qemu', imagePath: image }))
    .rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(worldOnly, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
});

it('the strict VM volume and fresh-root checks refuse ordinary host directories', async () => {
  const home = await makeHome();
  await expect(assertVmVolumes(home)).rejects.toThrow(/execution\/layout-damaged/);
  await mkdir(join(home, 'world'));
  await mkdir(join(home, 'vm'));
  await expect(assertVmVolumes(home)).rejects.toThrow(/execution\/layout-damaged/);
  await chmod(join(home, 'world'), 0o755);
  await writeFile(join(home, 'world', 'entry'), 'x');
  await expect(assertVmVolumes(home)).rejects.toThrow(/execution\/layout-damaged/);
  await expect(classifyFreshVolumeRoot(join(home, 'world'))).resolves.toBe('damaged');
  const empty = await makeHome();
  expect(await classifyFreshVolumeRoot(empty)).toBe('empty');
  await writeFile(join(empty, 'entry'), 'x');
  expect(await classifyFreshVolumeRoot(empty)).toBe('damaged');
  const lost = await makeHome();
  await mkdir(join(lost, 'lost+found'), { mode: 0o700 });
  await chmod(join(lost, 'lost+found'), 0o700);
  expect(await classifyFreshVolumeRoot(lost)).toBe('damaged');
});

it('refuses a post-init lost+found under either volume root, read-only', async () => {
  const home = await makeHome();
  await mkdir(join(home, 'world'));
  await mkdir(join(home, 'vm'));
  await expect(assertNoPostInitVolumeEntries(home)).resolves.toBeUndefined();

  await mkdir(join(home, 'vm', 'lost+found'), { mode: 0o700 });
  await chmod(join(home, 'vm', 'lost+found'), 0o700);
  await expect(assertNoPostInitVolumeEntries(home)).rejects.toThrow(/post-init lost\+found/);
  // Never removed: the guard is read-only.
  expect((await lstat(join(home, 'vm', 'lost+found'))).isDirectory()).toBe(true);

  const worldLost = await makeHome();
  await mkdir(join(worldLost, 'world'));
  await mkdir(join(worldLost, 'vm'));
  await mkdir(join(worldLost, 'world', 'lost+found'), { mode: 0o700 });
  await chmod(join(worldLost, 'world', 'lost+found'), 0o700);
  await expect(assertNoPostInitVolumeEntries(worldLost)).rejects.toThrow(/post-init lost\+found/);

  const missing = await makeHome();
  await mkdir(join(missing, 'world'));
  await expect(assertNoPostInitVolumeEntries(missing))
    .rejects.toThrow(/execution\/layout-damaged/);
});

it('isolates each strict VM volume guard with its own refusal message', async () => {
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const home = await makeVolumeHome();
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    try {
      await expect(assertVmVolumes(home)).rejects.toThrow(/owned by the host uid/);
    } finally {
      spy.mockRestore();
    }
  }

  const gid = process.getgid?.();
  if (gid !== undefined) {
    const home = await makeVolumeHome();
    const spy = vi.spyOn(process, 'getgid').mockReturnValue(gid + 1);
    try {
      await expect(assertVmVolumes(home)).rejects.toThrow(/owned by the host gid/);
    } finally {
      spy.mockRestore();
    }
  }

  const mode = await makeVolumeHome();
  await chmod(join(mode, 'world'), 0o750);
  await expect(assertVmVolumes(mode)).rejects.toThrow(/must have mode 0700/);

  // The two roots sit on the home's own device: the distinct-device guard
  // fires before the mount check, which needs a real mount this suite cannot
  // create unprivileged.
  const device = await makeVolumeHome();
  await expect(assertVmVolumes(device)).rejects.toThrow(/needs its own device/);

  const linked = await makeVolumeHome();
  const target = await makeHome();
  await rm(join(linked, 'world'), { recursive: true, force: true });
  await symlink(target, join(linked, 'world'));
  await expect(assertVmVolumes(linked)).rejects.toThrow(/must be a real directory/);
});

it('detects every VM evidence form while a pristine empty vm root is not evidence', async () => {
  const fresh = await makeHome();
  expect(await hasVmEvidence(fresh)).toBe(false);
  await mkdir(join(fresh, 'vm'));
  expect(await hasVmEvidence(fresh)).toBe(false);
  await mkdir(join(fresh, 'vm', 'lost+found'), { mode: 0o700 });
  await chmod(join(fresh, 'vm', 'lost+found'), 0o700);
  expect(await hasVmEvidence(fresh)).toBe(true);

  for (const name of ['disk.qcow2', 'state.json', 'volumes.json']) {
    const home = await makeHome();
    await mkdir(join(home, 'vm'));
    await writeFile(join(home, 'vm', name), 'x');
    expect(await hasVmEvidence(home), name).toBe(true);
  }

  const record = await makeHome();
  await writeNetwork(record, 'not json', 0o644);
  expect(await hasVmEvidence(record)).toBe(true);

  // Any non-pristine `vm` form is evidence, not just a directory of artifacts:
  // a regular file and a symlink are both a damaged/non-pristine VM home.
  const fileVm = await makeHome();
  await writeFile(join(fileVm, 'vm'), 'x');
  expect(await hasVmEvidence(fileVm)).toBe(true);

  const linkedVm = await makeHome();
  await symlink(await makeHome(), join(linkedVm, 'vm'));
  expect(await hasVmEvidence(linkedVm)).toBe(true);
});

it('an evidence-only home is refused by init and start, never downgraded to Landlock', async () => {
  const home = await makeHome();
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  await writeNetwork(home, 'not json', 0o644);
  await expect(assertExecutionStartable(home, { noSandbox: false }))
    .rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(assertExecutionStartable(home, { noSandbox: true }))
    .rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(initHome(home)).rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(absent(join(home, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
  const refusal = await hostRefusal(home, 'start', {});
  expect(refusal.code).toBe(2);
  expect(refusal.messages.join('\n')).toMatch(/execution\/marker-absent-vm-evidence/);
  expect(refusal.attach).toBe(0);
  expect(refusal.config).toBe(0);
  // A fresh home with a VM record also refuses, before writing a marker/world.
  const fresh = await makeHome();
  await writeNetwork(fresh, 'not json', 0o644);
  await expect(initHome(fresh)).rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(absent(join(fresh, 'world'))).resolves.toBe(true);
  await expect(absent(join(fresh, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
});

it('finds the exact VM offering sentence in a node journal as evidence', async () => {
  const home = await makeHome();
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  await seedVmConfig(home);
  expect(await hasVmEvidence(home)).toBe(true);
  await expect(assertExecutionStartable(home, { noSandbox: false }))
    .rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(initHome(home)).rejects.toThrow(/execution\/marker-absent-vm-evidence/);
  await expect(absent(join(home, '.es', EXECUTION_MARKER_FILE))).resolves.toBe(true);
});

it('parses the strict network record and refuses every schema or file deviation', async () => {
  const home = await makeHome();
  const canonical = await realpath(home);
  const valid = recordFor(canonical);
  await writeNetwork(home, valid);
  const record = await readVmNetworkRecord(home);
  expect(record).toEqual({
    v: 1, home: canonical, id: 'ab12cd', n: 1,
    interface: 'estapab12cd', bridge: 'esbrab12cd',
    guest: { addr: '10.200.1.2', prefix: 30, gateway: '10.200.1.1' },
    dns: '1.1.1.1', mac: '02:00:00:00:00:01',
  } satisfies VmNetworkRecord);

  const parse = (overrides: Record<string, unknown>): void => {
    parseVmNetworkRecord(recordFor(canonical, overrides), canonical);
  };
  expect(() => parse({ home: '/other' })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ id: 'ABC123' })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ n: 0 })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ n: 255 })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ interface: 'estap0' })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ bridge: 'esbr0' })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ guest: { addr: '10.200.1.3', prefix: 30, gateway: '10.200.1.1' } }))
    .toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ guest: { addr: '10.200.1.2', prefix: 29, gateway: '10.200.1.1' } }))
    .toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ dns: '10.0.0.1' })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ dns: '1.1.1.01' })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ mac: '01:00:00:00:00:01' })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ mac: '02:00:00:00:00:0A' })).toThrow(/execution\/network-record-invalid/);
  expect(() => parse({ extra: true })).toThrow(/execution\/network-record-invalid/);

  const absentHome = await makeHome();
  await expect(readVmNetworkRecord(absentHome)).rejects.toThrow(/execution\/network-record-absent/);

  const malformed = await makeHome();
  await writeNetwork(malformed, '{"v":1');
  await expect(readVmNetworkRecord(malformed)).rejects.toThrow(/execution\/network-record-invalid/);

  const duplicate = await makeHome();
  await writeNetwork(duplicate,
    '{"v":1,"v":1,"home":"/x","id":"ab12cd","n":1,"interface":"estapab12cd",'
    + '"bridge":"esbrab12cd","guest":{"addr":"10.200.1.2","prefix":30,"gateway":"10.200.1.1"},'
    + '"dns":"1.1.1.1","mac":"02:00:00:00:00:01"}');
  await expect(readVmNetworkRecord(duplicate)).rejects.toThrow(/execution\/network-record-invalid/);

  // A syntactically and schema-valid record over the 4 KiB bound: the strict
  // parser would accept it without the size guard (the padding is insignificant
  // JSON whitespace), so the record's own bound is genuinely exercised.
  const oversize = await makeHome();
  const oversizedRecord = JSON.stringify(recordFor(await realpath(oversize)));
  await writeNetwork(oversize, `{${' '.repeat(4200)}${oversizedRecord.slice(1)}`);
  await expect(readVmNetworkRecord(oversize)).rejects.toThrow(/execution\/network-record-invalid/);

  const mode = await makeHome();
  await writeNetwork(mode, recordFor(await realpath(mode)), 0o644);
  await expect(readVmNetworkRecord(mode)).rejects.toThrow(/execution\/network-record-invalid/);

  const linked = await makeHome();
  const target = join(await tempDir('es-exec-net-'), 'record.json');
  await writeFile(target, JSON.stringify(recordFor(await realpath(linked))));
  await makeEs(linked);
  await symlink(target, join(linked, '.es', VM_NETWORK_FILE));
  await expect(readVmNetworkRecord(linked)).rejects.toThrow(/execution\/network-record-invalid/);
});

it('pins an outside real regular image by digest with a fake inspector', async () => {
  const home = await makeHome();
  const imageDir = await tempDir('es-exec-image-');
  const image = join(imageDir, 'base.qcow2');
  await writeFile(image, 'small-base-image');
  const expected = createHash('sha256').update('small-base-image').digest('hex');
  const inspect = vi.fn(async () => ({ format: 'qcow2', backing: null, virtualBytes: 1024 }));
  const pinned = await pinExecutionImage(home, image, inspect);
  expect(pinned).toEqual({
    path: image, sha256: expected, bytes: Buffer.byteLength('small-base-image'),
  });
  expect(inspect).toHaveBeenCalledWith(image);

  await expect(pinExecutionImage(home, 'relative.qcow2', inspect))
    .rejects.toThrow(/execution\/image-invalid/);
  await expect(pinExecutionImage(home, join(imageDir, 'missing.qcow2'), inspect))
    .rejects.toThrow(/execution\/image-invalid/);
  const inside = join(home, 'base.qcow2');
  await writeFile(inside, 'x');
  await expect(pinExecutionImage(home, inside, inspect)).rejects.toThrow(/execution\/image-invalid/);
  const link = join(imageDir, 'link.qcow2');
  await symlink(image, link);
  await expect(pinExecutionImage(home, link, inspect)).rejects.toThrow(/execution\/image-invalid/);
  const empty = join(imageDir, 'empty.qcow2');
  await writeFile(empty, '');
  await expect(pinExecutionImage(home, empty, inspect)).rejects.toThrow(/execution\/image-invalid/);
  const huge = join(imageDir, 'huge.qcow2');
  await writeFile(huge, 'x');
  await truncate(huge, 64 * 1024 ** 3 + 1);
  const notCalled = vi.fn(async () => ({ format: 'qcow2', backing: null, virtualBytes: 1 }));
  await expect(pinExecutionImage(home, huge, notCalled))
    .rejects.toThrow(/execution\/image-invalid/);
  expect(notCalled).not.toHaveBeenCalled();

  await expect(pinExecutionImage(home, image, async () => ({
    format: 'raw', backing: null, virtualBytes: 1,
  }))).rejects.toThrow(/execution\/image-invalid/);
  await expect(pinExecutionImage(home, image, async () => ({
    format: 'qcow2', backing: 'base.qcow2', virtualBytes: 1,
  }))).rejects.toThrow(/execution\/image-invalid/);
  await expect(pinExecutionImage(home, image, async () => ({
    format: 'qcow2', backing: null, virtualBytes: 0,
  }))).rejects.toThrow(/execution\/image-invalid/);
});

it('the explicit VM prerequisite gate refuses after parsing the network record and roots', async () => {
  const home = await makeHome();
  const imageDir = await tempDir('es-exec-image-');
  await expect(assertVmInitPrerequisites(home, join(imageDir, 'base.qcow2')))
    .rejects.toThrow(/execution\/layout-damaged/);
  await expect(absent(join(home, '.es'))).resolves.toBe(true);
  await expect(absent(join(home, 'world'))).resolves.toBe(true);
});

it('parses the marker value directly with the same exact shape', () => {
  expect(parseExecutionMarker(landlockMarker(), '/h')).toEqual({
    v: 1, backend: 'landlock', createdAt: 1,
  });
  expect(() => parseExecutionMarker({ ...landlockMarker() as object, name: 'x' }, '/h'))
    .toThrow(/execution\/marker-invalid/);
});
