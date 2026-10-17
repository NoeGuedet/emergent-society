import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { sha256HexOf } from '../../journal/index.js';
import { defaultAgentConfig } from '../config.js';
import { ArtifactMismatchError, type VerifiedEvent, type VerifiedEvents } from '../loader.js';
import { canonicalBytes, resolveArtifact } from '../artifacts.js';
import { assemble, rederivePlans } from '../assembler.js';
import { ContextFold } from '../fold.js';
import { presentWorld } from '../diff.js';
import { serializeWire } from '../../provider/wire.js';
import { useWorld } from '../../node/__tests__/helpers.js';
import type { WorldRepo } from '../../node/world.js';
import type {
  AgentConfig, ArtifactRef, CanonicalUsage, ChatMessage, FunctionCall, OpenTurn, ProjectionState,
  RequestId, RequestPlan, Source, SurfaceGroup, SurfaceNode, SurfaceSnapshot, ToolSchema,
} from '../contracts.js';

/**
 * Assembler unit tests: canonical offering, section semantics, the stable prefix,
 * queue/history placement, stateHash scope and whole-value freezing. The
 * serializer is exercised here only to prove the offering and prefix a plan
 * implies; its own byte-level shape is asserted in the wire tests.
 */

function src(seq: number): Source {
  return { seq, hash: seq.toString(16).padStart(64, '0') };
}

function call(id: string): FunctionCall {
  return { id, type: 'function', function: { name: 'execute', arguments: '{}' } };
}

function tool(name: string, properties: Record<string, JsonValue>, order: readonly string[]): ToolSchema {
  const ordered: Record<string, JsonValue> = {};
  for (const key of order) ordered[key] = properties[key]!;
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: ordered, required: ['cmd'], additionalProperties: false },
  };
}

function makeConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultAgentConfig(), ...over };
}

function makeSurface(
  heading: { readonly text: string; readonly source: Source },
  nodes: SurfaceNode[] = [],
): SurfaceSnapshot {
  const headingGroup: SurfaceGroup = {
    id: heading.source, kind: 'heading', turn: 0,
    messages: [{ role: 'system', content: heading.text }], sources: [heading.source],
  };
  return {
    heading,
    nodes: [{ position: 0, group: headingGroup }, ...nodes],
    revision: 'a'.repeat(64),
  };
}

const DEFAULT_HEADING = { text: 'Work on the current shared direction.', source: src(0) };

function makeState(over: Partial<ProjectionState> = {}): ProjectionState {
  return {
    config: { value: makeConfig(), source: src(0) },
    surface: makeSurface(DEFAULT_HEADING),
    open: null,
    recovery: [],
    watermark: null,
    pendingCompactions: [],
    ...over,
  };
}

const ID: RequestId = { turn: 0, ordinal: 0 };

function parse(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
}

describe('assemble: canonical offering', () => {
  const flatA = { cmd: { type: 'string', minLength: 1 }, flag: { type: 'boolean' } };
  const flatB = { flag: { type: 'boolean' }, cmd: { type: 'string', minLength: 1 } };
  const executeA = tool('execute', flatA, ['cmd', 'flag']);
  const executeB = tool('execute', flatB, ['flag', 'cmd']);
  const waitA = tool('wait', { selector: { type: 'string' } }, ['selector']);
  const waitB = tool('wait', { selector: { type: 'string' } }, ['selector']);

  it('sorts tools by code unit and canonicalizes nested schema keys so order never leaks', () => {
    const stateA = makeState({ config: { value: makeConfig({ tools: [executeA, waitA] }), source: src(0) } });
    const stateB = makeState({ config: { value: makeConfig({ tools: [waitB, executeB] }), source: src(0) } });
    const planA = assemble({ id: ID, state: stateA });
    const planB = assemble({ id: ID, state: stateB });

    expect(planA.tools.map((t) => t.name)).toEqual(['execute', 'wait']);
    expect(planB.tools.map((t) => t.name)).toEqual(['execute', 'wait']);
    expect(planA.toolsHash).toBe(planB.toolsHash);
    expect(planA.tools).toEqual(planB.tools);
    expect(Buffer.from(serializeWire(planA)).equals(Buffer.from(serializeWire(planB)))).toBe(true);
  });

  it('rejects a duplicate tool name in the offering', () => {
    const state = makeState({
      config: { value: makeConfig({ tools: [executeA, tool('execute', {}, [])] }), source: src(0) },
    });
    expect(() => assemble({ id: ID, state })).toThrow(/duplicate tool name/);
  });
});

