import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, CLAIM_CHECK_THRESHOLD, isBlobRef, JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { sha256HexOf } from '../../journal/canon.js';
import { canonicalMessagesBytes } from '../../provider/wire.js';
import { useTempHome, withFailingWrite } from '../../journal/__tests__/helpers.js';
import type { BoundaryGate, DriverHooks, GateCallbacks } from '../../node/gate.js';
import { createBoundaryGate } from '../../node/gate.js';
import { NodeDriver } from '../../node/driver.js';
import { useWorld } from '../../node/__tests__/helpers.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../events.js';
import { defaultAgentConfig } from '../config.js';
import { ContextFold } from '../fold.js';
import { SurfacePolicyError } from '../surface.js';
import { ArtifactMismatchError, loadVerifiedEvents } from '../loader.js';
import type { VerifiedEvent } from '../loader.js';
import { canonicalBytes } from '../artifacts.js';
import type {
  ArtifactRef, AssistantProjection, CompactionStart, CompactionSummary, FunctionCall, RequestId,
  RequestPlan, Source, WorldPerception,
} from '../contracts.js';
import type { WorldRange } from '../../node/world.js';

const home = useTempHome('c13-fold-');
const fixture = useWorld('c13-fold-driver-');

const call = (id: string): FunctionCall =>
  ({ id, type: 'function', function: { name: 'execute', arguments: '{}' } });

const perception = (text: string, range: WorldRange = { from: null, to: null }): WorldPerception => ({
  uid: 'n1', range, effectiveFrom: null, fallback: 'none',
  renderer: { policy: 'commit-patches-v1', gitVersion: 'git version 2.43.0', attrSource: 'to' },
  maxBytes: 32768, maxCommits: 4096, listTruncated: false,
  commits: [], included: [], omittedOwn: [], text, truncated: false,
});

/** A structurally valid plan; the fold checks only its identity and config provenance. */
function minimalPlan(id: RequestId, config: Source): RequestPlan {
  return {
    id, config, stateHash: 'a'.repeat(64), model: 'mock-model', parameters: {},
    policy: defaultAgentConfig().policy, tools: [], toolsHash: 'b'.repeat(64),
    sections: [
      { name: 'tools', cache: 'stable', sources: [] },
      { name: 'charter', cache: 'stable', sources: [] },
      { name: 'heading', cache: 'stable', sources: [] },
      { name: 'history', cache: 'advance', sources: [] },
      { name: 'queue', cache: 'volatile', sources: [] },
    ],
    history: [], queue: [], charter: '', heading: '',
  };
}

function projection(calls: FunctionCall[], raw: ArtifactRef): AssistantProjection {
  return {
    message: { role: 'assistant', content: calls.length === 0 ? 'final text' : null, tool_calls: calls },
    contentTruncated: false, raw,
  };
}

interface Session {
  readonly path: string;
  readonly writer: JournalWriter;
  readonly gate: (phase: 'ready' | 'turn', turn: number | null) =>
    { readonly gate: BoundaryGate };
  readonly lifecycle: (type: string, data: JsonValue, opts?: { ignorable?: boolean }) => EventEnvelope;
  readonly close: () => Promise<void>;
}

async function openSession(path: string): Promise<Session> {
  const writer = await JournalWriter.open(path, 'n1', { batchWindowMs: 60000 });
  const controller = new AbortController();
  const receipts = new Map<string, EventEnvelope>();
  const record = (envelope: EventEnvelope): EventEnvelope => {
    receipts.set(`${envelope.seq}:${envelope.hash}`, envelope);
    return envelope;
  };
  const lookup = (source: Source): EventEnvelope | null =>
    receipts.get(`${source.seq}:${source.hash}`) ?? null;
  const callbacks: GateCallbacks = {
    append: (type, data) => record(writer.append(type, data as never)),
    flush: () => writer.flush(),
    lookup,
    readBlob: (hash) => new BlobStore(path).get(hash),
    now: () => 1,
  };
  const gate = (phase: 'ready' | 'turn', turn: number | null) =>
    createBoundaryGate(
      createBoundaryRegistry(), { phase, turn, signal: controller.signal, lookup }, callbacks,
    );
  const lifecycle = (type: string, data: JsonValue, opts?: { ignorable?: boolean }): EventEnvelope =>
    record((writer.append as unknown as (
      t: string, d: JsonValue, o?: { ignorable?: boolean },
    ) => EventEnvelope)(type, data, opts));
  return { path, writer, gate, lifecycle, close: () => writer.close() };
}

async function startConfig(s: Session): Promise<Source> {
  const ready = s.gate('ready', null).gate;
  const source = ready.append('system/message', {
    version: 1, value: { kind: 'inline', value: defaultAgentConfig() },
  });
  await ready.flush();
  return source;
}

async function foldOf(path: string): Promise<ContextFold> {
  const fold = new ContextFold();
  await fold.observe(await loadVerifiedEvents(path, 'n1', C13_EVENT_TYPES));
  return fold;
}

/**
 * Opens a turn and appends perception, plan, wire, response and an assistant
 * message (with the given advertised calls). The caller adds tool/call events,
 * results and the closer.
 */
async function pipeline(
  s: Session, turn: number, cfg: Source,
  opts: { perceptionText?: string; calls?: FunctionCall[] },
): Promise<{ id: RequestId; gate: BoundaryGate }> {
  s.lifecycle('turn/start', { turn, trigger: 'boot', world: { from: null, to: null } });
  const gate = s.gate('turn', turn).gate;
  gate.append('world/perception', {
    turn, range: { from: null, to: null },
    value: { kind: 'inline', value: perception(opts.perceptionText ?? '') },
  });
  const id: RequestId = { turn, ordinal: 0 };
  gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
  const body = await gate.capture(Buffer.from('{}'), 'utf8');
  gate.append('request/wire', { id, attempt: 0, body });
  const raw = await gate.capture(Buffer.from('raw'), 'utf8');
  gate.append('response/raw', { id, attempt: 0, status: 200, body: raw, complete: true });
  gate.append('assistant/message', {
    id, value: await gate.store(projection(opts.calls ?? [], raw)),
  });
  for (const advertised of opts.calls ?? []) {
    gate.append('tool/call', { turn, request: id, call: advertised });
  }
  return { id, gate };
}

function result(id: RequestId, turn: number, callId: string, synthetic = false): JsonValue {
  return {
    turn, request: id, callId,
    message: { role: 'tool', content: synthetic ? 'Outcome unknown after interruption; not re-executed' : 'ok', tool_call_id: callId },
    isError: synthetic, raw: null, failure: null, synthetic,
  } as unknown as JsonValue;
}

