/**
 * The frozen constants of the package layer (kernel.md, the local-log sections).
 *
 * One home, UPPER_SNAKE, `_BYTES`/`_MS` suffixes, numeric separators — an
 * unnamed bound is uncheckable, so every bound of the vocabulary lives here
 * and nowhere else. Each constant is frozen physics: a ruling that changes a
 * number reworks exactly this file plus its boundary tests.
 *
 * What this module never does: derive anything at runtime, import anything —
 * it is the leaf both the context vocabulary and the package modules share.
 */

/**
 * The bounded-detail cap of the `package/error` `detail` and the
 * `package/service` `status` strings, in UTF-8 bytes: guest-produced text is
 * capped before it can be journaled, and control characters other than
 * newline and tab are refused outright (the sanitization rule).
 */
export const MAX_ERROR_DETAIL_BYTES = 1_024;

/** The declared Package/tool name bound (1-64 chars, the §4 define rule). */
export const MAX_PACKAGE_NAME_CHARS = 64;

/** The declared purpose bound (1-512 chars, the same bound as descriptions). */
export const MAX_PACKAGE_PURPOSE_CHARS = 512;

/** One definition's source cap (the kernel-side bound on the fd read). */
export const MAX_PACKAGE_SOURCE_BYTES = 1_048_576;

/** The node-wide total source-bytes cap across all stored definitions. */
export const MAX_PACKAGE_SOURCE_BYTES_PER_NODE = 64 * 1024 * 1024;

/** The stored manifest.json cap (canonical {name, purpose} is always under 1 KiB). */
export const MAX_MANIFEST_BYTES = 1_024;

/** One protocol line's byte cap — an unterminated line is killed at the cap. */
export const MAX_FRAME_BYTES = 1_048_576;

/** The one concurrent Run per node (a frozen cap: one Run carries all the tooling). */
export const MAX_CONCURRENT_RUNS_PER_NODE = 1;

/** The most tools one Run may register. */
export const MAX_TOOLS_PER_RUN = 32;

/** One registered tool's schema cap (canonical bytes). */
export const MAX_TOOL_SCHEMA_BYTES = 4_096;

/** The whole declaration's surface cap (names + descriptions + schemas, canonical bytes). */
export const MAX_DECLARED_SURFACE_BYTES = 49_152;

/** The window a spawned child has to send `run/ready`. */
export const PACKAGE_READY_TIMEOUT_MS = 10_000;

/** The bootstrap's bounded capture of non-protocol writes (output.log). */
export const MAX_OUTPUT_LOG_BYTES = 65_536;