describe('assemble: prefix and stable sections', () => {
  it('emits exactly two system messages: charter then heading, with no duplicate heading', () => {
    const state = makeState();
    const plan = assemble({ id: ID, state });
    const wire = parse(serializeWire(plan));
    const messages = wire['messages'] as Array<Record<string, unknown>>;
    const systems = messages.filter((m) => m['role'] === 'system');
    expect(systems).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: plan.charter });
    expect(messages[1]).toEqual({ role: 'system', content: plan.heading });
    expect(messages.filter((m) => m['content'] === plan.heading)).toHaveLength(1);
  });

  it('orders and classifies the sections exactly', () => {
    const plan = assemble({ id: ID, state: makeState() });
    expect(plan.sections.map((s) => ({ name: s.name, cache: s.cache }))).toEqual([
      { name: 'tools', cache: 'stable' },
      { name: 'charter', cache: 'stable' },
      { name: 'heading', cache: 'stable' },
      { name: 'history', cache: 'advance' },
      { name: 'queue', cache: 'volatile' },
    ]);
  });
});

describe('assemble: queue then history placement', () => {
  function perceptionGroup(): SurfaceGroup {
    return {
      id: src(10), kind: 'perception', turn: 0,
      messages: [{ role: 'user', content: 'evidence' }], sources: [src(10)],
    };
  }

  it('places a first-use perception in the queue and nothing in history', () => {
    const open: OpenTurn = {
      start: src(9), turn: 0, world: { from: null, to: null },
      perception: perceptionGroup(), perceptionConsumed: false, messages: [], sources: [],
    };
    const plan = assemble({ id: ID, state: makeState({ open }) });
    expect(plan.queue).toEqual([{ role: 'user', content: 'evidence' }]);
    expect(plan.history).toEqual([]);
    expect(plan.sections[3]?.sources).toEqual([]);
    expect(plan.sections[4]?.sources).toEqual([src(10)]);
  });

  it('after the first wire keeps the perception once, before the responding assistant and results', () => {
    const assistant: ChatMessage = {
      role: 'assistant', content: null, tool_calls: [call('c1'), call('c2')],
    };
    const r1: ChatMessage = { role: 'tool', content: 'ok', tool_call_id: 'c1' };
    const r2: ChatMessage = { role: 'tool', content: 'ok', tool_call_id: 'c2' };
    const open: OpenTurn = {
      start: src(9), turn: 0, world: { from: null, to: null },
      perception: perceptionGroup(), perceptionConsumed: true,
      messages: [assistant, r1, r2], sources: [src(11), src(12), src(13), src(14)],
    };
    const plan = assemble({ id: ID, state: makeState({ open }) });
    expect(plan.queue).toEqual([]);
    expect(plan.history).toEqual([
      { role: 'user', content: 'evidence' }, assistant, r1, r2,
    ]);
    expect(plan.sections[3]?.sources).toEqual([src(10), src(11), src(12), src(13), src(14)]);
    expect(plan.sections[4]?.sources).toEqual([]);
  });
});

describe('assemble: stateHash scope', () => {
  it('changes with the heading/config source but leaves charter and tools bytes untouched', () => {
    const stateA = makeState();
    const headingB = { text: 'A newer direction.', source: src(5) };
    const stateB = makeState({
      config: { value: makeConfig(), source: src(5) },
      surface: makeSurface(headingB),
    });
    const planA = assemble({ id: ID, state: stateA });
    const planB = assemble({ id: ID, state: stateB });

    expect(planB.charter).toBe(planA.charter);
    expect(planB.toolsHash).toBe(planA.toolsHash);
    expect(planB.heading).not.toBe(planA.heading);
    expect(planB.stateHash).not.toBe(planA.stateHash);

    const wireA = parse(serializeWire(planA));
    const wireB = parse(serializeWire(planB));
    expect(wireA['tools']).toEqual(wireB['tools']);
    expect((wireA['messages'] as unknown[])[0]).toEqual((wireB['messages'] as unknown[])[0]);
    expect((wireA['messages'] as unknown[])[1]).not.toEqual((wireB['messages'] as unknown[])[1]);
  });

  it('ignores watermark and pending-compaction metadata', () => {
    const base = makeState();
    const noisy = makeState({
      watermark: src(77),
      pendingCompactions: [{
        id: 'x', revision: 'b'.repeat(64), groupIds: [src(1)], sources: [src(1)],
        shadowHash: 'c'.repeat(64), shadowBytes: 10,
      }],
    });
    expect(assemble({ id: ID, state: noisy }).stateHash)
      .toBe(assemble({ id: ID, state: base }).stateHash);
  });

  it('includes the open turn in the state hash', () => {
    const open: OpenTurn = {
      start: src(9), turn: 0, world: { from: null, to: null },
      perception: null, perceptionConsumed: false, messages: [], sources: [],
    };
    const closed = assemble({ id: ID, state: makeState() });
    const opened = assemble({ id: ID, state: makeState({ open }) });
    expect(opened.stateHash).not.toBe(closed.stateHash);
    // The open turn is the only difference: config, surface and recovery agree.
    expect(opened.sections).toEqual(closed.sections);
    expect(opened.history).toEqual(closed.history);
    expect(opened.queue).toEqual(closed.queue);
  });

  it('refuses without a config and refuses a nonempty recovery list', () => {
    expect(() => assemble({ id: ID, state: makeState({ config: null, surface: null }) }))
      .toThrow(/config/);
    const recovery: ProjectionState['recovery'] = [{
      turn: 0, request: ID,
      assistant: { role: 'assistant', content: null, tool_calls: [call('c1')] },
      sources: [src(3)], results: [], missing: [call('c1')],
    }];
    expect(() => assemble({ id: ID, state: makeState({ recovery }) })).toThrow(/recovery/);
  });
});

