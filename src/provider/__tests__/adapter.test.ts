import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { createBoundaryRegistry, C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { defaultAgentConfig } from '../../context/config.js';
import { createBoundaryGate } from '../../node/gate.js';
import type { BoundaryGate, GateCallbacks, GateScope } from '../../node/gate.js';
import { failFrontierFlushes, openTestFrontier, readFrontier } from '../../frontier/__tests__/helpers.js';
import type { Frontier, FrontierJournal } from '../../frontier/index.js';
import { serializeWire } from '../wire.js';
import { ProviderAdapter, type ProviderPolicy } from '../adapter.js';
import { OpenAITransport } from '../transport.js';
import type { SerializedTransport, TransportFacts, TransportResult } from '../transport.js';
import type {
  AssistantProjection, RequestPlan, SeedPolicy, Source, Stored,
} from '../../context/contracts.js';

/**
 * Adapter tests: exact bytes and raw-before-projection over a real local HTTP
 * server, the malformed/lone-surrogate table, bounded retries, the oversize
 * request refusal, transport failures, and fatal flush faults. No real external
 * network is used, and the fake key never appears outside the authorization
 * header. Every adapter runs against a real frontier journal, opened lazily by
 * the first adapter that needs it and closed before the temp home is removed.
 */

let home = '';
let frontier: FrontierJournal | null = null;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'provider-adapter-'));
  frontier = null;
});
afterEach(async () => {
  vi.restoreAllMocks();
  const journal = frontier;
  frontier = null;
  // A fault-poisoned writer may reject its close; the home still goes away.
  if (journal !== null) await journal.close().catch(() => {});
  await rm(home, { recursive: true, force: true });
});

// --- the frontier session ---------------------------------------------------------

/** The test's own frontier journal: opened once, closed in `afterEach`. */
async function openFrontier(): Promise<FrontierJournal> {
  if (frontier === null) frontier = await openTestFrontier(home);
  return frontier;
}

/** An adapter bound to this test's frontier journal. */
async function adapterWith(
  transport: SerializedTransport, policy: ProviderPolicy = policies(),
): Promise<ProviderAdapter> {
  return new ProviderAdapter(transport, policy, (await openFrontier()).gate);
}

/** The facts a test transport declares (the fixture endpoint and credential id). */
const TEST_FACTS: TransportFacts = {
  url: 'https://test.invalid/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  credentialId: 'test',
};

type FrontierRequestData = {
  readonly call: string; readonly group: string; readonly attempt: number;
  readonly method: string; readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentials: ReadonlyArray<{ readonly id: string; readonly where: string }>;
  readonly body: { readonly encoding: string; readonly sha256: string; readonly bytes: number;
    readonly complete: boolean };
  readonly world_head: string | null;
};

type FrontierResponseData = {
  readonly call: string; readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly encoding: string; readonly sha256: string; readonly bytes: number;
    readonly complete: boolean };
  readonly timing: { readonly durationMs: number };
  readonly error: { readonly code: string } | null;
};

/** The frontier requests and terminals the journal serves, in order. */
async function frontierRecords(): Promise<{
  readonly requests: FrontierRequestData[]; readonly responses: FrontierResponseData[];
}> {
  const events = await readFrontier(home);
  return {
    requests: events.filter((event) => event.type === 'http/request')
      .map((event) => event.data as unknown as FrontierRequestData),
    responses: events.filter((event) => event.type === 'http/response')
      .map((event) => event.data as unknown as FrontierResponseData),
  };
}

