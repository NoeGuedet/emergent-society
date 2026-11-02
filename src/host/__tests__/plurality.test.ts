import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import type { AgentConfig, LlmModel } from '../../context/contracts.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { ContextFold } from '../../context/fold.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { openFrontierJournal, readAttribution } from '../../frontier/index.js';
import { TEST_STORAGE } from '../../frontier/__tests__/helpers.js';
import { commitAs, gitIn, serveJson } from '../../node/__tests__/helpers.js';
import { HeadWatcher } from '../../node/watcher.js';
import { WorldRepo } from '../../node/world.js';
import { AUTHORED_IDENTITY_RE } from '../../node/identity.js';
import {
  composeCellSet, startHost,
  type CellSet, type HostDeps, type HostHandle, type HostOptions, type NodeCell,
} from '../host.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';

/**
 * A1/A3: several nodes on one home, and the flat pool they live in.
 *
 * One host process, one world, one frontier journal and its attribution
 * sidecar; one runtime, driver, local log, scratch leaf and cgroup leaf per
 * node. The solo path is unchanged; this suite proves the shared parts and the
 * per-node parts separately, and the spawn contract S1 arbitrated: the grant is
 * declared (a solo flag boot grants nobody), the composer sentence names the
 * requester, a node's end removes only that node, the home ceiling is the one
 * cap, and uid minting is monotonic and race-free.
 */

const dirs: string[] = [];
const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Reply = {
  readonly cmd?: string; readonly content?: string;
  readonly tool?: { readonly name: string; readonly args: unknown };
  /** Several tool calls in one response: they execute sequentially in one turn. */
  readonly tools?: readonly { readonly name: string; readonly args: unknown }[];
};

function toolCall(tool: { readonly name: string; readonly args: unknown }, id: string) {
  return {
    id, type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
  };
}

function message(reply: Reply): unknown {
  if (reply.tools !== undefined) {
    return {
      role: 'assistant', content: null,
      tool_calls: reply.tools.map((tool, index) => toolCall(tool, `e${index}`)),
    };
  }
  if (reply.tool !== undefined) {
    return { role: 'assistant', content: null, tool_calls: [toolCall(reply.tool, 'e0')] };
  }
  if (reply.cmd !== undefined) {
    return {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'e0', type: 'function',
        function: { name: 'execute', arguments: JSON.stringify({ cmd: reply.cmd }) },
      }],
    };
  }
  return { role: 'assistant', content: reply.content ?? 'idle' };
}

function respond(reply: Reply): { body: string } {
  return { body: JSON.stringify({ choices: [{ message: message(reply) }] }) };
}

function config(uid: string) {
  return validateAgentConfig({
    ...defaultAgentConfig(), model: 'first-light-test',
    heading: `${uid} holds.`, charter: `You are ${uid}.`,
  });
}

async function fixture(): Promise<{ home: string; world: WorldRepo; seed: string }> {
  const home = await mkdtemp(join(tmpdir(), 'es-plurality-'));
  dirs.push(home);
  const world = await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  const seed = await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  return { home, world, seed };
}

/** A cell home ready for a host: world pair, the human seed, providers written by the caller. */
async function initFixture(): Promise<{ home: string; world: WorldRepo }> {
  const home = await mkdtemp(join(tmpdir(), 'es-spawn-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  return { home, world };
}

/** A windowed declaration: a fresh START on any named model needs one (A3). */
const catalog = (...modelIds: readonly string[]): readonly LlmModel[] =>
  modelIds.map((id) => ({ id, contextTokens: 200_000, maxOutputTokens: 32_000 }));

async function providers(
  home: string, url: string, models?: readonly LlmModel[],
): Promise<void> {
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: {
      key: 'k', endpoint: `${url}/v1/chat/completions`,
      ...(models !== undefined ? { models } : {}),
    },
  }), { encoding: 'utf8', mode: 0o600 });
}

async function writeNodes(
  home: string, entries: readonly Record<string, unknown>[],
): Promise<string> {
  const path = join(home, 'nodes.json');
  await writeFile(path, JSON.stringify(entries), 'utf8');
  return path;
}

