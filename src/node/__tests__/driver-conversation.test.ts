import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectEvents } from '../../journal/__tests__/helpers.js';
import { NODE_EVENT_TYPES, type TurnTrigger } from '../events.js';
import type { TurnContext, TurnResult } from '../driver.js';
import { ConversationLog } from '../conversation.js';
import { ConversationWatcher } from '../conversation-watcher.js';
import type { ConversationNotice, ConversationSource } from '../conversation-watcher.js';
import { HeadWatcher } from '../watcher.js';
import { commitAs, openTestDriver, useWorld } from './helpers.js';

/**
 * The conversation wake at the driver level (A3): the second subscription
 * inside every park, the boot-rule notice, the `'conversation'` trigger, and
 * one message waking ONE recipient.
 */

const fixture = useWorld('node-conversation-driver-');
const running: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of running.splice(0)) await stop().catch(() => {});
});

const execFileAsync = promisify(execFile);

/** Appends one line from another process, with no in-process poke. */
async function foreignAppend(path: string, record: Record<string, unknown>): Promise<void> {
  const script = 'require("node:fs").appendFileSync(process.argv[1], process.argv[2] + "\\n")';
  await execFileAsync(process.execPath, ['-e', script, path, JSON.stringify(record)]);
}

type Seen = { readonly uid: string; readonly trigger: TurnTrigger };

/**
 * The runtime's read-and-clear at the handler boundary: consume the pending
 * notice when one is present (a sent request clears it), then park. `seen`
 * records what each turn rendered.
 */
function handlerFor(
  watcher: ConversationWatcher, uid: string, seen: Seen[],
  consume: boolean,
): (ctx: TurnContext) => TurnResult {
  return (ctx: TurnContext): TurnResult => {
    const notice = watcher.noticeFor(uid);
    if (notice !== null && consume) watcher.consume(uid, notice.version);
    seen.push({ uid, trigger: ctx.trigger });
    return { outcome: 'waiting', toolCalls: false };
  };
}

/**
 * A source whose listeners can be captured and fired BY HAND: the park epoch
 * is only observable when a stale park's evaluation can be replayed after the
 * park ended, which no real watcher allows.
 */
class FakeConversationSource implements ConversationSource {
  private readonly active = new Set<() => void>();
  private readonly history: (() => void)[] = [];
  private notice: ConversationNotice | null = null;

  subscribe(listener: () => void): () => void {
    this.active.add(listener);
    this.history.push(listener);
    return () => { this.active.delete(listener); };
  }

  noticeFor(): ConversationNotice | null {
    return this.notice;
  }

  async armBoot(): Promise<void> { /* the boot rule is not this test's subject */ }

  get subscriberCount(): number {
    return this.active.size;
  }

  arm(notice: ConversationNotice): void {
    this.notice = notice;
  }

  /** Replays the FIRST park's evaluation — a stale epoch. */
  emitStale(): void {
    this.history[0]?.();
  }

  /** Fires the currently subscribed (current-park) listeners. */
  emitCurrent(): void {
    for (const listener of [...this.active]) listener();
  }
}

const triggers = async (home: string, uid: string): Promise<TurnTrigger[]> => {
  const events = await collectEvents(home, NODE_EVENT_TYPES, uid);
  return events.filter((event) => event.type === 'turn/start')
    .map((event) => (event.data as { trigger: TurnTrigger }).trigger);
};

