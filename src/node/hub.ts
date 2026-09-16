import { NodeDriver, type NodeDriverOptions, type Router, type TurnHandler } from './driver.js';
import type { RoutedMessage } from './message.js';

export class UnknownNodeError extends Error {
  constructor(public readonly uid: string) {
    super(`unknown node: ${uid}`);
    this.name = 'UnknownNodeError';
  }
}

/**
 * The transport: a registry of live nodes and the single route between them.
 * Delivery crosses no channel that is not journaled — `sent` in the sender's
 * log (durable before routing), `received` in the recipient's (kernel.md §3,
 * rule 3). Single-process by design; there is no network transport in C1.
 */
export class Hub implements Router {
  private readonly nodes = new Map<string, NodeDriver>();

  constructor(
    private readonly home: string,
    private readonly opts: NodeDriverOptions = {},
  ) {}

  async boot(uid: string, handler: TurnHandler): Promise<NodeDriver> {
    if (this.nodes.has(uid)) throw new Error(`node already booted: ${uid}`);
    const driver = await NodeDriver.open(this.home, uid, handler, this, this.opts);
    this.nodes.set(uid, driver);
    return driver;
  }

  get(uid: string): NodeDriver | undefined {
    return this.nodes.get(uid);
  }

  async route(msg: RoutedMessage): Promise<void> {
    const target = this.nodes.get(msg.to);
    if (target === undefined) throw new UnknownNodeError(msg.to);
    await target.deliver(msg);
  }

  /** Asks every node to stop; the caller awaits the `run()` promises it holds. */
  stopAll(reason = 'stop-requested'): void {
    for (const driver of this.nodes.values()) driver.stop(reason);
  }
}