describe('assemble: freezing and null preservation', () => {
  it('frees the plan from later mutations of the source config and schema', () => {
    const tools: ToolSchema[] = [{
      name: 'execute', description: 'd',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    }];
    const state = makeState({ config: { value: makeConfig({ tools }), source: src(0) } });
    const plan = assemble({ id: ID, state });
    const before = JSON.parse(JSON.stringify(plan)) as unknown;

    (tools[0] as unknown as { name: string }).name = 'mutated';
    (tools[0]!.parameters as unknown as Record<string, unknown>)['properties'] = {};

    expect(plan.tools[0]?.name).toBe('execute');
    expect(JSON.parse(JSON.stringify(plan))).toEqual(before);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.tools)).toBe(true);
    expect(Object.isFrozen(plan.tools[0])).toBe(true);
    expect(Object.isFrozen(plan.tools[0]?.parameters)).toBe(true);
    expect(Object.isFrozen(plan.history)).toBe(true);
  });

  it('preserves assistant content null in history rather than an empty string', () => {
    const assistant: ChatMessage = { role: 'assistant', content: null, tool_calls: [] };
    const open: OpenTurn = {
      start: src(9), turn: 0, world: { from: null, to: null },
      perception: null, perceptionConsumed: false, messages: [assistant], sources: [src(11)],
    };
    const plan = assemble({ id: ID, state: makeState({ open }) });
    expect(plan.history[0]).toEqual({ role: 'assistant', content: null, tool_calls: [] });
  });

  it('keeps unknown usage counters as null through the shared canonical encoder', () => {
    const usage: CanonicalUsage = {
      inputTotal: null, inputUncached: null, output: null, cacheRead: null, cacheWrite: null,
    };
    const parsed = JSON.parse(Buffer.from(canonicalBytes(usage)).toString('utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({
      inputTotal: null, inputUncached: null, output: null, cacheRead: null, cacheWrite: null,
    });
    expect(Object.values(parsed).every((v) => v === null)).toBe(true);
  });
});

