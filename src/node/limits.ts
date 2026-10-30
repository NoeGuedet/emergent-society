/**
 * The node-side bounds: one home for every default the world commit path, the
 * process layer and the world doctor use. They are constants, not environment
 * switches and not journaled configuration: the production values are the
 * contract and a test injects smaller ones through the function parameters
 * that carry this type. The host's cgroup bounds (`LIMITS` in
 * `src/host/cgroups.ts`) are a different layer and are not imported here.
 *
 * The commit budget numbers come from the incident the survival core answers:
 * a 26,497-file / 2 GB-sparse world must commit, a 2 GB sparse file must be
 * refused before `add` ever runs, and a 300k-entry world must be a typed
 * refusal rather than an out-of-memory walk.
 */

/** The per-call git deadline for plumbing (`add` has its own, longer one). */
export const GIT_PLUMBING_TIMEOUT_MS = 10_000;

/** The `add --all` deadline: staging 26,497 files measured 0.2 s, 2 GB sparse 6 s. */
export const GIT_ADD_TIMEOUT_MS = 30_000;

/** The streaming read deadline (`git log`, the hermetic diff): bounded, never a hang. */
export const GIT_READ_TIMEOUT_MS = 10_000;

/** Entries the nested-repository walk may see before it refuses (measured 130 MB RSS at 300k). */
export const MAX_WALK_ENTRIES = 100_000;

/** The apparent-size cap for one regular file in the walk (sparse files count apparent bytes). */
export const MAX_FILE_APPARENT_BYTES = 64 * 1024 * 1024;

/** The TURN'S staged paths the post-`add` budget accepts (the delta against HEAD). */
export const MAX_STAGED_PATHS = 50_000;

/** The TURN'S staged blob bytes the post-`add` budget accepts (the delta against HEAD). */
export const MAX_STAGED_BYTES = 256 * 1024 * 1024;

/** Untracked paths the doctor may quarantine in one boot. */
export const QUARANTINE_MAX_FILES = 1_000;

/** Untracked bytes the doctor may quarantine in one boot. */
export const QUARANTINE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * How old an `index.lock` must be before the doctor may remove it. It sits
 * above the whole commit worst case (~75 s: a 2 s freeze attempt per commit
 * retry, the 30 s `add` and five 10 s plumbing children), so a live commit can
 * never be inside the window. A kernel writer holds the world flock, so the
 * age rule is the doctor's proof for the case the flock cannot see: human git.
 */
export const INDEX_STALE_MS = 5 * 60 * 1000;

/**
 * The storage floor the doctor REPORTS as `freeSpace.state` (a low disk is a
 * fact). It is not the quarantine move gate: the move is gated on room for the
 * bounded rename (count/bytes/inodes), because renaming within one filesystem
 * does not consume free space.
 */
export const MIN_FREE_BYTES = 20 * 1024 ** 3;

/** The tracked-unreadable list the doctor's report carries (bounded relative names). */
export const MAX_TRACKED_UNREADABLE_PATHS = 100;

/** Entries one doctor listing scan may read before it stops and reports `truncated`. */
export const MAX_DOCTOR_SCAN_ENTRIES = 100_000;


/** The code-point cap of one reported relative path (a path is never a payload). */
export const MAX_DOCTOR_PATH_CHARS = 200;

/** The commit budgets a caller may lower for a test; production uses the defaults. */
export type CommitLimits = {
  readonly maxWalkEntries: number;
  readonly maxFileApparentBytes: number;
  readonly maxStagedPaths: number;
  readonly maxStagedBytes: number;
};

/** The production budgets (what `WorldRepo.commitAll` uses, with no switch). */
export const DEFAULT_COMMIT_LIMITS: CommitLimits = Object.freeze({
  maxWalkEntries: MAX_WALK_ENTRIES,
  maxFileApparentBytes: MAX_FILE_APPARENT_BYTES,
  maxStagedPaths: MAX_STAGED_PATHS,
  maxStagedBytes: MAX_STAGED_BYTES,
});
