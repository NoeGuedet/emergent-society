import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalBytes } from '../../context/artifacts.js';
import { assemble } from '../../context/assembler.js';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import type { AgentConfig, ChatMessage, RequestPlan } from '../../context/contracts.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { ContextFold } from '../../context/fold.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { FRONTIER_EVENT_TYPES, openFrontierJournal } from '../../frontier/index.js';
import { TEST_STORAGE } from '../../frontier/__tests__/helpers.js';
import { encodeBatch, scanBatches } from '../../journal/framing.js';
import {
  JournalReader, JournalWriter, frontierLayout, nodeLayout, type EventEnvelope,
} from '../../journal/index.js';
import { processStartTime } from '../../journal/lock.js';
import {
  serveJson, type LoopServer, type RecordedRequest,
} from '../../node/__tests__/helpers.js';
import { MAX_CAPTURE_BYTES } from '../../node/gate.js';
import { modelRefusal } from '../../node/tools/providers.js';
import {
  ESCAPE_FACTOR, IDENTITY_FLOOR, PLAN_MARGIN, assertSendableIdentity, effectiveCeiling,
  identityBudget, identityBytes, reserve,
} from '../../node/identity-budget.js';
import { canonicalMessagesBytes } from '../../provider/wire.js';
import { WorldRepo } from '../../node/world.js';
import {
  attachProcessHandlers, composeCell, startHost,
  type HostHandle, type HostOptions, type ProcessHandlersTarget,
} from '../host.js';
import { createHostLog, type HostLog } from '../observe.js';
import { readOwner, requestPause } from '../owner.js';
import { formatStatus, readStatus } from '../status.js';

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
const hostDeps = {
  installSignals: false, keepAlive: false,
  // The cgroup layer is exercised by cgroups.test.ts with its own harness; the
  // lifecycle cases must never move this worker into a cgroup tree.
  attachToCell: async () => ({ ok: false as const, reason: 'test-stub' }),
  // Hermetic storage: the controlled HIGH probe, never the real /tmp headroom.
  // The production default stays the real statfs (HostDeps has no production
  // switch); the explicit real-probe cases live in storage.test.ts/driver-storage.
  freeSpace: TEST_STORAGE.probe,
} as const;

/** The captured stderr lines, keyed by the log that wrote them. */
const capturedLines = new WeakMap<HostLog, string[]>();
/** Every host this case started, so a failing assertion cannot leak a live one. */
const tracked: HostHandle[] = [];
let home = '';
let log: HostLog;
let opts: HostOptions;
let server: LoopServer | null = null;
/** The catalog the current case's store declares (undefined = none). */
let servedModels: readonly string[] | undefined;

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
  servedModels = undefined;
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
async function serve(
  respond: Responder = () => idleReply, models?: readonly string[],
): Promise<LoopServer> {
  const started = await serveJson(respond);
  server = started;
  servedModels = models;
  await writeProviders(started);
  return started;
}

