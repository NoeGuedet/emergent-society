import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  link, mkdtemp, readdir, readFile, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import type { AgentConfig } from '../../context/contracts.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { FRONTIER_EVENT_TYPES, openFrontierJournal } from '../../frontier/index.js';
import { encodeBatch, scanBatches } from '../../journal/framing.js';
import {
  JournalReader, JournalWriter, frontierLayout, nodeLayout, type EventEnvelope,
} from '../../journal/index.js';
import { processStartTime } from '../../journal/lock.js';
import {
  serveJson, type LoopServer, type RecordedRequest,
} from '../../node/__tests__/helpers.js';
import { WorldRepo } from '../../node/world.js';
import {
  attachProcessHandlers, composeCell, startHost,
  type HostHandle, type HostOptions, type ProcessHandlersTarget,
} from '../host.js';
import { createHostLog, type HostLog } from '../observe.js';
import { readOwner } from '../owner.js';

/**
 * The host lifetime's acceptance: one process owns one cell from the signal
 * handlers it installs to the owner record it releases.
 *
 * Each case owns its temp home, its world pair, its 0600 credential store and
 * its own loopback server, and every case finishes through the real lifetime —
 * a start that parks and is stopped, or a gate refusal that resolves before any
 * park. The only network is the loopback fake provider; the in-flight case
 * holds its response until the test ends, which is what makes "the abort
 * reached a request that had already arrived" observable.
 */

/** The replies the loopback fixtures answer with; no queue case echoes a header. */
type ReplyBody = { status?: number; body: string };
type Responder = (request: RecordedRequest, index: number) => ReplyBody | Promise<ReplyBody>;

const idleReply: ReplyBody = {
  body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'idle' } }] }),
};

const existingConfig = validateAgentConfig({
  ...defaultAgentConfig(), model: 'first-light-test', heading: 'First light.',
});
const hostDeps = { installSignals: false, keepAlive: false } as const;

/** The captured stderr lines, keyed by the log that wrote them. */
const capturedLines = new WeakMap<HostLog, string[]>();
/** Every host this case started, so a failing assertion cannot leak a live one. */
const tracked: HostHandle[] = [];
let home = '';
let log: HostLog;
let opts: HostOptions;
let server: LoopServer | null = null;

/**
 * A fresh cell per case. The world pair is initialized here because `start`
 * refuses a home that is not a cell, and the credential store is written by
 * `serve()` once the case's loopback endpoint is known.
 */
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'es-lifecycle-'));
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  const lines: string[] = [];
  log = createHostLog((line) => lines.push(line));
  capturedLines.set(log, lines);
  opts = {
    home, uid: 'node-0', command: 'start', model: 'first-light-test',
    heading: 'First light.', sandbox: false, pollMs: 0, log,
  };
});

afterEach(async () => {
  for (const handle of tracked.splice(0)) {
    handle.stop();
    await handle.done;
  }
  if (server !== null) {
    await server.close();
    server = null;
  }
  await rm(home, { recursive: true, force: true });
  home = '';
});

function track(handle: HostHandle): HostHandle {
  tracked.push(handle);
  return handle;
}

/** Starts this case's loopback provider and writes the 0600 credential store. */
async function serve(respond: Responder = () => idleReply): Promise<LoopServer> {
  const started = await serveJson(respond);
  server = started;
  await writeProviders(started);
  return started;
}

async function writeProviders(target: LoopServer): Promise<void> {
  await writeFile(
    join(home, 'providers.json'),
    JSON.stringify({
      llm: { key: 'sentinel-llm-key', endpoint: `${target.url}/v1/chat/completions` },
    }),
    { mode: 0o600 },
  );
}

/**
 * Rebuilds the cell from nothing. `runHostOnce('start', {config})` above leaves
 * a journaled config behind, so a later resume case that must see a fresh cell
 * asks for this reset rather than inheriting the earlier seed.
 */
async function resetHome(): Promise<void> {
  await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), 'es-lifecycle-'));
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  opts = { ...opts, home };
  if (server !== null) await writeProviders(server);
}

