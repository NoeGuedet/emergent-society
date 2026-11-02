import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TERMINAL_ENV } from '../tools/terminal.js';
import { NodeDriver } from '../driver.js';
import { createAgentRuntime, type AgentRuntime, type RuntimeDiagnostic } from '../loop.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { ContextFold } from '../../context/fold.js';
import { assemble } from '../../context/assembler.js';
import { COMPACTION_NOTICE, AUTHORED_FRAME } from '../../context/compaction.js';
import { defaultAgentConfig } from '../../context/config.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { readFrontier } from '../../frontier/__tests__/helpers.js';
import {
  METER_BLOCK_OVERHEAD, METER_CHARS_PER_TOKEN, headerDigest, priceMessage, priceMessages,
  priceWire,
} from '../../context/meter.js';
import { ProviderAdapter, type ProviderPolicy } from '../../provider/adapter.js';
import type {
  SerializedTransport, TransportFacts, TransportResult,
} from '../../provider/transport.js';
import type {
  AgentConfig, AssistantAccounting, ChatMessage, FunctionCall, LlmModel, RequestPlan,
  SeedPolicy, ToolSchema,
} from '../../context/contracts.js';
import type { JsonValue } from '../../journal/index.js';
import { openTestDriver, useWorld, type WorldFixture } from './helpers.js';
import type { ExtendPort } from '../tools/extend.js';
import { createPackageStore } from '../packages/store.js';
import { createRunSupervisor } from '../packages/supervisor.js';
import { REMEMBER_PENDING_TURNS, earlyTriggerMiss } from '../loop.js';

/**
 * The token trigger at the plan site (A4) and the accounting it journals (A7),
 * driven through the real runtime/loop harness: the journal, the fold, the
 * driver and the adapter are production; only the transport is scripted.
 *
 * The threshold is made reachable by the JOURNALED rule (the policy carries the
 * ratio and the headroom clamp), never by a giant conversation: a 1‰ ratio with
 * a zero headroom puts the threshold at 10 tokens for a 10,000-token window, so
 * the trigger's geometry is exact and its accounting is small. The plan a
 * decision priced is REPRODUCED by folding the journal up to the decision
 * boundary and calling the same pure assembler, so every estimate below is
 * exact rather than approximate.
 */

const fixture = useWorld('c13-meter-trigger-');

const providerPolicy: ProviderPolicy = {
  delay: (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => { if (timer !== undefined) clearTimeout(timer); reject(new Error('cancelled')); };
    timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  }),
  schedule: () => () => {},
};

const TEST_FACTS: TransportFacts = {
  url: 'https://test.invalid/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  credentialId: 'test',
};

/** Records every send and answers from a fixed script, in order. */
class ScriptedTransport implements SerializedTransport {
  readonly facts: TransportFacts = TEST_FACTS;
  readonly sends: Uint8Array[] = [];
  private readonly script: TransportResult[];

  constructor(script: readonly TransportResult[]) {
    this.script = [...script];
  }

  async post(body: Uint8Array, signal: AbortSignal, _maxBytes: number): Promise<TransportResult> {
    if (signal.aborted) {
      return {
        status: null, headers: {}, body: new Uint8Array(), complete: false,
        failure: { code: 'cancelled', status: null },
      };
    }
    this.sends.push(body);
    const next = this.script.shift();
    if (next === undefined) throw new Error('scripted transport exhausted');
    return next;
  }
}

/** A 200 assistant text, optionally carrying the OpenAI usage shape. */
function reply(
  content: string,
  usage?: { readonly prompt: number; readonly completion: number; readonly cached?: number },
): TransportResult {
  return {
    status: 200, headers: {}, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      ...(usage !== undefined
        ? {
          usage: {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            ...(usage.cached !== undefined
              ? { prompt_tokens_details: { cached_tokens: usage.cached } }
              : {}),
          },
        }
        : {}),
    })),
  };
}

/** One gated `remember` call: the authored text, optionally the early trigger. */
function rememberCall(id: string, text: string, compact?: boolean): FunctionCall {
  return {
    id, type: 'function',
    function: {
      name: 'extend',
      arguments: JSON.stringify({
        verb: 'remember', text, ...(compact !== undefined ? { compact } : {}),
      }),
    },
  };
}

function calling(
  calls: readonly FunctionCall[],
  usage?: { readonly prompt: number; readonly completion: number },
): TransportResult {
  return {
    status: 200, headers: {}, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
      ...(usage !== undefined
        ? { usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } }
        : {}),
    })),
  };
}

/** The provider's own structured window refusal, as OpenAI-compatible bodies carry it. */
function contextExceeded(): TransportResult {
  return {
    status: 400, headers: {}, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({
      error: {
        message: 'This model\'s maximum context length is 10000 tokens.',
        type: 'invalid_request_error', code: 'context_length_exceeded',
      },
    })),
  };
}

/** A 400 for another reason: never classified as the window refusal. */
function unrelated400(): TransportResult {
  return {
    status: 400, headers: {}, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({
      error: { message: 'unknown model', type: 'invalid_request_error', code: 'model_not_found' },
    })),
  };
}

function waitCall(id: string): FunctionCall {
  return { id, type: 'function', function: { name: 'wait', arguments: '{}' } };
}

/** The one declared window the harness uses: 10,000 tokens, 1,000 reserved. */
const MODELS: readonly LlmModel[] = [
  { id: 'mock-model', contextTokens: 10_000, maxOutputTokens: 1_000 },
];

/** 1‰ of the window and no headroom: the threshold is exactly 10 tokens. */
const TINY_RULE: SeedPolicy['compactAfterTokens'] = {
  ratioPermille: 1, headroom: { ratioPermille: 0, minTokens: 0, maxTokens: 0 },
};

/** The wide rule: the threshold is the window minus the reservation (9,000 tokens). */
const WIDE_RULE: SeedPolicy['compactAfterTokens'] = {
  ratioPermille: 1000, headroom: { ratioPermille: 0, minTokens: 0, maxTokens: 0 },
};

function configWith(over: {
  policy?: Partial<SeedPolicy>; model?: string; tools?: ToolSchema[]; version?: number;
  parameters?: { readonly [key: string]: JsonValue };
} = {}): AgentConfig {
  const base = defaultAgentConfig();
  return {
    ...base,
    version: over.version ?? base.version,
    model: over.model ?? base.model,
    tools: over.tools ?? base.tools,
    parameters: over.parameters ?? base.parameters,
    policy: { ...base.policy, ...over.policy } as SeedPolicy,
  };
}

/**
 * A pre-wave config: the token key removed entirely (the byte trigger's forever
 * path). A merge could not express this — a spread never deletes the factory's
 * key — so the policy is built whole.
 */
