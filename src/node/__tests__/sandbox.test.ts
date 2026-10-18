import { existsSync } from 'node:fs';
import {
  chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SandboxUnavailableError, buildSandboxSpec, probeSandbox, type SandboxSpec,
} from '../tools/sandbox.js';

/**
 * The policy builder and the functional probe (C1.4c): fixed grant order and
 * contents, the scratch leaf's creation and verification, the three build
 * invariants, and the probe's parse/failure contract. Builder tests stub the
 * launcher with a fixture file and need no binary; the default-path and real
 * probe tests skip when the binary is absent (the vitest globalSetup builds it).
 */

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const binary = join(projectRoot, 'native', 'es-landlock', 'es-landlock');
const binaryPresent = existsSync(binary);
const TEST_TIMEOUT_MS = 20_000;

let root = '';
let home = '';
let world = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-policy-'));
  home = join(root, 'home');
  world = join(root, 'world');
  await mkdir(home);
  await mkdir(world);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A regular-file launcher stub: the builder only resolves and stats it. */
async function launcherStub(name = 'es-landlock'): Promise<string> {
  const path = join(root, name);
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
  return path;
}

/** A probe stub: the script ignores argv and emits exactly what the test needs. */
async function probeStub(name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** Awaits a refusal and pins its class, so the message assertions stand alone. */
async function refusal(promise: Promise<unknown>): Promise<SandboxUnavailableError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SandboxUnavailableError);
    return err as SandboxUnavailableError;
  }
  throw new Error('expected the sandbox builder to refuse');
}

/** `realpath`, or `null` when the entry is absent: the builder skips missing optionals. */
async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

type Grant = { readonly flag: string; readonly path: string };

/** Splits a flat `--flag path` list into grant pairs (the argv tail is excluded by the caller). */
function parseGrants(argv: readonly string[]): Grant[] {
  const grants: Grant[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const path = argv[i + 1];
    if (flag === undefined || path === undefined) throw new Error('odd grant argv');
    grants.push({ flag, path });
  }
  return grants;
}

function flagsFor(grants: readonly Grant[], path: string): string[] {
  return grants.filter((grant) => grant.path === path).map((grant) => grant.flag);
}

