import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { useTempHome } from '../../journal/__tests__/helpers.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../events.js';
import { createBoundaryGate } from '../../node/gate.js';
import { ContextFold } from '../fold.js';
import { assemble } from '../assembler.js';
import { canonicalMessagesBytes, serializeWire } from '../../provider/wire.js';
import { loadVerifiedEvents } from '../loader.js';
import { canonicalBytes, resolveStored } from '../artifacts.js';
import { defaultAgentConfig } from '../config.js';
import { sha256HexOf } from '../../journal/index.js';
import { readFrontier } from '../../frontier/__tests__/helpers.js';
import type { HttpRequest, HttpResponse } from '../../frontier/index.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import type {
  SerializedTransport, TransportFacts, TransportResult,
} from '../../provider/transport.js';
import { NodeDriver } from '../../node/driver.js';
import { createAgentRuntime } from '../../node/loop.js';
import { DEFAULT_TERMINAL_ENV } from '../../node/tools/terminal.js';
import { loadProviders } from '../../node/tools/providers.js';
import { webRequestBody, webToolsFromProviders } from '../../node/tools/web.js';
import { commitAs, useWorld } from '../../node/__tests__/helpers.js';
import { verifyPerceptions } from './verify-perceptions.js';
import type {
  AgentConfig, AssistantProjection, CompactionStart, FunctionCall,
  RequestId, Source, Stored, WorldPerception,
} from '../contracts.js';

const home = useTempHome('c13-offline-');
const joinFixture = useWorld('c14d-join-');

/** Structural receipt source: works for both EventEnvelope and VerifiedEvent. */
const source = (event: { seq: number; hash: string }): Source => ({ seq: event.seq, hash: event.hash });

const call = (id: string, cmd: string): FunctionCall =>
  ({ id, type: 'function', function: { name: 'execute', arguments: JSON.stringify({ cmd }) } });

const giantConfig = (): AgentConfig => {
  const base = defaultAgentConfig();
  return { ...base, version: 1, charter: 'c'.repeat(5 * 1024 * 1024),
    policy: { ...base.policy, compactAfterBytes: 1, keepRecentGroups: 0 } };
};

const perception = (text: string): WorldPerception => ({
  uid: 'n1', range: { from: null, to: null }, effectiveFrom: null, fallback: 'none',
  renderer: { policy: 'commit-patches-v1', gitVersion: 'git version 2.43.0', attrSource: 'to' },
  maxBytes: 32768, maxCommits: 4096, listTruncated: false, commits: [], included: [], omittedOwn: [],
  text, truncated: false,
});

/**
 * One open writer. `gate(scope)` builds a context gate for a phase/turn; `lifecycle` appends the
 * Node lifecycle events (`turn/start`, `turn/end`) directly on the writer, never through the gate,
 * because they are not BoundaryDataMap types. Each turn uses its own gate scope (no forged turn on
 * another scope). `readBlob` backs the gate's durable claim-check verification.
 */
async function openSession() {
  const writer = await JournalWriter.open(home(), 'n1');
  const controller = new AbortController();
  const receipts = new Map<string, EventEnvelope>();
  // Preload the durable receipt inventory from the chain so a gate can resolve receipts created
  // by an earlier session (e.g. the compaction candidate's sources). Key by the raw journaled
  // envelope identity; a raw claim-check `data` is fine for lookup because the fold uses real
  // sources. The writer is open but unmodified, so the full chain still verifies.
  for (const event of await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES)) {
    receipts.set(`${event.raw.seq}:${event.raw.hash}`, event.raw);
  }
  const record = (receipt: EventEnvelope): EventEnvelope => {
    receipts.set(`${receipt.seq}:${receipt.hash}`, receipt);
    return receipt;
  };
  const lookup = (s: Source): EventEnvelope | null => receipts.get(`${s.seq}:${s.hash}`) ?? null;
  const callbacks = {
    append: (type: string, data: JsonValue): EventEnvelope => record(writer.append(type, data as never)),
    flush: (): Promise<void> => writer.flush(),
    lookup,
    readBlob: (hash: string): Promise<Uint8Array> => new BlobStore(home()).get(hash),
    now: (): number => 100,
  };
  const gates: Array<() => void> = [];
  const gate = (scope: { phase: 'ready' | 'turn'; turn: number | null }) => {
    const created = createBoundaryGate(createBoundaryRegistry(),
      { phase: scope.phase, turn: scope.turn, signal: controller.signal, lookup }, callbacks);
    gates.push(created.close);
    return created;
  };
  const lifecycle = (type: 'turn/start' | 'turn/end', data: JsonValue,
    opts?: { ignorable?: boolean }): EventEnvelope =>
    record(writer.append(type, data as never, opts));
  const flush = (): Promise<void> => writer.flush();
  const shutdown = async (): Promise<void> => {
    for (const close of gates) close(); // revoke every created scope handle first
    await writer.close();
    controller.abort();
  };
  return { gate, lifecycle, flush, shutdown };
}