/** The parsed diagnostics a log emitted, in order. */
function logged(target: HostLog): Record<string, unknown>[] {
  const lines = capturedLines.get(target);
  if (lines === undefined) throw new Error('log was not created by this suite');
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Polls until the log has emitted `event`; the default cap is the brief's 10 s. */
async function waitForLog(target: HostLog, event: string, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(() => {
    expect(logged(target).map((entry) => entry['event'])).toContain(event);
  }, { timeout: timeoutMs });
}

async function readC13(target: string, uid: string): Promise<EventEnvelope[]> {
  const reader = await JournalReader.open(target, uid, {
    knownTypes: C13_EVENT_TYPES, resolveBlobs: true,
  });
  const events: EventEnvelope[] = [];
  for await (const event of reader.events()) events.push(event);
  return events;
}

async function frontierEvents(target: string): Promise<EventEnvelope[]> {
  const reader = await JournalReader.openIn(frontierLayout(target), {
    knownTypes: FRONTIER_EVENT_TYPES,
  });
  const events: EventEnvelope[] = [];
  for await (const event of reader.events()) events.push(event);
  return events;
}

function types(events: readonly EventEnvelope[]): string[] {
  return events.map((event) => event.type);
}

function lastType(events: readonly EventEnvelope[]): string | undefined {
  return events.at(-1)?.type;
}

function lastTurnEnd(events: readonly EventEnvelope[]): { readonly outcome: string } {
  const closer = events.filter((event) => event.type === 'turn/end').at(-1);
  if (closer === undefined) throw new Error('the local log has no turn/end');
  return closer.data as { readonly outcome: string };
}

/** A pid the OS has already reaped, so its liveness probe is a plain miss. */
function reapedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', () => { resolve(child.pid as number); });
  });
}

type OwnerJson = {
  v: 1; pid: number; startTime: number | null; token: string;
  uid: string; command: 'start' | 'resume'; startedAt: number;
};

/** Writes a complete, valid 0600 record to `host.json`, overridden per case. */
async function writeOwner(target: string, partial: Partial<OwnerJson>): Promise<void> {
  const record: OwnerJson = {
    v: 1,
    pid: process.pid,
    startTime: await processStartTime(process.pid),
    token: 'a'.repeat(32),
    uid: 'node-0',
    command: 'start',
    startedAt: Date.now(),
    ...partial,
  };
  await writeFile(join(target, 'host.json'), JSON.stringify(record), { mode: 0o600 });
}

/** Journals a `system/message` config with no turn around it. */
async function seedConfig(config: AgentConfig): Promise<void> {
  const writer = await JournalWriter.open(home, 'node-0', {});
  writer.append('system/message', {
    version: config.version,
    value: { kind: 'inline', value: config },
  });
  await writer.flush();
  await writer.close();
}

/** The recoverable crash window: a durable boot with no configuration. */
async function seedBootOnly(target: string): Promise<void> {
  const writer = await JournalWriter.open(target, 'node-0', {});
  writer.append('node/boot', { reason: 'start' });
  await writer.flush();
  await writer.close();
}

/**
 * Rewrites one middle frame of the node's log so the hash chain breaks while
 * the prefix stays readable. The frame keeps its length prefix and stays valid
 * JSON; only the recorded hash no longer matches the event it describes.
 */
async function damageInteriorFrame(target: string): Promise<void> {
  const writer = await JournalWriter.open(target, 'node-0', {});
  writer.append('node/boot', { reason: 'start' });
  await writer.flush();
  writer.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
  await writer.flush();
  writer.append('turn/end', { turn: 0, outcome: 'waiting' });
  await writer.flush();
  await writer.close();

  const path = join(nodeLayout(target, 'node-0').dir, nodeLayout(target, 'node-0').logFile);
  const original = await readFile(path);
  const { batches } = scanBatches(original);
  const middle = batches[Math.floor(batches.length / 2)];
  if (middle === undefined) throw new Error('the seeded log has no frame to damage');
  const rewritten = middle.lines.map((line, index) => {
    if (index !== 0) return line;
    const record = JSON.parse(line) as { hash: string } & Record<string, unknown>;
    record.hash = `${record.hash.startsWith('0') ? '1' : '0'}${record.hash.slice(1)}`;
    return JSON.stringify(record);
  });
  const rebuilt = batches.map((batch) => (
    batch === middle
      ? encodeBatch(rewritten)
      : original.subarray(batch.offset, batch.offset + batch.size)
  ));
  await writeFile(path, Buffer.concat(rebuilt));
}

