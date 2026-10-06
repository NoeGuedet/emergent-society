import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NodeDriver } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { WorldRepo } from '../world.js';
import { DEFAULT_SHELL_ENV, type ShellPolicy } from '../tools/shell.js';
import { createAgentRuntime, defaultAgentConfig, type AgentRuntime } from '../loop.js';
import { rederivePlans } from '../../context/assembler.js';
import { canonicalBytes } from '../../context/artifacts.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { ProviderAdapter, type ProviderPolicy } from '../../provider/adapter.js';
import type { SerializedTransport, TransportResult } from '../../provider/transport.js';
import type {
  AgentConfig, FunctionCall, SeedPolicy, ToolSchema,
} from '../../context/contracts.js';
import { commitAs, useWorld, type WorldFixture } from './helpers.js';

/**
 * Runtime loop fixtures (T9). These drive the real `createAgentRuntime` through
 * the real `NodeDriver`: the transport is scripted, but the journal, the fold,
 * the shell and the world are the production ones. Nothing here mocks a high
 * level chat; the assertions read the durable journal.
 *
 * `presentWorld` is wrapped so one fixture can present a perception whose uid is
 * not the runtime's uid; every other path delegates to the real renderer.
 */

type PresentWorld = typeof import('../../context/diff.js').presentWorld;

const presenter = vi.hoisted(() => ({
  real: null as unknown as PresentWorld,
  override: null as null | PresentWorld,
}));

vi.mock('../../context/diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context/diff.js')>();
  presenter.real = actual.presentWorld;
  const wrapped = (...args: Parameters<PresentWorld>): Promise<Awaited<ReturnType<PresentWorld>>> =>
    (presenter.override ?? actual.presentWorld)(...args);
  return { ...actual, presentWorld: wrapped };
});

const fixture = useWorld('c13-loop-');

const providerPolicy: ProviderPolicy = {
  now: () => 0,
  delay: (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => { if (timer !== undefined) clearTimeout(timer); reject(new Error('cancelled')); };
    timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  }),
  schedule: () => () => {},
};

/** Records every send and answers from a fixed script, in order. */
class ScriptedTransport implements SerializedTransport {
  readonly sends: Uint8Array[] = [];
  private readonly script: TransportResult[];

  constructor(script: readonly TransportResult[]) {
    this.script = [...script];
  }

  async post(body: Uint8Array, signal: AbortSignal, _maxBytes: number): Promise<TransportResult> {
    if (signal.aborted) {
      return {
        status: null, body: new Uint8Array(), complete: false,
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
    status: 200, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] })),
  };
}

function calling(calls: readonly FunctionCall[]): TransportResult {
  return {
    status: 200, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
    })),
  };
}

function statusResponse(status: number): TransportResult {
  return { status, complete: true, failure: null, body: new Uint8Array() };
}

function execute(id: string, cmd: string): FunctionCall {
  return { id, type: 'function', function: { name: 'execute', arguments: JSON.stringify({ cmd }) } };
}

function waitCall(id: string): FunctionCall {
  return { id, type: 'function', function: { name: 'wait', arguments: '{}' } };
}

function configWith(over: {
  policy?: Partial<SeedPolicy>; model?: string;
  tools?: ToolSchema[]; allowedTools?: string[];
} = {}): AgentConfig {
  const base = defaultAgentConfig();
  return {
    ...base,
    model: over.model ?? base.model,
    tools: over.tools ?? base.tools,
    allowedTools: over.allowedTools ?? base.allowedTools,
    policy: { ...base.policy, ...over.policy } as SeedPolicy,
  };
}

function shellPolicyFor(config: AgentConfig): ShellPolicy {
  return {
    timeoutMs: config.policy.shellTimeoutMs,
    killGraceMs: config.policy.killGraceMs,
    maxCaptureBytes: config.policy.maxShellCaptureBytes,
    drainDeadlineMs: config.policy.shellDrainMs,
    env: DEFAULT_SHELL_ENV,
  };
}

function runtimeFor(
  fx: WorldFixture, config: AgentConfig, transport: ScriptedTransport,
): AgentRuntime {
  return createAgentRuntime({
    home: fx.home, uid: 'n1', world: fx.world, initialConfig: config,
    shellPolicy: shellPolicyFor(config),
    adapter: new ProviderAdapter(transport, providerPolicy),
  });
}

function openRuntime(fx: WorldFixture, runtime: AgentRuntime): Promise<NodeDriver> {
  return NodeDriver.open(fx.home, 'n1', runtime.handler, fx.world, {
    knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
  });
}

function eventsOf(fx: WorldFixture) {
  return loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
}

