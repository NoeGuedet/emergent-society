import { describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BlobStore, JournalWriter } from '../../journal/index.js';
import { withFailingWrite } from '../../journal/__tests__/helpers.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../../context/events.js';
import { loadVerifiedEvents, type VerifiedEvents } from '../../context/loader.js';
import { defaultAgentConfig } from '../../context/config.js';
import type { Source } from '../../context/contracts.js';
import type { BoundaryGate, DriverHooks } from '../gate.js';
import { GateClosedError } from '../gate.js';
import { NodeDriver, type TurnContext, type TurnResult } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { commitAs, useWorld, writeWorldFile } from './helpers.js';

const fixture = useWorld('node-boundary-');

const wait = (): TurnResult => ({ outcome: 'waiting', toolCalls: false });

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
    // closer reaches disk and the group is left open.
    await withFailingWrite(home, async () => {
      inject();
      await expect(running).rejects.toThrow('injected EIO');
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
