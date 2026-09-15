/**
 * Chain checkpoint written by the flush barrier. It is *disposable*: the log is
 * the single truth and any missing, stale or malformed head is rebuilt from it,
 * so the reader and the writer share the type here rather than the reader
 * importing the writer.
 *
 * Unlike the log, the head is not part of the frozen format — it may be
 * rewritten or deleted at any time; only its shape is agreed.
 */
export const HEAD_FILE = 'journal.v0.head';

export interface Head {
  first_hash: string;
  last_hash: string;
  count: number;
  ts: number;
}