describe('fold: two turns, committed history and an ignorable turn', () => {
  it('promotes the first dialogue and both perceptions, omitting the ignorable assistant', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);

      const t0 = await pipeline(s, 0, cfg, { perceptionText: 'first evidence', calls: [call('c1'), call('c2')] });
      t0.gate.append('tool/result', result(t0.id, 0, 'c1') as never);
      t0.gate.append('tool/result', result(t0.id, 0, 'c2') as never);
      await t0.gate.flush();
      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' });
      await s.writer.flush();

      const t1 = await pipeline(s, 1, cfg, { perceptionText: 'second evidence', calls: [] });
      await t1.gate.flush();
      const live = await foldOf(home());
      expect(live.snapshot().open?.perception?.messages[0]).toEqual(
        { role: 'user', content: 'second evidence' },
      );
      const liveAssistant = live.snapshot().open?.messages.find((m) => m.role === 'assistant');
      expect(liveAssistant).toEqual(
        { role: 'assistant', content: 'final text', tool_calls: [] },
      );

      s.lifecycle('turn/end', { turn: 1, outcome: 'waiting' }, { ignorable: true });
      await s.writer.flush();

      const done = await foldOf(home());
      const nodes = done.snapshot().surface?.nodes ?? [];
      expect(nodes.map((node) => node.group.kind))
        .toEqual(['heading', 'perception', 'dialogue', 'perception']);
      const dialogues = nodes.filter((node) => node.group.kind === 'dialogue');
      expect(dialogues).toHaveLength(1);
      const messages = dialogues[0]!.group.messages;
      expect(messages[0]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1' }, { id: 'c2' }] });
      expect(messages.slice(1).map((m) => (m as { tool_call_id: string }).tool_call_id))
        .toEqual(['c1', 'c2']);
      expect(nodes.filter((node) => node.group.kind === 'perception')).toHaveLength(2);

      // Re-observation is idempotent and the emitted state is a frozen copy.
      const again = await foldOf(home());
      expect(again.snapshot()).toEqual(done.snapshot());
      expect(Object.isFrozen(done.snapshot())).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('fold: retry idempotence', () => {
  it('folds a 429-then-200 retry into one perception, one dialogue and one response', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 0).gate;
      gate.append('world/perception', {
        turn: 0, range: { from: null, to: null },
        value: { kind: 'inline', value: perception('evidence') },
      });
      const id: RequestId = { turn: 0, ordinal: 0 };
      gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
      const body = await gate.capture(Buffer.from('{}'), 'utf8');
      gate.append('request/wire', { id, attempt: 0, body });
      const raw0 = await gate.capture(Buffer.from('raw0'), 'utf8');
      gate.append('response/raw', { id, attempt: 0, status: 429, body: raw0, complete: true });
      await gate.flush();

      const mid = await foldOf(home());
      // The queue entry is consumed by the first wire, before any retry.
      expect(mid.snapshot().open?.perceptionConsumed).toBe(true);
      expect(mid.snapshot().open?.perception?.messages[0]).toEqual(
        { role: 'user', content: 'evidence' },
      );

      gate.append('request/wire', { id, attempt: 1, body });
      const raw1 = await gate.capture(Buffer.from('raw1'), 'utf8');
      gate.append('response/raw', { id, attempt: 1, status: 200, body: raw1, complete: true });
      gate.append('assistant/message', { id, value: await gate.store(projection([], raw1)) });
      await gate.flush();
      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' });
      await s.writer.flush();

      const done = await foldOf(home());
      const nodes = done.snapshot().surface?.nodes ?? [];
      expect(nodes.map((node) => node.group.kind)).toEqual(['heading', 'perception', 'dialogue']);
      expect(nodes.filter((node) => node.group.kind === 'perception')).toHaveLength(1);
      expect(nodes.filter((node) => node.group.kind === 'dialogue')).toHaveLength(1);
      const events = done.verifiedEvents();
      expect(events.filter((e) => e.type === 'request/wire')).toHaveLength(2);
      expect(events.filter((e) => e.type === 'world/perception')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'assistant/message')).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
});

describe('fold: provenance and sequencing rejections', () => {
  it('rejects an artifact-json perception whose resolved range differs from the wrapper', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      const range: WorldRange = { from: 'c'.repeat(64), to: null };
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 0).gate;
      // A value large enough to be stored as artifact-json: the gate only checks
      // the manifest receipt, so the inner range equality is the fold's to own.
      const stored = await gate.store(perception('x'.repeat(5 * 1024 * 1024), range));
      expect(stored.kind).toBe('artifact-json');
      gate.append('world/perception', { turn: 0, range: { from: null, to: null }, value: stored as never });
      await gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/range/);
    } finally {
      await s.close();
    }
  });

  it('rejects a wrapper range that differs from the turn opening range', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      const range: WorldRange = { from: 'd'.repeat(64), to: null };
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 0).gate;
      gate.append('world/perception', {
        turn: 0, range, value: { kind: 'inline', value: perception('evidence', range) },
      });
      await gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/opening range/);
    } finally {
      await s.close();
    }
  });

  it('rejects a duplicate result for one call', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await pipeline(s, 0, cfg, { calls: [call('c1')] });
      t.gate.append('tool/result', result(t.id, 0, 'c1') as never);
      t.gate.append('tool/result', result(t.id, 0, 'c1') as never);
      await t.gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/duplicate/);
    } finally {
      await s.close();
    }
  });

  it('rejects a forged recovery result id at ready', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await pipeline(s, 0, cfg, { calls: [call('c1'), call('c2')] });
      t.gate.append('tool/result', result(t.id, 0, 'c1') as never);
      await t.gate.flush();
      s.lifecycle('turn/end', { turn: 0, outcome: 'interrupted', synthetic: true });
      await s.writer.flush();

      const folded = await foldOf(home());
      expect(folded.snapshot().recovery[0]?.missing.map((c) => c.id)).toEqual(['c2']);

      const ready = s.gate('ready', null).gate;
      ready.append('tool/result', result(t.id, 0, 'zzz', true) as never);
      await ready.flush();
      await expect(foldOf(home())).rejects.toThrow(/advertised|recovery/);
    } finally {
      await s.close();
    }
  });
});

describe('fold: compaction applies only after a verified end', () => {
  it('leaves the surface unchanged until end, then replaces and reports no orphan', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t0 = await pipeline(s, 0, cfg, { perceptionText: 'external evidence '.repeat(20), calls: [] });
      await t0.gate.flush();
      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' }, { ignorable: true });
      await s.writer.flush();

      const before = await foldOf(home());
      const surface = before.snapshot().surface;
      if (surface === null) throw new Error('missing surface');
      const group = surface.nodes.find((node) => node.group.kind === 'perception')!.group;
      const shadow = Buffer.from(canonicalMessagesBytes(group.messages));
      const candidate = {
        revision: surface.revision, groupIds: [group.id], sources: group.sources,
        shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length,
      };
      const start: CompactionStart = {
        id: sha256HexOf(Buffer.from(canonicalBytes(candidate))), ...candidate,
      };

      s.lifecycle('turn/start', { turn: 1, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 1).gate;
      gate.append('compaction/start', start);
      const message = { role: 'user' as const, content: 'Older committed context was removed.' };
      const summary = gate.append('compaction/summary', {
        id: start.id, message, sources: start.sources,
        replacementBytes: canonicalMessagesBytes([message]).length,
      });
      await gate.flush();

      const mid = await foldOf(home());
      expect(mid.snapshot().surface).toEqual(surface);
      expect(mid.snapshot().pendingCompactions).toHaveLength(1);
      expect(mid.orphanCompactions()).toHaveLength(1);

      gate.append('compaction/end', { id: start.id, summary: { seq: summary.seq, hash: summary.hash } });
      await gate.flush();
      const after = await foldOf(home());
      const nodes = after.snapshot().surface?.nodes ?? [];
      expect(nodes.map((node) => node.group.kind)).toEqual(['heading', 'summary']);
      expect(nodes[1]?.group.messages[0]?.content).toBe('Older committed context was removed.');
      expect(after.orphanCompactions()).toEqual([]);

      const again = await foldOf(home());
      expect(again.snapshot()).toEqual(after.snapshot());
    } finally {
      await s.close();
    }
  });

  it('rejects a durable end whose replacement is not strictly smaller than the shadow', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t0 = await pipeline(s, 0, cfg, { perceptionText: 'external evidence', calls: [] });
      await t0.gate.flush();
      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' }, { ignorable: true });
      await s.writer.flush();

      const before = await foldOf(home());
      const surface = before.snapshot().surface;
      if (surface === null) throw new Error('missing surface');
      const group = surface.nodes.find((node) => node.group.kind === 'perception')!.group;
      const shadow = Buffer.from(canonicalMessagesBytes(group.messages));
      const fields = {
        revision: surface.revision, groupIds: [group.id], sources: group.sources,
        shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length,
      };
      const start: CompactionStart = {
        id: sha256HexOf(Buffer.from(canonicalBytes(fields))), ...fields,
      };

      s.lifecycle('turn/start', { turn: 1, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 1).gate;
      gate.append('compaction/start', start);
      const message = { role: 'user' as const, content: 'Older committed context was removed.' };
      const summary = gate.append('compaction/summary', {
        id: start.id, message, sources: start.sources,
        // Exactly the shadow size: the replacement is not strictly smaller.
        replacementBytes: shadow.length,
      });
      gate.append('compaction/end', { id: start.id, summary: { seq: summary.seq, hash: summary.hash } });
      await gate.flush();

      const all = await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES);
      await expect(before.observe(all)).rejects.toThrow(SurfacePolicyError);
      expect(before.snapshot().surface).toEqual(surface);
    } finally {
      await s.close();
    }
  });
});

