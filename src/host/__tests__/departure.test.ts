import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents, type VerifiedEvent } from '../../context/loader.js';
import type { FencePort } from '../../node/index.js';
import { commitAs, gitIn, serveJson } from '../../node/__tests__/helpers.js';
import { HeadWatcher } from '../../node/watcher.js';
import { WorldRepo } from '../../node/world.js';
import {
  startHost, type CellOptions, type HostDeps, type HostHandle, type HostOptions, type NodeCell,
} from '../host.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';

/**
 * S4: a node asks for its own clean end (`extend {verb:"request_death"}`).
 *
 * The granted departure (the one result flushed before the shutdown event, the
 * turn's remaining calls synthetic-cancelled), the last-node refusal, the solo
 * boot's refusal, the concurrent departures (exactly one granted; the second
 * denied by the first's synchronous mark while the first is still live), the
 * orphan-survival flagship (the host stays alive while a composed child lives
 * and keeps committing after the root's `host/ended`), the churn mint and the
 * pool-emptied exit (the drain resolves and the host exits 0).
 *
 * Every home is mkdtemp'd; the only network is the loopback fake provider.
 * The concurrent case injects a test-only `FencePort` to hold the granted
 * node's commit: the mark's persistence is then a fact of the test, not a
 * timing coincidence.
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

/** The node uid a scripted request belongs to, from the kernel-composed sentence. */
function uidOf(request: { readonly body: { toString(encoding: 'utf8'): string } }): string {
  const body = request.body.toString('utf8');
  return /You are (node-\d+)[.,]/.exec(body)?.[1] ?? 'node-0';
}

type HostEvent = {
  readonly event: string;
  readonly uid?: string; readonly reason?: string; readonly requester?: string;
  readonly code?: number; readonly error?: string;
};

function hostEvents(lines: readonly string[]): HostEvent[] {
  return lines.map((line) => JSON.parse(line) as HostEvent);
}

function endsOf(lines: readonly string[]): HostEvent[] {
  return hostEvents(lines).filter((event) => event.event === 'host/ended');
}

function boot(home: string, opts: {
  readonly lines: string[];
  readonly nodesFile?: string;
  readonly deps?: HostDeps;
}): HostHandle {
  const options: HostOptions = {
    home, uid: 'node-0', command: 'start', sandbox: false,
    ...(opts.nodesFile !== undefined
      ? { nodesFile: opts.nodesFile }
      : { model: 'first-light-test', heading: 'Lead.' }),
    log: createHostLog((line) => opts.lines.push(line)),
  };
  return startHost(options, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
    ...opts.deps,
  });
}

async function initFixture(): Promise<{ home: string; world: WorldRepo }> {
  const home = await mkdtemp(join(tmpdir(), 'es-departure-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  return { home, world };
}

async function providers(home: string, url: string): Promise<void> {
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: { key: 'k', endpoint: `${url}/v1/chat/completions` },
  }), { encoding: 'utf8', mode: 0o600 });
}

async function writeNodes(
  home: string, entries: readonly Record<string, unknown>[],
): Promise<string> {
  const path = join(home, 'nodes.json');
  await writeFile(path, JSON.stringify(entries), 'utf8');
  return path;
}

async function localEvents(home: string, uid: string): Promise<readonly VerifiedEvent[]> {
  return loadVerifiedEvents(home, uid, C13_EVENT_TYPES);
}

async function resultEvents(home: string, uid: string): Promise<readonly {
  readonly callId: string; readonly isError: boolean; readonly synthetic: boolean;
  readonly raw: unknown; readonly content: string;
}[]> {
  const events = await localEvents(home, uid);
  return events
    .filter((event) => event.type === 'tool/result')
    .map((event) => {
      const data = event.data as {
        callId: string; isError: boolean; synthetic: boolean; raw: unknown;
        message: { content: string };
      };
      return {
        callId: data.callId, isError: data.isError, synthetic: data.synthetic,
        raw: data.raw, content: data.message.content,
      };
    });
}

async function resultTexts(home: string, uid: string): Promise<string[]> {
  return (await resultEvents(home, uid)).map((result) => result.content);
}

async function shutdownReasons(home: string, uid: string): Promise<string[]> {
  return (await localEvents(home, uid))
    .filter((event) => event.type === 'node/shutdown')
    .map((event) => (event.data as { reason: string }).reason);
}

/** The grant/denial text the executor renders. */
const GRANT = 'departure granted: this node stops when this turn ends';
const DENIAL = 'denied: the last live node cannot die; the operator pauses the host';