async function foldNow(): Promise<ContextFold> {
  const fold = new ContextFold();
  await fold.observe(await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES));
  return fold;
}

describe('C1.3 offline reconstruction (writer-backed, no runtime)', () => {
  it('D1: giant config artifact, semantic pipeline, committed compaction, interrupted recovery', async () => {
    const config = giantConfig();
    const session = await openSession();
    try {
      // Config is stored as a giant artifact, so the system/message event itself stays < 4 MiB.
      const ready = session.gate({ phase: 'ready', turn: null });
      const storedConfig = await ready.gate.store(config);
      expect(storedConfig.kind).toBe('artifact-json');
      ready.gate.append('system/message', { version: 1, value: storedConfig });
      await ready.gate.flush();

      // Complete turn 0: perception, one full wire pipeline, two calls and both real results.
      session.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const turn0 = session.gate({ phase: 'turn', turn: 0 });
      turn0.gate.append('world/perception', { turn: 0, range: { from: null, to: null },
        value: { kind: 'inline', value: perception('external evidence') } });
      await turn0.gate.flush();

      const requestId: RequestId = { turn: 0, ordinal: 0 };
      const calls = [call('e1', 'true'), call('e2', 'true')];
      const projection: AssistantProjection = {
        message: { role: 'assistant', content: null, tool_calls: calls },
        contentTruncated: false, frontierCall: 'call-0',
      };
      turn0.gate.append('assistant/message', { id: requestId, value: await turn0.gate.store(projection) });
      for (const id of ['e1', 'e2']) {
        turn0.gate.append('tool/call', { turn: 0, request: requestId, call: call(id, 'true') });
        turn0.gate.append('tool/result', { turn: 0, request: requestId, callId: id,
          message: { role: 'tool', content: 'ok', tool_call_id: id }, isError: false,
          raw: null, failure: null, synthetic: false, frontierCall: null });
      }
      session.lifecycle('turn/end', { turn: 0, outcome: 'waiting' });
      await turn0.gate.flush();

      // Interrupted turn 1 (a crash): empty perception (no new surface group), e3 has a durable
      // real result, e4 has none, no closer.
      session.lifecycle('turn/start', { turn: 1, trigger: 'chain', world: { from: null, to: null } });
      const turn1 = session.gate({ phase: 'turn', turn: 1 });
      turn1.gate.append('world/perception', { turn: 1, range: { from: null, to: null },
        value: { kind: 'inline', value: perception('') } });
      await turn1.gate.flush();
      const request1: RequestId = { turn: 1, ordinal: 0 };
      turn1.gate.append('assistant/message', { id: request1, value: await turn1.gate.store({
        message: { role: 'assistant', content: null, tool_calls: [call('e3', 'true'), call('e4', 'true')] },
        contentTruncated: false, frontierCall: 'call-1',
      } satisfies AssistantProjection) });
      turn1.gate.append('tool/call', { turn: 1, request: request1, call: call('e3', 'true') });
      turn1.gate.append('tool/result', { turn: 1, request: request1, callId: 'e3',
        message: { role: 'tool', content: 'ok', tool_call_id: 'e3' }, isError: false,
        raw: null, failure: null, synthetic: false, frontierCall: null });
      turn1.gate.append('tool/call', { turn: 1, request: request1, call: call('e4', 'true') });
      await turn1.gate.flush();
    } finally {
      await session.shutdown();
    }

    const all = await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES);
    // The giant config resolves from its raw blob after reload: the local log
    // keeps the semantic facts, and a stored value stays a claim-check reference.
    const configEvent = all.find((event) => event.type === 'system/message')!;
    const storedConfig = (configEvent.data as unknown as { value: Stored<AgentConfig> }).value;
    expect(storedConfig.kind).toBe('artifact-json');
    const assistant = all.filter((event) => event.type === 'assistant/message');
    expect(assistant).toHaveLength(2);
    expect((assistant[0]!.data as { id: RequestId }).id).toEqual({ turn: 0, ordinal: 0 });

    // Resume simulation: a synthetic interrupted closer, then a synthetic unknown result for e4.
    const resume = await openSession();
    try {
      resume.lifecycle('turn/end', { turn: 1, outcome: 'interrupted', synthetic: true });
      await resume.flush();
    } finally { await resume.shutdown(); }
    const closed = await foldNow();
    expect(closed.snapshot().recovery).toHaveLength(1);
    expect(closed.snapshot().recovery[0]!.results.map((m) => m.tool_call_id)).toEqual(['e3']);
    expect(closed.snapshot().recovery[0]!.missing.map((c) => c.id)).toEqual(['e4']);
    expect(() => assemble({ id: { turn: 0, ordinal: 0 }, state: closed.snapshot() })).toThrow();

    const reconcile = await openSession();
    try {
      reconcile.gate({ phase: 'ready', turn: null }).gate.append('tool/result',
        { turn: 1, request: { turn: 1, ordinal: 0 }, callId: 'e4',
          message: { role: 'tool', content: 'Outcome unknown after interruption; not re-executed',
            tool_call_id: 'e4' }, isError: true, raw: null, failure: null, synthetic: true,
          frontierCall: null });
      await reconcile.flush();
    } finally { await reconcile.shutdown(); }
    const recovered = await foldNow();
    expect(recovered.snapshot().recovery).toEqual([]);

    // Compact the committed turn-0 dialogue from its current (recovered) snapshot, citing all of
    // its exact source receipts, not just the group id.
    const before = recovered.snapshot();
    if (!before.surface) throw new Error('missing surface');
    const dialogue = before.surface.nodes.find((node) => node.group.kind === 'dialogue');
    if (!dialogue) throw new Error('missing dialogue group');
    const groupSources = [...dialogue.group.sources]
      .map((s) => ({ seq: s.seq, hash: s.hash }))
      .sort((a, b) => (a.seq - b.seq) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    const shadow = Buffer.from(canonicalMessagesBytes(dialogue.group.messages));
    const candidate = { revision: before.surface.revision, groupIds: [dialogue.group.id],
      sources: groupSources, shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length };
    const start: CompactionStart = { id: sha256HexOf(Buffer.from(canonicalBytes(candidate))), ...candidate };
    const compact = await openSession();
    try {
      // A direct policy-fact turn: lifecycle only, no perception/request/effect. The candidate
      // revision covers committed groups only, so opening turn 2 does not change it.
      compact.lifecycle('turn/start', { turn: 2, trigger: 'boot', world: { from: null, to: null } });
      await compact.flush();
      const gate = compact.gate({ phase: 'turn', turn: 2 });
      gate.gate.append('compaction/start', start);
      const message = { role: 'user' as const, content: 'Older committed context was removed.' };
      const summary = gate.gate.append('compaction/summary', { id: start.id, message,
        sources: groupSources, replacementBytes: canonicalMessagesBytes([message]).length });
      gate.gate.append('compaction/end', { id: start.id, summary: source(summary) });
      await gate.gate.flush();
      compact.lifecycle('turn/end', { turn: 2, outcome: 'waiting' }, { ignorable: true });
      await compact.flush();
    } finally { await compact.shutdown(); }
    const rebuilt = await foldNow();
    const nodes = rebuilt.snapshot().surface?.nodes ?? [];
    expect(nodes.map((node) => node.position)).toEqual([0, 1, 2, 3]);
    expect(nodes[0]?.group.kind).toBe('heading');
    expect(nodes[1]?.group.kind).toBe('perception');
    expect(nodes[2]?.group.kind).toBe('summary');
    expect(nodes[2]?.group.messages[0]?.content).toBe('Older committed context was removed.');
    expect(nodes[3]?.group.kind).toBe('dialogue');
    expect(rebuilt.snapshot().recovery).toEqual([]);
  }, 30000);
});

