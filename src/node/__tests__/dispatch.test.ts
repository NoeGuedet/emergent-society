import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { createBoundaryRegistry, C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import type { VerifiedEvents } from '../../context/loader.js';
import { resolveArtifact } from '../../context/artifacts.js';
import { defaultAgentConfig } from '../../context/config.js';
import { createBoundaryGate } from '../gate.js';
import type { BoundaryGate, GateCallbacks, GateScope } from '../gate.js';
import { dispatchCalls } from '../tools/dispatch.js';
import { DEFAULT_TERMINAL_ENV, PtyTerminalRuntime } from '../tools/terminal.js';
import type { CommandLimits, CommandOutcome, TerminalPort } from '../tools/terminal.js';
import type { WebOutcome, WebTools } from '../tools/web.js';
import { useWorld } from './helpers.js';
import type {
  AgentConfig, ArtifactRef, AssistantProjection, FunctionCall, RequestId, Source,
} from '../../context/contracts.js';

/**
 * Dispatch tests (T7): exact tool-name recognition, argument validation, the
 * durable tool/call + tool/result facts, wait semantics, the abort race, and
 * durability faults. Real shell effects are asserted on the world's files.
 */

const world = useWorld('c13-dispatch-');

type Session = {
  readonly gate: (phase: 'ready' | 'turn', turn: number | null) => BoundaryGate;
  readonly controller: AbortController;
  readonly shutdown: () => Promise<void>;
};

async function openSession(home: string): Promise<Session> {
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
    append: (type: string, data: JsonValue) => record(writer.append(type, data)),
    flush: () => writer.flush(),
    lookup,
    readBlob: (hash: string) => new BlobStore(home).get(hash),
    now: () => 100,
  };
  const closes: Array<() => void> = [];
  const gate = (phase: 'ready' | 'turn', turn: number | null): BoundaryGate => {
    const scope: GateScope = { phase, turn, signal: controller.signal, lookup };
    const created = createBoundaryGate(createBoundaryRegistry(), scope, callbacks);
    closes.push(created.close);
    return created.gate;
  };
  const shutdown = async (): Promise<void> => {
    for (const close of closes) close();
    try { await writer.close(); } catch { /* the assertion stands */ }
    controller.abort();
  };
  return { gate, controller, shutdown };
}

const events = (home: string): Promise<VerifiedEvents> =>
  loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);

function ofType(list: VerifiedEvents, type: string): EventEnvelope[] {
  return list.filter((event) => event.type === type);
}

const ID: RequestId = { turn: 0, ordinal: 0 };

function call(id: string, name: string, args: string): FunctionCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function projection(calls: FunctionCall[]): AssistantProjection {
  return {
    message: { role: 'assistant', content: null, tool_calls: calls },
    contentTruncated: false,
    raw: {
      kind: 'c13-artifact', manifest: { seq: 0, hash: '0'.repeat(64) },
      sha256: '0'.repeat(64), bytes: 0, encoding: 'utf8', complete: true,
    },
  };
}

function config(over: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultAgentConfig(), ...over };
}

type ExecCall = { readonly cmd: string; readonly limits: CommandLimits };

function stubTerminal(outcomes: CommandOutcome[], calls: ExecCall[]): TerminalPort {
  return {
    run: (cmd, limits, _signal) => {
      calls.push({ cmd, limits });
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error('stubTerminal: no outcome queued');
      return Promise.resolve(outcome);
    },
  };
}

/** The never-called terminal for the describes that never reach execute. */
const neverTerminal: TerminalPort = {
  run: () => Promise.reject(new Error('terminal not expected')),
};

function outcome(over: Partial<CommandOutcome> = {}): CommandOutcome {
  return {
    status: 'completed', exitCode: 0, signal: null,
    output: new Uint8Array(), truncated: false, reset: false, fresh: null, ...over,
  };
}

async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; } catch { return false; }
}