function boot(home: string, opts: {
  readonly lines: string[];
  readonly nodesFile?: string;
  readonly charterFile?: string;
  readonly deps?: HostDeps;
}): HostHandle {
  const options: HostOptions = {
    home, uid: 'node-0', command: 'start', sandbox: false,
    ...(opts.nodesFile !== undefined
      ? { nodesFile: opts.nodesFile }
      : { model: 'first-light-test', heading: 'Lead.' }),
    ...(opts.charterFile !== undefined ? { charterFile: opts.charterFile } : {}),
    log: createHostLog((line) => opts.lines.push(line)),
  };
  return startHost(options, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
    ...opts.deps,
  });
}

type HostEvent = {
  readonly event: string;
  readonly uid?: string; readonly reason?: string; readonly requester?: string;
  readonly error?: string;
};

function hostEvents(lines: readonly string[]): HostEvent[] {
  return lines.map((line) => JSON.parse(line) as HostEvent);
}

async function localEvents(home: string, uid: string) {
  return loadVerifiedEvents(home, uid, C13_EVENT_TYPES);
}

async function resultTexts(home: string, uid: string): Promise<string[]> {
  const events = await localEvents(home, uid);
  return events
    .filter((event) => event.type === 'tool/result')
    .map((event) => (event.data as { readonly message?: { readonly content?: string } })
      .message?.content ?? '');
}

async function foldedConfig(home: string, uid: string): Promise<AgentConfig | null> {
  const fold = new ContextFold();
  await fold.observe(await localEvents(home, uid));
  return fold.snapshot().config?.value ?? null;
}

it('runs two live nodes on one world and one frontier, each with its own log', async () => {
  const { home, world } = await fixture();
  // One scripted model for both nodes: each node's first request writes its
  // own file, its second request parks the turn.
  const replies = new Map<string, number>();
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    const uid = body.includes('You are node-1.') ? 'node-1' : 'node-0';
    const count = replies.get(uid) ?? 0;
    replies.set(uid, count + 1);
    return respond(count === 0 ? { cmd: `printf 'x\\n' > f-${uid}.txt` } : { content: 'idle' });
  });
  servers.push(server);

  const set: CellSet = await composeCellSet({
    home,
    nodes: [{ uid: 'node-0', config: config('node-0') },
      { uid: 'node-1', config: config('node-1') }],
    credential: { endpoint: `${server.url}/v1/chat/completions`, key: 'k', credentialId: 'llm' },
    providers: {}, sandbox: false, pollMs: 0, log: createHostLog(() => {}),
    storage: TEST_STORAGE,
  });
  expect(set.nodes.map((node) => node.uid)).toEqual(['node-0', 'node-1']);

  // Both nodes are composed and live (both local writers open, one shared
  // frontier) before either turn starts. node-0's turn commits f-node-0;
  // node-1's turn then writes and commits f-node-1, so no commit is lost and
  // the two carriers are distinct authors.
  const run0 = set.nodes[0]!.driver.run();
  void run0.catch(() => {});
  await vi.waitFor(() => expect(set.nodes[0]!.driver.state).toBe('waiting'), { timeout: 20_000 });
  const run1 = set.nodes[1]!.driver.run();
  void run1.catch(() => {});
  await vi.waitFor(() => expect(set.nodes[1]!.driver.state).toBe('waiting'), { timeout: 20_000 });
  for (const node of set.nodes) node.driver.stop('stop-requested');
  await Promise.all([run0, run1]);
  await set.close();

  // Two turn commits on top of the human seed, each authored by its node.
  const log = (await gitIn(world, ['log', '--format=%an%x00%s'])).trim().split('\n');
  const turns = log.filter((line) => line.split('\0')[1]?.startsWith('turn '));
  expect(turns).toHaveLength(2);
  expect(turns.map((line) => line.split('\0')[0]).sort()).toEqual(['node-0', 'node-1']);
  expect(turns.every((line) => line.split('\0')[1] === 'turn 0')).toBe(true);
  expect(await gitIn(world, ['show', '--format=', '--name-only', 'HEAD']))
    .toContain('f-node-1.txt');

  // One frontier, and the sidecar attributes every exchange to one of the two
  // nodes, in the chain's own order (the wake on a foreign commit may give
  // node-0 a second, idle turn, so the exact count is not asserted).
  const attribution = await readAttribution(home);
  const ids = attribution.map((record) => record.uid);
  expect(ids).toContain('node-0');
  expect(ids).toContain('node-1');
  expect(ids.every((uid) => uid === 'node-0' || uid === 'node-1')).toBe(true);

  // Each node has its own cold-start log, opened and booted exactly once.
  for (const uid of ['node-0', 'node-1']) {
    const events = await localEvents(home, uid);
    expect(events.filter((event) => event.type === 'node/boot')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn/end').length).toBeGreaterThan(0);
  }

  // The set released the one frontier: another opener takes it.
  const reopened = await openFrontierJournal(home, {
    worldHead: () => world.headHash(), now: Date.now, storage: TEST_STORAGE,
  });
  await reopened.close();
}, 40_000);

