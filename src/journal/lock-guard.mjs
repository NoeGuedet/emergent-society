// The short flock-guarded critical section of journal ownership.
//
// This is plain JS on purpose: it is executed by `process.execPath` (Node 24)
// as a child, wrapped by util-linux `flock` so that the kernel holds an
// exclusive lock on the stable sidecar for exactly the lifetime of this
// process. All read-decide-write work therefore happens here, in a process
// whose death releases the lock and can never leave a partially written
// record. The parent never races a dying lease: the durable owner record is
// what grants lifetime exclusion, and the flock only serializes transitions.
//
// Known commands only. Arguments arrive as separate argv literals; the parent
// never uses a shell.
import {
  closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, truncateSync, writeSync,
} from 'node:fs';

const LOCK_FILE = 'journal.v0.lock';
const OWNER_FILE = 'journal.v0.owner';
const MAX_PID = 2 ** 31 - 1;
const TOKEN_RE = /^[0-9a-f]{32}$/;

// Distinct, high exit codes so the parent can tell a decision from a guard
// failure; 1 is reserved for the `flock` wrapper's own contention exit.
const EXIT_OWNED = 10;
const EXIT_OWNER_GONE = 11;
const EXIT_BAD_PROTOCOL = 12;
const EXIT_ERROR = 13;

function fail(code, reason) {
  process.stderr.write(`lock-guard: ${reason}\n`);
  process.exit(code);
}

function parseArgv(argv) {
  const [command, dir, pidRaw, startedRaw, token] = argv;
  if (command !== 'acquire' && command !== 'release') fail(EXIT_BAD_PROTOCOL, 'unknown command');
  if (typeof dir !== 'string' || dir.length === 0) fail(EXIT_BAD_PROTOCOL, 'bad dir');
  const pid = Number(pidRaw);
  if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) fail(EXIT_BAD_PROTOCOL, 'bad pid');
  let startedAt;
  if (startedRaw === 'null') startedAt = null;
  else {
    startedAt = Number(startedRaw);
    if (!Number.isInteger(startedAt) || startedAt < 0) fail(EXIT_BAD_PROTOCOL, 'bad startedAt');
  }
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) fail(EXIT_BAD_PROTOCOL, 'bad token');
  return { command, dir, pid, startedAt, token };
}

/**
 * The process table entry for `pid`, or null when the pid names no process.
 * A pid whose stat is unreadable (EPERM) is reported alive-but-unknown so a
 * real owner is never mistaken for stale; only ENOENT means gone.
 */
function procInfo(pid) {
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { state: '?', startedAt: null, unknown: true };
  }
  const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  const startedAt = Number(rest[19]);
  return {
    state: rest[0],
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    unknown: false,
  };
}

/** A recorded process that is still the same live process (conservative). */
function recordIsLive(record) {
  const info = procInfo(record.pid);
  if (info === null) return false;
  if (info.unknown) return true;
  if (info.state === 'Z') return false;
  if (record.startedAt === null || record.startedAt === undefined) return true;
  if (info.startedAt === null) return true;
  return info.startedAt === record.startedAt;
}

/** The requesting owner must still be the same live process, definitively. */
function ownerIsAlive(pid, startedAt) {
  const info = procInfo(pid);
  if (info === null || info.unknown || info.state === 'Z') return false;
  if (startedAt === null) return true;
  return info.startedAt !== null && info.startedAt === startedAt;
}