interface ResultData {
  readonly callId: string; readonly isError: boolean; readonly failure: unknown;
  readonly raw: ArtifactRef | null; readonly synthetic: boolean;
  readonly message: { readonly content: string; readonly tool_call_id: string };
}

async function firstResult(home: string): Promise<ResultData> {
  const durable = await events(home);
  return ofType(durable, 'tool/result')[0]!.data as unknown as ResultData;
}

/** The `complete` flag of the first artifact's manifest. */
async function artifactComplete(home: string): Promise<boolean> {
  const durable = await events(home);
  const end = ofType(durable, 'artifact/end')[0]!.data as unknown as { complete: boolean };
  return end.complete;
}

/** Flush-proxy: fail the Nth `gate.flush` call, binding the rest to the target. */
function flushFaultGate(gate: BoundaryGate, failOnCall: number): BoundaryGate {
  let flushes = 0;
  return new Proxy(gate, {
    get(target, prop, receiver) {
      if (prop === 'flush') {
        return async (): Promise<void> => {
          flushes += 1;
          if (flushes === failOnCall) throw new Error('injected flush failure');
          await target.flush();
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe('dispatchCalls: execute', () => {
  it('runs a valid execute call in the persistent session and leaves its effect', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    const terminal = new PtyTerminalRuntime(repo.path, DEFAULT_TERMINAL_ENV);
    try {
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: "printf 'hello' > note.txt" }))]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), config(), terminal);
      expect(result).toEqual({ waited: false, called: 1 });
      expect(await readFile(join(repo.path, 'note.txt'), 'utf8')).toBe('hello');
      const durable = await events(home);
      expect(ofType(durable, 'tool/call')).toHaveLength(1);
      const data = await firstResult(home);
      expect(data.isError).toBe(false);
      expect(data.failure).toBeNull();
      expect(data.message.content).toBe('exit: 0');
      // A silent command captures no artifact.
      expect(data.raw).toBeNull();
      expect(ofType(durable, 'artifact/end')).toHaveLength(0);
    } finally {
      await terminal.dispose('test', 100);
      await s.shutdown();
    }
  }, 15000);

  it('renders captured output and keeps the verbatim raw artifact', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    const terminal = new PtyTerminalRuntime(repo.path, DEFAULT_TERMINAL_ENV);
    try {
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'echo hello-$((6*7))' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), config(), terminal);
      const data = await firstResult(home);
      expect(data.message.content).toMatch(/^exit: 0\noutput:\nhello-42/);
      const durable = await events(home);
      const rawBytes = resolveArtifact(durable, data.raw!);
      expect(Buffer.from(rawBytes).toString('utf8')).toMatch(/hello-42\r?\n/);
      expect(await artifactComplete(home)).toBe(true);
    } finally {
      await terminal.dispose('test', 100);
      await s.shutdown();
    }
  }, 15000);

  it('records an ordinary nonzero exit as isError with a null failure', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'false' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), config(),
        stubTerminal([outcome({ exitCode: 1 })], []));
      const data = await firstResult(home);
      expect(data.isError).toBe(true);
      expect(data.failure).toBeNull();
      expect(data.message.content).toBe('exit: 1');
    } finally {
      await s.shutdown();
    }
  });

  const STATUS_ROWS: ReadonlyArray<readonly [string, CommandOutcome, boolean, unknown, string]> = [
    ['timeout', outcome({ status: 'timeout', exitCode: null, reset: true,
      output: Buffer.from('partial\n', 'utf8') }), true, { code: 'timeout', status: null },
      'status: timeout\n[session: reset — the next command starts fresh]\noutput:\npartial\n'],
    ['session_exit clean', outcome({ status: 'session_exit', exitCode: 0, reset: true }),
      false, null,
      'status: session_exit\ndetail: the shell exited with code 0\n[session: reset — the next command starts fresh]'],
    ['session_exit nonzero', outcome({ status: 'session_exit', exitCode: 1, reset: true }),
      true, null,
      'status: session_exit\ndetail: the shell exited with code 1\n[session: reset — the next command starts fresh]'],
    ['session_exit by signal', outcome({ status: 'session_exit', exitCode: null,
      signal: 'SIGTERM', reset: true }), true, { code: 'signal', status: null },
      'status: session_exit\ndetail: the shell was killed by signal SIGTERM\n[session: reset — the next command starts fresh]'],
    ['stdin_read', outcome({ status: 'stdin_read', exitCode: null,
      output: Buffer.from('prompt? ', 'utf8') }), false, null,
      'status: stdin_read\n[the command is waiting on standard input; the next execute call resets the session first]\noutput:\nprompt? '],
    ['cancelled', outcome({ status: 'cancelled', exitCode: null, reset: true }),
      true, { code: 'cancelled', status: null },
      'status: cancelled\n[session: reset — the next command starts fresh]'],
    ['spawn-failed', outcome({ status: 'spawn-failed', exitCode: null }),
      true, { code: 'spawn', status: null }, 'status: spawn-failed'],
  ];

  it.each(STATUS_ROWS)('a %s outcome renders and classifies exactly',
    async (_name, outcomeValue, isError, failure, content) => {
      const { home } = world();
      const s = await openSession(home);
      try {
        const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'whatever' }))]);
        await dispatchCalls(proj, ID, s.gate('turn', 0), config(),
          stubTerminal([outcomeValue], []));
        const data = await firstResult(home);
        expect(data.isError).toBe(isError);
        expect(data.failure).toEqual(failure);
        expect(data.message.content).toBe(content);
      } finally {
        await s.shutdown();
      }
    });

  it('bounds the model-visible text and marks an over-limit capture incomplete', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const big = 'x'.repeat(4096);
      const policy = { ...defaultAgentConfig().policy, maxToolResultBytes: 256 };
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'big' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), config({ policy }),
        stubTerminal([outcome({ output: Buffer.from(big, 'utf8'), truncated: true })], []));
      const data = await firstResult(home);
      expect(data.isError).toBe(true);
      expect(data.failure).toEqual({ code: 'output-limit', status: null });
      const raw = data.raw!;
      const notice = /\n\[output truncated: showing (\d+) of (\d+) bytes; raw sha256 ([0-9a-f]{64})\]$/
        .exec(data.message.content);
      expect(notice).not.toBeNull();
      expect(Number(notice![1])).toBe(256);
      expect(Number(notice![2])).toBe(raw.bytes);
      expect(notice![3]).toBe(raw.sha256);
      expect(data.message.content).toContain('[output truncated at the capture limit; the command kept running]');
      expect(await artifactComplete(home)).toBe(false);
    } finally {
      await s.shutdown();
    }
  });

  it('sanitizes the render but keeps the raw artifact verbatim', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const dirty = Buffer.from('\x1b[31mred\x1b[0m\r\nprogress 10%\rprogress 99%\n', 'utf8');
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'dirty' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), config(),
        stubTerminal([outcome({ output: dirty })], []));
      const data = await firstResult(home);
      expect(data.message.content).toBe('exit: 0\noutput:\nred\nprogress 99%\n');
      const durable = await events(home);
      expect(Buffer.from(resolveArtifact(durable, data.raw!)).toString('utf8'))
        .toBe('\x1b[31mred\x1b[0m\r\nprogress 10%\rprogress 99%\n');
    } finally {
      await s.shutdown();
    }
  });

  it('a wedged session reset is announced on the next result', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'echo next' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), config(),
        stubTerminal([outcome({ fresh: 'stdin-wedge' })], []));
      const data = await firstResult(home);
      expect(data.message.content).toBe(
        '[session: reset after a command left waiting on stdin — previous shell state is gone]\nexit: 0');
    } finally {
      await s.shutdown();
    }
  });

  it('forwards the journaled policy limits to the terminal port', async () => {
    const { home } = world();
    const s = await openSession(home);
    const calls: ExecCall[] = [];
    try {
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'true' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), config(),
        stubTerminal([outcome()], calls));
      const cfg = config();
      expect(calls[0]!.limits).toEqual({
        timeoutMs: cfg.policy.shellTimeoutMs,
        killGraceMs: cfg.policy.killGraceMs,
        maxCaptureBytes: cfg.policy.maxShellCaptureBytes,
      });
    } finally {
      await s.shutdown();
    }
  });
});