async function writeProviders(target: LoopServer): Promise<void> {
  await writeFile(
    join(home, 'providers.json'),
    JSON.stringify({
      llm: {
        key: 'sentinel-llm-key', endpoint: `${target.url}/v1/chat/completions`,
        ...(servedModels !== undefined ? { models: servedModels } : {}),
      },
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

// --- the identity-budget boundary fixture (S5, plan §0.5) -------------------

/** The model the boundary fixture's store declares and its config names. */
const BOUNDARY_MODEL = 'boundary-model';
/** The declared catalog, so the reserve's substrate term is real. */
const BOUNDARY_CATALOG = [BOUNDARY_MODEL] as const;
/** Headroom between the fixture identity and the derived budget (over the actual O). */
const BOUNDARY_HEADROOM = 128 * 1024;
/** A C0 control character: JSON-escaped as a six-byte \u00XX — the true 6× case. */
const C0_CHAR = '\u0001';
/** The identity fill of the two fixture identities (well above the 256 KiB floor). */
const CAPS_IDENTITY_FILL = 1_500_000;
const K_IDENTITY_FILL = 500_000;

/** The reserve's history component: the K branch or the caps branch, whichever is larger. */
function historyComponent(policy: AgentConfig['policy']): number {
  return Math.max(
    policy.compactAfterBytes,
    (policy.keepRecentGroups * policy.maxCallsPerResponse * policy.maxToolResultBytes
      + policy.keepRecentGroups * policy.maxAssistantBytes) * ESCAPE_FACTOR,
  );
}

/**
 * A config whose policy is shrunk into the uncapped band, with the ceiling
 * solved together with the identity: `C = reserve + identity + headroom`, so
 * `budget = C − reserve = identity + headroom` — strictly above the floor and
 * leaving more than the plan's actual metadata overhead beside the identity.
 * Under the factory policy the same identity is refused (the budget collapses
 * to the floor).
 */
function shrunkBoundaryConfig(
  patch: Partial<AgentConfig['policy']>, identityFill: number,
): { readonly config: AgentConfig; readonly ceiling: number } {
  const base = defaultAgentConfig();
  const compose = (maxRequestBytes: number): AgentConfig => validateAgentConfig({
    ...base,
    model: BOUNDARY_MODEL,
    heading: 'Boundary seed.',
    charter: 'c'.repeat(identityFill) + ' You are node-0.',
    policy: { ...base.policy, ...patch, maxRequestBytes },
  });
  const probe = compose(1 * 1024 * 1024);
  const ceiling = reserve(probe, BOUNDARY_CATALOG) + identityBytes(probe) + BOUNDARY_HEADROOM;
  return { config: compose(ceiling), ceiling };
}

/** One balanced dialogue group: an assistant call and its one result, at the given sizes. */
function dialogueGroup(
  ordinal: number, assistantChars: number, resultChars: number,
): ChatMessage[] {
  const call = {
    id: `call-${ordinal}`, type: 'function' as const,
    function: { name: 'execute', arguments: '{"cmd":"true"}' },
  };
  return [
    { role: 'assistant', content: C0_CHAR.repeat(assistantChars), tool_calls: [call] },
    { role: 'tool', content: C0_CHAR.repeat(resultChars), tool_call_id: call.id },
  ];
}

/**
 * `keepRecentGroups` control-laden groups whose canonical total is the target
 * (the K-dominant variant): the envelope is the per-message JSON around the
 * six-byte escapes, measured once with one-character contents.
 */
function sizedControlGroups(targetCanonical: number, groups: number): ChatMessage[][] {
  const probe = Array.from({ length: groups }, (_, ordinal) => dialogueGroup(ordinal, 1, 1));
  const envelope = canonicalMessagesBytes(probe.flat()).length
    - groups * 2 * ESCAPE_FACTOR;
  const raw = Math.max(groups * 2, Math.floor((targetCanonical - envelope) / ESCAPE_FACTOR));
  const perMessage = Math.max(1, Math.floor(raw / (groups * 2)));
  return Array.from({ length: groups }, (_, ordinal) =>
    dialogueGroup(ordinal, perMessage, perMessage));
}

/**
 * Seeds the control-laden dialogue groups DIRECTLY into the node-local journal:
 * `execute` sanitizes PTY output and strips C0, so a driven result can never
 * carry the true six-byte escapes (plan S5). One closed turn promotes exactly
 * `keepRecentGroups` balanced dialogue groups, so the compaction span is
 * eligible-empty. Returns the canonical history size H.
 */
async function seedControlHistory(
  turn: number, groups: readonly ChatMessage[][],
): Promise<number> {
  const writer = await JournalWriter.open(home, 'node-0', {});
  writer.append('turn/start', { turn, trigger: 'boot', world: { from: null, to: null } });
  groups.forEach((messages, ordinal) => {
    const assistant = messages[0];
    const result = messages[1];
    if (assistant === undefined || assistant.role !== 'assistant'
      || result === undefined || result.role !== 'tool') {
      throw new Error('a seeded group is not one assistant and one result');
    }
    const call = assistant.tool_calls[0];
    if (call === undefined) throw new Error('a seeded assistant advertises no call');
    const request = { turn, ordinal };
    writer.append('assistant/message', {
      id: request,
      value: {
        kind: 'inline',
        value: { message: assistant, contentTruncated: false, frontierCall: 'f'.repeat(32) },
      },
    });
    writer.append('tool/call', { turn, request, call });
    writer.append('tool/result', {
      turn, request, callId: call.id, message: result,
      isError: false, raw: null, failure: null, synthetic: false, frontierCall: null,
    });
  });
  writer.append('turn/end', { turn, outcome: 'waiting' });
  await writer.flush();
  await writer.close();
  return canonicalMessagesBytes(groups.flat()).length;
}

/**
 * Folds the local journal through the measured request's turn opening — the
 * exact state the runtime assembles the boundary plan from: `turn/start`, then
 * the turn's (empty) perception and its artifact events, no direction pin —
 * and reconstructs that plan. The plan is never journaled; this is the
 * assembler's own pure function over the folded journal.
 */
async function boundaryPlan(expectedTurn: number): Promise<{
  readonly fold: ContextFold; readonly plan: RequestPlan; readonly planBytes: number;
}> {
  const events = await loadVerifiedEvents(home, 'node-0', C13_EVENT_TYPES);
  const start = events.findIndex((event) => event.type === 'turn/start'
    && (event.data as { turn?: number }).turn === expectedTurn);
  if (start < 0) throw new Error(`the local log has no turn/start for turn ${expectedTurn}`);
  const trailing = new Set([
    'world/perception', 'direction/pinned', 'artifact/chunk', 'artifact/end',
  ]);
  let end = start;
  while (end + 1 < events.length && trailing.has(events[end + 1]!.type)) end += 1;
  const fold = new ContextFold();
  await fold.observe(events.slice(0, end + 1));
  const plan = assemble({
    id: { turn: expectedTurn, ordinal: 0 }, state: fold.snapshot(), models: BOUNDARY_CATALOG,
  });
  return { fold, plan, planBytes: canonicalBytes(plan).length };
}

/** The last turn number the local log opened. */
async function lastTurnNumber(): Promise<number> {
  const events = await readC13(home, 'node-0');
  return Math.max(...events
    .filter((event) => event.type === 'turn/start')
    .map((event) => Number((event.data as { turn?: number }).turn)));
}

/** What one measured boundary run hands the test: the request the premise names. */
type BoundaryRun = {
  readonly fold: ContextFold; readonly plan: RequestPlan;
  readonly planBytes: number; readonly wireBytes: number; readonly wireBody: string;
  readonly seededH: number;
};

/**
 * Runs one boundary fixture: starts the shrunk config through the test-only
 * config seam (one hanging provider request, so the start journals its config
 * and parks without a committed idle dialogue), seeds the control-laden
 * history, resumes and measures the first request the resumed node sends —
 * the boundary plan. Every wait is generous (the plan is megabytes): 120 s.
 */
async function measureBoundary(
  srv: LoopServer, config: AgentConfig, groups: ChatMessage[][],
): Promise<BoundaryRun> {
  const started = track(startHost(opts, {
    ...hostDeps, readInitialConfig: async () => config,
  }));
  await vi.waitFor(() => expect(srv.requests.length).toBe(1), { timeout: 120_000 });
  started.stop();
  expect(await started.done).toBe(0);

  const seededTurn = await lastTurnNumber() + 1;
  const seededH = await seedControlHistory(seededTurn, groups);
  const { model, heading, ...resumeOpts } = opts;
  const resumed = track(startHost({ ...resumeOpts, command: 'resume' }, hostDeps));
  const boundary = srv.requests.length;
  await vi.waitFor(() => expect(srv.requests.length).toBe(boundary + 1), { timeout: 120_000 });
  const wire = srv.requests[boundary]!;
  resumed.stop();
  expect(await resumed.done).toBe(0);

  const { fold, plan, planBytes } = await boundaryPlan(seededTurn + 1);
  return {
    fold, plan, planBytes, wireBytes: wire.body.byteLength,
    wireBody: wire.body.toString('utf8'), seededH,
  };
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
  const reopened = await openFrontierJournal(home, {
    worldHead: async () => null, now: Date.now, storage: TEST_STORAGE,
  });
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

it('validates a solo start against the declared manifest, after the store loads', async () => {
  await serve(undefined, ['served-a', 'served-b']);
  expect(await runHostOnce('start', { expectRefusal: true })).toBe(2);
  const error = logged(log).find((entry) => entry['event'] === 'host/error');
  expect(error).toMatchObject({ error: 'HostConfigError' });
  // The enumeration is the shared teaching refusal, whole: the pointer is the
  // tail, so its presence proves the log's 200-code-point bound did not cut it.
  const message = String(error?.['message']);
  expect(message).toBe(modelRefusal('first-light-test', ['served-a', 'served-b']));
  expect(message).toContain('(2 models total — inspect lists them)');
  // A configuration refusal: no cell composed, no boot, no turn.
  expect(logged(log).some((entry) => entry['event'] === 'host/boot')).toBe(false);
  expect(logged(log).some((entry) => entry['event'] === 'host/parked')).toBe(false);
}, 20_000);

it('validates every nodes-file start entry against the declared manifest', async () => {
  await serve(undefined, ['served-a']);
  const nodesFile = join(home, 'nodes.json');
  await writeFile(nodesFile, JSON.stringify([
    { uid: 'node-0', model: 'served-a', heading: 'Lead.' },
    { uid: 'node-1', model: 'not-served', heading: 'Worker.' },
  ]));
  const handle = track(startHost({ ...opts, nodesFile }, hostDeps));
  expect(await handle.done).toBe(2);
  const error = logged(log).find((entry) => entry['event'] === 'host/error');
  expect(error).toMatchObject({ error: 'HostConfigError' });
  expect(String(error?.['message'])).toBe(
    modelRefusal('not-served', ['served-a']));
}, 20_000);

it('treats an empty declaration as a catalog: starts, spawn models and the block say none', async () => {
  // One scripted server for both phases. The refused start sends nothing, so
  // the resume's first request is the server's first: it asks for a spawn
  // naming a model, and every later request parks.
  const spawnReply: ReplyBody = {
    body: JSON.stringify({ choices: [{ message: {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'e0', type: 'function',
        function: {
          name: 'extend',
          arguments: JSON.stringify({ verb: 'spawn', model: 'any-model', heading: 'Child.' }),
        },
      }],
    } }] }),
  };
  const srv = await serve((_request, index) => (index === 0 ? spawnReply : idleReply), []);

  // A start is refused: the declaration exists and serves nothing.
  expect(await runHostOnce('start', { expectRefusal: true })).toBe(2);
  const error = logged(log).find((entry) => entry['event'] === 'host/error');
  expect(error).toMatchObject({ error: 'HostConfigError' });
  expect(String(error?.['message'])).toBe(modelRefusal('first-light-test', []));
  expect(String(error?.['message']))
    .toContain('no models (providers.json declares llm.models empty)');
  expect(logged(log).some((entry) => entry['event'] === 'host/boot')).toBe(false);

  // A journaled config still resumes (resume never re-validates): its request
  // renders the empty block, and a spawn naming any model is refused.
  await seedConfig(existingConfig);
  const nodesFile = join(home, 'nodes.json');
  await writeFile(nodesFile, JSON.stringify([{ uid: 'node-0', spawn: true }]));
  const { model, heading, ...resumeOpts } = opts;
  const resumed = track(startHost({ ...resumeOpts, command: 'resume', nodesFile }, hostDeps));
  const denials = async (): Promise<string[]> => (await readC13(home, 'node-0'))
    .filter((event) => event.type === 'tool/result')
    .map((event) => ((event.data as { message?: { content?: string } }).message?.content) ?? '')
    .filter((content) => content.startsWith('denied:'));
  await vi.waitFor(async () => { expect(await denials()).toHaveLength(1); }, { timeout: 10_000 });
  resumed.stop();
  expect(await resumed.done).toBe(0);

  expect((await denials())[0]).toBe(`denied: ${modelRefusal('any-model', [])}`);
  expect(logged(log).some((entry) => entry['event'] === 'host/spawned')).toBe(false);
  await expect(lstat(join(home, 'nodes', 'node-1')))
    .rejects.toMatchObject({ code: 'ENOENT' });
  const first = srv.requests[0];
  expect(first).toBeDefined();
  const body = JSON.parse(first!.body.toString('utf8')) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(body.messages[2]).toEqual({
    role: 'system', content: 'The substrate this kernel serves — models: (none declared)',
  });
}, 30_000);

it('never re-validates a resume: the journaled config wins over a newer manifest', async () => {
  // Boot with no catalog: the model is journaled as a free string.
  const srv = await serve();
  expect(await runHostOnce('start', {})).toBe(0);
  const sent = srv.requests.length;
  // The operator then declares a catalog that does not serve the journaled
  // model. A start would be refused; the resume is admitted, and its request
  // still carries the newly declared substrate block.
  servedModels = ['served-a'];
  await writeProviders(srv);
  const { model, heading, ...resumeOpts } = opts;
  const resumed = track(startHost({ ...resumeOpts, command: 'resume' }, hostDeps));
  await vi.waitFor(
    () => expect(srv.requests.length).toBeGreaterThan(sent), { timeout: 10_000 });
  resumed.stop();
  expect(await resumed.done).toBe(0);
  const last = srv.requests.at(-1);
  expect(last).toBeDefined();
  const body = JSON.parse(last!.body.toString('utf8')) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(body.messages[2]).toEqual({
    role: 'system', content: 'The substrate this kernel serves — models: served-a',
  });
}, 30_000);

it('projects the declared models as the third kernel system block on the wire', async () => {
  const srv = await serve(undefined, ['first-light-test', 'served-b']);
  const h = track(startHost(opts, hostDeps));
  await waitForLog(log, 'host/parked');
  h.stop();
  expect(await h.done).toBe(0);
  const first = srv.requests[0];
  expect(first).toBeDefined();
  const body = JSON.parse(first!.body.toString('utf8')) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(body.messages[0]!.role).toBe('system');
  expect(body.messages[0]!.content).toContain('You are node-0.');
  expect(body.messages[1]).toEqual({ role: 'system', content: 'First light.' });
  expect(body.messages[2]).toEqual({
    role: 'system',
    content: 'The substrate this kernel serves — models: first-light-test, served-b',
  });
}, 20_000);

it('renders no substrate block when the store declares no catalog', async () => {
  const srv = await serve();
  const h = track(startHost(opts, hostDeps));
  await waitForLog(log, 'host/parked');
  h.stop();
  expect(await h.done).toBe(0);
  const first = srv.requests[0];
  expect(first).toBeDefined();
  const body = JSON.parse(first!.body.toString('utf8')) as {
    messages: Array<{ role: string; content: string }>;
  };
  expect(body.messages.filter((message) => message.role === 'system')).toHaveLength(2);
  expect(JSON.stringify(body)).not.toContain('The substrate this kernel serves');
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

it('start refuses a missing, empty, invalid or over-bound charter file with exit 2', async () => {
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

  // "Oversize" now has two distinct bounds, not an arbitrary 8 KiB charter cap.
  // First the boot read's DoS guard: the capture ceiling, refused by byte
  // count, never buffered whole and never truncated.
  const fileBoundPath = join(home, 'over-file-bound.txt');
  await writeFile(fileBoundPath, 'x'.repeat(MAX_CAPTURE_BYTES + 1));
  expect(await runHostOnce('start', {
    charterFile: fileBoundPath, expectRefusal: true,
  })).toBe(2);
  let error = logged(log).filter((entry) => entry['event'] === 'host/error').at(-1);
  expect(error).toMatchObject({ event: 'host/error', error: 'HostConfigError' });
  expect(String(error?.['message'])).toBe(
    `the charter file is over ${MAX_CAPTURE_BYTES} bytes; the limit is ${MAX_CAPTURE_BYTES}`);

  // Second the derived identity budget at the START-composition seam: a file
  // under the DoS guard whose composed identity is past the bound is the same
  // intent (an oversized charter is refused) with the new bound. Under the
  // factory policy the budget collapses to the pinned floor.
  const overBudgetPath = join(home, 'over-budget.txt');
  const overBudgetText = 'x'.repeat(300 * 1024);
  await writeFile(overBudgetPath, overBudgetText);
  expect(await runHostOnce('start', {
    charterFile: overBudgetPath, expectRefusal: true,
  })).toBe(2);
  error = logged(log).filter((entry) => entry['event'] === 'host/error').at(-1);
  expect(error).toMatchObject({ event: 'host/error', error: 'HostConfigError' });
  const refusal = String(error?.['message']);
  expect(refusal).toContain('the sendability budget is');
  // The tail survives the operator log's 200-code-point bound: the bounded
  // sendability message renders un-truncated by construction.
  expect(refusal).toContain(`floored at ${IDENTITY_FLOOR})`);
  expect(refusal).not.toContain('the charter file is over');
  const overBudget = validateAgentConfig({
    ...defaultAgentConfig(), model: 'first-light-test', heading: 'First light.',
    charter: `${overBudgetText} You are node-0.`,
  });
  expect(identityBytes(overBudget)).toBeGreaterThanOrEqual(identityBudget(overBudget));
  expect(refusal).toContain(`the sendability budget is ${identityBudget(overBudget)} bytes`);

  // The boot-recovery start (node/boot journaled, no config) still composes a
  // charter — and both the exact 8192-byte FILE boundary and a 100 KiB file
  // are accepted: each sits below the pinned IDENTITY_FLOOR, the factory
  // budget, so the only remaining identity bound is the derived budget.
  await seedBootOnly(home);
  const exactPath = join(home, 'exact.txt');
  await writeFile(exactPath, 'x'.repeat(8192));
  expect(await runHostOnce('start', { charterFile: exactPath })).toBe(0);
  let events = await readC13(home, 'node-0');
  let seeded = events.filter((e) => e.type === 'system/message')[0]!.data as
    { value: { value: AgentConfig } };
  expect(seeded.value.value.charter).toBe('x'.repeat(8192) + ' You are node-0.');
  expect(identityBytes(seeded.value.value)).toBeLessThan(IDENTITY_FLOOR);

  await resetHome();
  await seedBootOnly(home);
  const midPath = join(home, 'mid.txt');
  const midText = 'x'.repeat(100 * 1024);
  await writeFile(midPath, midText);
  expect(await runHostOnce('start', { charterFile: midPath })).toBe(0);
  events = await readC13(home, 'node-0');
  seeded = events.filter((e) => e.type === 'system/message')[0]!.data as
    { value: { value: AgentConfig } };
  expect(seeded.value.value.charter).toBe(`${midText} You are node-0.`);
  expect(identityBytes(seeded.value.value)).toBeLessThan(IDENTITY_FLOOR);
}, 240_000);

/**
 * The nominal anti-wedge proof (plan §0.5 / §7 S5): under a shrunk policy in
 * the uncapped band — the two constraints solved together, `W ≤ C −
 * IDENTITY_FLOOR` and `budget > IDENTITY_FLOOR + overhead` — an identity above
 * the floor and strictly below the budget, with a sealed control-laden history
 * at the reserve's history component, still composes and sends plans. The
 * fixture pins `I + H + O < C` (the binding ceiling min(MAX_CAPTURE_BYTES,
 * maxRequestBytes)) and the premise `planBytes ≥ wireBytes`; the plan-ceiling
 * check against MAX_CAPTURE_BYTES stays a separate assertion. The history is
 * seeded as exactly `keepRecentGroups` dialogue groups at the policy caps, so
 * the compaction span is eligible-empty and no compaction fires before the
 * measured request — while the caps branch (not `compactAfterBytes`) sizes the
 * reserve's history term.
 */
it('sends the boundary plan under a shrunk policy and a sealed control-laden history', async () => {
  const patch: Partial<AgentConfig['policy']> = {
    compactAfterBytes: 64 * 1024,
    keepRecentGroups: 8,
    maxCallsPerResponse: 1,
    maxToolResultBytes: 32768,
    maxAssistantBytes: 32768,
  };
  const { config, ceiling } = shrunkBoundaryConfig(patch, CAPS_IDENTITY_FILL);
  const identity = identityBytes(config);
  const budget = identityBudget(config, BOUNDARY_CATALOG);
  const reserved = reserve(config, BOUNDARY_CATALOG);
  expect(ceiling).toBe(Math.min(MAX_CAPTURE_BYTES, config.policy.maxRequestBytes));
  expect(effectiveCeiling(config)).toBe(ceiling);
  // The uncapped band, with both constraints solved together: the reserve
  // leaves the floor's room (W ≤ C − IDENTITY_FLOOR), so the budget follows
  // C − W and is the identity plus the headroom — above the floor and above
  // the identity by more than the plan's actual metadata overhead.
  expect(reserved).toBeLessThanOrEqual(ceiling - IDENTITY_FLOOR);
  expect(budget).toBe(ceiling - reserved);
  expect(budget).toBe(identity + BOUNDARY_HEADROOM);
  expect(budget).toBeGreaterThan(IDENTITY_FLOOR);
  expect(identity).toBeGreaterThan(IDENTITY_FLOOR);
  // The same identity under the factory policy collapses to the floor and is
  // refused — the concern the shrunk policy exists to solve.
  const factory = validateAgentConfig({ ...config, policy: defaultAgentConfig().policy });
  expect(identityBudget(factory)).toBe(IDENTITY_FLOOR);
  expect(() => assertSendableIdentity(factory)).toThrow(/sendability budget/);
  // The boundary refusal is adjacent: an identity exactly AT the budget is
  // refused by the helper, and the START seam refuses it with that same
  // bounded message.
  const adjacent = validateAgentConfig({
    ...config,
    charter: 'c'.repeat(CAPS_IDENTITY_FILL + (budget - identity)) + ' You are node-0.',
  });
  expect(identityBytes(adjacent)).toBe(budget);
  let adjacentMessage = '';
  try {
    assertSendableIdentity(adjacent, BOUNDARY_CATALOG);
  } catch (err) {
    adjacentMessage = (err as Error).message;
  }
  expect(adjacentMessage).toContain('the sendability budget is');
  expect(adjacentMessage).toContain(`floored at ${IDENTITY_FLOOR})`);

  // The one hanging request is the start's (it journals the config and parks
  // without a committed idle dialogue); the resume's first request is the
  // measured boundary.
  const srv = await serve(
    (_request, index) => (index === 0 ? new Promise<ReplyBody>(() => {}) : idleReply),
    BOUNDARY_CATALOG,
  );
  // The seam runs AFTER the provider load: the declared catalog feeds the
  // reserve's substrate term, so a seam that ran before it would compute a
  // larger budget and admit this identity. A refusal is a config refusal
  // (exit 2) before any composition.
  const refused = track(startHost(opts, {
    ...hostDeps, readInitialConfig: async () => adjacent,
  }));
  expect(await refused.done).toBe(2);
  const refusal = logged(log).filter((entry) => entry['event'] === 'host/error').at(-1);
  expect(refusal).toMatchObject({ event: 'host/error', error: 'HostConfigError' });
  expect(String(refusal?.['message'])).toBe(adjacentMessage);
  expect(logged(log).some((entry) => entry['event'] === 'host/boot')).toBe(false);

  await resetHome();
  const groups = Array.from({ length: config.policy.keepRecentGroups }, (_, ordinal) =>
    dialogueGroup(ordinal, config.policy.maxAssistantBytes, config.policy.maxToolResultBytes));
  const run = await measureBoundary(srv, config, groups);
  const { fold, plan, planBytes, wireBytes, wireBody, seededH } = run;
  const component = historyComponent(config.policy);
  expect(component).toBe(config.policy.keepRecentGroups
    * (config.policy.maxCallsPerResponse * config.policy.maxToolResultBytes
      + config.policy.maxAssistantBytes) * ESCAPE_FACTOR);
  // The caps branch sizes the history term; the per-message envelope is slack
  // on top (the reserve's caps term is raw-content-based).
  expect(seededH).toBeGreaterThanOrEqual(component);
  expect(seededH - component).toBeLessThan(8 * 1024);

  const state = fold.snapshot();
  const liveConfig = state.config?.value;
  expect(liveConfig).toBeDefined();
  const committed = state.surface?.nodes.filter((node) => node.group.kind !== 'heading') ?? [];
  expect(committed.map((node) => node.group.kind)).toEqual(
    Array.from({ length: config.policy.keepRecentGroups }, () => 'dialogue'));
  // No compaction fired before the measured request: the history is above
  // compactAfterBytes (the trigger is real), but exactly keepRecentGroups
  // groups make the eligible span empty, and the assembled history is H.
  const all = await readC13(home, 'node-0');
  expect(all.some((event) => event.type === 'compaction/start'
    || event.type === 'compaction/summary')).toBe(false);
  const history = canonicalMessagesBytes(plan.history).length;
  expect(history).toBe(seededH);
  // O = planBytes − identity − actual history − offering − substrate −
  // direction (no direction is pinned): the plan's actual metadata overhead.
  const offering = canonicalBytes(plan.tools).length;
  const substrate = plan.substrate === undefined ? 0 : canonicalBytes(plan.substrate).length;
  const overhead = planBytes - identity - history - offering - substrate;
  const liveIdentity = identityBytes(liveConfig!);
  expect(liveIdentity).toBe(identity);
  const liveBudget = identityBudget(liveConfig!, BOUNDARY_CATALOG);
  expect(liveBudget).toBe(budget);
  expect(overhead).toBeLessThanOrEqual(PLAN_MARGIN);
  // The binding-ceiling inequality the fixture pins; the plan ceiling is the
  // separate assertion right after.
  expect(liveIdentity + history + overhead).toBeLessThan(ceiling);
  expect(liveIdentity).toBeLessThan(liveBudget - overhead);
  expect(planBytes).toBeLessThan(MAX_CAPTURE_BYTES);
  // The premise: the plan's canonical bytes dominate the wire's.
  expect(planBytes).toBeGreaterThanOrEqual(wireBytes);
  expect(wireBytes).toBeLessThanOrEqual(ceiling);
  // ...and the wire provably carries the seeded history: its body is at least
  // H bytes (a regression that dropped the seeded groups would leave only the
  // identity plus the fixed blocks), and the control-laden dialogue is present
  // in its exact escaped form.
  expect(wireBytes).toBeGreaterThanOrEqual(seededH);
  expect(wireBody).toContain('\\u0001');
}, 240_000);

/**
 * The compactAfterBytes-dominant variant (plan S5): a policy whose K sits under
 * `C − IDENTITY_FLOOR − PLAN_MARGIN − the other fixed terms` and exceeds the
 * caps term. The seeded history is just below K in canonical bytes and is
 * assembled verbatim — H < K already prevents compaction (the trigger check
 * precedes eligibility) — so the K branch of the history term is exercised,
 * not just the caps branch, and the plan still sends.
 */
it('sizes the reserve by compactAfterBytes and assembles a just-below-K history verbatim', async () => {
  const patch: Partial<AgentConfig['policy']> = {
    compactAfterBytes: 1 * 1024 * 1024,
    keepRecentGroups: 8,
    maxCallsPerResponse: 1,
    maxToolResultBytes: 256,
    maxAssistantBytes: 256,
  };
  const { config, ceiling } = shrunkBoundaryConfig(patch, K_IDENTITY_FILL);
  const identity = identityBytes(config);
  const budget = identityBudget(config, BOUNDARY_CATALOG);
  const reserved = reserve(config, BOUNDARY_CATALOG);
  const component = historyComponent(config.policy);
  const fixed = reserved - component - PLAN_MARGIN;
  // The K branch is exercised: K exceeds the caps term and the reserve's
  // history term is K. The plan's stated K bound holds: K sits under
  // C − IDENTITY_FLOOR − PLAN_MARGIN − the other fixed terms.
  expect(component).toBe(config.policy.compactAfterBytes);
  expect(config.policy.compactAfterBytes).toBeGreaterThan(
    config.policy.keepRecentGroups
    * (config.policy.maxCallsPerResponse * config.policy.maxToolResultBytes
      + config.policy.maxAssistantBytes) * ESCAPE_FACTOR);
  expect(config.policy.compactAfterBytes).toBeLessThanOrEqual(
    ceiling - IDENTITY_FLOOR - PLAN_MARGIN - fixed);
  expect(budget).toBe(ceiling - reserved);
  expect(budget).toBe(identity + BOUNDARY_HEADROOM);
  expect(identity).toBeGreaterThan(IDENTITY_FLOOR);

  const srv = await serve(
    (_request, index) => (index === 0 ? new Promise<ReplyBody>(() => {}) : idleReply),
    BOUNDARY_CATALOG,
  );
  const groups = sizedControlGroups(
    config.policy.compactAfterBytes - 512, config.policy.keepRecentGroups);
  const run = await measureBoundary(srv, config, groups);
  const { fold, plan, planBytes, wireBytes, wireBody, seededH } = run;
  // Just below K, and already below the trigger: the compaction span never
  // becomes eligible because selection stops at the threshold check.
  expect(seededH).toBeLessThan(config.policy.compactAfterBytes);
  expect(config.policy.compactAfterBytes - seededH).toBeLessThanOrEqual(1024);

  const state = fold.snapshot();
  const liveConfig = state.config?.value;
  expect(liveConfig).toBeDefined();
  const committed = state.surface?.nodes.filter((node) => node.group.kind !== 'heading') ?? [];
  expect(committed.map((node) => node.group.kind)).toEqual(
    Array.from({ length: config.policy.keepRecentGroups }, () => 'dialogue'));
  const all = await readC13(home, 'node-0');
  expect(all.some((event) => event.type === 'compaction/start'
    || event.type === 'compaction/summary')).toBe(false);
  const history = canonicalMessagesBytes(plan.history).length;
  expect(history).toBe(seededH);
  const offering = canonicalBytes(plan.tools).length;
  const substrate = plan.substrate === undefined ? 0 : canonicalBytes(plan.substrate).length;
  const overhead = planBytes - identity - history - offering - substrate;
  const liveIdentity = identityBytes(liveConfig!);
  const liveBudget = identityBudget(liveConfig!, BOUNDARY_CATALOG);
  expect(liveIdentity).toBe(identity);
  expect(liveBudget).toBe(budget);
  expect(overhead).toBeLessThanOrEqual(PLAN_MARGIN);
  expect(liveIdentity + history + overhead).toBeLessThan(ceiling);
  expect(liveIdentity).toBeLessThan(liveBudget - overhead);
  expect(planBytes).toBeLessThan(MAX_CAPTURE_BYTES);
  expect(planBytes).toBeGreaterThanOrEqual(wireBytes);
  expect(wireBytes).toBeLessThanOrEqual(ceiling);
  // The wire carries the seeded history, not just the identity: at least H
  // body bytes and the exact six-byte U+0001 escape the seed wrote.
  expect(wireBytes).toBeGreaterThanOrEqual(seededH);
  expect(wireBody).toContain('\\u0001');
}, 240_000);

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

it('replays an old-rules configuration whose identity exceeds the derived budget', async () => {
  const server = await serve();
  // Legal when it was written: the model was a free string and no identity
  // budget existed (a start composed it from the flags). The budget is
  // admission-only — `validateAgentConfig` is untouched — so the old log still
  // folds and boots, and resume never resurrects or refuses the identity.
  const legacy = validateAgentConfig({
    ...defaultAgentConfig(),
    model: 'first-light-test'.padEnd(300_000, '-'),
    heading: 'Legacy heading.',
    charter: 'the old charter You are node-0.',
  });
  expect(identityBytes(legacy)).toBeGreaterThan(identityBudget(legacy));
  await seedConfig(legacy);
  expect(await runHostOnce('resume', {})).toBe(0);
  const events = await readC13(home, 'node-0');
  // No second configuration was journaled: the fold replay stands.
  expect(events.filter((e) => e.type === 'system/message')).toHaveLength(1);
  // The resumed node's first request carries the journaled model verbatim (the
  // host log's own line is bounded, so the wire is the honest witness).
  const wire = JSON.parse(server.requests[0]!.body.toString('utf8')) as { model: string };
  expect(wire.model).toBe(legacy.model);
  expect(logged(log).some((entry) => entry['event'] === 'host/boot')).toBe(true);
}, 20_000);

it('refuses a second host while the first runs, after the first has parked', async () => {
  await serve();
  const first = track(startHost(opts, hostDeps));
  await waitForLog(log, 'host/parked');
  const { model, heading, ...resumeOpts } = opts;
  const second = track(startHost({ ...resumeOpts, command: 'resume' }, hostDeps));
  // A live owner record is a configuration refusal (exit 2), and the bounded
  // message names the blocking pid/uid.
  expect(await second.done).toBe(2);
  const refused = logged(log).find((entry) => entry['event'] === 'host/error');
  expect(refused).toMatchObject({ event: 'host/error', error: 'HostAlreadyRunningError' });
  expect(String(refused?.['message'])).toMatch(/pid=\d+/);
  expect(String(refused?.['message'])).toMatch(/uid=node-0/);
  first.stop();
  expect(await first.done).toBe(0);
}, 20_000);

it('refuses the real legacy shape (world/.git, no world.git) as exit 2 with the migration message', async () => {
  await serve();
  // The documented legacy layout: the git dir lives inside the world and the
  // external world.git is absent. The layout gate runs before WorldRepo.open,
  // so it must recognize the shape itself and never send the operator to
  // `init` (which would advise removing the recorded world).
  await rm(join(home, 'world.git'), { recursive: true, force: true });
  execFileSync('git', ['-C', join(home, 'world'), 'init', '-q'], { stdio: 'ignore' });
  expect(await runHostOnce('start', { expectRefusal: true })).toBe(2);
  const refused = logged(log).find((entry) => entry['event'] === 'host/error');
  expect(refused).toMatchObject({ event: 'host/error', error: 'WorldNotARepoError' });
  expect(String(refused?.['message'])).toMatch(/migrated/);
  // The world is untouched: the refusal is a recipe, not a removal.
  expect((await lstat(join(home, 'world'))).isDirectory()).toBe(true);
}, 20_000);

it('refuses a both-present mistrusted world as exit 2 with the migration message', async () => {
  await serve();
  // Both world paths exist (so the layout check passes) but the external git
  // dir is not a repository: `WorldRepo.open` refuses with the typed migration
  // note. That is a configuration refusal, not a runtime failure.
  await rm(join(home, 'world.git'), { recursive: true, force: true });
  await mkdir(join(home, 'world.git'));
  expect(await runHostOnce('start', { expectRefusal: true })).toBe(2);
  const refused = logged(log).find((entry) => entry['event'] === 'host/error');
  expect(refused).toMatchObject({ event: 'host/error', error: 'WorldNotARepoError' });
  expect(String(refused?.['message'])).toMatch(/migrated/);
}, 20_000);

it('boots with a bounded world/doctor-failed diagnostic when the doctor throws', async () => {
  await serve();
  const h = track(startHost(opts, {
    ...hostDeps,
    doctorRunner: async () => { throw new Error('injected doctor failure'); },
  }));
  await waitForLog(log, 'host/parked');
  expect(logged(log)).toContainEqual(
    expect.objectContaining({ event: 'world/doctor-failed', reason: 'Error' }),
  );
  // The failure never refuses the boot: the host reaches its park.
  expect(logged(log).map((entry) => entry['event'])).toContain('host/boot');
  h.stop();
  expect(await h.done).toBe(0);
}, 20_000);

it('acquires the owner before the config fold, so a pause targets a booting host', async () => {
  await serve();
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let release!: (config: AgentConfig) => void;
  const held = new Promise<AgentConfig>((resolve) => { release = resolve; });
  const h = track(startHost(opts, {
    ...hostDeps,
    readInitialConfig: async () => {
      entered();
      return held;
    },
  }));
  await enteredPromise;
  // The boot is still inside the fold, but the owner record already exists: a
  // pause issued now finds a target instead of answering "no host" and letting
  // the host boot anyway.
  expect((await readOwner(home)).kind).toBe('live');
  const signalled: number[] = [];
  const outcome = await requestPause(home, {
    timeoutMs: 50, intervalMs: 10,
    // The host is this test process; never really signal it.
    deps: { kill: (pid) => { signalled.push(pid); } },
  });
  expect(signalled).toHaveLength(1);
  expect(outcome.kind).toBe('still-stopping');
  release(existingConfig);
  h.stop();
  expect(await h.done).toBe(0);
}, 20_000);

it('reclaims a stale owner whose pid was reaped', async () => {
  await serve();
  const dead = await reapedPid();
  await writeOwner(home, { pid: dead, startTime: 1 });
  const h = track(startHost(opts, hostDeps));
  await waitForLog(log, 'host/parked');
  expect(logged(log)).toContainEqual(
    expect.objectContaining({
      event: 'host/boot', sandbox: 'off', launch: 'direct',
      limits: 'unavailable', reap: 'direct', fence: 'unavailable',
    }),
  );
  const live = await readOwner(home);
  expect(live.kind).toBe('live');
  if (live.kind === 'live') {
    expect(live.record.pid).not.toBe(dead);
    expect(live.record.sandbox).toBe('off');
    expect(live.record.fence).toBe('unavailable');
  }
  expect((await readdir(home)).filter((name) => name.startsWith('.host.'))).toEqual([]);
  h.stop();
  expect(await h.done).toBe(0);
  expect((await readOwner(home)).kind).toBe('absent');
}, 20_000);

it('records the launched Landlock mode in the owner record', async () => {
  await serve();
  const h = track(startHost({ ...opts, sandbox: {} }, hostDeps));
  await waitForLog(log, 'host/parked');
  const live = await readOwner(home);
  expect(live.kind).toBe('live');
  if (live.kind === 'live') expect(live.record.sandbox).toBe('landlock');
  h.stop();
  expect(await h.done).toBe(0);
}, 20_000);

// C2: an unfenced host is a durable, operator-visible fact. With the cgroup
// attach degraded (the stub), the cell has no fence port; the boot line, the
// owner record and `status` all carry `fence=unavailable`, and no successful
// commit can clear it. The record is annotated after the attach, so `status`
// reads it while the host is live.
it('records an unavailable fence in the owner record, boot line and status', async () => {
  await serve();
  const h = track(startHost({ ...opts, sandbox: {} }, hostDeps));
  await waitForLog(log, 'host/parked');
  expect(logged(log)).toContainEqual(
    expect.objectContaining({ event: 'host/boot', fence: 'unavailable', limits: 'unavailable' }),
  );
  const live = await readOwner(home);
  expect(live.kind).toBe('live');
  if (live.kind === 'live') {
    expect(live.record.fence).toBe('unavailable');
    expect(live.record.fenceReason).toBe('no-cell-cgroup');
  }
  const report = await readStatus(home);
  expect(report.host).toMatchObject({ state: 'running', fence: 'unavailable' });
  expect(formatStatus(report)).toContain('fence=unavailable');
  h.stop();
  expect(await h.done).toBe(0);
  expect((await readOwner(home)).kind).toBe('absent');
}, 20_000);

it('reports a boot leaf it could not thaw on host/degraded', async () => {
  await serve();
  const root = await mkdtemp(join(tmpdir(), 'es-boot-stuck-'));
  const stuck = join(root, 'node-stuck');
  await mkdir(stuck);
  await writeFile(join(stuck, 'keep'), 'x');
  try {
    const h = track(startHost({ ...opts, sandbox: {} }, {
      ...hostDeps,
      attachToCell: async () => ({ ok: true as const, root, limits: false }),
    }));
    await waitForLog(log, 'host/parked');
    expect(logged(log)).toContainEqual(expect.objectContaining({
      event: 'host/degraded',
      reason: expect.stringContaining('boot-thaw-failed: node-stuck'),
    }));
    h.stop();
    expect(await h.done).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it('reports an unreadable cell-root listing as boot-hygiene-failed, not "no leaves"', async () => {
  await serve();
  const root = await mkdtemp(join(tmpdir(), 'es-boot-hygiene-'));
  try {
    // The seam makes the branch reachable without a real cgroup tree: the
    // listing fails with EACCES, so booting silently over the unknown leaves
    // would skip thaw/kill entirely. The diagnostic is bounded and carries the
    // errno, never a path.
    const h = track(startHost({ ...opts, sandbox: {} }, {
      ...hostDeps,
      attachToCell: async () => ({ ok: true as const, root, limits: false }),
      bootHygiene: async () => ({ reaped: 0, failed: [], listError: 'EACCES' }),
    }));
    await waitForLog(log, 'host/parked');
    expect(logged(log)).toContainEqual(expect.objectContaining({
      event: 'host/degraded',
      reason: expect.stringContaining('boot-hygiene-failed: EACCES'),
    }));
    h.stop();
    expect(await h.done).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it('a test-injected fence port makes the host fence-available', async () => {
  await serve();
  const fake = {
    acquire: async () => ({ fenced: true as const, leaves: 0 }),
    release: async () => {},
  };
  const h = track(startHost({ ...opts, sandbox: {} }, { ...hostDeps, fence: fake }));
  await waitForLog(log, 'host/parked');
  expect(logged(log)).toContainEqual(
    expect.objectContaining({ event: 'host/boot', fence: 'available' }),
  );
  const live = await readOwner(home);
  expect(live.kind).toBe('live');
  if (live.kind === 'live') {
    expect(live.record.fence).toBe('available');
    expect(live.record.fenceReason).toBeUndefined();
  }
  // An available fence adds no human field: the healthy line stays byte-identical.
  expect(formatStatus(await readStatus(home))).not.toContain('fence=');
  h.stop();
  expect(await h.done).toBe(0);
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
