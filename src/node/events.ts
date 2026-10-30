import type { CommitRefusal } from './world-commit.js';
import type { WorldRange } from './world.js';

/**
 * The node's event vocabulary (kernel.md §3, rule 1): each type records a fact
 * that is not reconstructible from the rest of the journal. Registered by
 * declaration merging; the envelope format stays frozen.
 *
 * The world's own history is the other half of the record: it is not an event
 * type but a git repository, joined to these events by the commit hash a
 * `turn/end` carries (§5.2).
 */

export type TurnTrigger = 'boot' | 'chain' | 'wakeup';
export type TurnEndOutcome = 'chained' | 'waiting' | 'error' | 'interrupted';
export type ShutdownReason = 'stop-requested' | 'handler-error' | 'maintenance-error' | 'driver-error';

/** The node's durable vocabulary, declared once; merged into the journal's map below. */
export interface NodeEventDataMap {
  'node/boot': { reason: 'start' | 'resume' };
  'node/shutdown': { reason: ShutdownReason; error?: string };
  'turn/start': { turn: number; trigger: TurnTrigger; world: WorldRange };
  'turn/end': { turn: number; outcome: TurnEndOutcome; commit?: string; synthetic?: true; error?: string };
  /**
   * One refused commit, written after the turn's `turn/end` closer and
   * ignorable: the turn ended `waiting`, the kernel survives, and the local
   * log is the record of which turn's commit was refused and why. The fold
   * renders it as one bounded system line in a durable `refusal` group — a
   * later successful commit does NOT clear that group (it stays history and
   * may be compacted); only the degraded sidecar is cleared by success.
   * `turn` is the refused turn; `paths` is reserved for the later commit
   * budgets.
   */
  'world/commit-refused': {
    refusal: CommitRefusal; turn: number; paths?: string[];
  };
}

declare module '../journal/envelope.js' {
  interface EventDataMap extends NodeEventDataMap {}
}

// Record<keyof NodeEventDataMap, true> rejects a missing or extra key at compile time.
const REGISTERED: Record<keyof NodeEventDataMap, true> = {
  'node/boot': true, 'node/shutdown': true, 'turn/start': true, 'turn/end': true,
  'world/commit-refused': true,
};

/** The runtime registry handed to `JournalReader.open` (its `knownTypes`). */
export const NODE_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(REGISTERED));