describe('dispatchCalls: argument validation', () => {
  const INVALID_ARGS: ReadonlyArray<readonly [string, string]> = [
    ['an empty object', '{}'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a number cmd', '{"cmd":0}'],
    ['a whitespace cmd', '{"cmd":" "}'],
    ['an unknown extra key', '{"cmd":"true","extra":1}'],
  ];

  it.each(INVALID_ARGS)('rejects %s with a durable invalid-tool result and no shell', async (_name, args) => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('bad', 'execute', args)]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), config(), neverTerminal);
      expect(result).toEqual({ waited: false, called: 1 });

      const durable = await events(home);
      expect(ofType(durable, 'tool/call')).toHaveLength(1);
      // No capture ran, so no artifact was ever written for this call.
      expect(ofType(durable, 'artifact/end')).toHaveLength(0);
      const data = await firstResult(home);
      expect(data.callId).toBe('bad');
      expect(data.message.tool_call_id).toBe('bad');
      expect(data.isError).toBe(true);
      expect(data.failure).toEqual({ code: 'invalid-tool', status: null });
      expect(data.raw).toBeNull();
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('never turns an unknown tool name into bash', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('c1', 'not-execute', JSON.stringify({ cmd: 'touch unknown.txt' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), config(), neverTerminal);
      const data = await firstResult(home);
      expect(data.failure).toEqual({ code: 'unknown-tool', status: null });
      expect(data.raw).toBeNull();
      expect(await exists(join(repo.path, 'unknown.txt'))).toBe(false);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('denies an execution not in the allowlist without changing the offering', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    try {
      const denied = config({ allowedTools: ['wait'] });
      const offeredNames = denied.tools.map((tool) => tool.name);
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'touch denied.txt' }))]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), denied, neverTerminal);
      expect(result).toEqual({ waited: false, called: 1 });

      const data = await firstResult(home);
      expect(data.failure).toEqual({ code: 'denied', status: null });
      expect(data.raw).toBeNull();
      expect(await exists(join(repo.path, 'denied.txt'))).toBe(false);
      // The offering itself is untouched: execute is still advertised.
      expect(offeredNames).toContain('execute');
      expect(denied.tools.map((tool) => tool.name)).toEqual(offeredNames);
    } finally {
      await s.shutdown();
    }
  }, 15000);
});

