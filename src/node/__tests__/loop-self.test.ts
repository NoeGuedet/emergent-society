import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderAdapter, type ProviderPolicy } from '../../provider/adapter.js';
import type {
  SerializedTransport, TransportFacts, TransportResult,
} from '../../provider/transport.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { ContextFold } from '../../context/fold.js';
import { loadVerifiedEvents, type VerifiedEvents } from '../../context/loader.js';
import { validateAgentConfig } from '../../context/config.js';
import type { AgentConfig, FunctionCall } from '../../context/contracts.js';
import type { EventEnvelope } from '../../journal/index.js';
import { readFrontier } from '../../frontier/__tests__/helpers.js';
import { createAgentRuntime, defaultAgentConfig, type AgentRuntime } from '../loop.js';
import { createPackageStore } from '../packages/store.js';
import { createRunSupervisor } from '../packages/supervisor.js';
import { DEFAULT_TERMINAL_ENV } from '../tools/terminal.js';
import type { ExtendPort } from '../tools/extend.js';
import { commitAs, openTestDriver, useWorld, type WorldFixture } from './helpers.js';

/**
 * The runtime side of `update_self` (plan §0.7): the rewrite reaches the next
 * assembled request within the same turn, the turn's dispatch keeps the config
 * captured at turn start (`run()` binds one `config` and hands it to every
 * `dispatchCalls`), the ratified direction still wins the heading block, two
 * rewrites in one turn land strictly increasing versions, and the frontier
 * journal's event-kind set is untouched.
 *
 * The real runtime, driver, fold, world, store and journal run here; only the
 * provider transport is scripted.
 */

const fixture = useWorld('c13-loop-self-');

const providerPolicy: ProviderPolicy = {
  delay: (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new Error('cancelled'));
    };
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

function noCalls(content: string): TransportResult {
  return {
    status: 200, headers: {}, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })),
  };
}

function calling(calls: readonly FunctionCall[]): TransportResult {
  return {
    status: 200, headers: {}, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
    })),
  };
}

/** One `extend {verb:"update_self", ...}` call, as the model would advertise it. */
function updateSelf(id: string, args: Record<string, unknown>): FunctionCall {
  return {
    id, type: 'function',
    function: { name: 'extend', arguments: JSON.stringify({ verb: 'update_self', ...args }) },
  };
}

const seedConfig = (): AgentConfig => validateAgentConfig({
  ...defaultAgentConfig(),
  heading: 'seed heading',
  charter: 'the boot charter You are n1.',
});

async function adapterFor(fx: WorldFixture, transport: SerializedTransport): Promise<ProviderAdapter> {
  return new ProviderAdapter(transport, providerPolicy, (await fx.frontier()).gate);
}

/** The real extend port the runtime's factory returns (the self field is the runtime's). */
async function portFor(fx: WorldFixture): Promise<ExtendPort> {
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

async function runtimeFor(
  fx: WorldFixture, transport: ScriptedTransport, initialConfig: AgentConfig = seedConfig(),
): Promise<AgentRuntime> {
  const port = await portFor(fx);
  return createAgentRuntime({
    home: fx.home, uid: 'n1', world: fx.world, initialConfig,
    terminal: { env: DEFAULT_TERMINAL_ENV },
    adapter: await adapterFor(fx, transport),
    extend: () => port,
  });
}

function openRuntime(fx: WorldFixture, runtime: AgentRuntime) {
  return openTestDriver(fx.home, 'n1', runtime.handler, fx.world, {
    knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
  });
}

type Wire = {
  readonly model: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string | null }>;
  readonly tools: readonly unknown[];
};

function wire(bytes: Uint8Array): Wire {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Wire;
}

/** The kernel-owned prefix: [0] charter, [1] heading (the substrate block is absent). */
function systemMessage(index: 0 | 1, body: Wire): string {
  return body.messages[index]!.content ?? '';
}

async function localEvents(fx: WorldFixture): Promise<VerifiedEvents> {
  return loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
}

async function foldedConfig(fx: WorldFixture): Promise<AgentConfig | null> {
  const fold = new ContextFold();
  await fold.observe(await localEvents(fx));
  return fold.snapshot().config?.value ?? null;
}

function resultContents(events: readonly EventEnvelope[]): string[] {
  return events
    .filter((event) => event.type === 'tool/result')
    .map((event) => (event.data as { message?: { content?: string } }).message?.content ?? '');
}

async function runOneTurn(
  fx: WorldFixture, transport: ScriptedTransport,
): Promise<readonly EventEnvelope[]> {
  const runtime = await runtimeFor(fx, transport);
  const driver = await openRuntime(fx, runtime);
  const running = driver.run();
  await vi.waitFor(() => expect(driver.state).toBe('waiting'), { timeout: 20_000 });
  driver.stop();
  await running;
  return localEvents(fx);
}