it('grants a departure to a live node: the result flushes before the shutdown', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const uid = uidOf(request);
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (count > 0) return respond({ content: 'idle' });
    return uid === 'node-0'
      ? respond({
        tools: [
          { name: 'extend', args: { verb: 'request_death' } },
          { name: 'execute', args: { cmd: "printf 'x\\n' > never.txt" } },
        ],
      })
      : respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.' },
    { uid: 'node-1', model: 'first-light-test', heading: 'Peer.' },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  await vi.waitFor(async () => {
    expect(await resultTexts(home, 'node-0')).toContain(GRANT);
  }, { timeout: 30_000 });
  await vi.waitFor(() => {
    expect(endsOf(lines)).toContainEqual(
      expect.objectContaining({ uid: 'node-0', reason: 'self-requested' }));
  }, { timeout: 30_000 });

  // The node's end removes only that node: the host stays alive while the
  // peer is live, and the peer was not stopped by the departure.
  expect(hostEvents(lines).some((event) => event.event === 'host/stop')).toBe(false);
  expect(await shutdownReasons(home, 'node-1')).toEqual([]);

  // The one result per call: the grant for the request_death call and the
  // synthetic cancelled closer for the call after it.
  const results = await resultEvents(home, 'node-0');
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ callId: 'e0', isError: false, synthetic: false });
  expect(results[0]!.content).toBe(GRANT);
  expect(results[1]).toMatchObject({ callId: 'e1', isError: true, synthetic: true });
  expect(results[1]!.content).toBe('cancelled');
  expect(results.every((result) => result.raw === null)).toBe(true);
  // The stop aborted the turn's remaining call: it never reached the shell.
  expect(existsSync(join(home, 'world', 'never.txt'))).toBe(false);

  // The grant is durable BEFORE the shutdown event, and the end's reason is
  // the node's own vocabulary.
  const events = await localEvents(home, 'node-0');
  const grantAt = events.findIndex((event) => event.type === 'tool/result'
    && (event.data as { message?: { content?: string } }).message?.content === GRANT);
  const shutdownAt = events.findIndex((event) => event.type === 'node/shutdown');
  expect(grantAt).toBeGreaterThanOrEqual(0);
  expect(shutdownAt).toBeGreaterThan(grantAt);
  expect((events[shutdownAt]!.data as { reason: string }).reason).toBe('self-requested');

  handle.stop();
  expect(await handle.done).toBe(0);
  expect(endsOf(lines)).toContainEqual(
    expect.objectContaining({ uid: 'node-1', reason: 'stop-requested' }));
  expect(await shutdownReasons(home, 'node-1')).toEqual(['stop-requested']);
}, 60_000);

it('refuses a solo boot its own end and keeps the node alive', async () => {
  const { home } = await initFixture();
  const server = await serveJson((_request, index) => respond(index === 0
    ? { tool: { name: 'extend', args: { verb: 'request_death' } } }
    : { content: 'idle' }));
  servers.push(server);
  await providers(home, server.url);
  const lines: string[] = [];
  const handle = boot(home, { lines });
  await vi.waitFor(async () => {
    expect(await resultTexts(home, 'node-0')).toContain(DENIAL);
  }, { timeout: 30_000 });

  // The last live node's end is the operator's: nothing ended, nothing stopped.
  const results = await resultEvents(home, 'node-0');
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ callId: 'e0', isError: true, synthetic: false });
  expect(results[0]!.raw).toBeNull();
  expect(endsOf(lines)).toEqual([]);
  expect((await localEvents(home, 'node-0')).some((event) => event.type === 'node/shutdown'))
    .toBe(false);

  handle.stop();
  expect(await handle.done).toBe(0);
  expect(endsOf(lines)).toContainEqual(
    expect.objectContaining({ uid: 'node-0', reason: 'stop-requested' }));
  expect(await shutdownReasons(home, 'node-0')).toEqual(['stop-requested']);
}, 60_000);

