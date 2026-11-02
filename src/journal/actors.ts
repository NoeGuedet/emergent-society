import { GATEWAY_ADDRESSEE, HUMAN_AUTHOR, assertNodeUid } from './layout.js';
import { InvalidNodeUidError } from './errors.js';

/**
 * The conversation actor rule — the one validator every kernel-owned record
 * that names a participant shares.
 *
 * Three records name an actor: the frontier's attribution sidecar (which node
 * began the exchange), the chat log (the human and the gateway's records), and
 * the conversation stream (the nodes' messages and the gateway's answers). The
 * actors they may carry are the node uids plus the two RESERVED names, `human`
 * (the ratifier) and `gateway` (the overlay addressee) — both refused by
 * `assertNodeUid`, so no node can ever bear them and no node can forge another
 * actor's line through its own identity.
 *
 * This module is deliberately the only place the rule is written: the three
 * write points call `assertConversationActor`, and a node uid is validated by
 * the same `assertNodeUid` every journal path uses. `assertConversationAddressee`
 * is the narrower addressing rule of the conversation record's `to` field: a
 * node uid or the reserved gateway — the human reads the chat log, never the
 * conversation stream, so the human is not a conversation addressee.
 */

/** Validates a record's actor (a sender's identity), returning it unchanged. */
export function assertConversationActor(actor: string): string {
  if (actor === HUMAN_AUTHOR || actor === GATEWAY_ADDRESSEE) return actor;
  return assertNodeUid(actor);
}

/** Validates a conversation addressee (a node uid or the reserved gateway). */
export function assertConversationAddressee(to: string): string {
  if (to === GATEWAY_ADDRESSEE) return to;
  if (to === HUMAN_AUTHOR) {
    throw new InvalidNodeUidError(
      to, 'the human is not a conversation addressee — the human\'s words live in the chat log',
    );
  }
  return assertNodeUid(to);
}
