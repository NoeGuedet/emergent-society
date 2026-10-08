import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BlobIntegrityError, BlobStore, JournalWriter, MAX_BLOB_BYTES, TruncatedBlobError,
  isCorruption, isRetryable,
} from '../../journal/index.js';
import { withFailingWrite } from '../../journal/__tests__/helpers.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../../context/events.js';
import {
  loadVerifiedEvents, type VerifiedEvent, type VerifiedEvents,
} from '../../context/loader.js';
import { defaultAgentConfig } from '../../context/config.js';
import type { Source } from '../../context/contracts.js';
import type { BoundaryGate, DriverHooks, WorldAcknowledgement } from '../gate.js';
import { GateClosedError } from '../gate.js';
import { NodeDriver, type TurnContext, type TurnResult } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { WorldRepo, type WorldRange } from '../world.js';
import { commitAs, useWorld, writeWorldFile } from './helpers.js';

const fixture = useWorld('node-boundary-');

const wait = (): TurnResult => ({ outcome: 'waiting', toolCalls: false });

/** A structurally valid inline world perception for acknowledgement fixtures. */
function perceptionValue(range: WorldRange, text = '') {
  return {
    uid: 'n1', range, effectiveFrom: null, fallback: 'none',
    renderer: { policy: 'commit-patches-v1', gitVersion: 'git version 2.43.0', attrSource: 'to' },
    maxBytes: 32768, maxCommits: 4096, listTruncated: false,
    commits: [], included: [], omittedOwn: [], text, truncated: false,
  };
}

/** A reusable hook bundle over the real T1 loader and blob store. */
function hooksFor(home: string, over: Partial<DriverHooks> = {}): DriverHooks {
  return {
    registry: createBoundaryRegistry(),
    onDurable: async (): Promise<void> => {},
    onReady: async (): Promise<void> => {},
    onTurnStart: async (): Promise<void> => {},
    readHistory: (path: string, uid: string, knownTypes: ReadonlySet<string>) =>
      loadVerifiedEvents(path, uid, knownTypes),
    readBlob: (hash: string) => new BlobStore(home).get(hash),
    acknowledgedWorld: () => null,
    ...over,
  };
}

function read(home: string): Promise<VerifiedEvents> {
  return loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
}

type ToolCallData = {
  turn: number;
  request: { turn: number; ordinal: number };
  call: { id: string };
};