/** The exact bytes a frontier body reference names. */
function frontierBody(ref: { readonly sha256: string }): Promise<Buffer> {
  return new BlobStore(home).get(ref.sha256);
}

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
  readonly facts: TransportFacts = TEST_FACTS;
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
    status, headers: {}, body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
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
  it('sends exact durable bytes and journals the exchange on the frontier', async () => {
    const session = await openSession();
    const request = plan();
    const responses: Buffer[] = [];
    const requestBodies: Buffer[] = [];
    const auth: Array<string | undefined> = [];
    // A failed barrier must fail the test, never resolve it. In particular an
    // assertion thrown in the async check and the not-durable error both land
    // here; the server then never answers, so the adapter's own timeout keeps
    // the test from hanging.
    const errors: unknown[] = [];
    let index = 0;
    const server = createServer((req, res) => {
      const i = index;
      index += 1;
      auth.push(req.headers.authorization);
      const chunks: Buffer[] = [];
      let checked = false;
      let resolveCheck!: () => void;
      let rejectCheck!: (error: unknown) => void;
      const check = new Promise<void>((resolve, reject) => {
        resolveCheck = resolve; rejectCheck = reject;
      });
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (checked) return;
        checked = true;
        // Read the frontier on the FIRST request data: the http/request record
        // proves the exchange was durable before the handler answered.
        void (async () => {
          const durable = await readFrontier(home);
          const requests = durable.filter((event) => event.type === 'http/request');
          if (requests.length !== i + 1) throw new Error('http/request not durable at first byte');
          resolveCheck();
        })().catch(rejectCheck);
      });
      req.on('end', () => {
        void (async () => {
          try {
            await check;
          } catch (error) {
            // Already recorded by the barrier; do not answer a failed check.
            errors.push(error);
            return;
          }
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
      const adapter = await adapterWith(
        new OpenAITransport({ endpoint, key: 'test-key-never-log' }),
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
      // The local log keeps the semantic assistant fact and none of the retired
      // wire/usage/attempt types.
      const types = new Set(durable.map((event) => event.type));
      for (const retired of [
        'request/plan', 'request/wire', 'response/raw', 'request/usage', 'assistant/attempt',
      ]) expect(types.has(retired)).toBe(false);
      const assistant = ofType(durable, 'assistant/message');
      expect(assistant).toHaveLength(1);
      const storedProjection = (assistant[0]!.data as unknown as {
        value: Stored<AssistantProjection>;
      }).value;
      expect(storedProjection.kind).toBe('inline');
      const projection = storedProjection.kind === 'inline'
        ? storedProjection.value : null;
      const { requests } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(projection?.frontierCall).toBe(requests[0]!.call);

      expect(auth).toEqual(['Bearer test-key-never-log']);
      expect(Buffer.from(requestBodies[0]!).equals(Buffer.from(serializeWire(request)))).toBe(true);
      expect(JSON.stringify(durable.map((event) => event.data))).not.toContain('test-key-never-log');
      // The frontier journal carries the non-secret facts only — never the key.
      const frontierEvents = await readFrontier(home);
      expect(JSON.stringify(frontierEvents.map((event) => event.data)))
        .not.toContain('test-key-never-log');
      const requestEvent = frontierEvents.find((event) => event.type === 'http/request')!;
      expect((requestEvent.data as unknown as { headers: Record<string, string> }).headers)
        .toEqual({ 'content-type': 'application/json' });
      // The frontier response body is the exact bytes the server sent.
      const responseEvent = frontierEvents.find((event) => event.type === 'http/response')!;
      expect((await frontierBody((responseEvent.data as unknown as FrontierResponseData).body))
        .equals(responses[0]!)).toBe(true);
      // The durability barrier's failures are assertions, not swallowed work.
      expect(errors).toEqual([]);
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
  it.each(MALFORMED)('journals the frontier terminal then fails terminally: %s', async (_name, body) => {
    const session = await openSession();
    try {
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      const adapter = await adapterWith(new ScriptedTransport([transportResult(bytes)]));
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'malformed', status: 200 } });

      const durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      expect(ofType(durable, 'tool/call')).toHaveLength(0);
      expect(durable.some((event) => [
        'request/plan', 'request/wire', 'response/raw', 'request/usage', 'assistant/attempt',
      ].includes(event.type))).toBe(false);

      // The malformed body is a local failure AFTER the frontier record: the
      // exchange's terminal is the outcome classified at the exchange — a
      // complete 200 with no frontier error — and the exact received bytes.
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.call).toBe(requests[0]!.call);
      expect(responses[0]!.status).toBe(200);
      expect(responses[0]!.error).toBeNull();
      expect(responses[0]!.body.complete).toBe(true);
      expect((await frontierBody(responses[0]!.body)).equals(Buffer.from(bytes))).toBe(true);
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

  it.each(cases)('is a safe terminal malformed failure with no local event: %s', async (_name, body) => {
    const session = await openSession();
    try {
      // The body is UTF-8-valid JSON and parses; it fails only when projected.
      expect(() => JSON.parse(body)).not.toThrow();
      const adapter = await adapterWith(new ScriptedTransport([transportResult(body)]));
      // Must resolve to a failure, never reject as a fatal kernel error.
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'malformed', status: 200 } });

      expect(ofType(await events(), 'assistant/message')).toHaveLength(0);
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
      const adapter = await adapterWith(new OpenAITransport({ endpoint, key: 'k' }));
      const result = await adapter.send(request, session.gate('turn', 0));
      expect(result.kind).toBe('response');

      const durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(1);
      expect(durable.some((event) => [
        'request/plan', 'request/wire', 'response/raw', 'request/usage', 'assistant/attempt',
      ].includes(event.type))).toBe(false);

      // One logical operation across the frontier: the retry re-begins with the
      // same group, an incremented attempt and the same body digest (one blob).
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(2);
      expect(requests[0]!.attempt).toBe(0);
      expect(requests[1]!.attempt).toBe(1);
      expect(requests[1]!.group).toBe(requests[0]!.group);
      expect(requests[1]!.call).not.toBe(requests[0]!.call);
      expect(requests[1]!.body.sha256).toBe(requests[0]!.body.sha256);
      expect(responses.map((response) => response.status)).toEqual([429, 200]);
      expect(responses[0]!.error).toEqual({ code: 'http' });
      expect(responses[1]!.error).toBeNull();
      // Each attempt's body is the exact wire bytes the server received.
      expect((await frontierBody(requests[0]!.body))
        .equals(Buffer.from(serializeWire(request)))).toBe(true);
    } finally {
      await session.shutdown();
      await close(server);
    }
  });
});

// --- the retry-status matrix and the anti-abuse projection bounds ----------------

const RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504] as const;
const TERMINAL_STATUS = [400, 401, 403, 404, 422] as const;