it('spawns through a declared grant, names the requester, and denies the ungranted child', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    // The kernel-composed identity sentence is how a scripted reply tells the
    // root from its child on one provider endpoint: the composer suffix names
    // the requester, never a bare "You are node-N.".
    const body = request.body.toString('utf8');
    const uid = body.includes('You are node-1, composed by node-0.') ? 'node-1' : 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (count > 0) return respond({ content: 'idle' });
    return uid === 'node-0'
      ? respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } })
      // A child gets no capability implicitly: it asks and is refused.
      : respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Grandchild.' } } });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(1);
  }, { timeout: 30_000 });
  // The child boots, is refused the capability it was never granted, and parks.
  await vi.waitFor(async () => {
    expect((await resultTexts(home, 'node-1')).some(
      (text) => text.includes('denied: this node was not granted the spawn capability')))
      .toBe(true);
  }, { timeout: 30_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  const spawned = hostEvents(lines).find((event) => event.event === 'host/spawned');
  expect(spawned).toMatchObject({ requester: 'node-0', uid: 'node-1' });
  // The child's identity names its composer; the child is a peer in the home,
  // not a custodied descendant.
  const child = await foldedConfig(home, 'node-1');
  expect(child?.charter.endsWith(' You are node-1, composed by node-0.')).toBe(true);
  // The root's result says the child outlives this node.
  const rootResults = await resultTexts(home, 'node-0');
  const spawnedResult = rootResults.find((text) => text.startsWith('spawned node-1'));
  expect(spawnedResult).toContain('keeps running when this node ends');
  // The child's local log: one boot, one shutdown, and the honest denial.
  const events = await localEvents(home, 'node-1');
  expect(events.filter((event) => event.type === 'node/boot')).toHaveLength(1);
  expect(events.some((event) => event.type === 'node/shutdown')).toBe(true);
  expect(hostEvents(lines).some(
    (event) => event.event === 'host/ended' && event.uid === 'node-1')).toBe(true);
  const attribution = await readAttribution(home);
  expect(attribution.some((record) => record.uid === 'node-1')).toBe(true);
}, 60_000);

