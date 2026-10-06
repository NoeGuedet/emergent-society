import { createServer, type Server } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '../../journal/index.js';
import { loadVerifiedEvents, type VerifiedEvents } from '../../context/loader.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { resolveArtifact, resolveStored, toJson } from '../../context/artifacts.js';
import { validateRequestPlan } from '../../context/events.js';
import { rederivePlans } from '../../context/assembler.js';
import { serializeWire } from '../../provider/wire.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import { OpenAITransport } from '../../provider/transport.js';
import { NodeDriver } from '../driver.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import { HeadWatcher } from '../watcher.js';
import { commitAs, useWorld } from './helpers.js';
import type { ArtifactRef, RequestId, RequestPlan, Stored } from '../../context/contracts.js';

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
        // Read the durable plan/wire once the request starts arriving. This async read
        // proves they were durable before the handler answered; it does not prove a
        // first-byte instant barrier — the fault fixture proves that ordering.
        void (async () => {
          const events = await resolved(home);
          const wire = events.filter((event) => event.type === 'request/wire')[index];
          const plan = events.filter((event) => event.type === 'request/plan')[index];
          if (!wire || !plan) throw new Error('plan/wire not durable at first byte');
          const wireData = wire.data as unknown as { id: RequestId; body: ArtifactRef };
          const planData = plan.data as unknown as { id: RequestId; value: Stored<RequestPlan> };
          const recorded = resolveStored(events, planData.value, validateRequestPlan);
          const durableBody = Buffer.from(resolveArtifact(events, wireData.body));
          expect(wireData.id).toEqual(planData.id);
          expect(Buffer.from(serializeWire(recorded)).equals(durableBody)).toBe(true);
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
          // The entire HTTP body must equal the durable wire body captured on arrival.
          const events = await resolved(home);
          const wire = events.filter((event) => event.type === 'request/wire')[index];
          if (!wire) throw new Error('missing durable wire');
          const durableBody = Buffer.from(
            resolveArtifact(events, (wire.data as unknown as { body: ArtifactRef }).body));
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
      shellTimeoutMs: 1000, killGraceMs: 20, retryDelayMs: 1, requestTimeoutMs: 1000,
    } };
    const shellPolicy = {
      timeoutMs: config.policy.shellTimeoutMs, killGraceMs: config.policy.killGraceMs,
      maxCaptureBytes: config.policy.maxShellCaptureBytes,
      drainDeadlineMs: config.policy.shellDrainMs,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb' },
    };
    const makeRuntime = () => createAgentRuntime({
      home, uid: 'n1', world, initialConfig: config, shellPolicy,
      adapter: new ProviderAdapter(new OpenAITransport({ endpoint, key: 'test-key-never-log' }), {
        now: () => 100, delay,
        schedule: (ms, callback) => {
          const timer = setTimeout(callback, ms);
          return () => { clearTimeout(timer); };
        },
      }),
    });
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      const runtime = makeRuntime();
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
      driver.stop();
      await running;
      running = null;
      const beforeRestart = await resolved(home);
      const turnStarts = beforeRestart.filter((event) => event.type === 'turn/start');
      expect(turnStarts).toHaveLength(2);
      expect((turnStarts[0]!.data as unknown as { world: { to: string } }).world.to).toBe(initialHead);
      expect((turnStarts[1]!.data as unknown as { world: { to: string } }).world.to).toBe(later);
      expect(beforeRestart.some((event) => event.type === 'turn/end' && event.ignorable === true)).toBe(true);
      const restarted = makeRuntime();
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
      const plans = events.filter((event) => event.type === 'request/plan');
      const wires = events.filter((event) => event.type === 'request/wire');
      const raws = events.filter((event) => event.type === 'response/raw');
      expect(plans).toHaveLength(4);
      expect(wires).toHaveLength(4);
      expect(raws).toHaveLength(4);
      for (let index = 0; index < wires.length; index += 1) {
        const planData = plans[index]!.data as unknown as { id: RequestId; value: Stored<RequestPlan> };
        const plan = resolveStored(events, planData.value, validateRequestPlan);
        const wireRef = (wires[index]!.data as unknown as { body: ArtifactRef }).body;
        expect(Buffer.from(resolveArtifact(events, wireRef)).equals(bodies[index]!)).toBe(true);
        expect(Buffer.from(serializeWire(plan)).equals(bodies[index]!)).toBe(true);
        const rawRef = (raws[index]!.data as unknown as { body: ArtifactRef }).body;
        expect(Buffer.from(resolveArtifact(events, rawRef)).equals(responses[index]!)).toBe(true);
      }
      const comparisons = await rederivePlans(events, world);
      expect(comparisons).toHaveLength(4);
      for (const comparison of comparisons) {
        expect(canonicalizeJson(toJson(comparison.rederived)))
          .toBe(canonicalizeJson(toJson(comparison.recorded)));
      }
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
});