// --- C1.4d T8.10: the local → frontier join ----------------------------------------

const JOIN_FACTS: TransportFacts = {
  url: 'https://test.invalid/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  credentialId: 'test',
};

/** A transport answering from a queue; no HTTP, so the run is fully deterministic. */
class ScriptedTransport implements SerializedTransport {
  readonly facts: TransportFacts = JOIN_FACTS;
  readonly sends: Uint8Array[] = [];

  constructor(private readonly replies: readonly TransportResult[]) {}

  async post(body: Uint8Array): Promise<TransportResult> {
    this.sends.push(body);
    const reply = this.replies[this.sends.length - 1];
    if (reply === undefined) throw new Error('scripted transport exhausted');
    return reply;
  }
}

function okReply(content: string | null, calls: readonly FunctionCall[] = []): TransportResult {
  return {
    status: 200, headers: {}, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({ choices: [{ message: {
      role: 'assistant', content,
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
    } }] })),
  };
}

function webSearch(id: string, query: string): FunctionCall {
  return {
    id, type: 'function',
    function: { name: 'web_search', arguments: JSON.stringify({ query }) },
  };
}

const JOIN_SEARCH_RESPONSE = JSON.stringify({
  request_id: 'req-join',
  results: [{
    title: 'Emergence', url: 'https://example.com/emergence',
    content: 'complex systems arising from simple rules',
  }],
});

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
}

