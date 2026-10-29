import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeDriver } from '../../driver.js';
import { C13_EVENT_TYPES } from '../../../context/events.js';
import { loadVerifiedEvents } from '../../../context/loader.js';
import type { VerifiedEvents } from '../../../context/loader.js';
import { defaultAgentConfig } from '../../../context/config.js';
import { createAgentRuntime } from '../../loop.js';
import type { AgentRuntime } from '../../loop.js';
import { ProviderAdapter } from '../../../provider/adapter.js';
import { systemProviderPolicy } from '../../../provider/policy.js';
import type { SerializedTransport, TransportFacts, TransportResult } from '../../../provider/transport.js';
import type { FunctionCall } from '../../../context/contracts.js';
import { useWorld } from '../../__tests__/helpers.js';
import type { WorldFixture } from '../../__tests__/helpers.js';
import { createPackageStore } from '../store.js';
import { createRunSupervisor } from '../supervisor.js';

/**
 * The Package lifecycle wiring (kernel.md, the sandbox and local-log
 * sections): the boot scan (re-verify, report corrupt, reap orphaned run
 * leaves, before the first turn), the host-stop disposal (the stop-phase
 * gate's package/stop fact), and the Vitest acceptance spine — the C2
 * criterion path in one test: define from a world file → run → funneled
 * call → result asserted → stop → close+reopen → re-mount verified →
 * re-run → park. Runs spawn under --no-sandbox with the committed echo
 * fixture only; every home is mkdtemp'd.
 */

const bootstrapSource = fileURLToPath(new URL('../run-bootstrap.ts', import.meta.url));
const ECHO_SOURCE = readFileSync(new URL('./fixtures/echo.js', import.meta.url), 'utf8');

const world = useWorld('c15-lifecycle-');

/** A transport whose script reads the live history — the ids are runtime facts. */
class SpineTransport implements SerializedTransport {
  readonly facts: TransportFacts = {
    url: 'https://test.invalid/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    credentialId: 'test',
  };
  readonly sends: Uint8Array[] = [];
  throwIfCalled = false;

  constructor(private readonly respond: (messages: readonly unknown[]) => TransportResult) {}

  async post(body: Uint8Array, _signal: AbortSignal, _maxBytes: number): Promise<TransportResult> {
    if (this.throwIfCalled) throw new Error('transport called offline');
    this.sends.push(body);
    const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as { messages?: unknown[] };
    return this.respond(parsed.messages ?? []);
  }
}

const callOf = (id: string, verb: string, args: Record<string, unknown>): FunctionCall => ({
  id, type: 'function',
  function: { name: 'extend', arguments: JSON.stringify({ verb, ...args }) },
});

const noCalls = (content: string): TransportResult => ({
  status: 200, headers: {}, complete: true, failure: null,
  body: Buffer.from(JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  })),
});

const calling = (calls: readonly FunctionCall[]): TransportResult => ({
  status: 200, headers: {}, complete: true, failure: null,
  body: Buffer.from(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
  })),
});

/** The last tool result content in a history, or null. */
function lastToolResult(messages: readonly unknown[]): string | null {
  let content: string | null = null;
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    if (role === 'tool') content = (message as { content: string }).content;
  }
  return content;
}

interface Spine {
  readonly fx: WorldFixture;
  readonly transport: SpineTransport;
  readonly runtime: AgentRuntime;
  driver: NodeDriver | null;
  /** Mutated by open(); the tests read it in finally. */
  open(): Promise<NodeDriver>;
  events(): Promise<VerifiedEvents>;
}

