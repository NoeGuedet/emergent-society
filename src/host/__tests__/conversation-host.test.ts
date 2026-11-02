import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { commitAs, serveJson } from '../../node/__tests__/helpers.js';
import { ConversationLog, readConversationThread } from '../../node/conversation.js';
import { ConversationWatcher } from '../../node/conversation-watcher.js';
import { HeadWatcher } from '../../node/watcher.js';
import { WorldRepo } from '../../node/world.js';
import { startHost } from '../host.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';

/**
 * The conversation at the host level (A3): the pending notice rides the
 * recipient's next assembled request as a kernel-owned SYSTEM message, a
 * parked recipient wakes with `trigger: 'conversation'`, and the clear rule
 * prefers a sent request over a failed one. The stream is appended from the
 * test process — the in-process `poke` is exactly the host's own latency path
 * for a host-side write.
 */

const dirs: string[] = [];
const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function idle(): { body: string } {
  return { body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'idle' } }] }) };
}

async function fixture(): Promise<{ home: string; world: WorldRepo }> {
  const home = await mkdtemp(join(tmpdir(), 'es-conversation-host-'));
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

function start(home: string, lines: string[]) {
  const nodesFile = join(home, 'nodes.json');
  return writeFile(nodesFile, JSON.stringify([
    { uid: 'node-0', model: 'first-light-test', heading: 'Root.' },
    { uid: 'node-1', model: 'first-light-test', heading: 'Worker.' },
  ]), 'utf8').then(() => startHost({
    home, uid: 'node-0', command: 'start', nodesFile, sandbox: false, pollMs: 0,
    log: createHostLog((line) => lines.push(line)),
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  }));
}

type Wire = {
  readonly messages: readonly { readonly role: string; readonly content: string | null }[];
};

/** One tool-call reply for the scripted provider. */
function toolCall(name: string, args: unknown): { body: string } {
  return { body: JSON.stringify({ choices: [{ message: {
    role: 'assistant', content: null,
    tool_calls: [{
      id: 'e0', type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  } }] }) };
}

/** A one-node boot that DECLARES the spawn grant (a solo flag boot grants nobody). */
function startSpawner(home: string, lines: string[]) {
  const nodesFile = join(home, 'nodes.json');
  return writeFile(nodesFile, JSON.stringify([
    { uid: 'node-0', model: 'first-light-test', heading: 'Root.', spawn: true },
  ]), 'utf8').then(() => startHost({
    home, uid: 'node-0', command: 'start', nodesFile, sandbox: false, pollMs: 0,
    log: createHostLog((line) => lines.push(line)),
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  }));
}

const nodeRequests = (bodies: readonly string[], uid: string): string[] =>
  bodies.filter((body) => body.includes(`You are ${uid}.`));

const notices = (body: string): string[] => (JSON.parse(body) as Wire).messages
  .filter((message) => message.role === 'system'
    && (message.content ?? '').includes('consult get_messages'))
  .map((message) => message.content ?? '');

const triggers = async (home: string, uid: string): Promise<string[]> => {
  const events = await loadVerifiedEvents(home, uid, C13_EVENT_TYPES);
  return events.filter((event) => event.type === 'turn/start')
    .map((event) => (event.data as { readonly trigger: string }).trigger);
};

it('boots with unread mail, renders the notice in the next request, and clears it on the send', async () => {
  const { home } = await fixture();
  // The boot backlog: a node booting with unread mail is notified on its first
  // evaluation, without a second turn.
  await ConversationLog.for(home).append('gateway', 'node-1', 'before the boot');
  const bodies: string[] = [];
  const server = await serveJson((request) => {
    bodies.push(request.body.toString('utf8'));
    return idle();
  });
  servers.push(server);
  await providers(home, server.url);
  const lines: string[] = [];
  const handle = await start(home, lines);
  try {
    await vi.waitFor(() => {
      expect(nodeRequests(bodies, 'node-0')).toHaveLength(1);
      expect(nodeRequests(bodies, 'node-1')).toHaveLength(1);
    }, { timeout: 30_000 });
    // Every boot turn holds its first request's notice exactly once.
    expect(notices(nodeRequests(bodies, 'node-1')[0]!))
      .toEqual(['1 message arrived, the newest from gateway; consult get_messages']);
    expect(notices(nodeRequests(bodies, 'node-0')[0]!)).toEqual([]);
    // The written request clears the notice; the next append is a new arrival.
    await vi.waitFor(() => {
      expect(ConversationWatcher.for(home).noticeFor('node-1')).toBeNull();
    });
    await ConversationLog.for(home).append('gateway', 'node-1', 'after the boot');
    ConversationWatcher.for(home).poke();
    await vi.waitFor(() => expect(nodeRequests(bodies, 'node-1')).toHaveLength(2), {
      timeout: 30_000,
    });
    const second = nodeRequests(bodies, 'node-1')[1]!;
    expect(notices(second))
      .toEqual(['1 message arrived, the newest from gateway; consult get_messages']);
    // The seed commit the node has never seen opens the first turn as a
    // wakeup; the second is the conversation's.
    const starts = await triggers(home, 'node-1');
    expect(starts).toHaveLength(2);
    expect(starts[1]).toBe('conversation');
    // The clear rule: the second request consumed the second notice too.
    await vi.waitFor(() => {
      expect(ConversationWatcher.for(home).noticeFor('node-1')).toBeNull();
    });
    // One message wakes ONE recipient: node-0 made no further request.
    expect(nodeRequests(bodies, 'node-0')).toHaveLength(1);
    expect(await triggers(home, 'node-0')).toHaveLength(1);
  } finally {
    handle.stop();
    expect(await handle.done).toBe(0);
  }
}, 40_000);

it('does not consume the notice on a failed request; the next turn re-renders it', async () => {
  const { home, world } = await fixture();
  let failures = 2;
  const bodies: string[] = [];
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    bodies.push(body);
    // The boot turn is idle. The wake turn's adapter attempts fail (a 500 is
    // retryable: two attempts, then the request is a failure), and every later
    // request succeeds.
    if (body.includes('You are node-1.') && nodeRequests(bodies, 'node-1').length > 1
      && failures > 0) {
      failures -= 1;
      return { status: 500, body: '{}' };
    }
    return idle();
  });
  servers.push(server);
  await providers(home, server.url);
  const lines: string[] = [];
  const handle = await start(home, lines);
  try {
    await vi.waitFor(() => {
      expect(nodeRequests(bodies, 'node-1')).toHaveLength(1);
    }, { timeout: 30_000 });
    await ConversationLog.for(home).append('gateway', 'node-1', 'a message that fails');
    ConversationWatcher.for(home).poke();
    // The woken turn sends the notice; both attempts fail, so the exchange is a
    // failure and the notice is not consumed.
    await vi.waitFor(() => expect(failures).toBe(0), { timeout: 30_000 });
    await vi.waitFor(() => {
      expect(nodeRequests(bodies, 'node-1').length).toBeGreaterThanOrEqual(3);
    }, { timeout: 30_000 });
    expect(notices(nodeRequests(bodies, 'node-1')[1]!))
      .toEqual(['1 message arrived, the newest from gateway; consult get_messages']);
    // The failed request did not consume it.
    const watcher = ConversationWatcher.for(home);
    await vi.waitFor(() => {
      expect(watcher.noticeFor('node-1')).not.toBeNull();
    });
    // A later turn (a foreign world commit wakes the node) renders it again.
    const before = nodeRequests(bodies, 'node-1').length;
    await commitAs(world, 'human', { 'foreign.txt': 'moved\n' }, 'foreign');
    HeadWatcher.for(world, 0).poke();
    await vi.waitFor(() => {
      expect(nodeRequests(bodies, 'node-1').length).toBeGreaterThan(before);
    }, { timeout: 30_000 });
    const after = nodeRequests(bodies, 'node-1');
    expect(notices(after[after.length - 1]!))
      .toEqual(['1 message arrived, the newest from gateway; consult get_messages']);
    await vi.waitFor(() => expect(watcher.noticeFor('node-1')).toBeNull());
    // The notice turn was a conversation wake, never a silent 'wakeup'.
    const starts = await triggers(home, 'node-1');
    expect(starts[0]).toMatch(/boot|wakeup/);
    expect(starts).toContain('conversation');
  } finally {
    handle.stop();
    expect(await handle.done).toBe(0);
  }
}, 60_000);

it('accumulates a record for an absent recipient with no notice and no wake', async () => {
  const { home } = await fixture();
  const bodies: string[] = [];
  const server = await serveJson((request) => {
    bodies.push(request.body.toString('utf8'));
    return idle();
  });
  servers.push(server);
  await providers(home, server.url);
  const lines: string[] = [];
  const handle = await start(home, lines);
  try {
    await vi.waitFor(() => {
      expect(nodeRequests(bodies, 'node-0')).toHaveLength(1);
      expect(nodeRequests(bodies, 'node-1')).toHaveLength(1);
    }, { timeout: 30_000 });
    await ConversationLog.for(home).append('gateway', 'node-9', 'for the departed');
    ConversationWatcher.for(home).poke();
    // The record is durable and honest in the stream; no live driver wakes.
    await vi.waitFor(async () => {
      const thread = await readConversationThread(home, 'node-9', 16);
      expect(thread.records.map((record) => record.text)).toEqual(['for the departed']);
    });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(nodeRequests(bodies, 'node-0')).toHaveLength(1);
    expect(nodeRequests(bodies, 'node-1')).toHaveLength(1);
    // NO notice: the address names a node no live driver bears.
    expect(ConversationWatcher.for(home).noticeFor('node-9')).toBeNull();
    // The raw stream holds the record beside the boot seed.
    expect(await readFile(join(home, 'conversation.v0.jsonl'), 'utf8'))
      .toContain('for the departed');
  } finally {
    handle.stop();
    expect(await handle.done).toBe(0);
  }
}, 40_000);

it('arms a waiting record for a spawned node during its composition', async () => {
  const { home } = await fixture();
  // The first spawn mints node-1 (node-0 is the only known uid). The record
  // waits in the stream before the child exists.
  await ConversationLog.for(home).append('gateway', 'node-1', 'waiting for you');
  const bodies: string[] = [];
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    bodies.push(body);
    // The root spawns once; the child composes, boots, and parks.
    if (body.includes('You are node-0.') && nodeRequests(bodies, 'node-0').length === 1) {
      return toolCall('extend', { verb: 'spawn', heading: 'Worker.' });
    }
    return idle();
  });
  servers.push(server);
  await providers(home, server.url);
  const lines: string[] = [];
  const handle = await startSpawner(home, lines);
  const childBodies = (): string[] => bodies.filter(
    (body) => body.includes('You are node-1, composed by node-0.'),
  );
  try {
    await vi.waitFor(() => expect(childBodies()).toHaveLength(1), { timeout: 30_000 });
    // The reservation-aware recipient filter admitted the child's uid while it
    // was still composing, so its boot arming armed the waiting record and its
    // FIRST request carries the notice.
    expect(notices(childBodies()[0]!))
      .toEqual(['1 message arrived, the newest from gateway; consult get_messages']);
    expect(await triggers(home, 'node-1')).toHaveLength(1);
    // The sent request consumed it.
    await vi.waitFor(() => {
      expect(ConversationWatcher.for(home).noticeFor('node-1')).toBeNull();
    });
  } finally {
    handle.stop();
    expect(await handle.done).toBe(0);
  }
}, 40_000);