/**
 * The local → frontier join, in the two scoped halves the plan names. A real
 * runtime performs the exchanges (a scripted LLM transport, so the wire bytes
 * are captured exactly, and a loopback Tavily server); the joins are then
 * recomputed **offline** from the two durable artifacts — no network, no
 * re-execution.
 *
 * - *LLM*: for every local `assistant/message`, its `frontierCall` resolves to a
 *   terminal `http/response`; every attempt of its group carries the same body;
 *   and that body equals `serializeWire(assemble({ id, state }))` recomputed from
 *   the local fold state captured just before the `assistant/message` event is
 *   folded. The fold is stepped event by event and snapshotted only at those
 *   points; `serializeWire` ignores the request id, so the join needs no
 *   per-request id mapping. Requests are discriminated by URL.
 * - *Web*: for every web `tool/result.frontierCall`, the request body equals
 *   `webRequestBody(args, entry)` recomputed from the recorded `tool/call`
 *   arguments and the fixture's registry entry.
 * - Plus `verifyPerceptions(world, events)`: the perception fidelity proof.
 *
 * Scoped honestly: an **LLM** call whose attempts all failed has no local anchor
 * by design (only a success produces an `assistant/message`), so it is checked
 * for group/attempt integrity only. A **web** call's failure *is* anchored
 * locally (`dispatch` journals a `tool/result` for every `WebOutcome`), so the
 * web join covers successes and failures alike.
 */
