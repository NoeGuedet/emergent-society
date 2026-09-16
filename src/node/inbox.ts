import type { EventEnvelope } from '../journal/index.js';
import type { Message } from './message.js';

/**
 * The inbox is a durable projection over the journal: deliveries
 * (`message/received`) minus claims (`inbox/claim`). It is rebuilt by replay
 * at boot and fed by the same single path while running — the event is
 * always the fact, the map only ever mirrors it.
 */
export class Inbox {
  private readonly pending = new Map<string, Message>();

  /** Feeds one journaled event; idempotent by message id. */
  apply(e: EventEnvelope): void {
    if (e.type === 'message/received') {
      const d = e.data as {
        id: string; from: string; kind: Message['kind']; body: string; replyTo?: string;
      };
      if (!this.pending.has(d.id)) {
        this.pending.set(d.id, {
          id: d.id, from: d.from, kind: d.kind, body: d.body,
          ...(d.replyTo !== undefined ? { replyTo: d.replyTo } : {}),
        });
      }
    } else if (e.type === 'inbox/claim') {
      for (const id of (e.data as { messages: string[] }).messages) {
        this.pending.delete(id);
      }
    }
  }

  /** The unclaimed messages, in arrival order (Map insertion order). */
  pendingMessages(): Message[] {
    return [...this.pending.values()];
  }

  get size(): number {
    return this.pending.size;
  }
}