describe('dispatchCalls: wait', () => {
  it('returns the fixed waiting text and no effect', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('w1', 'wait', '{}')]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), config(), neverTerminal);
      expect(result).toEqual({ waited: true, called: 1 });
      const data = await firstResult(home);
      expect(data.isError).toBe(false);
      expect(data.failure).toBeNull();
      expect(data.raw).toBeNull();
      expect(data.synthetic).toBe(false);
      expect(data.message.content).toBe('Waiting until a foreign world commit');
      expect(data.message.tool_call_id).toBe('w1');
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('completes both a wait and an execute in one group', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    const terminal = new PtyTerminalRuntime(repo.path, DEFAULT_TERMINAL_ENV);
    try {
      const proj = projection([
        call('w1', 'wait', '{}'),
        call('e1', 'execute', JSON.stringify({ cmd: 'printf hi > both.txt && echo done' })),
      ]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), config(), terminal);
      expect(result).toEqual({ waited: true, called: 2 });
      expect(await readFile(join(repo.path, 'both.txt'), 'utf8')).toBe('hi');

      const durable = await events(home);
      expect(ofType(durable, 'tool/call')).toHaveLength(2);
      expect(ofType(durable, 'tool/result')).toHaveLength(2);
      const results = ofType(durable, 'tool/result').map((e) => e.data as unknown as ResultData);
      expect(results[0]!.callId).toBe('w1');
      expect(results[1]!.callId).toBe('e1');
      expect(results[1]!.raw).not.toBeNull();
    } finally {
      await terminal.dispose('test', 100);
      await s.shutdown();
    }
  }, 15000);
});

