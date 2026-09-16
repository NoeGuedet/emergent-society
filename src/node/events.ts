import type { MessageKind } from './message.js';

/**
 * The node's event vocabulary (kernel.md §3, rule 1): each type records a fact
 * that is not reconstructible from the rest of the journal. Registered by
 * declaration merging; the envelope format stays frozen.
 */

export type TurnTrigger = 'boot' | 'chain' | 'wakeup';
export type TurnEndOutcome = 'chained' | 'waiting' | 'error' | 'interrupted';
export type ShutdownReason = 'stop-requested' | 'handler-error' | 'maintenance-error' | 'driver-error';

/** The node's durable vocabulary, declared once; merged into the journal's map below. */
export interface NodeEventDataMap {
  'node/boot': { reason: 'start' | 'resume' };
  'node/shutdown': { reason: ShutdownReason; error?: string };
  'turn/start': { turn: number; trigger: TurnTrigger };
  'turn/end': { turn: number; outcome: TurnEndOutcome; synthetic?: true; error?: string };
  'message/sent': { id: string; to: string; kind: MessageKind; wakeup: boolean; body: string; replyTo?: string };
  'message/received': { id: string; from: string; kind: MessageKind; wakeupRequested: boolean; body: string; replyTo?: string };
  'message/undeliverable': { id: string; to: string; reason: 'unknown-node' | 'not-accepting' };
  'inbox/claim': { turn: number; messages: string[] };
}

declare module '../journal/envelope.js' {
  interface EventDataMap extends NodeEventDataMap {}
}

// Record<keyof NodeEventDataMap, true> rejects a missing or extra key at compile time.
const REGISTERED: Record<keyof NodeEventDataMap, true> = {
  'node/boot': true, 'node/shutdown': true, 'turn/start': true, 'turn/end': true,
  'message/sent': true, 'message/received': true, 'message/undeliverable': true,
  'inbox/claim': true,
};

/** The runtime registry handed to `JournalReader.open` (its `knownTypes`). */
export const NODE_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(REGISTERED));
