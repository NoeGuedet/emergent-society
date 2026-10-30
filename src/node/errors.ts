import { KernelError } from '../errors.js';

/**
 * The node module's typed errors. Like `src/journal/errors.ts`, this family roots
 * at `KernelError` (src/errors.ts), which assigns `name` from `new.target`.
 */
export abstract class NodeError extends KernelError {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The node's state contract was violated (a `run()` out of order, or a second one). */
export class NodeStateError extends NodeError {}

/** The configured world directory is `$HOME` or a broad root (kernel.md §7). */
export class UnsafeWorldPathError extends NodeError {
  constructor(public readonly path: string) {
    super(`refusing ${path} as the world repo: the world is a dedicated directory`);
  }
}

/** The configured world directory is not the root of a git repository. */
export class WorldNotARepoError extends NodeError {
  constructor(public readonly path: string, detail?: string) {
    super(`${path} is not the root of a git repository${detail === undefined ? '' : `: ${detail}`}`);
  }
}

/**
 * The world's HEAD is not a single local branch the kernel can publish to: it is
 * detached, names something outside `refs/heads/`, or switched branch during a
 * commit. The kernel publishes with a compare-and-swap against one named branch
 * and has no safe contract for guessing another, so it fails closed.
 */
export class WorldHeadError extends NodeError {
  constructor(public readonly reason: string) {
    super(`world HEAD is not a publishable branch: ${reason}`);
  }
}

/**
 * Why a git invocation failed, as far as the process layer can tell. It is a
 * discriminator, not a message: `exit` is a command that ran and returned
 * non-zero, `spawn` a child that never started (ENOENT and friends), `timeout`
 * a child the process layer killed at its deadline, and `abort` a call the
 * caller's signal cancelled. Before it, `GitCommandError` carried only
 * `exitCode: number | null`: a numeric exit and a spawn failure were told
 * apart only by the null, and a timeout, an abort and the output-bound kill
 * could not be named at all — so the commit boundary could not classify them.
 */
export type GitFailureKind = 'exit' | 'spawn' | 'timeout' | 'abort';

/** The failure detail carried into a `GitCommandError`; `kind` is required. */
export type GitCommandFailure = {
  readonly kind: GitFailureKind;
  /**
   * The output bound killed the child (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`)
   * rather than the command failing. It is the one kill that is neither a
   * timeout nor an abort, so it is carried beside `kind` instead of widening
   * the process-layer vocabulary.
   */
  readonly outputCapped?: boolean;
  readonly cause?: unknown;
};

/** A git invocation against the world failed. */
export class GitCommandError extends NodeError {
  readonly kind: GitFailureKind;
  readonly outputCapped: boolean;

  constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
    failure: GitCommandFailure = { kind: 'exit' },
  ) {
    const exit = exitCode !== null ? ` (exit ${exitCode})` : '';
    super(
      `git ${args.join(' ')} failed${exit}: ${stderr.trim()}`,
      failure.cause !== undefined ? { cause: failure.cause } : undefined,
    );
    this.kind = failure.kind;
    this.outputCapped = failure.outputCapped === true;
  }
}

/**
 * An interrupted turn's own world commit cannot be identified unambiguously
 * without guessing: the search's verified base is unreachable, the bounded walk
 * was exceeded, or more than one commit in the turn's range carries the node's
 * uid and the exact `turn N` subject. The kernel reconciles by joining the one
 * commit the turn made, never by picking one of several — so it fails closed
 * with this typed error, before any replay effect.
 */
export class WorldReconciliationError extends NodeError {
  constructor(public readonly reason: string) {
    super(`world reconciliation refused: ${reason}`);
  }
}
