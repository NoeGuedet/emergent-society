import type { CommitRefusal } from './world-commit.js';
import type { DoctorReport } from './world-doctor.js';
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

/**
 * What caused a turn to open. `'conversation'` is the interface's arrival: a
 * pending conversation notice ended the park (the cause rides a fired flag,
 * exactly like `'timer'`, so a conversation wake is never silently recorded as
 * `'wakeup'`). `'cadence'` is the modern per-node phase-grid wake: it is its own
 * selected cause, but an already-visible foreign commit at the fire-time check
 * still selects `'wakeup'`. The value joins the type only; the local event set
 * is unchanged, and the fold ignores the trigger, so an older reader skips it.
 */
export type TurnTrigger = 'boot' | 'chain' | 'wakeup' | 'timer' | 'conversation' | 'cadence';
export type TurnEndOutcome = 'chained' | 'waiting' | 'error' | 'interrupted';
export type ShutdownReason =
  | 'stop-requested' | 'handler-error' | 'maintenance-error' | 'driver-error'
  /** The node's own clean end (`extend {verb:"request_death"}`). */
  | 'self-requested';

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
  /**
   * The boot-time world doctor's report, written once after `node/boot` when
   * composition ran the doctor. It is an ignorable, non-rendered fact: the
   * fold validates the payload and renders nothing, so replay is identical
   * whether the report is present or an older reader skips it. The report
   * carries counts and bounded relative names — never an absolute path, never
   * a payload.
   */
  'world/doctor': { report: DoctorReport };
  /**
   * The ratified direction this turn pins: the world commit the human authored
   * and the pinned text's byte length (never the text itself — the world holds
   * it, the frontier holds the exact request bytes). Ignorable and not
   * rendered: the fold validates nothing beyond the shape and leaves the
   * snapshot unchanged, so replay is identical whether the fact is present or
   * an older reader skips it.
   */
  'direction/pinned': { commit: string; bytes: number };
}

declare module '../journal/envelope.js' {
  interface EventDataMap extends NodeEventDataMap {}
}

// Record<keyof NodeEventDataMap, true> rejects a missing or extra key at compile time.
const REGISTERED: Record<keyof NodeEventDataMap, true> = {
  'node/boot': true, 'node/shutdown': true, 'turn/start': true, 'turn/end': true,
  'world/commit-refused': true, 'world/doctor': true, 'direction/pinned': true,
};

/** The runtime registry handed to `JournalReader.open` (its `knownTypes`). */
export const NODE_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(REGISTERED));