describe('fold: compaction summary above the claim-check threshold', () => {
  it('resolves and applies a summary stored as a claim-check reference, durably on replay', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      // A real shadow well above the ~20 KiB summary and far below the 4 MiB gate
      // ceiling, so the strict-smaller rule holds on a genuine span.
      const shadowText = 'external evidence '.repeat(1400);
      const t0 = await pipeline(s, 0, cfg, { perceptionText: shadowText, calls: [] });
      await t0.gate.flush();
      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' }, { ignorable: true });
      await s.writer.flush();

      const before = await foldOf(home());
      const surface = before.snapshot().surface;
      if (surface === null) throw new Error('missing surface');
      const group = surface.nodes.find((node) => node.group.kind === 'perception')!.group;
      const shadow = Buffer.from(canonicalMessagesBytes(group.messages));
      const fields = {
        revision: surface.revision, groupIds: [group.id], sources: group.sources,
        shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length,
      };
      const start: CompactionStart = {
        id: sha256HexOf(Buffer.from(canonicalBytes(fields))), ...fields,
      };

      s.lifecycle('turn/start', { turn: 1, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 1).gate;
      gate.append('compaction/start', start);
      const content = 'compacted summary '.repeat(1200);
      const message = { role: 'user' as const, content };
      const replacementBytes = canonicalMessagesBytes([message]).length;
      expect(replacementBytes).toBeGreaterThan(CLAIM_CHECK_THRESHOLD);
      expect(replacementBytes).toBeLessThan(shadow.length);
      const summary = gate.append('compaction/summary', {
        id: start.id, message, sources: start.sources, replacementBytes,
      });
      gate.append('compaction/end', { id: start.id, summary: { seq: summary.seq, hash: summary.hash } });
      await gate.flush();

      const after = await foldOf(home());
      const nodes = after.snapshot().surface?.nodes ?? [];
      expect(nodes.map((node) => node.group.kind)).toEqual(['heading', 'summary']);
      expect(nodes[1]?.group.messages[0]).toEqual(message);

      // Offline replay through a fresh fold re-derives the same applied summary.
      expect((await foldOf(home())).snapshot().surface).toEqual(after.snapshot().surface);

      // The raw receipt stays a claim-check reference while the resolved value is
      // the durable summary payload the surface applied.
      const verified = await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES);
      const receipt = verified.find((event) => event.seq === summary.seq);
      expect(receipt?.type).toBe('compaction/summary');
      expect(isBlobRef(receipt?.raw.data)).toBe(true);
      expect((receipt?.data as { message: { content: string } }).message.content).toBe(content);
    } finally {
      await s.close();
    }
  });
});

// --- driver-backed recovery -------------------------------------------------
function hooksFor(fold: ContextFold, path: string, over: Partial<DriverHooks> = {}): DriverHooks {
  return {
    registry: createBoundaryRegistry(),
    onDurable: async (events) => { await fold.observe(events); },
    onReady: async (gate) => {
      if (fold.snapshot().config === null) {
        gate.append('system/message', { version: 1, value: { kind: 'inline', value: defaultAgentConfig() } });
        await gate.flush();
        return;
      }
      for (const unresolved of fold.unresolvedCalls()) {
        gate.append('tool/result', {
          turn: unresolved.turn, request: unresolved.request, callId: unresolved.call.id,
          message: {
            role: 'tool', content: 'Outcome unknown after interruption; not re-executed',
            tool_call_id: unresolved.call.id,
          },
          isError: true, raw: null, failure: null, synthetic: true,
        });
      }
      await gate.flush();
    },
    onTurnStart: async () => {},
    readHistory: (path2, uid, knownTypes) => loadVerifiedEvents(path2, uid, knownTypes),
    readBlob: (hash) => new BlobStore(path).get(hash),
    acknowledgedWorld: (turn) => fold.acknowledgedWorld(turn),
    ...over,
  };
}

type Variant = 'errorCloser' | 'persisted' | 'interrupted';

async function runFirstBoot(
  path: string, world: ReturnType<typeof fixture>['world'], variant: Variant,
): Promise<ContextFold> {
  const fold = new ContextFold();
  const hooks = hooksFor(fold, path);
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  let inject!: () => void;
  const injectionActive = new Promise<void>((resolve) => { inject = resolve; });
  const withResult = variant !== 'errorCloser';
  const ref: { d: NodeDriver | null } = { d: null };
  ref.d = await NodeDriver.open(path, 'n1', async (ctx) => {
    const cfg = fold.snapshot().config!.source;
    ctx.gate.append('world/perception', {
      turn: ctx.turn, range: ctx.world,
      value: { kind: 'inline', value: perception('') },
    });
    const id: RequestId = { turn: ctx.turn, ordinal: 0 };
    ctx.gate.append('request/plan', { id, value: await ctx.gate.store(minimalPlan(id, cfg)) });
    const body = await ctx.gate.capture(Buffer.from('{}'), 'utf8');
    ctx.gate.append('request/wire', { id, attempt: 0, body });
    const raw = await ctx.gate.capture(Buffer.from('raw'), 'utf8');
    ctx.gate.append('response/raw', { id, attempt: 0, status: 200, body: raw, complete: true });
    ctx.gate.append('assistant/message', {
      id, value: await ctx.gate.store(projection([call('c1'), call('c2')], raw)),
    });
    ctx.gate.append('tool/call', { turn: ctx.turn, request: id, call: call('c1') });
    if (withResult) {
      ctx.gate.append('tool/result', result(id, ctx.turn, 'c1') as never);
    }
    ctx.gate.append('tool/call', { turn: ctx.turn, request: id, call: call('c2') });
    await ctx.gate.flush();
    if (variant === 'interrupted') {
      release();
      await injectionActive;
      throw new Error('boom after durable calls');
    }
    if (variant === 'errorCloser' || variant === 'persisted') {
      return { outcome: 'error', toolCalls: true, error: { code: 'timeout', status: null } };
    }
    return { outcome: 'waiting', toolCalls: true };
  }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0, batchWindowMs: 10_000 });

  if (variant === 'interrupted') {
    const running = ref.d.run();
    await reached;
    await withFailingWrite(path, async () => {
      inject();
      // The handler's own failure reaches the caller: the error-closer flush
      // fault that follows it must not displace it.
      await expect(running).rejects.toThrow('boom after durable calls');
    }, 2);
  } else {
    const running = ref.d.run();
    await vi.waitFor(() => expect(ref.d!.state).toBe('waiting'));
    ref.d.stop();
    await running;
  }
  return fold;
}

