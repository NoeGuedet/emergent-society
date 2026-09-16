import {
  JournalReader, JournalWriter, MAX_BLOB_BYTES, TornTailError, repair,
  type JournalWriterOptions,
} from '../journal/index.js';
import { NODE_EVENT_TYPES, type ShutdownReason, type TurnTrigger } from './events.js';
import { MessageTooLargeError, NodeStateError, UnknownNodeError } from './errors.js';
import { Inbox } from './inbox.js';
import { WakeLatch } from './latch.js';
import { messageId, type Message, type MessageKind, type RoutedMessage } from './message.js';

export type NodeState = 'booting' | 'active' | 'waiting' | 'stopping' | 'stopped';

/**
 * The driver's default clock, mirroring the journal's own `systemClock`: the
 * driver resolves it once, so every turn heals the same `now` the caller
 * injected (or the wall clock when none was given).
 */
const systemClock = (): number => Date.now();

// The turn/shutdown vocabulary lives in events.ts (single home); re-exported so
// the node's public surface (`index.ts`) keeps naming these types.
export type { ShutdownReason, TurnEndOutcome, TurnTrigger } from './events.js';

export interface SendOptions {
  kind?: MessageKind;
  replyTo?: string;
  wakeup?: boolean;
}

/** The handler's whole world: no writer, no transport — the clock is the injected `now`. */
export interface TurnContext {
  readonly turn: number;
  readonly trigger: TurnTrigger;
  readonly messages: readonly Message[];
  send(body: string, to: string, opts?: SendOptions): Promise<void>;
  now(): number;
}

export type TurnOutcome = 'chained' | 'waiting';
export type TurnHandler = (ctx: TurnContext) => Promise<TurnOutcome> | TurnOutcome;

/** The transport the driver hands routed messages to; the Hub implements it (Task 7). */
export interface Router {
  route(msg: RoutedMessage): Promise<void>;
}

export interface NodeDriverOptions extends JournalWriterOptions {
  onMaintenance?: () => Promise<void> | void;
  /**
   * The event types this driver's replay understands, defaulting to its own
   * `NODE_EVENT_TYPES`. Later checkpoints boot a driver with their types unioned
   * in, so a journal written by a richer node still resumes here.
   */
  knownTypes?: ReadonlySet<string>;
}

export class NodeDriver {
  private nodeState: NodeState = 'booting';
  private turn = 0;
  private outgoing = 0;
  private stopRequested = false;
  private stopReason: ShutdownReason = 'stop-requested';
  private readonly inbox = new Inbox();
  private readonly latch = new WakeLatch();
  /** Resolved once in the constructor, like the writer's `systemClock`. */
  private readonly now: () => number;

  private constructor(
    private readonly writer: JournalWriter,
    readonly uid: string,
    private readonly handler: TurnHandler,
    private readonly router: Router,
    private readonly opts: NodeDriverOptions,
  ) {
    this.now = opts.now ?? systemClock;
  }

  static async open(
    home: string, uid: string, handler: TurnHandler, router: Router,
    opts: NodeDriverOptions = {},
  ): Promise<NodeDriver> {
    let writer: JournalWriter;
    try {
      writer = await JournalWriter.open(home, uid, opts);
    } catch (err) {
      if (!(err instanceof TornTailError)) throw err;
      await repair(home, uid);
      writer = await JournalWriter.open(home, uid, opts);
    }
    const driver = new NodeDriver(writer, uid, handler, router, opts);
    try {
      await driver.resume(home);
    } catch (err) {
      // Mirror the writer's own failed-open force-close: a driver whose replay
      // failed must not keep the node locked behind the live pid, or every
      // in-process retry hits SessionAlreadyOwnedError. The close is
      // best-effort — the resume failure is the one that propagates.
      try {
        await writer.close();
      } catch { /* the resume error stands */ }
      throw err;
    }
    return driver;
  }

  get state(): NodeState {
    return this.nodeState;
  }

  /** Visible for resume assertions; the loop consumes the inbox itself. */
  get pendingCount(): number {
    return this.inbox.size;
  }

  /** The id the next sent message will carry (replay-safe). */
  nextMessageId(): string {
    return messageId(this.uid, this.outgoing + 1);
  }