describe('trusted gate lifetime', () => {
  it('serves the handler a turn gate whose signal is the turn signal', async () => {
    const { home, world } = fixture();
    const durable: string[] = [];
    const hooks = hooksFor(home, {
      onDurable: async (events) => { for (const e of events) durable.push(e.type); },
    });
    const ref: { d: NodeDriver | null } = { d: null };
    let sameSignal = false;
    let source: Source | null = null;
    ref.d = await NodeDriver.open(home, 'n1', (ctx: TurnContext) => {
      sameSignal = ctx.gate.signal === ctx.signal;
      source = ctx.gate.append('compaction/abort', { id: 'c1', reason: 'orphan' });
      ref.d!.stop();
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await ref.d.run();
    expect(sameSignal).toBe(true);
    expect(source).toMatchObject({ seq: expect.any(Number), hash: expect.any(String) });
    expect(durable).toContain('compaction/abort');
    expect((await read(home)).some((e) => e.type === 'compaction/abort')).toBe(true);
  });

  it('revokes the turn gate after the turn closes', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const ref: { d: NodeDriver | null } = { d: null };
    let retained: BoundaryGate | null = null;
    ref.d = await NodeDriver.open(home, 'n1', (ctx: TurnContext) => {
      retained = ctx.gate;
      ref.d!.stop();
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await ref.d.run();
    expect(() => retained!.append('compaction/abort', { id: 'x', reason: 'orphan' }))
      .toThrow(GateClosedError);
    await expect(retained!.flush()).rejects.toThrow(GateClosedError);
    await expect(retained!.capture(new Uint8Array(), 'utf8')).rejects.toThrow(GateClosedError);
    await expect(retained!.store({ a: 1 })).rejects.toThrow(GateClosedError);
  });

  it('rejects a Node lifecycle type appended through the gate', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const ref: { d: NodeDriver | null } = { d: null };
    let rejected = false;
    ref.d = await NodeDriver.open(home, 'n1', (ctx: TurnContext) => {
      try {
        (ctx.gate as unknown as { append: (t: string, d: unknown) => unknown })
          .append('turn/end', {});
      } catch {
        rejected = true;
      }
      ref.d!.stop();
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await ref.d.run();
    expect(rejected).toBe(true);
    expect((await read(home)).filter((e) => e.type === 'turn/end')).toHaveLength(1);
  });

  it('keeps a hookless context gate closed to every boundary type', async () => {
    const { home, world } = fixture();
    const ref: { d: NodeDriver | null } = { d: null };
    let rejected = false;
    ref.d = await NodeDriver.open(home, 'n1', (ctx: TurnContext) => {
      expect(ctx.gate.signal).toBe(ctx.signal);
      try { ctx.gate.append('compaction/abort', { id: 'x', reason: 'orphan' }); }
      catch { rejected = true; }
      ref.d!.stop();
      return wait();
    }, world, { worldPollMs: 0 });
    await ref.d.run();
    expect(rejected).toBe(true);
  });
});

describe('the ordered durable observation seam', () => {
  it('observes a config flushed inside onTurnStart before it returns', async () => {
    const { home, world } = fixture();
    const observed: string[] = [];
    let sawConfigInside = false;
    const hooks = hooksFor(home, {
      onDurable: async (events) => { for (const e of events) observed.push(e.type); },
      onTurnStart: async (ctx) => {
        ctx.gate.append('compaction/abort', { id: 'a', reason: 'stale' });
        await ctx.gate.flush();
        sawConfigInside = observed.includes('compaction/abort');
      },
    });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', () => {
      ref.d!.stop();
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await ref.d.run();
    expect(sawConfigInside).toBe(true);
  });

  it('observes synthetic closers and boot before onReady, in order', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    w.append('node/boot', { reason: 'start' });
    w.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    await w.close();
    const order: string[] = [];
    const durableTypes: string[] = [];
    const hooks = hooksFor(home, {
      onDurable: async (events) => {
        order.push('durable');
        for (const e of events) durableTypes.push(e.type);
      },
      onReady: async () => { order.push('ready'); },
    });
    const d = await NodeDriver.open(home, 'n1', wait, world, {
      knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0,
    });
    d.stop();
    await d.run();
    expect(order[0]).toBe('durable');
    // The boot durability was observed before onReady ran.
    expect(order.indexOf('ready')).toBeGreaterThan(order.lastIndexOf('durable'));
    expect(durableTypes).toContain('turn/end');
    expect(durableTypes).toContain('node/boot');
    const end = (await read(home)).find((e) => e.type === 'turn/end');
    expect(end?.data).toMatchObject({ outcome: 'interrupted', synthetic: true });
  });

  it('delivers only newly appended observations and never unflushed data', async () => {
    const { home, world } = fixture();
    const batches: string[][] = [];
    const hooks = hooksFor(home, {
      onDurable: async (events) => { batches.push(events.map((e) => e.type)); },
    });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', async (ctx) => {
      ctx.gate.append('compaction/abort', { id: 'z', reason: 'orphan' });
      await ctx.gate.flush();
      ref.d!.stop();
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await ref.d.run();
    // The turn/start barrier is one batch; the appended event is delivered by
    // its own flush, not merged into an earlier batch.
    const flat = batches.flat();
    expect(flat).toContain('turn/start');
    expect(flat).toContain('compaction/abort');
    expect(batches.every((b) => b.length > 0)).toBe(true);
  });

  it('rejects hooks whose knownTypes omits a boundary type', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    await expect(NodeDriver.open(home, 'n1', wait, world, {
      knownTypes: new Set(['node/boot']), hooks, worldPollMs: 0,
    })).rejects.toThrow(/knownTypes/);
  });
});

describe('fatal seams', () => {
  it('holds the request barrier: a failed turn/start flush reaches no handler', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    let handlerCalls = 0;
    const d = await NodeDriver.open(home, 'n1', () => {
      handlerCalls += 1;
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0, batchWindowMs: 10_000 });
    await withFailingWrite(home, async () => {
      await expect(d.run()).rejects.toThrow('injected EIO');
    });
    expect(handlerCalls).toBe(0);
    expect(d.state).toBe('stopped');
    const events = await read(home);
    expect(events.some((e) => e.type === 'turn/start')).toBe(true);
    expect(events.some((e) => e.type === 'request/wire')).toBe(false);
  });

  it('rethrows the original handler error but journals a safe label under hooks', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const d = await NodeDriver.open(home, 'n1', () => { throw new Error('boom'); }, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await expect(d.run()).rejects.toThrow('boom');
    const events = await read(home);
    expect(events.find((e) => e.type === 'turn/end')?.data)
      .toMatchObject({ outcome: 'error', error: 'kernel invariant failure' });
    expect(events.find((e) => e.type === 'node/shutdown')?.data)
      .toMatchObject({ reason: 'handler-error', error: 'kernel invariant failure' });
  });

  it('preserves the legacy error string for a hookless handler throw', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', () => { throw new Error('boom'); }, world,
      { worldPollMs: 0 });
    await expect(d.run()).rejects.toThrow('boom');
    const events = await read(home);
    expect(events.find((e) => e.type === 'turn/end')?.data)
      .toMatchObject({ outcome: 'error', error: 'Error: boom' });
  });
});