async function reconcileBoot(
  path: string, world: ReturnType<typeof fixture>['world'], fold: ContextFold,
): Promise<void> {
  const hooks = hooksFor(fold, path);
  const driver = await NodeDriver.open(path, 'n1', () => ({ outcome: 'waiting', toolCalls: false }), world, {
    knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0,
  });
  driver.stop();
  await driver.run();
}

/** A boot that closes an interrupted turn but performs no ready reconciliation. */
async function closeOnlyBoot(
  path: string, world: ReturnType<typeof fixture>['world'], fold: ContextFold,
): Promise<void> {
  const hooks = hooksFor(fold, path, { onReady: async () => {} });
  const driver = await NodeDriver.open(path, 'n1', () => ({ outcome: 'waiting', toolCalls: false }), world, {
    knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0,
  });
  driver.stop();
  await driver.run();
}

async function readEvents(path: string) {
  return loadVerifiedEvents(path, 'n1', C13_EVENT_TYPES);
}

describe('fold recovery: interrupted dialogue through the real T2 driver', () => {
  it('recovers one missing call, reconciles it once and is idempotent on restart', async () => {
    const { home: path, world } = fixture();
    const fold = await runFirstBoot(path, world, 'interrupted');
    // The turn never closed: it is open, not yet in recovery.
    expect(fold.snapshot().open).not.toBeNull();
    expect(fold.snapshot().recovery).toEqual([]);

    // A boot that writes the synthetic interrupted closer, without reconciling.
    await closeOnlyBoot(path, world, fold);
    const before = fold.snapshot();
    expect(before.open).toBeNull();
    expect(before.recovery).toHaveLength(1);
    expect(before.recovery[0]?.results.map((m) => m.tool_call_id)).toEqual(['c1']);
    expect(before.recovery[0]?.missing.map((c) => c.id)).toEqual(['c2']);
    expect(fold.unresolvedCalls().map((u) => u.call.id)).toEqual(['c2']);

    await reconcileBoot(path, world, fold);
    expect(fold.snapshot().recovery).toEqual([]);
    const after = await readEvents(path);
    const synthetic = after.filter((e) => e.type === 'tool/result'
      && (e.data as unknown as { synthetic: boolean }).synthetic);
    expect(synthetic.map((e) => (e.data as unknown as { callId: string }).callId)).toEqual(['c2']);
    // No re-execution: the original two calls are still the only tool/calls.
    expect(after.filter((e) => e.type === 'tool/call')).toHaveLength(2);

    await reconcileBoot(path, world, fold);
    const final = await readEvents(path);
    expect(final.filter((e) => e.type === 'tool/result'
      && (e.data as unknown as { synthetic: boolean }).synthetic)).toHaveLength(1);
  });

  it('recovers an incomplete group closed by a durable normal error closer', async () => {
    const { home: path, world } = fixture();
    const fold = await runFirstBoot(path, world, 'errorCloser');
    const end = (await readEvents(path)).find((e) => e.type === 'turn/end');
    expect(end?.data).toMatchObject({ outcome: 'error' });
    expect(fold.snapshot().recovery[0]?.missing.map((c) => c.id)).toEqual(['c1', 'c2']);

    await reconcileBoot(path, world, fold);
    expect(fold.snapshot().recovery).toEqual([]);
    const after = await readEvents(path);
    expect(after.filter((e) => e.type === 'tool/result'
      && (e.data as unknown as { synthetic: boolean }).synthetic)
      .map((e) => (e.data as unknown as { callId: string }).callId).sort())
      .toEqual(['c1', 'c2']);
  });

  it('completes a call from its real durable result and fabricates no unknown outcome', async () => {
    const { home: path, world } = fixture();
    const fold = await runFirstBoot(path, world, 'persisted');
    const recovery = fold.snapshot().recovery[0]!;
    expect(recovery.results.map((m) => m.tool_call_id)).toEqual(['c1']);
    expect(recovery.missing.map((c) => c.id)).toEqual(['c2']);

    await reconcileBoot(path, world, fold);
    const after = await readEvents(path);
    const synthetic = after.filter((e) => e.type === 'tool/result'
      && (e.data as unknown as { synthetic: boolean }).synthetic);
    expect(synthetic.map((e) => (e.data as unknown as { callId: string }).callId)).toEqual(['c2']);
    // The real result for c1 is untouched: still exactly one, and not synthetic.
    const c1 = after.filter((e) => e.type === 'tool/result'
      && (e.data as unknown as { callId: string }).callId === 'c1');
    expect(c1).toHaveLength(1);
    expect((c1[0]!.data as unknown as { synthetic: boolean }).synthetic).toBe(false);
  });
});

// --- strict assistant provenance and sequencing invariants (T7) ------------------

