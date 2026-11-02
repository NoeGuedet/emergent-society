import type { HostLog } from '../host/observe.js';
import type { ChatLog } from '../host/chat.js';
import { ChatWatcher } from '../host/chat-watcher.js';
import type { ConversationLog } from '../node/conversation.js';
import { ConversationWatcher } from '../node/conversation-watcher.js';
import type { OverlayConfig } from './charter.js';
import { runOverlayCycle, type OverlaySend } from './cycle.js';
import type { OverlayWorld } from './world-read.js';

/**
 * The gateway overlay's SERVICE: the cycle's loop, both watchers, and the one
 * dirty flag.
 *
 * ONE CYCLE PER COALESCED NOTIFICATION. The trigger is addressee-filtered on
 * both surfaces: the conversation watcher counts records whose `to` is the
 * reserved gateway, and the cycle fires only when that count grew (the
 * overlay's own sends name a node addressee and never re-trigger); the chat
 * watcher notifies only when a `uid: human` record grew the log (the overlay's
 * own `uid: gateway` deliveries never re-trigger). A notification from either
 * surface sets ONE dirty flag — no counting, no queue of events — so a burst
 * collapses into one cycle, whichever surface(s) moved.
 *
 * CYCLES ARE SERIALIZED: one at a time. A notification that arrives mid-cycle
 * only sets the flag again, and the loop runs exactly one more cycle afterwards
 * — never a second cycle in parallel, and never one per record.
 *
 * THE BOOT CYCLE: `start` sets the flag exactly once. A start is not an
 * arrival — a backlog written while the host was down grows neither file — so
 * the initial cycle evaluates whatever both bounded windows hold and digests
 * the backlog (the session's "will be digested when the overlay is configured"
 * promise, mechanized).
 *
 * A poll whose notification lands only after the cycle that already digested
 * its records can cost ONE redundant cycle: the flag is set from the
 * watcher's perspective, not from a comparison against the windows. That is the
 * polling cost, stated — never a lost arrival (the flag is set before the check
 * returns, and a mid-cycle notification always earns its one more cycle).
 */

/** Everything the service needs; production binds the live host parts. */
export type OverlayServiceOptions = {
  readonly home: string;
  readonly config: OverlayConfig;
  readonly chat: ChatLog;
  readonly conversation: ConversationLog;
  readonly world: OverlayWorld;
  readonly send: OverlaySend;
  readonly log: HostLog;
  readonly now?: () => number;
  readonly pollMs?: number;
};

export class OverlayService {
  private readonly chatWatcher: ChatWatcher;
  private readonly conversationWatcher: ConversationWatcher;
  private readonly abort = new AbortController();
  private readonly unsubscribes: Array<() => void> = [];
  private readonly now: () => number;
  /** The gateway-arrival count already accounted for by a cycle. */
  private seenGatewayArrivals = 0;
  /** THE single dirty flag across both surfaces. */
  private dirty = false;
  private running = false;
  private started = false;
  private stopped = false;
  private queued: Promise<void> = Promise.resolve();

  constructor(private readonly options: OverlayServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.chatWatcher = ChatWatcher.for(options.home, options.pollMs);
    this.conversationWatcher = ConversationWatcher.for(options.home, options.pollMs);
  }

  /** Starts the two subscriptions and runs the ONE boot cycle. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.seenGatewayArrivals = this.conversationWatcher.gatewayArrivalCount();
    this.unsubscribes.push(this.conversationWatcher.subscribe(() => {
      const arrivals = this.conversationWatcher.gatewayArrivalCount();
      if (arrivals === this.seenGatewayArrivals) return;
      this.seenGatewayArrivals = arrivals;
      this.markDirty();
    }));
    // The chat watcher already dropped a growth without a human record, so its
    // notification is the filtered arrival.
    this.unsubscribes.push(this.chatWatcher.subscribe(() => { this.markDirty(); }));
    // THE BOOT CYCLE: exactly one, on the existing backlog of both surfaces.
    this.markDirty();
  }

  /**
   * Sets the one dirty flag and pumps. Safe from any listener and from the
   * cycle itself: while a cycle runs the flag only marks one more due.
   */
  markDirty(): void {
    if (this.stopped) return;
    this.dirty = true;
    this.pump();
  }

  /** Stops the service: unsubscribes, aborts an in-flight exchange, settles. */
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.abort.abort();
      for (const off of this.unsubscribes.splice(0)) off();
    }
    await this.queued;
  }

  /** Resolves when no cycle is due or running (a test seam). */
  async idle(): Promise<void> {
    for (;;) {
      const current = this.queued;
      await current;
      if (this.queued === current && !this.running) return;
    }
  }

  private pump(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    const run = (async () => {
      while (this.dirty && !this.stopped) {
        this.dirty = false;
        await this.cycle();
      }
    })().catch((err: unknown) => {
      // The cycle catches its own failures; this is defense in depth and never
      // a silent swallow: it is the same bounded diagnostic.
      this.reportFailure(err);
    });
    this.queued = run.finally(() => {
      this.running = false;
      // A markDirty that landed between the loop's check and this point gets
      // its one cycle instead of being lost.
      if (this.dirty && !this.stopped) this.pump();
    });
  }

  private async cycle(): Promise<void> {
    try {
      const outcome = await runOverlayCycle({
        home: this.options.home,
        model: this.options.config.model,
        charter: this.options.config.charter,
        chat: this.options.chat,
        conversation: this.options.conversation,
        world: this.options.world,
        send: this.options.send,
        signal: this.abort.signal,
        now: this.now,
      });
      if (outcome.kind === 'failed') {
        // A provider failure is a BOUNDED host diagnostic, the observe
        // pattern; the frontier's incomplete markers already carry it, and a
        // failed cycle delivers no chat record (a fake reply would be worse).
        this.options.log.emit('overlay/provider-failed', {
          code: outcome.failure.code,
          status: outcome.failure.status,
          steps: outcome.steps,
        });
      }
    } catch (err) {
      this.options.log.emit('overlay/cycle-failed', {
        error: err instanceof Error ? err.name : 'Error',
      });
    }
  }

  private reportFailure(err: unknown): void {
    this.options.log.emit('overlay/cycle-failed', {
      error: err instanceof Error ? err.name : 'Error',
    });
  }
}