describe('recoverable error results', () => {
  it('commits the effect, closes the turn durably, parks, and wakes on a foreign commit', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const seen: number[] = [];
    const d = await NodeDriver.open(home, 'n1', async (ctx) => {
      seen.push(ctx.turn);
      if (ctx.turn === 0) {
        await writeWorldFile(world, 'n1/effect.txt', 'x');
        return { outcome: 'error', toolCalls: false, error: { code: 'timeout', status: null } };
      }
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    const events = await read(home);
    const end = events.find((e) => e.type === 'turn/end');
    expect(end?.data).toMatchObject({ outcome: 'error', error: 'timeout null' });
    expect((end?.data as { commit?: string }).commit).toBe(await world.headHash());
    // Nonignorable: failed-turn evidence survives.
    expect(end?.ignorable).toBeUndefined();
    await commitAs(world, 'n2', { 'n2/hi.md': 'hi' });
    await HeadWatcher.for(world, 0).check();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    d.stop();
    await running;
  });
});

describe('reused-blob validation on resume', () => {
  it('rejects a resume whose reused claim-check blob was substituted', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const w = await JournalWriter.open(home, 'n1');
    const big = { ...defaultAgentConfig(), charter: 'c'.repeat(100 * 1024) };
    const receipt = w.append('system/message', { version: 1, value: { kind: 'inline', value: big } });
    await w.flush();
    await w.close();
    const ref = receipt.data as unknown as { blob?: string };
    if (typeof ref.blob !== 'string') throw new Error('expected a claim-check reference');
    await writeFile(join(home, 'blobs', ref.blob.slice(0, 2), ref.blob),
      JSON.stringify({ substituted: true }));
    await expect(NodeDriver.open(home, 'n1', wait, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 }))
      .rejects.toThrow(/digest|size|blob/i);
  });

  it('refuses a flagged truncated observation at the barrier before any delivery', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    const receipt = w.append('node/boot', { reason: 'start' });
    await w.flush();
    await w.close();
    // A resumed receipt whose raw journaled data is a flagged reference. The
    // blob is written for real, so its digest and byte length match exactly and
    // only the flag can stop delivery.
    const body = Buffer.alloc(MAX_BLOB_BYTES, 0x62);
    const blob = await new BlobStore(home).put(body);
    const forged: VerifiedEvent = {
      ...receipt,
      raw: {
        ...receipt,
        data: { blob, size: body.length, truncated: true },
      },
    };
    const delivered: string[] = [];
    const hooks = hooksFor(home, {
      onDurable: async (events) => { for (const e of events) delivered.push(e.type); },
      readHistory: async () => [forged],
    });
    await expect(NodeDriver.open(home, 'n1', wait, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 }))
      .rejects.toThrow(TruncatedBlobError);
    expect(delivered).toEqual([]);
  });

  it('rethrows a blob read EIO at the barrier as a retryable error, not corruption', async () => {
    const { home, world } = fixture();
    const w = await JournalWriter.open(home, 'n1');
    const big = { ...defaultAgentConfig(), charter: 'c'.repeat(100 * 1024) };
    w.append('system/message', { version: 1, value: { kind: 'inline', value: big } });
    await w.flush();
    await w.close();
    const eio = Object.assign(new Error('injected EIO'), { code: 'EIO' });
    let delivered = 0;
    const hooks = hooksFor(home, {
      readBlob: () => Promise.reject(eio),
      onDurable: async () => { delivered += 1; },
    });
    const err = await NodeDriver.open(home, 'n1', wait, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BlobIntegrityError);
    expect(isCorruption(err)).toBe(false);
    expect(isRetryable(err)).toBe(true);
    expect((err as { code?: string }).code).toBe('EIO');
    expect(delivered).toBe(0);
  });
});