describe('dispatchCalls: abort and durability faults', () => {
  it('re-checks the signal after the tool/call flush and cancels without spawning', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    const terminal = new PtyTerminalRuntime(repo.path, DEFAULT_TERMINAL_ENV);
    try {
      let flushes = 0;
      const gate = new Proxy(s.gate('turn', 0), {
        get(target, prop, receiver) {
          if (prop === 'flush') {
            return async (): Promise<void> => {
              flushes += 1;
              if (flushes === 1) s.controller.abort();
              await target.flush();
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'printf x > race.txt' }))]);
      const result = await dispatchCalls(proj, ID, gate, config(), terminal);
      expect(result).toEqual({ waited: false, called: 1 });
      expect(await exists(join(repo.path, 'race.txt'))).toBe(false);

      const data = await firstResult(home);
      expect(data.failure).toEqual({ code: 'cancelled', status: null });
      expect(data.isError).toBe(true);
    } finally {
      await terminal.dispose('test', 100);
      await s.shutdown();
    }
  }, 15000);

  it('writes synthetic cancelled results for calls stopped before they are attempted', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    try {
      s.controller.abort();
      const proj = projection([
        call('c1', 'execute', JSON.stringify({ cmd: 'touch one.txt' })),
        call('c2', 'execute', JSON.stringify({ cmd: 'touch two.txt' })),
      ]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), config(), neverTerminal);
      expect(result).toEqual({ waited: false, called: 0 });

      const durable = await events(home);
      // No forged tool/call, but every advertised call is completed.
      expect(ofType(durable, 'tool/call')).toHaveLength(0);
      const results = ofType(durable, 'tool/result').map((e) => e.data as unknown as ResultData);
      expect(results).toHaveLength(2);
      for (const [i, data] of results.entries()) {
        expect(data.synthetic).toBe(true);
        expect(data.callId).toBe(i === 0 ? 'c1' : 'c2');
        expect(data.failure).toEqual({ code: 'cancelled', status: null });
        expect(data.raw).toBeNull();
      }
      expect(await exists(join(repo.path, 'one.txt'))).toBe(false);
      expect(await exists(join(repo.path, 'two.txt'))).toBe(false);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('leaves the effect absent when the tool/call flush faults', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    const terminal = new PtyTerminalRuntime(repo.path, DEFAULT_TERMINAL_ENV);
    try {
      const gate = flushFaultGate(s.gate('turn', 0), 1);
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'printf x > fault1.txt' }))]);
      await expect(dispatchCalls(proj, ID, gate, config(), terminal))
        .rejects.toThrow('injected flush failure');
      expect(await exists(join(repo.path, 'fault1.txt'))).toBe(false);
    } finally {
      await terminal.dispose('test', 100);
      await s.shutdown();
    }
  }, 15000);

  it('runs the effect but rejects when the result flush faults (no later request)', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    const terminal = new PtyTerminalRuntime(repo.path, DEFAULT_TERMINAL_ENV);
    try {
      const gate = flushFaultGate(s.gate('turn', 0), 2);
      const proj = projection([call('c1', 'execute', JSON.stringify({ cmd: 'printf x > fault2.txt' }))]);
      await expect(dispatchCalls(proj, ID, gate, config(), terminal))
        .rejects.toThrow('injected flush failure');
      expect(await readFile(join(repo.path, 'fault2.txt'), 'utf8')).toBe('x');
    } finally {
      await terminal.dispose('test', 100);
      await s.shutdown();
    }
  }, 15000);

  it('completes every listed call in a group', async () => {
    const { home, world: repo } = world();
    const s = await openSession(home);
    const terminal = new PtyTerminalRuntime(repo.path, DEFAULT_TERMINAL_ENV);
    try {
      const proj = projection([
        call('c1', 'execute', JSON.stringify({ cmd: 'printf one > a.txt' })),
        call('c2', 'execute', JSON.stringify({ cmd: 'printf two > b.txt' })),
      ]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), config(), terminal);
      expect(result).toEqual({ waited: false, called: 2 });
      expect(await readFile(join(repo.path, 'a.txt'), 'utf8')).toBe('one');
      expect(await readFile(join(repo.path, 'b.txt'), 'utf8')).toBe('two');
      expect(ofType(await events(home), 'tool/result')).toHaveLength(2);
    } finally {
      await terminal.dispose('test', 100);
      await s.shutdown();
    }
  }, 15000);
});