function byteConfig(over: {
  policy?: Partial<SeedPolicy>; model?: string; version?: number;
} = {}): AgentConfig {
  const base = defaultAgentConfig();
  const { compactAfterTokens: _tokens, ...rest } = base.policy;
  return {
    ...base,
    version: over.version ?? base.version,
    model: over.model ?? base.model,
    policy: { ...rest, ...over.policy } as SeedPolicy,
  };
}

async function adapterFor(fx: WorldFixture, transport: SerializedTransport): Promise<ProviderAdapter> {
  return new ProviderAdapter(transport, providerPolicy, (await fx.frontier()).gate);
}

async function runtimeFor(
  fx: WorldFixture, config: AgentConfig, transport: SerializedTransport,
  extra: {
    readonly models?: readonly LlmModel[];
    readonly diagnose?: (d: RuntimeDiagnostic) => void;
    readonly extend?: ExtendPort;
  } = {},
): Promise<AgentRuntime> {
  const extend = extra.extend;
  return createAgentRuntime({
    home: fx.home, uid: 'n1', world: fx.world, initialConfig: config,
    terminal: { env: DEFAULT_TERMINAL_ENV },
    adapter: await adapterFor(fx, transport),
    ...(extra.models !== undefined ? { models: extra.models } : {}),
    ...(extra.diagnose !== undefined ? { diagnose: extra.diagnose } : {}),
    ...(extend !== undefined ? { extend: () => extend } : {}),
  });
}

/**
 * The real extend port the runtime completes with its memory seam (the
 * loop-self precedent): the ready phase scans the store, so the port is real;
 * no Run is ever started and no terminal/web is wired.
 */
async function memoryExtendPort(fx: WorldFixture): Promise<ExtendPort> {
  const store = await createPackageStore({
    home: fx.home, uid: 'n1', worldDir: fx.world.path, scratchDir: join(fx.home, 'tmp', 'n1'),
  });
  const supervisor = createRunSupervisor({
    home: fx.home, uid: 'n1', sandbox: false,
    shellTimeoutMs: 5_000, killGraceMs: 200, maxShellCaptureBytes: 1024 * 1024,
    now: () => 0,
    schedule: (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    terminal: null, web: null, webAllowance: { search: false, fetch: false },
    events: { effect: () => {}, error: () => {}, service: () => {} },
    bootstrapPath: fileURLToPath(new URL('../packages/run-bootstrap.ts', import.meta.url)),
  });
  return { store, supervisor, sandbox: false };
}

/** The journaled compaction summaries, in order. */
async function summariesOf(fx: WorldFixture): Promise<Array<{
  id: string; message: { role: string; content: string }; replacement?: string;
  sources: unknown[]; replacementBytes: number;
}>> {
  return (await eventsOf(fx))
    .filter((event) => event.type === 'compaction/summary')
    .map((event) => event.data as unknown as {
      id: string; message: { role: string; content: string }; replacement?: string;
      sources: unknown[]; replacementBytes: number;
    });
}

/** The turn number of each compaction/start, from the journal's own order. */
async function compactionTurns(fx: WorldFixture): Promise<number[]> {
  const events = await eventsOf(fx);
  let turn = -1;
  const out: number[] = [];
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = (event.data as unknown as { turn: number }).turn;
    }
    if (event.type === 'compaction/start') out.push(turn);
  }
  return out;
}

function openRuntime(fx: WorldFixture, runtime: AgentRuntime): Promise<NodeDriver> {
  return openTestDriver(fx.home, 'n1', runtime.handler, fx.world, {
    knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
  });
}

function eventsOf(fx: WorldFixture) {
  return loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
}

/** Opens one turn on the runtime and settles it at its closer. */
async function runTurn(fx: WorldFixture, runtime: AgentRuntime): Promise<void> {
  const before = (await eventsOf(fx)).filter((event) => event.type === 'turn/end').length;
  const driver = await openRuntime(fx, runtime);
  const running = driver.run();
  await vi.waitFor(async () => {
    const ends = (await eventsOf(fx)).filter((event) => event.type === 'turn/end').length;
    expect(ends).toBe(before + 1);
  }, { timeout: 15000 });
  driver.stop();
  await running;
}

/** The turn numbers the journal opened, in order. */
async function turns(fx: WorldFixture): Promise<number[]> {
  return (await eventsOf(fx))
    .filter((event) => event.type === 'turn/start')
    .map((event) => (event.data as unknown as { turn: number }).turn);
}

/**
 * Re-derives the plan the plan site assembled for a turn's first logical
 * request: the fold through everything before the first decision boundary
 * (a compaction, the assistant record, a refusal or the closer), then the same
 * pure assembler the runtime calls.
 */
async function planAt(
  fx: WorldFixture, turn: number, models: readonly LlmModel[],
): Promise<RequestPlan> {
  const events = await eventsOf(fx);
  const boundaries = new Set([
    'compaction/start', 'assistant/message', 'request/refused', 'turn/end',
  ]);
  const start = events.findIndex((event) => event.type === 'turn/start'
    && (event.data as unknown as { turn: number }).turn === turn);
  if (start < 0) throw new Error(`no turn/start for turn ${turn}`);
  let end = events.length;
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === 'turn/start') break;
    if (boundaries.has(event.type)) { end = index; break; }
  }
  const fold = new ContextFold();
  await fold.observe(events.slice(0, end));
  return assemble({
    id: { turn, ordinal: 0 }, state: fold.snapshot(), models,
  });
}

/** The turn's first assistant message, as the encoder sees it. */
async function assistantAt(fx: WorldFixture, turn: number): Promise<ChatMessage> {
  const event = (await eventsOf(fx)).find((candidate) => candidate.type === 'assistant/message'
    && (candidate.data as unknown as { id: { turn: number } }).id.turn === turn);
  if (event === undefined) throw new Error(`no assistant/message for turn ${turn}`);
  const stored = (event.data as unknown as {
    value: { kind: string; value?: { message: ChatMessage } };
  }).value;
  if (stored.kind !== 'inline' || stored.value === undefined) throw new Error('not inline');
  return stored.value.message;
}

/** The accounting triple a turn's assistant record journals, when it carries one. */
async function accountingAt(
  fx: WorldFixture, turn: number,
): Promise<AssistantAccounting | undefined> {
  const event = (await eventsOf(fx)).find((candidate) => candidate.type === 'assistant/message'
    && (candidate.data as unknown as { id: { turn: number } }).id.turn === turn);
  return (event?.data as unknown as { accounting?: AssistantAccounting } | undefined)?.accounting;
}

/** The meter payloads on the journal's compaction/start records, in order. */
async function metersOf(fx: WorldFixture): Promise<(Record<string, unknown> | undefined)[]> {
  return (await eventsOf(fx))
    .filter((event) => event.type === 'compaction/start')
    .map((event) => (event.data as unknown as { meter?: Record<string, unknown> }).meter);
}