/** The advertised calls and durable results of a journal. */
function recoveryOf(events: VerifiedEvents): { calls: ToolCallData[]; missing: ToolCallData[] } {
  const calls = events.filter((e) => e.type === 'tool/call').map((e) => e.data as ToolCallData);
  const results = events.filter((e) => e.type === 'tool/result')
    .map((e) => (e.data as unknown as { callId: string }).callId);
  const missing = calls.filter((call) => !results.includes(call.call.id));
  return { calls, missing };
}

/** A synthetic unknown-outcome result for a call with no durable result. */
function syntheticResult(call: ToolCallData) {
  return {
    turn: call.turn, request: call.request, callId: call.call.id,
    message: { role: 'tool', content: 'unknown outcome', tool_call_id: call.call.id },
    isError: true, raw: null, failure: null, synthetic: true,
  };
}

/**
 * Runs one turn that makes two tool calls durable and closes it with a durable
 * normal error closer while a later flush fails. `withResult` makes the first
 * call's result durable before the closer.
 */
async function makeIncompleteGroup(
  home: string, world: ReturnType<typeof fixture>['world'], withResult: boolean,
): Promise<void> {
  const hooks = hooksFor(home);
  let releaseHandler!: () => void;
  const handlerReached = new Promise<void>((r) => { releaseHandler = r; });
  let inject!: () => void;
  const injectionActive = new Promise<void>((r) => { inject = r; });
  const ref: { d: NodeDriver | null } = { d: null };
  ref.d = await NodeDriver.open(home, 'n1', async (ctx) => {
    ctx.gate.append('tool/call', {
      turn: ctx.turn, request: { turn: ctx.turn, ordinal: 0 },
      call: { id: 'call-1', type: 'function', function: { name: 'execute', arguments: '{}' } },
    });
    if (withResult) {
      ctx.gate.append('tool/result', {
        turn: ctx.turn, request: { turn: ctx.turn, ordinal: 0 }, callId: 'call-1',
        message: { role: 'tool', content: 'done', tool_call_id: 'call-1' },
        isError: false, raw: null, failure: null, synthetic: false,
      });
    }
    await ctx.gate.flush();
    releaseHandler();
    await injectionActive;
    ctx.gate.append('tool/call', {
      turn: ctx.turn, request: { turn: ctx.turn, ordinal: 1 },
      call: { id: 'call-2', type: 'function', function: { name: 'execute', arguments: '{}' } },
    });
    await ctx.gate.flush();
    return wait();
  }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0, batchWindowMs: 10_000 });
  const running = ref.d.run();
  await handlerReached;
  await withFailingWrite(home, async () => {
    inject();
    await expect(running).rejects.toThrow('injected EIO');
  });
}