describe('fold: assistant provenance binds to a recorded complete 200 response', () => {
  /**
   * Opens one turn and drives it up to (and excluding) the closer. The assistant
   * projection's raw ref defaults to the recorded response body; `assistantRawBytes`
   * substitutes a different valid artifact and `assistantRawForge` mutates the ref.
   */
  async function turnWithAssistant(
    s: Session, cfg: Source, opts: {
      calls?: FunctionCall[]; response?: boolean; status?: number; complete?: boolean;
      assistantRawBytes?: Uint8Array; assistantRawForge?: (ref: ArtifactRef) => ArtifactRef;
      resultCount?: number;
    } = {},
  ): Promise<{ id: RequestId; gate: BoundaryGate }> {
    s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    const gate = s.gate('turn', 0).gate;
    gate.append('world/perception', {
      turn: 0, range: { from: null, to: null },
      value: { kind: 'inline', value: perception('evidence') },
    });
    const id: RequestId = { turn: 0, ordinal: 0 };
    gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
    const body = await gate.capture(Buffer.from('{}'), 'utf8');
    gate.append('request/wire', { id, attempt: 0, body });
    const responseBody = await gate.capture(
      Buffer.from('{"ok":true}'), 'utf8', opts.complete ?? true,
    );
    if (opts.response !== false) {
      gate.append('response/raw', {
        id, attempt: 0, status: opts.status ?? 200, body: responseBody,
        complete: opts.complete ?? true,
      });
    }
    const chosen = opts.assistantRawBytes === undefined
      ? responseBody
      : await gate.capture(Buffer.from(opts.assistantRawBytes), 'utf8');
    const raw = (opts.assistantRawForge ?? ((ref: ArtifactRef): ArtifactRef => ref))(chosen);
    gate.append('assistant/message', { id, value: await gate.store(projection(opts.calls ?? [], raw)) });
    const calls = opts.calls ?? [];
    for (const advertised of calls) gate.append('tool/call', { turn: 0, request: id, call: advertised });
    const count = opts.resultCount ?? calls.length;
    for (let i = 0; i < count; i++) {
      gate.append('tool/result', result(id, 0, calls[i]!.id) as never);
    }
    return { id, gate };
  }

  it('rejects an assistant message when no response was recorded for the request', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await turnWithAssistant(s, cfg, { response: false });
      await t.gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/response/);
    } finally {
      await s.close();
    }
  });

  it('rejects an assistant whose raw is a different valid artifact than the response', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await turnWithAssistant(s, cfg, {
        assistantRawBytes: Buffer.from('{"other":true}'),
      });
      await t.gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/response/);
    } finally {
      await s.close();
    }
  });

  it('rejects an assistant whose raw ref digest does not match its artifact', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await turnWithAssistant(s, cfg, {
        assistantRawForge: (ref) => ({ ...ref, sha256: 'f'.repeat(64) }),
      });
      await t.gate.flush();
      await expect(foldOf(home())).rejects.toThrow(ArtifactMismatchError);
    } finally {
      await s.close();
    }
  });

  it('does not bind an assistant to an HTTP 429 response', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await turnWithAssistant(s, cfg, { status: 429 });
      await t.gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/response/);
    } finally {
      await s.close();
    }
  });

  it('does not bind an assistant to an incomplete response', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await turnWithAssistant(s, cfg, { complete: false });
      await t.gate.flush();
      let err: unknown;
      try {
        await foldOf(home());
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ArtifactMismatchError);
      expect((err as ArtifactMismatchError).field).toBe('complete');
    } finally {
      await s.close();
    }
  });

  it('accepts a 200 complete response whose raw covers the recorded body', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await turnWithAssistant(s, cfg, { calls: [call('c1')] });
      await t.gate.flush();
      const folded = await foldOf(home());
      expect(folded.snapshot().open?.messages).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  /**
   * Opens one turn with the assistant projection captured as an `artifact-json`
   * value (the same inner-projection shape a giant assistant message uses). The
   * caller supplies the inner raw ref so the same binding path is exercised.
   */
  async function turnWithStoredAssistant(
    s: Session, cfg: Source, innerRaw: (responseBody: ArtifactRef) => Promise<ArtifactRef>,
  ): Promise<void> {
    s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    const gate = s.gate('turn', 0).gate;
    gate.append('world/perception', {
      turn: 0, range: { from: null, to: null },
      value: { kind: 'inline', value: perception('') },
    });
    const id: RequestId = { turn: 0, ordinal: 0 };
    gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
    const body = await gate.capture(Buffer.from('{}'), 'utf8');
    gate.append('request/wire', { id, attempt: 0, body });
    const responseBody = await gate.capture(Buffer.from('{"ok":true}'), 'utf8');
    gate.append('response/raw', {
      id, attempt: 0, status: 200, body: responseBody, complete: true,
    });
    const raw = await innerRaw(responseBody);
    const projectionBytes = Buffer.from(JSON.stringify(projection([], raw)), 'utf8');
    const ref = await gate.capture(projectionBytes, 'utf8');
    gate.append('assistant/message', { id, value: { kind: 'artifact-json', ref } });
    await gate.flush();
  }

  it('applies the same binding to an artifact-json assistant projection', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      await turnWithStoredAssistant(s, cfg, async (responseBody) => responseBody);
      const folded = await foldOf(home());
      expect(folded.snapshot().open?.messages).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('rejects an artifact-json assistant whose inner raw is a different artifact', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      await turnWithStoredAssistant(s, cfg, async () => {
        const gate = s.gate('turn', 0).gate;
        return gate.capture(Buffer.from('{"other":true}'), 'utf8');
      });
      await expect(foldOf(home())).rejects.toThrow(/response/);
    } finally {
      await s.close();
    }
  });
});

describe('fold: compaction and refusal sequencing invariants', () => {
  it('rejects a compaction summary that does not follow a start', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 0).gate;
      gate.append('compaction/summary', {
        id: 'e'.repeat(64), message: { role: 'user', content: 'x' }, sources: [cfg], replacementBytes: 1,
      });
      await gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/start|matching/);
    } finally {
      await s.close();
    }
  });

  it('rejects a duplicate compaction summary for one start', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 0).gate;
      const start: CompactionStart = {
        id: 'e'.repeat(64), revision: 'a'.repeat(64), groupIds: [cfg], sources: [cfg],
        shadowHash: 'b'.repeat(64), shadowBytes: 10,
      };
      const summary: CompactionSummary = {
        id: 'e'.repeat(64), message: { role: 'user', content: 'x' }, sources: [cfg], replacementBytes: 1,
      };
      gate.append('compaction/start', start);
      gate.append('compaction/summary', summary);
      gate.append('compaction/summary', summary);
      await gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/duplicate/);
    } finally {
      await s.close();
    }
  });

  it('rejects a compaction abort for an id with no matching start', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 0).gate;
      gate.append('compaction/abort', { id: 'ghost', reason: 'orphan' });
      await gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/abort|matching/);
    } finally {
      await s.close();
    }
  });

  it('rejects a duplicate request/refused for one request', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const gate = s.gate('turn', 0).gate;
      const id: RequestId = { turn: 0, ordinal: 0 };
      gate.append('request/refused', { id, bytes: 5, limit: 10, phase: 'plan' });
      gate.append('request/refused', { id, bytes: 5, limit: 10, phase: 'plan' });
      await gate.flush();
      await expect(foldOf(home())).rejects.toThrow(/refused/);
    } finally {
      await s.close();
    }
  });
});

describe('fold: acknowledgement is filtered by turn on the live path only', () => {
  it('returns null for a live perception-less turn and keeps the prior proof for resume', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t0 = await pipeline(s, 0, cfg, { perceptionText: 'first evidence' });
      await t0.gate.flush();
      const live = await foldOf(home());
      expect(live.acknowledgedWorld(0)?.turn).toBe(0);

      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' }, { ignorable: true });
      await s.writer.flush();
      // With no open turn the latest proof is the resume acknowledgement.
      expect((await foldOf(home())).acknowledgedWorld()?.turn).toBe(0);

      s.lifecycle('turn/start', { turn: 1, trigger: 'boot', world: { from: null, to: null } });
      await s.writer.flush();
      const next = await foldOf(home());
      expect(next.snapshot().open?.turn).toBe(1);
      // Live path: this turn recorded no perception, so the durable turn-0 proof
      // is stale and must not be offered as this turn's acknowledgement.
      expect(next.acknowledgedWorld(1)).toBeNull();
      // Resume path: a replayed open turn/start with no perception still needs
      // the prior proof to rebuild the watermark.
      expect(next.acknowledgedWorld()?.turn).toBe(0);
    } finally {
      await s.close();
    }
  });

  it('rebuilds the resume watermark from the prior proof after a crash mid-turn', async () => {
    const { home: path, world } = fixture();
    const previous = 'b'.repeat(64);
    const s = await openSession(path);
    try {
      await startConfig(s);
      s.lifecycle('turn/start', {
        turn: 0, trigger: 'boot', world: { from: null, to: previous },
      });
      const gate = s.gate('turn', 0).gate;
      gate.append('world/perception', {
        turn: 0, range: { from: null, to: previous },
        value: { kind: 'inline', value: perception('shown', { from: null, to: previous }) },
      });
      // A dialogue is not needed: the perception is the acknowledgement.
      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' });
      await s.writer.flush();
      // Crash mid-turn: turn 1's opening is durable, its perception is not.
      s.lifecycle('turn/start', {
        turn: 1, trigger: 'wakeup', world: { from: previous, to: null },
      });
      await s.writer.flush();
    } finally {
      await s.close();
    }

    const fold = new ContextFold();
    const seen: WorldRange[] = [];
    let driver: NodeDriver | null = null;
    driver = await NodeDriver.open(path, 'n1', (ctx) => {
      seen.push(ctx.world);
      driver!.stop();
      return { outcome: 'waiting', toolCalls: false };
    }, world, { knownTypes: C13_EVENT_TYPES, hooks: hooksFor(fold, path), worldPollMs: 0 });
    await driver.run();

    // Resume returned the prior turn's proof, so the interrupted turn's range is
    // re-presented and the next turn opens from the last perceived HEAD.
    expect(seen).toEqual([{ from: previous, to: await world.headHash() }]);
    expect(fold.acknowledgedWorld()?.turn).toBe(0);
  });
});

