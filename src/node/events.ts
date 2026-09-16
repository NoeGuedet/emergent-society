import type { MessageKind } from './message.js';

/**
 * The driver's event vocabulary (kernel.md §3, rule 1): each type records a
 * fact that is not reconstructible from the rest of the journal. Registered
 * by declaration merging; the envelope format stays frozen.
 */
declare module '../journal/envelope.js' {
  interface EventDataMap {
    'node/boot': { reason: 'start' | 'resume' };
    'node/shutdown': { reason: string };
    'turn/start': { turn: number; trigger: 'boot' | 'chain' | 'wakeup' };
    'turn/end': {
      turn: number;
      outcome: 'chained' | 'waiting' | 'error' | 'interrupted';
      synthetic?: true;
      error?: string;
    };
    'message/sent': {
      id: string; to: string; kind: MessageKind; wakeup: boolean;
      body: string; replyTo?: string;
    };
    'message/received': {
      id: string; from: string; kind: MessageKind; wakeupRequested: boolean;
      body: string; replyTo?: string;
    };
    'inbox/claim': { turn: number; messages: string[] };
  }
}

/** The runtime registry handed to `JournalReader.open` (its `knownTypes`). */
export const NODE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'node/boot', 'node/shutdown', 'turn/start', 'turn/end',
  'message/sent', 'message/received', 'inbox/claim',
]);