describe('error-closer recovery at ready', () => {
  it('reconciles every missing call with a synthetic result and replays no effect', async () => {
    const { home, world } = fixture();
    await makeIncompleteGroup(home, world, false);
    const before = await read(home);
    const end = before.find((e) => e.type === 'turn/end');
    expect(end?.data).toMatchObject({ outcome: 'error' });
    expect(end?.ignorable).toBeUndefined();
    const { calls, missing } = recoveryOf(before);
    expect(calls).toHaveLength(2);
    expect(missing.map((c) => c.call.id).sort()).toEqual(['call-1', 'call-2']);

    const appended: ToolCallData[] = [];
    const second = hooksFor(home, {
      onReady: async (gate) => {
        for (const call of missing) {
          appended.push(call);
          gate.append('tool/result', syntheticResult(call) as never);
        }
        await gate.flush();
      },
    });
    let handlerCalls = 0;
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', () => {
      handlerCalls += 1;
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks: second, worldPollMs: 0 });
    const running = ref.d.run();
    await vi.waitFor(() => expect(ref.d!.state).toBe('waiting'));
    ref.d.stop();
    await running;

    const after = await read(home);
    const synthetic = after.filter((e) => e.type === 'tool/result'
      && (e.data as unknown as { synthetic: boolean }).synthetic);
    expect(synthetic).toHaveLength(2);
    expect(synthetic.map((e) => (e.data as unknown as { callId: string }).callId).sort())
      .toEqual(['call-1', 'call-2']);
    // No effect replayed: the recovery appended facts, it did not re-execute.
    expect(appended).toHaveLength(2);
    expect(handlerCalls).toBe(1);
    expect(await world.headHash()).toBeNull();
  });

  it('recovers a no-closer fatal shutdown through a synthetic interrupted closer', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    let releaseHandler!: () => void;
    const handlerReached = new Promise<void>((r) => { releaseHandler = r; });
    let inject!: () => void;
    const injectionActive = new Promise<void>((r) => { inject = r; });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', async (ctx) => {
      ctx.gate.append('tool/call', {
        turn: ctx.turn, request: { turn: ctx.turn, ordinal: 0 },
        call: { id: 'solo', type: 'function', function: { name: 'execute', arguments: '{}' } },
      });
      await ctx.gate.flush();
      releaseHandler();
      await injectionActive;
      throw new Error('boom after flush');
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0, batchWindowMs: 10_000 });
    const running = ref.d.run();
    await handlerReached;
    // Two writes fail: the error closer's flush and close()'s retry, so no
    // closer reaches disk and the group is left open. The handler's own failure
    // is what reaches the caller: a commit or closer fault must not displace it.
    await withFailingWrite(home, async () => {
      inject();
      await expect(running).rejects.toThrow('boom after flush');
    }, 2);
    const before = await read(home);
    expect(before.some((e) => e.type === 'turn/end')).toBe(false);
    const { missing } = recoveryOf(before);
    expect(missing.map((c) => c.call.id)).toEqual(['solo']);

    const second = hooksFor(home, {
      onReady: async (gate) => {
        for (const call of missing) gate.append('tool/result', syntheticResult(call) as never);
        await gate.flush();
      },
    });
    const ref2: { d: NodeDriver | null } = { d: null };
    ref2.d = await NodeDriver.open(home, 'n1', wait, world,
      { knownTypes: C13_EVENT_TYPES, hooks: second, worldPollMs: 0 });
    ref2.d.stop();
    await ref2.d.run();
    const after = await read(home);
    expect(after.find((e) => e.type === 'turn/end')?.data)
      .toMatchObject({ outcome: 'interrupted', synthetic: true });
    expect(after.some((e) => e.type === 'tool/result'
      && (e.data as unknown as { synthetic: boolean }).synthetic)).toBe(true);
  });

  it('leaves a call with a durable result unreconciled and fabricates no unknown outcome', async () => {
    const { home, world } = fixture();
    await makeIncompleteGroup(home, world, true);
    const before = await read(home);
    const { missing } = recoveryOf(before);
    expect(missing.map((c) => c.call.id)).toEqual(['call-2']);

    const second = hooksFor(home, {
      onReady: async (gate) => {
        for (const call of missing) gate.append('tool/result', syntheticResult(call) as never);
        await gate.flush();
      },
    });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', wait, world,
      { knownTypes: C13_EVENT_TYPES, hooks: second, worldPollMs: 0 });
    ref.d.stop();
    await ref.d.run();
    const after = await read(home);
    const synthetic = after.filter((e) => e.type === 'tool/result'
      && (e.data as unknown as { synthetic: boolean }).synthetic);
    expect(synthetic.map((e) => (e.data as unknown as { callId: string }).callId)).toEqual(['call-2']);
    // The real result for call-1 is still the only one, and no second result exists.
    expect(after.filter((e) => e.type === 'tool/result'
      && (e.data as unknown as { callId: string }).callId === 'call-1')).toHaveLength(1);
  });
});

/** A hook object literal missing one required port, for the early-refusal tests. */
function withoutPort(hooks: DriverHooks, port: string): DriverHooks {
  const stripped = { ...hooks } as unknown as Record<string, unknown>;
  delete stripped[port];
  return stripped as unknown as DriverHooks;
}

