/**
 * The journal's typed error surface: one base, so callers can catch the whole
 * family and read `name` off `new.target` instead of repeating it in every
 * constructor, plus the two predicates that tell an operator what to do next.
 *
 * Corruptions and environment failures call for opposite responses — inspect
 * versus retry — so `isCorruption`/`isRetryable` make that decision explicit at
 * the call site rather than leaving it to a chain of `instanceof` checks.
 */
export abstract class JournalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Damage to the log's contents. A shared base rather than a list of classes at
 * the predicate, so a new corruption kind is covered by construction and this
 * module stays free of imports.
 */
export abstract class CorruptionError extends JournalError {}

/** Damage to the log: inspect it before retrying anything. */
export function isCorruption(e: unknown): boolean {
  return e instanceof CorruptionError;
}

/** An environment failure (EIO, ENOSPC, EACCES) rather than a journal decision. */
export function isRetryable(e: unknown): boolean {
  return !(e instanceof JournalError);
}

/**
 * A node uid that cannot be used as a path segment and a git identity at once.
 *
 * A uid is a technical identifier, not the free name an agent goes by (kernel.md
 * §3): it is joined under `home/nodes/`, so a separator, a `..` or a control
 * character in it is a path traversal or a corrupt directory name, and it is a
 * git author at every turn-end. It is refused before any filesystem effect, so a
 * hostile uid can never read or create a path outside the cell home.
 */
export class InvalidNodeUidError extends JournalError {
  constructor(public readonly uid: string, reason: string) {
    super(`invalid node uid ${JSON.stringify(uid)}: ${reason}`);
  }
}

/**
 * A layout whose four file names are not plain, distinct names inside
 * `layout.dir`. The names are joined onto the directory and then renamed over,
 * so an unsafe or repeated name is a path escape or a self-replacement: `..` or
 * a separator leaves the journal directory, `headFile === logFile` makes the
 * head rename replace the log, and `lockFile === ownerFile` makes the owner
 * rename replace the flocked inode. Refused before any filesystem effect.
 */
export class InvalidJournalLayoutError extends JournalError {
  constructor(public readonly label: string, reason: string) {
    super(`journal "${label}": invalid layout — ${reason}`);
  }
}
