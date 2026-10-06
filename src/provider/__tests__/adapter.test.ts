import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { createBoundaryRegistry, C13_EVENT_TYPES, validateRequestPlan } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { resolveArtifact, resolveStored } from '../../context/artifacts.js';
import { defaultAgentConfig } from '../../context/config.js';
import { createBoundaryGate } from '../../node/gate.js';
import type { BoundaryGate, GateCallbacks, GateScope } from '../../node/gate.js';
import { serializeWire } from '../wire.js';
import { ProviderAdapter, type ProviderPolicy } from '../adapter.js';
import { OpenAITransport } from '../transport.js';
import type { SerializedTransport, TransportResult } from '../transport.js';
import type {
  ArtifactRef, CanonicalUsage, RequestId, RequestPlan, SeedPolicy, Source, Stored,
} from '../../context/contracts.js';

/**
 * Adapter tests: exact bytes and raw-before-projection over a real local HTTP
 * server, the malformed/lone-surrogate table, bounded retries, the oversize
 * request refusal, transport failures, and fatal flush faults. No real external
 * network is used, and the fake key never appears outside the authorization
 * header.
 */

let home = '';

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'provider-adapter-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

// --- gate/writer session ---------------------------------------------------------

type Session = {
  readonly gate: (phase: 'ready' | 'turn', turn: number | null) => BoundaryGate;
  readonly controller: AbortController;
  readonly shutdown: () => Promise<void>;
};

/** The D1-style standalone gate session: real writer, real registry, real lookup. */
async function openSession(): Promise<Session> {
  const writer = await JournalWriter.open(home, 'n1');
  const controller = new AbortController();
  const receipts = new Map<string, EventEnvelope>();
  const record = (receipt: EventEnvelope): EventEnvelope => {
    receipts.set(`${receipt.seq}:${receipt.hash}`, receipt);
    return receipt;
  };
  const lookup = (source: Source): EventEnvelope | null =>
    receipts.get(`${source.seq}:${source.hash}`) ?? null;
  const callbacks: GateCallbacks = {
    append: (type: string, data: JsonValue) => record(writer.append(type, data)),
    flush: () => writer.flush(),
    lookup,
    readBlob: (hash: string) => new BlobStore(home).get(hash),
    now: () => 100,
  };
  const closes: Array<() => void> = [];
  const gate = (phase: 'ready' | 'turn', turn: number | null): BoundaryGate => {
    const scope: GateScope = { phase, turn, signal: controller.signal, lookup };
    const created = createBoundaryGate(createBoundaryRegistry(), scope, callbacks);
    closes.push(created.close);
    return created.gate;
  };
  const shutdown = async (): Promise<void> => {
    for (const close of closes) close();
    try { await writer.close(); } catch { /* the assertion stands */ }
    controller.abort();
  };
  return { gate, controller, shutdown };
}

const events = (): ReturnType<typeof loadVerifiedEvents> =>
  loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);

function ofType(list: Awaited<ReturnType<typeof events>>, type: string): EventEnvelope[] {
  return list.filter((event) => event.type === type);
}

// --- policy injection ------------------------------------------------------------

const delay = (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error('cancelled')); return; }
  const onAbort = (): void => { clearTimeout(timer); reject(new Error('cancelled')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

function policies(over: Partial<ProviderPolicy> = {}): ProviderPolicy {
  return {
    now: () => Date.now(),
    delay,
    schedule: (ms: number, callback: () => void) => {
      const timer = setTimeout(callback, ms);
      return () => { clearTimeout(timer); };
    },
    ...over,
  };
}

/** A transport that replays scripted results; the last result repeats. */
class ScriptedTransport implements SerializedTransport {
  sends = 0;
  constructor(private readonly results: TransportResult[]) {}
  async post(_body: Uint8Array, _signal: AbortSignal, _maxBytes: number): Promise<TransportResult> {
    const result = this.results[Math.min(this.sends, this.results.length - 1)]!;
    this.sends += 1;
    return result;
  }
}

function transportResult(body: Uint8Array | string, status = 200): TransportResult {
  return {
    status, body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
    complete: true, failure: null,
  };
}

// --- plan fixture ----------------------------------------------------------------

function seedPolicy(over: Partial<SeedPolicy> = {}): SeedPolicy {
  return {
    ...defaultAgentConfig().policy,
    maxAttempts: 1, retryDelayMs: 0, requestTimeoutMs: 1000,
    ...over,
  };
}

function plan(over: Partial<RequestPlan> = {}): RequestPlan {
  return {
    id: { turn: 0, ordinal: 0 }, config: { seq: 0, hash: '0'.repeat(64) },
    stateHash: 'a'.repeat(64), model: 'mock-model', parameters: { temperature: 0 },
    policy: seedPolicy(),
    tools: [{ name: 'execute', description: 'run', parameters: { type: 'object' } }],
    toolsHash: 'b'.repeat(64),
    sections: [
      { name: 'tools', cache: 'stable', sources: [] },
      { name: 'charter', cache: 'stable', sources: [] },
      { name: 'heading', cache: 'stable', sources: [] },
      { name: 'history', cache: 'advance', sources: [] },
      { name: 'queue', cache: 'volatile', sources: [] },
    ],
    history: [], queue: [], charter: 'charter text', heading: 'heading text',
    ...over,
  };
}

function validBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'hello' } }], ...over,
  });
}

