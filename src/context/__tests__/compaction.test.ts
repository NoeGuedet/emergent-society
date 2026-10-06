import { describe, expect, it } from 'vitest';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { sha256HexOf } from '../../journal/canon.js';
import { createBoundaryGate } from '../../node/gate.js';
import type { BoundaryGate } from '../../node/gate.js';
import { canonicalMessagesBytes } from '../../provider/wire.js';
import { assemble } from '../assembler.js';
import { canonicalBytes } from '../artifacts.js';
import { COMPACTION_NOTICE, runCompaction, selectCompaction } from '../compaction.js';
import { defaultAgentConfig } from '../config.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../events.js';
import { ContextFold } from '../fold.js';
import { loadVerifiedEvents } from '../loader.js';
import type { VerifiedEvents } from '../loader.js';
import { useTempHome } from '../../journal/__tests__/helpers.js';
import type {
  AgentConfig, AssistantProjection, ChatMessage, CompactionStart, FunctionCall,
  RequestId, SeedPolicy, Source, SurfaceGroup, WorldPerception,
} from '../contracts.js';

const home = useTempHome('c13-compaction-');

/** Structural receipt identity: works for an `EventEnvelope` or a `VerifiedEvent`. */
const source = (event: { seq: number; hash: string }): Source =>
  ({ seq: event.seq, hash: event.hash });

const SAME = (a: Source, b: Source): boolean => a.seq === b.seq && a.hash === b.hash;