describe('ProviderAdapter: retry-status matrix', () => {
  it.each(RETRYABLE_STATUS)('retries HTTP %i exactly once more under maxAttempts 2', async (status) => {
    const session = await openSession();
    const transport = new ScriptedTransport([
      transportResult('{"error":"retry me"}', status),
      transportResult(validBody()),
    ]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2 }) }), session.gate('turn', 0),
      );
      expect(result.kind).toBe('response');
      expect(transport.sends).toBe(2);
      const { responses } = await frontierRecords();
      expect(responses.map((response) => response.status)).toEqual([status, 200]);
      expect(responses[0]!.error).toEqual({ code: 'http' });
    } finally {
      await session.shutdown();
    }
  });

  it.each(TERMINAL_STATUS)('treats HTTP %i as terminal with no second send', async (status) => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult('{"error":"no"}', status)]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({ kind: 'failure', failure: { code: 'http', status } });
      expect(transport.sends).toBe(1);
      const { responses } = await frontierRecords();
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(status);
      expect(responses[0]!.error).toEqual({ code: 'http' });
    } finally {
      await session.shutdown();
    }
  });

  it('never retries a malformed projection under maxAttempts 2', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult('not json at all')]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({
        kind: 'failure', failure: { code: 'malformed', status: 200 },
      });
      expect(transport.sends).toBe(1);
    } finally {
      await session.shutdown();
    }
  });

  it('never retries a body-limit under maxAttempts 2', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([{
      status: 200, headers: {}, body: Buffer.from('{"choices":'), complete: false,
      failure: { code: 'body-limit', status: 200 },
    }]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({
        kind: 'failure', failure: { code: 'body-limit', status: 200 },
      });
      expect(transport.sends).toBe(1);
      const { responses } = await frontierRecords();
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(200);
      expect(responses[0]!.error).toEqual({ code: 'body-limit' });
      expect(responses[0]!.body.complete).toBe(false);
    } finally {
      await session.shutdown();
    }
  });

  it('never retries a request-limit: the refusal precedes any send', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult(validBody())]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2, maxRequestBytes: 1 }) }),
        session.gate('turn', 0),
      );
      expect(result).toEqual({
        kind: 'failure', failure: { code: 'request-limit', status: null },
      });
      expect(transport.sends).toBe(0);
    } finally {
      await session.shutdown();
    }
  });
});

describe('ProviderAdapter: anti-abuse projection bounds', () => {
  const twoCalls = JSON.stringify({
    choices: [{
      message: {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'execute', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'execute', arguments: '{}' } },
        ],
      },
    }],
  });

  it('refuses more calls than maxCallsPerResponse as a bounded malformed failure', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult(twoCalls)]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxCallsPerResponse: 1 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({
        kind: 'failure', failure: { code: 'malformed', status: 200 },
      });
      // The refusal happens after the one response: no retry, no projection.
      expect(transport.sends).toBe(1);
      expect(ofType(await events(), 'assistant/message')).toHaveLength(0);
      expect((await frontierRecords()).responses).toHaveLength(1);
    } finally {
      await session.shutdown();
    }
  });

  it('refuses arguments over maxToolArgumentBytes as a bounded malformed failure', async () => {
    const session = await openSession();
    const body = JSON.stringify({
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'c1', type: 'function',
            function: { name: 'execute', arguments: JSON.stringify({ cmd: 'x'.repeat(64) }) },
          }],
        },
      }],
    });
    const transport = new ScriptedTransport([transportResult(body)]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxToolArgumentBytes: 8 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({
        kind: 'failure', failure: { code: 'malformed', status: 200 },
      });
      expect(transport.sends).toBe(1);
      expect(ofType(await events(), 'assistant/message')).toHaveLength(0);
    } finally {
      await session.shutdown();
    }
  });
});

// --- status-known body classification --------------------------------------------

