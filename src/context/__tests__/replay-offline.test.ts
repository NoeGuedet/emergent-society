import { describe, expect, it } from 'vitest';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { useTempHome } from '../../journal/__tests__/helpers.js';
import { C13_EVENT_TYPES, createBoundaryRegistry, validateRequestPlan } from '../events.js';
import { createBoundaryGate } from '../../node/gate.js';
import { ContextFold } from '../fold.js';
import { assemble } from '../assembler.js';
import { serializeWire } from '../../provider/wire.js';
import { loadVerifiedEvents } from '../loader.js';
import { canonicalBytes, resolveArtifact, resolveStored } from '../artifacts.js';
import { defaultAgentConfig } from '../config.js';
import { sha256HexOf } from '../../journal/canon.js';
import type {
  AgentConfig, ArtifactRef, AssistantProjection, CompactionStart, FunctionCall,
  RequestId, RequestPlan, Source, Stored, WorldPerception,
} from '../contracts.js';

const home = useTempHome('c13-offline-');

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
  it('D1: giant config artifact, full wire pipeline, committed compaction, interrupted recovery', async () => {
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
      const plan = assemble({ id: requestId, state: (await foldNow()).snapshot() });
      const storedPlan = await turn0.gate.store(plan);
      turn0.gate.append('request/plan', { id: requestId, value: storedPlan });
      const wireBytes = serializeWire(plan);
      expect(wireBytes.length).toBeGreaterThan(5 * 1024 * 1024); // ~80 × 64 KiB chunks
      const wireRef = await turn0.gate.capture(wireBytes, 'utf8');
      turn0.gate.append('request/wire', { id: requestId, attempt: 0, body: wireRef });
      const rawBytes = Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant',
        content: null, tool_calls: [call('e1', 'true'), call('e2', 'true')] } }] }));
      const rawRef = await turn0.gate.capture(rawBytes, 'utf8');
      turn0.gate.append('response/raw', { id: requestId, attempt: 0, status: 200, body: rawRef, complete: true });
      const projection: AssistantProjection = {
        message: { role: 'assistant', content: null, tool_calls: [call('e1', 'true'), call('e2', 'true')] },
        contentTruncated: false, raw: rawRef,
      };
      turn0.gate.append('assistant/message', { id: requestId, value: await turn0.gate.store(projection) });
      for (const id of ['e1', 'e2']) {
        turn0.gate.append('tool/call', { turn: 0, request: requestId, call: call(id, 'true') });
        turn0.gate.append('tool/result', { turn: 0, request: requestId, callId: id,
          message: { role: 'tool', content: 'ok', tool_call_id: id }, isError: false,
          raw: null, failure: null, synthetic: false });
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
      const plan1 = assemble({ id: request1, state: (await foldNow()).snapshot() });
      turn1.gate.append('request/plan', { id: request1, value: await turn1.gate.store(plan1) });
      const wireRef1 = await turn1.gate.capture(serializeWire(plan1), 'utf8');
      turn1.gate.append('request/wire', { id: request1, attempt: 0, body: wireRef1 });
      const rawRef1 = await turn1.gate.capture(rawBytes, 'utf8');
      turn1.gate.append('response/raw', { id: request1, attempt: 0, status: 200, body: rawRef1, complete: true });
      turn1.gate.append('assistant/message', { id: request1, value: await turn1.gate.store({
        message: { role: 'assistant', content: null, tool_calls: [call('e3', 'true'), call('e4', 'true')] },
        contentTruncated: false, raw: rawRef1,
      } satisfies AssistantProjection) });
      turn1.gate.append('tool/call', { turn: 1, request: request1, call: call('e3', 'true') });
      turn1.gate.append('tool/result', { turn: 1, request: request1, callId: 'e3',
        message: { role: 'tool', content: 'ok', tool_call_id: 'e3' }, isError: false,
        raw: null, failure: null, synthetic: false });
      turn1.gate.append('tool/call', { turn: 1, request: request1, call: call('e4', 'true') });
      await turn1.gate.flush();
    } finally {
      await session.shutdown();
    }

    const all = await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES);
    // The giant config and wire artifacts resolve from their raw blobs after reload.
    const configEvent = all.find((event) => event.type === 'system/message')!;
    const storedConfig = (configEvent.data as unknown as { value: Stored<AgentConfig> }).value;
    expect(storedConfig.kind).toBe('artifact-json');
    const wire = all.find((event) => event.type === 'request/wire')!;
    const wireArtifact = resolveArtifact(all, (wire.data as unknown as { body: ArtifactRef }).body);
    expect(wireArtifact.length).toBeGreaterThan(5 * 1024 * 1024);
    // The recorded plan re-serializes byte-for-byte to the durable wire.
    const planEvent = all.find((event) => event.type === 'request/plan')!;
    const planValue = (planEvent.data as unknown as { value: Stored<RequestPlan> }).value;
    const recordedPlan = resolveStored(all, planValue, validateRequestPlan);
    expect(Buffer.from(serializeWire(recordedPlan)).equals(Buffer.from(wireArtifact))).toBe(true);

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
            tool_call_id: 'e4' }, isError: true, raw: null, failure: null, synthetic: true });
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
    const shadow = Buffer.from(canonicalBytes(dialogue.group.messages));
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
        sources: groupSources, replacementBytes: canonicalBytes([message]).length });
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
