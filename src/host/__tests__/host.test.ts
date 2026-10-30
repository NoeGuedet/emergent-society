import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { commitAs, gitIn, serveJson } from '../../node/__tests__/helpers.js';
import { HeadWatcher } from '../../node/watcher.js';
import { NodeStateError } from '../../node/errors.js';
import { WorldRepo } from '../../node/world.js';
import {
  JournalReader, JournalWriter, SessionAlreadyOwnedError, frontierLayout,
  type EventEnvelope,
} from '../../journal/index.js';
import {
  FRONTIER_EVENT_TYPES, FrontierValidationError, openFrontierJournal,
} from '../../frontier/index.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import type { BoundaryGate, TurnContext } from '../../node/index.js';
import { createHostLog } from '../observe.js';
import {
  composeCell, wrapHandler, type Cell, type CellOptions,
} from '../host.js';

/**
 * The composition root's acceptance: one cell, one real turn, and every
 * lifetime branch that can be taken without a live provider.
 *
 * The only network is a loopback fake provider; the shell is unconfined
 * (`sandbox: false`) in every case but the Landlock one, which is skipped when
 * the launcher is absent. Each case owns its temp home, its own world pair and
 * its own script, so no case can pass on another's journal.
 *
 * Teardown is written for a failing test as much as a passing one: every cell
 * this case composed is stopped, its driver run awaited and its frontier
 * closed in `afterEach`, and the home is removed only when all of that settled.
 * A cell whose run cannot settle therefore leaves its home in place for
 * inspection instead of having the directory deleted under a live writer.
 */

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const launcherBinary = join(projectRoot, 'native', 'es-landlock', 'es-landlock');
const launcherPresent = existsSync(launcherBinary);

const config = validateAgentConfig({
  ...defaultAgentConfig(), model: 'first-light-test', heading: 'First light.',
});

/** The scripted model's one reply: a content message, an `execute`, or one tool call. */
type Reply = { readonly content?: string; readonly cmd?: string;
  readonly tool?: { readonly name: string; readonly args: unknown } };