describe('ProviderAdapter: status-known incomplete bodies', () => {
  it('retries a post-headers body stall as a timeout with the same wire bytes', async () => {
    const session = await openSession();
    const request = plan({
      policy: seedPolicy({ maxAttempts: 2, requestTimeoutMs: 150, retryDelayMs: 0 }),
    });
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
          // Headers and a partial body are flushed, then the response stalls: the
          // adapter's own request timeout must fire and abort the read.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(prefix);
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(validBody());
        }
      });
    });
    const endpoint = await listen(server);
    try {
      const adapter = await adapterWith(new OpenAITransport({ endpoint, key: 'k' }));
      const result = await adapter.send(request, session.gate('turn', 0));
      expect(result.kind).toBe('response');
      expect(requestBodies).toHaveLength(2);

      const durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(1);
      const { requests, responses } = await frontierRecords();
      expect(responses).toHaveLength(2);
      expect(responses[0]!.status).toBe(200);
      expect(responses[0]!.body.complete).toBe(false);
      expect((await frontierBody(responses[0]!.body)).toString('utf8')).toBe(prefix);
      expect(responses[0]!.error).toEqual({ code: 'timeout' });
      expect(responses[1]!.status).toBe(200);
      expect(responses[1]!.body.complete).toBe(true);
      expect(responses[1]!.error).toBeNull();

      // The retry reuses the one frontier body blob byte-for-byte.
      expect(requests).toHaveLength(2);
      expect(requests[0]!.attempt).toBe(0);
      expect(requests[1]!.attempt).toBe(1);
      expect(requests[1]!.group).toBe(requests[0]!.group);
      expect(requests[1]!.body).toEqual(requests[0]!.body);
      expect(requestBodies[1]!.equals(requestBodies[0]!)).toBe(true);
    } finally {
      await session.shutdown();
      await close(server);
    }
  });

  it('cancels a gate stop after headers non-retryably with status 200 and a partial raw', async () => {
    const session = await openSession();
    const request = plan({
      policy: seedPolicy({ maxAttempts: 4, requestTimeoutMs: 60_000, retryDelayMs: 0 }),
    });
    const prefix = '{"choices":';
    /** A stalled send that only resolves once the gate signal has aborted it. */
    class StallingTransport implements SerializedTransport {
      readonly facts: TransportFacts = TEST_FACTS;
      sends = 0;
      private mark!: () => void;
      readonly reached = new Promise<void>((resolve) => { this.mark = resolve; });
      async post(_body: Uint8Array, signal: AbortSignal): Promise<TransportResult> {
        this.sends += 1;
        this.mark();
        await new Promise<void>((resolve) => {
          if (signal.aborted) { resolve(); return; }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 200, headers: {}, body: Buffer.from(prefix), complete: false,
          failure: { code: 'cancelled', status: 200 },
        };
      }
    }
    const transport = new StallingTransport();
    try {
      const adapter = await adapterWith(transport);
      const sending = adapter.send(request, session.gate('turn', 0));
      await transport.reached;
      session.controller.abort();
      const result = await sending;
      expect(result).toEqual({
        kind: 'failure', failure: { code: 'cancelled', status: 200 },
      });
      expect(transport.sends).toBe(1);

      const durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(200);
      expect(responses[0]!.body.complete).toBe(false);
      expect((await frontierBody(responses[0]!.body)).toString('utf8')).toBe(prefix);
      expect(responses[0]!.error).toEqual({ code: 'cancelled' });
    } finally {
      await session.shutdown();
    }
  });

  it('classifies a gate stop as cancelled even when the capped body reports body-limit', async () => {
    const session = await openSession();
    const request = plan({
      policy: seedPolicy({ maxAttempts: 3, requestTimeoutMs: 60_000, retryDelayMs: 0 }),
    });
    const prefix = '{"choices":';
    /** A capped stalled send that reports `body-limit` only once its signal aborts. */
    class CappedStallTransport implements SerializedTransport {
      readonly facts: TransportFacts = TEST_FACTS;
      sends = 0;
      private mark!: () => void;
      readonly reached = new Promise<void>((resolve) => { this.mark = resolve; });
      async post(_body: Uint8Array, signal: AbortSignal): Promise<TransportResult> {
        this.sends += 1;
        this.mark();
        await new Promise<void>((resolve) => {
          if (signal.aborted) { resolve(); return; }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          status: 200, headers: {}, body: Buffer.from(prefix), complete: false,
          failure: { code: 'body-limit', status: 200 },
        };
      }
    }
    const transport = new CappedStallTransport();
    try {
      const adapter = await adapterWith(transport);
      const sending = adapter.send(request, session.gate('turn', 0));
      await transport.reached;
      session.controller.abort();
      const result = await sending;
      // A stop outranks a capped body: the ordering is explicit, and both are
      // terminal and non-retryable with the status preserved.
      expect(result).toEqual({
        kind: 'failure', failure: { code: 'cancelled', status: 200 },
      });
      expect(transport.sends).toBe(1);

      const durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(200);
      expect(responses[0]!.body.complete).toBe(false);
      expect((await frontierBody(responses[0]!.body)).toString('utf8')).toBe(prefix);
      expect(responses[0]!.error).toEqual({ code: 'cancelled' });
    } finally {
      await session.shutdown();
    }
  });

  it('classifies a truncated response body as a retryable network failure with surviving bytes', async () => {
    const session = await openSession();
    const request = plan({
      policy: seedPolicy({ maxAttempts: 2, requestTimeoutMs: 5000, retryDelayMs: 0 }),
    });
    const prefix = '{"choices":';
    const seen: Array<{ status: number; complete: boolean; bytes: number }> = [];
    let index = 0;
    const server = createServer((req, res) => {
      const i = index;
      index += 1;
      req.on('error', () => { /* the peer may reset the socket */ });
      res.on('error', () => { /* the peer may reset the socket */ });
      req.on('data', () => { /* drain */ });
      req.on('end', () => {
        if (i === 0) {
          // A short body against a larger content-length, then the socket is
          // ended mid-body: the read fails after the prefix has arrived.
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
          res.write(prefix, () => { res.socket?.end(); });
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(validBody());
        }
      });
    });
    const endpoint = await listen(server);
    try {
      const adapter = await adapterWith(new OpenAITransport({ endpoint, key: 'k' }));
      const result = await adapter.send(request, session.gate('turn', 0));
      expect(result.kind).toBe('response');

      const durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(1);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(2);
      expect(responses).toHaveLength(2);
      for (const response of responses) {
        seen.push({
          status: response.status as number,
          complete: response.body.complete,
          bytes: response.body.bytes,
        });
      }
      expect(seen[0]!.status).toBe(200);
      expect(seen[0]!.complete).toBe(false);
      expect(seen[0]!.bytes).toBeGreaterThan(0);
      expect((await frontierBody(responses[0]!.body)).toString('utf8')).toBe(prefix);
      expect(seen[1]!.complete).toBe(true);
      expect(responses[0]!.error).toEqual({ code: 'network' });
      expect(responses[1]!.error).toBeNull();
    } finally {
      await session.shutdown();
      await close(server);
    }
  });
});