describe('C1.4d T8.10: the local → frontier join', () => {
  it('recomputes every request body from the local fold and joins it to a terminal', async () => {
    const fx = joinFixture();
    await commitAs(fx.world, 'human', { 'direction.txt': 'join the two logs\n' });

    const tavilyBodies: Buffer[] = [];
    const tavily = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        tavilyBodies.push(Buffer.concat(chunks));
        res.setHeader('content-type', 'application/json');
        res.end(JOIN_SEARCH_RESPONSE);
      });
    });
    await new Promise<void>((resolve) => { tavily.listen(0, '127.0.0.1', resolve); });
    const address = tavily.address();
    if (address === null || typeof address === 'string') throw new Error('missing TCP address');
    const tavilyUrl = `http://127.0.0.1:${address.port}`;

    const transport = new ScriptedTransport([
      // A retryable failure, then the tool-calling answer: one group, two attempts.
      { status: 429, headers: {}, complete: true, failure: null, body: new Uint8Array() },
      okReply(null, [webSearch('w1', 'emergent societies')]),
      okReply('done'),
    ]);
    const base = defaultAgentConfig();
    const config: AgentConfig = {
      ...base, policy: { ...base.policy, maxAttempts: 2, retryDelayMs: 1 },
    };
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      await writeFile(join(fx.home, 'providers.json'), JSON.stringify({ tavily: {
        key: 'tvly-join-never-logged', baseUrl: tavilyUrl, timeoutMs: 5000,
      } }), 'utf8');
      const journal = await fx.frontier();
      const webTools = webToolsFromProviders(await loadProviders(fx.home), journal.gate);
      if (webTools === undefined) throw new Error('tavily registry entry missing');

      const runtime = createAgentRuntime({
        home: fx.home, uid: 'n1', world: fx.world, initialConfig: config,
        terminal: { env: DEFAULT_TERMINAL_ENV },
        adapter: new ProviderAdapter(transport, {
          delay: (ms, signal) => new Promise<void>((resolve, reject) => {
            if (signal.aborted) { reject(new Error('cancelled')); return; }
            let timer: NodeJS.Timeout | undefined;
            const onAbort = (): void => {
              if (timer !== undefined) clearTimeout(timer);
              reject(new Error('cancelled'));
            };
            timer = setTimeout(() => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            }, ms);
            signal.addEventListener('abort', onAbort, { once: true });
          }),
          schedule: (ms, callback) => {
            const timer = setTimeout(callback, ms);
            return () => { clearTimeout(timer); };
          },
        }, journal.gate),
        webTools,
      });
      driver = await NodeDriver.open(fx.home, 'n1', runtime.handler, fx.world, {
        knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
      });
      running = driver.run();
      await vi.waitFor(() => expect(driver!.state).toBe('waiting'), { timeout: 15000 });
      driver.stop();
      await running;
      running = null;
      driver = null;

      // The exchanges happened: three LLM sends (retry included) and one web call.
      expect(transport.sends).toHaveLength(3);
      expect(tavilyBodies).toHaveLength(1);

      const events = await loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
      const frontier = await readFrontier(fx.home);
      const requests = frontier.filter((event) => event.type === 'http/request')
        .map((event) => event.data as unknown as HttpRequest);
      const terminals = frontier.filter((event) => event.type === 'http/response')
        .map((event) => event.data as unknown as HttpResponse);
      const requestsByCall = new Map(requests.map((request) => [request.call, request]));
      const terminalsByCall = new Map(terminals.map((terminal) => [terminal.call, terminal]));
      const blobs = new BlobStore(fx.home);
      expect(terminals).toHaveLength(requests.length);

      // The default LLM endpoint is the scripted transport's fact; the web URL is
      // the fixture's. Requests are discriminated by URL.
      const llmUrl = JOIN_FACTS.url;
      const llmRequests = requests.filter((request) => request.url === llmUrl);
      const webRequests = requests.filter((request) => request.url === `${tavilyUrl}/search`);
      expect(llmRequests).toHaveLength(3);
      expect(webRequests).toHaveLength(1);

      // --- the LLM half: fold-stepped snapshots and exact wire recomputation ---
      const fold = new ContextFold();
      const joins: { id: RequestId; call: string }[] = [];
      for (const event of events) {
        if (event.type === 'assistant/message') {
          const state = fold.snapshot();
          const data = event.data as unknown as {
            id: RequestId; value: Stored<AssistantProjection>;
          };
          const projection = resolveStored(events, data.value,
            (value) => value as AssistantProjection);
          joins.push({ id: data.id, call: projection.frontierCall });

          const terminal = terminalsByCall.get(projection.frontierCall);
          expect(terminal).toBeDefined();
          expect(terminal).toMatchObject({
            status: 200, error: null, body: { complete: true },
          });
          const request = requestsByCall.get(projection.frontierCall);
          expect(request).toBeDefined();
          expect(request!.url).toBe(llmUrl);

          // Group integrity: contiguous attempts of one logical operation, and
          // every attempt reuses the exact bytes (one content-addressed blob).
          const attempts = requests.filter((candidate) =>
            candidate.group === request!.group);
          expect(attempts.map((attempt) => attempt.attempt))
            .toEqual(attempts.map((_attempt, index) => index));
          expect(new Set(attempts.map((attempt) => attempt.body.sha256)).size).toBe(1);

          // The plan↔wire proof, recomputed from the folded local state only.
          const wire = Buffer.from(serializeWire(assemble({ id: data.id, state })));
          const durable = Buffer.from(await blobs.get(request!.body.sha256));
          expect(durable.equals(wire)).toBe(true);
          expect(request!.body.sha256).toBe(sha256HexOf(wire));
          expect(request!.body.bytes).toBe(wire.length);
        }
        await fold.observe([event]);
      }
      expect(joins.map((join) => join.id)).toEqual([
        { turn: 0, ordinal: 0 }, { turn: 0, ordinal: 1 },
      ]);
      // The first logical request really was retried: one group, two attempts.
      const first = requestsByCall.get(joins[0]!.call)!;
      const retried = requests.filter((request) => request.group === first.group);
      expect(retried).toHaveLength(2);
      expect(terminalsByCall.get(retried[0]!.call)!.status).toBe(429);
      expect(terminalsByCall.get(retried[1]!.call)!.status).toBe(200);

      // --- the web half: the body recomputed from the recorded call arguments ---
      const registry = await loadProviders(fx.home);
      const entry = registry.tavily;
      if (entry === undefined) throw new Error('tavily registry entry missing');
      const callsByKey = new Map<string, FunctionCall>();
      for (const event of events) {
        if (event.type !== 'tool/call') continue;
        const data = event.data as unknown as {
          request: RequestId; call: FunctionCall;
        };
        callsByKey.set(
          `${data.request.turn}:${data.request.ordinal}:${data.call.id}`, data.call);
      }
      let webJoins = 0;
      for (const event of events) {
        if (event.type !== 'tool/result') continue;
        const data = event.data as unknown as {
          request: RequestId; callId: string; frontierCall: string | null;
        };
        if (data.frontierCall === null) continue;
        const recorded = callsByKey.get(
          `${data.request.turn}:${data.request.ordinal}:${data.callId}`);
        expect(recorded).toBeDefined();
        const parsed = JSON.parse(recorded!.function.arguments) as Record<string, unknown>;
        const args = recorded!.function.name === 'web_search'
          ? { kind: 'web_search' as const, query: parsed['query'] as string,
              maxResults: parsed['max_results'] as number | undefined }
          : { kind: 'web_fetch' as const, url: parsed['url'] as string };
        const request = requestsByCall.get(data.frontierCall);
        expect(request).toBeDefined();
        expect(request!.url).toBe(`${tavilyUrl}/search`);
        expect(request!.credentials).toEqual([{ id: 'tavily', where: 'authorization' }]);
        const wire = Buffer.from(webRequestBody(args, entry));
        const durable = Buffer.from(await blobs.get(request!.body.sha256));
        expect(durable.equals(wire)).toBe(true);
        expect(request!.body.sha256).toBe(sha256HexOf(wire));
        // The bytes the provider actually received are those durable bytes.
        expect(durable.equals(tavilyBodies[webJoins]!)).toBe(true);
        webJoins += 1;
      }
      expect(webJoins).toBe(1);

      // --- the perception half the retired rederivation carried ---
      await verifyPerceptions(fx.world, events);
    } finally {
      const current = driver;
      driver = null;
      if (current !== null) {
        current.stop();
        const pending = running as Promise<void> | null;
        if (pending !== null) await pending.catch(() => { /* the assertion stands */ });
        else if (current.state === 'booting' || current.state === 'active') {
          await current.run().catch(() => { /* the assertion stands */ });
        }
      }
      await closeServer(tavily);
    }
  }, 30000);
});
