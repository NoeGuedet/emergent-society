import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JournalError } from './errors.js';
import { lockPath } from './layout.js';

/**
 * Single-writer ownership for one node's journal.
 *
 * The invariant: at most one live owner may hold a node's journal. A stable
 * flock sidecar serializes every lifecycle transition; the exclusive right
 * itself is a durable record naming the owner process (`{pid, startedAt,
 * token}`), so a crashed helper cannot strand or duplicate an ownership. The
 * read-decide-write of that record runs in a short-lived helper process held
 * under the flock — never in the parent — so a partial record is impossible
 * and a dead helper releases the kernel lock by itself.
 */
export class SessionAlreadyOwnedError extends JournalError {
  constructor(nodeUid: string) {
    super(`journal for node "${nodeUid}" is already owned by a live writer`);
  }
}

/**
 * The ownership guard is momentarily held by another transition. Nothing is
 * known about the state of ownership, so this is deliberately not reported as
 * a live owner: the caller may retry.
 */
export class JournalLockBusyError extends JournalError {
  constructor(public readonly nodeUid: string) {
    super(`journal for node "${nodeUid}": the ownership guard is busy`);
  }
}

/**
 * The ownership guard could not run at all — `flock`, the helper, or the child
 * process failed, or the wait ceiling elapsed. Ownership is unknown, so the
 * caller must fail closed rather than assume the journal is free.
 */
export class JournalLockUnavailableError extends JournalError {
  constructor(public readonly nodeUid: string, reason: string) {
    super(`journal for node "${nodeUid}": ownership guard unavailable — ${reason}`);
  }
}

/** The durable identity of an owner: its process, start time and random token. */
export interface OwnerIdentity {
  pid: number;
  startedAt: number | null;
  token: string;
}

/**
 * The exclusive right to write one node's journal. `release` is idempotent and
 * token-bound: it clears only the record it created, never a later owner's.
 */
export interface JournalOwnership {
  release(): Promise<void>;
}

const GUARD_PATH = fileURLToPath(new URL('./lock-guard.mjs', import.meta.url));
const FLOCK_PATH = '/usr/bin/flock';
const GUARD_WAIT_SECONDS = 5;
const GUARD_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC = 200;

/**
 * The guard's process launcher. A narrow seam so a test can substitute the child
 * or shorten the wait at the OS boundary without a production flag; production
 * always runs `/usr/bin/flock` around the helper with the fixed timeout.
 */
export const guardLauncher = {
  spawn(args: string[], timeoutMs: number): ChildProcess {
    return spawn(FLOCK_PATH, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      // The bounded wait must actually end the critical section; SIGKILL cannot
      // be ignored by a wedged helper.
      killSignal: 'SIGKILL',
    });
  },
};

/** Decision codes the helper uses. */
const EXIT_OWNED = 10;
const EXIT_OWNER_GONE = 11;
const EXIT_BAD_PROTOCOL = 12;
const EXIT_HELPER_ERROR = 13;
/** `flock -E` reports a conflict with this reserved code, not the helper's. */
const FLOCK_CONFLICT_EXIT = 3;
/** `flock` exits with these when it cannot even start the helper. */
const FLOCK_STARTUP_EXITS = new Set([1, 64, 66, 69]);

/**
 * The guard died or ended without a recognized exit code, so whether it wrote
 * the record is unknown; only this outcome warrants a token-conditional
 * cleanup release.
 */
class UnknownGuardOutcomeError extends JournalLockUnavailableError {}

/**
 * Runs the ownership helper under the flock sidecar. A narrow seam so tests can
 * inject a guard failure at the dependency boundary without a production flag.
 */
export class LockGuard {
  constructor(private readonly dir: string, private readonly nodeUid: string) {}