describe('fold: forged chain-valid payloads fail as typed invariants', () => {
  async function foldError(path: string): Promise<unknown> {
    try {
      await foldOf(path);
      return null;
    } catch (err) {
      return err;
    }
  }

  function expectInvariant(err: unknown, pattern: RegExp): void {
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/context fold invariant failure/);
    expect((err as Error).message).toMatch(pattern);
  }

  function rawAppend(s: Session, type: string, data: JsonValue): void {
    (s.writer.append as unknown as (t: string, d: JsonValue) => EventEnvelope)(type, data);
  }

  it('rejects a malformed turn/start world', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: null });
      await s.writer.flush();
      expectInvariant(await foldError(home()), /turn\/start\.world/);
    } finally {
      await s.close();
    }
  });

  it('rejects an unknown turn/end outcome instead of treating it as failure', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      s.lifecycle('turn/end', { turn: 0, outcome: 'mystery' });
      await s.writer.flush();
      expectInvariant(await foldError(home()), /outcome/);
    } finally {
      await s.close();
    }
  });

  it('rejects a tool/result whose message is null', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const t = await pipeline(s, 0, cfg, { calls: [call('c1')] });
      await t.gate.flush();
      rawAppend(s, 'tool/result', {
        turn: 0, request: t.id, callId: 'c1', message: null,
        isError: false, raw: null, failure: null, synthetic: false,
      } as unknown as JsonValue);
      await s.writer.flush();
      expectInvariant(await foldError(home()), /tool\/result\.message/);
    } finally {
      await s.close();
    }
  });

  it('rejects a compaction/start without a sources array', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const hash = 'a'.repeat(64);
      rawAppend(s, 'compaction/start', {
        id: hash, revision: hash, groupIds: [], shadowHash: hash, shadowBytes: 1,
      });
      await s.writer.flush();
      expectInvariant(await foldError(home()), /compaction\/start\.sources/);
    } finally {
      await s.close();
    }
  });

  it('rejects a compaction/summary with a null message', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      rawAppend(s, 'compaction/summary', {
        id: 'a'.repeat(64), message: null, sources: [], replacementBytes: 1,
      } as unknown as JsonValue);
      await s.writer.flush();
      expectInvariant(await foldError(home()), /compaction\/summary\.message/);
    } finally {
      await s.close();
    }
  });

  it('rejects a compaction/end whose summary is null', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      rawAppend(s, 'compaction/end', {
        id: 'a'.repeat(64), summary: null,
      } as unknown as JsonValue);
      await s.writer.flush();
      expectInvariant(await foldError(home()), /compaction\/end\.summary/);
    } finally {
      await s.close();
    }
  });

  it('rejects a compaction/abort with a non-object payload', async () => {
    const s = await openSession(home());
    try {
      await startConfig(s);
      s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      rawAppend(s, 'compaction/abort', null);
      await s.writer.flush();
      expectInvariant(await foldError(home()), /compaction\/abort/);
    } finally {
      await s.close();
    }
  });

  it('rejects forged payloads at every remaining handler boundary', async () => {
    const cases: Array<{
      readonly type: string; readonly data: JsonValue; readonly pattern: RegExp;
      readonly turn: boolean;
    }> = [
      {
        type: 'system/message', data: { version: 0, value: null },
        pattern: /system\/message\.value/, turn: false,
      },
      {
        type: 'world/perception',
        data: { turn: 0, range: null, value: { kind: 'inline', value: {} } },
        pattern: /world\/perception\.range/, turn: true,
      },
      {
        type: 'request/plan', data: { id: null, value: { kind: 'inline', value: {} } },
        pattern: /request\/plan\.id/, turn: true,
      },
      {
        type: 'request/refused', data: { id: null, bytes: 1, limit: 2, phase: 'plan' },
        pattern: /request\/refused\.id/, turn: true,
      },
      {
        type: 'request/wire',
        data: { id: null, attempt: 0, body: null },
        pattern: /request\/wire\.id/, turn: true,
      },
      {
        type: 'response/raw',
        data: { id: null, attempt: 0, status: 200, body: null, complete: true },
        pattern: /response\/raw\.id/, turn: true,
      },
      {
        type: 'assistant/message', data: { id: null, value: { kind: 'inline', value: {} } },
        pattern: /assistant\/message\.id/, turn: true,
      },
      {
        type: 'tool/call', data: { turn: 0, request: null, call: null },
        pattern: /tool\/call\.request/, turn: true,
      },
    ];

    for (const c of cases) {
      // Each case needs its own journal: `home()` is one directory per test.
      const path = await mkdtemp(join(tmpdir(), 'c13-forged-'));
      const s = await openSession(path);
      try {
        if (c.turn) {
          await startConfig(s);
          s.lifecycle('turn/start', {
            turn: 0, trigger: 'boot', world: { from: null, to: null },
          });
        }
        rawAppend(s, c.type, c.data);
        await s.writer.flush();
        expectInvariant(await foldError(path), c.pattern);
      } finally {
        await s.close();
        await rm(path, { recursive: true, force: true });
      }
    }
  });
});

