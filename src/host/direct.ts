import { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { GitCommandError, UnsafeWorldPathError, WorldHeadError, WorldNotARepoError } from '../node/errors.js';
import { MAX_SPEAK_BYTES } from '../node/conversation.js';
import {
  RatifyIoError, RatifyRefusedError, ratify, worldIoOf, type RatifyOutcome,
} from '../node/world-ratify.js';
import { WorldRepo } from '../node/world.js';
import { GATEWAY_CHARTER_FILE } from '../overlay/charter.js';
import { validateTreePath } from '../overlay/world-read.js';
import { isErrno } from '../journal/index.js';
import { singleLine } from '../text.js';
import {
  CHAT_ABSENT_OVERLAY_NOTICE, ChatWriteError, ChatWriter,
} from './chat.js';
import {
  readPinnedOperatorFile, type PinnedOperatorPin,
} from './charter-file.js';
import { HostConfigError, UsageError } from './errors.js';
import {
  assertCellLayout, assertHomePermissions, worldPairOf,
} from './layout.js';

/**
 * `direct`: the human's write act — TWO acts, one command (A6).
 *
 * THE DEFAULT ACT is the chat reply, the batch twin of typing in the G4
 * session: `direct --home <dir> (--text "<msg>" | --file <abs>)` appends ONE
 * `{v:0, at, uid:'human', text}` record to the chat log through the existing
 * `ChatWriter` (0600, under `<home>/.es/chat.lock`, the full termination-first
 * discipline — this module duplicates none of it). The running host's
 * `ChatWatcher` sees the growth on its size poll and triggers the overlay's
 * cycle cross-process; this command does not wait, exactly like the session's
 * timeout path, and makes NO world commit: the human's words are chat-private,
 * and the society can only hear them if the overlay relays a direction through
 * its own `send_message`. The reply cap is 8192 bytes and it must be non-blank.
 * The confirmation says the record LANDED and what happens next — and when the
 * `gateway.charter.md` sidecar is absent it reuses the session's honest
 * sentence verbatim: the message is saved either way.
 *
 * THE `--path` ACT is the ratification: `direct --home <dir> --path
 * <world-relative> --file <abs>` writes the validated bytes and commits them
 * authored `human`. The machinery is `node/world-ratify.ts` (the fresh private
 * index, the stdin hash, the mode rule, the unchanged question, the both-pairs
 * identity, the CAS, the re-seeding retry, materialize-first); this module owns
 * the operator surface: the `--file` read discipline (the shared pinned
 * `charter-file.ts` core: the configured legacy world-root alias is the only
 * trusted symlink prefix, every ancestor and the leaf are no-follow, regular,
 * UTF-8, bounded, `providers.json` refused by path AND inode), the tree-path
 * form (the same discipline as the overlay's `read_world`), the world's gates
 * (`WorldRepo.open`: cell layout, home permissions, the legacy world's
 * migration refusal, the trust scan), the audit line, and the exit codes.
 *
 * THE FLAG COMBINATIONS are strict (A6): `--text` XOR `--file`, exactly one;
 * `--path` requires `--file` and refuses `--text`; the bare default (with
 * `--text`/`--file`) is the chat reply. The parser enforces all of it, so this
 * module never sees an ambiguous act.
 *
 * EXIT CODES: `0` ok (the reply is saved; the commit landed; or the tree was
 * already the ratified one — `unchanged: no commit — the pin did not move`);
 * `1` a runtime failure (a git failure; an unwritable home on the reply's chat
 * write or the ratification's `.es` write, whose raw `EACCES` is a bounded
 * refusal); `2` usage, a missing home, the flag refusals, a path escape, a
 * refused file or target, and — for the `--path` act ONLY — the world's gates
 * (a foreign-owned or permissive home, a legacy in-world layout, a refused
 * trust scan). The reply act never runs those gates: its surface is the chat
 * log, so it saves on a home whose layout the ratification would refuse.
 *
 * POST-CAS PRECEDENCE: a failed worktree rename or a failed shared-index update
 * after the commit landed is a NAMED WARNING on stderr and still exit `0` — the
 * commit is the act, and a reported divergence is never a silent half-act. The
 * unchanged path's own materialization failure is the same: exit `0`, one
 * warning, the no-commit sentence.
 */

/** The unchanged path's sentence: the tree already carried the ratified bytes. */
export const DIRECT_UNCHANGED_NOTICE = 'unchanged: no commit — the pin did not move';

/** The reply's confirmation when an overlay is configured (it digests asynchronously). */
export function renderReplySaved(bytes: number): string {
  return `saved: 1 uid: human chat record (${bytes} bytes); the chat log only, no world commit`
    + ' — the overlay will digest it on its next cycle\n';
}

/** The reply's confirmation when no overlay is configured (the session's wording). */
export function renderReplyAbsent(bytes: number): string {
  return `saved: 1 uid: human chat record (${bytes} bytes); the chat log only, no world commit\n`
    + `${CHAT_ABSENT_OVERLAY_NOTICE}\n`;
}

/** The ratification's audit line: the commit hash always (A6). */
export function renderRatifyCommitted(commit: string, path: string): string {
  return `committed ${commit} (author: human) ${path}\n`;
}

/** The unchanged path's audit line, with the materialization fact when it happened. */
export function renderRatifyUnchanged(materialized: boolean): string {
  return materialized
    ? `${DIRECT_UNCHANGED_NOTICE} (the worktree copy was restored)\n`
    : `${DIRECT_UNCHANGED_NOTICE}\n`;
}

/** Everything one `direct` invocation needs; the seams are test-only interleaves. */
export type DirectOptions = {
  readonly home: string;
  /** The reply's inline message (mutually exclusive with `file`). */
  readonly text?: string;
  /** The reply's message file, or the ratification's bytes (absolute). */
  readonly file?: string;
  /** The ratification's world-relative tree path (requires `file`). */
  readonly path?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly now?: () => number;
  /** The ratification's CAS-interleave seam (after commit-tree, before update-ref). */
  readonly beforePublish?: (parent: string | null) => Promise<void>;
  /** The ratification's scar seam (after a successful CAS, before the rename). */
  readonly afterPublish?: (commit: string) => Promise<void>;
  /**
   * Test-only: fires once after the source read's final parent pin and before
   * the leaf lstat/open (the reply's source read, and the ratification's source
   * read; never the materialization).
   */
  readonly afterPinned?: (pin: PinnedOperatorPin) => Promise<void>;
  /** Test-only: the source read's proc-filesystem root; also passed to `ratify`. */
  readonly procRoot?: string;
};

/**
 * Runs one `direct` act and resolves the process exit code.
 *
 * The command never throws: every refusal is printed once on stderr (a bounded
 * line, never a raw git stderr or an absolute temp path) and mapped onto the
 * documented code. The two acts are dispatched here, so the parser's flag
 * discipline and the CLI's mapping stay one small surface.
 */
export async function runDirect(options: DirectOptions): Promise<number> {
  const out = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    if (options.path !== undefined) return await runRatify(options, out, err);
    return await runReply(options, out, err);
  } catch (error) {
    err(`error: ${describeFailure(error)}\n`);
    return exitCodeFor(error);
  }
}