  /**
   * The transport's only entry point: one message enters the node.
   *
   * Receipts are accepted as soon as the journal is open — every state but
   * `stopping`/`stopped` — so a delivery to a node still in `booting` is not
   * lost: it is journaled now and the loop claims it on its first turn, whose
   * trigger the non-empty inbox already makes `wakeup` rather than `boot`.
   *
   * @throws NodeStateError once the driver is stopping or stopped — a journal
   * that is closing cannot take a durable `received`.
   * @throws MessageTooLargeError when the body would be journaled lossily.
   */
  async deliver(msg: RoutedMessage): Promise<void> {
    if (this.nodeState === 'stopping' || this.nodeState === 'stopped') {
      throw new NodeStateError(`cannot deliver to ${this.uid}: state is ${this.nodeState}`);
    }
    // A body at the blob bound would be claim-check-truncated by the writer (it
    // stores a prefix past MAX_BLOB_BYTES), and a truncated reference is refused
    // at resume — one such delivery would brick the node's replay. The driver
    // rejects before journaling anything instead of writing a message it could
    // never read back; the margin covers the envelope's own overhead.
    const bytes = Buffer.byteLength(msg.body, 'utf8');
    if (bytes >= MAX_BLOB_BYTES - 1024) throw new MessageTooLargeError(bytes, MAX_BLOB_BYTES);
    const wakeupRequested =
      msg.wakeup && this.nodeState === 'waiting' && this.latch.request();
    const data = {
      id: msg.id, from: msg.from, kind: msg.kind, wakeupRequested,
      body: msg.body,
      ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
    };
    // A body at or past CLAIM_CHECK_THRESHOLD is claim-checked in the journaled
    // envelope; feeding that envelope to the inbox would store the blob
    // reference as if it were the message. The projection gets the original
    // fields, which the driver already holds; replay resolves the reference
    // instead (resume opens its reader with resolveBlobs).
    this.writer.append('message/received', data);
    this.inbox.apply({ type: 'message/received', data });
    // Deliveries flush eagerly: a journaled `sent` whose `received` was lost to
    // write-behind would be an effect without a trace on the recipient side.
    await this.writer.flush();
  }

  stop(reason: ShutdownReason = 'stop-requested'): void {
    if (this.nodeState === 'stopping' || this.nodeState === 'stopped') return;
    this.stopReason = reason;
    this.stopRequested = true;
    if (this.nodeState === 'waiting') this.latch.request();
  }

  async run(): Promise<void> {
    if (this.nodeState !== 'booting') {
      throw new NodeStateError(`run() out of order: state is ${this.nodeState}`);
    }
    this.nodeState = 'active';
    let trigger: TurnTrigger = this.inbox.size > 0 ? 'wakeup' : 'boot';
    let failure: unknown = null;
    try {
      while (!this.stopRequested) {
        const claimed = this.inbox.pendingMessages();
        if (claimed.length > 0) {
          this.inbox.apply(this.writer.append('inbox/claim', {
            turn: this.turn, messages: claimed.map((m) => m.id),
          }));
        }
        this.writer.append('turn/start', { turn: this.turn, trigger });
        // Barrier: the claim and the turn's opening are durable before the
        // handler can produce any effect (kernel.md §3).
        await this.writer.flush();
        let outcome: TurnOutcome;
        try {
          outcome = await this.handler({
            turn: this.turn,
            trigger,
            messages: claimed,
            send: (body, to, opts) => this.send(body, to, opts),
            now: () => this.now(),
          });
        } catch (err) {
          this.writer.append('turn/end', {
            turn: this.turn, outcome: 'error', error: String(err),
          });
          this.stopReason = 'handler-error';
          throw err;
        }
        this.writer.append('turn/end', { turn: this.turn, outcome });
        if (outcome === 'chained') {
          trigger = 'chain';
          this.turn += 1;
          continue;
        }
        this.nodeState = 'waiting';
        try {
          await this.opts.onMaintenance?.();
        } catch (err) {
          this.stopReason = 'maintenance-error';
          throw err;
        }
        if (this.stopRequested) break;
        // A delivery that landed mid-turn never touches the latch: the inbox
        // check covers it, and a stale request is dropped instead of causing
        // a spurious wake.
        if (this.inbox.size === 0) await this.latch.wait();
        else this.latch.clear();
        if (this.stopRequested) break;
        this.nodeState = 'active';
        trigger = 'wakeup';
        this.turn += 1;
      }
    } catch (err) {
      failure = err;
      // The loop died outside the handler's contract (a failed flush barrier, a
      // maintenance hook that rejected) — an error the caller never asked for.
      // A reason set by stop() or by the handler's own turn must not be
      // overwritten, so only the untouched default is relabelled.
      if (this.stopReason === 'stop-requested') this.stopReason = 'driver-error';
    }
    const shutdownFailure = await this.shutdown(failure);
    failure ??= shutdownFailure;
    if (failure !== null) throw failure;
  }