type HostOnceSetup = {
  readonly model?: string; readonly heading?: string; readonly charterFile?: string;
  readonly config?: AgentConfig; readonly fresh?: boolean;
  readonly expectRefusal?: boolean;
};

/**
 * Runs one host to completion. A non-refusal case waits for the park, stops the
 * host and returns its own code; a refusal case resolves before any park, so it
 * is awaited directly. `resume` drops `model`/`heading` because §3.5 refuses a
 * resume that carries either; a `charterFile` in setup is threaded through on
 * both commands so the resume refusal is observable too.
 */
async function runHostOnce(command: 'start' | 'resume', setup: HostOnceSetup = {}): Promise<number> {
  if (setup.fresh === true) await resetHome();
  if (setup.config !== undefined) await seedConfig(setup.config);
  const options: HostOptions = command === 'start'
    ? {
        ...opts,
        ...(setup.model !== undefined ? { model: setup.model } : {}),
        ...(setup.heading !== undefined ? { heading: setup.heading } : {}),
        ...(setup.charterFile !== undefined ? { charterFile: setup.charterFile } : {}),
      }
    : (() => {
        const { model, heading, ...resumeOpts } = opts;
        return {
          ...resumeOpts,
          command: 'resume' as const,
          ...(setup.charterFile !== undefined ? { charterFile: setup.charterFile } : {}),
        };
      })();
  const handle = track(startHost(options, hostDeps));
  if (setup.expectRefusal !== true) {
    await waitForLog(log, 'host/parked');
    handle.stop();
  }
  return await handle.done;
}

it('stops cleanly while parked and leaves no owner record', async () => {
  await serve();
  const h = track(startHost(opts, hostDeps));
  await waitForLog(log, 'host/parked');
  h.stop();
  expect(await h.done).toBe(0);
  expect((await readOwner(home)).kind).toBe('absent');
  const events = await readC13(home, 'node-0');
  expect(lastType(events)).toBe('node/shutdown');
  expect((await readFile(join(home, 'nodes', 'node-0', 'log.v0.jsonl.zstd'))).byteLength)
    .toBeGreaterThan(0);
  const reopened = await openFrontierJournal(home, { worldHead: async () => null, now: Date.now });
  await reopened.close();
}, 20_000);

it('cancels an in-flight provider request only after it has arrived, with no retry', async () => {
  const srv = await serve(() => new Promise<ReplyBody>(() => {}));
  const h = track(startHost(opts, hostDeps));
  await vi.waitFor(() => expect(srv.requests.length).toBe(1), { timeout: 10_000 });
  h.stop();
  expect(await h.done).toBe(0);
  const f = await frontierEvents(home);
  expect(f.filter((e) => e.type === 'http/request')).toHaveLength(1);
  expect(f.filter((e) => e.type === 'http/response')).toHaveLength(1);
  const terminal = f.find((e) => e.type === 'http/response')!.data as
    { error: { code: string } | null };
  expect(terminal.error?.code).toBe('cancelled');
  expect(srv.requests).toHaveLength(1);
  expect(lastTurnEnd(await readC13(home, 'node-0')).outcome).toBe('waiting');
}, 20_000);

it('queues a stop that arrives before compose resolves and cleans the opened driver', async () => {
  await serve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = track(startHost(opts, {
    ...hostDeps,
    compose: async (o) => { await gate; return composeCell(o); },
  }));
  h.stop();
  release();
  expect(await h.done).toBe(0);
  const events = await readC13(home, 'node-0');
  expect(types(events)).toContain('node/boot');
  expect(types(events)).toContain('node/shutdown');
  expect(types(events)).not.toContain('turn/start');
  expect((await readOwner(home)).kind).toBe('absent');
}, 20_000);

it('start refuses a journaled config; resume refuses a fresh cell', async () => {
  await serve();
  expect(await runHostOnce('start', { config: existingConfig, expectRefusal: true })).toBe(2);
  expect(await runHostOnce('resume', { fresh: true, expectRefusal: true })).toBe(2);
}, 20_000);

