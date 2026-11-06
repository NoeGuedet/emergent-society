import type { SeedPolicy } from '../context/contracts.js';

/**
 * The gateway overlay's host-side constants.
 *
 * The overlay is not a cell: it has no journaled config, no policy fold and no
 * per-node budget to derive its bounds from. Its limits are therefore
 * host-side constants — one policy object shaped like the node's recorded
 * `SeedPolicy`, so the provider adapter and the wire read it through the same
 * contract, and a handful of named caps the cycle and the toolset self-bound
 * under.
 */

/** The per-cycle bound on model→tool rounds (the `stepsPerTurn` precedent). */
export const OVERLAY_CYCLE_STEPS = 8;

/** The byte cap every overlay tool result self-bounds under. */
export const OVERLAY_TOOL_RESULT_BYTES = 64 * 1024;

/** The chat-window bound: the human↔overlay exchange's tail, in records. */
export const OVERLAY_CHAT_WINDOW = 16;

/** The conversation-window bound: the gateway thread's tail, in records. */
export const OVERLAY_THREAD_WINDOW = 16;

/** The `read_world` blob ceiling: a file, not a document dump. */
export const OVERLAY_WORLD_READ_MAX_BYTES = 64 * 1024;

/** The `world_log` default commit count. */
export const OVERLAY_WORLD_LOG_DEFAULT = 10;

/** The `world_log` count ceiling: n is clamped, never refused, above it. */
export const OVERLAY_WORLD_LOG_MAX = 16;

/** The tree-path byte ceiling: a path, not a payload. */
export const OVERLAY_WORLD_PATH_MAX_BYTES = 4096;

/**
 * The overlay's policy: `SeedPolicy`-shaped so the adapter and the wire accept
 * it unchanged. The fields a node derives from its cell are fixed constants
 * here — the overlay has no shell, no turn and no compaction concern, so those
 * values are inert and named as such; the fields the exchange genuinely uses
 * (`maxRequestBytes`, `maxAttempts`, `requestTimeoutMs`,
 * `maxCallsPerResponse`, `maxAssistantBytes`, `maxToolArgumentBytes`) are the
 * overlay's own bounds.
 */
export const OVERLAY_POLICY: SeedPolicy = {
  // Inert: the cycle is bounded in cycles by the service, in steps by
  // OVERLAY_CYCLE_STEPS; this field is carried for the shared contract only.
  stepsPerTurn: OVERLAY_CYCLE_STEPS,
  compactAfterBytes: 256 * 1024,
  keepRecentGroups: 0,
  maxAttempts: 2,
  retryDelayMs: 250,
  requestTimeoutMs: 120_000,
  // Inert: no shell, no kill, no capture in the overlay.
  shellTimeoutMs: 30_000,
  killGraceMs: 200,
  maxCaptureBytes: 32 * 1024 * 1024,
  maxShellCaptureBytes: 1024 * 1024,
  maxDiffBytes: 32 * 1024,
  maxCommits: 0,
  // THE USE:
  maxRequestBytes: 2 * 1024 * 1024,
  maxAssistantBytes: 32 * 1024,
  maxToolResultBytes: OVERLAY_TOOL_RESULT_BYTES,
  maxToolArgumentBytes: 256 * 1024,
  maxCallsPerResponse: 32,
};