/**
 * The price of a plan-as-sent: the wire's own messages and its ALREADY-WRAPPED
 * tools. The parsed tools are the wire's `{type:'function', function:{…}}`
 * array, so they are priced as JSON directly — passing them to `priceTools`
 * would wrap them a second time (`name`/`description`/`parameters` undefined)
 * and under-price the body.
 */
function priceBody(body: Uint8Array): number {
  const wire = JSON.parse(Buffer.from(body).toString('utf8')) as {
    messages: ChatMessage[]; tools: unknown[];
  };
  const tools = wire.tools.length === 0
    ? 0
    : Math.ceil(JSON.stringify(wire.tools).length / METER_CHARS_PER_TOKEN) + METER_BLOCK_OVERHEAD;
  return priceMessages(wire.messages) + tools;
}

/** The frontier's http/request records, in order. */
async function frontierRequests(fx: WorldFixture): Promise<{ group: string }[]> {
  return (await readFrontier(fx.home))
    .filter((event) => event.type === 'http/request')
    .map((event) => event.data as unknown as { group: string });
}

describe('the token trigger at the plan site', () => {
  it('does not fire below the threshold: no compaction, one send', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([reply('idle')]);
    const runtime = await runtimeFor(
      fx, configWith({ policy: { compactAfterTokens: WIDE_RULE } }), transport,
      { models: MODELS });
    await runTurn(fx, runtime);
    expect(transport.sends).toHaveLength(1);
    const events = await eventsOf(fx);
    expect(events.filter((event) => event.type === 'compaction/start')).toHaveLength(0);
    // The fixture's own precondition: the priced plan is under the wide threshold.
    const [turn] = await turns(fx);
    expect(priceWire(await planAt(fx, turn!, MODELS))).toBeLessThan(9000);
  });

  it('fires above it: one forced compaction, the re-assembled plan sent, the meter journaled', async () => {
    const fx = fixture();
    // Turn 0 commits a dialogue group (one `wait` call), so a later turn has an
    // eligible span at all.
    const first = new ScriptedTransport([calling([waitCall('w1')])]);
    const rule = { compactAfterTokens: TINY_RULE, keepRecentGroups: 0 };
    const runtime1 = await runtimeFor(fx, configWith({ policy: rule }), first, { models: MODELS });
    await runTurn(fx, runtime1);
    expect(first.sends).toHaveLength(1);
    const [turn0] = await turns(fx);

    // Turn 1: the priced request is over the (10-token) threshold.
    const second = new ScriptedTransport([reply('idle')]);
    const runtime2 = await runtimeFor(fx, configWith({ policy: rule }), second, { models: MODELS });
    const frontierBefore = (await frontierRequests(fx)).length;
    await runTurn(fx, runtime2);

    const events = await eventsOf(fx);
    const starts = events.filter((event) => event.type === 'compaction/start');
    // Bounded: one compaction for the logical request, even though the
    // re-assembled plan is still far over a 10-token threshold.
    expect(starts).toHaveLength(1);
    const pre = await planAt(fx, turn0! + 1, MODELS);
    expect((starts[0]!.data as unknown as { meter: unknown }).meter).toEqual({
      window: 10_000,
      output: 1_000,
      headroom: 0,
      threshold: 10,
      percent: 0.1,
      estimate: priceWire(pre),
      anchor: 'estimate',
      outcome: 'compact',
    });
    // The reassembled plan fits: the priced-after is strictly below the
    // priced-before (the meter's estimate), and exactly one request crossed the
    // frontier — the discarded plan left NO frontier fact.
    expect(second.sends).toHaveLength(1);
    expect(priceBody(second.sends[0]!)).toBeLessThan(priceWire(pre));
    expect((await frontierRequests(fx)).length).toBe(frontierBefore + 1);
    // The compaction applied durably (its end follows), and — THE NEGATIVE PIN —
    // it made no adapter send of its own: the kernel never calls a model for
    // memory, so the only send in this turn is the request's.
    expect(events.filter((event) => event.type === 'compaction/end')).toHaveLength(1);
  });

  it('escapes typed when nothing can be compacted: over the window, sent anyway, nothing journaled', async () => {
    const fx = fixture();
    const diagnostics: RuntimeDiagnostic[] = [];
    const transport = new ScriptedTransport([reply('idle')]);
    const runtime = await runtimeFor(
      fx, configWith({ policy: { compactAfterTokens: TINY_RULE } }), transport,
      { models: MODELS, diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime);
    // No committed group exists yet: selectCompaction has nothing eligible.
    const [turn] = await turns(fx);
    expect(transport.sends).toHaveLength(1);
    expect(diagnostics).toEqual([{
      kind: 'uncompactable-over-window',
      estimate: priceWire(await planAt(fx, turn!, MODELS)), threshold: 10,
    }]);
    const events = await eventsOf(fx);
    expect(events.filter((event) => event.type === 'compaction/start')).toHaveLength(0);
    // The escape branch journals nothing (request/refused refuses any phase but
    // 'plan'); the bounded host diagnostic is its only accounting.
    expect(events.filter((event) => event.type === 'request/refused')).toHaveLength(0);
  });

  it('refuses a request whose output reservation leaves no window, typed and before any send', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([reply('never')]);
    const runtime = await runtimeFor(
      fx,
      configWith({
        policy: { compactAfterTokens: TINY_RULE },
        parameters: { max_tokens: 10_000 },
      }),
      transport, { models: MODELS });
    await runTurn(fx, runtime);
    expect(transport.sends).toHaveLength(0);
    const events = await eventsOf(fx);
    const end = events.find((event) => event.type === 'turn/end')!.data as unknown as {
      outcome: string; error?: string;
    };
    expect(end.outcome).toBe('error');
    // The typed request refusal at the plan site: `request-limit`, no status.
    expect(end.error).toBe('request-limit null');
    expect(events.filter((event) => event.type === 'compaction/start')).toHaveLength(0);
  });
});