it('grants exactly one of two concurrent departures: the mark refuses the second', async () => {
  const { home } = await initFixture();
  const counts = new Map<string, number>();
  let arrivals = 0;
  let releaseResponses!: () => void;
  const bothArrived = new Promise<void>((resolve) => { releaseResponses = resolve; });
  const server = await serveJson(async (request) => {
    const uid = uidOf(request);
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    const ask = respond({ tool: { name: 'extend', args: { verb: 'request_death' } } });
    if (count > 0) return ask;
    // Both first turns reach their decision together: the two requests are
    // held until both are in flight.
    arrivals += 1;
    if (arrivals === 2) releaseResponses();
    await bothArrived;
    return ask;
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.' },
    { uid: 'node-1', model: 'first-light-test', heading: 'Peer.' },
  ]);
  // The test-only fence holds every commit until the test releases it: both
  // runs are blocked before settling, so the second departure decision is
  // provably made against the synchronous mark (both nodes still live), not
  // against a changed roster.
  let holdFence = true;
  const fenceWaiters: (() => void)[] = [];
  const fence: FencePort = {
    acquire: async () => {
      if (holdFence) await new Promise<void>((resolve) => { fenceWaiters.push(resolve); });
      return { fenced: true, leaves: 0 };
    },
    release: async () => {},
  };
  const openFence = (): void => {
    holdFence = false;
    for (const resolve of fenceWaiters.splice(0)) resolve();
  };
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines, deps: { fence } });

  const grantOf = async (uid: string): Promise<boolean> =>
    (await resultTexts(home, uid)).includes(GRANT);
  let grantedUid = '';
  await vi.waitFor(async () => {
    const granted = [];
    for (const uid of ['node-0', 'node-1']) if (await grantOf(uid)) granted.push(uid);
    const denied = [];
    for (const uid of ['node-0', 'node-1']) {
      if ((await resultTexts(home, uid)).includes(DENIAL)) denied.push(uid);
    }
    expect(granted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    grantedUid = granted[0]!;
  }, { timeout: 30_000 });
  const deniedUid = grantedUid === 'node-0' ? 'node-1' : 'node-0';

  // The denial was decided while the granted node was STILL LIVE and unended:
  // only the departure mark can refuse it (two live nodes, the last-node rule
  // alone would grant). Both runs are blocked in the fence, so no shutdown can
  // exist yet.
  expect(await shutdownReasons(home, grantedUid)).toEqual([]);
  expect(endsOf(lines)).toEqual([]);
  expect((await resultTexts(home, grantedUid)).filter((text) => text === GRANT)).toHaveLength(1);
  expect((await resultTexts(home, deniedUid)).filter((text) => text === DENIAL).length)
    .toBeGreaterThanOrEqual(1);

  // Release the commits: the granted node's turn lands and its run settles.
  openFence();
  await vi.waitFor(() => {
    expect(endsOf(lines)).toContainEqual(
      expect.objectContaining({ uid: grantedUid, reason: 'self-requested' }));
  }, { timeout: 30_000 });
  expect(hostEvents(lines).some((event) => event.event === 'host/stop')).toBe(false);

  // The survivor is now the last live node: its next ask is refused again, by
  // the last-node rule, and it is not stopped.
  await vi.waitFor(async () => {
    const denials = (await resultTexts(home, deniedUid)).filter((text) => text === DENIAL);
    expect(denials.length).toBeGreaterThanOrEqual(2);
  }, { timeout: 30_000 });
  expect((await localEvents(home, deniedUid)).some((event) => event.type === 'node/shutdown'))
    .toBe(false);
  expect(hostEvents(lines).some((event) => event.event === 'host/stop')).toBe(false);

  handle.stop();
  expect(await handle.done).toBe(0);
  expect(endsOf(lines)).toContainEqual(
    expect.objectContaining({ uid: deniedUid, reason: 'stop-requested' }));
  expect(await shutdownReasons(home, deniedUid)).toEqual(['stop-requested']);
}, 120_000);

