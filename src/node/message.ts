export type MessageKind = 'chat' | 'question' | 'answer';

/** A message as a node sees it — at rest in an inbox, or claimed into a turn. */
export interface Message {
  id: string;
  from: string;
  kind: MessageKind;
  body: string;
  replyTo?: string;
}

/** A message in transit: the sender's content plus the routing fields. */
export interface RoutedMessage extends Message {
  to: string;
  wakeup: boolean;
}

/**
 * `${from}/m${n}` — deterministic per sender; the counter is rebuilt from the
 * journal at boot, so ids stay unique across restarts without any clock.
 */
export function messageId(from: string, n: number): string {
  return `${from}/m${n}`;
}