describe('the anchor: the sample, the adoption and the delta', () => {
  /** The journaled sample price of the first request: the plan plus its completion. */
  async function sampleAt(fx: WorldFixture, turn: number, models: readonly LlmModel[]):
    Promise<{ readonly plan: RequestPlan; readonly sample: number }> {
    const plan = await planAt(fx, turn, models);
    const assistant = await assistantAt(fx, turn);
    return { plan, sample: priceWire(plan) + priceMessage(assistant) };
  }

  it('journal the exact triple and adopts it on history growth (the delta on the second request)', async () => {
    const fx = fixture();
    const rule = { compactAfterTokens: TINY_RULE, keepRecentGroups: 0 };
    // Turn 0: a usage-bearing completion anchors the meter.
    const first = new ScriptedTransport([
      calling([waitCall('w1')], { prompt: 5_000, completion: 500 }),
    ]);
    const runtime1 = await runtimeFor(fx, configWith({ policy: rule }), first, { models: MODELS });
    await runTurn(fx, runtime1);
    const [turn0] = await turns(fx);

    const { plan, sample } = await sampleAt(fx, turn0!, MODELS);
    const accounting = await accountingAt(fx, turn0!);
    expect(accounting).toEqual({
      headerDigest: headerDigest(plan),
      surfacePriceAtSample: sample,
      usage: {
        promptTokens: 5_000, completionTokens: 500, totalTokens: 5_500, cachedTokens: null,
      },
    });
    // The fold re-derives the triple exactly: the restart's anchor source.
    const replay = new ContextFold();
    await replay.observe(await eventsOf(fx));
    expect(replay.lastAssistantAccounting()).toEqual(accounting);

    // Turn 1 (the same runtime, whose ready re-forms the anchor from the fold):
    // the decision adopts the usage and adds the surface delta.
    const second = new ScriptedTransport([reply('idle')]);
    const runtime2 = await runtimeFor(fx, configWith({ policy: rule }), second, { models: MODELS });
    await runTurn(fx, runtime2);
    const [turn1] = (await turns(fx)).slice(1);
    const current = await planAt(fx, turn1!, MODELS);
    const meter = (await metersOf(fx))[0]!;
    expect(meter).toMatchObject({ anchor: 'usage', estimate: 5_500 + (priceWire(current) - sample) });
    expect(priceWire(current)).toBeGreaterThan(sample - priceMessage(await assistantAt(fx, turn0!)));
  });

  it('falls back to the estimate wholesale when the usage under-reports', async () => {
    const fx = fixture();
    const rule = { compactAfterTokens: TINY_RULE, keepRecentGroups: 0 };
    const first = new ScriptedTransport([calling([waitCall('w1')], { prompt: 5, completion: 5 })]);
    const runtime1 = await runtimeFor(fx, configWith({ policy: rule }), first, { models: MODELS });
    await runTurn(fx, runtime1);
    const [turn0] = await turns(fx);
    // The usage is well-formed and journals a sample...
    expect((await accountingAt(fx, turn0!))?.usage.totalTokens).toBe(10);

    const second = new ScriptedTransport([reply('idle')]);
    const runtime2 = await runtimeFor(fx, configWith({ policy: rule }), second, { models: MODELS });
    await runTurn(fx, runtime2);
    const [turn1] = (await turns(fx)).slice(1);
    const current = await planAt(fx, turn1!, MODELS);
    // ...but it is BELOW the sampled estimate, so the anchor is not adopted and
    // the current request's own price stands wholesale.
    expect((await metersOf(fx))[0]).toMatchObject({
      anchor: 'estimate', estimate: priceWire(current),
    });
  });

  it('rejects the anchor on a tools change', async () => {
    const fx = fixture();
    const rule = { compactAfterTokens: TINY_RULE, keepRecentGroups: 0 };
    const first = new ScriptedTransport([
      calling([waitCall('w1')], { prompt: 5_000, completion: 500 }),
    ]);
    const base = configWith({ policy: rule });
    const runtime1 = await runtimeFor(fx, base, first, { models: MODELS });
    await runTurn(fx, runtime1);

    // The next turn runs a journaled config whose tools differ: the header no
    // longer matches, so the estimate stands until the next response re-anchors.
    const changed: AgentConfig = {
      ...base,
      version: base.version + 1,
      tools: base.tools.map((tool) => (tool.name === 'execute'
        ? { ...tool, description: `${tool.description} (rewritten)` }
        : tool)),
    };
    const second = new ScriptedTransport([reply('idle')]);
    const runtime2 = await runtimeFor(fx, changed, second, { models: MODELS });
    runtime2.scheduleConfig(changed);
    await runTurn(fx, runtime2);
    const [turn1] = (await turns(fx)).slice(1);
    const current = await planAt(fx, turn1!, MODELS);
    expect((await metersOf(fx))[0]).toMatchObject({
      anchor: 'estimate', estimate: priceWire(current),
    });
  });

  it('resets the anchor on an applied compaction: the next decision is estimate-only', async () => {
    const fx = fixture();
    const rule = { compactAfterTokens: TINY_RULE, keepRecentGroups: 0 };
    // Turn 0 anchors on a usage.
    const first = new ScriptedTransport([
      calling([waitCall('w1')], { prompt: 5_000, completion: 500 }),
    ]);
    const runtime1 = await runtimeFor(fx, configWith({ policy: rule }), first, { models: MODELS });
    await runTurn(fx, runtime1);
    // Turn 1 fires and APPLIES a compaction; its own completion carries no
    // usage, so no new sample replaces the one the compaction invalidated.
    const second = new ScriptedTransport([reply('idle')]);
    const runtime2 = await runtimeFor(fx, configWith({ policy: rule }), second, { models: MODELS });
    await runTurn(fx, runtime2);
    // Turn 2's priced request is decided estimate-only. It is the escape (the
    // summary group cannot be reduced again), so the decision is observable
    // through the bounded host diagnostic: the estimate is the CURRENT surface
    // price — not the stale `usage + (surface − sample)` the anchor would give.
    const diagnostics: RuntimeDiagnostic[] = [];
    const third = new ScriptedTransport([reply('idle')]);
    const runtime3 = await runtimeFor(fx, configWith({ policy: rule }), third,
      { models: MODELS, diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime3);
    const [turn1, turn2] = (await turns(fx)).slice(1);
    expect(turn1).toBeDefined();
    const current = await planAt(fx, turn2!, MODELS);
    const escape = diagnostics.find((diagnostic) =>
      diagnostic.kind === 'uncompactable-over-window');
    expect(escape).toEqual({
      kind: 'uncompactable-over-window', estimate: priceWire(current), threshold: 10,
    });
  });
});

describe('the restart: the fold is the anchor\'s only durable source', () => {
  it('a restart after an applied compaction whose send failed decides estimate-only', async () => {
    const fx = fixture();
    const rule = { compactAfterTokens: TINY_RULE, keepRecentGroups: 0 };
    // Turn 0 anchors on a usage (a committed dialogue so a later span exists).
    const first = new ScriptedTransport([
      calling([waitCall('w1')], { prompt: 5_000, completion: 500 }),
    ]);
    const runtime1 = await runtimeFor(fx, configWith({ policy: rule }), first, { models: MODELS });
    await runTurn(fx, runtime1);
    const [turn0] = await turns(fx);
    expect((await accountingAt(fx, turn0!))?.usage.totalTokens).toBe(5_500);

    // Turn 1: the trigger fires and APPLIES the compaction, then the send fails
    // (an unrelated non-retryable 400): no assistant record follows, so only the
    // transaction itself can invalidate the anchor's sample.
    const second = new ScriptedTransport([unrelated400()]);
    const runtime2 = await runtimeFor(fx, configWith({ policy: rule }), second, { models: MODELS });
    await runTurn(fx, runtime2);
    expect(second.sends).toHaveLength(1);
    expect((await eventsOf(fx)).filter((event) => event.type === 'compaction/end'))
      .toHaveLength(1);
    // The fold a RESTART folds holds no accounting triple any more: the
    // compaction cleared it (the mirror of the live reset).
    const replay = new ContextFold();
    await replay.observe(await eventsOf(fx));
    expect(replay.lastAssistantAccounting()).toBeNull();

    // Turn 2 on a FRESH runtime (a restart re-forms from the fold): the decision
    // is estimate-only and the estimate is the CURRENT surface price — never the
    // stale `usage + (surface − sample)` the pre-compaction anchor would give.
    const diagnostics: RuntimeDiagnostic[] = [];
    const third = new ScriptedTransport([reply('idle')]);
    const runtime3 = await runtimeFor(fx, configWith({ policy: rule }), third,
      { models: MODELS, diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime3);
    const [, turn2] = (await turns(fx)).slice(1);
    const current = await planAt(fx, turn2!, MODELS);
    expect(diagnostics.find((diagnostic) => diagnostic.kind === 'uncompactable-over-window'))
      .toEqual({
        kind: 'uncompactable-over-window', estimate: priceWire(current), threshold: 10,
      });
  });

  it('observes the re-price: an applied compaction that is still over is diagnosed', async () => {
    const fx = fixture();
    const rule = { compactAfterTokens: TINY_RULE, keepRecentGroups: 0 };
    const first = new ScriptedTransport([calling([waitCall('w1')])]);
    const runtime1 = await runtimeFor(fx, configWith({ policy: rule }), first, { models: MODELS });
    await runTurn(fx, runtime1);
    const diagnostics: RuntimeDiagnostic[] = [];
    const second = new ScriptedTransport([reply('idle')]);
    const runtime2 = await runtimeFor(fx, configWith({ policy: rule }), second,
      { models: MODELS, diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime2);
    // The 10-token threshold is far below even the trimmed offering: the
    // re-assembled plan is still over, and the bounded re-price says so.
    const after = diagnostics.find(
      (diagnostic) => diagnostic.kind === 'over-window-after-compaction');
    expect(after).toEqual({
      kind: 'over-window-after-compaction',
      estimate: priceBody(second.sends[0]!), threshold: 10,
    });
    // The after-price is the SENT plan's own price (the re-price is the plan the
    // request actually carries), and it is below the pre-compaction estimate.
    const pre = diagnostics.find((diagnostic) => diagnostic.kind === 'uncompactable-over-window');
    expect(pre).toBeUndefined();
  });
});

describe('the migration: the byte trigger\'s paths', () => {
  it('a pre-wave policy (no token key) keeps the byte trigger, silently', async () => {
    const fx = fixture();
    const diagnostics: RuntimeDiagnostic[] = [];
    const config = byteConfig({ policy: { compactAfterBytes: 2, keepRecentGroups: 0 } });
    const first = new ScriptedTransport([calling([waitCall('w1')])]);
    const runtime1 = await runtimeFor(fx, config, first,
      { models: MODELS, diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime1);
    // Turn 1: the committed history is over the 2-byte threshold.
    const second = new ScriptedTransport([reply('idle')]);
    const runtime2 = await runtimeFor(fx, config, second,
      { models: MODELS, diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime2);
    const starts = (await eventsOf(fx)).filter((event) => event.type === 'compaction/start');
    expect(starts).toHaveLength(1);
    // The byte trigger's transaction carries NO meter payload (it made no token
    // decision), and the old cell is never diagnosed: it lacks the key.
    expect((starts[0]!.data as unknown as { meter?: unknown }).meter).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it('a key-present, windowless cell stays on the byte trigger with one bounded diagnostic', async () => {
    const fx = fixture();
    const diagnostics: RuntimeDiagnostic[] = [];
    const config = configWith({
      policy: { compactAfterTokens: TINY_RULE, compactAfterBytes: 2, keepRecentGroups: 0 },
    });
    // No catalog: no window resolves, so the token branch cannot run.
    // ONE runtime, two turns: the diagnostic is once per BOOT, not per turn.
    const transport = new ScriptedTransport([calling([waitCall('w1')]), reply('idle')]);
    const runtime = await runtimeFor(fx, config, transport,
      { diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime);
    await runTurn(fx, runtime);
    expect(diagnostics).toEqual([{ kind: 'token-trigger-fallback' }]);
    const starts = (await eventsOf(fx)).filter((event) => event.type === 'compaction/start');
    expect(starts).toHaveLength(1);
    expect((starts[0]!.data as unknown as { meter?: unknown }).meter).toBeUndefined();
    // One send per turn: the byte trigger's transaction makes none of its own.
    expect(transport.sends).toHaveLength(2);
  });

  it('the smoke case: a fresh no-catalog cell (the factory policy) stays on the byte trigger', async () => {
    const fx = fixture();
    const diagnostics: RuntimeDiagnostic[] = [];
    // The factory config carries the token key; the store declares no catalog.
    const transport = new ScriptedTransport([reply('idle')]);
    const runtime = await runtimeFor(fx, configWith(), transport,
      { diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime);
    // One send, no decision: the byte trigger is the cell's only trigger (and it
    // has nothing to compact), and the windowless fallback is diagnosed once.
    expect(transport.sends).toHaveLength(1);
    expect(diagnostics).toEqual([{ kind: 'token-trigger-fallback' }]);
    expect((await eventsOf(fx)).filter((event) => event.type === 'compaction/start'))
      .toHaveLength(0);
    expect(transport.sends).toHaveLength(1);
  });

  it('a key-present cell with a window takes the token branch, not the fallback', async () => {
    const fx = fixture();
    // The reverse of the fallback: with a window, the same key runs the token
    // trigger. Nothing is committed yet, so the decision is the uncompactable
    // escape — never the windowless fallback.
    const diagnostics: RuntimeDiagnostic[] = [];
    const transport = new ScriptedTransport([reply('idle')]);
    const runtime = await runtimeFor(
      fx, configWith({ policy: { compactAfterTokens: TINY_RULE } }), transport,
      { models: MODELS, diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime);
    expect(transport.sends).toHaveLength(1);
    expect(diagnostics).toEqual([{ kind: 'uncompactable-over-window', estimate: expect.any(Number), threshold: 10 }]);
    expect(diagnostics.some((diagnostic) => diagnostic.kind === 'token-trigger-fallback'))
      .toBe(false);
  });
});

describe('the usage parse at the adapter edge, through the runtime', () => {
  it('journals the OpenAI shape with the cached subset informational, never double-counted', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      reply('idle', { prompt: 100, completion: 5, cached: 70 }),
    ]);
    const runtime = await runtimeFor(
      fx, configWith({ policy: { compactAfterTokens: WIDE_RULE } }), transport, { models: MODELS });
    await runTurn(fx, runtime);
    const [turn] = await turns(fx);
    const accounting = await accountingAt(fx, turn!);
    expect(accounting?.usage).toEqual({
      promptTokens: 100, completionTokens: 5, totalTokens: 105, cachedTokens: 70,
    });
  });

  it('flattens a malformed usage to absent: the turn still succeeds, no sample journals', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([{
      status: 200, headers: {}, complete: true, failure: null,
      body: Buffer.from(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'idle' } }],
        usage: { prompt_tokens: -1, completion_tokens: 5 },
      })),
    }]);
    const runtime = await runtimeFor(
      fx, configWith({ policy: { compactAfterTokens: WIDE_RULE } }), transport, { models: MODELS });
    await runTurn(fx, runtime);
    const [turn] = await turns(fx);
    expect(await accountingAt(fx, turn!)).toBeUndefined();
    const events = await eventsOf(fx);
    expect(events.filter((event) => event.type === 'assistant/message')).toHaveLength(1);
    expect(events.find((event) => event.type === 'turn/end')!.data)
      .toMatchObject({ outcome: 'waiting' });
  });

  it('flattens a usage above the declared window, at the host\'s window (the store→runtime hand-off)', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      reply('idle', { prompt: 15_000, completion: 5_000 }),
    ]);
    const runtime = await runtimeFor(
      fx, configWith({ policy: { compactAfterTokens: WIDE_RULE } }), transport, { models: MODELS });
    await runTurn(fx, runtime);
    const [turn] = await turns(fx);
    // The request was sent (so the hand-off happened)…
    expect(transport.sends).toHaveLength(1);
    expect((await eventsOf(fx)).filter((event) => event.type === 'assistant/message'))
      .toHaveLength(1);
    // …and 20,000 tokens over a declared 10,000-token window flatten to absent.
    expect(await accountingAt(fx, turn!)).toBeUndefined();
  });

  it('keeps the same usage when no window is declared (the structural cap only)', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      reply('idle', { prompt: 15_000, completion: 5_000 }),
    ]);
    const runtime = await runtimeFor(fx, configWith(), transport);
    await runTurn(fx, runtime);
    const [turn] = await turns(fx);
    expect((await accountingAt(fx, turn!))?.usage.totalTokens).toBe(20_000);
  });
});