// --- oversize request refusal ----------------------------------------------------

describe('ProviderAdapter: oversize request refusal below the ceiling', () => {
  it('refuses terminally before any begin and journals nothing local', async () => {
    const session = await openSession();
    const request = plan({
      history: [{ role: 'user', content: 'x'.repeat(2000) }],
      policy: seedPolicy({ maxRequestBytes: 64 }),
    });
    const transport = new ScriptedTransport([transportResult(validBody())]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(request, session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'request-limit', status: null } });
      expect(transport.sends).toBe(0);

      const durable = await events();
      expect(durable).toHaveLength(0);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(0);
      expect(responses).toHaveLength(0);
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
      const adapter = await adapterWith(new OpenAITransport({ endpoint, key: 'k' }));
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'network', status: null } });
      const durable = await events();
      expect(durable).toHaveLength(0);
      // The frontier terminal is durable before the failure returns: no status
      // and a `network` code, with the empty capture the exchange produced.
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.call).toBe(requests[0]!.call);
      expect(responses[0]!.status).toBeNull();
      expect(responses[0]!.error).toEqual({ code: 'network' });
      expect(responses[0]!.body.bytes).toBe(0);
      expect(responses[0]!.body.complete).toBe(false);
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
      const adapter = await adapterWith(
        new OpenAITransport({ endpoint, key: 'k' }),
        policies({
          schedule: (ms, callback) => {
            const timer = setTimeout(callback, ms);
            return () => { cleared += 1; clearTimeout(timer); };
          },
        }),
      );
      const result = await adapter.send(
        plan({ policy: seedPolicy({ requestTimeoutMs: 40 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({ kind: 'failure', failure: { code: 'timeout', status: null } });
      expect(cleared).toBeGreaterThan(0);
      const { responses } = await frontierRecords();
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBeNull();
      expect(responses[0]!.error).toEqual({ code: 'timeout' });
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
      const adapter = await adapterWith(new OpenAITransport({ endpoint, key: 'k' }));
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxCaptureBytes: 32 }) }), session.gate('turn', 0),
      );
      expect(result).toEqual({ kind: 'failure', failure: { code: 'body-limit', status: 200 } });
      const durable = await events();
      expect(durable).toHaveLength(0);
      const { responses } = await frontierRecords();
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(200);
      expect(responses[0]!.error).toEqual({ code: 'body-limit' });
      expect(responses[0]!.body.bytes).toBe(32);
      expect(responses[0]!.body.complete).toBe(false);
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
      const adapter = await adapterWith(
        new OpenAITransport({ endpoint, key: 'k' }),
        policies({
          schedule: (ms, callback) => {
            const timer = setTimeout(callback, ms);
            return () => { clearTimeout(timer); };
          },
        }),
      );
      const sending = adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2, requestTimeoutMs: 60_000 }) }),
        session.gate('turn', 0),
      );
      await gotRequest;
      session.controller.abort();
      const result = await sending;
      expect(result).toEqual({ kind: 'failure', failure: { code: 'cancelled', status: null } });
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.error).toEqual({ code: 'cancelled' });
    } finally {
      await session.shutdown();
      await close(server);
    }
  });

  it('cancels a stop during the retry delay with no later send', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([
      { status: 500, headers: {}, body: Buffer.from('{}'), complete: true, failure: null },
      transportResult(validBody()),
    ]);
    const adapter = await adapterWith(transport, policies({
      delay: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('cancelled')); return; }
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
    }));
    try {
      const sending = adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 2 }) }), session.gate('turn', 0),
      );
      await vi.waitFor(async () => {
        expect((await frontierRecords()).responses).toHaveLength(1);
      });
      session.controller.abort();
      const result = await sending;
      // The 500 was already classified when the stop landed, so the status is
      // preserved rather than recorded as an unknown cancellation.
      expect(result).toEqual({ kind: 'failure', failure: { code: 'cancelled', status: 500 } });
      expect(transport.sends).toBe(1);
      expect(ofType(await events(), 'assistant/message')).toHaveLength(0);

      // The stop rewrites only the adapter's returned failure: no further
      // begin, and the one terminal stays the outcome classified at its
      // exchange (a complete 500 with `http`), never rewritten to `cancelled`.
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(500);
      expect(responses[0]!.error).toEqual({ code: 'http' });
      expect(responses[0]!.body.complete).toBe(true);
    } finally {
      await session.shutdown();
    }
  });

});

// --- late stops and policy seams --------------------------------------------------