async function spineFor(
  fx: WorldFixture,
  respond: (messages: readonly unknown[]) => TransportResult,
): Promise<Spine> {
  const transport = new SpineTransport(respond);
  const frontier = await fx.frontier();
  const scratchDir = join(fx.home, 'tmp', 'n1');
  await import('node:fs').then((fs) => fs.promises.mkdir(scratchDir, { recursive: true }));
  const store = await createPackageStore({
    home: fx.home, uid: 'n1', worldDir: fx.world.path, scratchDir,
  });
  const runtime = createAgentRuntime({
    home: fx.home, uid: 'n1', world: fx.world, initialConfig: defaultAgentConfig(),
    terminal: { env: { PATH: '/usr/bin:/bin' } },
    adapter: new ProviderAdapter(transport, systemProviderPolicy, frontier.gate),
    extend: (events, ports) => ({
      store,
      supervisor: createRunSupervisor({
        home: fx.home, uid: 'n1', sandbox: false,
        shellTimeoutMs: 5_000, killGraceMs: 200,
        maxShellCaptureBytes: 16 * 1024 * 1024,
        now: () => Date.now(),
        schedule: (ms, callback) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
        terminal: ports.terminal, web: null,
        webAllowance: { search: true, fetch: true },
        events,
        bootstrapPath: bootstrapSource,
      }),
      sandbox: false,
    }),
  });
  const spine: Spine = {
    fx, transport, runtime, driver: null,
    async open(): Promise<NodeDriver> {
      const driver = await NodeDriver.open(
        fx.home, 'n1', runtime.handler, fx.world,
        { knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0 },
      );
      spine.driver = driver;
      return driver;
    },
    events: () => loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES),
  };
  return spine;
}

const ID_RE = /id ([0-9a-f]{64})/;

describe('package lifecycle: the Vitest acceptance spine (the C2 path)', () => {
  it('defines, runs, funnels, stops, survives a restart, re-runs, parks', async () => {
    const fx = world();
    // Session 1: define, run, funneled call, stop, park. The restart ends
    // the session BEFORE the re-run — the re-run is session 2's own turn.
    let packageId = '';
    let session = 1;
    const respond = (messages: readonly unknown[]): TransportResult => {
      const last = lastToolResult(messages);
      if (session === 1) {
        if (phase1 === 'define') {
          phase1 = 'run';
          return calling([callOf('c1', 'define', {
            name: 'echo_pkg', purpose: 'echo things', path: 'echo.js',
          })]);
        }
        if (phase1 === 'run') {
          const match = last !== null ? ID_RE.exec(last) : null;
          expect(match, `the define result carries the id: ${last}`).not.toBeNull();
          packageId = match![1] as string;
          phase1 = 'call';
          return calling([callOf('c2', 'run', { id: packageId })]);
        }
        if (phase1 === 'call') {
          phase1 = 'stop';
          return calling([callOf('c3', 'call', {
            tool: 'echo_text', args: { text: 'through the funnel' },
          })]);
        }
        if (phase1 === 'stop') {
          expect(last).toContain('through the funnel');
          phase1 = 'park';
          return calling([callOf('c4', 'stop', { id: packageId })]);
        }
        return noCalls('parking before the restart');
      }
      // Session 2: the definition survived the restart — re-run it, then park.
      if (phase2 === 'rerun') {
        phase2 = 'park';
        return calling([callOf('c5', 'run', { id: packageId })]);
      }
      return noCalls('done for now');
    };
    let phase1 = 'define';
    let phase2 = 'rerun';
    const first = await spineFor(fx, respond);
    let second: Spine | null = null;
    try {
      writeFileSync(join(fx.world.path, 'echo.js'), ECHO_SOURCE);
      let driver = await first.open();
      let running = driver.run();
      await vi.waitFor(() => expect(driver!.state).toBe('waiting'));
      driver.stop();
      await running;

      // --- the restart: a FRESH runtime, store and supervisor over the same
      // home — the honest process-restart shape — then the re-run. ---
      session = 2;
      second = await spineFor(fx, respond);
      driver = await second.open();
      running = driver.run();
      await vi.waitFor(() => expect(driver!.state).toBe('waiting'));
      driver.stop();
      await running;
      // The re-run was live at park: the host-stop disposed it.
      first.driver = null;

      const events = await first.events();
      const byType = (type: string): VerifiedEvents[number][] =>
        [...events].filter((event) => event.type === type);
      // The verb facts: define, run, effect, stop (verb) — and after the
      // restart the second run's facts.
      const defines = byType('package/define');
      expect(defines).toHaveLength(1);
      expect((defines[0]!.data as Record<string, unknown>)['name']).toBe('echo_pkg');
      const runs = byType('package/run');
      expect(runs).toHaveLength(2);
      expect((runs[0]!.data as Record<string, unknown>)['id']).toBe(packageId);
      expect((runs[1]!.data as Record<string, unknown>)['id']).toBe(packageId);
      // One effect fact per registration: the two runs each registered the tool.
      const effects = byType('package/effect');
      expect(effects).toHaveLength(2);
      expect(effects.every(
        (event) => (event.data as Record<string, unknown>)['tool'] === 'echo_text',
      )).toBe(true);
      // Two stops: the verb's (session 1) and the host's (the re-run was
      // live when the final driver stop landed).
      const stops = byType('package/stop');
      expect(stops).toHaveLength(2);
      expect((stops[0]!.data as Record<string, unknown>)['reason']).toBe('verb');
      expect((stops[1]!.data as Record<string, unknown>)['reason']).toBe('host-stop');
      // The funneled call's result is a durable tool/result with the echo.
      const results = [...events].filter((event) => event.type === 'tool/result');
      const funneled = results.find(
        (event) => (event.data as { message: { content: string } }).message.content.includes('through the funnel'),
      );
      expect(funneled).toBeDefined();
      expect((funneled!.data as { frontierCall: unknown }).frontierCall).toBeNull();
      // No crash facts anywhere: the lifecycle is clean.
      expect(byType('package/error')).toEqual([]);
    } finally {
      for (const s of [first, second]) {
        if (s !== null && s.driver !== null && s.driver.state !== 'stopped') {
          s.driver.stop();
          await s.driver.run().catch(() => {});
        }
      }
      rmSync(join(fx.home, '..'), { recursive: true, force: true });
    }
  }, 60_000);
});

