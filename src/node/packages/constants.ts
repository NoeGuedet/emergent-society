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