it('refuses an out-of-catalog spawned model with the whole clamp-budgeted enumeration', async () => {
  const { home } = await initFixture();
  // Sixty-four declared models and one long, unserved requested id: the
  // refusal enumerates the catalog and must still render whole inside the
  // executor's `denied:` clamp — the tail pointer survives by construction.
  const declared = [
    'first-light-test',
    ...Array.from({ length: 63 }, (_, index) =>
      `served-vendor/model-${String(index + 1).padStart(2, '0')}`),
  ];
  expect(declared).toHaveLength(64);
  const requested = `not-served-${'x'.repeat(300)}`;
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    const count = counts.get('node-0') ?? 0;
    counts.set('node-0', count + 1);
    return respond(count === 0 && body.includes('You are node-0')
      ? { tool: { name: 'extend', args: { verb: 'spawn', model: requested, heading: 'Worker.' } } }
      : { content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url, catalog(...declared));
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  const denials = async () => (await resultTexts(home, 'node-0'))
    .filter((text) => text.includes('is not served'));
  await vi.waitFor(async () => { expect(await denials()).toHaveLength(1); }, { timeout: 30_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  const denial = (await denials())[0]!;
  expect(denial.startsWith('denied: model "')).toBe(true);
  // `denied: ` plus one whole 200-code-point message: nothing was cut.
  expect([...denial].length).toBeLessThanOrEqual('denied: '.length + 200);
  expect(denial.endsWith(' (64 models total — inspect lists them)')).toBe(true);
  expect(denial).toContain('served-vendor/model-01');
  expect(denial).toContain(', …');
  // The refusal precedes every composition side effect: no child was composed,
  // no spawn was announced, and no child cell directory exists.
  expect(hostEvents(lines).some((event) => event.event === 'host/spawned')).toBe(false);
  expect(existsSync(join(home, 'nodes', 'node-1'))).toBe(false);
}, 60_000);

it('spawns an in-catalog model and the live child runs on it', async () => {
  const { home } = await initFixture();
  const declared = ['first-light-test', 'served-child-model'];
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    const uid = body.includes('You are node-1') ? 'node-1' : 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    // The root names a declared model; every later reply parks.
    return respond(uid === 'node-0' && count === 0
      ? { tool: { name: 'extend', args: { verb: 'spawn', model: 'served-child-model', heading: 'Worker.' } } }
      : { content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url, catalog(...declared));
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(1);
  }, { timeout: 30_000 });
  // The child is live: it boots and sends its own request, which names the
  // declared model and carries the same declared substrate block.
  const childRequest = async () => server.requests.find((request) =>
    request.body.toString('utf8').includes('You are node-1'));
  await vi.waitFor(async () => { expect(await childRequest()).toBeDefined(); }, { timeout: 30_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  expect(hostEvents(lines).find((event) => event.event === 'host/spawned'))
    .toMatchObject({ requester: 'node-0', uid: 'node-1' });
  const child = await foldedConfig(home, 'node-1');
  expect(child?.model).toBe('served-child-model');
  expect(child?.charter.endsWith(' You are node-1, composed by node-0.')).toBe(true);
  const events = await localEvents(home, 'node-1');
  expect(events.filter((event) => event.type === 'node/boot')).toHaveLength(1);
  expect(hostEvents(lines).some(
    (event) => event.event === 'host/ended' && event.uid === 'node-1')).toBe(true);
  const wire = JSON.parse((await childRequest())!.body.toString('utf8')) as {
    model: string; messages: Array<{ role: string; content: string }>;
  };
  expect(wire.model).toBe('served-child-model');
  expect(wire.messages[2]).toEqual({
    role: 'system',
    content: 'The substrate this kernel serves — models: first-light-test, served-child-model',
  });
}, 60_000);

it('refuses the seventeenth node at the home ceiling, the one roster cap', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    const uid = /You are (node-\d+), composed by node-0\./.exec(body)?.[1] ?? 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (uid === 'node-0') {
      // One spawn per root turn (even request), then a plain reply so the turn
      // closes and the child's commit can wake the root again.
      return respond(count % 2 === 0
        ? { tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } }
        : { content: 'idle' });
    }
    // Every child writes once (a commit that wakes the root), then parks.
    return respond(count === 0
      ? { cmd: `printf 'x\n' > f-${uid}.txt` }
      : { content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  const denied = async () => (await resultTexts(home, 'node-0'))
    .filter((text) => text.includes('this home already holds 16 nodes'));
  await vi.waitFor(async () => { expect(await denied()).toHaveLength(1); }, { timeout: 120_000 });
  handle.stop();
  expect(await handle.done).toBe(0);
  const root = await resultTexts(home, 'node-0');
  // Root + fifteen children = sixteen; the sixteenth spawn attempt is the one
  // refused, and only by the home's one ceiling.
  expect(root.filter((text) => text.startsWith('spawned node-'))).toHaveLength(15);
  expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(15);
}, 180_000);

it('transmits the capability only when the requester asks, and the grandchild is denied', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    const uid = body.includes('You are node-2, composed by node-1.') ? 'node-2'
      : body.includes('You are node-1, composed by node-0.') ? 'node-1' : 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (count > 0) return respond({ content: 'idle' });
    if (uid === 'node-0') {
      // The requester asks for the child to hold the same capability.
      return respond({
        tool: { name: 'extend', args: { verb: 'spawn', heading: 'Child.', spawn: true } },
      });
    }
    if (uid === 'node-1') {
      // The granted child spends it on a grandchild, without re-granting.
      return respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Grandchild.' } } });
    }
    return respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Denied.' } } });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(2);
  }, { timeout: 40_000 });
  await vi.waitFor(async () => {
    expect((await resultTexts(home, 'node-2')).some(
      (text) => text.includes('denied: this node was not granted the spawn capability')))
      .toBe(true);
  }, { timeout: 30_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  const spawned = hostEvents(lines).filter((event) => event.event === 'host/spawned');
  expect(spawned.map((event) => [event.requester, event.uid])).toEqual([
    ['node-0', 'node-1'],
    ['node-1', 'node-2'],
  ]);
  // The requester's result names the capability it passed on; the child's own
  // spawn of the grandchild asked for no grant, so its result does not.
  expect((await resultTexts(home, 'node-0')).some(
    (text) => text.startsWith('spawned node-1') && text.includes('spawn capability was passed on')))
    .toBe(true);
  expect((await resultTexts(home, 'node-1')).some(
    (text) => text.startsWith('spawned node-2') && text.includes('spawn capability was passed on')))
    .toBe(false);
  expect((await foldedConfig(home, 'node-2'))?.charter
    .endsWith(' You are node-2, composed by node-1.')).toBe(true);
}, 60_000);

it('mints through the uid grammar on a custom-uid boot', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    const uid = body.includes('You are node-1, composed by alice.') ? 'node-1' : 'alice';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (count > 0) return respond({ content: 'idle' });
    return uid === 'alice'
      ? respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } })
      : respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Denied.' } } });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'alice', model: 'first-light-test', heading: 'Alice.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(1);
  }, { timeout: 30_000 });
  await vi.waitFor(async () => {
    expect((await resultTexts(home, 'node-1')).some(
      (text) => text.includes('denied: this node was not granted the spawn capability')))
      .toBe(true);
  }, { timeout: 30_000 });
  handle.stop();
  expect(await handle.done).toBe(0);
  // The mint is max-known+1 over the pool, its reservations and the disk; the
  // composer sentence and the strip pattern run over the uid grammar, not a
  // hardcoded node-N form.
  expect(hostEvents(lines).find((event) => event.event === 'host/spawned'))
    .toMatchObject({ requester: 'alice', uid: 'node-1' });
  expect((await foldedConfig(home, 'node-1'))?.charter
    .endsWith(' You are node-1, composed by alice.')).toBe(true);
  expect((await foldedConfig(home, 'alice'))?.charter.endsWith(' You are alice.')).toBe(true);
  // The authored-strip pattern is built on the uid grammar (dots, dashes,
  // underscores included), so a world charter from another node cannot smuggle
  // a second sentence and an operator's own non-node-N uid still strips.
  expect('base You are a.b-c_9.'.replace(AUTHORED_IDENTITY_RE, '')).toBe('base');
  expect('base You are a.b-c_9, composed by x.y.'.replace(AUTHORED_IDENTITY_RE, '')).toBe('base');
  expect(' You are alice.'.replace(AUTHORED_IDENTITY_RE, '')).toBe('');
}, 60_000);

