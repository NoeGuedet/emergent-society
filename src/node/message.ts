export type MessageKind = 'chat' | 'question' | 'answer';

/**
 * A message as a node sees it — at rest in an inbox, or claimed into a turn.
 * Its fields are readonly, and the inbox freezes what it inserts: a message is
 * a frozen fact of the journal, never a mutable buffer the handler may edit.
 */
export interface Message {
  readonly id: string;
  readonly from: string;
  readonly kind: MessageKind;
  readonly body: string;
  readonly replyTo?: string;
}

/** A message in transit: the sender's content plus the routing fields. */
export interface RoutedMessage extends Message {
  readonly to: string;
  readonly wakeup: boolean;
}

/**
 * `${from}/m${n}` — deterministic per sender; the counter is rebuilt from the
 * journal at boot, so ids stay unique across restarts without any clock.
 */
export function messageId(from: string, n: number): string {
  return `${from}/m${n}`;
}