describe('the conversation wake', () => {
  it('arms the boot-rule notice from the thread tail and consumes it in the first turn', async () => {
    const { home, world } = fixture();
    const watcher = ConversationWatcher.for(home, 0);
    await ConversationLog.for(home).append('gateway', 'n1', 'before the boot');
    const seen: Seen[] = [];
    const d = await openTestDriver(home, 'n1', handlerFor(watcher, 'n1', seen, true), world, {
      worldPollMs: 0, conversation: watcher,
    });
    expect(watcher.noticeFor('n1')).toMatchObject({ count: 1, newestFrom: 'gateway' });
    const run = d.run();
    running.push(async () => { d.stop(); await run; });
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    // The boot notice was consumed by the first turn, so the first park does
    // not immediately wake again (one possibly-redundant consult per boot).
    expect(seen).toEqual([{ uid: 'n1', trigger: 'boot' }]);
    expect(watcher.noticeFor('n1')).toBeNull();
    d.stop();
    await run;
    expect(watcher.subscriberCount).toBe(0);
  });

  it('wakes only the addressed parked driver, with the conversation trigger', async () => {
    const { home, world } = fixture();
    const watcher = ConversationWatcher.for(home, 0);
    const seen: Seen[] = [];
    const a = await openTestDriver(home, 'n1', handlerFor(watcher, 'n1', seen, true), world, {
      worldPollMs: 0, conversation: watcher,
    });
    const b = await openTestDriver(home, 'n2', handlerFor(watcher, 'n2', seen, true), world, {
      worldPollMs: 0, conversation: watcher,
    });
    const runA = a.run();
    const runB = b.run();
    running.push(async () => { a.stop(); b.stop(); await Promise.all([runA, runB]); });
    await vi.waitFor(() => {
      expect(a.state).toBe('waiting');
      expect(b.state).toBe('waiting');
      expect(watcher.subscriberCount).toBe(2);
    });
    // The wake is not HEAD-conditioned: the world is byte-identically still.
    const head = await world.headHash();
    // A foreign process appends a record addressed to n2; the watcher's stat
    // check (the interval's tick) is the only in-kernel effect.
    await foreignAppend(join(home, 'conversation.v0.jsonl'), {
      v: 0, at: Date.now(), from: 'gateway', to: 'n2', text: 'for node two',
    });
    await watcher.check();
    expect(await world.headHash()).toBe(head);
    await vi.waitFor(() => expect(seen.filter((entry) => entry.uid === 'n2')).toHaveLength(2));
    // One message wakes ONE recipient: n1's park was evaluated and stayed put.
    expect(seen.filter((entry) => entry.uid === 'n1')).toHaveLength(1);
    expect(a.state).toBe('waiting');
    expect(await triggers(home, 'n2')).toEqual(['boot', 'conversation']);
    expect(await triggers(home, 'n1')).toEqual(['boot']);
    a.stop();
    b.stop();
    await Promise.all([runA, runB]);
    expect(watcher.subscriberCount).toBe(0);
  });

  it('a stale park-epoch evaluation cannot arm the next park', async () => {
    const { home, world } = fixture();
    const fake = new FakeConversationSource();
    const seen: Seen[] = [];
    const noticeChecks = vi.spyOn(fake, 'noticeFor');
    const d = await openTestDriver(home, 'n1', (ctx: TurnContext) => {
      seen.push({ uid: 'n1', trigger: ctx.trigger });
      return { outcome: 'waiting', toolCalls: false };
    }, world, { worldPollMs: 0, conversation: fake });
    const run = d.run();
    running.push(async () => { d.stop(); await run; });
    // Park 1: the fake holds the first listener and its own initial notice
    // check has completed before any notice exists.
    await vi.waitFor(() => {
      expect(d.state).toBe('waiting');
      expect(fake.subscriberCount).toBe(1);
      expect(noticeChecks).toHaveBeenCalledTimes(1);
    });
    // A foreign commit ends park 1 and opens its wakeup turn; park 2 takes its
    // own subscription, and park 1's listener is removed.
    await commitAs(world, 'n2', { 'moved.txt': 'moved\n' }, 'foreign');
    HeadWatcher.for(world, 0).poke();
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 10_000 });
    expect(seen[1]!.trigger).toBe('wakeup');
    await vi.waitFor(() => {
      expect(d.state).toBe('waiting');
      expect(fake.subscriberCount).toBe(1);
      // Readiness gate: park 2's own initial `armConversationIfDue` check has
      // finished (its second noticeFor) BEFORE a notice is armed. Without this,
      // the initial check could see the armed notice and mask a broken epoch
      // guard by waking for the wrong reason.
      expect(noticeChecks).toHaveBeenCalledTimes(2);
    });
    // A notice arms while park 2 is parked. Replaying park 1's (stale)
    // evaluation must not arm park 2's latch; its own listener must.
    const checksBeforeStale = noticeChecks.mock.calls.length;
    fake.arm({ count: 1, newestFrom: 'gateway', version: 1 });
    fake.emitStale();
    // Synchronous, timing-free distinguishing assertion: the stale epoch must
    // return before consulting the source at all (removing the epoch guard
    // makes this call happen here).
    expect(noticeChecks).toHaveBeenCalledTimes(checksBeforeStale);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(seen).toHaveLength(2);
    expect(d.state).toBe('waiting');
    fake.emitCurrent();
    // The current park's listener did consult the source synchronously for this
    // wake; a later park's own initial check may add one more, so assert the
    // immediate transition only.
    expect(noticeChecks).toHaveBeenCalledTimes(checksBeforeStale + 1);
    await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 10_000 });
    expect(seen[2]).toEqual({ uid: 'n1', trigger: 'conversation' });
    d.stop();
    await run;
  });

  it('does not spin a park when an unconsumed notice is still pending', async () => {
    const { home, world } = fixture();
    const watcher = ConversationWatcher.for(home, 0);
    const seen: Seen[] = [];
    // The handler never consumes: the notice stays pending, exactly as after a
    // failed request (a failed request does not consume it).
    const d = await openTestDriver(home, 'n1', handlerFor(watcher, 'n1', seen, false), world, {
      worldPollMs: 0, conversation: watcher,
    });
    const run = d.run();
    running.push(async () => { d.stop(); await run; });
    await vi.waitFor(() => expect(d.state).toBe('waiting'));
    await ConversationLog.for(home).append('gateway', 'n1', 'not yet consumed');
    await watcher.check();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    // The notice is still pending, but the same version does not re-wake the
    // park: the next attempt belongs to a later wake, not to a hot loop.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(seen).toEqual([
      { uid: 'n1', trigger: 'boot' },
      { uid: 'n1', trigger: 'conversation' },
    ]);
    // Consuming it and receiving a new record wakes again.
    const pending = watcher.noticeFor('n1')!;
    watcher.consume('n1', pending.version);
    await ConversationLog.for(home).append('gateway', 'n1', 'a new one');
    await watcher.check();
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[2]).toEqual({ uid: 'n1', trigger: 'conversation' });
    d.stop();
    await run;
  });
});