describe('the overflow answer (the separable slice)', () => {
  it('classifies the provider\'s window refusal, forces a maximal reduction and resends once', async () => {
    const fx = fixture();
    // A pre-wave (byte-trigger) cell keeps the token trigger out of the way.
    const config = byteConfig();
    const first = new ScriptedTransport([calling([waitCall('w1')])]);
    const runtime1 = await runtimeFor(fx, config, first);
    await runTurn(fx, runtime1);
    const [turn0] = await turns(fx);
    expect(turn0).toBeDefined();

    const transport = new ScriptedTransport([contextExceeded(), reply('idle')]);
    const runtime2 = await runtimeFor(fx, config, transport);
    const before = (await frontierRequests(fx)).length;
    await runTurn(fx, runtime2);

    // ONE forced maximal reduction (retain 0, bypassing the byte threshold) and
    // ONE resend in a NEW frontier group.
    expect(transport.sends).toHaveLength(2);
    const requests = await frontierRequests(fx);
    expect(requests.length).toBe(before + 2);
    expect(requests.at(-1)!.group).not.toBe(requests.at(-2)!.group);
    const events = await eventsOf(fx);
    expect(events.filter((event) => event.type === 'compaction/end')).toHaveLength(1);
    // The resend's plan is the reduced one: strictly smaller than the first.
    expect(priceBody(transport.sends[1]!)).toBeLessThan(priceBody(transport.sends[0]!));
    // The resend succeeded, so the turn is not an error.
    expect(events.at(-1)!.type).not.toBe('turn/end');
    const end = [...events].reverse().find((event) => event.type === 'turn/end')!;
    expect(end.data).toMatchObject({ outcome: 'waiting' });
  });

  it('parks when a cancellation lands during the resend, never journaling the provider error', async () => {
    const fx = fixture();
    const config = byteConfig();
    const first = new ScriptedTransport([calling([waitCall('w1')])]);
    const runtime1 = await runtimeFor(fx, config, first);
    await runTurn(fx, runtime1);

    const cancelled: TransportResult = {
      status: null, headers: {}, body: new Uint8Array(), complete: false,
      failure: { code: 'cancelled', status: null },
    };
    const transport = new ScriptedTransport([contextExceeded(), cancelled]);
    const runtime2 = await runtimeFor(fx, config, transport);
    await runTurn(fx, runtime2);
    expect(transport.sends).toHaveLength(2);
    const end = [...(await eventsOf(fx))].reverse()
      .find((event) => event.type === 'turn/end')!;
    // A stop during the resend is a boundary cancellation: the turn parks and no
    // `context-exceeded` error closer is journaled over it.
    expect(end.data).toMatchObject({ outcome: 'waiting' });
  });

  it('passes the ORIGINAL error through when the resend fails too', async () => {
    const fx = fixture();
    const config = byteConfig();
    const first = new ScriptedTransport([calling([waitCall('w1')])]);
    const runtime1 = await runtimeFor(fx, config, first);
    await runTurn(fx, runtime1);

    const transport = new ScriptedTransport([contextExceeded(), unrelated400()]);
    const runtime2 = await runtimeFor(fx, config, transport);
    await runTurn(fx, runtime2);
    expect(transport.sends).toHaveLength(2);
    const end = [...(await eventsOf(fx))].reverse()
      .find((event) => event.type === 'turn/end')!;
    // The second failure's own code is `http`; the original window refusal is
    // what the turn records.
    expect(end.data).toMatchObject({ outcome: 'error', error: 'context-exceeded 400' });
  });
});

