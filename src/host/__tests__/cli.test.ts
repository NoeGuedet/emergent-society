import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach, beforeEach, expect, it, vi,
} from 'vitest';
import { runCli, type CliDeps } from '../cli.js';
import { HostPauseError } from '../errors.js';
import type { HostOptions } from '../host.js';
import type { PauseOutcome } from '../owner.js';

/**
 * `runCli` is the only place argv meets the host: every case here observes the
 * exit code the shell will see and the two sinks the operator will read.
 *
 * The `init` case drives the real `initHome` against a real 0700 temp home, so
 * "init never creates providers.json" is proven on the filesystem. The dispatch
 * cases replace `startHost`/`requestPause`/the log, so no host, no cell and no
 * signal exists in this file.
 */

const stdout: string[] = [];
const stderr: string[] = [];
const deps: CliDeps = {
  stdout: (s: string) => { stdout.push(s); },
  stderr: (s: string) => { stderr.push(s); },
};

let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'es-cli-'));
  stdout.length = 0;
  stderr.length = 0;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('runCli init prints the providers path/schema hint and never creates providers.json', async () => {
  expect(await runCli(['init', '--home', home], deps)).toBe(0);
  expect(stdout.join('')).toMatch(/initialized/);
  expect(stdout.join('')).toContain(home);
  expect(stdout.join('')).toContain(join(home, 'providers.json'));
  await expect(access(join(home, 'providers.json'))).rejects.toThrow();
  expect(await runCli(['init', '--home', home], deps)).toBe(0);
  expect(stdout.join('')).toMatch(/already initialized/);
});

it('runCli works with no deps (default sinks) for help and init', async () => {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect(await runCli(['--help'])).toBe(0);
    expect(await runCli(['init', '--home', home])).toBe(0);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});

it('dispatches start with the resolved sandbox, no undefined optional fields, and a live log', async () => {
  const captured: HostOptions[] = [];
  const d = {
    ...deps,
    startHost: (o: HostOptions) => {
      captured.push(o);
      o.log.emit('host/boot', { model: 'm' });
      return { stop() {}, done: Promise.resolve(0) };
    },
  };
  expect(await runCli(
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--no-sandbox'], d,
  )).toBe(0);
  expect(captured[0]!.sandbox).toBe(false);
  expect(captured[0]!.uid).toBe('node-0');
  expect('model' in captured[0]!).toBe(true);
  expect('heading' in captured[0]!).toBe(true);
  expect('charterFile' in captured[0]!).toBe(false);
  expect(stderr.filter((l) => l.trim() !== '').map((l) => JSON.parse(l).event))
    .toEqual(['host/boot']);
});

it('dispatches resume without model/heading keys', async () => {
  const captured: HostOptions[] = [];
  const d = {
    ...deps,
    startHost: (o: HostOptions) => {
      captured.push(o);
      return { stop() {}, done: Promise.resolve(0) };
    },
  };
  expect(await runCli(['resume', '--home', '/x'], d)).toBe(0);
  expect('model' in captured[0]!).toBe(false);
  expect('heading' in captured[0]!).toBe(false);
});

it('dispatches the charter file only for start', async () => {
  const captured: HostOptions[] = [];
  const d = {
    ...deps,
    startHost: (o: HostOptions) => {
      captured.push(o);
      return { stop() {}, done: Promise.resolve(0) };
    },
  };
  expect(await runCli(
    ['start', '--home', '/x', '--model', 'm', '--heading', 'h', '--charter-file', '/tmp/c.txt'], d,
  )).toBe(0);
  expect(captured[0]!.charterFile).toBe('/tmp/c.txt');
  expect(await runCli(['resume', '--home', '/x'], d)).toBe(0);
  expect('charterFile' in captured[1]!).toBe(false);
});

it('maps pause outcomes to 0/2/3 and runtime failures to 1', async () => {
  const d = (p: PauseOutcome | Error) => ({
    ...deps,
    requestPause: async (): Promise<PauseOutcome> => {
      if (p instanceof Error) throw p;
      return p;
    },
  });
  expect(await runCli(['pause', '--home', '/x'], d({ kind: 'exited' }))).toBe(0);
  expect(await runCli(['pause', '--home', '/x'], d({ kind: 'no-host', state: 'absent' }))).toBe(2);
  expect(await runCli(['pause', '--home', '/x'], d({ kind: 'no-host', state: 'unverified' }))).toBe(2);
  expect(await runCli(['pause', '--home', '/x'], d({ kind: 'still-stopping', pid: 1 }))).toBe(3);
  expect(await runCli(['pause', '--home', '/x'], d(new HostPauseError('kill failed')))).toBe(1);
});

it('returns 2 for usage errors, prints usage once, and prints KernelError messages', async () => {
  expect(await runCli(['start', '--home', '/x'], deps)).toBe(2);
  expect(stderr.join('').match(/Usage:/g)).toHaveLength(1);
  const failing = {
    ...deps,
    requestPause: async (): Promise<PauseOutcome> => {
      throw new HostPauseError('killed');
    },
  };
  expect(await runCli(['pause', '--home', '/x'], failing)).toBe(1);
  expect(stderr.join('')).toContain('killed');
});

it('dispatches status: the report prints first, then the exit code it earns', async () => {
  const report = {
    home: '/x',
    host: { state: 'idle' as const },
    frontier: {
      present: false, count: 0, lastHash: null, counts: {}, openCalls: 0,
      lastRequest: null, lastResponse: null, error: null,
    },
    world: { present: false, head: null, error: null },
  };
  const clean = { ...deps, readStatus: async () => report };
  expect(await runCli(['status', '--home', '/x', '--json'], clean)).toBe(0);
  expect(stdout.join('')).toBe(`${JSON.stringify(report)}\n`);
  stdout.length = 0;
  const degraded = {
    ...report,
    frontier: { ...report.frontier, error: 'ChainBreakError' },
  };
  const failing = { ...deps, readStatus: async () => degraded };
  expect(await runCli(['status', '--home', '/x'], failing)).toBe(1);
  expect(stdout.join('')).toBe(
    'home: /x\n'
    + 'host: idle\n'
    + 'frontier: 0 events last=null http/request=0 http/response=0 http/incomplete=0 open=0\n'
    + 'world: absent\n',
  );
  // The human lines never print an error name; the exit code is the signal.
  expect(stdout.join('')).not.toContain('ChainBreakError');
});

it('maps status failures: a missing home to 2, any other throw to 1 with a bounded label', async () => {
  expect(await runCli(['status', '--home', join(home, 'nope')], deps)).toBe(2);
  expect(stderr.join('')).toContain('error:');
  stderr.length = 0;
  const failing = {
    ...deps,
    readStatus: async (): Promise<never> => {
      throw new Error('raw failure detail');
    },
  };
  expect(await runCli(['status', '--home', '/x'], failing)).toBe(1);
  expect(stderr.join('')).toContain('error: Error');
  expect(stderr.join('')).not.toContain('raw failure detail');
});