it('mints distinct uids for two simultaneous spawns and never repeats one', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    // Roots carry the plain boot sentence; children carry the composer suffix
    // and park after their first request.
    const uid = /You are (node-\d+)\./.exec(body)?.[1];
    if (uid === undefined) return respond({ content: 'idle' });
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    return count === 0
      ? respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Shared.' } } })
      : respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
    { uid: 'node-1', model: 'first-light-test', heading: 'Peer.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(2);
  }, { timeout: 60_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  const uids = hostEvents(lines)
    .filter((event) => event.event === 'host/spawned')
    .map((event) => event.uid);
  expect(new Set(uids).size).toBe(2);
  // The mint is max-known+1 over the pool and its reservations: the two
  // concurrent spawns take node-2 and node-3, never the same uid twice.
  expect([...uids].sort()).toEqual(['node-2', 'node-3']);
  // No seventeenth (or duplicate) node exists: every spawned child booted once.
  for (const uid of ['node-2', 'node-3']) {
    const events = await localEvents(home, uid);
    expect(events.filter((event) => event.type === 'node/boot')).toHaveLength(1);
    expect(events.some((event) => event.type === 'node/shutdown')).toBe(true);
  }
}, 90_000);

it('closes a child composed during a pause and answers with the honest denial', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const uid = request.body.toString('utf8').includes('You are node-1, composed by node-0.')
      ? 'node-1' : 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    return count === 0
      ? respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } })
      : respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  let signalComposing!: () => void;
  const composing = new Promise<void>((resolve) => { signalComposing = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handle = boot(home, {
    nodesFile, lines,
    deps: {
      composeChild: async (_options, compose) => {
        signalComposing();
        await gate;
        return compose();
      },
    },
  });
  await composing;
  handle.stop();
  release();
  expect(await handle.done).toBe(0);
  // No host/spawned: a composed-but-unrun child of a closing host is never
  // reported as spawned. Its local log settled through close(), and the
  // requester got the honest bounded denial.
  expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(0);
  const child = await localEvents(home, 'node-1');
  expect(child.filter((event) => event.type === 'node/boot')).toHaveLength(1);
  expect(child.some((event) => event.type === 'node/shutdown')).toBe(true);
  expect((await resultTexts(home, 'node-0'))).toContain('denied: the host is stopping');
  expect(hostEvents(lines).some((event) => event.event === 'host/stop')).toBe(true);
}, 60_000);

