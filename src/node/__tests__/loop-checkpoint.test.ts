import { describe, expect, it, vi } from 'vitest';
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
import { useWorld, type WorldFixture } from './helpers.js';

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
): Promise<NodeDriver> {
  return NodeDriver.open(fx.home, 'n1', runtime.handler, fx.world, {
    knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
    onCheckpoint,
  });
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
    const driver = await openRuntime(fx, runtime, (mark) => {
      marks.push(mark);
      return runtime.checkpoint(mark);
    });
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running;

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

  it('parks with no maintenance error when the snapshot write fails with EACCES', async () => {
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
      const driver = await openRuntime(fx, runtime, (mark) => {
        marks.push(mark);
        return runtime.checkpoint(mark);
      });
      const running = driver.run();
      await vi.waitFor(() => expect(driver.state).toBe('waiting'));
      driver.stop();
      await running; // resolves: the checkpoint failure never ended the run

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
    const driver = await openRuntime(fx, runtime, () => {
      calls += 1;
      throw new Error('injected checkpoint hook crash');
    });
    const running = driver.run();
    await vi.waitFor(() => expect(driver.state).toBe('waiting'));
    driver.stop();
    await running; // resolves: the hook's throw was caught, not fatal

    expect(calls).toBe(1);
    expect(transport.sends).toHaveLength(1);
    const events = await loadVerifiedEvents(fx.home, 'n1', C13_EVENT_TYPES);
    expect(events.filter((event) => event.type === 'turn/end').at(-1)?.data)
      .toMatchObject({ outcome: 'waiting' });
    expect((events.at(-1)!.data as { reason: string }).reason).toBe('stop-requested');
    await expect(readSnapshot(fx.home, 'n1', events)).resolves.toBeNull();
  });
});