it('lets a composed child outlive its root and keep committing (the flagship)', async () => {
  const { home, world } = await initFixture();
  const counts = new Map<string, number>();
  let releaseChild!: () => void;
  const rootEnded = new Promise<void>((resolve) => { releaseChild = resolve; });
  const server = await serveJson(async (request) => {
    const body = request.body.toString('utf8');
    const isChild = body.includes('You are node-1, composed by node-0.');
    const uid = isChild ? 'node-1' : 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (!isChild) {
      return count === 0
        ? respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } })
        : respond({
          tools: [
            { name: 'extend', args: { verb: 'request_death' } },
            { name: 'execute', args: { cmd: "printf 'x\\n' > never.txt" } },
          ],
        });
    }
    if (count === 0) return respond({ cmd: "printf 'first\\n' > child-first.txt" });
    // The post-departure turn is held until the root's end is observed: its
    // commit is then strictly after the root's `host/ended`.
    if (count === 1) {
      await rootEnded;
      return respond({ cmd: "printf 'after\\n' > child-after.txt" });
    }
    return respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });

  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned'))
      .toHaveLength(1);
  }, { timeout: 30_000 });
  await vi.waitFor(() => {
    expect(existsSync(join(world.path, 'child-first.txt'))).toBe(true);
  }, { timeout: 30_000 });
  await vi.waitFor(async () => {
    expect(await resultTexts(home, 'node-0')).toContain(GRANT);
  }, { timeout: 30_000 });
  // The root's departure: granted (the child is live), the remaining call
  // cancelled, and the host stays alive.
  await vi.waitFor(() => {
    expect(endsOf(lines)).toContainEqual(
      expect.objectContaining({ uid: 'node-0', reason: 'self-requested' }));
  }, { timeout: 30_000 });
  const headAtRootEnd = await gitIn(world, ['rev-parse', 'HEAD']);
  expect(hostEvents(lines).some((event) => event.event === 'host/stop')).toBe(false);
  expect(await shutdownReasons(home, 'node-1')).toEqual([]);
  expect(existsSync(join(world.path, 'never.txt'))).toBe(false);
  const rootResults = await resultEvents(home, 'node-0');
  expect(rootResults.find((result) => result.callId === 'e1'))
    .toMatchObject({ isError: true, synthetic: true, content: 'cancelled' });
  expect(await shutdownReasons(home, 'node-0')).toEqual(['self-requested']);

  // The child commits AFTER the root's end: the held reply is released only
  // now, so the commit is caused by a turn the root's end preceded.
  releaseChild();
  await vi.waitFor(async () => {
    const tracked = await gitIn(world, ['show', '--format=', '--name-only', 'HEAD']);
    expect(tracked).toContain('child-after.txt');
  }, { timeout: 30_000 });
  const headAfter = await gitIn(world, ['rev-parse', 'HEAD']);
  expect(headAfter).not.toBe(headAtRootEnd);
  // The host is still alive: S1's pool anchor — a dead root is not a dead host.
  expect(hostEvents(lines).some((event) => event.event === 'host/stop')).toBe(false);
  expect(await shutdownReasons(home, 'node-1')).toEqual([]);

  // The operator's pause stops everything cleanly.
  handle.stop();
  expect(await handle.done).toBe(0);
  expect(endsOf(lines)).toContainEqual(
    expect.objectContaining({ uid: 'node-1', reason: 'stop-requested' }));
  expect(await shutdownReasons(home, 'node-1')).toEqual(['stop-requested']);
}, 120_000);

it('mints a fresh uid for a spawn after a departure: the departed uid is never reused', async () => {
  const { home, world } = await initFixture();
  const counts = new Map<string, number>();
  // The root's post-departure spawn is gated on node-1's END: the provider
  // withholds that reply until the test has observed `host/ended` for node-1,
  // so the mint provably happens after the departed node left the pool — only
  // its directory is left, which is the mint's disk term.
  let allowSecondSpawn!: () => void;
  const secondSpawnAllowed = new Promise<void>((resolve) => { allowSecondSpawn = resolve; });
  const server = await serveJson(async (request) => {
    const uid = uidOf(request);
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (uid === 'node-1') {
      // The child writes (its turn commits, which wakes the root) and then asks
      // for its own end; the root is live, so the departure is granted.
      if (count === 0) {
        return respond({
          tools: [
            { name: 'execute', args: { cmd: "printf 'departed\n' > departed.txt" } },
            { name: 'extend', args: { verb: 'request_death' } },
          ],
        });
      }
      return respond({ content: 'idle' });
    }
    if (uid !== 'node-0') return respond({ content: 'idle' });
    // Turn 0: spawn node-1, then an idle step closes the turn and parks the
    // root. The child's departure turn commits, the wake opens a LATER turn,
    // and that turn's spawn is held until the child's end is observed.
    if (count === 0) {
      return respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'First.' } } });
    }
    if (count === 1) return respond({ content: 'idle' });
    if (count === 2) {
      await secondSpawnAllowed;
      return respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Second.' } } });
    }
    // A spawned child's later boot contributes no world change: no wake.
    return respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines });
  // The first spawn, then the child's granted departure.
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(1);
  }, { timeout: 30_000 });
  await vi.waitFor(() => {
    expect(endsOf(lines)).toContainEqual(
      expect.objectContaining({ uid: 'node-1', reason: 'self-requested' }));
  }, { timeout: 30_000 });
  // Only now may the root's later turn spawn: node-1 is out of the roster and
  // its directory is on disk, so only the mint's disk term keeps the uid from
  // coming back.
  allowSecondSpawn();
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(2);
  }, { timeout: 30_000 });
  // `host/spawned` is emitted inside the pool; the requester's result is
  // appended and flushed after the executor returns, so wait for it too.
  await vi.waitFor(async () => {
    expect((await resultTexts(home, 'node-0')).filter(
      (text) => text.startsWith('spawned node-'))).toHaveLength(2);
  }, { timeout: 30_000 });

  const events = hostEvents(lines);
  const endedAt = events.findIndex(
    (event) => event.event === 'host/ended' && event.uid === 'node-1');
  const spawnedAt = events.findIndex(
    (event) => event.event === 'host/spawned' && event.uid === 'node-2');
  expect(endedAt).toBeGreaterThanOrEqual(0);
  // The second spawn is strictly after the first node's end: the mint could
  // see the departed node-1 on disk only, never in the roster.
  expect(spawnedAt).toBeGreaterThan(endedAt);
  const spawned = events
    .filter((event) => event.event === 'host/spawned')
    .map((event) => event.uid);
  expect(spawned).toEqual(['node-1', 'node-2']);
  expect(existsSync(join(home, 'nodes', 'node-1'))).toBe(true);
  expect(existsSync(join(home, 'nodes', 'node-2'))).toBe(true);
  expect((await resultTexts(home, 'node-0')).filter(
    (text) => text.startsWith('spawned node-'))).toEqual([
    expect.stringContaining('spawned node-1'),
    expect.stringContaining('spawned node-2'),
  ]);
  // The departed node's own turn left the world commit that woke the root; it
  // is still HEAD (the spawn is a local fact and the fresh child changed
  // nothing), so the sequence really is spawn -> child commit -> depart ->
  // spawn.
  expect(await gitIn(world, ['log', '--format=%an', '-1'])).toBe('node-1\n');
  expect(await gitIn(world, ['show', '--format=', '--name-only', 'HEAD']))
    .toContain('departed.txt');
  expect(events.some((event) => event.event === 'host/stop')).toBe(false);

  handle.stop();
  expect(await handle.done).toBe(0);
}, 120_000);

