import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeDriver } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { createAgentRuntime, defaultAgentConfig, type AgentRuntime } from '../loop.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents, type VerifiedEvent, type VerifiedEvents } from '../../context/loader.js';
import { rederivePlans } from '../../context/assembler.js';
import { resolveArtifact } from '../../context/artifacts.js';
import { serializeWire } from '../../provider/wire.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import type { SerializedTransport, TransportResult } from '../../provider/transport.js';
import type { AgentConfig, ArtifactRef, FunctionCall } from '../../context/contracts.js';
import type { ShellPolicy } from '../tools/shell.js';
import { commitAs, useWorld, type WorldFixture } from './helpers.js';

/**
 * T9 runtime-seeded replay fixture (kernel.md §4). The real `createAgentRuntime`
 * runs against the real driver, world, Git renderer, fold and shell; only the
 * provider transport is scripted. It produces:
 *
 *  - two nonempty turns, each a tool group (`execute` + `wait`), and the Git
 *    diffs their perceptions rendered;
 *  - a heading/config update (scheduled strictly newer configuration);
 *  - a closed EMPTY turn whose nonempty external perception is still retained;
 *  - canonical artifacts above 4 MiB (version 2's charter is a giant captured
 *    artifact, so the final turn's plan and wire are giants too; version 1's
 *    default charter keeps the earlier turns cheap);
 *  - successive committed compactions;
 *  - an interrupted turn: the shell is armed to throw mid-dispatch, so the turn
 *    closes with a durable error closer that moves its incomplete call group
 *    into recovery.
 *
 * It then stops, replays offline with a throwing transport and an armed shell
 * (zero calls/effects/commits), restarts a fresh runtime whose `initialConfig`
 * deliberately differs (the journaled config wins), and asserts every rederived
 * plan and serialized wire is canonically equal. Two focused companions cover the
 * oversize-plan refusal and the 429-then-200 retry.
 */

type RunShell = typeof import('../tools/shell.js').runShell;

const shellGuard = vi.hoisted(() => ({
  real: null as unknown as RunShell,
  throwsOn: null as string | null,
  calls: 0,
}));

vi.mock('../tools/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/shell.js')>();
  shellGuard.real = actual.runShell;
  const wrapped: RunShell = (cmd, cwd, signal, policy) => {
    shellGuard.calls += 1;
    if (shellGuard.throwsOn !== null && cmd.includes(shellGuard.throwsOn)) {
      throw new Error('injected shell crash');
    }
    return actual.runShell(cmd, cwd, signal, policy);
  };
  return { ...actual, runShell: wrapped };
});

const fixture = useWorld('c13-loop-replay-');

const MiB = 1024 * 1024;
/** A charter above the 4 MiB artifact threshold, so the final turn's plan/wire are giants. */
const GIANT_CHARTER = 'c'.repeat(4.5 * MiB);

beforeEach(() => {
  shellGuard.throwsOn = null;
  shellGuard.calls = 0;
});

class ScriptedTransport implements SerializedTransport {
  readonly sends: Uint8Array[] = [];
  private readonly script: TransportResult[];
  /** When set, any post is a hard failure: it proves offline replay never sends. */
  throwIfCalled = false;

  constructor(script: readonly TransportResult[] = []) {
    this.script = [...script];
  }