it('start recovers a log with node/boot but no system/message', async () => {
  await serve();
  await seedBootOnly(home);
  expect(await runHostOnce('start', {})).toBe(0);
  const events = await readC13(home, 'node-0');
  expect(events.filter((e) => e.type === 'system/message')).toHaveLength(1);
  expect(events.some(
    (e) => e.type === 'node/boot' && (e.data as { reason?: string }).reason === 'resume',
  )).toBe(true);
  // The factory-charter branch composes the identity sentence too (the common
  // production path has no --charter-file).
  const seeded = events.filter((e) => e.type === 'system/message')[0]!.data as
    { value: { value: { charter: string } } };
  expect(seeded.value.value.charter)
    .toBe(`${defaultAgentConfig().charter} You are node-0.`);
}, 20_000);

it('refuses mock-model, a missing heading and a corrupt log with exit 2', async () => {
  await serve();
  expect(await runHostOnce('start', { model: 'mock-model', expectRefusal: true })).toBe(2);
  expect(await runHostOnce('start', { heading: '', expectRefusal: true })).toBe(2);
  await damageInteriorFrame(home);
  expect(await runHostOnce('start', { expectRefusal: true })).toBe(2);
  expect(logged(log)).toContainEqual(
    expect.objectContaining({ event: 'host/error', error: 'HostConfigError' }),
  );
}, 20_000);

it('start composes the operator charter; resume refuses the flag-carried file', async () => {
  await serve();
  const charterPath = join(home, 'charter.txt');
  await writeFile(charterPath, 'Operator charter for a production variant.', { mode: 0o600 });
  expect(await runHostOnce('start', { charterFile: charterPath })).toBe(0);
  const events = await readC13(home, 'node-0');
  const seeded = events.filter((e) => e.type === 'system/message')[0]!.data as
    { value: { value: { charter: string } } };
  expect(seeded.value.value.charter).toBe(
    'Operator charter for a production variant. You are node-0.');
  expect(await runHostOnce('resume', { charterFile: charterPath, expectRefusal: true })).toBe(2);
}, 20_000);

it('start refuses a missing, empty, invalid or oversize charter file with exit 2', async () => {
  await serve();
  expect(await runHostOnce('start', { charterFile: join(home, 'absent.txt'), expectRefusal: true }))
    .toBe(2);
  const emptyPath = join(home, 'empty.txt');
  await writeFile(emptyPath, '');
  expect(await runHostOnce('start', { charterFile: emptyPath, expectRefusal: true })).toBe(2);
  const blankPath = join(home, 'blank.txt');
  await writeFile(blankPath, ' \n\t ');
  expect(await runHostOnce('start', { charterFile: blankPath, expectRefusal: true })).toBe(2);
  await writeFile(join(home, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x41]));
  expect(await runHostOnce('start', { charterFile: join(home, 'bad.txt'), expectRefusal: true }))
    .toBe(2);
  expect(await runHostOnce('start', { charterFile: join(home, 'world'), expectRefusal: true }))
    .toBe(2);
  expect(await runHostOnce('start', { charterFile: join(home, 'providers.json'), expectRefusal: true }))
    .toBe(2);
  // The store's identity, not just its path: a symlink or a hardlink to it
  // carries the same inode and must refuse the same way.
  await symlink(join(home, 'providers.json'), join(home, 'link-charter.txt'));
  expect(await runHostOnce('start', { charterFile: join(home, 'link-charter.txt'), expectRefusal: true }))
    .toBe(2);
  await link(join(home, 'providers.json'), join(home, 'hard-charter.txt'));
  expect(await runHostOnce('start', { charterFile: join(home, 'hard-charter.txt'), expectRefusal: true }))
    .toBe(2);
  await writeFile(join(home, 'huge.txt'), 'x'.repeat(8193));
  expect(await runHostOnce('start', { charterFile: join(home, 'huge.txt'), expectRefusal: true }))
    .toBe(2);
  expect(logged(log)).toContainEqual(
    expect.objectContaining({ event: 'host/error', error: 'HostConfigError' }),
  );
  // The boot-recovery start (node/boot journaled, no config) still composes a
  // charter — and the exact 8192-byte FILE boundary is accepted, not refused
  // (the composed charter grows by the identity sentence past the file cap,
  // which bounds the operator's file, not the composed value).
  await seedBootOnly(home);
  const exactPath = join(home, 'exact.txt');
  await writeFile(exactPath, 'x'.repeat(8192));
  expect(await runHostOnce('start', { charterFile: exactPath })).toBe(0);
  const events = await readC13(home, 'node-0');
  const seeded = events.filter((e) => e.type === 'system/message')[0]!.data as
    { value: { value: { charter: string } } };
  expect(seeded.value.value.charter).toBe('x'.repeat(8192) + ' You are node-0.');
}, 20_000);

