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
import { composeCell, wrapHandler } from '../host.js';

/**
 * The composition root's acceptance: one cell, one real turn, and every
 * lifetime branch that can be taken without a live provider.
 *
 * The only network is a loopback fake provider; the shell is unconfined
 * (`sandbox: false`) in every case but the Landlock one, which is skipped when
 * the launcher is absent. Each case owns its temp home, its own world pair and
 * its own script, so no case can pass on another's journal.
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

/** Every journal this test opened; torn down before the home is removed. */
const journals: { close(): Promise<void> }[] = [];
let home = '';

afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => {});
  if (home !== '') {
    await rm(home, { recursive: true, force: true });
    home = '';
  }
});

/** This case's home, world pair and the human seed commit every case opens on. */
async function setup(): Promise<{ home: string; world: WorldRepo; seed: string }> {
  home = await mkdtemp(join(tmpdir(), 'es-host-'));
  const world = await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  const seed = await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  return { home, world, seed };
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
    const cell = await composeCell({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    expect(frontierLayout(home).dir).toBe(join(home, 'frontier'));
    const run = cell.driver.run();
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

it('close refuses while the cell is live and leaves both writers held', async () => {
  const { home } = await setup();
  const script: Reply[] = [{ cmd: "printf 'hi\\n' > first.txt" }, { content: 'done' }];
  const server = await serveJson((_req, i) => reply(script[i] ?? { content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  try {
    const cell = await composeCell({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    const run = cell.driver.run();
    await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
    await expect(cell.close()).rejects.toBeInstanceOf(NodeStateError);
    // Both writers are still held: the local one by the driver, the frontier one
    // by the cell. The rejection comes from the fresh open's lock acquisition.
    await expect(openFrontierJournal(home, { worldHead: async () => null, now: Date.now }))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    cell.driver.stop('stop-requested'); await run;
    await cell.close();
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
    const first = await composeCell({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    const firstRun = first.driver.run();
    await vi.waitFor(() => expect(first.driver.state).toBe('waiting'), { timeout: 10_000 });
    first.driver.stop('stop-requested'); await firstRun; await first.close();

    // A different model on the second compose must not replace the journaled one.
    const second = await composeCell({
      home, uid: 'node-0', config: { ...config, model: 'different-model' },
      credential, providers: {}, sandbox: false, pollMs: 0, log,
    });
    expect(second.config.model).toBe('first-light-test');
    const secondRun = second.driver.run();
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
    const cell = await composeCell({
      home, uid: 'node-0', config, credential, providers, sandbox: false, pollMs: 0, log,
    });
    expect(cell.webTools).toBe(true);
    const run = cell.driver.run();
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
    await expect(composeCell({
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
    await expect(composeCell({
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
  const { home } = await setup();
  const script: Reply[] = [{ cmd: "printf 'confined\\n' > confined.txt" }, { content: 'done' }];
  const server = await serveJson((_req, i) => reply(script[i] ?? { content: 'idle' }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: 'sentinel-llm-key', credentialId: 'llm' as const };
  try {
    const cell = await composeCell({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: {}, pollMs: 0, log,
    });
    const run = cell.driver.run();
    await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
    cell.driver.stop('stop-requested'); await run; await cell.close();
    expect(cell.runtime.sandboxStatus()).not.toBeNull();
    expect(cell.runtime.sandboxStatus()).toMatchObject({ mode: 'landlock' });
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
