import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../../context/events.js';
import { canonicalizeJson } from '../../journal/index.js';
import { sha256HexOf } from '../../journal/index.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import type { VerifiedEvents } from '../../context/loader.js';
import { defaultAgentConfig } from '../../context/config.js';
import { createBoundaryGate } from '../gate.js';
import type { BoundaryGate, GateCallbacks, GateScope } from '../gate.js';
import { dispatchCalls } from '../tools/dispatch.js';
import { createPackageStore } from '../packages/store.js';
import type { PackageStore } from '../packages/store.js';
import { createRunSupervisor } from '../packages/supervisor.js';
import type { RunSupervisor, RunSupervisorEvents } from '../packages/supervisor.js';
import type {
  AgentConfig, AssistantProjection, FunctionCall, RequestId, Source,
} from '../../context/contracts.js';

/**
 * The extend tool and its funnel (kernel.md, the sandbox and local-log
 * sections): six verbs, the append homes of the verb facts, the kernel-side
 * schema validation at the funnel, the frozen-offering invariant (the
 * toolsHash never moves across a full package lifecycle), and the honest
 * inspect catalogue. Real spawns under --no-sandbox with committed in-repo
 * fixture sources only; every home is mkdtemp'd.
 */

const bootstrapSource = fileURLToPath(new URL('../packages/run-bootstrap.ts', import.meta.url));

type Session = {
  readonly home: string;
  readonly world: string;
  readonly store: PackageStore;
  readonly supervisor: RunSupervisor;
  readonly gate: (phase: 'ready' | 'turn', turn: number | null) => BoundaryGate;
  readonly packageGate: (gate: BoundaryGate | null) => void;
  readonly shutdown: () => Promise<void>;
};

async function openSession(): Promise<Session> {
  const home = mkdtempSync(join(tmpdir(), 'es-extend-'));
  const world = join(home, 'world');
  const scratch = join(home, 'tmp', 'n1');
  await import('node:fs').then((fs) => fs.promises.mkdir(world, { recursive: true }));
  await import('node:fs').then((fs) => fs.promises.mkdir(scratch, { recursive: true }));
  const writer = await JournalWriter.open(home, 'n1');
  const controller = new AbortController();
  const receipts = new Map<string, EventEnvelope>();
  const record = (receipt: EventEnvelope): EventEnvelope => {
    receipts.set(`${receipt.seq}:${receipt.hash}`, receipt);
    return receipt;
  };
  const lookup = (source: Source): EventEnvelope | null =>
    receipts.get(`${source.seq}:${source.hash}`) ?? null;
  const callbacks: GateCallbacks = {
    append: (type: string, data: JsonValue, opts) =>
      record(writer.append(type, data as never, opts)),
    flush: () => writer.flush(),
    lookup,
    readBlob: async () => new Uint8Array(),
    now: () => 100,
  };
  const closes: Array<() => void> = [];
  const gate = (phase: 'ready' | 'turn', turn: number | null): BoundaryGate => {
    const scope: GateScope = { phase, turn, signal: controller.signal, lookup };
    const created = createBoundaryGate(createBoundaryRegistry(), scope, callbacks);
    closes.push(created.close);
    return created.gate;
  };
  // The events router the loop owns: the supervisor's facts append to
  // whichever gate the current dispatch holds.
  let packageGate: BoundaryGate | null = null;
  const events: RunSupervisorEvents = {
    effect: (payload) => {
      packageGate?.append('package/effect', payload);
    },
    error: (payload) => {
      packageGate?.append('package/error', payload);
    },
    service: (payload) => {
      packageGate?.append('package/service', payload);
    },
  };
  const store = await createPackageStore({ home, uid: 'n1', worldDir: world, scratchDir: scratch });
  const supervisor = createRunSupervisor({
    home, uid: 'n1', sandbox: false,
    shellTimeoutMs: 5_000, killGraceMs: 200,
    maxShellCaptureBytes: 16 * 1024 * 1024,
    now: () => 0, schedule: (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    terminal: null, web: null,
      webAllowance: { search: true, fetch: true },
    events,
    bootstrapPath: bootstrapSource,
  });
  const shutdown = async (): Promise<void> => {
    if (supervisor.liveRunId() !== null) await supervisor.stopRun();
    for (const close of closes) close();
    try { await writer.close(); } catch { /* the assertion stands */ }
    controller.abort();
    rmSync(home, { recursive: true, force: true });
  };
  return {
    home, world, store, supervisor, gate,
    packageGate: (next) => { packageGate = next; },
    shutdown,
  };
}

const events = (home: string): Promise<VerifiedEvents> =>
  loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);

