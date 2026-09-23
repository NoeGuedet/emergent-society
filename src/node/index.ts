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
export { WorldRepo, type WorldCommitInfo, type WorldRange } from './world.js';
export {
  GitCommandError, NodeError, NodeStateError, UnsafeWorldPathError, WorldNotARepoError,
} from './errors.js';
export {
  NODE_EVENT_TYPES, type ShutdownReason, type TurnEndOutcome, type TurnTrigger,
} from './events.js';