describe('ProviderAdapter: a late stop preserves the classified status', () => {
  it('returns cancelled with the known status when the stop lands after the frontier terminal', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult('{"error":"bad"}', 400)]);
    const journal = await openFrontier();
    // The stop lands exactly after the terminal is durable, before the adapter
    // returns: only the returned failure is rewritten, never the record.
    const frontier: Frontier = {
      begin: (input) => journal.gate.begin(input),
      complete: async (call, outcome) => {
        await journal.gate.complete(call, outcome);
        session.controller.abort();
      },
    };
    try {
      const adapter = new ProviderAdapter(transport, policies(), frontier);
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({
        kind: 'failure', failure: { code: 'cancelled', status: 400 },
      });

      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(400);
      expect(responses[0]!.error).toEqual({ code: 'http' });
      expect(ofType(await events(), 'assistant/message')).toHaveLength(0);
    } finally {
      await session.shutdown();
    }
  });
});

describe('ProviderAdapter: the post seam', () => {
  it('removes the abort listener when the injected schedule throws', async () => {
    const session = await openSession();
    const inner = session.gate('turn', 0);
    const added = vi.spyOn(inner.signal, 'addEventListener');
    const removed = vi.spyOn(inner.signal, 'removeEventListener');
    try {
      const adapter = await adapterWith(
        new ScriptedTransport([transportResult(validBody())]),
        policies({ schedule: () => { throw new Error('injected schedule failure'); } }),
      );
      await expect(adapter.send(plan(), inner)).rejects.toThrow('injected schedule failure');
      const addAbort = added.mock.calls.filter((call) => call[0] === 'abort');
      const removeAbort = removed.mock.calls.filter((call) => call[0] === 'abort');
      expect(addAbort).toHaveLength(1);
      expect(removeAbort).toHaveLength(1);
      // The exact listener registered is the one removed: no leak on throw.
      expect(removeAbort[0]![1]).toBe(addAbort[0]![1]);

      // The exchange never began: the begin is durable, the terminal says the
      // kernel's own machinery failed before anything was handed to the
      // transport, and the error propagates.
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.call).toBe(requests[0]!.call);
      expect(responses[0]!.status).toBeNull();
      expect(responses[0]!.error).toEqual({ code: 'local' });
      expect(responses[0]!.body.bytes).toBe(0);
      expect(responses[0]!.body.complete).toBe(false);
    } finally {
      await session.shutdown();
    }
  });
});

// --- the frontier path -----------------------------------------------------------

describe('ProviderAdapter: the frontier sequence', () => {
  it('reads a durable matching http/request at every transport entry', async () => {
    const session = await openSession();
    const problems: unknown[] = [];
    const posted: Uint8Array[] = [];
    /** Reads the frontier at entry: the request must already be durable. */
    class ObservingTransport implements SerializedTransport {
      readonly facts: TransportFacts = TEST_FACTS;
      async post(body: Uint8Array): Promise<TransportResult> {
        posted.push(body);
        try {
          const events = await readFrontier(home);
          const requests = events.filter((event) => event.type === 'http/request');
          const last = requests[requests.length - 1];
          if (last === undefined) throw new Error('no http/request durable before the send');
          const data = last.data as unknown as FrontierRequestData;
          if (!(await frontierBody(data.body)).equals(Buffer.from(body))) {
            throw new Error('the durable request body differs from the posted bytes');
          }
          if (events.some((event) => event.type === 'http/response')) {
            throw new Error('a terminal was durable before the send');
          }
        } catch (err) {
          problems.push(err);
        }
        return transportResult(validBody());
      }
    }
    try {
      const adapter = await adapterWith(new ObservingTransport());
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result.kind).toBe('response');
      expect(problems).toEqual([]);
      expect(posted).toHaveLength(1);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(requests[0]!.method).toBe('POST');
      expect(requests[0]!.url).toBe(TEST_FACTS.url);
      expect(requests[0]!.headers).toEqual({ 'content-type': 'application/json' });
      expect(requests[0]!.credentials).toEqual([{ id: 'test', where: 'authorization' }]);
      expect(requests[0]!.body).toMatchObject({ encoding: 'utf8', complete: true });
      expect(requests[0]!.body.bytes).toBe(posted[0]!.byteLength);
    } finally {
      await session.shutdown();
    }
  });

  it('journals a non-200 as a durable http terminal before the failure returns', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult('{"error":"no"}', 401)]);
    try {
      const adapter = await adapterWith(transport);
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'http', status: 401 } });
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.call).toBe(requests[0]!.call);
      expect(responses[0]!.status).toBe(401);
      expect(responses[0]!.error).toEqual({ code: 'http' });
      expect(responses[0]!.body.complete).toBe(true);
      expect((await frontierBody(responses[0]!.body)).toString('utf8')).toBe('{"error":"no"}');
    } finally {
      await session.shutdown();
    }
  });

  it('journals a 302 as the response it is and never follows it', async () => {
    const session = await openSession();
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(302, { location: '/v1/elsewhere', 'content-type': 'application/json' });
      res.end('{"moved":true}');
    });
    const endpoint = await listen(server);
    try {
      const adapter = await adapterWith(new OpenAITransport({ endpoint, key: 'k' }));
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAttempts: 4 }) }), session.gate('turn', 0),
      );
      // A redirect is a non-200 response, not a retryable one: one send only.
      expect(result).toEqual({ kind: 'failure', failure: { code: 'http', status: 302 } });
      expect(paths).toHaveLength(1);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.status).toBe(302);
      expect(responses[0]!.error).toEqual({ code: 'http' });
      // Only the response allowlist is journaled; `location` never rides it.
      expect(responses[0]!.headers).toEqual({ 'content-type': 'application/json' });
    } finally {
      await session.shutdown();
      await close(server);
    }
  });

  it('an abort before begin journals no frontier event and sends nothing', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult(validBody())]);
    try {
      const adapter = await adapterWith(transport);
      session.controller.abort();
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'cancelled', status: null } });
      expect(transport.sends).toBe(0);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(0);
      expect(responses).toHaveLength(0);
    } finally {
      await session.shutdown();
    }
  });

  it('an abort after begin journals a cancelled terminal and sends nothing', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult(validBody())]);
    const journal = await openFrontier();
    // The stop lands exactly between the durable begin and the send.
    const abortOnBegin: Frontier = {
      begin: async (input) => {
        const call = await journal.gate.begin(input);
        session.controller.abort();
        return call;
      },
      complete: (call, outcome) => journal.gate.complete(call, outcome),
    };
    try {
      const adapter = new ProviderAdapter(transport, policies(), abortOnBegin);
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'cancelled', status: null } });
      expect(transport.sends).toBe(0);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.call).toBe(requests[0]!.call);
      expect(responses[0]!.status).toBeNull();
      expect(responses[0]!.error).toEqual({ code: 'cancelled' });
      expect(responses[0]!.body.bytes).toBe(0);
      expect(responses[0]!.body.complete).toBe(false);
    } finally {
      await session.shutdown();
    }
  });

  it('a frontier flush failure stops the exchange before the transport is reached', async () => {
    const session = await openSession();
    const transport = new ScriptedTransport([transportResult(validBody())]);
    const journal = await openFrontier();
    const restore = failFrontierFlushes(home);
    try {
      const adapter = new ProviderAdapter(transport, policies(), journal.gate);
      await expect(adapter.send(plan(), session.gate('turn', 0)))
        .rejects.toThrow('injected frontier flush failure');
      // Nothing crossed the frontier: no send, and no durable request.
      expect(transport.sends).toBe(0);
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(0);
      expect(responses).toHaveLength(0);
    } finally {
      restore();
      await session.shutdown();
    }
  });
});