  async post(body: Uint8Array, signal: AbortSignal, _maxBytes: number): Promise<TransportResult> {
    if (this.throwIfCalled) throw new Error('transport called offline');
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

const providerPolicy = {
  now: () => 100,
  delay: (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  }),
  schedule: (ms: number, callback: () => void): (() => void) => {
    const timer = setTimeout(callback, ms);
    return () => { clearTimeout(timer); };
  },
};

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

function shellPolicyFor(config: AgentConfig): ShellPolicy {
  return {
    timeoutMs: config.policy.shellTimeoutMs, killGraceMs: config.policy.killGraceMs,
    maxCaptureBytes: config.policy.maxShellCaptureBytes,
    drainDeadlineMs: config.policy.shellDrainMs,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb' },
  };
}

function runtimeFor(fx: WorldFixture, config: AgentConfig, transport: ScriptedTransport): AgentRuntime {
  return createAgentRuntime({
    home: fx.home, uid: 'n1', world: fx.world, initialConfig: config,
    shellPolicy: shellPolicyFor(config),
    adapter: new ProviderAdapter(transport, providerPolicy),
  });
}

function openRuntime(fx: WorldFixture, runtime: AgentRuntime): Promise<NodeDriver> {
  return NodeDriver.open(fx.home, 'n1', runtime.handler, fx.world, {
    knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
    onCheckpoint: (mark) => runtime.checkpoint(mark),
  });
}

async function parked(driver: NodeDriver, world: WorldFixture['world']): Promise<void> {
  await vi.waitFor(() => {
    expect(driver.state).toBe('waiting');
    expect(HeadWatcher.for(world).subscriberCount).toBe(1);
  }, { timeout: 60000 });
}

function eventsOf(fx: WorldFixture): Promise<VerifiedEvents> {
  return loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
}

function dataOf<T>(event: VerifiedEvent): T {
  return event.data as unknown as T;
}

function inlinePerceptionText(event: VerifiedEvent): string {
  const data = dataOf<{ value: { kind: string; value?: { text: string } } }>(event);
  return data.value.kind === 'inline' ? (data.value.value?.text ?? '') : '';
}

describe('C1.3 runtime-seeded replay', () => {
  it('reconstructs a multi-turn journal offline and recovers an interrupted turn', async () => {
    const fx = fixture();
    const base = defaultAgentConfig();
    const config: AgentConfig = {
      ...base,
      policy: {
        ...base.policy,
        compactAfterBytes: 1, keepRecentGroups: 0, retryDelayMs: 1,
        stepsPerTurn: 8, maxAttempts: 2,
      },
    };
    // Version 2 grows the charter above the artifact threshold; only the final turn
    // (the one that crashes) carries the > 4 MiB plan and wire artifacts.
    const updated: AgentConfig = {
      ...config, version: 2, charter: GIANT_CHARTER, heading: 'New heading, verbatim.',
    };
    const transport = new ScriptedTransport([
      calling([execute('c1', "printf 'hello' > note.txt"), waitCall('w1')]),
      noCalls('done-2'),
      calling([execute('c2', "printf 'world' > note2.txt"), waitCall('w2')]),
      calling([execute('c9', 'boom')]),
    ]);
    const runtime = runtimeFor(fx, config, transport);
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      await commitAs(fx.world, 'human', { 'direction.txt': 'build a note\n' });
      driver = await openRuntime(fx, runtime);
      running = driver.run();

      // Turn 0 (boot): a tool group (execute + wait) then parks.
      await vi.waitFor(() => expect(transport.sends).toHaveLength(1), { timeout: 60000 });
      await parked(driver, fx.world);
      expect(await readFile(join(fx.world.path, 'note.txt'), 'utf8')).toBe('hello');

      await commitAs(fx.world, 'peer', { 'peer.txt': 'new external fact\n' });
      await HeadWatcher.for(fx.world).check();

      // Turn 1: an empty (ignorable) turn, but its nonempty external perception is retained.
      await vi.waitFor(() => expect(transport.sends).toHaveLength(2), { timeout: 60000 });
      await parked(driver, fx.world);
      const afterTurn1 = runtime.snapshot();
      expect(afterTurn1.config?.value.version).toBe(1);
      const perceptions = afterTurn1.surface?.nodes.filter((node) => node.group.kind === 'perception') ?? [];
      expect(perceptions.some((node) =>
        node.group.messages.some((message) =>
          (message as { content: string }).content.includes('peer.txt')))).toBe(true);

      // Turn 2: another nonempty tool-group turn; successive compaction has run.
      await commitAs(fx.world, 'peer', { 'peer2.txt': 'another fact\n' });
      await HeadWatcher.for(fx.world).check();
      await vi.waitFor(() => expect(transport.sends).toHaveLength(3), { timeout: 60000 });
      await parked(driver, fx.world);
      expect(await readFile(join(fx.world.path, 'note2.txt'), 'utf8')).toBe('world');

      // Turn 3: a giant configuration is applied (the heading/config update), then the
      // execute is armed to crash mid-dispatch. The runtime throws and the driver closes
      // the turn with a durable error closer, leaving the advertised c9 group incomplete
      // (moved into recovery). No turn runs after this one, so no further world render.
      runtime.scheduleConfig(updated);
      const f3 = await commitAs(fx.world, 'peer', { 'peer3.txt': 'third fact\n' });
      shellGuard.throwsOn = 'boom';
      await HeadWatcher.for(fx.world).check();
      await expect(running).rejects.toThrow('injected shell crash');
      running = null;
      expect(transport.sends).toHaveLength(4);

      // --- offline reconstruction with throwing ports: zero calls/effects/commits ---
      const events = await eventsOf(fx);
      const headBefore = await fx.world.headHash();
      const shellCallsBefore = shellGuard.calls;
      transport.throwIfCalled = true;
      shellGuard.throwsOn = ''; // any shell call would throw

      const perceptionsRecorded = events.filter((event) => event.type === 'world/perception');
      expect(perceptionsRecorded.some((event) => inlinePerceptionText(event).includes('direction.txt')))
        .toBe(true);
      expect(events.filter((event) => event.type === 'tool/call')
        .map((event) => dataOf<{ call: FunctionCall }>(event).call.id))
        .toEqual(['c1', 'w1', 'c2', 'w2', 'c9']);
      expect(events.filter((event) => event.type === 'tool/result')
        .map((event) => dataOf<{ callId: string }>(event).callId)).toEqual(['c1', 'w1', 'c2', 'w2']);
      expect(events.filter((event) => event.type === 'compaction/end').length).toBeGreaterThanOrEqual(2);
      const emptyCloser = events.find((event) =>
        event.type === 'turn/end' && dataOf<{ turn: number }>(event).turn === 1);
      expect(emptyCloser?.ignorable).toBe(true);

      const plans = events.filter((event) => event.type === 'request/plan');
      const wires = events.filter((event) => event.type === 'request/wire');
      expect(plans).toHaveLength(4);
      expect(wires).toHaveLength(4);
      const comparisons = await rederivePlans(events, fx.world);
      expect(comparisons).toHaveLength(4);
      for (let index = 0; index < comparisons.length; index += 1) {
        const comparison = comparisons[index]!;
        const rederived = Buffer.from(serializeWire(comparison.rederived));
        expect(rederived.equals(Buffer.from(serializeWire(comparison.recorded)))).toBe(true);
        const wireRef = dataOf<{ body: ArtifactRef }>(wires[index]!).body;
        expect(rederived.equals(Buffer.from(resolveArtifact(events, wireRef)))).toBe(true);
      }
      // The final turn's plan and wire are the > 4 MiB canonical artifacts, and the
      // scheduled (version 2) configuration is itself a > 4 MiB captured artifact.
      const giantWire = resolveArtifact(events, dataOf<{ body: ArtifactRef }>(wires[3]!).body);
      expect(giantWire.length).toBeGreaterThan(4 * MiB);
      const giantPlan = resolveArtifact(events, (() => {
        const stored = dataOf<{ value: { kind: string; ref: ArtifactRef } }>(plans[3]!).value;
        return stored.ref;
      })());
      expect(giantPlan.length).toBeGreaterThan(4 * MiB);
      const v2Config = events.find((event) =>
        event.type === 'system/message' && dataOf<{ version: number }>(event).version === 2);
      expect(v2Config).toBeDefined();
      const v2Stored = dataOf<{ value: { kind: string; ref: ArtifactRef } }>(v2Config!).value;
      expect(v2Stored.kind).toBe('artifact-json');
      expect(resolveArtifact(events, v2Stored.ref).length).toBeGreaterThan(4 * MiB);

      // The throwing transport and armed shell were never reached.
      expect(transport.sends).toHaveLength(4);
      expect(shellGuard.calls).toBe(shellCallsBefore);
      expect(await fx.world.headHash()).toBe(headBefore);

      // --- restart with a deliberately different initialConfig: journaled config wins ---
      const differing: AgentConfig = {
        ...defaultAgentConfig(), version: 1,
        charter: 'DIFFERENT CHARTER', heading: 'DIFFERENT HEADING',
      };
      const restartedTransport = new ScriptedTransport([]);
      restartedTransport.throwIfCalled = true;
      const restarted = createAgentRuntime({
        home: fx.home, uid: 'n1', world: fx.world, initialConfig: differing,
        // The supplied shell numerics come from the JOURNALED config, not the ignored
        // differing initialConfig: strict shell-policy validation checks the effective one.
        shellPolicy: shellPolicyFor(updated),
        adapter: new ProviderAdapter(restartedTransport, providerPolicy),
      });
      driver = await NodeDriver.open(fx.home, 'n1', restarted.handler, fx.world, {
        knownTypes: C13_EVENT_TYPES, hooks: restarted.hooks, worldPollMs: 0,
      });
      // open() rebuilt offline and reconciled the interrupted call: no send, no shell.
      expect(restartedTransport.sends).toHaveLength(0);
      expect(shellGuard.calls).toBe(shellCallsBefore);
      expect(restarted.snapshot().config?.value.version).toBe(2);
      expect(restarted.snapshot().config?.value.heading).toBe('New heading, verbatim.');
      expect(restarted.snapshot().recovery).toEqual([]);
      expect(await fx.world.headHash()).toBe(headBefore);

      // Shut the opened-but-not-run driver down without starting a turn.
      driver.stop();
      await driver.run();
      driver = null;

      const finalEvents = await eventsOf(fx);
      const c9Result = finalEvents.filter((event) => event.type === 'tool/result')
        .find((event) => dataOf<{ callId: string }>(event).callId === 'c9');
      expect(c9Result).toBeDefined();
      expect(dataOf<{ synthetic: boolean }>(c9Result!).synthetic).toBe(true);
      expect(dataOf<{ message: { content: string } }>(c9Result!).message.content)
        .toBe('Outcome unknown after interruption; not re-executed');
      const finalComparisons = await rederivePlans(finalEvents, fx.world);
      expect(finalComparisons).toHaveLength(4);
      // The last foreign commit is still HEAD: no effect or commit was replayed.
      expect(await fx.world.headHash()).toBe(f3);
    } finally {
      shellGuard.throwsOn = null;
      const current = driver;
      driver = null;
      if (current) {
        current.stop();
        const pending = running as Promise<void> | null;
        if (pending) await pending.catch(() => { /* the assertion failure stands */ });
        else if (current.state === 'booting' || current.state === 'active') {
          await current.run().catch(() => { /* the assertion failure stands */ });
        }
      }
    }
  }, 300000);

  it('refuses an oversize plan durably with no wire and zero sends', async () => {
    const fx = fixture();
    const base = defaultAgentConfig();
    // A charter just under the 32 MiB config ceiling: the config still journals, but
    // the assembled plan (charter + the ~1 MiB rendered perception) reaches the ceiling.
    const config: AgentConfig = {
      ...base,
      charter: 'c'.repeat(31.5 * MiB),
      policy: { ...base.policy, maxDiffBytes: MiB, stepsPerTurn: 1 },
    };
    const transport = new ScriptedTransport([]);
    const runtime = runtimeFor(fx, config, transport);
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      const head = await commitAs(fx.world, 'peer', { 'big.txt': 'x'.repeat(Math.ceil(1.2 * MiB)) });
      driver = await openRuntime(fx, runtime);
      running = driver.run();
      await parked(driver, fx.world);
      driver.stop();
      await running;
      running = null;

      expect(transport.sends).toHaveLength(0);
      const events = await eventsOf(fx);
      const refused = events.filter((event) => event.type === 'request/refused');
      expect(refused).toHaveLength(1);
      const payload = dataOf<{ phase: string; bytes: number; limit: number }>(refused[0]!);
      expect(payload.phase).toBe('plan');
      expect(payload.bytes).toBeGreaterThanOrEqual(32 * MiB);
      expect(payload.limit).toBe(32 * MiB);
      expect(events.some((event) => event.type === 'request/plan')).toBe(false);
      expect(events.some((event) => event.type === 'request/wire')).toBe(false);
      expect(events.some((event) => event.type === 'response/raw')).toBe(false);
      expect(events.find((event) => event.type === 'turn/end')?.data)
        .toMatchObject({ outcome: 'error' });
      // Nothing was written or committed: the foreign commit stays HEAD.
      expect(await fx.world.headHash()).toBe(head);
    } finally {
      const current = driver;
      driver = null;
      if (current) {
        current.stop();
        const pending = running as Promise<void> | null;
        if (pending) await pending.catch(() => { /* the assertion failure stands */ });
        else if (current.state === 'booting' || current.state === 'active') {
          await current.run().catch(() => { /* the assertion failure stands */ });
        }
      }
    }
  }, 120000);

