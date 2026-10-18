import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Binary-level contract of the vendored Landlock launcher: real processes,
 * real confinement, no PTY. Every fixture is a mkdtemp tree so the suite never
 * touches the checkout. The binary is built by vitest's globalSetup (or by
 * `npm run build:native`); without it the suite skips rather than fails.
 */
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const binary = path.join(projectRoot, 'native', 'es-landlock', 'es-landlock');
const binaryPresent = existsSync(binary);
if (!binaryPresent) {
  console.warn(
    `[es-landlock] ${binary} is absent; skipping the launcher suite (run npm run build:native).`,
  );
}

const COMMAND_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 20_000;
const PYTHON = '/usr/bin/python3';

let fixture = '';
let world = '';
let secret = '';
let readable = '';
let grantDir = '';
let ungrantedDir = '';
let worldSymlink = '';

beforeAll(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'es-landlock-'));
  world = path.join(fixture, 'world');
  secret = path.join(fixture, 'secret.txt');
  readable = path.join(fixture, 'readable.txt');
  grantDir = path.join(fixture, 'grant-dir');
  ungrantedDir = path.join(fixture, 'ungranted');
  worldSymlink = path.join(world, 'secret-link');

  mkdirSync(world);
  mkdirSync(grantDir);
  mkdirSync(ungrantedDir);
  writeFileSync(secret, 'topsecret\n');
  writeFileSync(readable, 'readable\n');
  writeFileSync(path.join(grantDir, 'inner.txt'), 'inner\n');
  chmodSync(secret, 0o644);
  chmodSync(readable, 0o644);
  chmodSync(path.join(grantDir, 'inner.txt'), 0o644);
  symlinkSync(secret, worldSymlink);
});