// --- the fake key -----------------------------------------------------------------

describe('ProviderAdapter: the fake key never reaches an event', () => {
  it('drops a transport error message that embeds the key', async () => {
    const session = await openSession();
    class ThrowingTransport implements SerializedTransport {
      readonly facts: TransportFacts = TEST_FACTS;
      async post(): Promise<TransportResult> {
        throw new Error('connect failed using test-key-never-log');
      }
    }
    try {
      const adapter = await adapterWith(new ThrowingTransport());
      const result = await adapter.send(plan(), session.gate('turn', 0));
      expect(result).toEqual({ kind: 'failure', failure: { code: 'network', status: null } });
      const durable = await events();
      expect(JSON.stringify(durable.map((event) => event.data))).not.toContain('test-key-never-log');
      // A throwing transport is a durable `network` terminal before the return;
      // the arbitrary Error never rides it.
      const { requests, responses } = await frontierRecords();
      expect(requests).toHaveLength(1);
      expect(responses).toHaveLength(1);
      expect(responses[0]!.call).toBe(requests[0]!.call);
      expect(responses[0]!.status).toBeNull();
      expect(responses[0]!.error).toEqual({ code: 'network' });
      expect(JSON.stringify(responses[0])).not.toContain('test-key-never-log');
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

describe('ProviderAdapter: fatal frontier faults are never swallowed', () => {
  it('rethrows a frontier complete failure and records no assistant message', async () => {
    const session = await openSession();
    const journal = await openFrontier();
    const frontier: Frontier = {
      begin: (input) => journal.gate.begin(input),
      complete: async () => { throw new Error('injected terminal failure'); },
    };
    try {
      const adapter = new ProviderAdapter(
        new ScriptedTransport([transportResult(validBody())]), policies(), frontier,
      );
      await expect(adapter.send(plan(), session.gate('turn', 0)))
        .rejects.toThrow('injected terminal failure');

      let durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
      expect(durable.some((event) => [
        'request/plan', 'request/wire', 'response/raw', 'request/usage', 'assistant/attempt',
      ].includes(event.type))).toBe(false);
      // Restart: the same facts still cause no replayed model/tool calls.
      await session.shutdown();
      durable = await events();
      expect(ofType(durable, 'assistant/message')).toHaveLength(0);
    } finally {
      await session.shutdown();
    }
  });

  it('rethrows a projection flush failure rather than returning a failure result', async () => {
    const session = await openSession();
    try {
      const adapter = await adapterWith(
        new ScriptedTransport([transportResult(validBody())]),
      );
      // Flush #1 is the projection barrier: the only local flush left.
      const faulty = flushFaultGate(session.gate('turn', 0), 1);
      await expect(adapter.send(plan(), faulty)).rejects.toThrow('injected flush failure');
    } finally {
      await session.shutdown();
    }
  });
});

// --- assistant content bounding (artifact algorithm 7) ---------------------------

/** The journaled assistant projection, resolving an inline or artifact-json value. */
async function journaledProjection(): Promise<AssistantProjection> {
  const durable = await events();
  const event = ofType(durable, 'assistant/message')[0]!;
  const value = (event.data as unknown as { value: Stored<AssistantProjection> }).value;
  if (value.kind === 'inline') return value.value;
  const bytes = await new BlobStore(home).get(value.ref.sha256);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as AssistantProjection;
}

/** The frontier capture the projection names, for the notice's call/bytes. */
async function captureOf(): Promise<{
  readonly call: string; readonly bytes: number; readonly complete: boolean;
}> {
  const projection = await journaledProjection();
  const { responses } = await frontierRecords();
  const response = responses.find((record) => record.call === projection.frontierCall);
  if (response === undefined) throw new Error('missing frontier terminal for the projection');
  return {
    call: response.call, bytes: response.body.bytes, complete: response.body.complete,
  };
}

const NOTICE = /^\[content truncated: model text capped at (\d+) bytes; frontier call: (.+), (\d+) captured bytes, complete: (yes|no)\]$/;

describe('ProviderAdapter: assistant content bounding', () => {
  it('truncates to maxAssistantBytes and appends a notice naming the frontier call', async () => {
    const session = await openSession();
    const content = 'a'.repeat(1000);
    try {
      const adapter = await adapterWith(
        new ScriptedTransport([transportResult(JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
        }))]),
      );
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAssistantBytes: 256 }) }), session.gate('turn', 0),
      );
      expect(result.kind).toBe('response');
      if (result.kind === 'response') expect(result.projection.contentTruncated).toBe(true);

      const projection = await journaledProjection();
      expect(projection.contentTruncated).toBe(true);
      const capture = await captureOf();
      const expectedNotice = `\n[content truncated: model text capped at 256 bytes; `
        + `frontier call: ${capture.call}, ${capture.bytes} captured bytes, `
        + `complete: ${capture.complete ? 'yes' : 'no'}]`;
      expect(projection.message.content).toBe('a'.repeat(256) + expectedNotice);
      // The notice matches the binding format, names the call, and carries no
      // artifact digest: the capture is the frontier's, not a local artifact.
      const match = NOTICE.exec(expectedNotice.slice(1));
      expect(match).not.toBeNull();
      expect(match![1]).toBe('256');
      expect(match![2]).toBe(capture.call);
      expect(match![3]).toBe(String(capture.bytes));
      expect(match![4]).toBe(capture.complete ? 'yes' : 'no');
      expect(projection.message.content).not.toContain('raw sha256');
      // The truncated text (before the notice) is exactly maxAssistantBytes.
      expect(Buffer.byteLength(projection.message.content!.slice(0, 256), 'utf8')).toBe(256);
    } finally {
      await session.shutdown();
    }
  });

  it('cuts only at a code-point boundary on a multibyte body (no U+FFFD)', async () => {
    const session = await openSession();
    // 255 'a' + 'é' (2 bytes) + filler: byte 256 lands mid-'é', so a naive slice
    // at 256 would split the character; the boundary cut drops it whole.
    const content = 'a'.repeat(255) + 'é' + 'b'.repeat(500);
    try {
      const adapter = await adapterWith(
        new ScriptedTransport([transportResult(JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
        }))]),
      );
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAssistantBytes: 256 }) }), session.gate('turn', 0),
      );
      expect(result.kind).toBe('response');

      const projection = await journaledProjection();
      expect(projection.contentTruncated).toBe(true);
      const capture = await captureOf();
      // The retained text is the 255 ASCII bytes, then the notice; no replacement.
      expect(projection.message.content!.startsWith('a'.repeat(255) + '\n[content truncated:')).toBe(true);
      expect(projection.message.content).not.toContain('\uFFFD');
      expect(Buffer.byteLength(projection.message.content!.slice(0, 255), 'utf8')).toBe(255);
      // The notice states the cap, not the retained prefix's smaller size.
      expect(projection.message.content).toContain('model text capped at 256 bytes');
      expect(projection.message.content).toContain(`frontier call: ${capture.call}, `
        + `${capture.bytes} captured bytes`);
      expect(Buffer.from(projection.message.content!.slice(0, 255), 'utf8').toString('utf8')).toBe('a'.repeat(255));
    } finally {
      await session.shutdown();
    }
  });

  it('leaves content exactly at the limit untruncated', async () => {
    const session = await openSession();
    const content = 'a'.repeat(256);
    try {
      const adapter = await adapterWith(
        new ScriptedTransport([transportResult(JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
        }))]),
      );
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAssistantBytes: 256 }) }), session.gate('turn', 0),
      );
      expect(result.kind).toBe('response');
      const projection = await journaledProjection();
      expect(projection.contentTruncated).toBe(false);
      expect(projection.message.content).toBe(content);
    } finally {
      await session.shutdown();
    }
  });

  it('leaves null content null and untruncated', async () => {
    const session = await openSession();
    try {
      const adapter = await adapterWith(
        new ScriptedTransport([transportResult(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: null } }],
        }))]),
      );
      const result = await adapter.send(
        plan({ policy: seedPolicy({ maxAssistantBytes: 256 }) }), session.gate('turn', 0),
      );
      expect(result.kind).toBe('response');
      const projection = await journaledProjection();
      expect(projection.contentTruncated).toBe(false);
      expect(projection.message.content).toBeNull();
    } finally {
      await session.shutdown();
    }
  });
});
