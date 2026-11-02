/**
 * The gateway overlay — the host-side digest service over a cell home.
 *
 * The gateway is NOT a node: it has no pool membership, no cell, no cgroup
 * leaf, no scratch, no sandbox, no world grant, no turn and none of the node
 * verbs. Its equipment is this service (the event-driven cycle, the two
 * watchers, the three tools), and its role is charter data
 * (`<home>/gateway.charter.md`). `direction.md` and `kernel.md` state the
 * doctrine; this barrel is the code's entry.
 */
export {
  GATEWAY_CHARTER_FILE, GATEWAY_CONFIG_FILE, gatewayCharterPath, gatewayConfigPath,
  persistOverlayConfig, readOverlaySidecars, resolvePersistedOverlay,
  type OverlayConfig, type OverlaySidecars,
} from './charter.js';
export { OVERLAY_FRAMING, NO_REPLY_NOTICE, boundResponse, runOverlayCycle, type OverlayCycleOutcome, type OverlayCyclePorts, type OverlaySend } from './cycle.js';
export { createOverlayGate } from './gate.js';
export {
  OVERLAY_CHAT_WINDOW, OVERLAY_CYCLE_STEPS, OVERLAY_POLICY, OVERLAY_THREAD_WINDOW,
  OVERLAY_TOOL_RESULT_BYTES, OVERLAY_WORLD_LOG_DEFAULT, OVERLAY_WORLD_LOG_MAX,
  OVERLAY_WORLD_PATH_MAX_BYTES, OVERLAY_WORLD_READ_MAX_BYTES,
} from './policy.js';
export { CHAT_WINDOW_HEADER, THREAD_WINDOW_HEADER, loadOverlayWindows, renderChatWindow, renderConversationWindow, type OverlayWindows } from './context.js';
export { OVERLAY_TOOLS, dispatchOverlayTool, type OverlayToolPorts } from './tools.js';
export {
  WORLD_READ_FRAMING, TreePathRefusedError, boundOverlayResult, readCommittedBlob, readWorldLog,
  renderWorldLog, validateTreePath,
  type CommittedLog, type CommittedRead, type OverlayWorld, type WorldLogEntry,
} from './world-read.js';
export { OverlayService, type OverlayServiceOptions } from './service.js';