it('empties the pool through rejecting composed runs and exits 0 (the drain)', async () => {
  const { home } = await initFixture();
  let requests = 0;
  const server = await serveJson(() => {
    requests += 1;
    if (requests === 1) {
      return respond({
        tools: [
          { name: 'extend', args: { verb: 'spawn', heading: 'First.' } },
          { name: 'extend', args: { verb: 'spawn', heading: 'Second.' } },
          // The root departs AFTER both children are registered: they are live
          // (their deferred runs are pending), so the departure is granted.
          { name: 'extend', args: { verb: 'request_death' } },
        ],
      });
    }
    return respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  // The S1 test-only compose seam: the composed children's runs are deferred
  // rejecting promises. The test rejects them only AFTER the root's end — an
  // immediate rejection would end the children before the root's departure and
  // deny it as the last live node.
  const deferred: { readonly uid: string; reject(err: unknown): void }[] = [];
  const composeChild: NonNullable<HostDeps['composeChild']> = async (options: CellOptions) => {
    let reject!: (err: unknown) => void;
    const run = new Promise<void>((_resolve, rej) => { reject = rej; });
    void run.catch(() => { /* the pool observes the rejection too */ });
    deferred.push({ uid: options.uid, reject });
    return {
      uid: options.uid,
      close: async () => {},
      driver: {
        state: 'active',
        run: () => run,
        stop: () => {},
        shutdownReason: () => 'handler-error' as const,
      },
    } as unknown as NodeCell;
  };
  const lines: string[] = [];
  const handle = boot(home, { nodesFile, lines, deps: { composeChild } });
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(2);
  }, { timeout: 30_000 });
  await vi.waitFor(() => {
    expect(endsOf(lines)).toContainEqual(
      expect.objectContaining({ uid: 'node-0', reason: 'self-requested' }));
  }, { timeout: 30_000 });
  // The root is gone, the composed children are still live: the pool keeps the
  // host body alive, so no exit has happened yet.
  expect(deferred.map((entry) => entry.uid)).toEqual(['node-1', 'node-2']);
  expect(hostEvents(lines).some((event) => event.event === 'host/stop')).toBe(false);

  // The deferred rejections: each ends only its own node, and the last one
  // empties the pool — the drain resolves.
  for (const entry of deferred) entry.reject(new Error('child fault'));
  expect(await handle.done).toBe(0);
  expect(hostEvents(lines).find((event) => event.event === 'host/stop'))
    .toMatchObject({ code: 0 });
  expect(hostEvents(lines).some((event) => event.event === 'host/error')).toBe(false);
  expect(endsOf(lines)).toContainEqual(
    expect.objectContaining({ uid: 'node-1', reason: 'handler-error' }));
  expect(endsOf(lines)).toContainEqual(
    expect.objectContaining({ uid: 'node-2', reason: 'handler-error' }));
}, 60_000);