describe('dispatchCalls: web tools', () => {
  const WEB_OFFERING = [
    { name: 'web_search', description: 'Search.', parameters: {
      type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' } },
      required: ['query'], additionalProperties: false } },
    { name: 'web_fetch', description: 'Fetch.', parameters: {
      type: 'object', properties: { url: { type: 'string' } },
      required: ['url'], additionalProperties: false } },
  ];
  const WEB_NAMES = new Set(['web_search', 'web_fetch']);

  function webConfig(over: Partial<AgentConfig> = {}): AgentConfig {
    const base = config();
    return { ...base,
      tools: [...base.tools.filter((tool) => !WEB_NAMES.has(tool.name)), ...WEB_OFFERING],
      allowedTools: [...base.allowedTools.filter((name) => !WEB_NAMES.has(name)),
        'web_search', 'web_fetch'],
      ...over };
  }

  function withoutWeb(base: AgentConfig): AgentConfig {
    return { ...base,
      tools: base.tools.filter((tool) => !WEB_NAMES.has(tool.name)),
      allowedTools: base.allowedTools.filter((name) => !WEB_NAMES.has(name)) };
  }

  type StubCall = { readonly method: string; readonly args: unknown[] };

  function stubWeb(outcomes: WebOutcome[], calls: StubCall[]): WebTools {
    const next = (): WebOutcome => {
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error('stubWeb: no outcome queued');
      return outcome;
    };
    return {
      search: (query, maxResults, _signal) => {
        calls.push({ method: 'search', args: [query, maxResults] });
        return Promise.resolve(next());
      },
      extract: (url, _signal) => {
        calls.push({ method: 'extract', args: [url] });
        return Promise.resolve(next());
      },
    };
  }

  const SEARCH_JSON = JSON.stringify({
    request_id: 'req-dispatch', query: 'q',
    results: [{ title: 'One', url: 'https://one.example', content: 'first snippet' }],
  });
  const EXTRACT_FAILED_JSON = JSON.stringify({
    results: [],
    failed_results: [{ url: 'https://a.example/', error: 'Failed to retrieve content' }],
  });

  function okSearch(body = SEARCH_JSON): WebOutcome {
    return { ok: true, status: 200, body: Buffer.from(body, 'utf8') };
  }

  async function rawText(home: string): Promise<string> {
    const durable = await events(home);
    const data = ofType(durable, 'tool/result')[0]!.data as unknown as { raw: ArtifactRef | null };
    return Buffer.from(resolveArtifact(durable, data.raw!)).toString('utf8');
  }

  it('journals a bounded web_search result with its raw artifact', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(),
        neverTerminal, stubWeb([okSearch()], []));
      expect(result).toEqual({ waited: false, called: 1 });
      const durable = await events(home);
      expect(ofType(durable, 'tool/call')).toHaveLength(1);
      const data = await firstResult(home);
      expect(data.isError).toBe(false);
      expect(data.failure).toBeNull();
      expect(data.synthetic).toBe(false);
      expect(data.message.content).toBe([
        'provider: tavily', 'request: req-dispatch', 'results: 1', '',
        '[1] One', 'https://one.example', 'first snippet',
      ].join('\n'));
      expect(await rawText(home)).toBe(SEARCH_JSON);
      expect(await artifactComplete(home)).toBe(true);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('web tools are denied when no provider is configured', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(), neverTerminal);
      const data = await firstResult(home);
      expect(data.isError).toBe(true);
      expect(data.failure).toEqual({ code: 'denied', status: null });
      expect(data.raw).toBeNull();
      expect(data.message.content).toBe('error: denied');
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('a web tool not in allowedTools is denied', async () => {
    const { home } = world();
    const s = await openSession(home);
    const calls: StubCall[] = [];
    try {
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0),
        webConfig({ allowedTools: ['execute', 'wait'] }), neverTerminal, stubWeb([], calls));
      const data = await firstResult(home);
      expect(data.failure).toEqual({ code: 'denied', status: null });
      expect(calls).toHaveLength(0);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('a web tool that is not offered is unknown-tool', async () => {
    const { home } = world();
    const s = await openSession(home);
    const calls: StubCall[] = [];
    try {
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), withoutWeb(config()),
        neverTerminal, stubWeb([], calls));
      const data = await firstResult(home);
      expect(data.failure).toEqual({ code: 'unknown-tool', status: null });
      expect(calls).toHaveLength(0);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  const INVALID_WEB_ARGS: ReadonlyArray<readonly [string, string]> = [
    ['web_search', '{}'],
    ['web_search', '{"query":""}'],
    ['web_search', '{"query":"q","max_results":0}'],
    ['web_search', '{"query":"q","max_results":21}'],
    ['web_search', '{"query":"q","extra":1}'],
    ['web_fetch', '{}'],
    ['web_fetch', '{"url":7}'],
    ['web_fetch', '{"url":"ftp://x"}'],
    ['web_fetch', '{"url":"not a url"}'],
    ['web_fetch', '{"url":"https://a","extra":1}'],
  ];

  it.each(INVALID_WEB_ARGS)('rejects invalid %s arguments %s with invalid-tool and no provider call',
    async (name, args) => {
      const { home } = world();
      const s = await openSession(home);
      const calls: StubCall[] = [];
      try {
        const proj = projection([call('bad', name, args)]);
        const result = await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(),
          neverTerminal, stubWeb([], calls));
        expect(result).toEqual({ waited: false, called: 1 });
        expect(calls).toHaveLength(0);
        const durable = await events(home);
        expect(ofType(durable, 'artifact/end')).toHaveLength(0);
        const data = await firstResult(home);
        expect(data.failure).toEqual({ code: 'invalid-tool', status: null });
        expect(data.raw).toBeNull();
      } finally {
        await s.shutdown();
      }
    }, 15000);

  it('a failed outcome keeps its failure and captured prefix', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const outcome: WebOutcome = {
        ok: false, failure: { code: 'http', status: 429 }, status: 429,
        body: Buffer.from('{"detail":"rate limited"}', 'utf8'), complete: true,
      };
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(), neverTerminal,
        stubWeb([outcome], []));
      const data = await firstResult(home);
      expect(data.isError).toBe(true);
      expect(data.failure).toEqual({ code: 'http', status: 429 });
      expect(data.message.content).toBe('error: http\nstatus: 429\nbody:\n{"detail":"rate limited"}');
      expect(await rawText(home)).toBe('{"detail":"rate limited"}');
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('a malformed success body is a malformed failure with the raw kept', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(), neverTerminal,
        stubWeb([okSearch('not json')], []));
      const data = await firstResult(home);
      expect(data.isError).toBe(true);
      expect(data.failure).toEqual({ code: 'malformed', status: 200 });
      expect(data.message.content).toBe('error: malformed\nstatus: 200\nbody:\nnot json');
      expect(await rawText(home)).toBe('not json');
      expect(await artifactComplete(home)).toBe(true);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('a failed extraction is an error result without a SafeFailure', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const proj = projection([call('w1', 'web_fetch', JSON.stringify({ url: 'https://a.example/' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(), neverTerminal,
        stubWeb([okSearch(EXTRACT_FAILED_JSON)], []));
      const data = await firstResult(home);
      expect(data.isError).toBe(true);
      expect(data.failure).toBeNull();
      expect(data.message.content)
        .toBe('provider: tavily\nurl: https://a.example/\nerror: Failed to retrieve content');
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('an empty failure body keeps raw null and writes no artifact', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const outcome: WebOutcome = {
        ok: false, failure: { code: 'network', status: null }, status: null,
        body: new Uint8Array(), complete: false,
      };
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(), neverTerminal,
        stubWeb([outcome], []));
      const data = await firstResult(home);
      expect(data.isError).toBe(true);
      expect(data.failure).toEqual({ code: 'network', status: null });
      expect(data.raw).toBeNull();
      expect(data.message.content).toBe('error: network');
      const durable = await events(home);
      expect(ofType(durable, 'artifact/end')).toHaveLength(0);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('a body-limit outcome captures an incomplete prefix', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const outcome: WebOutcome = {
        ok: false, failure: { code: 'body-limit', status: 200 }, status: 200,
        body: Buffer.alloc(2048, 120), complete: false,
      };
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(), neverTerminal,
        stubWeb([outcome], []));
      const data = await firstResult(home);
      expect(data.failure).toEqual({ code: 'body-limit', status: 200 });
      expect(data.message.content.startsWith('error: body-limit\nstatus: 200\nbody:\n')).toBe(true);
      expect(data.raw!.complete).toBe(false);
      expect(await artifactComplete(home)).toBe(false);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('bounds a long successful render with the truncation notice', async () => {
    const { home } = world();
    const s = await openSession(home);
    try {
      const big = JSON.stringify({
        results: [{ title: 'Big', url: 'https://big.example', content: 'x'.repeat(4096) }],
      });
      const policy = { ...defaultAgentConfig().policy, maxToolResultBytes: 256 };
      const proj = projection([call('w1', 'web_search', JSON.stringify({ query: 'q' }))]);
      await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig({ policy }),
        neverTerminal, stubWeb([okSearch(big)], []));
      const data = await firstResult(home);
      const raw = data.raw!;
      // Every byte of the render is ASCII, so the retained prefix is exactly the
      // 256-byte bound; the notice must name that real size and the raw's own facts.
      const notice = /\n\[output truncated: showing (\d+) of (\d+) bytes; raw sha256 ([0-9a-f]{64})\]$/
        .exec(data.message.content);
      expect(notice).not.toBeNull();
      expect(Number(notice![1])).toBe(256);
      expect(Number(notice![2])).toBe(raw.bytes);
      expect(notice![3]).toBe(raw.sha256);
      expect(data.message.content.startsWith('provider: tavily')).toBe(true);
    } finally {
      await s.shutdown();
    }
  }, 15000);

  it('forwards the valid max_results bounds to the web port', async () => {
    const { home } = world();
    const s = await openSession(home);
    const calls: StubCall[] = [];
    try {
      const proj = projection([
        call('w1', 'web_search', JSON.stringify({ query: 'q', max_results: 1 })),
        call('w2', 'web_search', JSON.stringify({ query: 'q', max_results: 20 })),
      ]);
      const result = await dispatchCalls(proj, ID, s.gate('turn', 0), webConfig(),
        neverTerminal, stubWeb([okSearch(), okSearch()], calls));
      expect(result).toEqual({ waited: false, called: 2 });
      expect(calls.map((entry) => entry.args[1])).toEqual([1, 20]);
    } finally {
      await s.shutdown();
    }
  }, 15000);
});
