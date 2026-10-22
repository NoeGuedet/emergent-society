import { basename, join } from 'node:path';
import { HASH_RE } from './canon.js';
import { InvalidJournalLayoutError, InvalidNodeUidError } from './errors.js';

/**
 * Where a journal lives, in one place. The on-disk layout is an interface of
 * its own (kernel.md §3): C1.2's kernel addresses these files at boot without
 * going through the writer, so every literal that spells a journal path belongs
 * here rather than at the call site.
 *
 * A layout names one journal: the cell home (the durability root and the shared
 * blob store root), the directory holding the log, the lock's diagnostic label,
 * and the four file names. Two profiles exist: the node's local log
 * (`nodeLayout(home, uid)`, named `log.v0.*`) and the cell's global frontier
 * journal (`frontierLayout(home)`, named `journal.v0.*`). The storage machinery
 * is identical; only the names differ.
 *
 * The uid is a technical identifier (kernel.md §3), and this module is where it
 * is validated: the `(home, uid)` constructors — `nodeDir` and `nodeLayout` —
 * funnel through `assertNodeUid`, so a rejected uid can never reach the
 * filesystem from any caller, direct writer included. `frontierLayout` takes no
 * uid and validates nothing: it builds a trusted layout for the directory the
 * kernel itself owns.
 *
 * The module also owns `Head` and `parseHead` — the shape of the one disposable
 * checkpoint that sits beside the log — so that the reader and the writer share
 * it without importing each other.
 */

/**
 * What a uid may be: one safe path segment that is also a valid git author and
 * a stable round-trip through git's identity fields. It must start with an
 * alphanumeric so `.` and `..` are impossible, and it may continue with
 * `A-Za-z0-9._-` up to 128 characters — no separator, no control character,
 * no whitespace, no leading dash or dot.
 */
export const NODE_UID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Validates a node uid, returning it unchanged.
 *
 * @throws InvalidNodeUidError when it is empty, too long, or carries a
 * character that is not safe in a path segment and a git identity.
 */
export function assertNodeUid(uid: string): string {
  if (typeof uid !== 'string' || !NODE_UID_RE.test(uid)) {
    throw new InvalidNodeUidError(String(uid), 'must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/');
  }
  return uid;
}

/**
 * One journal's layout. `home` is the durability root and the shared blob store
 * root; `dir` is the directory holding the log; `label` is the lock's
 * diagnostic identity (`'frontier'` or the node uid); the four names are the
 * log, its disposable head, the flock sidecar and the owner record.
 */
export type JournalLayout = {
  readonly home: string;
  readonly dir: string;
  readonly label: string;
  readonly logFile: string;
  readonly headFile: string;
  readonly lockFile: string;
  readonly ownerFile: string;
};

export const LOG_FILE = 'log.v0.jsonl.zstd';
export const LOCK_FILE = 'log.v0.lock';
export const OWNER_FILE = 'log.v0.owner';
export const HEAD_FILE = 'log.v0.head';

const FRONTIER_DIR = 'frontier';
const FRONTIER_LOG_FILE = 'journal.v0.jsonl.zstd';
const FRONTIER_LOCK_FILE = 'journal.v0.lock';
const FRONTIER_OWNER_FILE = 'journal.v0.owner';
const FRONTIER_HEAD_FILE = 'journal.v0.head';

/**
 * `nodes/<uid>/` — the node's local-log directory, inside the cell home. The uid
 * is validated here, before the join, so no caller can address a path outside
 * `home/nodes/`.
 */
export function nodeDir(home: string, nodeUid: string): string {
  return join(home, 'nodes', assertNodeUid(nodeUid));
}

/** The node's local log, in its `log.v0.*` profile. */
export function nodeLayout(home: string, nodeUid: string): JournalLayout {
  const uid = assertNodeUid(nodeUid);
  return {
    home,
    dir: nodeDir(home, uid),
    label: uid,
    logFile: LOG_FILE,
    headFile: HEAD_FILE,
    lockFile: LOCK_FILE,
    ownerFile: OWNER_FILE,
  };
}

/** The cell's global frontier journal, in its `journal.v0.*` profile. */
export function frontierLayout(home: string): JournalLayout {
  return {
    home,
    dir: join(home, FRONTIER_DIR),
    label: 'frontier',
    logFile: FRONTIER_LOG_FILE,
    headFile: FRONTIER_HEAD_FILE,
    lockFile: FRONTIER_LOCK_FILE,
    ownerFile: FRONTIER_OWNER_FILE,
  };
}

/**
 * One safe file name: a plain, non-empty segment that stays inside
 * `layout.dir` and carries no control character. This is the canonical copy
 * the lock adopts for its two names, so the runtime direction is lock →
 * layout — which keeps the invariant that the layout module never depends on
 * the lock.
 */
export function isSafeFileName(name: unknown): name is string {
  return typeof name === 'string' && basename(name) === name
    && name !== '' && name !== '.' && name !== '..'
    && !/[\u0000-\u001f\u007f]/.test(name);
}

const LAYOUT_FILE_FIELDS = ['logFile', 'headFile', 'lockFile', 'ownerFile'] as const;

/**
 * Refuses a layout whose four file names are unsafe or not pairwise distinct.
 *
 * The names are joined onto `dir` and later renamed over: a separator or `..`
 * escapes the journal directory, `headFile === logFile` lets the head rename
 * replace the log, and `lockFile === ownerFile` lets the owner rename replace
 * the flocked sidecar inode. Every open path validates before its first
 * filesystem effect, so a hand-built layout (types are not runtime-checked)
 * cannot reach a journal.
 *
 * @throws InvalidJournalLayoutError naming the first offending field.
 */
export function assertLayoutNames(layout: JournalLayout): void {
  for (const field of LAYOUT_FILE_FIELDS) {
    if (!isSafeFileName(layout[field])) {
      throw new InvalidJournalLayoutError(
        layout.label, `${field} ${JSON.stringify(layout[field])} is not a plain file name`,
      );
    }
  }
  const names = LAYOUT_FILE_FIELDS.map((field) => layout[field]);
  if (new Set(names).size !== names.length) {
    throw new InvalidJournalLayoutError(
      layout.label, 'the log, head, lock and owner file names must be pairwise distinct',
    );
  }
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