describe('the world acknowledgement proof', () => {
  it('accepts a proof whose source is a delivered world/perception and advances nothing else', async () => {
    const { home, world } = fixture();
    let ack: WorldAcknowledgement | null = null;
    const hooks = hooksFor(home, {
      onTurnStart: async (ctx) => {
        const source = ctx.gate.append('world/perception', {
          turn: ctx.turn, range: ctx.world,
          value: { kind: 'inline', value: perceptionValue(ctx.world) },
        } as never);
        await ctx.gate.flush();
        ack = { turn: ctx.turn, range: { from: ctx.world.from, to: ctx.world.to }, source };
      },
      acknowledgedWorld: () => ack,
    });
    let handlerCalls = 0;
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', () => {
      handlerCalls += 1;
      ref.d!.stop();
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await ref.d.run();
    expect(handlerCalls).toBe(1);
    expect((await read(home)).some((e) => e.type === 'world/perception')).toBe(true);
  });

  it('rejects a proof whose source is a pending, undelivered receipt', async () => {
    const { home, world } = fixture();
    let cited: Source | null = null;
    let handlerCalls = 0;
    const hooks = hooksFor(home, {
      onTurnStart: async (ctx) => {
        // Appended but never flushed: the receipt is pending, delivered nowhere.
        cited = ctx.gate.append('world/perception', {
          turn: ctx.turn, range: ctx.world,
          value: { kind: 'inline', value: perceptionValue(ctx.world) },
        } as never);
      },
      acknowledgedWorld: () => (cited === null
        ? null
        : { turn: 0, range: { from: null, to: null }, source: cited }),
    });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', () => { handlerCalls += 1; return wait(); }, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0, batchWindowMs: 10_000 });
    await expect(ref.d.run()).rejects.toThrow(/delivered observation/);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a proof whose source is a delivered observation of the wrong type', async () => {
    const { home, world } = fixture();
    let startSource: Source | null = null;
    let handlerCalls = 0;
    const hooks = hooksFor(home, {
      onDurable: async (events) => {
        for (const event of events) {
          if (event.type === 'turn/start') startSource = { seq: event.raw.seq, hash: event.raw.hash };
        }
      },
      acknowledgedWorld: () => (startSource === null
        ? null
        : { turn: 0, range: { from: null, to: null }, source: startSource }),
    });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', () => { handlerCalls += 1; return wait(); }, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await expect(ref.d.run()).rejects.toThrow(/not world\/perception/);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a proof whose turn is not the current turn, before any effect', async () => {
    const { home, world } = fixture();
    let ack: WorldAcknowledgement | null = null;
    let handlerCalls = 0;
    const hooks = hooksFor(home, { acknowledgedWorld: () => ack });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', () => { handlerCalls += 1; return wait(); }, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    ack = { turn: 7, range: { from: null, to: null }, source: { seq: 0, hash: 'a'.repeat(64) } };
    await expect(ref.d.run()).rejects.toThrow(/current turn/);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a proof whose range is not the turn opening range, before any effect', async () => {
    const { home, world } = fixture();
    let ack: WorldAcknowledgement | null = null;
    let handlerCalls = 0;
    const hooks = hooksFor(home, { acknowledgedWorld: () => ack });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', () => { handlerCalls += 1; return wait(); }, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    ack = { turn: 0, range: { from: null, to: 'b'.repeat(40) }, source: { seq: 0, hash: 'a'.repeat(64) } };
    await expect(ref.d.run()).rejects.toThrow(/range/);
    expect(handlerCalls).toBe(0);
  });

  it('treats a null proof as no acknowledgement and lets the handler run', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home, { acknowledgedWorld: () => null });
    let handlerCalls = 0;
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', () => {
      handlerCalls += 1;
      ref.d!.stop();
      return wait();
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await ref.d.run();
    expect(handlerCalls).toBe(1);
  });
});

