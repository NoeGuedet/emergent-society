import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { sha256HexOf } from '../../journal/canon.js';
import { useTempHome, withFailingWrite } from '../../journal/__tests__/helpers.js';
import type { BoundaryGate, DriverHooks, GateCallbacks } from '../../node/gate.js';
import { createBoundaryGate } from '../../node/gate.js';
import { NodeDriver } from '../../node/driver.js';
import { useWorld } from '../../node/__tests__/helpers.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../events.js';
import { defaultAgentConfig } from '../config.js';
import { ContextFold } from '../fold.js';
import { SurfacePolicyError } from '../surface.js';
import { loadVerifiedEvents } from '../loader.js';
import { canonicalBytes } from '../artifacts.js';
import type {
  ArtifactRef, AssistantProjection, CompactionStart, FunctionCall, RequestId, RequestPlan, Source,
  WorldPerception,
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
  return { writer, gate, lifecycle, close: () => writer.close() };
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
      const shadow = Buffer.from(canonicalBytes(group.messages));
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
        replacementBytes: canonicalBytes([message]).length,
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
      const shadow = Buffer.from(canonicalBytes(group.messages));
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
      await expect(running).rejects.toThrow('injected EIO');
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
