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