describe('fold: an invariant never leaves the cached surface half-changed', () => {
  /**
   * Opens turn 0 with a nonempty perception and a two-call assistant whose second
   * call has no result, leaving a durable state an ordinary closer would promote
   * from an unbalanced dialogue.
   */
  async function unbalancedTurn(s: Session, cfg: Source): Promise<ContextFold> {
    const fold = new ContextFold();
    const syncTo = async (): Promise<void> => {
      await fold.observe(await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES));
    };
    await syncTo();
    s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    const gate = s.gate('turn', 0).gate;
    gate.append('world/perception', {
      turn: 0, range: { from: null, to: null },
      value: { kind: 'inline', value: perception('evidence') },
    });
    const id: RequestId = { turn: 0, ordinal: 0 };
    gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
    const body = await gate.capture(Buffer.from('{}'), 'utf8');
    gate.append('request/wire', { id, attempt: 0, body });
    const raw = await gate.capture(Buffer.from('{"ok":true}'), 'utf8');
    gate.append('response/raw', { id, attempt: 0, status: 200, body: raw, complete: true });
    gate.append('assistant/message', {
      id, value: await gate.store(projection([call('c1'), call('c2')], raw)),
    });
    gate.append('tool/call', { turn: 0, request: id, call: call('c1') });
    gate.append('tool/result', result(id, 0, 'c1') as never);
    gate.append('tool/call', { turn: 0, request: id, call: call('c2') });
    await gate.flush();
    await syncTo();
    return fold;
  }

  it('refuses an unbalanced dialogue under a successful closer before appending', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const fold = await unbalancedTurn(s, cfg);
      const before = fold.snapshot().surface;
      expect(before?.nodes).toHaveLength(1);

      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' });
      await s.writer.flush();
      await expect(fold.observe(await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES)))
        .rejects.toThrow(/unbalanced/);
      expect(fold.snapshot().surface).toEqual(before);
      expect(fold.snapshot().surface?.nodes).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('fail-stops after a fatal invariant and refuses re-delivery onto partial state', async () => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      const fold = await unbalancedTurn(s, cfg);
      const before = fold.snapshot().surface;

      s.lifecycle('turn/end', { turn: 0, outcome: 'waiting' });
      await s.writer.flush();
      await expect(fold.observe(await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES)))
        .rejects.toThrow(/unbalanced/);
      // The same fold now refuses any further observation rather than re-delivering
      // the batch onto the partially-mutated cache...
      await expect(fold.observe(await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES)))
        .rejects.toThrow(/poisoned/);
      // ...its cached snapshot is unchanged, and a fresh fold is unaffected.
      expect(fold.snapshot().surface).toEqual(before);
      const fresh = new ContextFold();
      await expect(fresh.observe(await loadVerifiedEvents(home(), 'n1', C13_EVENT_TYPES)))
        .rejects.toThrow(/unbalanced/);
    } finally {
      await s.close();
    }
  });
});

// --- request sequencing invariants, table-driven (T3 audit M2) -------------------

/**
 * Every row starts from a real writer, a real config and, where it matters, a
 * real folded prefix, then appends the one event (or event pair) that violates a
 * sequencing rule. The gate is bypassed with `rawAppend` only where it would
 * reject the forged fact before the fold could own the invariant.
 */