describe('rederivePlans: the observed prefix is authoritative', () => {
  const GENESIS = '0'.repeat(64);

  function envelope(over: Partial<EventEnvelope> & { type: string; data: JsonValue }): EventEnvelope {
    return { v: 0, seq: 0, time: 1, prev_hash: GENESIS, hash: GENESIS, ...over };
  }

  const verified = (event: EventEnvelope): VerifiedEvent => ({ ...event, raw: event });

  it('cannot resolve a request/plan from an artifact that only appears later', async () => {
    const H0 = 'a'.repeat(64);
    const H1 = 'b'.repeat(64);
    const H2 = 'c'.repeat(64);
    const C0 = '1'.repeat(64);
    const C1 = '2'.repeat(64);
    const HM = 'e'.repeat(64);

    const plan: RequestPlan = {
      id: { turn: 0, ordinal: 0 }, config: { seq: 0, hash: H0 }, stateHash: 'x'.repeat(64),
      model: 'mock-model', parameters: {}, policy: defaultAgentConfig().policy,
      tools: [], toolsHash: 'd'.repeat(64),
      sections: [
        { name: 'tools', cache: 'stable', sources: [] },
        { name: 'charter', cache: 'stable', sources: [] },
        { name: 'heading', cache: 'stable', sources: [] },
        { name: 'history', cache: 'advance', sources: [] },
        { name: 'queue', cache: 'volatile', sources: [] },
      ],
      history: [], queue: [], charter: '', heading: '',
    };
    const bytes = Buffer.from(JSON.stringify(plan), 'utf8');
    const sha = sha256HexOf(bytes);
    const half = Math.floor(bytes.length / 2);
    const ref: ArtifactRef = {
      kind: 'c13-artifact', manifest: { seq: 5, hash: HM },
      sha256: sha, bytes: bytes.length, encoding: 'utf8', complete: true,
    };

    const events: VerifiedEvents = [
      verified(envelope({
        type: 'system/message', seq: 0, hash: H0,
        data: { version: 1, value: { kind: 'inline', value: defaultAgentConfig() } },
      })),
      verified(envelope({
        type: 'turn/start', seq: 1, hash: H1, prev_hash: H0,
        data: { turn: 0, trigger: 'boot', world: { from: null, to: null } },
      })),
      verified(envelope({
        type: 'request/plan', seq: 2, hash: H2, prev_hash: H1,
        data: { id: { turn: 0, ordinal: 0 }, value: { kind: 'artifact-json', ref } },
      })),
      verified(envelope({
        type: 'artifact/chunk', seq: 3, hash: C0, prev_hash: H2,
        data: { artifact: sha, index: 0, base64: bytes.subarray(0, half).toString('base64') },
      })),
      verified(envelope({
        type: 'artifact/chunk', seq: 4, hash: C1, prev_hash: C0,
        data: { artifact: sha, index: 1, base64: bytes.subarray(half).toString('base64') },
      })),
      verified(envelope({
        type: 'artifact/end', seq: 5, hash: HM, prev_hash: C1,
        data: {
          artifact: sha, sha256: sha, bytes: bytes.length, encoding: 'utf8', complete: true,
          parts: [{ seq: 3, hash: C0 }, { seq: 4, hash: C1 }],
        },
      })),
    ];

    // The artifact itself is genuinely resolvable from the whole history...
    expect(Buffer.from(resolveArtifact(events, ref)).equals(bytes)).toBe(true);
    // ...but the plan cites a manifest that is still in the future when it is
    // read, so reconstruction refuses rather than trusting a later receipt.
    const world = {} as unknown as WorldRepo;
    await expect(rederivePlans(events, world)).rejects.toThrow(ArtifactMismatchError);
  });
});