describe('buildSandboxSpec', () => {
  it(
    'builds the fixed grant list, spawn tail and owned env',
    async () => {
      const launcher = await launcherStub();
      const uid = 'node-a';
      const spec = await buildSandboxSpec({ world, home, uid, launcherPath: launcher });
      const homeReal = await realpath(home);
      const worldReal = await realpath(world);

      expect(spec.launcherPath).toBe(await realpath(launcher));
      expect(spec.scratchDir).toBe(join(homeReal, 'tmp', uid));

      const dash = spec.spawnArgv.indexOf('--');
      expect(dash).toBeGreaterThan(0);
      expect(spec.spawnArgv.slice(dash))
        .toEqual(['--', '/bin/bash', '--noprofile', '--norc', '-i']);
      const grants = parseGrants(spec.spawnArgv.slice(0, dash));

      expect(flagsFor(grants, world)).toEqual(['--rw']);
      expect(flagsFor(grants, spec.scratchDir)).toEqual(['--rw']);

      // /usr is granted once; the merged-usr symlink targets under it are
      // dropped by the realpath rule (this host: /bin -> /usr/bin).
      expect(flagsFor(grants, '/usr')).toEqual(['--rox']);
      expect(grants.some((grant) => grant.path.startsWith('/usr/'))).toBe(false);

      for (const name of [
        'ld.so.cache', 'passwd', 'group', 'nsswitch.conf', 'hosts', 'resolv.conf', 'bash.bashrc',
      ]) {
        const real = await realpathOrNull(join('/etc', name));
        if (real === null) continue;
        expect(flagsFor(grants, real), name).toEqual(['--ro']);
      }
      // /etc/localtime resolves into the already-granted /usr on this host.
      const zone = await realpathOrNull('/etc/localtime');
      if (zone !== null) {
        if (zone === '/usr' || zone.startsWith('/usr/')) {
          expect(grants.some((grant) => grant.path === zone)).toBe(false);
        } else {
          expect(flagsFor(grants, zone)).toEqual(['--ro']);
        }
      }
      const certs = await realpathOrNull('/etc/ssl/certs');
      if (certs !== null) expect(flagsFor(grants, certs)).toEqual(['--ro']);
      expect(flagsFor(grants, '/proc')).toEqual(['--ro']);

      expect(flagsFor(grants, '/dev/null')).toEqual(['--rw']);
      expect(flagsFor(grants, '/dev/tty')).toEqual(['--rw']);
      expect(flagsFor(grants, '/dev/zero')).toEqual(['--ro']);
      expect(flagsFor(grants, '/dev/random')).toEqual(['--ro']);
      expect(flagsFor(grants, '/dev/urandom')).toEqual(['--ro']);

      expect(spec.env).toEqual({
        HOME: worldReal, TMPDIR: spec.scratchDir, HISTFILE: '/dev/null',
      });
      expect(spec.probeArgv.slice(0, 7)).toEqual([
        '--probe',
        '--probe-deny', spec.launcherPath,
        '--probe-rw', spec.scratchDir,
        '--probe-rw', world,
      ]);
      expect(spec.probeArgv.slice(7)).toEqual(spec.spawnArgv.slice(0, dash));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates the scratch leaf 0700 and reuses it on a second build',
    async () => {
      const launcher = await launcherStub();
      const spec = await buildSandboxSpec({
        world, home, uid: 'node-a', launcherPath: launcher,
      });
      const info = await stat(spec.scratchDir);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
      expect(spec.scratchDir).toBe(join(await realpath(home), 'tmp', 'node-a'));

      const again = await buildSandboxSpec({
        world, home, uid: 'node-a', launcherPath: launcher,
      });
      expect(again.scratchDir).toBe(spec.scratchDir);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a home inside the world',
    async () => {
      const nestedHome = join(world, 'home');
      await mkdir(nestedHome);
      const err = await refusal(buildSandboxSpec({
        world, home: nestedHome, uid: 'node-a', launcherPath: await launcherStub(),
      }));
      expect(err.message).toMatch(/inside the world/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a home whose realpath fails (a symlink loop)',
    async () => {
      const loop = join(root, 'loop');
      await symlink('loop', loop);
      const err = await refusal(buildSandboxSpec({
        world, home: loop, uid: 'node-a', launcherPath: await launcherStub(),
      }));
      expect(err.message).toMatch(/not usable/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a missing launcher and names the build step',
    async () => {
      const err = await refusal(buildSandboxSpec({
        world, home, uid: 'node-a', launcherPath: join(root, 'never-built'),
      }));
      expect(err.message).toMatch(/npm run build:native/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a launcher that resolves inside a granted root',
    async () => {
      const planted = join(world, 'es-landlock');
      await writeFile(planted, '#!/bin/sh\nexit 0\n');
      await chmod(planted, 0o755);
      const err = await refusal(buildSandboxSpec({
        world, home, uid: 'node-a', launcherPath: planted,
      }));
      expect(err.message).toMatch(/inside the granted root/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a scratch leaf that is a symlink',
    async () => {
      await mkdir(join(home, 'tmp'), { mode: 0o755 });
      await symlink(home, join(home, 'tmp', 'node-a'));
      const err = await refusal(buildSandboxSpec({
        world, home, uid: 'node-a', launcherPath: await launcherStub(),
      }));
      expect(err.message).toMatch(/not a real directory/);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!binaryPresent)(
    'resolves the built launcher by default (three levels up)',
    async () => {
      const spec = await buildSandboxSpec({ world, home, uid: 'node-a' });
      expect(spec.launcherPath).toBe(await realpath(binary));
    },
    TEST_TIMEOUT_MS,
  );
});

/** A probe spec whose launcher is the given stub; argv is the stub's to ignore. */
async function stubSpec(launcher: string): Promise<SandboxSpec> {
  return buildSandboxSpec({ world, home, uid: 'node-a', launcherPath: launcher });
}

describe('probeSandbox', () => {
  it(
    'parses the abi/enforcement pair from probe stdout',
    async () => {
      const launcher = await probeStub(
        'probe-status', "printf 'abi=8\\nenforcement=full\\n'");
      await expect(probeSandbox(await stubSpec(launcher)))
        .resolves.toEqual({ abi: 8, enforcement: 'full' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses garbage output and a nonzero exit, attaching stderr',
    async () => {
      const garbled = await probeStub(
        'probe-garbage', "printf 'not a status\\n'; printf 'es-landlock: stub: garbled\\n' >&2");
      const garbage = await refusal(probeSandbox(await stubSpec(garbled)));
      expect(garbage.message).toContain('es-landlock: stub: garbled');

      const failing = await probeStub(
        'probe-failing',
        "printf 'es-landlock: probe-deny: Permission denied\\n' >&2; exit 125",
      );
      const failure = await refusal(probeSandbox(await stubSpec(failing)));
      expect(failure.message).toContain('es-landlock: probe-deny: Permission denied');
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!binaryPresent)(
    'runs the real probe against the built launcher',
    async () => {
      const spec = await buildSandboxSpec({ world, home, uid: 'node-a' });
      const status = await probeSandbox(spec);
      expect(status.abi).toBeGreaterThanOrEqual(3);
      expect(status.enforcement).toBe('full');
    },
    TEST_TIMEOUT_MS,
  );
});