describe('fold: request-sequencing invariants fail closed', () => {
  type InvariantCase = {
    readonly name: string;
    readonly pattern: RegExp;
    readonly run: (s: Session, cfg: Source) => Promise<void>;
  };

  function beginTurn(s: Session, turn = 0): BoundaryGate {
    s.lifecycle('turn/start', { turn, trigger: 'boot', world: { from: null, to: null } });
    return s.gate('turn', turn).gate;
  }

  function rawAppend(s: Session, type: string, data: JsonValue): void {
    (s.writer.append as unknown as (t: string, d: JsonValue) => EventEnvelope)(type, data);
  }

  /** Plan, wire, response and assistant, with tool/call receipts controlled by the caller. */
  async function announced(
    s: Session, cfg: Source, calls: FunctionCall[], receipts: boolean,
  ): Promise<{ id: RequestId; gate: BoundaryGate; raw: ArtifactRef }> {
    const gate = beginTurn(s);
    gate.append('world/perception', {
      turn: 0, range: { from: null, to: null },
      value: { kind: 'inline', value: perception('evidence') },
    });
    const id: RequestId = { turn: 0, ordinal: 0 };
    gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
    const body = await gate.capture(Buffer.from('{}'), 'utf8');
    gate.append('request/wire', { id, attempt: 0, body });
    const raw = await gate.capture(Buffer.from('{"ok":true}'), 'utf8');
    gate.append('response/raw', { id, attempt: 0, status: 200, body: raw, complete: true });
    gate.append('assistant/message', {
      id, value: await gate.store(projection(calls, raw)),
    });
    if (receipts) for (const call of calls) gate.append('tool/call', { turn: 0, request: id, call });
    return { id, gate, raw };
  }

  const cases: readonly InvariantCase[] = [
    {
      name: 'turn/start while a turn is already open',
      pattern: /turn\/start while a turn is already open/,
      run: async (s) => {
        s.lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
        s.lifecycle('turn/start', { turn: 1, trigger: 'boot', world: { from: null, to: null } });
      },
    },
    {
      name: 'duplicate request/plan',
      pattern: /duplicate request\/plan/,
      run: async (s, cfg) => {
        const t = await pipeline(s, 0, cfg, {});
        t.gate.append('request/plan', {
          id: t.id, value: await t.gate.store(minimalPlan(t.id, cfg)),
        });
      },
    },
    {
      name: 'request/plan id does not match its payload',
      pattern: /request\/plan id does not match its payload/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        gate.append('request/plan', {
          id: { turn: 0, ordinal: 0 },
          value: await gate.store(minimalPlan({ turn: 0, ordinal: 1 }, cfg)),
        });
      },
    },
    {
      name: 'request/plan config differs from the active config',
      pattern: /request\/plan config does not equal the active config/,
      run: async (s) => {
        const gate = beginTurn(s);
        const foreign = { seq: 999, hash: 'c'.repeat(64) };
        gate.append('request/plan', {
          id: { turn: 0, ordinal: 0 },
          value: await gate.store(minimalPlan({ turn: 0, ordinal: 0 }, foreign)),
        });
      },
    },
    {
      name: 'request/wire without a recorded plan',
      pattern: /request\/wire without a recorded plan/,
      run: async (s) => {
        const gate = beginTurn(s);
        const body = await gate.capture(Buffer.from('{}'), 'utf8');
        gate.append('request/wire', { id: { turn: 0, ordinal: 0 }, attempt: 0, body });
      },
    },
    {
      name: 'duplicate first request/wire',
      pattern: /duplicate first request\/wire/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        const id: RequestId = { turn: 0, ordinal: 0 };
        gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
        const body = await gate.capture(Buffer.from('{}'), 'utf8');
        gate.append('request/wire', { id, attempt: 0, body });
        gate.append('request/wire', { id, attempt: 0, body });
      },
    },
    {
      name: 'retry request/wire with different body bytes',
      pattern: /retry request\/wire does not reuse the first body/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        const id: RequestId = { turn: 0, ordinal: 0 };
        gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
        const first = await gate.capture(Buffer.from('{}'), 'utf8');
        const second = await gate.capture(Buffer.from('{"changed":true}'), 'utf8');
        gate.append('request/wire', { id, attempt: 0, body: first });
        gate.append('request/wire', { id, attempt: 1, body: second });
      },
    },
    {
      name: 'duplicate request/wire attempt',
      pattern: /duplicate request\/wire attempt/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        const id: RequestId = { turn: 0, ordinal: 0 };
        gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
        const body = await gate.capture(Buffer.from('{}'), 'utf8');
        gate.append('request/wire', { id, attempt: 0, body });
        gate.append('request/wire', { id, attempt: 1, body });
        gate.append('request/wire', { id, attempt: 1, body });
      },
    },
    {
      name: 'response/raw without a preceding wire',
      pattern: /response\/raw without a preceding wire/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        const id: RequestId = { turn: 0, ordinal: 0 };
        gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
        const raw = await gate.capture(Buffer.from('raw'), 'utf8');
        gate.append('response/raw', { id, attempt: 0, status: 200, body: raw, complete: true });
      },
    },
    {
      name: 'duplicate response/raw for an attempt',
      pattern: /duplicate response\/raw for an attempt/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        const id: RequestId = { turn: 0, ordinal: 0 };
        gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
        const body = await gate.capture(Buffer.from('{}'), 'utf8');
        gate.append('request/wire', { id, attempt: 0, body });
        const raw = await gate.capture(Buffer.from('raw'), 'utf8');
        gate.append('response/raw', { id, attempt: 0, status: 200, body: raw, complete: true });
        gate.append('response/raw', { id, attempt: 0, status: 200, body: raw, complete: true });
      },
    },
    {
      name: 'assistant/message without a recorded plan',
      pattern: /assistant\/message without a recorded plan/,
      run: async (s) => {
        const gate = beginTurn(s);
        const raw = await gate.capture(Buffer.from('raw'), 'utf8');
        gate.append('assistant/message', {
          id: { turn: 0, ordinal: 0 },
          value: await gate.store(projection([], raw)),
        });
      },
    },
    {
      name: 'assistant/message without a preceding wire',
      pattern: /assistant\/message without a preceding wire/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        const id: RequestId = { turn: 0, ordinal: 0 };
        gate.append('request/plan', { id, value: await gate.store(minimalPlan(id, cfg)) });
        const raw = await gate.capture(Buffer.from('raw'), 'utf8');
        gate.append('assistant/message', { id, value: await gate.store(projection([], raw)) });
      },
    },
    {
      name: 'duplicate assistant/message for a request',
      pattern: /duplicate assistant\/message for a request/,
      run: async (s, cfg) => {
        const t = await announced(s, cfg, [], false);
        t.gate.append('assistant/message', {
          id: t.id, value: await t.gate.store(projection([], t.raw)),
        });
      },
    },
    {
      name: 'tool/call was not advertised',
      pattern: /tool\/call c2 was not advertised/,
      run: async (s, cfg) => {
        const t = await pipeline(s, 0, cfg, { calls: [call('c1')] });
        t.gate.append('tool/call', { turn: 0, request: t.id, call: call('c2') });
      },
    },
    {
      name: 'tool/call arguments disagree with the advertised call',
      pattern: /tool\/call c1 disagrees with the advertised call/,
      run: async (s, cfg) => {
        const t = await pipeline(s, 0, cfg, { calls: [call('c1')] });
        t.gate.append('tool/call', {
          turn: 0, request: t.id,
          call: { id: 'c1', type: 'function', function: { name: 'execute', arguments: '{"cmd":"x"}' } },
        });
      },
    },
    {
      name: 'duplicate tool/result for a call',
      pattern: /duplicate tool\/result for c1/,
      run: async (s, cfg) => {
        const t = await pipeline(s, 0, cfg, { calls: [call('c1')] });
        t.gate.append('tool/result', result(t.id, 0, 'c1') as never);
        t.gate.append('tool/result', result(t.id, 0, 'c1') as never);
      },
    },
    {
      name: 'tool/result without a preceding tool/call',
      pattern: /tool\/result without a preceding tool\/call/,
      run: async (s, cfg) => {
        const t = await announced(s, cfg, [call('c1')], false);
        t.gate.append('tool/result', result(t.id, 0, 'c1') as never);
      },
    },
    {
      name: 'non-synthetic tool/result outside its turn',
      pattern: /non-synthetic tool\/result outside its turn/,
      run: async (s) => {
        beginTurn(s);
        rawAppend(s, 'tool/result', result({ turn: 1, ordinal: 0 }, 1, 'c1'));
      },
    },
    {
      name: 'compaction/end without a matching summary',
      pattern: /compaction\/end without a matching summary/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        const id = 'a'.repeat(64);
        gate.append('compaction/start', {
          id, revision: 'b'.repeat(64), groupIds: [cfg], sources: [cfg],
          shadowHash: 'c'.repeat(64), shadowBytes: 1,
        });
        rawAppend(s, 'compaction/end', { id, summary: { seq: 0, hash: cfg.hash } });
      },
    },
    {
      name: 'compaction/end cites a different summary receipt',
      pattern: /compaction\/end summary source does not match the recorded summary/,
      run: async (s, cfg) => {
        const gate = beginTurn(s);
        const first = 'a'.repeat(64);
        const second = 'b'.repeat(64);
        let secondSummary: Source | null = null;
        for (const id of [first, second]) {
          gate.append('compaction/start', {
            id, revision: 'c'.repeat(64), groupIds: [cfg], sources: [cfg],
            shadowHash: 'd'.repeat(64), shadowBytes: 1,
          });
          const summary = gate.append('compaction/summary', {
            id, message: { role: 'user', content: 'older context removed' },
            sources: [cfg], replacementBytes: 1,
          });
          if (id === second) secondSummary = summary;
        }
        // The fold holds both summaries; ending the first with the second's
        // receipt is a provenance mismatch, not a missing summary.
        const other = secondSummary!;
        gate.append('compaction/end', {
          id: first, summary: { seq: other.seq, hash: other.hash },
        });
      },
    },
    {
      name: 'duplicate world/perception for a turn',
      pattern: /duplicate world\/perception for the turn/,
      run: async (s) => {
        const gate = beginTurn(s);
        const value = { kind: 'inline' as const, value: perception('evidence') };
        gate.append('world/perception', {
          turn: 0, range: { from: null, to: null }, value,
        });
        gate.append('world/perception', {
          turn: 0, range: { from: null, to: null }, value,
        });
      },
    },
    {
      name: 'config version regression',
      pattern: /config version must strictly increase/,
      run: async (s) => {
        const ready = s.gate('ready', null).gate;
        ready.append('system/message', {
          version: 1,
          value: { kind: 'inline', value: { ...defaultAgentConfig(), heading: 'A different heading.' } },
        });
      },
    },
  ];

  it.each(cases)('$name', async ({ pattern, run }) => {
    const s = await openSession(home());
    try {
      const cfg = await startConfig(s);
      await run(s, cfg);
      await s.writer.flush();
      await expect(foldOf(home())).rejects.toThrow(pattern);
    } finally {
      await s.close();
    }
  }, 15000);
});

describe('fold: observation identity fails closed', () => {
  const GENESIS = '0'.repeat(64);
  const hashFor = (seq: number): string => (seq + 1).toString(16).padStart(64, '0');

  function boot(seq: number): VerifiedEvent {
    const envelope = {
      v: 0, seq, time: 1, prev_hash: GENESIS, hash: hashFor(seq), type: 'node/boot', data: {},
    } as EventEnvelope;
    return { ...envelope, raw: envelope };
  }

  it('rejects a changed hash at an already-observed seq', async () => {
    const fold = new ContextFold();
    await fold.observe([boot(0)]);
    const changed = boot(0);
    const raw = { ...changed.raw, hash: 'f'.repeat(64) };
    await expect(fold.observe([{ ...raw, raw }])).rejects.toThrow(/changed hash at seq 0/);
  });

  it('rejects a gap in seq on observation', async () => {
    const fold = new ContextFold();
    await expect(fold.observe([boot(1)])).rejects.toThrow(
      /gap in observation: expected seq 0, received 1/);
  });

  it('skips an identical (seq,hash) and continues from the observed prefix', async () => {
    const fold = new ContextFold();
    await fold.observe([boot(0)]);
    await fold.observe([boot(0), boot(1)]);
    expect(fold.verifiedEvents().map((event) => event.raw.seq)).toEqual([0, 1]);
  });
});