  /**
   * The one shutdown path: mark the stop, journal the reason, release the
   * writer, and land in `stopped` no matter which step failed.
   *
   * The run's `prior` failure is journaled with the shutdown and outranks any
   * error these steps raise: the append can fail (poisoned writer, recorded
   * write-behind failure) and so can close(), and neither may displace the
   * error that actually ended the run. The step errors are still returned so a
   * clean run is told about them — the caller keeps whichever it holds first.
   *
   * @param prior the error that ended the run, or null on a clean stop.
   * @returns the first shutdown-step error, or null when both steps succeeded.
   */
  private async shutdown(prior: unknown): Promise<unknown> {
    let failure: unknown = null;
    this.nodeState = 'stopping';
    try {
      this.writer.append('node/shutdown', {
        reason: this.stopReason,
        ...(prior !== null && prior !== undefined ? { error: String(prior) } : {}),
      });
    } catch (err) {
      failure ??= err;
    }
    try {
      await this.writer.close();
    } catch (err) {
      failure ??= err;
    } finally {
      // Reached even when close() fails: a driver whose writer cannot be closed
      // is still stopped, never left in 'stopping'.
      this.nodeState = 'stopped';
    }
    return failure;
  }

  /**
   * Journals the intent, makes it durable, then routes — never the reverse.
   *
   * A transport failure is a journaled fact, not a death: the sender's `sent`
   * is durable before the route is attempted, so an undeliverable message is
   * recorded as `message/undeliverable` next to it and the handler is told
   * nothing — it asked to send, and the journal now says what became of that.
   * Only an unexpected error escapes.
   *
   * @throws MessageTooLargeError when the body would be journaled lossily.
   * @throws any error the router raises that is not a known delivery refusal.
   */
  private async send(body: string, to: string, opts: SendOptions = {}): Promise<void> {
    // Same bound as deliver(): a body the writer would claim-check-truncate can
    // never be resolved at resume, so it is refused before anything is journaled.
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes >= MAX_BLOB_BYTES - 1024) throw new MessageTooLargeError(bytes, MAX_BLOB_BYTES);
    const msg: RoutedMessage = {
      id: messageId(this.uid, this.outgoing + 1),
      from: this.uid,
      to,
      kind: opts.kind ?? 'chat',
      wakeup: opts.wakeup ?? true,
      body,
      ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
    };
    this.outgoing += 1;
    this.writer.append('message/sent', {
      id: msg.id, to, kind: msg.kind, wakeup: msg.wakeup, body,
      ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
    });
    await this.writer.flush();
    try {
      await this.router.route(msg);
    } catch (err) {
      // The two refusals the transport can mean: no node owns the uid, or the
      // node exists but is stopping. Both are recorded against the `sent` that
      // already exists, then swallowed — the turn goes on.
      let reason: 'unknown-node' | 'not-accepting';
      if (err instanceof UnknownNodeError) reason = 'unknown-node';
      else if (err instanceof NodeStateError) reason = 'not-accepting';
      else throw err;
      this.writer.append('message/undeliverable', { id: msg.id, to, reason });
      await this.writer.flush();
    }
  }

  /**
   * The resume protocol (kernel.md §3): rebuild every projection by replay,
   * close an interrupted turn synthetically, then journal the boot — durable
   * before any turn effect can exist.
   */
  private async resume(home: string): Promise<void> {
    const reader = await JournalReader.open(home, this.uid, {
      knownTypes: this.opts.knownTypes ?? NODE_EVENT_TYPES,
      // Projections replay the original payloads, not claim-check references:
      // a message/received with a large body must rebuild as the message.
      resolveBlobs: true,
    });
    let sawAny = false;
    let openTurn: number | null = null;
    for await (const e of reader.events()) {
      sawAny = true;
      this.inbox.apply(e);
      if (e.type === 'turn/start') {
        openTurn = (e.data as { turn: number }).turn;
        this.turn = openTurn + 1;
      } else if (e.type === 'turn/end') {
        openTurn = null;
      } else if (e.type === 'message/sent') {
        this.outgoing += 1;
      }
    }
    if (openTurn !== null) {
      // Fed back through the projection, like every replayed event above: the
      // closer is what releases the interrupted turn's claim (inbox.ts), so
      // generating it without applying it would leave the mail eaten.
      this.inbox.apply(this.writer.append(
        'turn/end', { turn: openTurn, outcome: 'interrupted', synthetic: true },
      ));
    }
    this.writer.append('node/boot', { reason: sawAny ? 'resume' : 'start' });
    await this.writer.flush();
  }
}
