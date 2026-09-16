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

  /** Filled in by Task 6. */
  async run(): Promise<void> {
    throw new Error('not implemented');
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