const ID: RequestId = { turn: 0, ordinal: 0 };

function call(id: string, name: string, args: JsonValue): FunctionCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function projection(calls: FunctionCall[]): AssistantProjection {
  return {
    message: { role: 'assistant', content: null, tool_calls: calls },
    contentTruncated: false, frontierCall: 'call-1',
  };
}

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultAgentConfig(), ...over };
}

interface Dispatched {
  readonly results: { callId: string; content: string; isError: boolean }[];
  readonly rawEvents: VerifiedEvents;
}

async function extendCall(
  s: Session, args: JsonValue, over: Partial<AgentConfig> = {},
): Promise<Dispatched> {
  const gate = s.gate('turn', 0);
  s.packageGate(gate);
  try {
    await dispatchCalls(
      projection([call('c1', 'extend', args)]), ID, gate, config(over),
      { run: async () => { throw new Error('not used'); } },
      undefined,
      { store: s.store, supervisor: s.supervisor, sandbox: false },
    );
  } finally {
    s.packageGate(null);
  }
  const list = await events(s.home);
  // The session journal accumulates every call's results; this dispatch's
  // own result is the LAST one.
  const all = ([...list] as EventEnvelope[])
    .filter((event) => event.type === 'tool/result');
  const last = all[all.length - 1];
  const data = last?.data as Record<string, unknown> | undefined;
  const message = data?.['message'] as { content: string } | undefined;
  const results = last !== undefined && message !== undefined
    ? [{ callId: data!['callId'] as string, content: message.content, isError: data!['isError'] as boolean }]
    : [];
  return { results, rawEvents: list };
}

const ECHO_SOURCE = readFileSync(new URL(
  '../packages/__tests__/fixtures/echo.js', import.meta.url,
), 'utf8');
// The strict optional-schema funnel fixture: pattern required, glob optional.
const OPTIONAL_SOURCE = 'return { tools: [{ name: "grep_world",'
  + ' description: "search the world files",'
  + ' parameters: { type: "object",'
  + ' properties: { pattern: { type: "string", minLength: 1 },'
  + ' glob: { type: "string" } }, required: ["pattern"],'
  + ' additionalProperties: false },'
  + ' handler: async (args) => ({ matches: args.pattern }) }] };\n';

