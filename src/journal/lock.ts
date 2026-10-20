import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JournalError } from './errors.js';
import type { JournalLayout } from './layout.js';

/**
 * Single-writer ownership for one journal.
 *
 * The invariant: at most one live owner may hold a journal. A stable flock
 * sidecar serializes every lifecycle transition; the exclusive right itself is
 * a durable record naming the owner process (`{pid, startedAt, token}`), so a
 * crashed helper cannot strand or duplicate an ownership. The read-decide-write
 * of that record runs in a short-lived helper process held under the flock —
 * never in the parent — so a partial record is impossible and a dead helper
 * releases the kernel lock by itself.
 *
 * The journal is named by its `JournalLayout`; every diagnostic uses the
 * layout's `label` (`'frontier'` or a node uid), so the lock layer knows nothing
 * about nodes.
 */
export class SessionAlreadyOwnedError extends JournalError {
  constructor(label: string) {
    super(`journal "${label}" is already owned by a live writer`);
  }
}

/**
 * The ownership guard is momentarily held by another transition. Nothing is
 * known about the state of ownership, so this is deliberately not reported as
 * a live owner: the caller may retry.
 */
export class JournalLockBusyError extends JournalError {
  constructor(public readonly label: string) {
    super(`journal "${label}": the ownership guard is busy`);
  }
}

/**
 * The ownership guard could not run at all — `flock`, the helper, or the child
 * process failed, or the wait ceiling elapsed. Ownership is unknown, so the
 * caller must fail closed rather than assume the journal is free.
 */
export class JournalLockUnavailableError extends JournalError {
  constructor(public readonly label: string, reason: string) {
    super(`journal "${label}": ownership guard unavailable — ${reason}`);
  }
}

/** The durable identity of an owner: its process, start time and random token. */
export interface OwnerIdentity {
  pid: number;
  startedAt: number | null;
  token: string;
}

/**
 * The exclusive right to write one journal. `release` is idempotent and
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
      // The bounded wait ends the critical section: SIGKILL is delivered without
      // unwinding handlers. A helper wedged in uninterruptible kernel I/O (D
      // state) cannot be reaped until the call returns, so the timeout bounds
      // the lock, not the process's death.
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
 * One safe file name: no separator, no traversal, no empty name, and no NUL or
 * control character (which `spawn` would reject with a raw TypeError, or the
 * filesystem would carry into a diagnostic). The guard applies exactly the same
 * predicate to the names it receives, but the parent applies it first:
 * `/usr/bin/flock` opens its target before the guard parses argv, so guard-side
 * validation alone cannot protect the sidecar path.
 */
function isSafeFileName(name: string): boolean {
  return typeof name === 'string' && basename(name) === name
    && name !== '' && name !== '.' && name !== '..'
    && !/[\u0000-\u001f\u007f]/.test(name);
}

/**
 * Refuses a layout whose lock or owner name is not a plain file name. Applied
 * before either name is used, by the parent's sidecar pre-creation as well as
 * by the guard's argv build.
 */
function assertSafeNames(layout: JournalLayout): void {
  if (!isSafeFileName(layout.lockFile)) {
    throw new JournalLockUnavailableError(
      layout.label, `invalid lock file name ${JSON.stringify(layout.lockFile)}`,
    );
  }
  if (!isSafeFileName(layout.ownerFile)) {
    throw new JournalLockUnavailableError(
      layout.label, `invalid owner file name ${JSON.stringify(layout.ownerFile)}`,
    );
  }
}

/**
 * Runs the ownership helper under the flock sidecar. A narrow seam so tests can
 * inject a guard failure at the dependency boundary without a production flag.
 */
export class LockGuard {
  constructor(private readonly layout: JournalLayout) {}

