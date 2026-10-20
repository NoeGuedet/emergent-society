import { createServer, type Server } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BlobStore } from '../../journal/index.js';
import { loadVerifiedEvents, type VerifiedEvents } from '../../context/loader.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { ContextFold } from '../../context/fold.js';
import { resolveStored } from '../../context/artifacts.js';
import { verifyPerceptions } from '../../context/__tests__/verify-perceptions.js';
import { ProviderAdapter, type ProviderPolicy } from '../../provider/adapter.js';
import { OpenAITransport } from '../../provider/transport.js';
import { readFrontier } from '../../frontier/__tests__/helpers.js';
import { NodeDriver } from '../driver.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import { DEFAULT_TERMINAL_ENV } from '../tools/terminal.js';
import { HeadWatcher } from '../watcher.js';
import { commitAs, useWorld } from './helpers.js';
import type { AssistantProjection, Stored } from '../../context/contracts.js';

const fixture = useWorld('c13-http-');

function resolved(home: string): Promise<VerifiedEvents> {
  return loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
}

async function parked(driver: NodeDriver, world: ReturnType<typeof fixture>['world']): Promise<void> {
  await vi.waitFor(() => {
    expect(driver.state).toBe('waiting');
    expect(HeadWatcher.for(world).subscriberCount).toBe(1);
  }, { timeout: 5000 });
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

const providerPolicy: ProviderPolicy = {
  delay,
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => { clearTimeout(timer); };
  },
};

/** The adapter bound to the fixture's frontier journal. */
async function adapterFor(endpoint: string): Promise<ProviderAdapter> {
  return new ProviderAdapter(
    new OpenAITransport({ endpoint, key: 'test-key-never-log' }),
    providerPolicy,
    (await fixture().frontier()).gate,
  );
}