// ==================================================================================
// The remember verb (A5): the pending authored survival, the early flag, the
// typed outcomes and the gate — driven through the real runtime.
// ==================================================================================

describe('the remember verb: the pending authored survival', () => {
  const GATE_ON = { remember: true, messages: false };
  /** A wide byte threshold: nothing compacts while the payload is authored. */
  const wide = (policy: Partial<SeedPolicy> = {}): Partial<SeedPolicy> => ({
    compactAfterBytes: 1_000_000, keepRecentGroups: 0, memory: GATE_ON, ...policy,
  });
  /** The next config version: the byte trigger fires, consuming the slot. */
  const compacting = (version = 2): AgentConfig =>
    byteConfig({ version, policy: wide({ compactAfterBytes: 1, memory: GATE_ON }) });

  it('pins the turn-distance expiry constant', () => {
    // The slot's age is a TURN DISTANCE (A5's committed pin), not wall time.
    expect(REMEMBER_PENDING_TURNS).toBe(4);
  });

  it('maps every non-applied early outcome to its own typed diagnostic (never silent)', () => {
    // 'applied' journals the transaction; both misses are typed, including the
    // ABORTED case (stale/orphan) that the branch previously swallowed.
    expect(earlyTriggerMiss('applied')).toBeNull();
    expect(earlyTriggerMiss('skipped')).toEqual({ kind: 'early-compact-nothing-selectable' });
    expect(earlyTriggerMiss('aborted')).toEqual({ kind: 'early-compact-aborted' });
  });

  it('records at turn N and lands at a later turn M: the frame, the sources, the typed outcome', async () => {
    const fx = fixture();
    const config = byteConfig({ policy: wide() });
    const transport = new ScriptedTransport([
      calling([waitCall('w1')]),                                    // turn 0
      calling([rememberCall('r1', 'the direction is north')]),      // turn 1, step 0
      reply('idle'),                                                // turn 1, step 1
      reply('idle'),                                                // turn 2 (compacts)
      reply('idle'),                                                // turn 3 (reads the frame)
    ]);
    const runtime = await runtimeFor(fx, config, transport, { extend: await memoryExtendPort(fx) });
    await runTurn(fx, runtime); // turn 0: one committed dialogue group
    await runTurn(fx, runtime); // turn 1: the verb records the pending payload
    // The verb is never a verb-time transaction: nothing has compacted yet.
    expect(await summariesOf(fx)).toHaveLength(0);
    runtime.scheduleConfig(compacting());
    await runTurn(fx, runtime); // turn 2: the plan site consumes the slot
    const summaries = await summariesOf(fx);
    expect(summaries).toHaveLength(1);
    const message = `${AUTHORED_FRAME}the direction is north`;
    expect(summaries[0]!.replacement).toBe('authored-applied');
    expect(summaries[0]!.message.content).toBe(message);
    // The removed span's sources are still cited.
    expect(summaries[0]!.sources.length).toBeGreaterThan(0);
    expect(summaries[0]!.replacementBytes).toBeGreaterThan(message.length);
    // The frame is in the NEXT plan's history as an ordinary user message.
    await runTurn(fx, runtime); // turn 3
    const [turn0] = await turns(fx);
    const plan = await planAt(fx, turn0! + 3, []);
    const users = plan.history.filter((entry) => entry.role === 'user')
      .map((entry) => entry.content);
    expect(users).toContain(message);
  });

  it('a second remember replaces the pending payload outright', async () => {
    const fx = fixture();
    const config = byteConfig({ policy: wide() });
    const transport = new ScriptedTransport([
      calling([waitCall('w1')]),                                     // turn 0
      calling([rememberCall('r1', 'the first text must not survive')]), // turn 1, step 0
      calling([rememberCall('r2', 'the second text survives')]),     // turn 1, step 1
      reply('idle'),                                                 // turn 1, step 2
      reply('idle'),                                                 // turn 2 (compacts)
    ]);
    const runtime = await runtimeFor(fx, config, transport, { extend: await memoryExtendPort(fx) });
    await runTurn(fx, runtime);
    await runTurn(fx, runtime);
    runtime.scheduleConfig(compacting());
    await runTurn(fx, runtime);
    const summaries = await summariesOf(fx);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.message.content).toContain('the second text survives');
    expect(summaries[0]!.message.content).not.toContain('the first text');
  });

  it('is lost on restart: a fresh runtime compacts with the fixed notice (the node re-authors)', async () => {
    const fx = fixture();
    const transport1 = new ScriptedTransport([
      calling([waitCall('w1')]),                              // turn 0
      calling([rememberCall('r1', 'the runtime-only text')]), // turn 1, step 0
      reply('idle'),                                          // turn 1, step 1
    ]);
    const runtime1 = await runtimeFor(
      fx, byteConfig({ policy: wide() }), transport1, { extend: await memoryExtendPort(fx) });
    await runTurn(fx, runtime1);
    await runTurn(fx, runtime1);
    expect(await summariesOf(fx)).toHaveLength(0);

    // A RESTART is a fresh runtime: the slot is host state, never journaled.
    const runtime2 = await runtimeFor(fx, byteConfig({ policy: wide() }), new ScriptedTransport([
      reply('idle'), // turn 2 (compacts)
    ]), { extend: await memoryExtendPort(fx) });
    runtime2.scheduleConfig(compacting());
    await runTurn(fx, runtime2);
    const summaries = await summariesOf(fx);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.replacement).toBe('no-pending-notice');
    expect(summaries[0]!.message.content).toBe(COMPACTION_NOTICE);
  });

  it('the strict-smaller rule at apply time falls back to the notice when the text is too large', async () => {
    const fx = fixture();
    const config = byteConfig({ policy: wide() });
    const transport = new ScriptedTransport([
      calling([waitCall('w1')]),                               // turn 0
      calling([rememberCall('r1', 'x'.repeat(5_000))]),        // turn 1, step 0
      reply('idle'),                                           // turn 1, step 1
      reply('idle'),                                           // turn 2 (compacts)
    ]);
    const runtime = await runtimeFor(fx, config, transport, { extend: await memoryExtendPort(fx) });
    await runTurn(fx, runtime);
    await runTurn(fx, runtime);
    // Retain the newest groups — the dialogue that carries the 5,000-byte
    // arguments and the perception beside it — so the eligible span is the
    // older, smaller surface the authored text cannot fit.
    runtime.scheduleConfig(byteConfig({
      version: 2, policy: wide({ compactAfterBytes: 1, keepRecentGroups: 2, memory: GATE_ON }),
    }));
    await runTurn(fx, runtime);
    const summaries = await summariesOf(fx);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.replacement).toBe('authored-too-large-fallback-notice');
    expect(summaries[0]!.message.content).toBe(COMPACTION_NOTICE);
  });

  it('the turn-distance expiry drops a stale payload instead of filling a later slot', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      calling([waitCall('w1')]),                              // turn 0: a committed span
      calling([rememberCall('r1', 'stale text must not land')]), // turn 1
      reply('idle'),                                          // turn 1, step 1
      reply('idle'),                                          // turn 2
      reply('idle'),                                          // turn 3
      reply('idle'),                                          // turn 4
      reply('idle'),                                          // turn 5 (compacts)
    ]);
    const runtime = await runtimeFor(
      fx, byteConfig({ policy: wide() }), transport, { extend: await memoryExtendPort(fx) });
    await runTurn(fx, runtime); // turn 0
    await runTurn(fx, runtime); // turn 1: recorded
    for (let turn = 2; turn <= 4; turn += 1) await runTurn(fx, runtime);
    expect(REMEMBER_PENDING_TURNS).toBe(4); // distance 4 at turn 5: expired
    runtime.scheduleConfig(compacting());
    await runTurn(fx, runtime); // turn 5: the distance is reached, the payload is dropped
    const summaries = await summariesOf(fx);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.replacement).toBe('no-pending-notice');
    expect(summaries[0]!.message.content).toBe(COMPACTION_NOTICE);
  });

  it('the early flag is consumed at the NEXT plan site, never at verb time', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      calling([waitCall('w1')]),                                     // turn 0: group 1
      calling([waitCall('w2')]),                                     // turn 1: group 2
      calling([rememberCall('r1', 'early text survives', true), waitCall('w3')]), // turn 2
      reply('idle'),                                                 // turn 3 (forces)
      reply('idle'),                                                 // turn 4 (no second fire)
    ]);
    const runtime = await runtimeFor(
      fx, byteConfig({ policy: wide() }), transport, { extend: await memoryExtendPort(fx) });
    await runTurn(fx, runtime); // turn 0
    await runTurn(fx, runtime); // turn 1
    await runTurn(fx, runtime); // turn 2: records the payload + the flag
    // Never a verb-time transaction: turn 2 itself compacted nothing.
    expect((await summariesOf(fx))).toHaveLength(0);
    await runTurn(fx, runtime); // turn 3: the flag fires one forced compaction
    await runTurn(fx, runtime); // turn 4: the flag is gone; the threshold is still wide
    const summaries = await summariesOf(fx);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.replacement).toBe('authored-applied');
    expect(summaries[0]!.message.content).toContain('early text survives');
    // Exactly one compaction, and it happened at turn 3 — the next plan site.
    expect(await compactionTurns(fx)).toEqual([3]);
  });

  it('the early trigger with nothing selectable is typed, never a silent no-op', async () => {
    const fx = fixture();
    const diagnostics: RuntimeDiagnostic[] = [];
    const transport = new ScriptedTransport([
      // The same turn: the remember dispatch is followed by the next plan site,
      // where the open turn is not on the committed surface yet.
      calling([rememberCall('r1', 'nothing to compact yet', true)]),
      reply('idle'),
    ]);
    const runtime = await runtimeFor(
      fx, byteConfig({ policy: wide() }), transport,
      { extend: await memoryExtendPort(fx), diagnose: (diagnostic) => diagnostics.push(diagnostic) });
    await runTurn(fx, runtime);
    expect(diagnostics).toContainEqual({ kind: 'early-compact-nothing-selectable' });
    expect((await eventsOf(fx)).filter((event) => event.type === 'compaction/start'))
      .toHaveLength(0);
  });

  // The M1×M2 seam: the early flag and the token trigger are two admission
  // paths to the SAME transaction. These two rows prove the combination, which
  // neither brick's own tests exercised (the remember rows use the byte path
  // and the token rows never set memory).
  it('the early flag suppresses the routine/token compaction: one transaction when both would fire', async () => {
    const fx = fixture();
    const diagnostics: RuntimeDiagnostic[] = [];
    const gated = {
      compactAfterBytes: 1_000_000, keepRecentGroups: 0,
      compactAfterTokens: WIDE_RULE, memory: GATE_ON,
    };
    const transport = new ScriptedTransport([
      calling([waitCall('w1')]), // turn 0: one committed dialogue, the wide rule silent
      calling([rememberCall('r1', 'early under the token trigger', true), waitCall('w2')]),
      reply('idle'), // turn 2: the consuming plan site
    ]);
    const runtime = await runtimeFor(fx, configWith({ policy: gated }), transport,
      {
        models: MODELS, diagnose: (diagnostic) => diagnostics.push(diagnostic),
        extend: await memoryExtendPort(fx),
      });
    await runTurn(fx, runtime); // turn 0
    await runTurn(fx, runtime); // turn 1: the flag is recorded; its own plan site had none
    expect((await eventsOf(fx)).filter((event) => event.type === 'compaction/start'))
      .toHaveLength(0);
    // Turn 2: the tiny token rule AND the byte threshold would both fire. The
    // early flag is consumed first and is the ONE erasure; the token branch
    // re-prices instead of firing a second.
    runtime.scheduleConfig(configWith({
      version: 2,
      policy: { ...gated, compactAfterBytes: 1, compactAfterTokens: TINY_RULE },
    }));
    await runTurn(fx, runtime);
    const events = await eventsOf(fx);
    expect(events.filter((event) => event.type === 'compaction/start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'compaction/end')).toHaveLength(1);
    const summary = (await summariesOf(fx))[0]!;
    expect(summary.replacement).toBe('authored-applied');
    expect(summary.message.content).toContain('early under the token trigger');
    // The token branch evaluated and observed the still-over price: the re-price
    // diagnostic is the proof it did not fire a second transaction.
    expect(diagnostics).toContainEqual({
      kind: 'over-window-after-compaction',
      estimate: expect.any(Number), threshold: 10,
    });
  }, 20_000);

  it('lands the authored survival under the TOKEN trigger (the meter path carries the replacement)', async () => {
    const fx = fixture();
    const gated = {
      compactAfterBytes: 1_000_000, keepRecentGroups: 0,
      compactAfterTokens: WIDE_RULE, memory: GATE_ON,
    };
    const transport = new ScriptedTransport([
      calling([waitCall('w1')]), // turn 0: the committed span
      calling([rememberCall('r1', 'survival under the token trigger')]), // turn 1, step 0
      reply('idle'), // turn 1, step 1
      reply('idle'), // turn 2: the token trigger fires
    ]);
    const runtime = await runtimeFor(fx, configWith({ policy: gated }), transport,
      { models: MODELS, extend: await memoryExtendPort(fx) });
    await runTurn(fx, runtime); // turn 0
    await runTurn(fx, runtime); // turn 1: the payload is pending, the wide rule silent
    runtime.scheduleConfig(configWith({
      version: 2, policy: { ...gated, compactAfterTokens: TINY_RULE },
    }));
    await runTurn(fx, runtime); // turn 2: the token trigger decides the transaction
    const starts = (await eventsOf(fx)).filter((event) => event.type === 'compaction/start');
    expect(starts).toHaveLength(1);
    // The TOKEN path decided it: the start carries the kernel's meter payload.
    expect((starts[0]!.data as unknown as { meter?: unknown }).meter).toBeDefined();
    const summary = (await summariesOf(fx))[0]!;
    expect(summary.replacement).toBe('authored-applied');
    expect(summary.message.content).toContain('survival under the token trigger');
  }, 20_000);
});
