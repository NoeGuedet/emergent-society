/**
 * The node driver's public surface — what C1.3 and later checkpoints may build
 * on. Everything not re-exported here (WakeLatch, HeadWatcher, the `world-*`
 * siblings) is an implementation detail and may change.
 *
 * The world crosses this barrel as `WorldRepo` and its types alone: `world.ts`
 * is the façade over `world-types`/`world-git`/`world-trust`/`world-history`/
 * `world-diff`/`world-commit`, and no sibling is a public entry point.
 *
 * The hook seam is public on the type side — `DriverHooks` plus the `GateScope`
 * a hook is handed and the `BoundaryRegistry` it is dispatched from; the gate
 * factory and the journal writer are not.
 */

export {
  NodeDriver,
  type FenceOutcome,
  type FencePort,
  type NodeDriverOptions,
  type NodeState,
  type TurnContext,
  type TurnHandler,
  type TurnOpening,
  type TurnResult,
} from './driver.js';
export {
  WorldRepo, type CommitRange, type DiffCapture, type RecordedCommit, type WorldCommitInfo,
  type WorldRange,
} from './world.js';
export {
  GitCommandError, InvalidDoctorReportError, NodeError, NodeStateError, UnsafeWorldPathError,
  WakeClockUnavailableError, WorldHeadError, WorldNotARepoError, WorldReconciliationError,
} from './errors.js';
export {
  NODE_EVENT_TYPES, type ShutdownReason, type TurnEndOutcome, type TurnTrigger,
} from './events.js';
export type {
  BoundaryGate, BoundaryRegistry, DurableWatermark, DriverHooks, GateScope,
  WorldAcknowledgement,
} from './gate.js';
// The C1.3 runtime's public surface: the factory plus its instance and option
// types. Provider components stay direct imports (no re-export here), and the
// boundary gate factory and the writer stay unexported.
export {
  createAgentRuntime, type AgentRuntime, type RuntimeOptions,
} from './loop.js';
// The conversation interface's public surface: the stream's writer/reader, its
// watcher and the pending notice. The node verbs reach the log through the
// host-composed port; the overlay (G1) subscribes to the same watcher.
export {
  CONVERSATION_FILE, CONVERSATION_FRAMING, CONVERSATION_LOCK_FILE, DEFAULT_THREAD_READ,
  MAX_SPEAK_BYTES, ConversationLog, ConversationRefusedError, ConversationWriteError,
  openConversationLog, readConversationStream, readConversationThread, renderConversationNotice,
  renderConversationThread,
  type ConversationRecord, type ConversationSent, type ConversationThread,
} from './conversation.js';
export {
  ConversationWatcher,
  type ConversationNotice, type ConversationNoticeSource, type ConversationSource,
} from './conversation-watcher.js';
