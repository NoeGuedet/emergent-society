import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDurableDirectory } from './journal/index.js';

/**
 * The kernel-owned line logs' shared cross-process append primitive.
 *
 * Two logs are written by more than one process — the conversation stream
 * (`conversation.v0.jsonl`: the nodes' driver and the overlay's cycle) and the
 * chat log (`chat.v0.jsonl`: the overlay's cycle, the interactive session and
 * `direct`) — and both follow ONE audited discipline, so it is written once
 * here rather than copied per log:
 *
 * - the caller's flock sidecar (`.es/<log>.lock`), a BLOCKING wait, created
 *   under `<home>/.es` with the durable owner-only directory discipline;
 * - under the lock, the torn-tail TERMINATION FIRST (a non-empty file not
 *   ending in a newline gets one prepended, so a crash fragment becomes its
 *   own droppable degraded line and the new record is never glued to it);
 * - THEN the record's start offset (the stat), one `O_APPEND` write and one
 *   `fsync`; a file this append created is 0600 and its directory entry is
 *   made durable.
 *
 * The boot-time truncate repair is the HOST's separate act, under the same
 * lock (`repairUnderLock`); a missing file is a new cell and creates nothing.
 * Node has no flock binding, so each critical section runs the short-lived
 * helper (`node/conversation-append.mjs`, the lock-guard precedent), exec'd by
 * util-linux `flock -F` so the lock fd stays held for the whole section.
 *
 * Failures are the fixed PATH-FREE `LockedAppendError`: the helper's own stderr
 * (a raw errno line carrying the absolute path) is drained and dropped, and
 * every caller maps the failure to its own bounded refusal. A caller that needs
 * a more specific message (an unavailable lock sidecar) distinguishes the
 * `ensureLockSidecar` call from the append/repair call.
 */

/** The kernel-owned sidecar directory every line log's flock lives in. */
export const LOCK_DIR = '.es';

const HELPER_PATH = fileURLToPath(new URL('./node/conversation-append.mjs', import.meta.url));
const FLOCK_PATH = '/usr/bin/flock';
/** The blocking wait's ceiling (the journal guard's own five seconds). */
const LOCK_WAIT_SECONDS = 5;
const HELPER_TIMEOUT_MS = 15_000;

/** One append's outcome: the record's start offset, its bytes, the create fact. */
export type LockedAppendOutcome = {
  readonly offset: number;
  readonly bytes: number;
  readonly created: boolean;
};

/** One boot repair's outcome: the truncated bytes and the file's size after it. */
export type LockedRepairOutcome = {
  readonly repaired: number;
  readonly size: number;
};

/**
 * What the boot repair does with a file that is NOTHING but a torn first
 * append (no newline anywhere in the repair window). The conversation stream
 * refuses (its records are kernel-stamped exchanges, and a no-newline stream
 * is beyond its record bound); the chat log follows its own truncate-to-zero
 * precedent, so one crashed first append cannot make the host unbootable.
 */
export type WholeFileTornPolicy = 'refuse' | 'truncate';

/** The bounded, path-free failure every locked write maps to. */
export class LockedAppendError extends Error {
  constructor(message = 'the kernel-owned line log could not be written') {
    super(message);
    this.name = 'LockedAppendError';
  }
}

/**
 * Ensures `<home>/.es` (0700, durable from the home down) and the named lock
 * sidecar (0600), returning the lock's path. A caller passes `<log>.lock`, so
 * the two logs never share a lock.
 */
export async function ensureLockSidecar(home: string, lockFile: string): Promise<string> {
  const dir = join(home, LOCK_DIR);
  await ensureDurableDirectory(dir, home);
  const lock = join(dir, lockFile);
  const handle = await open(lock, 'a', 0o600);
  await handle.close();
  return lock;
}

/**
 * Appends one newline-terminated line to `file`, under `lock`. The caller has
 * already validated the record; this primitive never interprets the bytes.
 */
export async function appendLineUnderLock(
  lock: string, file: string, line: string,
): Promise<LockedAppendOutcome> {
  const result = await runHelper(lock, 'append', file, line);
  const offset = result['offset'];
  const bytes = result['bytes'];
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset)
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes)) {
    throw new LockedAppendError('the kernel-owned line log writer returned no result');
  }
  return { offset, bytes, created: result['created'] === true };
}

/**
 * Truncates at most one incomplete trailing fragment, under `lock`. This is the
 * HOST's boot open's act; a clean file is untouched and a missing one creates
 * nothing (the helper reports the absence). `wholeFileTorn` selects the
 * no-newline-file policy: refuse (the conversation stream) or truncate to zero
 * (the chat log).
 */
export async function repairUnderLock(
  lock: string, file: string, wholeFileTorn: WholeFileTornPolicy = 'refuse',
): Promise<LockedRepairOutcome> {
  const result = await runHelper(
    lock, 'repair', file, '', wholeFileTorn === 'truncate' ? 'truncate-whole' : undefined,
  );
  const repaired = result['repaired'];
  const size = result['size'];
  if (typeof repaired !== 'number' || !Number.isSafeInteger(repaired)
    || typeof size !== 'number' || !Number.isSafeInteger(size)) {
    throw new LockedAppendError('the kernel-owned line log writer returned no result');
  }
  return { repaired, size };
}

/**
 * Runs the writer helper under the flock. `flock -F` execs the helper in place,
 * so the lock fd is held for the whole critical section and a timed-out wait
 * never runs the helper at all.
 *
 * Every failure is the fixed path-free `LockedAppendError`. The helper's own
 * stderr (a raw errno line, which would carry the absolute stream path) is
 * drained and dropped: it is never operator- or model-visible.
 */
function runHelper(
  lock: string, command: 'append' | 'repair', file: string, stdin: string, mode?: string,
): Promise<Record<string, unknown>> {
  const args = [
    '-F', '--exclusive', `--wait=${LOCK_WAIT_SECONDS}`, lock,
    process.execPath, HELPER_PATH, command, file,
    ...(mode !== undefined ? [mode] : []),
  ];
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(FLOCK_PATH, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: HELPER_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
    } catch {
      reject(new LockedAppendError());
      return;
    }
    let stdout = '';
    child.stdout.setEncoding('utf8');
    // Drained but never read: the helper's raw diagnostic can carry the path,
    // and a caller-visible result must not.
    child.stderr.on('data', () => { /* dropped on purpose */ });
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 4096) stdout += chunk;
    });
    // A helper that never reads (the wait expired) leaves the pipe closed; the
    // EPIPE is the exit path's business, not an unhandled stream error.
    child.stdin.on('error', () => { /* the exit code is the outcome */ });
    child.once('error', () => {
      reject(new LockedAppendError());
    });
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new LockedAppendError());
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new LockedAppendError('the kernel-owned line log writer returned no result'));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(new LockedAppendError('the kernel-owned line log writer returned no result'));
        return;
      }
      resolve(parsed as Record<string, unknown>);
    });
    child.stdin.end(stdin);
  });
}