describe('package lifecycle: the boot scan', () => {
  it('reaps orphaned run leaves before the first turn', async () => {
    const fx = world();
    mkdirSync(join(fx.home, 'nodes', 'n1', 'runs', 'e'.repeat(32)), { recursive: true });
    const spine = await spineFor(fx, () => noCalls('nothing to do'));
    try {
      const driver = await spine.open();
      const running = driver.run();
      await vi.waitFor(() => expect(driver.state).toBe('waiting'));
      driver.stop();
      await running;
      expect(() => readFileSync(join(fx.home, 'nodes', 'n1', 'runs'))).toThrow();
    } finally {
      if (spine.driver !== null && spine.driver.state !== 'stopped') {
        spine.driver.stop();
        await spine.driver.run().catch(() => {});
      }
      rmSync(join(fx.home, '..'), { recursive: true, force: true });
    }
  }, 30_000);

  it('deletes and reports a corrupted definition at boot', async () => {
    const fx = world();
    let phase = 'define';
    const spine = await spineFor(fx, () => {
      if (phase === 'define') {
        phase = 'park';
        return calling([callOf('c1', 'define', {
          name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
        })]);
      }
      return noCalls('done');
    });
    try {
      writeFileSync(join(fx.world.path, 'echo.js'), ECHO_SOURCE);
      let driver = await spine.open();
      let running = driver.run();
      await vi.waitFor(() => expect(driver!.state).toBe('waiting'));
      driver.stop();
      await running;

      // Corrupt the stored bytes behind the kernel's back.
      const events1 = await spine.events();
      const id = ([...events1]
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      writeFileSync(join(fx.home, 'nodes', 'n1', 'packages', id as string, 'package.js'), 'mutated\n');

      // The restart scans, deletes, reports.
      driver = await spine.open();
      running = driver.run();
      await vi.waitFor(() => expect(driver!.state).toBe('waiting'));
      driver.stop();
      await running;

      const events2 = await spine.events();
      const corrupt = [...events2].filter(
        (event) => event.type === 'package/error'
          && (event.data as Record<string, unknown>)['code'] === 'corrupt',
      );
      expect(corrupt).toHaveLength(1);
      expect((corrupt[0]!.data as Record<string, unknown>)['id']).toBe(id);
      expect(() => readFileSync(
        join(fx.home, 'nodes', 'n1', 'packages', id as string),
      )).toThrow();
    } finally {
      if (spine.driver !== null && spine.driver.state !== 'stopped') {
        spine.driver.stop();
        await spine.driver.run().catch(() => {});
      }
      rmSync(join(fx.home, '..'), { recursive: true, force: true });
    }
  }, 40_000);
});

describe('package lifecycle: the host stop', () => {
  it('disposes a live Run at driver stop and journals the host-stop fact', async () => {
    const fx = world();
    let phase = 'define';
    let packageId = '';
    const spine = await spineFor(fx, (messages) => {
      const last = lastToolResult(messages);
      if (phase === 'define') {
        phase = 'run';
        return calling([callOf('c1', 'define', {
          name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
        })]);
      }
      if (phase === 'run') {
        const match = last !== null ? ID_RE.exec(last) : null;
        if (match !== null) packageId = match[1] as string;
        phase = 'park';
        return calling([callOf('c2', 'run', { id: packageId })]);
      }
      return noCalls('done');
    });
    try {
      writeFileSync(join(fx.world.path, 'echo.js'), ECHO_SOURCE);
      const driver = await spine.open();
      const running = driver.run();
      await vi.waitFor(() => expect(driver.state).toBe('waiting'));
      // The Run is live: the stop disposes it and journals host-stop.
      driver.stop();
      await running;
      const events = await spine.events();
      const stops = [...events].filter((event) => event.type === 'package/stop');
      expect(stops).toHaveLength(1);
      expect((stops[0]!.data as Record<string, unknown>)['reason']).toBe('host-stop');
      expect((stops[0]!.data as Record<string, unknown>)['id']).toBe(packageId);
      // No crash fact: the kernel initiated this teardown.
      expect([...events].filter((event) => event.type === 'package/error')).toEqual([]);
    } finally {
      if (spine.driver !== null && spine.driver.state !== 'stopped') {
        spine.driver.stop();
        await spine.driver.run().catch(() => {});
      }
      rmSync(join(fx.home, '..'), { recursive: true, force: true });
    }
  }, 40_000);
});

describe('package lifecycle: the final-swarm corrections', () => {
  it('journals an idle Run crash that lands while the node is parked', async () => {
    const fx = world();
    let phase = 'define';
    let packageId = '';
    const spine = await spineFor(fx, (messages) => {
      const last = lastToolResult(messages);
      if (phase === 'define') {
        phase = 'run';
        return calling([callOf('c1', 'define', {
          name: 'selfkiller', purpose: 'dies on a timer', path: 'selfkiller.js',
        })]);
      }
      if (phase === 'run') {
        const match = last !== null ? ID_RE.exec(last) : null;
        expect(match, `id: ${last}`).not.toBeNull();
        packageId = match![1] as string;
        phase = 'park';
        return calling([callOf('c2', 'run', { id: packageId })]);
      }
      return noCalls('parked while the Run idles');
    });
    try {
      // The guest exits on its own timer, AFTER the node parks: the crash
      // fact arrives with no dispatch gate held.
      writeFileSync(join(fx.world.path, 'selfkiller.js'),
        'const fs = await import("node:fs");\n'
        + 'fs.writeFileSync("arming.txt", "1");\n'
        + 'setTimeout(() => process.exit(7), 250);\n'
        + 'return { tools: [{ name: "never_called",'
        + ' description: "dies first",'
        + ' parameters: { type: "object" },'
        + ' handler: async () => ({}) }] };\n');
      const driver = await spine.open();
      const running = driver.run();
      await vi.waitFor(() => expect(driver.state).toBe('waiting'));
      // Give the idle crash time to land while parked.
      await new Promise((resolve) => setTimeout(resolve, 900));
      driver.stop();
      await running;
      // The reopen uses the SAME runtime: the queued crash fact lives in
      // its package fact queue, and its ready phase flushes it.
      const driver2 = await spine.open();
      const running2 = driver2.run();
      await vi.waitFor(() => expect(driver2.state).toBe('waiting'));
      driver2.stop();
      await running2;
      const events = await spine.events();
      const crashed = [...events].filter(
        (event) => event.type === 'package/error'
          && (event.data as Record<string, unknown>)['code'] === 'crashed',
      );
      expect(crashed).toHaveLength(1);
      expect((crashed[0]!.data as Record<string, unknown>)['id']).toBe(packageId);
    } finally {
      rmSync(join(fx.home, '..'), { recursive: true, force: true });
    }
  }, 40_000);

  it('keeps a pre-C1.5 four-tool journal exactly as it was (no migration)', async () => {
    const fx = world();
    // Session 1 journals a FOUR-tool config (the pre-C1.5 shape).
    const oldConfig = { ...defaultAgentConfig() };
    oldConfig.tools = oldConfig.tools.filter((tool) => tool.name !== 'extend');
    oldConfig.allowedTools = oldConfig.allowedTools.filter((name) => name !== 'extend');
    const transport1 = new SpineTransport(() => noCalls('old cell parks'));
    const frontier = await fx.frontier();
    const runtime1 = createAgentRuntime({
      home: fx.home, uid: 'n1', world: fx.world, initialConfig: oldConfig,
      terminal: { env: { PATH: '/usr/bin:/bin' } },
      adapter: new ProviderAdapter(transport1, systemProviderPolicy, frontier.gate),
    });
    let driver = await NodeDriver.open(
      fx.home, 'n1', runtime1.handler, fx.world,
      { knownTypes: C13_EVENT_TYPES, hooks: runtime1.hooks, worldPollMs: 0 },
    );
    let running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

    // Session 2 boots with the DEFAULT (five-tool) factory config: the
    // journaled four-tool config wins — extend is not offered.
    let attempted = false;
    const transport2 = new SpineTransport(() => {
      if (!attempted) {
        attempted = true;
        return calling([callOf('c1', 'extend', { verb: 'inspect' })]);
      }
      return noCalls('done');
    });
    const runtime2 = createAgentRuntime({
      home: fx.home, uid: 'n1', world: fx.world, initialConfig: defaultAgentConfig(),
      terminal: { env: { PATH: '/usr/bin:/bin' } },
      adapter: new ProviderAdapter(transport2, systemProviderPolicy, frontier.gate),
    });
    driver = await NodeDriver.open(
      fx.home, 'n1', runtime2.handler, fx.world,
      { knownTypes: C13_EVENT_TYPES, hooks: runtime2.hooks, worldPollMs: 0 },
    );
    running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

    const events = await loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
    // No config rewrite: exactly one system/message, the four-tool journal.
    const configs = [...events].filter((event) => event.type === 'system/message');
    expect(configs).toHaveLength(1);
    // The extend attempt closed unknown-tool — the old cell's exact behavior.
    const refused = [...events].filter((event) => event.type === 'tool/result')
      .map((event) => (event.data as { failure: { code: string } | null }).failure);
    expect(refused.some((failure) => failure !== null && failure.code === 'unknown-tool'))
      .toBe(true);
    // No migration: no package fact exists.
    expect([...events].some((event) => event.type.startsWith('package/'))).toBe(false);
  }, 40_000);
});
