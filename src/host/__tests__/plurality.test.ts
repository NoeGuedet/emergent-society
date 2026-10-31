import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { openFrontierJournal, readAttribution } from '../../frontier/index.js';
import { TEST_STORAGE } from '../../frontier/__tests__/helpers.js';
import { commitAs, gitIn, serveJson } from '../../node/__tests__/helpers.js';
import { HeadWatcher } from '../../node/watcher.js';
import { WorldRepo } from '../../node/world.js';
import { composeCellSet, startHost, type CellSet } from '../host.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';

/**
 * A1: several nodes on one home.
 *
 * One host process, one world, one frontier journal and its attribution
 * sidecar; one runtime, driver, local log, scratch leaf and cgroup leaf per
 * node. The solo path is unchanged; this suite proves the shared parts and the
 * per-node parts separately: two live nodes commit with distinct authors on the
 * one chain, and the host lifetime boots a declared set.
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
};

function message(reply: Reply): unknown {
  if (reply.tool !== undefined) {
    return {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'e0', type: 'function',
        function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
      }],
    };
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

async function localEvents(home: string, uid: string) {
  return loadVerifiedEvents(home, uid, C13_EVENT_TYPES);
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

it('spawns a child on the root call, denies the child the capability, and unloads it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'es-spawn-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    // The kernel-composed identity sentence is how a scripted reply tells the
    // root from its child on one provider endpoint.
    const uid = request.body.toString('utf8').includes('You are node-1.')
      ? 'node-1' : 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (count === 0) {
      return respond({
        tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } },
      });
    }
    return respond({ content: 'idle' });
  });
  servers.push(server);
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: { key: 'k', endpoint: `${server.url}/v1/chat/completions` },
  }), { encoding: 'utf8', mode: 0o600 });
  const lines: string[] = [];
  const handle = startHost({
    home, uid: 'node-0', command: 'start', model: 'first-light-test',
    heading: 'Lead.', sandbox: false,
    log: createHostLog((line) => lines.push(line)),
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  });
  await vi.waitFor(() => {
    const spawned = lines
      .map((line) => JSON.parse(line) as { readonly event: string })
      .filter((event) => event.event === 'host/spawned');
    expect(spawned).toHaveLength(1);
  }, { timeout: 20_000 });
  // The child boots, tries to spawn itself on its first request (a child gets
  // no capability implicitly), and is refused; only then is the host stopped.
  await vi.waitFor(async () => {
    const events = await localEvents(home, 'node-1');
    expect(events.some((event) => event.type === 'turn/end')).toBe(true);
  }, { timeout: 20_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  const child = await localEvents(home, 'node-1');
  expect(child.filter((event) => event.type === 'node/boot')).toHaveLength(1);
  expect(child.some((event) => event.type === 'node/shutdown')).toBe(true);
  const claimed = child.filter((event) => event.type === 'tool/result'
    && (event.data as { readonly message?: { readonly content?: string } })
      .message?.content?.includes('spawned'));
  expect(claimed).toHaveLength(0);
  const denied = child.some((event) => event.type === 'tool/result'
    && (event.data as { readonly message?: { readonly content?: string } })
      .message?.content?.includes('denied: this node was not granted the spawn capability'));
  expect(denied).toBe(true);
  const attribution = await readAttribution(home);
  expect(attribution.some((record) => record.uid === 'node-1')).toBe(true);
  const spawned = lines
    .map((line) => JSON.parse(line) as { readonly event: string; readonly parent?: string;
      readonly uid?: string; readonly depth?: number })
    .find((event) => event.event === 'host/spawned');
  expect(spawned).toMatchObject({ parent: 'node-0', uid: 'node-1', depth: 1 });
}, 60_000);

it('caps a node at eight live children and refuses the ninth with a teaching denial', async () => {
  const home = await mkdtemp(join(tmpdir(), 'es-spawn-cap-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    const uid = /You are (node-\d+)\./.exec(body)?.[1] ?? 'node-0';
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
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: { key: 'k', endpoint: `${server.url}/v1/chat/completions` },
  }), { encoding: 'utf8', mode: 0o600 });
  const lines: string[] = [];
  const handle = startHost({
    home, uid: 'node-0', command: 'start', model: 'first-light-test',
    heading: 'Lead.', sandbox: false,
    log: createHostLog((line) => lines.push(line)),
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  });
  const denied = async () => (await localEvents(home, 'node-0')).filter((event) =>
    event.type === 'tool/result'
    && (event.data as { readonly message?: { readonly content?: string } })
      .message?.content?.includes('already has 8 live children'));
  await vi.waitFor(async () => { expect(await denied()).toHaveLength(1); }, { timeout: 40_000 });
  handle.stop();
  expect(await handle.done).toBe(0);
  const root = await localEvents(home, 'node-0');
  const spawned = root.filter((event) => event.type === 'tool/result'
    && (event.data as { readonly message?: { readonly content?: string } })
      .message?.content?.includes('spawned node-'));
  expect(spawned).toHaveLength(8);
}, 60_000);

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