it('swallows a failing close of the mid-spawn child and still denies honestly', async () => {
  const { home } = await initFixture();
  const server = await serveJson((_request, index) => respond(index === 0
    ? { tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } }
    : { content: 'idle' }));
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  let signalComposing!: () => void;
  const composing = new Promise<void>((resolve) => { signalComposing = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handle = boot(home, {
    nodesFile, lines,
    deps: {
      composeChild: async () => {
        signalComposing();
        await gate;
        // A fresh cell whose close() rejects: the pool must log the bounded
        // diagnostic and still throw the bounded refusal, never a raw error.
        return {
          uid: 'node-1',
          close: async () => { throw new Error('close failed'); },
        } as unknown as NodeCell;
      },
    },
  });
  await composing;
  handle.stop();
  release();
  expect(await handle.done).toBe(0);
  expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(0);
  expect(hostEvents(lines).some((event) => event.event === 'host/degraded'
    && event.reason !== undefined && event.reason.includes('spawn-close-failed'))).toBe(true);
  expect((await resultTexts(home, 'node-0'))).toContain('denied: the host is stopping');
  expect(hostEvents(lines).some((event) => event.event === 'host/error')).toBe(false);
}, 60_000);

it('holds the reservation against the ceiling and releases it on a compose failure', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  // Node 0 spawns twice in one turn; node 1's spawn is held at the provider
  // until node 0's reservation is held, so the two are genuinely concurrent at
  // the ceiling check.
  let composing!: () => void;
  const composingSignal = new Promise<void>((resolve) => { composing = resolve; });
  const server = await serveJson(async (request) => {
    const body = request.body.toString('utf8');
    const uid = /You are (node-\d+)[.,]/.exec(body)?.[1];
    if (uid === undefined) return respond({ content: 'idle' });
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (count > 0) return respond({ content: 'idle' });
    if (uid === 'node-1') {
      await composingSignal;
      return respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Racing.' } } });
    }
    if (uid !== 'node-0') return respond({ content: 'idle' });
    // Two spawn calls in one turn: the first fails composition while its
    // reservation holds the home's last place; the second must be admitted
    // again after the release.
    return respond({
      tools: [
        { name: 'extend', args: { verb: 'spawn', heading: 'First.' } },
        { name: 'extend', args: { verb: 'spawn', heading: 'Second.' } },
      ],
    });
  });
  servers.push(server);
  await providers(home, server.url);
  // Fifteen booted nodes hold the roster and two of them hold the declared
  // grant: node 0's reservation is the sixteenth place, so node 1's concurrent
  // spawn must see 15 live + 1 reserved at the one ceiling.
  const nodesFile = await writeNodes(home, Array.from({ length: 15 }, (_value, index) => ({
    uid: `node-${index}`, model: 'first-light-test', heading: `Node ${index}.`,
    ...(index === 0 || index === 1 ? { spawn: true } : {}),
  })));
  const lines: string[] = [];
  let attempts = 0;
  let releaseSeam!: () => void;
  const seamGate = new Promise<void>((resolve) => { releaseSeam = resolve; });
  const handle = boot(home, {
    nodesFile, lines,
    deps: {
      composeChild: async (_options, compose) => {
        attempts += 1;
        if (attempts > 1) return compose();
        composing();
        // Hold the reservation while node 1's concurrent spawn reaches the
        // ceiling check; the seam gate is released only once that refusal is
        // durable in node 1's local log.
        await seamGate;
        throw new Error('compose failed');
      },
    },
  });
  await vi.waitFor(async () => {
    expect((await resultTexts(home, 'node-1')).some(
      (text) => text.includes('denied: this home already holds 16 nodes'))).toBe(true);
  }, { timeout: 60_000 });
  releaseSeam();
  await vi.waitFor(async () => {
    const results = await resultTexts(home, 'node-0');
    expect(results.some((text) => text.includes('denied: the child could not be composed')))
      .toBe(true);
    expect(results.some((text) => text.startsWith('spawned node-15'))).toBe(true);
  }, { timeout: 60_000 });
  handle.stop();
  expect(await handle.done).toBe(0);
  const spawned = hostEvents(lines).filter((event) => event.event === 'host/spawned');
  // The reserved uid and place were released: the next spawn was admitted and
  // re-minted the same node-N (mint is max-known+1 and nothing landed on disk).
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ requester: 'node-0', uid: 'node-15' });
  expect(hostEvents(lines).some((event) => event.event === 'host/degraded'
    && event.reason !== undefined && event.reason.startsWith('spawn-failed:'))).toBe(true);
  const child = await localEvents(home, 'node-15');
  expect(child.filter((event) => event.type === 'node/boot')).toHaveLength(1);
}, 120_000);