describe('turn control', () => {
  it('waits a turn whose assistant makes no tool calls', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([noCalls('thinking')]);
    const runtime = runtimeFor(fx, configWith({ policy: { retryDelayMs: 1 } }), transport);
    const driver = await openRuntime(fx, runtime);
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

    expect(transport.sends).toHaveLength(1);
    const events = await eventsOf(fx);
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1);
    const end = events.find((event) => event.type === 'turn/end');
    expect(end?.data).toMatchObject({ outcome: 'waiting' });
    // Nothing called and nothing committed: the turn is the skip unit.
    expect(end?.ignorable).toBe(true);
  });

  it('finishes a complete wait group before it waits', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([calling([waitCall('w1')])]);
    const runtime = runtimeFor(fx, configWith({ policy: { retryDelayMs: 1 } }), transport);
    const driver = await openRuntime(fx, runtime);
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

    expect(transport.sends).toHaveLength(1);
    const events = await eventsOf(fx);
    const calls = events.filter((event) => event.type === 'tool/call');
    const results = events.filter((event) => event.type === 'tool/result');
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    const message = (results[0]!.data as { message: { content: string } }).message;
    expect(message.content).toMatch(/Waiting/);
    const end = events.find((event) => event.type === 'turn/end');
    expect(end?.data).toMatchObject({ outcome: 'waiting' });
    expect(end?.ignorable).toBeUndefined();
  });

  it('chains after a complete call group when the quantum is exhausted', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      calling([execute('c1', 'true')]),
      noCalls('done'),
    ]);
    const runtime = runtimeFor(
      fx, configWith({ policy: { stepsPerTurn: 1, retryDelayMs: 1 } }), transport,
    );
    const driver = await openRuntime(fx, runtime);
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

    expect(transport.sends).toHaveLength(2);
    const events = await eventsOf(fx);
    const outcomes = events.filter((event) => event.type === 'turn/end')
      .map((event) => (event.data as { outcome: string }).outcome);
    expect(outcomes).toEqual(['chained', 'waiting']);
    // The next turn's request carries the previous turn's balanced dialogue.
    const second = JSON.parse(Buffer.from(transport.sends[1]!).toString('utf8')) as {
      messages: Array<Record<string, unknown>>;
    };
    const assistant = second.messages.find(
      (message) => message['role'] === 'assistant' && Array.isArray(message['tool_calls']),
    );
    const tool = second.messages.find((message) => message['role'] === 'tool');
    expect((assistant?.['tool_calls'] as Array<{ id: string }>)[0]?.id).toBe('c1');
    expect(tool?.['tool_call_id']).toBe('c1');
  });
});

describe('recoverable provider failure', () => {
  it('parks on an exhausted retryable failure and recovers on a foreign wake', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      statusResponse(429), statusResponse(429), noCalls('recovered'),
    ]);
    const runtime = runtimeFor(
      fx, configWith({ policy: { maxAttempts: 2, retryDelayMs: 1 } }), transport,
    );
    const driver = await openRuntime(fx, runtime);
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));

    expect(transport.sends).toHaveLength(2);
    let events = await eventsOf(fx);
    const failed = events.find((event) => event.type === 'turn/end');
    expect(failed?.data).toMatchObject({ outcome: 'error', error: 'http 429' });
    const attempts = events.filter((event) => event.type === 'assistant/attempt');
    expect(attempts).toHaveLength(2);
    expect((attempts[1]!.data as { terminal: boolean }).terminal).toBe(true);

    // A foreign commit wakes the parked node; the next turn succeeds.
    await commitAs(fx.world, 'n2', { 'n2/hi.md': 'hi' });
    await HeadWatcher.for(fx.world, 0).check();
    await vi.waitFor(() => expect(transport.sends).toHaveLength(3));
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

    events = await eventsOf(fx);
    const outcomes = events.filter((event) => event.type === 'turn/end')
      .map((event) => (event.data as { outcome: string }).outcome);
    expect(outcomes).toEqual(['error', 'waiting']);
  });
});

describe('stop', () => {
  it('aborts an active shell process and appends no later request', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([
      calling([execute('s1', 'touch started.txt && sleep 30')]),
    ]);
    const runtime = runtimeFor(
      fx, configWith({ policy: { stepsPerTurn: 8, retryDelayMs: 1 } }), transport,
    );
    const driver = await openRuntime(fx, runtime);
    const started = Date.now();
    const running = driver.run();
    await vi.waitFor(
      async () => { await access(join(fx.world.path, 'started.txt')); },
      { timeout: 15000 },
    );
    driver.stop();
    await running;

    expect(Date.now() - started).toBeLessThan(10000);
    expect(transport.sends).toHaveLength(1);
    const events = await eventsOf(fx);
    // The killed call completed the group; no second logical request was attempted.
    expect(events.filter((event) => event.type === 'request/plan')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool/result')).toHaveLength(1);
    const shutdown = events.findIndex((event) => event.type === 'node/shutdown');
    expect(shutdown).toBe(events.length - 1);
    const lastAttempt = events.map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'request/wire' || event.type === 'assistant/attempt')
      .at(-1);
    if (lastAttempt !== undefined) expect(lastAttempt.index).toBeLessThan(shutdown);
  });
});

describe('parking', () => {
  it('makes no extra request when a static world is re-checked while parked', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([noCalls('idle')]);
    const runtime = runtimeFor(fx, configWith({ policy: { retryDelayMs: 1 } }), transport);
    const driver = await openRuntime(fx, runtime);
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));

    const watcher = HeadWatcher.for(fx.world, 0);
    for (let i = 0; i < 6; i += 1) await watcher.check();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(transport.sends).toHaveLength(1);
    const events = await eventsOf(fx);
    expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1);
    driver.stop();
    await running;
  });
});