// --- server helpers --------------------------------------------------------------

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1/chat/completions`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
}

// --- HTTP acceptance -------------------------------------------------------------

describe('ProviderAdapter: real HTTP acceptance', () => {
  it('sends exact durable bytes and preserves unknown fields/usage in response/raw', async () => {
    const session = await openSession();
    const request = plan();
    const responses: Buffer[] = [];
    const requestBodies: Buffer[] = [];
    const auth: Array<string | undefined> = [];
    let index = 0;
    const server = createServer((req, res) => {
      const i = index;
      index += 1;
      auth.push(req.headers.authorization);
      const chunks: Buffer[] = [];
      let checked = false;
      let resolveCheck!: () => void;
      const check = new Promise<void>((resolve) => { resolveCheck = resolve; });
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (checked) return;
        checked = true;
        // Read the durable plan/wire on the FIRST request data: it proves they
        // were durable before the handler answered.
        void (async () => {
          const durable = await events();
          const wire = ofType(durable, 'request/wire')[i];
          const planEvent = ofType(durable, 'request/plan')[i];
          if (!wire || !planEvent) throw new Error('plan/wire not durable at first byte');
          const wireData = wire.data as unknown as { id: RequestId; body: ArtifactRef };
          const planData = planEvent.data as unknown as { id: RequestId; value: Stored<RequestPlan> };
          const recorded = resolveStored(durable, planData.value, validateRequestPlan);
          const durableBody = Buffer.from(resolveArtifact(durable, wireData.body));
          expect(wireData.id).toEqual(planData.id);
          expect(Buffer.from(serializeWire(recorded)).equals(durableBody)).toBe(true);
          resolveCheck();
        })().catch(() => { resolveCheck(); });
      });
      req.on('end', () => {
        void (async () => {
          await check;
          requestBodies.push(Buffer.concat(chunks));
          const body = Buffer.from(JSON.stringify({
            choices: [{
              message: {
                role: 'assistant', content: 'hello', tool_calls: [],
                reasoning_content: 'retained raw reasoning',
              },
              finish_reason: 'stop',
            }],
            usage: {
              prompt_tokens: 100, completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 70 }, unknown: true,
            },
            unknown: { nested: ['keep', 7] },
          }));
          responses.push(body);
          res.setHeader('content-type', 'application/json');
          res.end(body);
        })();
      });
    });
    const endpoint = await listen(server);
    try {
      const adapter = new ProviderAdapter(
        new OpenAITransport({ endpoint, key: 'test-key-never-log' }), policies(),
      );
      const result = await adapter.send(request, session.gate('turn', 0));
      expect(result.kind).toBe('response');
      if (result.kind === 'response') {
        expect(result.projection.message).toEqual({
          role: 'assistant', content: 'hello', tool_calls: [],
        });
        expect(result.projection.contentTruncated).toBe(false);
      }

      const durable = await events();
      const raw = ofType(durable, 'response/raw')[0]!;
      const rawRef = (raw.data as unknown as { body: ArtifactRef }).body;
      expect(rawRef.complete).toBe(true);
      expect(Buffer.from(resolveArtifact(durable, rawRef)).equals(responses[0]!)).toBe(true);

      const usageEvent = ofType(durable, 'request/usage')[0]!;
      expect((usageEvent.data as unknown as { value: CanonicalUsage }).value).toEqual({
        inputTotal: 100, inputUncached: 30, output: 5, cacheRead: 70, cacheWrite: null,
      });
      expect(ofType(durable, 'assistant/message')).toHaveLength(1);

      expect(auth).toEqual(['Bearer test-key-never-log']);
      expect(Buffer.from(requestBodies[0]!).equals(Buffer.from(serializeWire(request)))).toBe(true);
      expect(JSON.stringify(durable.map((event) => event.data))).not.toContain('test-key-never-log');
    } finally {
      await session.shutdown();
      await close(server);
    }
  });
});

// --- malformed table -------------------------------------------------------------

const MALFORMED: ReadonlyArray<readonly [string, Uint8Array | string]> = [
  ['an empty object', '{}'],
  ['invalid JSON', 'not json at all'],
  ['invalid UTF-8 bytes', Buffer.from([0xff, 0xfe, 0x00])],
  ['a content array', JSON.stringify({ choices: [{ message: { role: 'assistant', content: ['x'] } }] })],
  ['duplicate tool call ids', JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'execute', arguments: '{}' } },
      { id: 'c1', type: 'function', function: { name: 'execute', arguments: '{}' } },
    ] } }] })],
];

describe('ProviderAdapter: malformed responses', () => {
  it.each(MALFORMED)('journals the raw body then fails terminally: %s', async (_name, body) => {
    const session = await openSession();
    try {
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      const adapter = new ProviderAdapter(
        new ScriptedTransport([transportResult(bytes)]), policies(),
      );
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'malformed', status: 200 } });

      const durable = await events();
      const raw = ofType(durable, 'response/raw');
      expect(raw).toHaveLength(1);
      const rawRef = (raw[0]!.data as unknown as { body: ArtifactRef }).body;
      expect(Buffer.from(resolveArtifact(durable, rawRef)).equals(Buffer.from(bytes))).toBe(true);
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      expect(ofType(durable, 'request/usage')).toHaveLength(0);
      expect(ofType(durable, 'tool/call')).toHaveLength(0);
      expect(ofType(durable, 'assistant/attempt')).toHaveLength(1);
    } finally {
      await session.shutdown();
    }
  });
});

describe('ProviderAdapter: unprojectable lone surrogates', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['in content', '{"choices":[{"message":{"role":"assistant","content":"\\ud800"}}]}'],
    ['in call arguments', '{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":['
      + '{"id":"c1","type":"function","function":{"name":"execute","arguments":"\\ud800"}}]}}]}'],
  ];

  it.each(cases)('is a safe terminal malformed failure after raw durability: %s', async (_name, body) => {
    const session = await openSession();
    try {
      // The body is UTF-8-valid JSON and parses; it fails only when projected.
      expect(() => JSON.parse(body)).not.toThrow();
      const adapter = new ProviderAdapter(
        new ScriptedTransport([transportResult(body)]), policies(),
      );
      // Must resolve to a failure, never reject as a fatal kernel error.
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'malformed', status: 200 } });

      const durable = await events();
      expect(ofType(durable, 'response/raw')).toHaveLength(1);
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      expect(ofType(durable, 'request/usage')).toHaveLength(0);
    } finally {
      await session.shutdown();
    }
  });
});

// --- retries ---------------------------------------------------------------------

describe('ProviderAdapter: bounded retries', () => {
  it('retries 429 then 200 reusing identical wire bytes on one RequestId', async () => {
    const session = await openSession();
    const request = plan({ policy: seedPolicy({ maxAttempts: 2 }) });
    let index = 0;
    const server = createServer((req, res) => {
      const i = index;
      index += 1;
      req.on('data', () => { /* drain */ });
      req.on('end', () => {
        if (i === 0) { res.statusCode = 429; res.end('{"error":"slow down"}'); }
        else { res.end(validBody()); }
      });
    });
    const endpoint = await listen(server);
    try {
      const adapter = new ProviderAdapter(
        new OpenAITransport({ endpoint, key: 'k' }), policies(),
      );
      const result = await adapter.send(request, session.gate('turn', 0));
      expect(result.kind).toBe('response');

      const durable = await events();
      const wires = ofType(durable, 'request/wire');
      expect(wires).toHaveLength(2);
      const first = (wires[0]!.data as unknown as { body: ArtifactRef; attempt: number });
      const second = (wires[1]!.data as unknown as { body: ArtifactRef; attempt: number });
      expect(first.attempt).toBe(0);
      expect(second.attempt).toBe(1);
      expect(second.body).toEqual(first.body);
      expect(Buffer.from(resolveArtifact(durable, first.body))
        .equals(Buffer.from(resolveArtifact(durable, second.body)))).toBe(true);

      expect(ofType(durable, 'response/raw').map(
        (event) => (event.data as unknown as { status: number }).status)).toEqual([429, 200]);
      const attempts = ofType(durable, 'assistant/attempt');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.data).toMatchObject({ terminal: false, failure: { code: 'http', status: 429 } });
      expect(ofType(durable, 'assistant/message')).toHaveLength(1);
      expect(ofType(durable, 'request/usage')).toHaveLength(1);
    } finally {
      await session.shutdown();
      await close(server);
    }
  });
});

// --- oversize request refusal ----------------------------------------------------

describe('ProviderAdapter: oversize request refusal below the ceiling', () => {
  it('stores the plan, then journals a terminal request-limit attempt with no send', async () => {
    const session = await openSession();
    const request = plan({
      history: [{ role: 'user', content: 'x'.repeat(2000) }],
      policy: seedPolicy({ maxRequestBytes: 64 }),
    });
    const transport = new ScriptedTransport([transportResult(validBody())]);
    try {
      const adapter = new ProviderAdapter(transport, policies());
      const result = await adapter.send(request, session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'request-limit', status: null } });
      expect(transport.sends).toBe(0);

      const durable = await events();
      expect(ofType(durable, 'request/plan')).toHaveLength(1);
      expect(ofType(durable, 'request/wire')).toHaveLength(0);
      expect(ofType(durable, 'response/raw')).toHaveLength(0);
      const attempts = ofType(durable, 'assistant/attempt');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.data).toMatchObject({
        terminal: true, failure: { code: 'request-limit', status: null },
      });
    } finally {
      await session.shutdown();
    }
  });
});

// --- transport failures ----------------------------------------------------------

describe('ProviderAdapter: transport failures', () => {
  it('journals a safe network marker when the socket closes before headers', async () => {
    const session = await openSession();
    const server = createServer();
    server.on('connection', (socket) => { socket.destroy(); });
    const endpoint = await listen(server);
    try {
      const adapter = new ProviderAdapter(new OpenAITransport({ endpoint, key: 'k' }), policies());
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'network', status: null } });
      const durable = await events();
      expect(ofType(durable, 'response/raw')).toHaveLength(0);
      expect(ofType(durable, 'assistant/attempt')[0]!.data).toMatchObject({
        terminal: true, failure: { code: 'network', status: null },
      });
    } finally {
      await session.shutdown();
      await close(server);
    }
  });

  it('times out a hanging response and clears its timer', async () => {
    const session = await openSession();
    const server = createServer((req) => { req.on('data', () => { /* never answer */ }); });
    const endpoint = await listen(server);
    let cleared = 0;
    try {
      const adapter = new ProviderAdapter(new OpenAITransport({ endpoint, key: 'k' }), policies({
        schedule: (ms, callback) => {
          const timer = setTimeout(callback, ms);
          return () => { cleared += 1; clearTimeout(timer); };
        },
      }));
      const result = await adapter.send(
        plan({ policy: seedPolicy({ requestTimeoutMs: 40 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({ kind: 'failure', failure: { code: 'timeout', status: null } });
      expect(cleared).toBeGreaterThan(0);
      expect(ofType(await events(), 'assistant/attempt')[0]!.data)
        .toMatchObject({ terminal: true, failure: { code: 'timeout', status: null } });
    } finally {
      await session.shutdown();
      await close(server);
    }
  });

  it('preserves a partial artifact and journals body-limit when the body exceeds the cap', async () => {
    const session = await openSession();
    const server = createServer((_req, res) => { res.end(validBody({ padding: 'z'.repeat(200) })); });
    const endpoint = await listen(server);
    try {
      const adapter = new ProviderAdapter(new OpenAITransport({ endpoint, key: 'k' }), policies());
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxCaptureBytes: 32 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({ kind: 'failure', failure: { code: 'body-limit', status: 200 } });
      const durable = await events();
      const raw = ofType(durable, 'response/raw')[0]!;
      const data = raw.data as unknown as { body: ArtifactRef; complete: boolean };
      expect(data.complete).toBe(false);
      expect(data.body.bytes).toBe(32);
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      expect(ofType(durable, 'request/usage')).toHaveLength(0);
      expect(ofType(durable, 'tool/call')).toHaveLength(0);
    } finally {
      await session.shutdown();
      await close(server);
    }
  });

  it('cancels a stop during the body with no later send', async () => {
    const session = await openSession();
    let received!: () => void;
    const gotRequest = new Promise<void>((resolve) => { received = resolve; });
    const server = createServer((req) => { req.on('data', () => received()); });
    const endpoint = await listen(server);
    try {
      const adapter = new ProviderAdapter(
        new OpenAITransport({ endpoint, key: 'k' }),
        policies({ schedule: (ms, callback) => {
          const timer = setTimeout(callback, ms);
          return () => { clearTimeout(timer); };
        } }),
      );
      const sending = adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2, requestTimeoutMs: 60_000 }) }),
        session.gate('turn', 0),
      );
      await gotRequest;
      session.controller.abort();
      const result = await sending;
      expect(result).toEqual({ kind: 'failure', failure: { code: 'cancelled', status: null } });
      expect(ofType(await events(), 'request/wire')).toHaveLength(1);
    } finally {
      await session.shutdown();
      await close(server);
    }
  });

  it('cancels a stop during the retry delay with no later send', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([
      { status: 500, body: Buffer.from('{}'), complete: true, failure: null },
      transportResult(validBody()),
    ]);
    const adapter = new ProviderAdapter(transport, policies({
      delay: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
    }));
    try {
      const sending = adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2 }) }), session.gate('turn', 0),
      );
      await vi.waitFor(async () => {
        expect(ofType(await events(), 'assistant/attempt')).toHaveLength(1);
      });
      session.controller.abort();
      const result = await sending;
      expect(result).toEqual({ kind: 'failure', failure: { code: 'cancelled', status: null } });
      expect(transport.sends).toBe(1);
      expect(ofType(await events(), 'request/wire')).toHaveLength(1);
    } finally {
      await session.shutdown();
    }
  });
});

// --- the fake key -----------------------------------------------------------------

describe('ProviderAdapter: the fake key never reaches an event', () => {
  it('drops a transport error message that embeds the key', async () => {
    const session = await openSession();
    class ThrowingTransport implements SerializedTransport {
      async post(): Promise<TransportResult> {
        throw new Error('connect failed using test-key-never-log');
      }
    }
    try {
      const adapter = new ProviderAdapter(new ThrowingTransport(), policies());
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'network', status: null } });
      const durable = await events();
      expect(JSON.stringify(durable.map((event) => event.data))).not.toContain('test-key-never-log');
    } finally {
      await session.shutdown();
    }
  });
});

// --- fatal flush faults ----------------------------------------------------------

function flushFaultGate(gate: BoundaryGate, failOnCall: number): BoundaryGate {
  let flushes = 0;
  return new Proxy(gate, {
    get(target, prop, receiver) {
      if (prop === 'flush') {
        return async (): Promise<void> => {
          flushes += 1;
          if (flushes === failOnCall) throw new Error('injected flush failure');
          await target.flush();
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('ProviderAdapter: fatal flush faults are never swallowed', () => {
  it('rethrows a response/raw flush failure and projects nothing', async () => {
    const session = await openSession();
    try {
      const adapter = new ProviderAdapter(
        new ScriptedTransport([transportResult(validBody())]), policies(),
      );
      // Flush #1 is the wire barrier, #2 is the response/raw flush.
      const faulty = flushFaultGate(session.gate('turn', 0), 2);
      await expect(adapter.send(plan(), faulty)).rejects.toThrow('injected flush failure');

      let durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      expect(ofType(durable, 'request/usage')).toHaveLength(0);
      expect(ofType(durable, 'tool/call')).toHaveLength(0);
      // Restart: the same facts still cause no replayed model/tool calls.
      await session.shutdown();
      durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      expect(ofType(durable, 'tool/call')).toHaveLength(0);
    } finally {
      await session.shutdown();
    }
  });

  it('rethrows a projection flush failure rather than returning a failure result', async () => {
    const session = await openSession();
    try {
      const adapter = new ProviderAdapter(
        new ScriptedTransport([transportResult(validBody())]), policies(),
      );
      // Flush #3 is the final projection barrier.
      const faulty = flushFaultGate(session.gate('turn', 0), 3);
      await expect(adapter.send(plan(), faulty)).rejects.toThrow('injected flush failure');
    } finally {
      await session.shutdown();
    }
  });
});