it('faults the host on a booted run rejection and still settles the sibling node', async () => {
  const { home } = await initFixture();
  const server = await serveJson(() => respond({ content: 'idle' }));
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.' },
    { uid: 'node-1', model: 'first-light-test', heading: 'Peer.' },
  ]);
  const lines: string[] = [];
  const handle = boot(home, {
    nodesFile, lines,
    deps: {
      composeSet: async (options) => {
        const set = await composeCellSet(options);
        const broken = {
          ...set.nodes[0]!,
          driver: {
            state: 'active',
            run: async (): Promise<void> => { throw new Error('boot fault'); },
            stop: (): void => {},
            shutdownReason: () => 'driver-error' as const,
          } as unknown as NodeCell['driver'],
        };
        return { ...set, nodes: [broken, set.nodes[1]!] };
      },
    },
  });
  expect(await handle.done).toBe(1);
  // The drain's rejection reaches the existing catch as the booted run's own
  // error — never a NodeStateError from the exit cleanup.
  const hostError = hostEvents(lines).find((event) => event.event === 'host/error');
  expect(hostError).toBeDefined();
  expect(hostError?.error).toBe('Error');
  expect(hostError?.error).not.toBe('NodeStateError');
  // The sibling booted cell is stopped and settled by the host's exit, never
  // left live behind a NodeStateError.
  const sibling = await localEvents(home, 'node-1');
  expect(sibling.filter((event) => event.type === 'node/boot')).toHaveLength(1);
  expect(sibling.some((event) => event.type === 'node/shutdown')).toBe(true);
  // The faulted node's own end is named like every removal.
  expect(hostEvents(lines).some((event) => event.event === 'host/ended'
    && event.uid === 'node-0' && event.reason === 'driver-error')).toBe(true);
}, 60_000);

it('ends only the composed node whose run rejects, keeping the host alive', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const uid = request.body.toString('utf8').includes('You are node-1, composed by node-0.')
      ? 'node-1' : 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    return count === 0
      ? respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } })
      : respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  let failChild!: () => void;
  const childFails = new Promise<void>((resolve) => { failChild = resolve; });
  const handle = boot(home, {
    nodesFile, lines,
    deps: {
      composeChild: async () => ({
        uid: 'node-1',
        close: async () => {},
        driver: {
          state: 'active',
          run: async (): Promise<void> => { await childFails; throw new Error('child fault'); },
          stop: (): void => {},
          shutdownReason: () => 'handler-error' as const,
        } as unknown as NodeCell['driver'],
      }) as unknown as NodeCell,
    },
  });
  await vi.waitFor(async () => {
    expect((await resultTexts(home, 'node-0')).some(
      (text) => text.startsWith('spawned node-1'))).toBe(true);
  }, { timeout: 30_000 });
  failChild();
  await vi.waitFor(() => {
    expect(hostEvents(lines).some(
      (event) => event.event === 'host/ended' && event.uid === 'node-1')).toBe(true);
  }, { timeout: 30_000 });
  expect(hostEvents(lines).find((event) => event.event === 'host/ended'))
    .toMatchObject({ uid: 'node-1', reason: 'handler-error' });
  // The host keeps running while the root is live: no exit, no host/error.
  expect(hostEvents(lines).some((event) => event.event === 'host/stop')).toBe(false);
  expect(hostEvents(lines).some((event) => event.event === 'host/error')).toBe(false);
  handle.stop();
  expect(await handle.done).toBe(0);
}, 60_000);

