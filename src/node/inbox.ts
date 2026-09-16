import { isBlobRef, type EventEnvelope } from '../journal/index.js';
import { NodeStateError } from './errors.js';
import type { TurnEndOutcome } from './events.js';
import type { Message } from './message.js';

/**
 * The inbox is a durable projection over the journal: deliveries
 * (`message/received`) minus claims (`inbox/claim`). It is rebuilt by replay
 * at boot and fed by the same single path while running — the event is
 * always the fact, the map only ever mirrors it.
 *
 * A claim is a loan, not a consumption: `turn/end` says whether the turn that
 * took the messages got to keep them. An `error` or `interrupted` turn releases
 * them back to the pending tail, so a crash mid-turn cannot silently eat mail.
 * No event carries the release — it is reconstructed from the claim and the
 * outcome, and replay folds the same two events.
 */
export class Inbox {
  private readonly pending = new Map<string, Message>();
  /** Open claims: the turn that took messages, and what it took in claim order. */
  private readonly claimed = new Map<number, Message[]>();

  /**
   * Feeds one journaled event; idempotent by message id. Only `type` and
   * `data` are read: the live path applies the original delivery fields, since
   * the envelope it journaled may carry a claim-check reference instead.
   *
   * @throws NodeStateError when fed an unresolved claim-check reference — a
   * projection rebuilt from references would store a blob name as a body.
   */
  apply(e: Pick<EventEnvelope, 'type' | 'data'>): void {
    if (e.type === 'message/received') {
      if (isBlobRef(e.data)) {
        throw new NodeStateError(
          'inbox fed an unresolved claim-check reference — open the reader with resolveBlobs',
        );
      }
      const d = e.data as {
        id: string; from: string; kind: Message['kind']; body: string; replyTo?: string;
      };
      if (!this.pending.has(d.id)) {
        // Frozen on insert: a handler mutating ctx.messages[i] would otherwise
        // desynchronize the projection from the journal.
        this.pending.set(d.id, Object.freeze({
          id: d.id, from: d.from, kind: d.kind, body: d.body,
          ...(d.replyTo !== undefined ? { replyTo: d.replyTo } : {}),
        }));
      }
    } else if (e.type === 'inbox/claim') {
      const d = e.data as { turn: number; messages: string[] };
      const claimed: Message[] = [];
      for (const id of d.messages) {
        const msg = this.pending.get(id);
        if (msg !== undefined) claimed.push(msg);
        this.pending.delete(id);
      }
      // The claim keeps the very objects it removed: releasing them gives the
      // handler back the frozen message, not a copy that could drift from it.
      if (claimed.length > 0) this.claimed.set(d.turn, claimed);
      // A claim for turn T is journaled only after turn T-1 ended, so no record
      // older than T can still be released. Dropping them here is what keeps
      // the live path from retaining every turn's mail forever: there, only
      // claims are applied (the driver never feeds its own `turn/end`), so the
      // map would otherwise grow by one turn per message-bearing turn.
      for (const turn of this.claimed.keys()) {
        if (turn < d.turn) this.claimed.delete(turn);
      }
    } else if (e.type === 'turn/end') {
      const d = e.data as { turn: number; outcome: TurnEndOutcome };
      const claimed = this.claimed.get(d.turn);
      this.claimed.delete(d.turn);
      // 'chained' and 'waiting' are the outcomes that consumed the claim; the
      // other two mean the turn never got to act on its mail, so the release is
      // reconstructed here rather than journaled as its own event.
      if (claimed !== undefined && (d.outcome === 'error' || d.outcome === 'interrupted')) {
        for (const msg of claimed) this.pending.set(msg.id, msg);
      }
    }
  }

  /**
   * The unclaimed messages: arrival order for deliveries, claim order for the
   * mail a released turn re-presents at the tail.
   */
  pendingMessages(): Message[] {
    return [...this.pending.values()];
  }

  get size(): number {
    return this.pending.size;
  }
}