describe('C1.3 real boundaries', () => {
  it('sends exact durable bytes, carries tool dialogue, and rebuilds after restart', async () => {
    const { home, world } = fixture();
    const initialHead = await commitAs(world, 'human', { 'direction.txt': 'build a note\n' });
    const bodies: Buffer[] = [];
    const responses: Buffer[] = [];
    const errors: unknown[] = [];
    const durableAtSend: boolean[] = [];
    let requestIndex = 0;
    const server = createServer((req, res) => {
      const index = requestIndex;
      requestIndex += 1;
      // Only the fake key, only in the header; nothing logs headers.
      expect(req.method).toBe('POST');
      expect(req.headers.authorization).toBe('Bearer test-key-never-log');
      const chunks: Buffer[] = [];
      let started = false;
      let resolveCheck!: () => void;
      let rejectCheck!: (error: unknown) => void;
      const firstCheck = new Promise<void>((resolve, reject) => {
        resolveCheck = resolve; rejectCheck = reject;
      });
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (started) return;
        started = true;
        // Read the frontier once the request starts arriving. This async read
        // proves the `http/request` was durable before the handler answered; it
        // does not prove a first-byte instant barrier — the fault fixture proves
        // that ordering.
        void (async () => {
          const frontierEvents = await readFrontier(home);
          const requests = frontierEvents.filter((event) => event.type === 'http/request');
          if (requests.length !== index + 1) {
            throw new Error('http/request not durable at first byte');
          }
          durableAtSend[index] = true;
          resolveCheck();
        })().catch(rejectCheck);
      });
      req.on('end', () => {
        void (async () => {
          // Settle the first-byte check before answering, so its assertions can never
          // run after the test has finished.
          await firstCheck;
          const body = Buffer.concat(chunks);
          bodies.push(body);
          // The entire HTTP body must equal the durable frontier request body.
          const frontierEvents = await readFrontier(home);
          const requests = frontierEvents.filter((event) => event.type === 'http/request');
          const request = requests[index];
          if (!request) throw new Error('missing durable http/request');
          const durableBody = await new BlobStore(home)
            .get((request.data as unknown as { body: { sha256: string } }).body.sha256);
          expect(body.equals(durableBody)).toBe(true);
          const parsed = JSON.parse(body.toString('utf8')) as {
            messages: { role: string; content: string | null; tool_call_id?: string;
              tool_calls?: { id: string }[] }[];
          };
          if (index === 0) {
            expect(parsed.messages.at(-1)?.content).toContain('build a note');
          }
          if (index === 1) {
            const assistant = parsed.messages.find((message) => message.tool_calls?.[0]?.id === 'c1');
            expect(assistant?.tool_calls).toHaveLength(2);
            for (const id of ['c1', 'c2']) {
              expect(parsed.messages.some((message) => message.role === 'tool' && message.tool_call_id === id))
                .toBe(true);
            }
          }
          const response = index === 0
            ? { choices: [{ message: { role: 'assistant', content: 'I will write.',
                tool_calls: [{ id: 'c1', type: 'function', function: {
                  name: 'execute', arguments: JSON.stringify({ cmd: "printf 'hello' > note.txt" }),
                } }, { id: 'c2', type: 'function', function: {
                  name: 'not-execute', arguments: JSON.stringify({ cmd: 'touch forbidden.txt' }),
                } }], reasoning_content: 'retained raw reasoning' } }],
                usage: { prompt_tokens: 10, completion_tokens: 3, extra: { untouched: true } },
                unknown: { raw: ['keep', 7] } }
            : { choices: [{ message: { role: 'assistant', content: `finished-${index + 1}` } }] };
          const bytes = Buffer.from(JSON.stringify(response));
          responses.push(bytes);
          res.setHeader('content-type', 'application/json');
          res.end(bytes);
        })().catch((error: unknown) => {
          errors.push(error); res.statusCode = 500; res.end('{}');
        });
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing TCP address');
    const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const defaults = defaultAgentConfig();
    const config = { ...defaults, policy: { ...defaults.policy,
      shellTimeoutMs: 5000, killGraceMs: 20, retryDelayMs: 1, requestTimeoutMs: 1000,
    } };
    const makeRuntime = async () => createAgentRuntime({
      home, uid: 'n1', world, initialConfig: config,
      terminal: { env: DEFAULT_TERMINAL_ENV },
      adapter: await adapterFor(endpoint),
    });
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      const runtime = await makeRuntime();
      driver = await NodeDriver.open(home, 'n1', runtime.handler, world, {
        knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
        onCheckpoint: (mark) => runtime.checkpoint(mark),
      });
      running = driver.run();
      await parked(driver, world);
      expect(bodies).toHaveLength(2);
      expect(await readFile(join(world.path, 'note.txt'), 'utf8')).toBe('hello');
      await expect(access(join(world.path, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      runtime.scheduleConfig({ ...config, version: 2, heading: 'New heading, verbatim.' });
      const later = await commitAs(world, 'peer', { 'peer.txt': 'new external fact\n' });
      await HeadWatcher.for(world).check();
      await vi.waitFor(() => expect(bodies).toHaveLength(3), { timeout: 5000 });
      await parked(driver, world);
      expect(JSON.parse(bodies[2]!.toString('utf8')).messages[1].content).toBe('New heading, verbatim.');
      expect(runtime.snapshot().config?.value.version).toBe(2);
      // Every exchange crossed the frontier: each request record is durable
      // with the exact bytes the server received, and each has one terminal.
      const frontier = await readFrontier(home);
      const requests = frontier.filter((event) => event.type === 'http/request')
        .map((event) => event.data as unknown as {
          call: string; url: string; attempt: number;
          credentials: Array<{ id: string; where: string }>;
          body: { sha256: string };
        });
      const terminals = frontier.filter((event) => event.type === 'http/response')
        .map((event) => event.data as unknown as {
          call: string; status: number; error: unknown;
        });
      expect(requests).toHaveLength(bodies.length);
      expect(terminals).toHaveLength(bodies.length);
      expect(requests.every((request) => request.url === endpoint)).toBe(true);
      expect(requests.every((request) => request.attempt === 0)).toBe(true);
      expect(requests.every((request) => request.credentials.length === 1
        && request.credentials[0]!.id === 'llm'
        && request.credentials[0]!.where === 'authorization')).toBe(true);
      expect(new Set(terminals.map((terminal) => terminal.call)))
        .toEqual(new Set(requests.map((request) => request.call)));
      expect(terminals.every((terminal) => terminal.status === 200 && terminal.error === null))
        .toBe(true);
      const blobs = new BlobStore(home);
      for (const [index, request] of requests.entries()) {
        expect((await blobs.get(request.body.sha256)).equals(bodies[index]!)).toBe(true);
      }
      driver.stop();
      await running;
      running = null;
      const beforeRestart = await resolved(home);
      const turnStarts = beforeRestart.filter((event) => event.type === 'turn/start');
      expect(turnStarts).toHaveLength(2);
      expect((turnStarts[0]!.data as unknown as { world: { to: string } }).world.to).toBe(initialHead);
      expect((turnStarts[1]!.data as unknown as { world: { to: string } }).world.to).toBe(later);
      expect(beforeRestart.some((event) => event.type === 'turn/end' && event.ignorable === true)).toBe(true);
      const restarted = await makeRuntime();
      driver = await NodeDriver.open(home, 'n1', restarted.handler, world, {
        knownTypes: C13_EVENT_TYPES, hooks: restarted.hooks, worldPollMs: 0,
      });
      // open() rebuilds without a network call; run() deliberately starts a new boot turn.
      expect(bodies).toHaveLength(3);
      expect(restarted.snapshot().config?.value.heading).toBe('New heading, verbatim.');
      expect(restarted.snapshot().surface?.nodes.some((node) =>
        node.group.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'c1')))
        .toBe(true);
      running = driver.run();
      await parked(driver, world);
      expect(bodies).toHaveLength(4);
      const lastMessages = JSON.parse(bodies[3]!.toString('utf8')).messages as { content: string | null }[];
      expect(lastMessages.some((message) => message.content === 'finished-2')).toBe(true);
      expect(lastMessages.some((message) => message.content === 'finished-3')).toBe(false);
      await HeadWatcher.for(world).check();
      await HeadWatcher.for(world).check();
      expect(bodies).toHaveLength(4);
      driver.stop();
      await running;
      running = null;
      const events = await resolved(home);
      const assistants = events.filter((event) => event.type === 'assistant/message');
      expect(assistants).toHaveLength(4);
      const allFrontier = await readFrontier(home);
      const allRequests = allFrontier.filter((event) => event.type === 'http/request')
        .map((event) => event.data as unknown as { call: string; body: { sha256: string } });
      const allTerminals = allFrontier.filter((event) => event.type === 'http/response')
        .map((event) => event.data as unknown as { call: string; body: { sha256: string } });
      expect(allRequests).toHaveLength(4);
      expect(allTerminals).toHaveLength(4);
      const finalBlobs = new BlobStore(home);
      for (let index = 0; index < allRequests.length; index += 1) {
        expect((await finalBlobs.get(allRequests[index]!.body.sha256)).equals(bodies[index]!)).toBe(true);
        expect((await finalBlobs.get(allTerminals[index]!.body.sha256)).equals(responses[index]!))
          .toBe(true);
      }
      // Every assistant message names the successful frontier call that produced it.
      for (const [index, assistant] of assistants.entries()) {
        const data = assistant.data as unknown as { value: Stored<AssistantProjection> };
        expect(resolveStored(events, data.value, (value) => value as AssistantProjection).frontierCall)
          .toBe(allRequests[index]!.call);
      }
      // The perception half of the retired reconstruction survives as a helper.
      await verifyPerceptions(world, events);
      expect(durableAtSend).toEqual([true, true, true, true]);
      expect(errors).toEqual([]);
    } finally {
      const current = driver;
      driver = null;
      if (current) {
        current.stop();
        if (running) {
          await running.catch(() => { /* the assertion failure stands */ });
        } else if (current.state === 'booting' || current.state === 'active') {
          // open() succeeded but run() was never started (an assertion failed first):
          // drive it to shutdown so the writer lock is released.
          await current.run().catch(() => { /* the assertion failure stands */ });
        }
      }
      await closeServer(server);
    }
  }, 20000);

  it('folds a post-headers partial retry into one assistant message from the complete 200', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'start\n' });
    const prefix = '{"choices":';
    const requestBodies: Buffer[] = [];
    let index = 0;
    const server = createServer((req, res) => {
      const i = index;
      index += 1;
      req.on('error', () => { /* the client abort resets the socket */ });
      res.on('error', () => { /* the client abort resets the socket */ });
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requestBodies.push(Buffer.concat(chunks));
        if (i === 0) {
          // 200 headers plus a partial body, then a stall: the adapter's own timer
          // aborts the read and retries.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(prefix);
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(Buffer.from(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'partial-retry-done' } }],
          })));
        }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing TCP address');
    const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    const defaults = defaultAgentConfig();
    const config = { ...defaults, policy: { ...defaults.policy,
      maxAttempts: 2, retryDelayMs: 0, requestTimeoutMs: 250,
    } };
    const runtime = createAgentRuntime({
      home, uid: 'n1', world, initialConfig: config,
      terminal: { env: DEFAULT_TERMINAL_ENV },
      adapter: await adapterFor(endpoint),
    });
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      driver = await NodeDriver.open(home, 'n1', runtime.handler, world, {
        knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
        onCheckpoint: (mark) => runtime.checkpoint(mark),
      });
      running = driver.run();
      await parked(driver, world);
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]!.equals(requestBodies[0]!)).toBe(true);

      driver.stop();
      await running;
      running = null;

      // An offline rebuild of the exact durable history folds one assistant
      // message: the local log records the semantic result only, while the two
      // attempts and their terminals are frontier facts. (This turn produces no
      // world effect, so the driver marks its waiting closer ignorable and the
      // dialogue is not promoted into the surface.)
      const events = await resolved(home);
      const offline = new ContextFold();
      await offline.observe(events);
      expect(offline.orphanCompactions()).toEqual([]);

      const frontier = await readFrontier(home);
      const requests = frontier.filter((event) => event.type === 'http/request')
        .map((event) => event.data as unknown as {
          call: string; group: string; attempt: number; body: { sha256: string };
        });
      const terminals = frontier.filter((event) => event.type === 'http/response')
        .map((event) => event.data as unknown as {
          call: string; status: number; body: { sha256: string; complete: boolean };
        });
      expect(requests).toHaveLength(2);
      expect(terminals).toHaveLength(2);
      expect([requests[0]!.attempt, requests[1]!.attempt]).toEqual([0, 1]);
      expect(requests[1]!.group).toBe(requests[0]!.group);
      expect(requests[1]!.body.sha256).toBe(requests[0]!.body.sha256);
      expect(terminals.map((terminal) => terminal.body.complete)).toEqual([false, true]);
      expect(terminals[1]!.status).toBe(200);
      expect((await new BlobStore(home).get(terminals[0]!.body.sha256)).toString('utf8'))
        .toBe(prefix);

      const assistantEvents = events.filter((event) => event.type === 'assistant/message');
      expect(assistantEvents).toHaveLength(1);
      // The projection names the successful second attempt's call, never the
      // incomplete first attempt's.
      const stored = (assistantEvents[0]!.data as unknown as {
        value: Stored<AssistantProjection>;
      }).value;
      const projection = resolveStored(events, stored, (value) => value as AssistantProjection);
      expect(projection.frontierCall).toBe(requests[1]!.call);
      expect(projection.frontierCall).not.toBe(requests[0]!.call);

      // A second offline fold is identical: replay writes nothing.
      const again = new ContextFold();
      await again.observe(events);
      expect(again.snapshot()).toEqual(offline.snapshot());

      // The perception half of the offline join still verifies.
      await verifyPerceptions(world, events);
      expect((await resolved(home)).length).toBe(events.length);
    } finally {
      const current = driver;
      driver = null;
      if (current) {
        current.stop();
        if (running) {
          await running.catch(() => { /* the assertion failure stands */ });
        } else if (current.state === 'booting' || current.state === 'active') {
          await current.run().catch(() => { /* the assertion failure stands */ });
        }
      }
      await closeServer(server);
    }
  }, 20000);
});