it('grants nobody on a solo flag boot: the honest spawn denial', async () => {
  const { home } = await initFixture();
  const server = await serveJson((_request, index) => respond(index === 0
    ? { tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } }
    : { content: 'idle' }));
  servers.push(server);
  await providers(home, server.url);
  const lines: string[] = [];
  const handle = boot(home, { lines });
  await vi.waitFor(async () => {
    expect((await resultTexts(home, 'node-0')).some(
      (text) => text.includes('denied: this node was not granted the spawn capability')))
      .toBe(true);
  }, { timeout: 30_000 });
  expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(0);
  handle.stop();
  expect(await handle.done).toBe(0);
}, 40_000);

it('strips an authored identity sentence at boot: the kernel owns the final sentence', async () => {
  const { home } = await initFixture();
  const bodies: string[] = [];
  const server = await serveJson((request) => {
    bodies.push(request.body.toString('utf8'));
    return respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const charterFile = join(home, 'charter.txt');
  await writeFile(charterFile, 'Hold the line. You are node-7.', 'utf8');
  const lines: string[] = [];
  const handle = boot(home, { charterFile, lines });
  await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 30_000 });
  const body = JSON.parse(bodies[0]!) as {
    readonly messages: readonly { readonly role: string; readonly content: string | null }[];
  };
  expect(body.messages[0]?.content).toBe('Hold the line. You are node-0.');
  expect(bodies[0]).not.toContain('node-7');
  handle.stop();
  expect(await handle.done).toBe(0);
}, 40_000);

it('refuses a malformed nodes file at the gate, with exit 2 and no owner record', async () => {
  const home = await mkdtemp(join(tmpdir(), 'es-plurality-bad-'));
  dirs.push(home);
  await initHome(home);
  const nodesFile = join(home, 'nodes.json');
  await writeFile(nodesFile, JSON.stringify([
    { uid: 'node-0', model: 'm', heading: 'h' },
    { uid: 'node-0', model: 'm', heading: 'h' },
  ]), 'utf8');
  const lines: string[] = [];
  const handle = startHost({
    home, uid: 'node-0', command: 'start', nodesFile, sandbox: false,
    log: createHostLog((line) => lines.push(line)),
  }, { installSignals: false, keepAlive: false });
  expect(await handle.done).toBe(2);
  const events = lines.map((line) => JSON.parse(line) as { readonly event: string });
  expect(events.map((event) => event.event)).toContain('host/error');
  expect(existsSync(join(home, 'host.json'))).toBe(false);
}, 20_000);

it('boots a declared node set through the host lifetime and stops it cleanly', async () => {
  const home = await mkdtemp(join(tmpdir(), 'es-plurality-host-'));
  dirs.push(home);
  await initHome(home);
  const server = await serveJson(() => respond({ content: 'idle' }));
  servers.push(server);
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: { key: 'k', endpoint: `${server.url}/v1/chat/completions` },
  }), { encoding: 'utf8', mode: 0o600 });
  const nodesFile = join(home, 'nodes.json');
  await writeFile(nodesFile, JSON.stringify([
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.' },
    { uid: 'node-1', model: 'first-light-test', heading: 'Worker.' },
  ]), 'utf8');
  const lines: string[] = [];
  const handle = startHost({
    home, uid: 'node-0', command: 'start', nodesFile, sandbox: false,
    log: createHostLog((line) => lines.push(line)),
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  });
  await vi.waitFor(() => {
    const ends = lines.filter((line) => (JSON.parse(line) as { event: string }).event === 'turn/end');
    expect(ends).toHaveLength(2);
  }, { timeout: 20_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  const events = lines.map((line) => JSON.parse(line) as {
    readonly event: string; readonly uid?: string;
  });
  expect(events.filter((event) => event.event === 'host/boot').map((event) => event.uid).sort())
    .toEqual(['node-0', 'node-1']);
  expect(events.filter((event) => event.event === 'host/stop')).toHaveLength(1);
  for (const uid of ['node-0', 'node-1']) {
    const local = await localEvents(home, uid);
    expect(local.filter((event) => event.type === 'node/boot')).toHaveLength(1);
  }
}, 40_000);
