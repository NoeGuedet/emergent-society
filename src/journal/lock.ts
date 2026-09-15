import { readFile, rm, writeFile } from 'node:fs/promises';
import { JournalError } from './errors.js';
import { isErrno } from './fsutil.js';
import { lockPath } from './layout.js';

/**
 * Single-writer ownership for one node's journal.
 *
 * The invariant: at most one live writer may hold `nodes/<uid>/journal.v0.lock`.
 * The lock is a file created with `wx`, so acquisition is atomic; a lock whose
 * owner is provably gone may be taken over, and a second live owner is refused
 * with `SessionAlreadyOwnedError`. Ownership is identified by `{pid, startedAt}`
 * rather than the pid alone, because a recycled pid would otherwise read as a
 * live owner and strand the journal forever.
 */
export class SessionAlreadyOwnedError extends JournalError {
  constructor(nodeUid: string) {
    super(`journal for node "${nodeUid}" is already owned by a live writer`);
  }
}

interface LockRecord {
  pid: number;
  /** Process start time, so a recycled PID is detected as stale. */
  startedAt: number | null;
}

/**
 * The PID range `process.kill` accepts. A value outside it names no process at
 * all, so such a lock is stale rather than an unkillable live owner.
 */
const MAX_PID = 2 ** 31 - 1;

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PID;
}

export async function acquireLock(dir: string, nodeUid: string): Promise<void> {
  const path = lockPath(dir);
  const record = JSON.stringify(await currentLockRecord());
  try {
    await writeFile(path, record, { flag: 'wx' });
    return;
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err;
  }
  if (await isLockHeldByLiveProcess(path)) throw new SessionAlreadyOwnedError(nodeUid);
  // Stale lock: the previous owner is gone.
  await rm(path, { force: true });
  try {
    await writeFile(path, record, { flag: 'wx' });
  } catch (err) {
    // Another writer won the race between the removal and this write.
    if (isErrno(err, 'EEXIST')) throw new SessionAlreadyOwnedError(nodeUid);
    throw err;
  }
}

export async function releaseLock(dir: string): Promise<void> {
  await rm(lockPath(dir), { force: true });
}

async function currentLockRecord(): Promise<LockRecord> {
  return { pid: process.pid, startedAt: await processStartTime(process.pid) };
}

/**
 * Process start time in clock ticks since boot, read from `/proc/<pid>/stat`
 * field 22 (the value after the command in parentheses and the state char).
 * Together with the PID it identifies a process across PID reuse. Returns null
 * where `/proc` is unavailable, falling back to pid-only behaviour.
 */
async function processStartTime(pid: number): Promise<number | null> {
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

async function readLockRecord(path: string): Promise<LockRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  // Tolerate the bare-PID lock written by an older writer.
  const barePid = Number(raw.trim());
  if (isPid(barePid)) return { pid: barePid, startedAt: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isPid(parsed['pid'])) return null;
    const startedAt = parsed['startedAt'];
    if (startedAt !== null && (typeof startedAt !== 'number' || !Number.isFinite(startedAt))) {
      return null;
    }
    return { pid: parsed['pid'], startedAt: startedAt as number | null };
  } catch {
    return null;
  }
}

async function isLockHeldByLiveProcess(path: string): Promise<boolean> {
  const record = await readLockRecord(path);
  // Unparseable contents do not identify a live owner, so the lock is stale.
  if (record === null) return false;
  try {
    process.kill(record.pid, 0);
  } catch (err) {
    // EPERM means the process exists but is not ours — still a live owner.
    return !isErrno(err, 'ESRCH');
  }
  // The PID is alive; check that it is the same process and not a recycled one.
  if (record.startedAt === null) return true;
  const actual = await processStartTime(record.pid);
  // An unreadable start time cannot disprove ownership: treat it as live.
  if (actual === null) return true;
  return actual === record.startedAt;
}