  async run(command: 'acquire' | 'release', owner: OwnerIdentity): Promise<void> {
    const args = [
      // -F: flock execs the helper in place, so the spawned pid *is* the
      // critical section; killing it on timeout releases the kernel lock and
      // leaves no orphan that could still write a record.
      '-F',
      // -E: report contention with a reserved code distinct from flock's own
      // startup errors, so a broken guard is not mistaken for transient busy.
      '-E', String(FLOCK_CONFLICT_EXIT),
      `--wait=${GUARD_WAIT_SECONDS}`,
      '--exclusive',
      lockPath(this.dir),
      process.execPath,
      GUARD_PATH,
      command,
      this.dir,
      String(owner.pid),
      owner.startedAt === null ? 'null' : String(owner.startedAt),
      owner.token,
    ];
    const { code, diagnostic } = await this.spawnFlock(args);
    switch (code) {
      case 0:
        return;
      case EXIT_OWNED:
        throw new SessionAlreadyOwnedError(this.nodeUid);
      case EXIT_OWNER_GONE:
        throw new JournalLockUnavailableError(this.nodeUid, 'owning process is no longer alive');
      case EXIT_BAD_PROTOCOL:
        throw new JournalLockUnavailableError(this.nodeUid, 'guard rejected the request');
      case EXIT_HELPER_ERROR:
        throw new JournalLockUnavailableError(
          this.nodeUid, diagnostic === '' ? 'guard failed before deciding' : diagnostic,
        );
      case FLOCK_CONFLICT_EXIT:
        throw new JournalLockBusyError(this.nodeUid);
      default:
        // flock could not start the helper: a clean failure, not contention.
        if (FLOCK_STARTUP_EXITS.has(code)) {
          throw new JournalLockUnavailableError(
            this.nodeUid, diagnostic === '' ? `guard could not start (exit ${code})` : diagnostic,
          );
        }
        // Any other code is not one the helper emits, so the outcome is unknown.
        throw new UnknownGuardOutcomeError(
          this.nodeUid, diagnostic === '' ? `guard exited ${code}` : diagnostic,
        );
    }
  }

  private spawnFlock(args: string[]): Promise<{ code: number; diagnostic: string }> {
    return new Promise((resolve, reject) => {
      const child = guardLauncher.spawn(args, GUARD_TIMEOUT_MS);
      let diagnostic = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        if (diagnostic.length < MAX_DIAGNOSTIC) diagnostic += chunk.toString('utf8');
      });
      child.once('error', (err) => {
        reject(new JournalLockUnavailableError(this.nodeUid, sanitize(err.message)));
      });
      child.once('close', (code) => {
        if (code === null) {
          // Killed at the wait ceiling (or by a signal): the critical section
          // may have partially run, so the outcome is unknown.
          reject(new UnknownGuardOutcomeError(this.nodeUid, 'guard timed out'));
          return;
        }
        resolve({ code, diagnostic: sanitize(diagnostic) });
      });
    });
  }
}

/**
 * Acquires exclusive ownership of a node's journal for this process.
 *
 * @throws SessionAlreadyOwnedError when a live (or conservatively live) owner
 * already holds the journal.
 * @throws JournalLockBusyError when the guard is momentarily contended.
 * @throws JournalLockUnavailableError when the guard cannot run at all.
 */
export async function acquireLock(dir: string, nodeUid: string): Promise<JournalOwnership> {
  const identity: OwnerIdentity = {
    pid: process.pid,
    startedAt: await processStartTime(process.pid),
    token: randomBytes(16).toString('hex'),
  };
  const guard = new LockGuard(dir, nodeUid);
  try {
    await guard.run('acquire', identity);
  } catch (err) {
    // A refusal, a contention, a startup error or a helper decision means the
    // helper provably never wrote, so no cleanup is needed. Only a genuinely
    // unknown outcome (timeout, signal, unrecognized exit) may have written:
    // clear only a record carrying this exact token, never a live owner's.
    if (err instanceof UnknownGuardOutcomeError) {
      await guard.run('release', identity).catch(() => {});
    }
    throw err;
  }
  return new Ownership(guard, identity);
}

class Ownership implements JournalOwnership {
  private released = false;

  constructor(private readonly guard: LockGuard, private readonly identity: OwnerIdentity) {}

  async release(): Promise<void> {
    if (this.released) return;
    await this.guard.run('release', this.identity);
    this.released = true;
  }
}

/**
 * Process start time in clock ticks since boot, read from `/proc/<pid>/stat`
 * field 22 (the value after the command in parentheses and the state char).
 * Together with the PID it identifies a process across PID reuse.
 *
 * Returns null when `/proc` is unavailable (or the field is missing). At the
 * ownership layer that is not a pid-only fallback: the helper's `ownerIsAlive`
 * cannot prove the requester is alive, so it fails closed (`EXIT_OWNER_GONE`)
 * and every acquire is refused. Ownership therefore requires Linux `/proc` and
 * the hardcoded `flock`.
 */
export async function processStartTime(pid: number): Promise<number | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const field = rest[19];
  if (field === undefined) return null;
  const value = Number(field);
  return Number.isFinite(value) ? value : null;
}

/** Trims a child's diagnostic to a short, control-character-free line. */
function sanitize(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC);
}