function sortUnique(sources: readonly Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources) {
    const key = `${s.seq}:${s.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ seq: s.seq, hash: s.hash });
  }
  out.sort((a, b) => (a.seq - b.seq) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return out;
}

function eventsAt(path: string): Promise<VerifiedEvents> {
  return loadVerifiedEvents(path, 'n1', C13_EVENT_TYPES);
}

const call = (id: string): FunctionCall =>
  ({ id, type: 'function', function: { name: 'execute', arguments: JSON.stringify({ cmd: 'true' }) } });

const perception = (text: string): WorldPerception => ({
  uid: 'n1', range: { from: null, to: null }, effectiveFrom: null, fallback: 'none',
  renderer: { policy: 'commit-patches-v1', gitVersion: 'git version 2.43.0', attrSource: 'to' },
  maxBytes: 32768, maxCommits: 4096, listTruncated: false, commits: [], included: [], omittedOwn: [],
  text, truncated: false,
});

function testConfig(opts: {
  version?: number; heading?: string; policy?: Partial<SeedPolicy>;
} = {}): AgentConfig {
  const base = defaultAgentConfig();
  return {
    ...base,
    version: opts.version ?? base.version,
    heading: opts.heading ?? base.heading,
    policy: { ...base.policy, ...(opts.policy ?? {}) },
  };
}

// --- one writer-backed session, kept in sync with a live fold ----------------------

type Session = {
  readonly fold: ContextFold;
  gate(scope: { phase: 'ready' | 'turn'; turn: number | null }): { gate: BoundaryGate; close: () => void };
  lifecycle(type: 'turn/start' | 'turn/end', data: JsonValue, opts?: { ignorable?: boolean }): EventEnvelope;
  flush(): Promise<void>;
  armFault(offset: number): void;
  armInject(offset: number, fn: () => Promise<void>): void;
  appendConfig(config: AgentConfig): Promise<void>;
  shutdown(): Promise<void>;
};

/**
 * A writer-backed session that mirrors the driver's durable observation seam: every
 * `flush` writes the journal and then folds the newly durable events into the live
 * fold *before* resolving, so a recheck after an await sees an injected fact.
 * `armFault`/`armInject` fault or inject at a flush position counted from the arm.
 */
async function openSession(): Promise<Session> {
  const writer = await JournalWriter.open(home(), 'n1');
  const controller = new AbortController();
  const receipts = new Map<string, EventEnvelope>();
  const fold = new ContextFold();
  const sync = async (): Promise<void> => {
    await fold.observe(await eventsAt(home()));
  };
  for (const event of await eventsAt(home())) {
    receipts.set(`${event.raw.seq}:${event.raw.hash}`, event.raw);
  }
  await sync();
  const record = (receipt: EventEnvelope): EventEnvelope => {
    receipts.set(`${receipt.seq}:${receipt.hash}`, receipt);
    return receipt;
  };
  const lookup = (s: Source): EventEnvelope | null => receipts.get(`${s.seq}:${s.hash}`) ?? null;

  let flushCount = 0;
  let armBase = 0;
  let faultOffset: number | null = null;
  let injectOffset: number | null = null;
  let injectFn: (() => Promise<void>) | null = null;
  const flush = async (): Promise<void> => {
    flushCount += 1;
    const delta = flushCount - armBase;
    if (faultOffset !== null && delta === faultOffset) {
      faultOffset = null;
      throw new Error('injected flush fault');
    }
    await writer.flush();
    if (injectOffset !== null && delta === injectOffset) {
      injectOffset = null;
      const fn = injectFn;
      injectFn = null;
      if (fn !== null) await fn();
    }
    await sync();
  };
  const callbacks = {
    append: (type: string, data: JsonValue): EventEnvelope =>
      record(writer.append(type, data as never)),
    flush,
    lookup,
    readBlob: (hash: string): Promise<Uint8Array> => new BlobStore(home()).get(hash),
    now: (): number => 100,
  };
  const gates: Array<() => void> = [];
  const gate = (scope: { phase: 'ready' | 'turn'; turn: number | null }) => {
    const created = createBoundaryGate(
      createBoundaryRegistry(),
      { phase: scope.phase, turn: scope.turn, signal: controller.signal, lookup },
      callbacks,
    );
    gates.push(created.close);
    return created;
  };
  const lifecycle = (
    type: 'turn/start' | 'turn/end', data: JsonValue, opts?: { ignorable?: boolean },
  ): EventEnvelope => record(writer.append(type, data as never, opts));
  const appendConfig = async (config: AgentConfig): Promise<void> => {
    const created = gate({ phase: 'ready', turn: null });
    try {
      created.gate.append('system/message',
        { version: config.version, value: { kind: 'inline', value: config } });
      await created.gate.flush();
    } finally {
      created.close();
    }
  };
  const shutdown = async (): Promise<void> => {
    for (const close of gates) close();
    await writer.close();
    controller.abort();
  };
  return {
    fold, gate, lifecycle, flush, appendConfig, shutdown,
    armFault: (offset): void => { armBase = flushCount; faultOffset = offset; },
    armInject: (offset, fn): void => { armBase = flushCount; injectOffset = offset; injectFn = fn; },
  };
}

/** Appends one full request pipeline for an open turn; `attempted` controls result coverage. */
async function pipeline(
  session: Session, turn: number, ordinal: number, callIds: readonly string[],
  attempted: number, resultChars: number,
): Promise<void> {
  const t = session.gate({ phase: 'turn', turn });
  try {
    const id: RequestId = { turn, ordinal };
    const plan = assemble({ id, state: session.fold.snapshot() });
    t.gate.append('request/plan', { id, value: await t.gate.store(plan) });
    const wireRef = await t.gate.capture(Buffer.from('wire-body'), 'utf8');
    t.gate.append('request/wire', { id, attempt: 0, body: wireRef });
    const rawRef = await t.gate.capture(Buffer.from('{"ok":true}'), 'utf8');
    t.gate.append('response/raw', { id, attempt: 0, status: 200, body: rawRef, complete: true });
    const projection: AssistantProjection = {
      message: { role: 'assistant', content: null, tool_calls: callIds.map(call) },
      contentTruncated: false, raw: rawRef,
    };
    t.gate.append('assistant/message', { id, value: await t.gate.store(projection) });
    for (let i = 0; i < callIds.length; i++) {
      const cid = callIds[i]!;
      t.gate.append('tool/call', { turn, request: id, call: call(cid) });
      if (i < attempted) {
        t.gate.append('tool/result', {
          turn, request: id, callId: cid,
          message: { role: 'tool', content: 'r'.repeat(resultChars), tool_call_id: cid },
          isError: false, raw: null, failure: null, synthetic: false,
        });
      }
    }
    await session.flush();
  } finally {
    t.close();
  }
}

/** A closed turn whose single dialogue group is an assistant with two calls and two results. */
async function closedDialogue(
  session: Session, turn: number, callIds: readonly string[], resultChars: number,
): Promise<void> {
  session.lifecycle('turn/start', { turn, trigger: 'chain', world: { from: null, to: null } });
  const t = session.gate({ phase: 'turn', turn });
  try {
    t.gate.append('world/perception', {
      turn, range: { from: null, to: null }, value: { kind: 'inline', value: perception('') },
    });
    await session.flush();
    await pipeline(session, turn, 0, callIds, callIds.length, resultChars);
    session.lifecycle('turn/end', { turn, outcome: 'waiting' });
    await session.flush();
  } finally {
    t.close();
  }
}

/** A closed turn that only promotes a nonempty external perception group. */
async function closedPerception(session: Session, turn: number, text: string): Promise<void> {
  session.lifecycle('turn/start', { turn, trigger: 'chain', world: { from: null, to: null } });
  const t = session.gate({ phase: 'turn', turn });
  try {
    t.gate.append('world/perception', {
      turn, range: { from: null, to: null }, value: { kind: 'inline', value: perception(text) },
    });
    session.lifecycle('turn/end', { turn, outcome: 'waiting' }, { ignorable: true });
    await session.flush();
  } finally {
    t.close();
  }
}

function balanced(group: SurfaceGroup): boolean {
  if (group.kind === 'heading') {
    const only = group.messages[0];
    return group.messages.length === 1 && only !== undefined && only.role === 'system';
  }
  if (group.kind === 'summary' || group.kind === 'perception') {
    const only = group.messages[0];
    return group.messages.length === 1 && only !== undefined && only.role === 'user';
  }
  if (group.kind !== 'dialogue') return false;
  const assistant = group.messages[0];
  if (assistant === undefined || assistant.role !== 'assistant') return false;
  const ids = assistant.tool_calls.map((c) => c.id);
  const results = group.messages.slice(1);
  if (group.messages.length !== 1 + ids.length) return false;
  return results.every((m, i): m is Extract<ChatMessage, { role: 'tool' }> =>
    m.role === 'tool' && m.tool_call_id === ids[i]);
}

// ==================================================================================
// C. Durable compaction applies only after end (installed as written)
// ==================================================================================

describe('completed markers only', () => {
  it('does not apply start plus summary, then applies one verified end idempotently', async () => {
    const writer = await JournalWriter.open(home(), 'n1');
    try {
      const config = defaultAgentConfig();
      writer.append('system/message', { version: 1, value: { kind: 'inline', value: config } });
      writer.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
      const perception = writer.append('world/perception', {
        turn: 0, range: { from: null, to: null }, value: { kind: 'inline', value: {
          uid: 'n1', range: { from: null, to: null }, effectiveFrom: null, fallback: 'none',
          renderer: { policy: 'commit-patches-v1', gitVersion: 'git version 2.43.0', attrSource: 'to' },
          maxBytes: 32768, maxCommits: 4096, listTruncated: false,
          commits: [], included: [], omittedOwn: [],
          text: 'external evidence '.repeat(100), truncated: false,
        } },
      });
      writer.append('turn/end', { turn: 0, outcome: 'waiting' }, { ignorable: true });
      await writer.flush();
      const fold = new ContextFold();
      await fold.observe(await eventsAt(home()));
      const before = fold.snapshot();
      if (!before.surface) throw new Error('missing surface');
      const group = before.surface.nodes[1]?.group;
      if (!group) throw new Error('missing perception group');
      const shadow = Buffer.from(canonicalBytes(group.messages));
      const candidate = {
        revision: before.surface.revision, groupIds: [group.id], sources: [source(perception)],
        shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length,
      };
      const start: CompactionStart = {
        id: sha256HexOf(Buffer.from(canonicalBytes(candidate))), ...candidate,
      };
      writer.append('compaction/start', start);
      const message = { role: 'user' as const, content: 'Older committed context was removed.' };
      const summary = writer.append('compaction/summary', {
        id: start.id, message, sources: start.sources,
        replacementBytes: canonicalBytes([message]).length,
      });
      await writer.flush();
      await fold.observe(await eventsAt(home()));
      expect(fold.snapshot().surface).toEqual(before.surface);
      writer.append('compaction/end', { id: start.id, summary: source(summary) });
      await writer.flush();
      const complete = await eventsAt(home());
      await fold.observe(complete);
      const after = fold.snapshot();
      expect(after.surface?.nodes.map((node) => node.position)).toEqual([0, 1]);
      expect(after.surface?.nodes[0]?.group.messages[0]?.content).toBe(config.heading);
      expect(after.surface?.nodes[1]?.group.messages[0]?.content).toBe(message.content);
      await fold.observe(complete);
      expect(fold.snapshot()).toEqual(after);
      const rebuilt = new ContextFold();
      await rebuilt.observe(complete);
      expect(rebuilt.snapshot()).toEqual(after);
    } finally {
      await writer.close();
    }
  });
});

// ==================================================================================
// T8 named fixtures
// ==================================================================================

describe('selectCompaction and whole committed groups', () => {
  it('compacts the oldest groups keeping the recent tail, then again after new groups and a heading change', async () => {    const session = await openSession();
    try {
      const config = testConfig({ policy: { keepRecentGroups: 2 } });
      await session.appendConfig(config);
      for (let turn = 0; turn < 10; turn++) {
        await closedDialogue(session, turn, [`t${turn}a`, `t${turn}b`], 20000);
      }
      const before = session.fold.snapshot();
      const nodes = before.surface?.nodes ?? [];
      expect(nodes.map((node) => node.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const removed = nodes.slice(1, 9).map((node) => node.group);
      expect(removed).toHaveLength(8);

      session.lifecycle('turn/start', { turn: 10, trigger: 'boot', world: { from: null, to: null } });
      await session.flush();
      const candidate = selectCompaction(session.fold.snapshot());
      expect(candidate).not.toBeNull();
      const gate = session.gate({ phase: 'turn', turn: 10 });
      try {
        const outcome = await runCompaction(session.fold, gate.gate);
        expect(outcome).toBe('applied');
      } finally {
        gate.close();
      }

      const start = (await eventsAt(home())).find((event) => event.type === 'compaction/start');
      const recorded = start?.data as unknown as CompactionStart;
      expect(recorded).toEqual(candidate);
      // Exact original receipts, deduplicated and receipt-ordered, never a subset.
      const expectedSources = sortUnique(removed.flatMap((group) => group.sources));
      expect(recorded.sources).toEqual(expectedSources);
      expect(recorded.sources.length).toBeGreaterThan(0);
      // Every source is a real receipt, and the removed group ids are exactly the span.
      const all = await eventsAt(home());
      const keys = new Set(all.map((event) => `${event.raw.seq}:${event.raw.hash}`));
      for (const s of recorded.sources) expect(keys.has(`${s.seq}:${s.hash}`)).toBe(true);
      expect(recorded.groupIds).toEqual(removed.map((group) => group.id));

      const after = session.fold.snapshot();
      expect(after.surface?.nodes.map((node) => node.position)).toEqual([0, 1, 2, 3]);
      expect(after.surface?.nodes[0]?.group.messages[0]?.content).toBe(config.heading);
      expect(after.surface?.nodes[1]?.group.kind).toBe('summary');
      expect(after.surface?.nodes[1]?.group.messages[0]?.content).toBe(COMPACTION_NOTICE);
      // The kept tail is the two most recent dialogues, still balanced.
      for (const node of after.surface?.nodes ?? []) expect(balanced(node.group)).toBe(true);

      const firstRevision = candidate!.revision;

      // Close the policy turn that ran the first transaction, then add new
      // committed groups and change the heading (config version 2). The heading
      // rewrite changes the surface revision, so a fresh candidate must be re-derived.
      session.lifecycle('turn/end', { turn: 10, outcome: 'waiting' }, { ignorable: true });
      await session.flush();
      for (let turn = 11; turn < 18; turn++) {
        await closedDialogue(session, turn, [`t${turn}a`, `t${turn}b`], 2000);
      }
      const heading = testConfig({
        version: 2, heading: 'A new shared direction.',
        policy: { compactAfterBytes: 1, keepRecentGroups: 2 },
      });
      await session.appendConfig(heading);
      session.lifecycle('turn/start', { turn: 18, trigger: 'boot', world: { from: null, to: null } });
      await session.flush();

      const beforeSecond = session.fold.snapshot();
      expect(beforeSecond.surface?.nodes[0]?.group.messages[0]?.content).toBe(heading.heading);
      const second = selectCompaction(beforeSecond);
      expect(second).not.toBeNull();
      expect(second!.revision).not.toBe(firstRevision);
      expect(second!.revision).toBe(beforeSecond.surface!.revision);
      // No duplicate sources and the span is the oldest contiguous run.
      const sourceKeys = second!.sources.map((s) => `${s.seq}:${s.hash}`);
      expect(new Set(sourceKeys).size).toBe(sourceKeys.length);
      const committed = (beforeSecond.surface?.nodes ?? []).filter((node) => node.group.kind !== 'heading');
      expect(second!.groupIds).toEqual(committed.slice(0, committed.length - 2).map((node) => node.group.id));

      const gate2 = session.gate({ phase: 'turn', turn: 18 });
      try {
        expect(await runCompaction(session.fold, gate2.gate)).toBe('applied');
      } finally {
        gate2.close();
      }
      const final = session.fold.snapshot();
      expect(final.surface?.nodes[0]?.group.messages[0]?.content).toBe(heading.heading);
      expect(final.surface?.nodes[1]?.group.kind).toBe('summary');
      expect(final.surface?.nodes[1]?.group.messages[0]?.content).toBe(COMPACTION_NOTICE);
      // No dangling result: every surviving dialogue is a balanced assistant+results group.
      const dialogues = (final.surface?.nodes ?? []).filter((node) => node.group.kind === 'dialogue');
      expect(dialogues.length).toBe(2);
      for (const node of dialogues) expect(balanced(node.group)).toBe(true);
      for (const node of final.surface?.nodes ?? []) expect(balanced(node.group)).toBe(true);
    } finally {
      await session.shutdown();
    }
  }, 20000);

  it('never selects a current open group, complete or incomplete', async () => {
    const session = await openSession();
    try {
      await session.appendConfig(testConfig({ policy: { compactAfterBytes: 1, keepRecentGroups: 1 } }));
      for (let turn = 0; turn < 3; turn++) {
        await closedDialogue(session, turn, [`t${turn}a`, `t${turn}b`], 2000);
      }
      const committed = session.fold.snapshot().surface?.nodes ?? [];
      const oldestIds = committed.slice(1, 3).map((node) => node.group.id);

      // Open turn 3: one complete two-call group (ordinal 0) and one incomplete (ordinal 1).
      session.lifecycle('turn/start', { turn: 3, trigger: 'chain', world: { from: null, to: null } });
      const t = session.gate({ phase: 'turn', turn: 3 });
      try {
        t.gate.append('world/perception', {
          turn: 3, range: { from: null, to: null }, value: { kind: 'inline', value: perception('') },
        });
        await session.flush();
        await pipeline(session, 3, 0, ['open-a', 'open-b'], 2, 2000);
        await pipeline(session, 3, 1, ['open-c', 'open-d'], 1, 2000);
      } finally {
        t.close();
      }

      const state = session.fold.snapshot();
      const candidate = selectCompaction(state);
      expect(candidate).not.toBeNull();
      expect(candidate!.groupIds).toEqual(oldestIds);

      const openSources = new Set((state.open?.sources ?? []).map((s) => `${s.seq}:${s.hash}`));
      expect(openSources.size).toBeGreaterThan(0);
      for (const id of candidate!.groupIds) {
        expect(openSources.has(`${id.seq}:${id.hash}`)).toBe(false);
      }
      for (const s of candidate!.sources) expect(openSources.has(`${s.seq}:${s.hash}`)).toBe(false);
      // Only the complete open group's messages are visible to assembly; neither is committed.
      expect(state.open?.messages).toHaveLength(3);
      const surfaceKeys = new Set(
        (state.surface?.nodes ?? []).flatMap((node) => node.group.sources.map((s) => `${s.seq}:${s.hash}`)),
      );
      for (const s of state.open?.sources ?? []) expect(surfaceKeys.has(`${s.seq}:${s.hash}`)).toBe(false);
    } finally {
      await session.shutdown();
    }
  });

  it('skips a tiny shadow without throwing and without a transaction', async () => {
    const session = await openSession();
    try {
      await session.appendConfig(testConfig({ policy: { compactAfterBytes: 1, keepRecentGroups: 4 } }));
      await closedPerception(session, 0, 'x');
      for (let turn = 1; turn < 5; turn++) {
        await closedDialogue(session, turn, [`t${turn}a`, `t${turn}b`], 2000);
      }
      const committed = session.fold.snapshot().surface?.nodes.length ?? 0;
      expect(committed).toBe(6);
      expect(selectCompaction(session.fold.snapshot())).toBeNull();

      session.lifecycle('turn/start', { turn: 5, trigger: 'boot', world: { from: null, to: null } });
      await session.flush();
      const gate = session.gate({ phase: 'turn', turn: 5 });
      try {
        expect(await runCompaction(session.fold, gate.gate)).toBe('skipped');
      } finally {
        gate.close();
      }
      const types = (await eventsAt(home())).map((event) => event.type);
      expect(types).not.toContain('compaction/start');
      expect(types).not.toContain('compaction/end');
    } finally {
      await session.shutdown();
    }
  });
});

describe('runCompaction transaction discipline', () => {
  it('aborts an orphan start+summary on restart with reason orphan and an unchanged surface', async () => {
    const prepared = await (async () => {
      const first = await openSession();
      try {
        await first.appendConfig(testConfig({ policy: { compactAfterBytes: 1, keepRecentGroups: 0 } }));
        await closedPerception(first, 0, 'external evidence');
        const before = first.fold.snapshot();
        const group = before.surface?.nodes[1]?.group;
        if (!group) throw new Error('missing perception group');
        const shadow = Buffer.from(canonicalMessagesBytes(group.messages));
        const candidate = {
          revision: before.surface!.revision, groupIds: [group.id], sources: group.sources,
          shadowHash: sha256HexOf(shadow), shadowBytes: shadow.length,
        };
        const start: CompactionStart = {
          id: sha256HexOf(Buffer.from(canonicalBytes(candidate))), ...candidate,
        };
        first.lifecycle('turn/start', { turn: 1, trigger: 'boot', world: { from: null, to: null } });
        const gate = first.gate({ phase: 'turn', turn: 1 });
        try {
          gate.gate.append('compaction/start', start);
          gate.gate.append('compaction/summary', {
            id: start.id, message: { role: 'user', content: COMPACTION_NOTICE },
            sources: start.sources,
            replacementBytes:
              canonicalMessagesBytes([{ role: 'user', content: COMPACTION_NOTICE }]).length,
          });
          await gate.gate.flush();
        } finally {
          gate.close();
        }
        return { before, startId: start.id };
      } finally {
        await first.shutdown();
      }
    })();

    // Restart: the orphan is visible, the surface is unchanged.
    const restarted = await openSession();
    try {
      expect(restarted.fold.orphanCompactions()).toHaveLength(1);
      expect(restarted.fold.snapshot().surface?.nodes).toEqual(prepared.before.surface?.nodes);
      const ready = restarted.gate({ phase: 'ready', turn: null });
      try {
        expect(await runCompaction(restarted.fold, ready.gate)).toBe('aborted');
      } finally {
        ready.close();
      }
      expect(restarted.fold.orphanCompactions()).toEqual([]);
      expect(restarted.fold.snapshot().surface?.nodes).toEqual(prepared.before.surface?.nodes);
      expect(restarted.fold.snapshot().pendingCompactions).toEqual([]);
      const abort = (await eventsAt(home())).find((event) => event.type === 'compaction/abort');
      expect(abort?.data).toMatchObject({ reason: 'orphan', id: prepared.startId });
    } finally {
      await restarted.shutdown();
    }
  });

  for (const position of [1, 2, 3] as const) {
    it(`faults at flush position ${position} without ever applying the replacement early`, async () => {
      const session = await openSession();
      try {
        await session.appendConfig(testConfig({ policy: { compactAfterBytes: 1, keepRecentGroups: 1 } }));
        await closedDialogue(session, 0, ['a1', 'a2'], 2000);
        await closedDialogue(session, 1, ['b1', 'b2'], 2000);
        const before = session.fold.snapshot();
        const candidate = selectCompaction(before);
        expect(candidate).not.toBeNull();

        session.lifecycle('turn/start', { turn: 2, trigger: 'boot', world: { from: null, to: null } });
        await session.flush();
        const gate = session.gate({ phase: 'turn', turn: 2 });
        try {
          session.armFault(position);
          await expect(runCompaction(session.fold, gate.gate)).rejects.toThrow('injected flush fault');
        } finally {
          gate.close();
        }

        // No end is durable at any fault position, so no replacement has been applied.
        const durable = await eventsAt(home());
        expect(durable.filter((event) => event.type === 'compaction/end')).toHaveLength(0);
        expect(session.fold.snapshot().surface?.nodes).toEqual(before.surface?.nodes);
        expect(selectCompaction(session.fold.snapshot())?.revision).toBe(candidate!.revision);

        if (position === 3) {
          // The end was appended but not durable; a later successful barrier makes it apply once.
          await session.flush();
          const applied = session.fold.snapshot();
          expect(applied.surface?.nodes[1]?.group.kind).toBe('summary');
          expect(applied.surface?.nodes[1]?.group.messages[0]?.content).toBe(COMPACTION_NOTICE);
        }
      } finally {
        await session.shutdown();
      }
    });
  }

  for (const barrier of [1, 2] as const) {
    it(`aborts stale when a config update is delivered while awaiting the ${barrier === 1 ? 'start' : 'summary'} barrier`, async () => {
      const session = await openSession();
      try {
        await session.appendConfig(testConfig({ policy: { compactAfterBytes: 1, keepRecentGroups: 1 } }));
        await closedDialogue(session, 0, ['a1', 'a2'], 2000);
        await closedDialogue(session, 1, ['b1', 'b2'], 2000);
        const before = session.fold.snapshot();
        const candidate = selectCompaction(before);
        expect(candidate).not.toBeNull();

        session.lifecycle('turn/start', { turn: 2, trigger: 'boot', world: { from: null, to: null } });
        await session.flush();
        const heading = testConfig({
          version: 2, heading: 'A new shared direction.',
          policy: { compactAfterBytes: 1, keepRecentGroups: 1 },
        });
        session.armInject(barrier, async () => { await session.appendConfig(heading); });

        const gate = session.gate({ phase: 'turn', turn: 2 });
        try {
          expect(await runCompaction(session.fold, gate.gate)).toBe('aborted');
        } finally {
          gate.close();
        }
        // The heading pinned forward, but the selected span is untouched: no replacement.
        const after = session.fold.snapshot();
        expect(after.surface?.nodes[0]?.group.messages[0]?.content).toBe(heading.heading);
        for (const id of candidate!.groupIds) {
          expect(after.surface?.nodes.some((node) => SAME(node.group.id, id))).toBe(true);
        }
        expect(after.surface?.nodes.some((node) => node.group.kind === 'summary')).toBe(false);
        expect(after.pendingCompactions).toEqual([]);
        const abort = (await eventsAt(home())).find((event) => event.type === 'compaction/abort');
        expect((abort?.data as unknown as { reason: string }).reason).toBe('stale');
      } finally {
        await session.shutdown();
      }
    });
  }
});