  async run(command: 'acquire' | 'release', owner: OwnerIdentity): Promise<void> {
    const { dir, label, lockFile, ownerFile } = this.layout;
    assertSafeNames(this.layout);
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
      join(dir, lockFile),
      process.execPath,
      GUARD_PATH,
      command,
      dir,
      String(owner.pid),
      owner.startedAt === null ? 'null' : String(owner.startedAt),
      owner.token,
      '--lock', lockFile, '--owner', ownerFile,
    ];
    const { code, diagnostic } = await this.spawnFlock(args);
    switch (code) {
      case 0:
        return;
      case EXIT_OWNED:
        throw new SessionAlreadyOwnedError(label);
      case EXIT_OWNER_GONE:
        throw new JournalLockUnavailableError(label, 'owning process is no longer alive');
      case EXIT_BAD_PROTOCOL:
        throw new JournalLockUnavailableError(label, 'guard rejected the request');
      case EXIT_HELPER_ERROR:
        throw new JournalLockUnavailableError(
          label, diagnostic === '' ? 'guard failed before deciding' : diagnostic,
        );
      case FLOCK_CONFLICT_EXIT:
        throw new JournalLockBusyError(label);
      default:
        // flock could not start the helper: a clean failure, not contention.
        if (FLOCK_STARTUP_EXITS.has(code)) {
          throw new JournalLockUnavailableError(
            label, diagnostic === '' ? `guard could not start (exit ${code})` : diagnostic,
          );
        }
        // Any other code is not one the helper emits, so the outcome is unknown.
        throw new UnknownGuardOutcomeError(
          label, diagnostic === '' ? `guard exited ${code}` : diagnostic,
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
        reject(new JournalLockUnavailableError(this.layout.label, sanitize(err.message)));
      });
      child.once('close', (code) => {
        if (code === null) {
          // Killed at the wait ceiling (or by a signal): the critical section
          // may have partially run, so the outcome is unknown.
          reject(new UnknownGuardOutcomeError(this.layout.label, 'guard timed out'));
          return;
        }
        resolve({ code, diagnostic: sanitize(diagnostic) });
      });
    });
  }
}

/**
 * Creates the flock sidecar before `flock` touches it, with the journal's
 * owner-only mode. The external binary would otherwise create it with the
 * umask's modes.
 *
 * The file is opened for append, never truncated and never atomically replaced:
 * the sidecar must keep one inode across every lifecycle transition, and its
 * content may be a legacy record an older writer left there. An existing file's
 * mode is likewise left alone — re-moding would race another owner and break
 * the inode-identity guarantee the lock relies on.
 */
async function createLockSidecar(layout: JournalLayout): Promise<void> {
  assertSafeNames(layout);
  try {
    const handle = await open(join(layout.dir, layout.lockFile), 'a', 0o600);
    await handle.close();
  } catch (err) {
    throw new JournalLockUnavailableError(
      layout.label,
      `cannot create the lock sidecar — ${sanitize(err instanceof Error ? err.message : String(err))}`,
    );
  }
}

/**
 * Acquires exclusive ownership of a journal for this process.
 *
 * @throws SessionAlreadyOwnedError when a live (or conservatively live) owner
 * already holds the journal.
 * @throws JournalLockBusyError when the guard is momentarily contended.
 * @throws JournalLockUnavailableError when the guard cannot run at all.
 */
export async function acquireLock(layout: JournalLayout): Promise<JournalOwnership> {
  await createLockSidecar(layout);
  const identity: OwnerIdentity = {
    pid: process.pid,
    startedAt: await processStartTime(process.pid),
    token: randomBytes(16).toString('hex'),
  };
  const guard = new LockGuard(layout);
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
 * treats a live pid with an unknown start time as alive (it cannot prove a
 * *different* process holds the pid, so it refuses rather than reclaims), and a
 * recorded null-start owner is likewise conservatively live in `recordIsLive`.
 * The fail-closed `EXIT_OWNER_GONE` outcome occurs when the helper cannot read
 * `/proc/<pid>/stat` at all — the pid is gone, or the read fails (EPERM), which
 * `procInfo` reports as unknown — not for every null start time. Ownership
 * therefore requires Linux `/proc` and the hardcoded `flock`.
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