afterAll(() => {
  if (fixture !== '') rmSync(fixture, { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  pid: number;
}

function run(args: string[], options: { cwd?: string } = {}): RunResult {
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  const result = spawnSync(binary, args, spawnOptions);
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    pid: result.pid,
  };
}

/** A failure is exit 125 and exactly one `es-landlock: <context>: <detail>` line. */
function expectLauncherFailure(result: RunResult, detail: string | RegExp): void {
  expect(result.status).toBe(125);
  const lines = result.stderr.replace(/\n$/, '').split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^es-landlock: /);
  if (typeof detail === 'string') expect(result.stderr).toContain(detail);
  else expect(result.stderr).toMatch(detail);
}

const suite = describe.skipIf(!binaryPresent);

suite('es-landlock launcher', () => {
  describe('usage contract', () => {
    it(
      'rejects an invocation with no arguments',
      () => {
        expectLauncherFailure(run([]), 'missing --');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'rejects an unknown argument',
      () => {
        expectLauncherFailure(run(['--bogus']), 'unknown argument');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'rejects a missing -- before the program',
      () => {
        expectLauncherFailure(run(['--ro', '/usr']), 'missing --');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'rejects --probe combined with a program',
      () => {
        expectLauncherFailure(
          run([
            '--probe',
            '--probe-deny',
            secret,
            '--probe-rw',
            world,
            '--',
            '/bin/sh',
            '-c',
            'true',
          ]),
          '--probe cannot be combined with a program',
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('setup failures', () => {
    it(
      'fails on a grant path that does not exist',
      () => {
        expectLauncherFailure(
          run(['--ro', path.join(fixture, 'absent'), '--rox', '/usr', '--', '/bin/sh', '-c', 'true']),
          'No such file or directory',
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'refuses a symlink grant instead of building an inert rule',
      () => {
        expectLauncherFailure(
          run(['--ro', worldSymlink, '--rox', '/usr', '--', '/bin/sh', '-c', 'true']),
          'refusing symlink',
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'detects a --probe-deny path that is readable under the grants',
      () => {
        const grantedDeny = path.join(world, 'granted-deny.txt');
        writeFileSync(grantedDeny, 'readable\n');
        chmodSync(grantedDeny, 0o644);
        expectLauncherFailure(
          run([
            '--probe',
            '--probe-deny',
            grantedDeny,
            '--probe-rw',
            world,
            '--rw',
            world,
            '--ro',
            '/proc',
          ]),
          'readable under confinement',
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'fails on a nonexistent --probe-deny path (never a false pass)',
      () => {
        expectLauncherFailure(
          run([
            '--probe',
            '--probe-deny',
            path.join(fixture, 'never-existed'),
            '--probe-rw',
            world,
            '--rw',
            world,
            '--ro',
            '/proc',
          ]),
          'No such file or directory',
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'fails when a --probe-rw dir has no covering grant',
      () => {
        expectLauncherFailure(
          run([
            '--probe',
            '--probe-deny',
            secret,
            '--probe-rw',
            ungrantedDir,
            '--rw',
            world,
            '--ro',
            '/proc',
          ]),
          'Permission denied',
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('per-target-type right masking', () => {
    it(
      'builds a ruleset for a file grant and confines with it',
      () => {
        const result = run(['--ro', readable, '--rox', '/usr', '--', '/bin/sh', '-c', `cat ${readable}`]);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('readable\n');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'builds a ruleset with directory rights for a directory grant',
      () => {
        const result = run([
          '--ro',
          grantDir,
          '--rox',
          '/usr',
          '--',
          '/bin/sh',
          '-c',
          `ls ${grantDir} && cat ${grantDir}/inner.txt`,
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('inner.txt\ninner\n');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('confined happy path', () => {
    it(
      'writes, reads back and removes a file inside the rw world',
      () => {
        const target = path.join(world, 'created-by-test.txt');
        const result = run([
          '--rw',
          world,
          '--rox',
          '/usr',
          '--',
          '/bin/sh',
          '-c',
          `printf hi > ${target} && cat ${target} && rm ${target} && echo removed`,
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('hiremoved\n');
        expect(existsSync(target)).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'denies reading a secret outside every grant with EACCES',
      () => {
        const result = run(['--rw', world, '--rox', '/usr', '--', '/bin/sh', '-c', `cat ${secret}`]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Permission denied');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'denies a world symlink that points outside the grants',
      () => {
        const result = run(['--rw', world, '--rox', '/usr', '--', '/bin/sh', '-c', `cat ${worldSymlink}`]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Permission denied');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'denies the same read from a nested /bin/sh -c (the domain is inherited)',
      () => {
        const result = run([
          '--rw',
          world,
          '--rox',
          '/usr',
          '--',
          '/bin/sh',
          '-c',
          `sh -c 'cat ${secret}'`,
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('Permission denied');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('truncate mediation', () => {
    it(
      'denies truncating an outside file with : >',
      () => {
        const target = path.join(fixture, 'truncate-target.txt');
        writeFileSync(target, 'keep me\n');
        chmodSync(target, 0o644);
        const result = run([
          '--rw',
          world,
          '--rox',
          '/usr',
          '--',
          '/bin/sh',
          '-c',
          `: > ${target}`,
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Permission denied');
        expect(existsSync(target)).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('signal scope', () => {
    it(
      'denies killing a process outside the domain with EPERM',
      () => {
        const result = run(['--rox', '/usr', '--', '/bin/sh', '-c', `kill -0 ${process.pid}`]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Operation not permitted');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'allows killing a process inside the domain',
      () => {
        const result = run(['--rox', '/usr', '--', '/bin/sh', '-c', 'kill -0 $$ && echo self-ok']);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('self-ok\n');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('unix socket scopes', () => {
    const abstractAddress = `es-c14c-${process.pid}`;
    const abstractArg = `@${abstractAddress}`;
    const pathnameSocket = path.join(fixture, 'pathname.sock');
    // Pinned client: python with an inline -c. Node lives under the ungranted
    // nvm home, and a script file under /tmp would itself be EACCES.
    const pythonProbe = [
      'import socket,sys',
      'a=sys.argv[1]',
      'a=("\\0"+a[1:]) if a.startswith("@") else a',
      's=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(3)',
      'try: s.connect(a); print("connected")',
      'except OSError as e: print("errno=%d %s" % (e.errno,e.strerror)); sys.exit(1)',
    ].join('\n');

    let abstractServer: net.Server;
    let pathnameServer: net.Server;

    beforeAll(async () => {
      abstractServer = net.createServer((socket) => socket.end());
      pathnameServer = net.createServer((socket) => socket.end());
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          abstractServer.once('error', reject);
          abstractServer.listen(`\0${abstractAddress}`, () => resolve());
        }),
        new Promise<void>((resolve, reject) => {
          pathnameServer.once('error', reject);
          pathnameServer.listen(pathnameSocket, () => resolve());
        }),
      ]);
    });

    afterAll(async () => {
      await Promise.all([
        new Promise<void>((resolve) => abstractServer.close(() => resolve())),
        new Promise<void>((resolve) => pathnameServer.close(() => resolve())),
      ]);
    });

    function connect(target: string): RunResult {
      return run([
        '--rox',
        '/usr',
        '--ro',
        '/dev/urandom',
        '--',
        PYTHON,
        '-c',
        pythonProbe,
        target,
      ]);
    }

    it(
      'denies an abstract socket connect with EPERM',
      () => {
        const result = connect(abstractArg);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('errno=1 Operation not permitted\n');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'still allows a pathname socket connect at ABI 8 (documented residual)',
      () => {
        const result = connect(pathnameSocket);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('connected\n');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('process identity', () => {
    it(
      'preserves the pid across the in-place execve',
      () => {
        const result = run(['--rox', '/usr', '--', '/bin/sh', '-c', 'echo $$']);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(String(result.pid));
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('functional probe', () => {
    it(
      'reports the ABI and enforcement level after proving the ruleset',
      () => {
        const result = run([
          '--probe',
          '--probe-deny',
          secret,
          '--probe-rw',
          world,
          '--rw',
          world,
          '--ro',
          '/proc',
        ]);
        expect(result.status).toBe(0);
        const match = /^abi=(\d+)\nenforcement=(full|partial)\n$/.exec(result.stdout);
        expect(match).not.toBeNull();
        const abi = Number(match?.[1]);
        expect(abi).toBeGreaterThanOrEqual(3);
        expect(match?.[2]).toBe(abi >= 6 ? 'full' : 'partial');
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('fd hygiene', () => {
    it(
      'leaves only fds 0, 1, 2 plus the listing process’s own directory fd',
      () => {
        const result = run([
          '--ro',
          '/proc',
          '--rox',
          '/usr',
          '--',
          '/bin/sh',
          '-c',
          'ls /proc/self/fd',
        ]);
        expect(result.status).toBe(0);
        const fds = result.stdout
          .trim()
          .split('\n')
          .map((line) => Number(line))
          .sort((a, b) => a - b);
        expect(fds).toHaveLength(4);
        expect(fds.slice(0, 3)).toEqual([0, 1, 2]);
        expect(fds[3]).toBeGreaterThanOrEqual(3);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
