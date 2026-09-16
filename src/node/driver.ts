import {
  JournalReader, JournalWriter, TornTailError, repair,
  type JournalWriterOptions,
} from '../journal/index.js';
import { NODE_EVENT_TYPES } from './events.js';
import { Inbox } from './inbox.js';
import { WakeLatch } from './latch.js';
import { messageId, type Message, type MessageKind, type RoutedMessage } from './message.js';

export type NodeState = 'booting' | 'active' | 'waiting' | 'stopping' | 'stopped';
export type TurnTrigger = 'boot' | 'chain' | 'wakeup';

export interface SendOptions {
  kind?: MessageKind;
  replyTo?: string;
  wakeup?: boolean;
}

/** The handler's whole world: no writer, no clock, no transport — kernel.md §3 rule 2. */
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
}

export class NodeDriver {
  private nodeState: NodeState = 'booting';
  private turn = 0;
  private outgoing = 0;
  private stopRequested = false;
  private stopReason = 'stop-requested';
  private readonly inbox = new Inbox();
  private readonly latch = new WakeLatch();

  private constructor(
    private readonly writer: JournalWriter,
    readonly uid: string,
    private readonly handler: TurnHandler,
    private readonly router: Router,
    private readonly opts: NodeDriverOptions,
  ) {}

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
    await driver.resume(home);
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

  /** The transport's only entry point: one message enters the node. */
  async deliver(msg: RoutedMessage): Promise<void> {
    if (this.nodeState !== 'active' && this.nodeState !== 'waiting') {
      throw new Error(`cannot deliver to ${this.uid}: state is ${this.nodeState}`);
    }
    const wakeupRequested =
      msg.wakeup && this.nodeState === 'waiting' && this.latch.request();
    this.inbox.apply(this.writer.append('message/received', {
      id: msg.id, from: msg.from, kind: msg.kind, wakeupRequested,
      body: msg.body,
      ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
    }));
    // Deliveries flush eagerly: a journaled `sent` whose `received` was lost to
    // write-behind would be an effect without a trace on the recipient side.
    await this.writer.flush();
  }

  stop(reason = 'stop-requested'): void {
    if (this.nodeState === 'stopping' || this.nodeState === 'stopped') return;
    this.stopReason = reason;
    this.stopRequested = true;
    if (this.nodeState === 'waiting') this.latch.request();
  }

  async run(): Promise<void> {
    if (this.nodeState !== 'booting') {
      throw new Error(`run() out of order: state is ${this.nodeState}`);
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
            now: () => (this.opts.now ?? Date.now)(),
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
    } finally {
      this.nodeState = 'stopping';
      try {
        this.writer.append('node/shutdown', { reason: this.stopReason });
      } catch (err) {
        // The shutdown append can itself fail (poisoned writer, recorded
        // write-behind failure). It must not displace the error that ended the
        // run: when both exist, the handler/maintenance error is the one that
        // propagates.
        failure ??= err;
      } finally {
        await this.writer.close();
        this.nodeState = 'stopped';
      }
    }
    if (failure !== null) throw failure;
  }

  /** Journals the intent, makes it durable, then routes — never the reverse. */
  private async send(body: string, to: string, opts: SendOptions = {}): Promise<void> {
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
    await this.router.route(msg);
  }

  /**
   * The resume protocol (kernel.md §3): rebuild every projection by replay,
   * close an interrupted turn synthetically, then journal the boot — durable
   * before any turn effect can exist.
   */
  private async resume(home: string): Promise<void> {
    const reader = await JournalReader.open(home, this.uid, { knownTypes: NODE_EVENT_TYPES });
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
      this.writer.append('turn/end', { turn: openTurn, outcome: 'interrupted', synthetic: true });
    }
    this.writer.append('node/boot', { reason: sawAny ? 'resume' : 'start' });
    await this.writer.flush();
  }
}
