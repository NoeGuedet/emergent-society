import { join } from 'node:path';
import { HASH_RE } from './canon.js';

/**
 * Where a node's journal lives, in one place. The on-disk layout is an interface
 * of its own (kernel.md §3): C1.2's kernel addresses these files at boot without
 * going through the writer, so every literal that spells a journal path belongs
 * here rather than at the call site.
 *
 * `nodeDir(home, uid)` builds a node's directory from the home; the `…Path(dir)`
 * helpers take that directory, which is what a writer or reader holds once it
 * has been resolved. The module also owns `Head` and `parseHead` — the shape of
 * the one disposable checkpoint that sits beside the log — so that the reader
 * and the writer share it without importing each other.
 */
export const LOG_FILE = 'journal.v0.jsonl.zstd';
export const LOCK_FILE = 'journal.v0.lock';
export const HEAD_FILE = 'journal.v0.head';

/** `nodes/<uid>/` — the node's journal directory, inside the cell home. */
export function nodeDir(home: string, nodeUid: string): string {
  return join(home, 'nodes', nodeUid);
}

/** The canonical log of a node. */
export function journalPath(dir: string): string {
  return join(dir, LOG_FILE);
}

/** The chain checkpoint of a node. */
export function headPath(dir: string): string {
  return join(dir, HEAD_FILE);
}

/** The single-writer lock of a node. */
export function lockPath(dir: string): string {
  return join(dir, LOCK_FILE);
}

/**
 * Chain checkpoint written by the flush barrier. It is *disposable*: the log is
 * the single truth and any missing, stale or malformed head is rebuilt from it,
 * so the reader and the writer share the type here rather than the reader
 * importing the writer.
 *
 * Unlike the log, the head is not part of the frozen format — it may be
 * rewritten or deleted at any time; only its shape is agreed.
 */
export interface Head {
  first_hash: string;
  last_hash: string;
  count: number;
  ts: number;
}

/**
 * Parses the head checkpoint. The head is disposable, so anything that is not a
 * well-formed checkpoint — missing, truncated, wrong shape, or carrying a hash
 * that is not 64 hex characters — is `null`, which the caller reads as "rebuild
 * from the log".
 */
export function parseHead(raw: string): Head | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const h = parsed as Record<string, unknown>;
  if (typeof h['first_hash'] !== 'string' || !HASH_RE.test(h['first_hash'])) return null;
  if (typeof h['last_hash'] !== 'string' || !HASH_RE.test(h['last_hash'])) return null;
  if (!Number.isSafeInteger(h['count']) || (h['count'] as number) < 0) return null;
  if (typeof h['ts'] !== 'number' || !Number.isFinite(h['ts'])) return null;
  return h as unknown as Head;
}