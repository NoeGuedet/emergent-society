import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadVerifiedEvents } from '../../context/loader.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { commitAs, serveJson } from '../../node/__tests__/helpers.js';
import { HeadWatcher } from '../../node/watcher.js';
import { WorldRepo } from '../../node/world.js';
import { startHost } from '../host.js';
import { readChat } from '../chat.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';

/**
 * Agent zero (A4): the human channel and the ratified direction.
 *
 * `speak` delivers a message outside the world and is granted to the root
 * only; the direction is the world's `DIRECTION.md` at its latest
 * human-authored commit, so a node's draft commit never moves the pin. Both
 * run through the real host lifetime against a scripted provider.
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

function respond(reply: Reply): { body: string } {
  if (reply.tool !== undefined) {
    return { body: JSON.stringify({ choices: [{ message: {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'e0', type: 'function',
        function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
      }],
    } }] }) };
  }
  if (reply.cmd !== undefined) {
    return { body: JSON.stringify({ choices: [{ message: {
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'e0', type: 'function',
        function: { name: 'execute', arguments: JSON.stringify({ cmd: reply.cmd }) },
      }],
    } }] }) };
  }
  return { body: JSON.stringify({ choices: [{ message: {
    role: 'assistant', content: reply.content ?? 'idle',
  } }] }) };
}

async function fixture(): Promise<{ home: string; world: WorldRepo }> {
  const home = await mkdtemp(join(tmpdir(), 'es-agent-zero-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  return { home, world };
}

async function providers(home: string, url: string): Promise<void> {
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: { key: 'k', endpoint: `${url}/v1/chat/completions` },
  }), { encoding: 'utf8', mode: 0o600 });
}

function start(home: string, lines: string[]) {
  return startHost({
    home, uid: 'node-0', command: 'start', model: 'first-light-test',
    heading: 'Seed heading.', sandbox: false,
    log: createHostLog((line) => lines.push(line)),
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  });
}

it('pins the human-ratified DIRECTION.md, never a node draft', async () => {
  const { home, world } = await fixture();
  await commitAs(world, 'human', { 'seed.txt': 'seed\n', 'DIRECTION.md': 'v1: hold the line\n' }, 'seed');
  const bodies: string[] = [];
  const server = await serveJson((request, index) => {
    bodies.push(request.body.toString('utf8'));
    // The root's first turn drafts a direction; its own commit must not move
    // the pin. Every later turn is idle.
    return index === 0
      ? respond({ cmd: "printf 'draft by node\\n' > DIRECTION.md" })
      : respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const lines: string[] = [];
  const handle = start(home, lines);
  await vi.waitFor(() => expect(bodies).toHaveLength(1), { timeout: 20_000 });
  expect(bodies[0]).toContain('v1: hold the line');
  // The draft is committed by node-0; the human then ratifies v2.
  await vi.waitFor(async () => {
    const events = await loadVerifiedEvents(home, 'node-0', C13_EVENT_TYPES);
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(1);
  }, { timeout: 20_000 });
  const ratified = await commitAs(world, 'human', { 'DIRECTION.md': 'v2: ratified\n' }, 'ratify');
  // The human commit is external to the drivers, so it does not poke the
  // shared watcher itself; the operator-side commit is announced like any
  // other world movement.
  HeadWatcher.for(world, 0).poke();
  // Turn 0 made two logical requests (the draft command and its reply); the
  // human commit then wakes the root, and its next request is the one that
  // must pin v2.
  await vi.waitFor(() => expect(bodies.length).toBeGreaterThanOrEqual(3), { timeout: 30_000 });
  // The heading block is the second system message (after the charter); the
  // perceived diff legitimately mentions the draft it replaced.
  const after = JSON.parse(bodies[bodies.length - 1]!) as {
    readonly messages: readonly { readonly role: string; readonly content: string | null }[];
  };
  expect(after.messages[1]?.content).toBe('v2: ratified\n');
  const events = await loadVerifiedEvents(home, 'node-0', C13_EVENT_TYPES);
  const pinned = events.filter((event) => event.type === 'direction/pinned');
  expect(pinned.length).toBeGreaterThanOrEqual(2);
  const first = pinned[0]!.data as { readonly commit: string; readonly bytes: number };
  expect(first.bytes).toBe(Buffer.byteLength('v1: hold the line\n', 'utf8'));
  const last = pinned[pinned.length - 1]!.data as { readonly commit: string };
  expect(last.commit).toBe(ratified);
  handle.stop();
  expect(await handle.done).toBe(0);
}, 40_000);

it('delivers speak outside the world to the root and denies it to a child', async () => {
  const { home, world } = await fixture();
  await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  const counts = new Map<string, number>();
  const server = await serveJson((request) => {
    const uid = request.body.toString('utf8').includes('You are node-1.')
      ? 'node-1' : 'node-0';
    const count = counts.get(uid) ?? 0;
    counts.set(uid, count + 1);
    if (uid === 'node-0') {
      if (count === 0) {
        return respond({ tool: { name: 'extend', args: { verb: 'spawn', heading: 'Worker.' } } });
      }
      if (count === 1) {
        return respond({ tool: { name: 'extend', args: { verb: 'speak', text: 'hello human' } } });
      }
      return respond({ content: 'idle' });
    }
    if (count === 0) {
      return respond({ tool: { name: 'extend', args: { verb: 'speak', text: 'child speaks' } } });
    }
    return respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const lines: string[] = [];
  const handle = start(home, lines);
  await vi.waitFor(async () => {
    const events = await loadVerifiedEvents(home, 'node-1', C13_EVENT_TYPES);
    expect(events.filter((event) => event.type === 'turn/end').length).toBeGreaterThan(0);
  }, { timeout: 30_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  const chat = await readChat(home);
  expect(chat).toHaveLength(1);
  expect(chat[0]).toMatchObject({ uid: 'node-0', text: 'hello human' });
  const child = await loadVerifiedEvents(home, 'node-1', C13_EVENT_TYPES);
  expect(child.some((event) => event.type === 'tool/result'
    && (event.data as { readonly message?: { readonly content?: string } })
      .message?.content?.includes('denied: this node was not granted the human channel')))
    .toBe(true);
  // The world never carries the chat: it is delivered outside it.
  expect(await world.headHash()).not.toBeNull();
  const worldFiles = await import('node:fs/promises').then((fs) => fs.readdir(world.path));
  expect(worldFiles).not.toContain('chat.v0.jsonl');
}, 40_000);