describe('extend: the six verbs', () => {
  it('inspects with the honest catalogue', async () => {
    const s = await openSession();
    try {
      const { results } = await extendCall(s, { verb: 'inspect' });
      expect(results).toHaveLength(1);
      const content = results[0]!.content;
      // The base section names every offered tool, extend included.
      for (const tool of ['execute', 'wait', 'web_search', 'web_fetch', 'extend']) {
        expect(content).toContain(tool);
      }
      // The kernel-owned section: visible, never mounted.
      expect(content).toContain('spawn');
      expect(content).toContain('speak');
      // Runtime honesty: the sandbox mode and the input cap.
      expect(content).toMatch(/sandbox/i);
      expect(content).toContain('256 KiB');
      expect(results[0]!.isError).toBe(false);
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('defines a package from a world file and journals the fact', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const { results, rawEvents } = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo things', path: 'echo.js',
      });
      expect(results[0]!.isError).toBe(false);
      expect(results[0]!.content).toMatch(/defined echo_pkg/);
      const defines = rawEvents.filter((event) => event.type === 'package/define');
      expect(defines).toHaveLength(1);
      const data = defines[0]!.data as Record<string, unknown>;
      expect(data['name']).toBe('echo_pkg');
      expect(data['purpose']).toBe('echo things');
      expect(data['sourceBytes']).toBe(Buffer.byteLength(ECHO_SOURCE));
      expect(data['id']).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('runs a stored package and returns the declared surface', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo things', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      const { results, rawEvents } = await extendCall(s, { verb: 'run', id: id as string });
      expect(results[0]!.isError).toBe(false);
      // The announcement: names, descriptions, full schemas.
      expect(results[0]!.content).toContain('echo_text');
      expect(results[0]!.content).toContain('echoes the text');
      expect(results[0]!.content).toContain('text');
      const runs = rawEvents.filter((event) => event.type === 'package/run');
      expect(runs).toHaveLength(1);
      expect((runs[0]!.data as Record<string, unknown>)['id']).toBe(id);
      expect((runs[0]!.data as Record<string, unknown>)['sandbox']).toBe('off');
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('funnels a same-turn call to the fresh tool (the run→call loop)', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      const { results } = await extendCall(s, {
        verb: 'call', tool: 'echo_text', args: { text: 'via the funnel' },
      });
      expect(results[0]!.isError).toBe(false);
      expect(results[0]!.content).toContain('via the funnel');

      // Stop, then re-run: the funnel answer after the stop.
      await extendCall(s, { verb: 'stop', id: id as string });
      const dead = await extendCall(s, {
        verb: 'call', tool: 'echo_text', args: { text: 'x' },
      });
      expect(dead.results[0]!.content).toMatch(/tool-not-found/);
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('stops a run and journals the verb fact', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      const { rawEvents } = await extendCall(s, { verb: 'stop', id: id as string });
      const stops = rawEvents.filter((event) => event.type === 'package/stop');
      expect(stops).toHaveLength(1);
      const data = stops[0]!.data as Record<string, unknown>;
      expect(data['id']).toBe(id);
      expect(data['reason']).toBe('verb');
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('undefines a stopped package and refuses while a run is live', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      const live = await extendCall(s, { verb: 'undefine', id: id as string });
      expect(live.results[0]!.isError).toBe(true);
      expect(live.results[0]!.content).toMatch(/stop/i);

      await extendCall(s, { verb: 'stop', id: id as string });
      const gone = await extendCall(s, { verb: 'undefine', id: id as string });
      expect(gone.results[0]!.isError).toBe(false);
      const undefines = gone.rawEvents.filter((event) => event.type === 'package/undefine');
      expect(undefines).toHaveLength(1);
      expect((undefines[0]!.data as Record<string, unknown>)['id']).toBe(id);
    } finally {
      await s.shutdown();
    }
  }, 30_000);
});

describe('extend: refusals and the funnel boundary', () => {
  it('refuses an unknown verb and every malformed shape as invalid-tool', async () => {
    const s = await openSession();
    try {
      const cases: JsonValue[] = [
        {}, { verb: 'nope' },
        { verb: 'define', name: 'n' },
        { verb: 'define', name: 'n', purpose: 'p', path: 'x', extra: 1 },
        { verb: 'run' },
        { verb: 'run', id: 'x', tool: 'y' },
        { verb: 'call', tool: 't' },
        { verb: 'call', tool: 't', args: 'not an object' },
        { verb: 'stop' },
        { verb: 'undefine', id: 'x', name: 'y' },
        { verb: 'inspect', extra: true },
      ];
      for (const args of cases) {
        const { results } = await extendCall(s, args);
        expect(results[0]!.isError, JSON.stringify(args)).toBe(true);
        expect(results[0]!.content, JSON.stringify(args)).toMatch(/invalid-tool/);
      }
      // A well-formed funnel call to an unregistered name is NOT a shape
      // error: the funnel's own refusal names it.
      const unregistered = await extendCall(s, {
        verb: 'call', tool: 't', args: {},
      });
      expect(unregistered.results[0]!.content).toMatch(/tool-not-found/);
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('resolves denied when extend is not allowed', async () => {
    const s = await openSession();
    try {
      const { results } = await extendCall(s, { verb: 'inspect' }, {
        allowedTools: ['execute', 'wait', 'web_search', 'web_fetch'],
      });
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content).toMatch(/denied/);
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('refuses a degenerate run/undefine/stop as package/not-found', async () => {
    const s = await openSession();
    try {
      for (const args of [
        { verb: 'run', id: 'f'.repeat(64) },
        { verb: 'undefine', id: 'f'.repeat(64) },
        { verb: 'stop', id: 'f'.repeat(64) },
      ]) {
        const { results } = await extendCall(s, args);
        expect(results[0]!.isError, JSON.stringify(args)).toBe(true);
        expect(results[0]!.content, JSON.stringify(args)).toMatch(/package\/not-found/);
      }
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('validates funneled args against the registered schema (tool/invalid-args)', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      const cases: JsonValue[] = [
        { verb: 'call', tool: 'echo_text', args: {} },
        { verb: 'call', tool: 'echo_text', args: { text: '' } },
        { verb: 'call', tool: 'echo_text', args: { text: 'ok', extra: 1 } },
      ];
      for (const args of cases) {
        const { results } = await extendCall(s, args);
        expect(results[0]!.isError, JSON.stringify(args)).toBe(true);
        expect(results[0]!.content, JSON.stringify(args)).toMatch(/tool\/invalid-args/);
      }
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('hints the funnel when a registered name is attempted natively', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      const gate = s.gate('turn', 0);
      s.packageGate(gate);
      try {
        await dispatchCalls(
          projection([call('c1', 'echo_text', {})]), ID, gate, config(),
          { run: async () => { throw new Error('not used'); } },
          undefined,
          { store: s.store, supervisor: s.supervisor, sandbox: false },
        );
      } finally {
        s.packageGate(null);
      }
      const list = await events(s.home);
      const result = list
        .filter((event) => event.type === 'tool/result')
        .map((event) => (event.data as { message: { content: string } }).message.content);
      expect(result[result.length - 1]).toMatch(/unknown-tool/);
      expect(result[result.length - 1]).toMatch(/extend/);
      expect(result[result.length - 1]).toMatch(/echo_text/);
    } finally {
      await s.shutdown();
    }
  }, 30_000);
});

describe('extend: the frozen offering', () => {
  it('joins the default offering at the factory (the golden default grows)', () => {
    const configDefault = defaultAgentConfig();
    expect(configDefault.tools.map((tool) => tool.name)).toContain('extend');
    expect(configDefault.allowedTools).toContain('extend');
  });
});

describe('extend: the audit corrections', () => {
  it('funnels omitted optional args as legal (the worked example is callable)', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'optional.js'), OPTIONAL_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'grep_world', purpose: 'grep', path: 'optional.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      const { results } = await extendCall(s, {
        verb: 'call', tool: 'grep_world', args: { pattern: 'needle' },
      });
      expect(results[0]!.isError).toBe(false);
      expect(results[0]!.content).toContain('needle');
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('refuses inherited argument names under additionalProperties:false', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      const { results } = await extendCall(s, {
        // "constructor" is not a declared property — hasOwn, not `in`.
        verb: 'call', tool: 'echo_text', args: { text: 'x', constructor: 'y' } as never,
      });
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content).toMatch(/tool\/invalid-args/);
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('keeps the offering byte-identical across the full lifecycle (the frozen invariant)', async () => {
    const s = await openSession();
    try {
      const offeringHash = (c: AgentConfig): string => {
        const sorted = [...c.tools].sort((a, b) => (a.name < b.name ? -1 : 1));
        return sha256HexOf(Buffer.from(canonicalizeJson(sorted as never), 'utf8'));
      };
      const before = offeringHash(config());
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      await extendCall(s, { verb: 'call', tool: 'echo_text', args: { text: 'x' } });
      await extendCall(s, { verb: 'stop', id: id as string });
      await extendCall(s, { verb: 'run', id: id as string });
      await extendCall(s, { verb: 'stop', id: id as string });
      expect(offeringHash(config())).toBe(before);
    } finally {
      await s.shutdown();
    }
  }, 40_000);

  it('maps a name-conflicting run to run/name-conflict and lands nothing', async () => {
    const s = await openSession();
    try {
      const conflict = 'return { tools: [{ name: "execute",'
        + ' description: "collides with the base shell",'
        + ' parameters: { type: "object" }, handler: async () => ({}) }] };\n';
      writeFileSync(join(s.world, 'conflict.js'), conflict);
      const defined = await extendCall(s, {
        verb: 'define', name: 'conflict_pkg', purpose: 'collide', path: 'conflict.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      const { results, rawEvents } = await extendCall(s, { verb: 'run', id: id as string });
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content).toMatch(/run\/name-conflict/);
      expect(results[0]!.content).toContain('execute');
      // The refusal landed nothing: no package/run fact, no registered tool.
      expect(rawEvents.some((event) => event.type === 'package/run')).toBe(false);
      expect(s.supervisor.registry.tools()).toEqual([]);
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('appends no verb fact on a refused define', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.home, 'outside.js'), ECHO_SOURCE);
      const { rawEvents } = await extendCall(s, {
        verb: 'define', name: 'escape', purpose: 'x', path: join(s.home, 'outside.js'),
      });
      expect(rawEvents.some((event) => event.type === 'package/define')).toBe(false);
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('resolves denied when no extend port is threaded', async () => {
    const s = await openSession();
    try {
      const gate = s.gate('turn', 0);
      s.packageGate(gate);
      try {
        await dispatchCalls(
          projection([call('c1', 'extend', { verb: 'inspect' })]), ID, gate, config(),
          { run: async () => { throw new Error('not used'); } },
        );
      } finally {
        s.packageGate(null);
      }
      const list = await events(s.home);
      const last = [...list].filter((event) => event.type === 'tool/result').pop()!;
      expect((last.data as { message: { content: string } }).message.content)
        .toMatch(/denied/);
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('refuses a malformed run id without touching the filesystem', async () => {
    const s = await openSession();
    try {
      const { results } = await extendCall(s, { verb: 'run', id: 'not-an-id' });
      expect(results[0]!.content).toMatch(/package\/not-found/);
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('raw-captures a funneled result like a base result', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });
      await extendCall(s, { verb: 'call', tool: 'echo_text', args: { text: 'captured' } });
      const list = await events(s.home);
      const last = [...list].filter((event) => event.type === 'tool/result').pop()!;
      const data = last.data as { raw: unknown; frontierCall: unknown };
      expect(data.raw).not.toBeNull();
      expect((data.raw as { kind: string }).kind).toBe('c13-artifact');
      expect(data.frontierCall).toBeNull();
    } finally {
      await s.shutdown();
    }
  }, 30_000);
});


describe('extend: the convergence-round regressions', () => {
  it('settles an aborted funneled invoke as the synthetic cancelled closer', async () => {
    const s = await openSession();
    try {
      writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
      const defined = await extendCall(s, {
        verb: 'define', name: 'echo_pkg', purpose: 'echo', path: 'echo.js',
      });
      const id = (defined.rawEvents
        .find((event) => event.type === 'package/define')!.data as Record<string, unknown>)['id'];
      await extendCall(s, { verb: 'run', id: id as string });

      // An already-aborted gate signal: the invoke settles cancelled at
      // entry, the synthetic cancelled closer is the durable result.
      const gate = s.gate('turn', 1);
      const controller = new AbortController();
      controller.abort();
      // The gate carries the aborted signal through a fresh scope.
      const abortedGate = {
        append: gate.append.bind(gate),
        flush: gate.flush.bind(gate),
        capture: gate.capture.bind(gate),
        store: gate.store.bind(gate),
        signal: controller.signal,
      } as unknown as typeof gate;
      s.packageGate(abortedGate);
      try {
        await dispatchCalls(
          projection([call('c1', 'extend', {
            verb: 'call', tool: 'echo_text', args: { text: 'never lands' },
          })]),
          { turn: 1, ordinal: 0 }, abortedGate, config(),
          { run: async () => { throw new Error('not used'); } },
          undefined,
          { store: s.store, supervisor: s.supervisor, sandbox: false },
        );
      } finally {
        s.packageGate(null);
      }
      const list = await events(s.home);
      const last = [...list].filter((event) => event.type === 'tool/result').pop()!;
      const data = last.data as { message: { content: string }; failure: { code: string } | null; synthetic: boolean };
      expect(data.message.content).toBe('cancelled');
      expect(data.failure).toEqual({ code: 'cancelled', status: null });
      expect(data.synthetic).toBe(true);
    } finally {
      await s.shutdown();
    }
  }, 30_000);
});

// The second committed source for the same package name: the same strict
// authoring shape, a different tool name — the version discriminator the
// name-addressing tests assert on (v1 registers echo_text, v2 shout_text).
const SHOUT_SOURCE = 'return {\n'
  + '  tools: [{\n'
  + '    name: \'shout_text\',\n'
  + '    description: \'shouts the text\',\n'
  + '    parameters: {\n'
  + '      type: \'object\',\n'
  + '      properties: { text: { type: \'string\', minLength: 1 } },\n'
  + '      required: [\'text\'],\n'
  + '      additionalProperties: false,\n'
  + '    },\n'
  + '    handler: async (args) => ({ shouted: args.text.toUpperCase() }),\n'
  + '  }],\n'
  + '};\n';

describe('extend: packages addressable by name (C1.6 L1)', () => {
  // Defines two versions of one name and pins their directory mtimes: the
  // latest-wins resolution must not depend on millisecond scheduling.
  async function defineTwoVersions(
    s: Session,
  ): Promise<{ v1: string; v2: string }> {
    const { utimesSync } = await import('node:fs');
    writeFileSync(join(s.world, 'echo.js'), ECHO_SOURCE);
    writeFileSync(join(s.world, 'shout.js'), SHOUT_SOURCE);
    const first = await extendCall(s, {
      verb: 'define', name: 'echo_pkg', purpose: 'v1', path: 'echo.js',
    });
    const v1 = ([...first.rawEvents]
      .filter((event) => event.type === 'package/define')
      .pop()!.data as Record<string, unknown>)['id'] as string;
    const second = await extendCall(s, {
      verb: 'define', name: 'echo_pkg', purpose: 'v2', path: 'shout.js',
    });
    const v2 = ([...second.rawEvents]
      .filter((event) => event.type === 'package/define')
      .pop()!.data as Record<string, unknown>)['id'] as string;
    // Pin the define order on the filesystem: v2 is the later definition.
    const packagesDir = join(s.home, 'nodes', 'n1', 'packages');
    utimesSync(join(packagesDir, v1), new Date(1_000), new Date(1_000));
    utimesSync(join(packagesDir, v2), new Date(2_000), new Date(2_000));
    return { v1, v2 };
  }

  it('runs a package by name — the latest stored version, with its id taught', async () => {
    const s = await openSession();
    try {
      const { v2 } = await defineTwoVersions(s);
      const { results, rawEvents } = await extendCall(s, { verb: 'run', name: 'echo_pkg' });
      expect(results[0]!.isError).toBe(false);
      // The announcement is v2's surface: shout_text, not echo_text.
      expect(results[0]!.content).toContain('shout_text');
      expect(results[0]!.content).not.toContain('echo_text');
      // The resolved id is taught in the result and journaled in the fact.
      expect(results[0]!.content).toContain(v2);
      const runs = rawEvents.filter((event) => event.type === 'package/run');
      expect(runs).toHaveLength(1);
      expect((runs[0]!.data as Record<string, unknown>)['id']).toBe(v2);
      await extendCall(s, { verb: 'stop', id: v2 });
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('stops the live Run by name and journals the verb fact', async () => {
    const s = await openSession();
    try {
      const { v2 } = await defineTwoVersions(s);
      await extendCall(s, { verb: 'run', name: 'echo_pkg' });
      const { results, rawEvents } = await extendCall(s, { verb: 'stop', name: 'echo_pkg' });
      expect(results[0]!.isError).toBe(false);
      expect(results[0]!.content).toContain('stopped');
      const stops = rawEvents.filter((event) => event.type === 'package/stop');
      const last = stops[stops.length - 1]!;
      expect((last.data as Record<string, unknown>)['id']).toBe(v2);
      expect((last.data as Record<string, unknown>)['reason']).toBe('verb');
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('refuses a stop by name that is not the live Run, naming the live package', async () => {
    const s = await openSession();
    try {
      await defineTwoVersions(s);
      writeFileSync(join(s.world, 'other.js'), ECHO_SOURCE);
      const other = await extendCall(s, {
        verb: 'define', name: 'other_pkg', purpose: 'stored, not running', path: 'other.js',
      });
      expect(other.results[0]!.isError).toBe(false);
      await extendCall(s, { verb: 'run', name: 'echo_pkg' });
      const { results } = await extendCall(s, { verb: 'stop', name: 'other_pkg' });
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content).toMatch(/package\/not-found/);
      // The honest refusal names the package the live Run actually belongs to.
      expect(results[0]!.content).toContain('echo_pkg');
      await extendCall(s, { verb: 'stop', name: 'echo_pkg' });
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('undefines the latest version by name and falls back to the previous one', async () => {
    const s = await openSession();
    try {
      const { v2 } = await defineTwoVersions(s);
      const { results } = await extendCall(s, { verb: 'undefine', name: 'echo_pkg' });
      expect(results[0]!.isError).toBe(false);
      expect(results[0]!.content).toContain(v2);
      // The latest version is gone; the name now resolves to v1.
      expect(await s.store.readPackageSource(v2)).toBeNull();
      const { results: rerun } = await extendCall(s, { verb: 'run', name: 'echo_pkg' });
      expect(rerun[0]!.isError).toBe(false);
      expect(rerun[0]!.content).toContain('echo_text');
      await extendCall(s, { verb: 'stop', name: 'echo_pkg' });
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('refuses an unknown name with the honest not-found wording', async () => {
    const s = await openSession();
    try {
      // run and undefine address the store: the refusal names the name.
      for (const args of [{ verb: 'run', name: 'ghost' }, { verb: 'undefine', name: 'ghost' }]) {
        const { results } = await extendCall(s, args);
        expect(results[0]!.isError, JSON.stringify(args)).toBe(true);
        expect(results[0]!.content, JSON.stringify(args)).toMatch(/package\/not-found/);
        expect(results[0]!.content, JSON.stringify(args)).toContain('no stored package has that name');
      }
      // stop addresses the live Run: the refusal says nothing is live.
      const stopped = await extendCall(s, { verb: 'stop', name: 'ghost' });
      expect(stopped.results[0]!.isError).toBe(true);
      expect(stopped.results[0]!.content).toMatch(/package\/not-found/);
      expect(stopped.results[0]!.content).toContain('no Run is live');
    } finally {
      await s.shutdown();
    }
  }, 20_000);

  it('refuses a stop by id that is not the live Run, naming the live package', async () => {
    const s = await openSession();
    try {
      const { v1, v2 } = await defineTwoVersions(s);
      await extendCall(s, { verb: 'run', id: v1 });
      const { results } = await extendCall(s, { verb: 'stop', id: v2 });
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content).toMatch(/package\/not-found/);
      // The honest refusal names the package the live Run actually belongs to.
      expect(results[0]!.content).toContain('echo_pkg');
      expect(results[0]!.content).toContain(v1);
      await extendCall(s, { verb: 'stop', name: 'echo_pkg' });
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('stops the live Run under a version skew (run v1, define v2, stop by name)', async () => {
    const s = await openSession();
    try {
      const { v1 } = await defineTwoVersions(s);
      // The live Run is v1 (started by id); v2 is newer but not running.
      await extendCall(s, { verb: 'run', id: v1 });
      const { results, rawEvents } = await extendCall(s, { verb: 'stop', name: 'echo_pkg' });
      expect(results[0]!.isError).toBe(false);
      // The name matched the LIVE Run's package: v1 stops, not v2.
      const stops = rawEvents.filter((event) => event.type === 'package/stop');
      const last = stops[stops.length - 1]!;
      expect((last.data as Record<string, unknown>)['id']).toBe(v1);
      expect((last.data as Record<string, unknown>)['reason']).toBe('verb');
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('undefines the latest version by name while an older same-name version runs', async () => {
    const s = await openSession();
    try {
      const { v1, v2 } = await defineTwoVersions(s);
      await extendCall(s, { verb: 'run', id: v1 });
      const { results } = await extendCall(s, { verb: 'undefine', name: 'echo_pkg' });
      expect(results[0]!.isError).toBe(false);
      // The destructive act landed on the latest version, not the live older one.
      expect(results[0]!.content).toContain(v2);
      expect(await s.store.readPackageSource(v2)).toBeNull();
      expect(await s.store.readPackageSource(v1)).not.toBeNull();
      // The live older version is still stoppable by name.
      const stopped = await extendCall(s, { verb: 'stop', name: 'echo_pkg' });
      expect(stopped.results[0]!.isError).toBe(false);
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('refuses an undefine by name whose newest version is corrupt, teaching the id', async () => {
    const s = await openSession();
    try {
      const { v1, v2 } = await defineTwoVersions(s);
      // Corrupt the newest version in place: the identity no longer verifies.
      const manifestPath = join(s.home, 'nodes', 'n1', 'packages', v2, 'manifest.json');
      writeFileSync(manifestPath, '{"name":"echo_pkg","purpose":"forged"}');
      const { results } = await extendCall(s, { verb: 'undefine', name: 'echo_pkg' });
      expect(results[0]!.isError).toBe(true);
      expect(results[0]!.content).toMatch(/undefine\/corrupt/);
      // The refusal teaches the exact id of the corrupt newest version.
      expect(results[0]!.content).toContain(v2);
      // The healthy older version was NOT the destructive target.
      expect(await s.store.readPackageSource(v1)).not.toBeNull();
      // The taught escape hatch works: by-id undefine is existence-only.
      const escaped = await extendCall(s, { verb: 'undefine', id: v2 });
      expect(escaped.results[0]!.isError).toBe(false);
      expect(await s.store.readPackageSource(v2)).toBeNull();
    } finally {
      await s.shutdown();
    }
  }, 30_000);

  it('refuses a malformed reference with a detail naming the rule', async () => {
    const s = await openSession();
    try {
      // A wrong key SET names the rule: extra keys, both keys, neither key.
      const cases: JsonValue[] = [
        { verb: 'run' },
        { verb: 'run', name: 'x', id: 'y' },
        { verb: 'run', name: 'x', tool: 'y' },
        { verb: 'stop' },
        { verb: 'stop', name: 'x', id: 'y' },
        { verb: 'undefine' },
        { verb: 'undefine', name: 'x', id: 'y' },
        { verb: 'run', id: 'x', name: 'y' },
      ];
      for (const args of cases) {
        const { results } = await extendCall(s, args);
        expect(results[0]!.isError, JSON.stringify(args)).toBe(true);
        expect(results[0]!.content, JSON.stringify(args)).toMatch(/invalid-tool/);
        expect(results[0]!.content, JSON.stringify(args))
          .toMatch(/takes exactly one of name or id/);
      }
      // A right key set with a wrong-typed value stays bare: the model sent
      // exactly one reference — the rule is not what it broke.
      const mistyped = await extendCall(s, { verb: 'run', name: 3 });
      expect(mistyped.results[0]!.isError).toBe(true);
      expect(mistyped.results[0]!.content).toMatch(/invalid-tool/);
      expect(mistyped.results[0]!.content).not.toMatch(/takes exactly one of/);
    } finally {
      await s.shutdown();
    }
  }, 20_000);
});
