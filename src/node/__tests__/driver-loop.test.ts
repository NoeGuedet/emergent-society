import { describe, expect, it, vi } from 'vitest';
import { collectEvents, withFailingWrite } from '../../journal/__tests__/helpers.js';
import { NodeDriver, type TurnContext, type TurnTrigger } from '../driver.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { useWorld } from './helpers.js';

const fixture = useWorld('node-loop-');

const wait = (): { outcome: 'waiting'; toolCalls: boolean } => ({ outcome: 'waiting', toolCalls: false });

/** A minimal typed view of the driver's private writer, for fault injection. */
type LooseWriter = { append: (...args: unknown[]) => unknown; close(): Promise<unknown> };

function log(home: string) {
  return collectEvents(home, NODE_EVENT_TYPES, 'n1');
}

describe('NodeDriver run loop', () => {
  it('chains turns with trigger chain until the handler waits', async () => {
    const { home, world } = fixture();
    const triggers: TurnTrigger[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      triggers.push(ctx.trigger);
      return { outcome: triggers.length < 3 ? 'chained' : 'waiting', toolCalls: true };
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    expect(triggers).toEqual(['boot', 'chain', 'chain']);
    expect((await log(home)).map((e) => e.type)).toEqual([
      'node/boot',
      'turn/start', 'turn/end',
      'turn/start', 'turn/end',
      'turn/start', 'turn/end',
      'node/shutdown',
    ]);
    expect(d.state).toBe('stopped');
  });

  it('opens every turn on the world range it perceives', async () => {
    const { home, world } = fixture();
    const ranges: unknown[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx) => {
      ranges.push(ctx.world);
      return wait();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    // An unborn world: the watermark is null and HEAD is null, and the range
    // says so rather than pretending the node has seen a commit.
    expect(ranges).toEqual([{ from: null, to: null }]);
    expect((await log(home)).find((e) => e.type === 'turn/start')?.data)
      .toEqual({ turn: 0, trigger: 'boot', world: { from: null, to: null } });
  });

  it('journals an error turn and shuts down when the handler throws', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', () => {
      throw new Error('boom');
    }, world, { worldPollMs: 0 });
    await expect(d.run()).rejects.toThrow('boom');
    const events = await log(home);
    expect(events.at(-2)?.data).toMatchObject({ outcome: 'error', error: 'Error: boom' });
    expect(events.at(-1)?.data).toEqual({ reason: 'handler-error', error: 'Error: boom' });
    expect(d.state).toBe('stopped');
  });

  it('propagates the handler error when the shutdown append also fails', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', () => {
      throw new Error('boom');
    }, world, { worldPollMs: 0 });
    // Fault injection: nothing outside the driver can reach the writer, so the
    // private field is patched to fail exactly where a poisoned writer or a
    // recorded write-behind failure would — the shutdown append.
    type LooseAppend = (...args: unknown[]) => unknown;
    const writer = (d as unknown as { writer: { append: LooseAppend } }).writer;
    const realAppend = writer.append.bind(writer);
    writer.append = (type: unknown, ...rest: unknown[]) => {
      if (type === 'node/shutdown') throw new Error('append dead');
      return realAppend(type, ...rest);
    };
    await expect(d.run()).rejects.toThrow('boom');
    expect(d.state).toBe('stopped');
  });

  it('propagates the handler error and still stops when close() fails', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', () => {
      throw new Error('boom');
    }, world, { worldPollMs: 0 });
    // Same fault-injection technique as the shutdown-append test: the writer is
    // private, so the field is reached through an annotated cast.
    type LooseClose = () => Promise<unknown>;
    const writer = (d as unknown as { writer: { close: LooseClose } }).writer;
    const realClose = writer.close.bind(writer);
    writer.close = async () => {
      // Release the lock and handle for real, then fail the way a poisoned
      // writer's close does: the run must survive it.
      await realClose();
      throw new Error('close dead');
    };
    await expect(d.run()).rejects.toThrow('boom');
    expect(d.state).toBe('stopped');
  });

  it('runs maintenance once per park', async () => {
    const { home, world } = fixture();
    let maintenanceCalls = 0;
    const d = await NodeDriver.open(home, 'n1', wait, world, {
      worldPollMs: 0, onMaintenance: () => { maintenanceCalls += 1; },
    });
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    expect(maintenanceCalls).toBe(1);
  });

  it('rejects a run() called out of order', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    await expect(d.run()).rejects.toThrow('run() out of order');
    d.stop();
    await running;
  });

  it('stops cleanly with node/shutdown journaled when stop() precedes run()', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    d.stop();
    await d.run();
    expect(d.state).toBe('stopped');
    const events = await log(home);
    expect(events.map((e) => e.type)).toEqual(['node/boot', 'node/shutdown']);
    expect(events[1]?.data).toEqual({ reason: 'stop-requested' });
  });

  it('wakes a parked node when stop() is called', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    expect(d.state).toBe('stopped');
    expect((await log(home)).filter((e) => e.type === 'turn/start')).toHaveLength(1);
  });

  it('shuts down with reason maintenance-error when the maintenance hook throws', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', wait, world, {
      worldPollMs: 0, onMaintenance: () => { throw new Error('maint boom'); },
    });
    await expect(d.run()).rejects.toThrow('maint boom');
    expect(d.state).toBe('stopped');
    expect((await log(home)).at(-1)?.data)
      .toEqual({ reason: 'maintenance-error', error: 'Error: maint boom' });
  });

  it('labels a loop death outside the handler as driver-error, with its error', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    // Fault injection: the append that opens the turn must fail so the loop
    // dies outside the handler — a handler-error would be a lie in the journal.
    const writer = (d as unknown as { writer: LooseWriter }).writer;
    const realAppend = writer.append.bind(writer);
    writer.append = (type: unknown, ...rest: unknown[]) => {
      if (type === 'turn/start') throw new Error('barrier dead');
      return realAppend(type, ...rest);
    };
    await expect(d.run()).rejects.toThrow('barrier dead');
    expect(d.state).toBe('stopped');
    const shutdown = (await log(home)).find((e) => e.type === 'node/shutdown');
    expect(shutdown?.data).toEqual({ reason: 'driver-error', error: 'Error: barrier dead' });
  });

  it('journals driver-error when the flush barrier itself rejects', async () => {
    const { home, world } = fixture();
    const d = await NodeDriver.open(home, 'n1', wait, world, { worldPollMs: 0 });
    // The recorded-write-behind shape: append() accepts, the barrier flush
    // fails. The failure is injected at the fs primitive the writer uses, so
    // nothing in the driver can be blamed for it.
    await withFailingWrite(home, async () => {
      await expect(d.run()).rejects.toThrow('injected EIO');
    });
    expect(d.state).toBe('stopped');
    const shutdown = (await log(home)).find((e) => e.type === 'node/shutdown');
    expect(shutdown?.data).toEqual({ reason: 'driver-error', error: 'Error: injected EIO' });
  });

  it('serves the handler a turn context with no writer and no commit', async () => {
    const { home, world } = fixture();
    let keys: string[] = [];
    const d = await NodeDriver.open(home, 'n1', (ctx: TurnContext) => {
      keys = Object.keys(ctx).sort();
      return wait();
    }, world, { worldPollMs: 0 });
    const running = d.run();
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    d.stop();
    await running;
    // The handler cannot journal and cannot commit: the driver owns both.
    expect(keys).toEqual(['now', 'trigger', 'turn', 'world']);
  });
});