/** The default act: one chat record through the existing `ChatWriter`. */
async function runReply(
  options: DirectOptions, out: (text: string) => void, _err: (text: string) => void,
): Promise<number> {
  await assertHomeDirectory(options.home);
  const text = await replyText(options);
  const bytes = Buffer.byteLength(text, 'utf8');
  // The reply's own contract, checked before any filesystem effect: the writer
  // would refuse both, but a one-shot command reports them as its refusal (2),
  // not as a runtime write failure.
  if (text.trim() === '') throw new HostConfigError('a chat message cannot be blank');
  if (bytes > MAX_SPEAK_BYTES) {
    throw new HostConfigError(`a chat message cannot exceed ${MAX_SPEAK_BYTES} bytes`);
  }
  const now = options.now ?? (() => Date.now());
  const appended = await ChatWriter.for(options.home).append(text, now());
  out((await overlayConfigured(options.home))
    ? renderReplySaved(appended.bytes)
    : renderReplyAbsent(appended.bytes));
  return 0;
}

/** The reply's text: `--text` verbatim, or the file's bytes minus one line terminator. */
async function replyText(options: DirectOptions): Promise<string> {
  if (options.text !== undefined) return options.text;
  if (options.file === undefined) {
    throw new UsageError('direct requires --text "<msg>" or --file <abs-path>');
  }
  const file = await readPinnedOperatorFile(options.home, options.file, 'the message file', {
    worldRoot: worldPairOf(options.home).world,
    allowEmpty: true,
    ...(options.afterPinned !== undefined ? { afterPinned: options.afterPinned } : {}),
    ...(options.procRoot !== undefined ? { procRoot: options.procRoot } : {}),
  });
  // A message FILE conventionally ends in a newline; the record is the line the
  // session's own typing would have produced, so one trailing line terminator is
  // the file's and not the message's.
  return file.text.replace(/\r?\n$/, '');
}