const toolCall = (name: string, args: unknown) => ({ role: 'assistant', content: null,
  tool_calls: [{ id: 'e0', type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] });
const message = (r: Reply) => r.tool !== undefined ? toolCall(r.tool.name, r.tool.args)
  : r.cmd !== undefined ? toolCall('execute', { cmd: r.cmd })
  : { role: 'assistant', content: r.content ?? 'idle' };
const reply = (r: Reply) => ({ body: JSON.stringify({ choices: [{ message: message(r) }] }) });

/** Every cell this case composed, in composition order. */
const cells: Cell[] = [];
/** Every driver run this case started, so teardown awaits the live one. */
const runs: Promise<void>[] = [];
/** Every second frontier journal this case opened; torn down before the home. */
const journals: { close(): Promise<void> }[] = [];
let home = '';

afterEach(async () => {
  const composed = cells.splice(0);
  for (const cell of composed) cell.driver.stop('stop-requested');
  let clean = true;
  for (const run of runs.splice(0)) {
    try {
      await run;
    } catch {
      clean = false;
    }
  }
  for (const cell of composed) {
    try {
      await cell.close();
    } catch {
      clean = false;
    }
  }
  for (const journal of journals.splice(0)) {
    try {
      await journal.close();
    } catch {
      clean = false;
    }
  }
  // Remove the home only once every writer released it: a failed teardown
  // leaves the journal behind for the failure to be inspected, never deletes a
  // live home out from under its writers.
  if (home !== '' && clean) await rm(home, { recursive: true, force: true });
  home = '';
});

/** This case's home, world pair and the human seed commit every case opens on. */
async function setup(): Promise<{ home: string; world: WorldRepo; seed: string }> {
  home = await mkdtemp(join(tmpdir(), 'es-host-'));
  const world = await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  const seed = await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  return { home, world, seed };
}

/** Composes through the real root and registers the cell for teardown. */
async function compose(options: CellOptions): Promise<Cell> {
  const cell = await composeCell(options);
  cells.push(cell);
  return cell;
}

/** Starts the driver's run and registers the promise for teardown. */
function start(cell: Cell): Promise<void> {
  const run = cell.driver.run();
  // A failure the test has not awaited yet must not surface as an unhandled
  // rejection; teardown still awaits (and sees) the original promise.
  void run.catch(() => {});
  runs.push(run);
  return run;
}

/** Opens a second frontier journal over this cell's home and tracks it for teardown. */
async function openFrontier(home: string): Promise<{ close(): Promise<void> }> {
  const journal = await openFrontierJournal(home, { worldHead: async () => null, now: Date.now });
  journals.push(journal);
  return journal;
}

async function readLocal(home: string): Promise<EventEnvelope[]> {
  const reader = await JournalReader.open(home, 'node-0', {
    knownTypes: C13_EVENT_TYPES, resolveBlobs: true,
  });
  const events: EventEnvelope[] = [];
  for await (const event of reader.events()) events.push(event);
  return events;
}

async function readFrontier(home: string): Promise<EventEnvelope[]> {
  const reader = await JournalReader.openIn(frontierLayout(home), {
    knownTypes: FRONTIER_EVENT_TYPES,
  });
  const events: EventEnvelope[] = [];
  for await (const event of reader.events()) events.push(event);
  return events;
}

type RequestData = { readonly url: string; readonly world_head: string | null;
  readonly credentials: readonly { readonly id: string; readonly where: string }[];
  readonly call: string };
type ResponseData = { readonly call: string; readonly status: number };

it('composes one cell and runs one real turn end to end', async () => {
  const { home, world, seed } = await setup();
  const script: Reply[] = [{ cmd: "printf 'hi\\n' > first.txt" }, { content: 'done' }];
  const server = await serveJson((_req, i) => reply(script[i] ?? { content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  try {
    const cell = await compose({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    expect(frontierLayout(home).dir).toBe(join(home, 'frontier'));
    const run = start(cell);
    await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
    cell.driver.stop('stop-requested'); await run; await cell.close();

    // The turn's own commit, authored by the node, in the external git dir.
    const commits = await world.commitsForTurn(seed, 'node-0', 0);
    expect(commits).toHaveLength(1);
    expect((await gitIn(world, ['log', '-1', '--format=%an%x00%s'])).trim())
      .toBe('node-0\0turn 0');
    expect(await readFile(join(world.path, 'first.txt'), 'utf8')).toBe('hi\n');

    // The local log: the boot, exactly one wakeup turn, and the shutdown.
    const events = await readLocal(home);
    const of = (type: string): EventEnvelope[] => events.filter((event) => event.type === type);
    const boots = of('node/boot');
    expect(boots).toHaveLength(1);
    expect(boots[0]!.data).toMatchObject({ reason: 'start' });
    // The world doctor ran in composition, before the frontier open, and its
    // report is the ignorable local fact written after node/boot.
    const doctors = of('world/doctor');
    expect(doctors).toHaveLength(1);
    expect(doctors[0]!.ignorable).toBe(true);
    expect(doctors[0]!.data).toMatchObject({
      report: { lock: 'free', index: { readable: true } },
    });
    expect(events.findIndex((event) => event.type === 'world/doctor'))
      .toBeGreaterThan(events.findIndex((event) => event.type === 'node/boot'));
    // The composed cell logs through `wrapHandler`: its turn boundaries reach
    // the injected sink, not process.stderr.
    const logged = lines.map((line) => JSON.parse(line) as { readonly event: string });
    expect(logged.map((entry) => entry.event)).toContain('turn/start');
    expect(logged.map((entry) => entry.event)).toContain('turn/end');
    const starts = of('turn/start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.data)
      .toMatchObject({ turn: 0, trigger: 'wakeup', world: { from: null, to: seed } });
    expect(of('world/perception')).toHaveLength(1);
    expect(of('assistant/message')).toHaveLength(2);
    expect(of('tool/call')).toHaveLength(1);
    expect(of('tool/result')).toHaveLength(1);
    const ends = of('turn/end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.data).toMatchObject({ turn: 0, outcome: 'waiting' });
    const commit = (ends[0]!.data as unknown as { readonly commit?: string }).commit;
    expect(typeof commit).toBe('string');
    expect(commit).not.toBe('');
    const shutdowns = of('node/shutdown');
    expect(shutdowns.at(-1)!.data).toMatchObject({ reason: 'stop-requested' });

    // The frontier: two request/response pairs, both naming the llm credential id.
    const frontier = await readFrontier(home);
    const requests = frontier.filter((event) => event.type === 'http/request')
      .map((event) => event.data as unknown as RequestData);
    const responses = frontier.filter((event) => event.type === 'http/response')
      .map((event) => event.data as unknown as ResponseData);
    expect(requests).toHaveLength(2);
    expect(responses).toHaveLength(2);
    for (const request of requests) {
      expect(request.credentials).toEqual([{ id: 'llm', where: 'authorization' }]);
      expect(request.url).toBe(`${server.url}/v1/chat/completions`);
    }
    expect(requests[0]!.world_head).toBe(seed);
    expect(responses.map((response) => response.call))
      .toEqual(requests.map((request) => request.call));

    expect(cell.webTools).toBe(false);
    expect(cell.config.model).toBe('first-light-test');

    // close() released the frontier lock: a fresh open succeeds, and a second
    // close is a no-op rather than a second shutdown.
    const reopened = await openFrontier(home);
    expect(reopened).toBeDefined();
    await expect(cell.close()).resolves.toBeUndefined();
  } finally {
    await server.close();
  }
}, 30_000);

it('close is concurrency-safe on a booting cell and runs the driver exactly once', async () => {
  const { home } = await setup();
  const server = await serveJson(() => reply({ content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  try {
    const cell = await compose({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    // Two concurrent closes share one in-flight outcome: the cell is stopped,
    // run and settled once, not twice.
    const outcomes = await Promise.allSettled([cell.close(), cell.close()]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(cell.driver.state).toBe('stopped');

    const events = await readLocal(home);
    expect(events.filter((event) => event.type === 'node/boot')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'node/shutdown')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(0);
    // No turn was ever opened, so no model request was made either.
    expect(server.requests).toEqual([]);
    // The frontier was released once, after the driver stopped.
    const reopened = await openFrontier(home);
    expect(reopened).toBeDefined();
    await expect(cell.close()).resolves.toBeUndefined();
  } finally {
    await server.close();
  }
}, 30_000);

it('close shares one rejection across concurrent callers and still closes after the stop', async () => {
  const { home } = await setup();
  const script: Reply[] = [{ cmd: "printf 'hi\\n' > first.txt" }, { content: 'done' }];
  const server = await serveJson((_req, i) => reply(script[i] ?? { content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  try {
    const cell = await compose({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    const run = start(cell);
    await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
    // Concurrent callers observe one refusal, not one each: the frontier is
    // still open and the driver is still live.
    const outcomes = await Promise.allSettled([cell.close(), cell.close()]);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(rejected).toHaveLength(2);
    expect(rejected.every((outcome) => outcome.reason instanceof NodeStateError)).toBe(true);
    expect(rejected[0]!.reason).toBe(rejected[1]!.reason);
    await expect(openFrontierJournal(home, { worldHead: async () => null, now: Date.now }))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError);

    // The refusal is not sticky: the same cell closes once the caller settles it.
    cell.driver.stop('stop-requested'); await run;
    await expect(cell.close()).resolves.toBeUndefined();
    const reopened = await openFrontier(home);
    expect(reopened).toBeDefined();
  } finally {
    await server.close();
  }
}, 30_000);

it('resumes on the journaled config and writes the system message exactly once', async () => {
  const { home } = await setup();
  const script: Reply[] = [
    { cmd: "printf 'hi\\n' > first.txt" }, { content: 'done' }, { content: 'idle' },
  ];
  const server = await serveJson((_req, i) => reply(script[i] ?? { content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  try {
    const first = await compose({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    const firstRun = start(first);
    await vi.waitFor(() => expect(first.driver.state).toBe('waiting'), { timeout: 10_000 });
    first.driver.stop('stop-requested'); await firstRun; await first.close();

    // A different model on the second compose must not replace the journaled one.
    const second = await compose({
      home, uid: 'node-0', config: { ...config, model: 'different-model' },
      credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    expect(second.config.model).toBe('first-light-test');
    const secondRun = start(second);
    await vi.waitFor(() => expect(second.driver.state).toBe('waiting'), { timeout: 10_000 });
    second.driver.stop('stop-requested'); await secondRun; await second.close();

    const events = await readLocal(home);
    const system = events.filter((event) => event.type === 'system/message');
    expect(system).toHaveLength(1);
    expect(system[0]!.data).toMatchObject({ version: 1 });
    const boots = events.filter((event) => event.type === 'node/boot');
    expect(boots.at(-1)!.data).toMatchObject({ reason: 'resume' });

    const frontier = await readFrontier(home);
    expect(frontier.filter((event) => event.type === 'http/request')).toHaveLength(3);
    expect(frontier.filter((event) => event.type === 'http/response')).toHaveLength(3);
  } finally {
    await server.close();
  }
}, 30_000);

it('offers web tools when the registry has a tavily entry, and journals the search', async () => {
  const { home } = await setup();
  const script: Reply[] = [
    { tool: { name: 'web_search', args: { query: 'emergent societies' } } },
    { content: 'done' },
  ];
  const server = await serveJson((request) => {
    if (request.url === '/search') return { body: JSON.stringify({ results: [] }) };
    return reply(script.shift() ?? { content: 'idle' });
  });
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  const providers = {
    tavily: {
      key: 'tvly-sentinel', baseUrl: server.url, timeoutMs: 5000, maxResults: 8,
      maxResponseBytes: 1048576,
    },
  };
  try {
    const cell = await compose({
      home, uid: 'node-0', config, credential, providers, sandbox: false, pollMs: 0, log,
    });
    expect(cell.webTools).toBe(true);
    const run = start(cell);
    await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
    cell.driver.stop('stop-requested'); await run; await cell.close();

    const frontier = await readFrontier(home);
    const search = frontier.filter((event) => event.type === 'http/request')
      .map((event) => event.data as unknown as RequestData)
      .find((request) => request.url === `${server.url}/search`);
    expect(search).toBeDefined();
    expect(search!.credentials).toEqual([{ id: 'tavily', where: 'authorization' }]);
    const searchResponse = frontier.filter((event) => event.type === 'http/response')
      .map((event) => event.data as unknown as ResponseData)
      .find((response) => response.call === search!.call);
    expect(searchResponse).toBeDefined();

    const results = (await readLocal(home)).filter((event) => event.type === 'tool/result')
      .map((event) => event.data as unknown as
        { readonly frontierCall: unknown; readonly raw: unknown });
    expect(results).toHaveLength(1);
    expect(results[0]!.frontierCall).not.toBeNull();
    expect(results[0]!.raw).toBeNull();
  } finally {
    await server.close();
  }
}, 30_000);

it('releases the frontier when the transport refuses the endpoint before a driver exists', async () => {
  const { home } = await setup();
  const server = await serveJson(() => reply({ content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: 'http://example.test/v1/chat/completions',
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  try {
    await expect(compose({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    })).rejects.toBeInstanceOf(FrontierValidationError);
    const reopened = await openFrontier(home);
    expect(reopened).toBeDefined();
  } finally {
    await server.close();
  }
}, 30_000);

it('releases the frontier when the local writer is already owned', async () => {
  const { home } = await setup();
  const server = await serveJson(() => reply({ content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  const writer = await JournalWriter.open(home, 'node-0', {});
  try {
    await expect(compose({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    })).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    const reopened = await openFrontier(home);
    expect(reopened).toBeDefined();
  } finally {
    await writer.close();
    await server.close();
  }
}, 30_000);

it.skipIf(!launcherPresent)('runs the first turn under Landlock', async () => {
  const { home, world } = await setup();
  const script: Reply[] = [{ cmd: "printf 'confined\\n' > confined.txt" }, { content: 'done' }];
  const server = await serveJson((_req, i) => reply(script[i] ?? { content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  try {
    const cell = await compose({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: {}, pollMs: 0, log,
    });
    const run = start(cell);
    await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
    cell.driver.stop('stop-requested'); await run; await cell.close();
    expect(cell.runtime.sandboxStatus()).not.toBeNull();
    expect(cell.runtime.sandboxStatus()).toMatchObject({ mode: 'landlock' });

    // The confined shell did the work: the command succeeded, the file holds
    // what it wrote, and the result the model saw is a success, not a denial.
    expect(await readFile(join(world.path, 'confined.txt'), 'utf8')).toBe('confined\n');
    const results = (await readLocal(home)).filter((event) => event.type === 'tool/result')
      .map((event) => event.data as unknown as
        { readonly isError: boolean; readonly message: { readonly content: string } });
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
    expect(results[0]!.message.content).toContain('exit: 0');
  } finally {
    await server.close();
  }
}, 30_000);

it('wrapHandler logs a throw as turn/error and rethrows it unchanged', async () => {
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const ctx: TurnContext = { turn: 0, trigger: 'boot', world: { from: null, to: null },
    gate: {} as BoundaryGate, signal: new AbortController().signal, now: () => 0 };
  const failure = new Error('boom');
  const wrapped = wrapHandler(() => { throw failure; }, log);
  await expect(wrapped(ctx)).rejects.toBe(failure);
  expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'turn/start', turn: 0, trigger: 'boot' });
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ event: 'turn/error', turn: 0, error: 'Error' });
}, 30_000);

it('wrapHandler logs a recoverable result as turn/end with its error code and status', async () => {
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const ctx: TurnContext = { turn: 0, trigger: 'boot', world: { from: null, to: null },
    gate: {} as BoundaryGate, signal: new AbortController().signal, now: () => 0 };
  const result = { outcome: 'error', toolCalls: false,
    error: { code: 'http', status: 401 } } as const;
  const wrapped = wrapHandler(() => result, log);
  await expect(wrapped(ctx)).resolves.toBe(result);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({
    event: 'turn/end', turn: 0, outcome: 'error', toolCalls: false,
    errorCode: 'http', errorStatus: 401,
  });
}, 30_000);