describe('world perception identity', () => {
  it('refuses a perception whose uid is not the runtime uid before any effect', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([]);
    const runtime = runtimeFor(fx, defaultAgentConfig(), transport);
    presenter.override = (world, _uid, range, maxBytes, maxCommits) =>
      presenter.real(world, 'intruder', range, maxBytes, maxCommits);
    try {
      const driver = await openRuntime(fx, runtime);
      await expect(driver.run()).rejects.toThrow(/uid/);
      expect(transport.sends).toHaveLength(0);
      expect(await fx.world.headHash()).toBeNull();
      await expect(access(join(fx.world.path, 'note.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const events = await eventsOf(fx);
      expect(events.filter((event) => event.type === 'turn/start')).toHaveLength(1);
      expect(events.some((event) => event.type === 'world/perception')).toBe(false);
      expect(events.some((event) => event.type === 'request/plan')).toBe(false);
      expect(events.some((event) => event.type === 'request/wire')).toBe(false);
      // The turn is still closed by the normal durable fatal closer.
      expect(events.find((event) => event.type === 'turn/end')?.data)
        .toMatchObject({ outcome: 'error' });
      expect(driver.state).toBe('stopped');
    } finally {
      presenter.override = null;
    }
  });
});

describe('configuration and shell policy', () => {
  it('refuses supplied shell limits that disagree with the recorded configuration', async () => {
    const fx = fixture();
    const config = defaultAgentConfig();
    const transport = new ScriptedTransport([]);
    const runtime = createAgentRuntime({
      home: fx.home, uid: 'n1', world: fx.world, initialConfig: config,
      shellPolicy: { ...shellPolicyFor(config), timeoutMs: config.policy.shellTimeoutMs + 1 },
      adapter: new ProviderAdapter(transport, providerPolicy),
    });
    await expect(openRuntime(fx, runtime)).rejects.toThrow(/shell policy/);
    expect(transport.sends).toHaveLength(0);
  });

  it('applies a strictly newer scheduled configuration at the next turn start', async () => {
    const fx = fixture();
    const base = configWith({ policy: { retryDelayMs: 1 } });
    const transport = new ScriptedTransport([noCalls('one')]);
    const runtime = runtimeFor(fx, base, transport);
    const driver = await openRuntime(fx, runtime);
    runtime.scheduleConfig({ ...base, version: base.version + 1, heading: 'A newer direction.' });
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

    const events = await eventsOf(fx);
    const versions = events.filter((event) => event.type === 'system/message')
      .map((event) => (event.data as { version: number }).version);
    expect(versions).toEqual([1, 2]);
    const wire = JSON.parse(Buffer.from(transport.sends[0]!).toString('utf8')) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(wire.messages[1]).toEqual({ role: 'system', content: 'A newer direction.' });
  });

  it('ignores a scheduled configuration that is not strictly newer', async () => {
    const fx = fixture();
    const base = configWith({ policy: { retryDelayMs: 1 } });
    const transport = new ScriptedTransport([noCalls('one')]);
    const runtime = runtimeFor(fx, base, transport);
    const driver = await openRuntime(fx, runtime);
    runtime.scheduleConfig({ ...base, version: base.version, heading: 'Stale direction.' });
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

    const events = await eventsOf(fx);
    const versions = events.filter((event) => event.type === 'system/message')
      .map((event) => (event.data as { version: number }).version);
    expect(versions).toEqual([1]);
    const wire = JSON.parse(Buffer.from(transport.sends[0]!).toString('utf8')) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(wire.messages[1]?.content).toBe(base.heading);
  });
});

describe('offline reconstruction', () => {
  async function journalWithOneTurn(): Promise<WorldFixture> {
    const fx = fixture();
    await commitAs(fx.world, 'n2', { 'n2/hi.md': 'hello' });
    const transport = new ScriptedTransport([noCalls('seen')]);
    const runtime = runtimeFor(fx, configWith({ policy: { retryDelayMs: 1 } }), transport);
    const driver = await openRuntime(fx, runtime);
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;
    return fx;
  }

  it('rederives every recorded plan and world perception canonically', async () => {
    const fx = await journalWithOneTurn();
    const events = await eventsOf(fx);
    expect(events.filter((event) => event.type === 'world/perception')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'request/plan')).toHaveLength(1);

    const comparisons = await rederivePlans(events, fx.world);
    expect(comparisons).toHaveLength(1);
    const only = comparisons[0]!;
    expect(Buffer.from(canonicalBytes(only.rederived)).equals(Buffer.from(canonicalBytes(only.recorded))))
      .toBe(true);
    expect(only.source.seq).toBeGreaterThan(0);
  });

  it('fails reconstruction explicitly when the world cannot re-render the perception', async () => {
    const fx = await journalWithOneTurn();
    const events = await eventsOf(fx);
    const elsewhere = await WorldRepo.init(join(dirname(fx.home), 'elsewhere-world'));
    await expect(rederivePlans(events, elsewhere)).rejects.toThrow();
  });
});