describe('the runtime self rewrite', () => {
  it('lands the next assembled request in the same turn, dispatch captured', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      calling([updateSelf('u1', { heading: 'rewritten heading' })]),
      noCalls('idle'),
    ]);
    const events = await runOneTurn(fx, transport);

    // Both requests belong to ONE turn: the rewrite applied between steps.
    expect(transport.sends).toHaveLength(2);
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(1);

    const first = wire(transport.sends[0]!);
    const second = wire(transport.sends[1]!);
    expect(systemMessage(1, first)).toBe('seed heading');
    expect(systemMessage(1, second)).toBe('rewritten heading');
    // The charter is untouched by a heading-only rewrite (the kernel sentence
    // is the charter's, not a second copy on the wire).
    expect(systemMessage(0, first)).toBe('the boot charter You are n1.');
    expect(systemMessage(0, second)).toBe('the boot charter You are n1.');
    // The model rides the config too: unchanged here.
    expect(second.model).toBe(first.model);

    // The new identity applies from the NEXT ASSEMBLED REQUEST, and the
    // turn's dispatch stayed on the config captured at turn start: `run()`
    // binds one `config` and hands it to every dispatchCalls call, so a later
    // call in this same turn still dispatches against the turn-start policy —
    // a fact by construction, unobservable here because a rewrite may not
    // carry capabilities. The journal proves the ordering: the config event
    // lands after the update_self call and before the second request's
    // assistant message.
    const order = events.map((event) => event.type);
    expect(order.indexOf('system/message', order.indexOf('system/message') + 1))
      .toBeGreaterThan(order.indexOf('tool/call'));

    const configs = events.filter((event) => event.type === 'system/message');
    expect(configs.map((event) => (event.data as { version: number }).version)).toEqual([1, 2]);
    expect((await foldedConfig(fx))?.heading).toBe('rewritten heading');
    expect(resultContents(events)).toContain('self updated (version 2): heading');
  }, 30_000);

  it('a ratified direction pins the heading block; the rewrite moves only the fallback', async () => {
    const fx = fixture();
    await commitAs(fx.world, 'human', { 'DIRECTION.md': 'the ratified direction' });
    const transport = new ScriptedTransport([
      calling([updateSelf('u1', { heading: 'rewritten heading' })]),
      noCalls('idle'),
    ]);
    const events = await runOneTurn(fx, transport);

    const first = wire(transport.sends[0]!);
    const second = wire(transport.sends[1]!);
    // Both requests carry the ratified direction — update_self never rewrites it.
    expect(systemMessage(1, first)).toBe('the ratified direction');
    expect(systemMessage(1, second)).toBe('the ratified direction');
    expect(systemMessage(1, second)).not.toBe('rewritten heading');
    // The journaled heading (the seed fallback) did move.
    expect((await foldedConfig(fx))?.heading).toBe('rewritten heading');
    expect(events.some((event) => event.type === 'direction/pinned')).toBe(true);
  }, 30_000);

  it('two rewrites in one turn land strictly increasing versions', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      calling([
        updateSelf('u1', { heading: 'first heading' }),
        updateSelf('u2', { model: 'model-b' }),
      ]),
      noCalls('idle'),
    ]);
    const events = await runOneTurn(fx, transport);

    const configs = events.filter((event) => event.type === 'system/message');
    expect(configs.map((event) => (event.data as { version: number }).version)).toEqual([1, 2, 3]);
    const config = await foldedConfig(fx);
    expect(config?.version).toBe(3);
    expect(config?.heading).toBe('first heading');
    expect(config?.model).toBe('model-b');
    // The second request is assembled from the live fold: both rewrites are in it.
    const second = wire(transport.sends[1]!);
    expect(systemMessage(1, second)).toBe('first heading');
    expect(second.model).toBe('model-b');

    const results = resultContents(events);
    expect(results).toContain('self updated (version 2): heading');
    expect(results).toContain('self updated (version 3): model');
  }, 30_000);

  it('leaves the frontier journal\'s event-kind set untouched', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      calling([updateSelf('u1', { heading: 'rewritten heading' })]),
      noCalls('idle'),
    ]);
    await runOneTurn(fx, transport);

    // The pre-wave frontier vocabulary, spelled literally: a new kind here is a
    // format change, not a detail.
    const preWave = new Set(['http/request', 'http/response', 'http/incomplete']);
    const frontier = await readFrontier(fx.home);
    const kinds = new Set(frontier.map((event) => event.type));
    expect(kinds).toEqual(new Set(['http/request', 'http/response']));
    for (const kind of kinds) expect(preWave.has(kind)).toBe(true);
    // The identity history is node-local: no config event reached the frontier.
    expect(frontier.some((event) => event.type === 'system/message')).toBe(false);
    const local = await localEvents(fx);
    expect(local.filter((event) => event.type === 'system/message')).toHaveLength(2);
  }, 30_000);
});
