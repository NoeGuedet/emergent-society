import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { access, chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodeDir } from '../../journal/index.js';
import { NodeDriver } from '../driver.js';
import { createAgentRuntime, defaultAgentConfig, type AgentRuntime } from '../loop.js';
import type { DurableWatermark } from '../gate.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { readSnapshot } from '../../context/snapshots.js';
import { DEFAULT_SHELL_ENV, type ShellPolicy } from '../tools/shell.js';
import { ProviderAdapter, type ProviderPolicy } from '../../provider/adapter.js';
import type { SerializedTransport, TransportResult } from '../../provider/transport.js';
import type { AgentConfig } from '../../context/contracts.js';
import { readNode, useWorld, type WorldFixture } from './helpers.js';

/**
 * T10 checkpoint-hook acceptance. The real `createAgentRuntime` is wired to the
 * real driver's `onCheckpoint`, so the mark the driver derives from the verified
 * event stream is the one the runtime snapshots. These fixtures prove the success
 * path (a round-trippable snapshot at the durable closer) and that two injected
 * checkpoint faults — a snapshot write failure and a throwing hook — leave the
 * driver parking normally, never the legacy fatal `maintenance-error`. The legacy
 * `onMaintenance` behavior stays covered by its own driver-loop suite.
 */

const fixture = useWorld('c13-loop-checkpoint-');

const providerPolicy: ProviderPolicy = {
  delay: () => Promise.resolve(),
  schedule: () => () => {},
};

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

/** One advertised `execute` call: a turn that cannot park, so the driver chains. */
function executeCall(id: string, cmd: string): TransportResult {
  return {
    status: 200, complete: true, failure: null,
    body: Buffer.from(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id, type: 'function',
            function: { name: 'execute', arguments: JSON.stringify({ cmd }) },
          }],
        },
      }],
    })),
  };
}