it('a journaled configuration wins over --charter-file', async () => {
  await serve();
  await seedConfig(existingConfig);
  const charterPath = join(home, 'charter.txt');
  await writeFile(charterPath, 'Operator charter for a production variant.', { mode: 0o600 });
  expect(await runHostOnce('start', { charterFile: charterPath, expectRefusal: true })).toBe(2);
  const events = await readC13(home, 'node-0');
  expect(events.filter((e) => e.type === 'system/message')).toHaveLength(1);
}, 20_000);

it('resume uses the journaled model and writes no second system/message', async () => {
  await serve();
  expect(await runHostOnce('start', {})).toBe(0);
  expect(await runHostOnce('resume', {})).toBe(0);
  const events = await readC13(home, 'node-0');
  expect(events.filter((e) => e.type === 'system/message')).toHaveLength(1);
  expect(events.some(
    (e) => e.type === 'node/boot' && (e.data as { reason?: string }).reason === 'resume',
  )).toBe(true);
  expect(events.filter((e) => e.type === 'system/message')[0]!.data).toMatchObject({
    value: expect.objectContaining({ value: expect.objectContaining({ model: 'first-light-test' }) }),
  });
}, 20_000);

it('refuses a second host while the first runs, after the first has parked', async () => {
  await serve();
  const first = track(startHost(opts, hostDeps));
  await waitForLog(log, 'host/parked');
  const { model, heading, ...resumeOpts } = opts;
  const second = track(startHost({ ...resumeOpts, command: 'resume' }, hostDeps));
  expect(await second.done).toBe(1);
  expect(logged(log)).toContainEqual(
    expect.objectContaining({ event: 'host/error', error: 'HostAlreadyRunningError' }),
  );
  first.stop();
  expect(await first.done).toBe(0);
}, 20_000);

it('reclaims a stale owner whose pid was reaped', async () => {
  await serve();
  const dead = await reapedPid();
  await writeOwner(home, { pid: dead, startTime: 1 });
  const h = track(startHost(opts, hostDeps));
  await waitForLog(log, 'host/parked');
  expect(logged(log)).toContainEqual(expect.objectContaining({ event: 'host/boot' }));
  const live = await readOwner(home);
  expect(live.kind).toBe('live');
  if (live.kind === 'live') expect(live.record.pid).not.toBe(dead);
  expect((await readdir(home)).filter((name) => name.startsWith('.host.'))).toEqual([]);
  h.stop();
  expect(await h.done).toBe(0);
  expect((await readOwner(home)).kind).toBe('absent');
}, 20_000);

it('logs an unhandled rejection through the injected proc and exits 1', async () => {
  await serve();
  const proc = new EventEmitter();
  const h = track(startHost(opts, {
    ...hostDeps,
    installSignals: true,
    proc: proc as unknown as ProcessHandlersTarget,
  }));
  await waitForLog(log, 'host/boot');
  proc.emit('unhandledRejection', new Error('x'), Promise.resolve());
  expect(await h.done).toBe(1);
  expect(logged(log)).toContainEqual(
    expect.objectContaining({ event: 'host/unhandled-rejection', error: 'Error' }),
  );
  expect(logged(log)).toContainEqual(expect.objectContaining({ event: 'host/stop', code: 1 }));
}, 20_000);

it('attachProcessHandlers forwards SIGINT/SIGTERM and unhandledRejection then detaches', () => {
  const proc = new EventEmitter();
  const calls: string[] = [];
  const detach = attachProcessHandlers({
    onStop: () => calls.push('stop'),
    onUnhandled: () => calls.push('unhandled'),
  }, proc);
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  proc.emit('unhandledRejection', new Error('x'));
  expect(calls).toEqual(['stop', 'stop', 'unhandled']);
  detach();
  proc.emit('SIGINT');
  expect(calls).toHaveLength(3);
}, 20_000);