describe('hook contract refusals', () => {
  it('refuses a hooks bundle that does not expose acknowledgedWorld', async () => {
    const { home, world } = fixture();
    const hooks = withoutPort(hooksFor(home), 'acknowledgedWorld');
    await expect(NodeDriver.open(home, 'n1', wait, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 })).rejects.toThrow(/acknowledgedWorld/);
  });

  it('refuses provided knownTypes that omit a node lifecycle type', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const known = new Set([...C13_EVENT_TYPES].filter((type) => type !== 'node/shutdown'));
    await expect(NodeDriver.open(home, 'n1', wait, world,
      { knownTypes: known, hooks, worldPollMs: 0 })).rejects.toThrow(/node\/shutdown/);
  });

  it('journals a fixed maintenance label under hooks, never the raw message', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const d = await NodeDriver.open(home, 'n1', wait, world, {
      knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0,
      onMaintenance: () => { throw new Error('secret api key sk-live-123'); },
    });
    await expect(d.run()).rejects.toThrow('secret api key sk-live-123');
    const shutdown = (await read(home)).find((e) => e.type === 'node/shutdown');
    expect(shutdown?.data).toEqual({ reason: 'maintenance-error', error: 'maintenance failure' });
  });

  it('fails a turn whose toolCalls report disagrees with the accepted gate', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      ctx.gate.append('tool/call', {
        turn: ctx.turn, request: { turn: ctx.turn, ordinal: 0 },
        call: { id: 'c1', type: 'function', function: { name: 'execute', arguments: '{}' } },
      });
      return { outcome: 'waiting', toolCalls: false };
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
    await expect(d.run()).rejects.toThrow(/toolCalls/);
    const end = (await read(home)).find((e) => e.type === 'turn/end');
    expect(end?.data).toMatchObject({ outcome: 'error', error: 'kernel invariant failure' });
    expect(end?.ignorable).toBeUndefined();
  });
});

describe('gate revocation on every failure path', () => {
  it('revokes the gate when the turn/start barrier flush fails', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    const d = await NodeDriver.open(home, 'n1', wait, world,
      { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0, batchWindowMs: 10_000 });
    let retained: BoundaryGate | null = null;
    const loose = d as unknown as {
      makeGate: (phase: string, turn: number | null, signal: AbortSignal) =>
        { gate: BoundaryGate; close: () => void };
    };
    const original = loose.makeGate.bind(d);
    loose.makeGate = (phase, turn, signal) => {
      const created = original(phase, turn, signal);
      if (phase === 'turn') retained = created.gate;
      return created;
    };
    await withFailingWrite(home, async () => {
      await expect(d.run()).rejects.toThrow('injected EIO');
    });
    expect(retained).not.toBeNull();
    expect(() => retained!.append('compaction/abort', { id: 'x', reason: 'orphan' }))
      .toThrow(GateClosedError);
    await expect(retained!.flush()).rejects.toThrow(GateClosedError);
  });

  it('revokes the gate when the commit fails', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    let retained: BoundaryGate | null = null;
    const spy = vi.spyOn(WorldRepo.prototype, 'commitAll').mockRejectedValue(new Error('commit dead'));
    try {
      const d = await NodeDriver.open(home, 'n1', (ctx) => {
        retained = ctx.gate;
        return wait();
      }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0 });
      await expect(d.run()).rejects.toThrow('commit dead');
      expect(retained).not.toBeNull();
      expect(() => retained!.append('compaction/abort', { id: 'x', reason: 'orphan' }))
        .toThrow(GateClosedError);
    } finally {
      spy.mockRestore();
    }
  });

  it('revokes the gate when the error closer cannot flush', async () => {
    const { home, world } = fixture();
    const hooks = hooksFor(home);
    let retained: BoundaryGate | null = null;
    let release!: () => void;
    const reached = new Promise<void>((r) => { release = r; });
    let inject!: () => void;
    const active = new Promise<void>((r) => { inject = r; });
    const ref: { d: NodeDriver | null } = { d: null };
    ref.d = await NodeDriver.open(home, 'n1', async (ctx) => {
      retained = ctx.gate;
      await ctx.gate.flush();
      release();
      await active;
      throw new Error('boom');
    }, world, { knownTypes: C13_EVENT_TYPES, hooks, worldPollMs: 0, batchWindowMs: 10_000 });
    const running = ref.d.run();
    await reached;
    await withFailingWrite(home, async () => {
      inject();
      await expect(running).rejects.toThrow('boom');
    }, 2);
    expect(retained).not.toBeNull();
    expect(() => retained!.append('compaction/abort', { id: 'x', reason: 'orphan' }))
      .toThrow(GateClosedError);
    await expect(retained!.capture(new Uint8Array(), 'utf8')).rejects.toThrow(GateClosedError);
    await expect(retained!.store({ a: 1 })).rejects.toThrow(GateClosedError);
  });
});