  it('rebuilds one complete response across a 429-then-200 retry without duplication', async () => {
    const fx = fixture();
    const base = defaultAgentConfig();
    const config: AgentConfig = {
      ...base, policy: { ...base.policy, maxAttempts: 2, retryDelayMs: 1 },
    };
    const transport = new ScriptedTransport([statusResponse(429), noCalls('recovered')]);
    const runtime = runtimeFor(fx, config, transport);
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      await commitAs(fx.world, 'human', { 'direction.txt': 'build a note\n' });
      driver = await openRuntime(fx, runtime);
      running = driver.run();
      await parked(driver, fx.world);
      driver.stop();
      await running;
      running = null;

      expect(transport.sends).toHaveLength(2);
      expect(Buffer.from(transport.sends[0]!).equals(Buffer.from(transport.sends[1]!))).toBe(true);
      const events = await eventsOf(fx);
      // One perception, one logical request, one assistant: the retry duplicates nothing.
      expect(events.filter((event) => event.type === 'world/perception')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'request/plan')).toHaveLength(1);
      const wires = events.filter((event) => event.type === 'request/wire');
      expect(wires.map((event) => dataOf<{ attempt: number }>(event).attempt)).toEqual([0, 1]);
      const raws = events.filter((event) => event.type === 'response/raw');
      expect(raws.map((event) => dataOf<{ status: number }>(event).status)).toEqual([429, 200]);
      expect(events.filter((event) => event.type === 'assistant/message')).toHaveLength(1);
      expect(events.some((event) => event.type === 'tool/call')).toBe(false);
      expect(events.some((event) => event.type === 'tool/result')).toBe(false);
      expect(events.find((event) => event.type === 'turn/end')?.data)
        .toMatchObject({ outcome: 'waiting' });
      const comparisons = await rederivePlans(events, fx.world);
      expect(comparisons).toHaveLength(1);
    } finally {
      const current = driver;
      driver = null;
      if (current) {
        current.stop();
        const pending = running as Promise<void> | null;
        if (pending) await pending.catch(() => { /* the assertion failure stands */ });
        else if (current.state === 'booting' || current.state === 'active') {
          await current.run().catch(() => { /* the assertion failure stands */ });
        }
      }
    }
  }, 30000);
});