/** The `--path` act: the gates, the read discipline, the ratified commit. */
async function runRatify(
  options: DirectOptions, out: (text: string) => void, err: (text: string) => void,
): Promise<number> {
  const path = options.path;
  if (path === undefined || options.file === undefined) {
    // Unreachable through the parser; kept as the contract's own refusal.
    throw new UsageError('the ratification needs --path <world-relative> and --file <abs-path>');
  }
  // The world's gates, in the host's own order: an existing home owned by this
  // uid with mode 0700, the cell layout (the legacy in-world `.git` gets the
  // sanitizing migration recipe, exit 2), and the trust scan inside open.
  await assertHomePermissions(options.home);
  await assertCellLayout(options.home);
  let treePath: string;
  try {
    treePath = validateTreePath(path);
  } catch (error) {
    throw new HostConfigError(error instanceof Error ? error.message : 'the --path is invalid');
  }
  const pair = worldPairOf(options.home);
  // The source read stays before any world open and any CAS. `procRoot` is
  // forwarded to the source read only on the reply act: the ratification gives
  // it to `ratify`'s post-CAS materialization instead, so an absent `/proc`
  // cannot mask the existing post-CAS warning behind a pre-CAS refusal.
  const file = await readPinnedOperatorFile(options.home, options.file, 'the ratification file', {
    worldRoot: pair.world,
    allowEmpty: true,
    ...(options.afterPinned !== undefined ? { afterPinned: options.afterPinned } : {}),
  });
  const repo = await WorldRepo.open(pair.world, { gitDir: pair.gitDir });
  const outcome: RatifyOutcome = await ratify(worldIoOf(repo), {
    path: treePath,
    bytes: file.bytes,
    ...(options.beforePublish !== undefined ? { beforePublish: options.beforePublish } : {}),
    ...(options.afterPublish !== undefined ? { afterPublish: options.afterPublish } : {}),
    ...(options.procRoot !== undefined ? { procRoot: options.procRoot } : {}),
  });
  for (const warning of outcome.warnings) err(`warning: ${warning}\n`);
  out(outcome.kind === 'committed'
    ? renderRatifyCommitted(outcome.commit ?? '', treePath)
    : renderRatifyUnchanged(outcome.materialized));
  return 0;
}

/** The absent-overlay probe: the charter sidecar's presence (the session's residual). */
async function overlayConfigured(home: string): Promise<boolean> {
  try {
    await lstat(join(home, GATEWAY_CHARTER_FILE));
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false;
    throw error;
  }
}

/** The reply's home gate: the session's own (a missing home is exit 2). */
async function assertHomeDirectory(home: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(home);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      throw new HostConfigError('home does not exist; run init');
    }
    throw error;
  }
  if (!entry.isDirectory()) {
    throw new HostConfigError(`home must be a directory: ${home}`);
  }
}

/** The documented exit code of one refusal. */
function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError || error instanceof HostConfigError) return 2;
  if (error instanceof WorldNotARepoError || error instanceof UnsafeWorldPathError) return 2;
  if (error instanceof RatifyRefusedError) return 2;
  return 1;
}

/**
 * One bounded failure line. A git failure never echoes its stderr (it can carry
 * absolute paths and, on a hostile world, arbitrary text): the sentence names
 * the class, and the world-flock conflict gets its own wording so the operator
 * knows a retry is the repair.
 */
function describeFailure(error: unknown): string {
  if (error instanceof GitCommandError) {
    return /world lock is held/i.test(error.stderr)
      ? 'the world is busy: another writer holds the world lock; nothing landed (retry)'
      : `the world's git refused the ratification (git ${error.kind}); nothing landed`;
  }
  if (error instanceof WorldHeadError) return error.message;
  if (error instanceof RatifyIoError || error instanceof RatifyRefusedError
    || error instanceof HostConfigError || error instanceof UsageError
    || error instanceof WorldNotARepoError || error instanceof UnsafeWorldPathError
    || error instanceof ChatWriteError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : 'the direct command failed';
  return singleLine(message, 300);
}