// Only ENOENT means "nothing here". Any other read error (EACCES, EIO, EISDIR)
// must not be treated as "no owner": that would let acquire overwrite a live
// owner's record. The error propagates to the top-level handler, which fails
// closed with the unavailable exit code.
function readRaw(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.trim() === '' ? null : raw;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The current owner candidate: a new-format record in the owner file, or a
 * legacy record (bare pid, or `{pid, startedAt}`) left in the sidecar by an
 * older writer. Unparseable content names no owner, but a *read failure* throws
 * so the caller fails closed rather than overwriting a record it cannot read.
 */
function readCandidate(sidecar, owner) {
  const ownerRaw = readRaw(owner);
  if (ownerRaw !== null) {
    try {
      const parsed = JSON.parse(ownerRaw);
      if (typeof parsed === 'object' && parsed !== null && Number.isInteger(parsed.pid)) {
        return { pid: parsed.pid, startedAt: parsed.startedAt ?? null };
      }
    } catch { /* fall through to legacy */ }
    return null;
  }
  const sidecarRaw = readRaw(sidecar);
  if (sidecarRaw === null) return null;
  const barePid = Number(sidecarRaw.trim());
  if (Number.isInteger(barePid) && barePid > 0 && barePid <= MAX_PID) {
    return { pid: barePid, startedAt: null };
  }
  try {
    const parsed = JSON.parse(sidecarRaw);
    if (typeof parsed === 'object' && parsed !== null && Number.isInteger(parsed.pid)) {
      return { pid: parsed.pid, startedAt: parsed.startedAt ?? null };
    }
  } catch { /* unparseable */ }
  return null;
}

// A process-local counter keeps temp names unique without pulling in crypto;
// a distinct helper process always has a distinct pid.
let tempCounter = 0;

// `writeSync` may write fewer bytes than asked, so the loop keeps writing until
// the whole record is durable. Zero progress is a stall, not a success: it is
// raised as a guard error so the parent fails closed instead of trusting a
// partial record.
function writeAllSync(fd, buf) {
  let written = 0;
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written);
    if (n === 0) throw new Error('owner record write made no progress');
    written += n;
  }
}

// The record's own temp file is fsynced before the rename, so the rename can
// never expose a partial record. The rename's directory entry is deliberately
// not fsynced: losing it in a crash only reverts to the previous (dead-owner)
// record, which the next acquire reclaims under the guard — never corruption.
function writeOwnerAtomic(owner, record) {
  const tmp = `${owner}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;
  const fd = openSync(tmp, 'wx');
  try {
    writeAllSync(fd, Buffer.from(JSON.stringify(record)));
    fsyncSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch { /* already closed or unclosable */ }
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, owner);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function clearLegacy(sidecar) {
  // Best-effort: ownership is already recorded, so a legacy sidecar that cannot
  // be read or truncated must not fail the acquire after the fact.
  try {
    if (readRaw(sidecar) === null) return;
    truncateSync(sidecar, 0);
  } catch { /* leave the legacy content in place */ }
}

function acquire(sidecar, owner, identity) {
  const candidate = readCandidate(sidecar, owner);
  if (candidate !== null && recordIsLive(candidate)) process.exit(EXIT_OWNED);
  // The requesting owner may have been killed while this helper waited on the
  // flock: writing a record for a dead owner would strand the journal, so the
  // orphan-late acquire is refused instead.
  if (!ownerIsAlive(identity.pid, identity.startedAt)) process.exit(EXIT_OWNER_GONE);
  writeOwnerAtomic(owner, { pid: identity.pid, startedAt: identity.startedAt, token: identity.token });
  clearLegacy(sidecar);
  process.exit(0);
}

function release(owner, identity) {
  const raw = readRaw(owner);
  if (raw !== null) {
    let record = null;
    try { record = JSON.parse(raw); } catch { record = null; }
    // Only a record carrying this exact token is ours; a later owner's record
    // (or one already removed) is left untouched, so release is idempotent and
    // never removes somebody else's ownership.
    if (record !== null && record.token === identity.token && record.pid === identity.pid) {
      rmSync(owner, { force: true });
    }
  }
  process.exit(0);
}

try {
  const identity = parseArgv(process.argv.slice(2));
  const sidecar = `${identity.dir}/${LOCK_FILE}`;
  const owner = `${identity.dir}/${OWNER_FILE}`;
  if (identity.command === 'acquire') acquire(sidecar, owner, identity);
  else release(owner, identity);
} catch (err) {
  fail(EXIT_ERROR, err instanceof Error ? err.message : String(err));
}
