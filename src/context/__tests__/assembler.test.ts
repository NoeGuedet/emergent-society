import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { sha256HexOf } from '../../journal/canon.js';
import { defaultAgentConfig } from '../config.js';
import { ArtifactMismatchError, type VerifiedEvent, type VerifiedEvents } from '../loader.js';
import { canonicalBytes, resolveArtifact } from '../artifacts.js';
import { assemble, rederivePlans } from '../assembler.js';
import { serializeWire } from '../../provider/wire.js';
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