/** The canonical `<seq>.json` rows on disk, as ascending seq numbers. */
async function canonicalRows(fx: WorldFixture): Promise<number[]> {
  const names = await readdir(snapshotsDir(fx));
  const seqs: number[] = [];
  for (const name of names) {
    const match = /^(0|[1-9][0-9]*)\.json$/.exec(name);
    if (match === null) continue;
    seqs.push(Number(match[1]));
  }
  return seqs.sort((a, b) => a - b);
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

function runtimeFor(fx: WorldFixture, config: AgentConfig, transport: ScriptedTransport): AgentRuntime {
  return createAgentRuntime({
    home: fx.home, uid: 'n1', world: fx.world, initialConfig: config,
    shellPolicy: shellPolicyFor(config),
    adapter: new ProviderAdapter(transport, providerPolicy),
  });
}

function openRuntime(
  fx: WorldFixture, runtime: AgentRuntime,
  onCheckpoint: (mark: DurableWatermark) => Promise<void> | void,
  onMaintenance?: () => Promise<void> | void,
): Promise<NodeDriver> {
  return NodeDriver.open(fx.home, 'n1', runtime.handler, fx.world, {
    knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
    onCheckpoint,
    ...(onMaintenance === undefined ? {} : { onMaintenance }),
  });
}

/** A one-shot signal driven by real work, never by a poll interval. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((fire) => { resolve = () => fire(); });
  return { promise, resolve };
}

/**
 * Runs to the signal that stands for the work the test needs, then tears the
 * driver down in a `finally`: a failing assertion can never leave the driver
 * writing while `useWorld` removes the fixture root. Racing the run's own
 * promise means a driver that dies before the signal surfaces that error and
 * still tears down, instead of awaiting a signal no live run can fire.
 */
async function runToSignal(driver: NodeDriver, signal: Promise<void>): Promise<void> {
  const running = driver.run();
  try {
    await Promise.race([signal, running]);
  } finally {
    driver.stop();
    await running;
  }
}

function snapshotsDir(fx: WorldFixture): string {
  return join(nodeDir(fx.home, 'n1'), 'snapshots');
}

describe('checkpoint wiring', () => {
  it('writes a verified checkpoint from the durable closer and round-trips it', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([noCalls('idle')]);
    const runtime = runtimeFor(fx, defaultAgentConfig(), transport);
    const marks: DurableWatermark[] = [];
    const parked = deferred();
    const driver = await openRuntime(fx, runtime, (mark) => {
      marks.push(mark);
      return runtime.checkpoint(mark);
    }, () => parked.resolve());
    await runToSignal(driver, parked.promise);

    const events = await loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
    const closer = events.filter((event) => event.type === 'turn/end').at(-1)!;
    expect(closer.data).toMatchObject({ outcome: 'waiting' });

    // One turn, one checkpoint: the mark is the durable closer's verified identity.
    expect(marks).toHaveLength(1);
    const mark = marks[0]!;
    expect(mark).toEqual({ seq: closer.raw.seq, hash: closer.raw.hash });
    // The mark is the fold's watermark after the durable closer.
    expect(runtime.snapshot().watermark).toEqual({ seq: mark.seq, hash: mark.hash });

    // The snapshot is on disk at the verified seq and reads back through the loader.
    await expect(access(join(snapshotsDir(fx), `${mark.seq}.json`))).resolves.toBeUndefined();
    const snap = await readSnapshot(fx.home, 'n1', events);
    expect(snap).not.toBeNull();
    expect(snap!.seq).toBe(mark.seq);
    expect(snap!.hash).toBe(mark.hash);
    expect(snap!.val.watermark).toEqual({ seq: mark.seq, hash: mark.hash });
  });

  it('writes one monotonic checkpoint per turn and keeps only the newest two', async () => {
    const fx = fixture();
    const base = defaultAgentConfig();
    // One step per turn: an `execute` response chains to the next turn, and the
    // final no-call response parks. Three turns, three durable closers.
    const config: AgentConfig = { ...base, policy: { ...base.policy, stepsPerTurn: 1 } };
    const transport = new ScriptedTransport([
      executeCall('c0', 'true'),
      executeCall('c1', 'true'),
      noCalls('idle'),
    ]);
    const runtime = runtimeFor(fx, config, transport);
    const marks: DurableWatermark[] = [];
    // The signal fires once the third checkpoint call has returned. `runToSignal`
    // then stops the driver and awaits the run, so the `access` below confirms the
    // row persists after stop — it is not a proof at signal time. Polling the mark
    // count let the test proceed mid-write and race fixture teardown under load.
    const thirdWritten = deferred();
    const driver = await openRuntime(fx, runtime, async (mark) => {
      marks.push(mark);
      await runtime.checkpoint(mark);
      if (marks.length === 3) thirdWritten.resolve();
    });
    await runToSignal(driver, thirdWritten.promise);

    // After the run has stopped, the newest retained row is readable from disk.
    await expect(access(join(snapshotsDir(fx), `${marks[2]!.seq}.json`))).resolves.toBeUndefined();

    expect(marks).toHaveLength(3);
    expect(marks[0]!.seq).toBeLessThan(marks[1]!.seq);
    expect(marks[1]!.seq).toBeLessThan(marks[2]!.seq);

    const events = await loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
    const closers = events.filter((event) => event.type === 'turn/end');
    expect(closers).toHaveLength(3);
    expect(marks.at(-1)).toEqual({ seq: closers.at(-1)!.raw.seq, hash: closers.at(-1)!.raw.hash });

    // One response per turn: checkpointing never re-executes a turn.
    expect(transport.sends).toHaveLength(3);

    // Retention: the newest two verified rows, nothing older.
    await expect(canonicalRows(fx)).resolves.toEqual([marks[1]!.seq, marks[2]!.seq]);
    const snap = await readSnapshot(fx.home, 'n1', events);
    expect(snap!.seq).toBe(marks[2]!.seq);
    expect(snap!.hash).toBe(marks[2]!.hash);
    expect(snap!.val.watermark).toEqual(marks[2]);
  });

  it.skipIf(process.getuid?.() === 0)('parks with no maintenance error when the snapshot write fails with EACCES', async () => {
    const fx = fixture();
    const dir = snapshotsDir(fx);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o500);
    try {
      // Prove the injected fault is in force: a write into the directory is refused.
      await expect(writeFile(join(dir, 'probe.json'), '{}'))
        .rejects.toMatchObject({ code: 'EACCES' });

      const transport = new ScriptedTransport([noCalls('idle')]);
      const runtime = runtimeFor(fx, defaultAgentConfig(), transport);
      const marks: DurableWatermark[] = [];
      const parked = deferred();
      const driver = await openRuntime(fx, runtime, (mark) => {
        marks.push(mark);
        return runtime.checkpoint(mark);
      }, () => parked.resolve());
      // Resolves after the parked closer, so the refused write never ended the run.
      await runToSignal(driver, parked.promise);

      expect(marks).toHaveLength(1);
      // The hook ran, but nothing durable landed: the write was refused, not thrown.
      const names = await readdir(dir);
      expect(names.filter((name) => name.endsWith('.json'))).toEqual([]);
      const events = await loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
      await expect(readSnapshot(fx.home, 'n1', events)).resolves.toBeNull();
      expect(events.filter((event) => event.type === 'turn/end').at(-1)?.data)
        .toMatchObject({ outcome: 'waiting' });
      // An ordinary stop, never the legacy fatal maintenance label.
      expect((events.at(-1)!.data as { reason: string }).reason).toBe('stop-requested');
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('parks with no maintenance error when the checkpoint hook throws', async () => {
    const fx = fixture();
    const transport = new ScriptedTransport([noCalls('idle')]);
    const runtime = runtimeFor(fx, defaultAgentConfig(), transport);
    let calls = 0;
    const parked = deferred();
    const driver = await openRuntime(fx, runtime, () => {
      calls += 1;
      throw new Error('injected checkpoint hook crash');
    }, () => parked.resolve());
    // Resolves after the parked closer, so the hook's throw was caught, not fatal.
    await runToSignal(driver, parked.promise);

    expect(calls).toBe(1);
    expect(transport.sends).toHaveLength(1);
    const events = await loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
    expect(events.filter((event) => event.type === 'turn/end').at(-1)?.data)
      .toMatchObject({ outcome: 'waiting' });
    expect((events.at(-1)!.data as { reason: string }).reason).toBe('stop-requested');
    await expect(readSnapshot(fx.home, 'n1', events)).resolves.toBeNull();
  });

  it('propagates a driver failure before the signal, instead of awaiting one that never fires', async () => {
    const fx = fixture();
    const boom = new Error('handler exploded');
    const driver = await NodeDriver.open(fx.home, 'n1', () => {
      throw boom;
    }, fx.world, { worldPollMs: 0 });
    // Explicit deferred that is never resolved: only the run's own rejection can
    // end the wait, so the helper must race it. The old `await signal` form hung
    // here until Vitest's own per-test bound, with the driver torn down too late.
    const never = deferred();
    await expect(runToSignal(driver, never.promise)).rejects.toBe(boom);

    // The failure still ran the driver's shutdown path to completion.
    const events = await readNode(fx.home);
    expect(events.at(-1)?.data).toEqual({ reason: 'handler-error', error: 'Error: handler exploded' });
    expect(driver.state).toBe('stopped');
  });
});
