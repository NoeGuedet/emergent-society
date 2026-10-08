/**
 * The node driver's public surface — what C1.3 and later checkpoints may build
 * on. Everything not re-exported here (WakeLatch, HeadWatcher) is an
 * implementation detail and may change.
 */

export {
  NodeDriver,
  type NodeDriverOptions,
  type NodeState,
  type TurnContext,
  type TurnHandler,
  type TurnOutcome,
  type TurnResult,
} from './driver.js';
export {
  WorldRepo, type CommitRange, type DiffCapture, type RecordedCommit, type WorldCommitInfo,
  type WorldRange,
} from './world.js';
export {
  GitCommandError, NodeError, NodeStateError, UnsafeWorldPathError, WorldHeadError, WorldNotARepoError,
} from './errors.js';
export {
  NODE_EVENT_TYPES, type ShutdownReason, type TurnEndOutcome, type TurnTrigger,
} from './events.js';
// The hook seam's types are public; the gate factory and the writer are not.
export type { BoundaryGate, DurableWatermark, DriverHooks } from './gate.js';
// The C1.3 runtime's public surface: the factory plus its instance and option
// types. Provider components stay direct imports (no re-export here), and the
// boundary gate factory and the writer stay unexported.
export {
  createAgentRuntime, type AgentRuntime, type RuntimeOptions,
} from './loop.js';
