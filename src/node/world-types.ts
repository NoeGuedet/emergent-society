/**
 * The world's data shapes: what a commit, a history range and a bounded
 * perception record look like. Nothing here runs git or touches the disk — the
 * process layer is `world-git.ts` and the repository policy is `world.ts`.
 */

/** The object formats git may use; a hash's hex length is the discriminator. */
export type ObjectFormat = 'sha1' | 'sha256';

/** One bounded render result: the emitted UTF-8 text, whether it stopped early, its byte length. */
export interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytesRetained: number;
}

/** One commit of the world's history, as the wake predicate and the journal need it. */
export interface WorldCommitInfo {
  readonly hash: string;
  /** The commit's author name — the uid of the node whose turn produced it. */
  readonly author: string;
}

/**
 * A range of the world's history: `from` is a node's wake watermark (the last
 * commit it has seen; null before it has ever perceived the world), `to` is
 * HEAD. It is what the journal records about a turn's perception and what the
 * C1.3 assembler turns into the diff a wake presents (kernel.md §4, §5.2).
 *
 * A type alias rather than an interface, deliberately: this shape is journaled
 * in `turn/start` data, and only a type alias is assignable to the `JsonValue`
 * index signature the envelope requires.
 */
export type WorldRange = {
  readonly from: string | null;
  readonly to: string | null;
};

/**
 * A bounded rendering of a world range (T4). `bytesRetained` counts the emitted
 * UTF-8 bytes of `text` after decoding/replacement, including headers and
 * notices — not an input byte count; `truncated` is true when emission stopped
 * before the whole bounded range was rendered. Type aliases, not interfaces:
 * these are journaled in `world/perception` and the envelope's `JsonValue`
 * constraint only admits alias-shaped object types.
 */
export type DiffCapture = {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytesRetained: number;
};

/** One recorded commit of a bounded range, as the perception records it. */
export type RecordedCommit = {
  readonly hash: string;
  readonly author: string;
};

/**
 * A bounded, verified traversal of the world's history (T4). `effectiveFrom` is
 * the requested `from` when reachable, else `null`; `listTruncated` records that
 * older commits were omitted rather than claiming a complete history.
 */
export type CommitRange = {
  readonly commits: RecordedCommit[];
  readonly effectiveFrom: string | null;
  readonly fallback: 'none' | 'unreachable-from';
  readonly listTruncated: boolean;
};