describe('rederivePlans: a divergence is explicit, never a promise of equality', () => {
  const GENESIS = '0'.repeat(64);
  const RANGE = { from: null, to: null };
  // A fresh world (unborn HEAD) makes the recorded perception independently
  // re-renderable; every case below diverges from it by exactly one field.
  const fixture = useWorld('c13-replay-divergence-');
  const hashFor = (seq: number): string => (seq + 1).toString(16).padStart(64, '0');

  function envelope(seq: number, type: string, data: JsonValue): EventEnvelope {
    return { v: 0, seq, time: 1, prev_hash: GENESIS, hash: hashFor(seq), type, data };
  }

  const verified = (event: EventEnvelope): VerifiedEvent => ({ ...event, raw: event });

  const configEvent = (): VerifiedEvent => verified(envelope(0, 'system/message', {
    version: 1, value: { kind: 'inline', value: defaultAgentConfig() },
  }));
  const turnEvent = (): VerifiedEvent => verified(envelope(1, 'turn/start', {
    turn: 0, trigger: 'boot', world: RANGE,
  }));
  const id: RequestId = { turn: 0, ordinal: 0 };

  it.each(['world/perception', 'request/plan', 'request/wire'] as const)(
    'refuses a chain-valid null %s payload as a typed replay error', async (type) => {
      const { world } = fixture();
      // Chain verification proves bytes, not shapes: these events are "verified"
      // but carry null data. The replay's own guard must classify them before
      // any id/value dereference, so the model sees a replay error, not a
      // TypeError from the offline utility.
      const events = [verified(envelope(0, type, null))];
      let err: unknown;
      try {
        await rederivePlans(events, world);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypeError);
      expect((err as Error).message).toContain(`replay: ${type} data at 0:`);
      expect((err as Error).message).toContain('is not an object');
    });

  it('rejects a recorded plan rewritten to a different but valid plan', async () => {
    const { world } = fixture();
    const config = configEvent();
    const turn = turnEvent();
    // The plan genuinely rederivable from these two facts...
    const prefix = new ContextFold();
    await prefix.observe([config, turn]);
    const real = assemble({ id, state: prefix.snapshot() });
    // ...and a valid plan that differs in one field.
    const rewritten = JSON.parse(JSON.stringify(real)) as RequestPlan;
    (rewritten as { model: string }).model = 'another-model';

    const events: VerifiedEvents = [
      config, turn,
      verified(envelope(2, 'request/plan', { id, value: { kind: 'inline', value: rewritten } })),
    ];
    await expect(rederivePlans(events, world)).rejects.toThrow(
      /plan recorded at \d+:[0-9a-f]+ does not match the plan rederived/);
  });

  it('rejects a recorded perception whose inline text differs from the re-render', async () => {
    const { world } = fixture();
    const rendered = await presentWorld(world, 'n1', RANGE, 32768, 4096);
    const recorded = { ...rendered, text: `${rendered.text}tampered` };
    const events: VerifiedEvents = [
      configEvent(), turnEvent(),
      verified(envelope(2, 'world/perception', {
        turn: 0, range: RANGE, value: { kind: 'inline', value: recorded },
      })),
    ];
    await expect(rederivePlans(events, world)).rejects.toThrow(
      /does not match the perception rederived from the world/);
  });

  it('rejects a recorded perception that binds a different Git version', async () => {
    const { world } = fixture();
    const rendered = await presentWorld(world, 'n1', RANGE, 32768, 4096);
    const recorded = {
      ...rendered,
      renderer: { ...rendered.renderer, gitVersion: 'git version 9.99.9' },
    };
    const events: VerifiedEvents = [
      configEvent(), turnEvent(),
      verified(envelope(2, 'world/perception', {
        turn: 0, range: RANGE, value: { kind: 'inline', value: recorded },
      })),
    ];
    await expect(rederivePlans(events, world)).rejects.toThrow(
      /recorded Git version .* differs from the host's/);
  });

  /**
   * One recorded turn whose wire artifact carries `wireFor(plan)`, so the same
   * prefix can prove both the honest and the divergent wire.
   */
  async function recordedPipeline(
    world: WorldRepo, wireFor: (plan: RequestPlan) => Buffer,
  ): Promise<{ events: VerifiedEvents; body: ArtifactRef; plan: RequestPlan }> {
    const config = configEvent();
    const turn = turnEvent();
    const rendered = await presentWorld(world, 'n1', RANGE, 32768, 4096);
    const perception = verified(envelope(2, 'world/perception', {
      turn: 0, range: RANGE, value: { kind: 'inline', value: rendered },
    }));

    // The plan assembled at the recorded moment, then captured as its wire.
    const atPlan = new ContextFold();
    await atPlan.observe([config, turn, perception]);
    const plan = assemble({ id, state: atPlan.snapshot() });
    const wireBytes = wireFor(plan);
    const sha = sha256HexOf(wireBytes);
    const chunk = verified(envelope(4, 'artifact/chunk', {
      artifact: sha, index: 0, base64: wireBytes.toString('base64'),
    }));
    const end = verified(envelope(5, 'artifact/end', {
      artifact: sha, sha256: sha, bytes: wireBytes.length, encoding: 'utf8', complete: true,
      parts: [{ seq: chunk.raw.seq, hash: chunk.raw.hash }],
    }));
    const body: ArtifactRef = {
      kind: 'c13-artifact', manifest: { seq: end.raw.seq, hash: end.raw.hash },
      sha256: sha, bytes: wireBytes.length, encoding: 'utf8', complete: true,
    };
    return {
      plan,
      body,
      events: [
        config, turn, perception,
        verified(envelope(3, 'request/plan', { id, value: { kind: 'inline', value: plan } })),
        chunk, end,
        verified(envelope(6, 'request/wire', { id, attempt: 0, body })),
      ],
    };
  }

  it('re-encodes the recorded wire body from the recorded plan', async () => {
    const { world } = fixture();
    const { events, body, plan } = await recordedPipeline(
      world, (recorded) => Buffer.from(serializeWire(recorded)),
    );

    const comparisons = await rederivePlans(events, world);
    expect(comparisons).toHaveLength(1);
    // The utility itself now verifies the wire; this pins the exact bytes.
    expect(Buffer.from(resolveArtifact(events, body)).equals(Buffer.from(serializeWire(plan))))
      .toBe(true);
    expect(Buffer.from(serializeWire(plan)))
      .toEqual(Buffer.from(serializeWire(comparisons[0]!.recorded)));
  });

  it('rejects a recorded wire body that differs from the plan it carries', async () => {
    const { world } = fixture();
    // A chain-valid artifact, but not the recorded plan's serialized body.
    const { events } = await recordedPipeline(
      world, () => Buffer.from('{"tampered":true}'),
    );
    await expect(rederivePlans(events, world)).rejects.toThrow(
      /wire recorded at \d+:[0-9a-f]+ \(attempt 0\) is not the recorded plan's serialized body/);
  });
});
