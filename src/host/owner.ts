import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  link, lstat, open, readFile, rename, unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { assertNodeUid, atomicWriteFile, syncPath } from '../journal/index.js';
import { processStartTime } from '../journal/lock.js';
import { singleLine } from '../text.js';
import {
  HostAlreadyRunningError, HostConfigError, HostPauseError,
} from './errors.js';

/**
 * The host owner record: one cell home's live-host marker, its liveness
 * classification, and the compare-and-swap that publishes and clears it.
 *
 * `<home>/host.json` is the address a second `start` refuses against and the
 * target `pause` signals. It is liveness metadata, not a truth artifact: the
 * journals and the world carry durability, so this module adds **no lock file**
 * and **no directory fsync**. Exclusion between two hosts comes from the
 * journals' own writer locks; the record only has to answer "is a host running
 * here, and which pid is it?" without ever deleting a live owner's record.
 *
 * The failure mode a plain "read, decide, unlink" protocol has is a lost-race
 * delete: two hosts read the same stale record, both decide to reclaim, and the
 * loser removes the winner's fresh record. The fix is a rename-based
 * compare-and-swap. `host.json` is atomically moved to a private claim path,
 * the *moved* file is re-validated and re-classified, and only a record that
 * still looks stale — and whose token matches what was pre-read, or which was
 * absent/malformed before — is discarded. Anything else is restored, and the
 * owner path is never unlinked after a lost race.
 *
 * Two residuals are disclosed rather than papered over. A reclaim or release
 * moves `host.json` aside and only then links a record back, so between those
 * two steps `pause` and `status` observe `absent`. That window is short in the
 * normal case but not bounded to a sub-millisecond instant, and if the process
 * dies inside it the record stays at the claim path and the absence becomes
 * durable — recovery from the claim is manual, exactly like the documented
 * stale-record remedy. This is the price of doing the CAS without a second
 * lock. And `requestPause` has an unavoidable PID-reuse window between its
 * `readOwner` and its `process.kill`: the recorded `/proc` start time makes that
 * a same-instant race, not a guarantee, and the plan claims no absolute
 * protection against it.
 *
 * `readOwner` is total: a hand-edited, truncated, symlinked or non-regular
 * `host.json` reads as `stale(record: null)` (or `absent`), never a throw, so
 * `pause` and `status` can act on a damaged home. It refuses a link as observed
 * by `lstat`; it does not follow one. A same-uid swap between the `lstat` and
 * the `readFile` is outside the threat model — that uid can already read the
 * credential store.
 */

/** The command a host was asked to run; carried in the record for `status`. */
export type HostCommand = 'start' | 'resume';

/**
 * The host-lifetime fence fact: whether this boot commits under a cgroup fence.
 * It is known only after the attach, so it is annotated onto the record once the
 * cell tree exists (or is known absent), and no later successful commit clears
 * it — an unfenced commit stays an operator-visible fact for the host's life.
 */
export type OwnerFence = 'available' | 'unavailable';

/** The on-disk shape of `<home>/host.json`: seven keys, plus the optional host facts. */
export type HostOwnerRecord = {
  readonly v: 1; readonly pid: number; readonly startTime: number | null;
  readonly token: string; readonly uid: string;
  readonly command: HostCommand; readonly startedAt: number;
  /**
   * The confinement mode this host was started with, so `status` can surface
   * it without reading any journal. Optional: every record written before the
   * mode was recorded is a 7-key record and the reader accepts both shapes —
   * the upgrade guarantee, without which an old live record would read
   * `stale` and a new `start` would reclaim it (the lost-record hazard this
   * module exists to prevent).
   */
  readonly sandbox?: 'landlock' | 'off';
  /**
   * Whether this host booted with a usable commit fence. Written after the
   * cgroup attach (availability is known only then); optional so every record
   * from before the field stays valid, and the same upgrade guarantee applies.
   */
  readonly fence?: OwnerFence;
  /** One bounded class label for an unavailable fence; never a path or payload. */
  readonly fenceReason?: string;
};

/**
 * What a record proves. `live` means the recorded pid is alive *and* its
 * `/proc` start time matches, so it cannot be a reused pid; `stale` means the
 * pid is gone, a zombie, or provably another process; `unverified` means the
 * record or the current process carries no start time, so identity cannot be
 * proven and the record is treated conservatively.
 */
export type OwnerState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'live'; readonly record: HostOwnerRecord }
  | { readonly kind: 'unverified'; readonly record: HostOwnerRecord }
  | { readonly kind: 'stale'; readonly record: HostOwnerRecord | null };

/**
 * The liveness seams. Every one is optional and production-total; the tests
 * substitute `state`, `alive` and `kill` to reach the zombie, ESRCH and EPERM
 * branches without a production flag. `kill` is **only** the SIGTERM transport
 * `requestPause` uses — liveness always goes through `process.kill(pid, 0)`
 * directly, so a substituted `kill` cannot change what counts as alive.
 */
export type OwnerLivenessDeps = {
  readonly alive?: (pid: number) => boolean | Promise<boolean>;
  readonly state?: (pid: number) => Promise<string | null>;
  readonly startTime?: (pid: number) => Promise<number | null>;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
};

/** The right to one home's owner record; `release` is idempotent and token-bound. */
export interface OwnerHandle {
  readonly record: HostOwnerRecord;
  release(): Promise<void>;
  /**
   * Adds the host-lifetime fence fact to the published record, atomically
   * (0600 tmp + rename) and only while the record at `<home>/host.json` still
   * carries this handle's `(pid, token)` — a record a reclaim swapped in is
   * never overwritten. A no-op after release or after the record is no longer
   * ours. The reason, when present, is bounded here.
   */
  annotate(input: {
    readonly fence: OwnerFence;
    readonly fenceReason?: string;
  }): Promise<void>;
}

/** The result of asking a host to stop. `exited` means released, not reaped. */
export type PauseOutcome =
  | { readonly kind: 'exited' }
  | { readonly kind: 'still-stopping'; readonly pid: number }
  | { readonly kind: 'no-host'; readonly state: 'absent' | 'stale' | 'unverified' };

/** The fixed pause ceiling and poll interval, exported so tests need no flag. */
export const PAUSE_TIMEOUT_MS = 10_000;
export const PAUSE_POLL_MS = 100;

const OWNER_BASENAME = 'host.json';
/**
 * Every key a record may carry: the seven required pre-mode keys plus the
 * optional host facts (`sandbox`, `fence`, `fenceReason`). They live here so the
 * unknown-key guard accepts them; each presence is validated separately in
 * `parseRecord`.
 */
const RECORD_KEYS = [
  'v', 'pid', 'startTime', 'token', 'uid', 'command', 'startedAt',
  'sandbox', 'fence', 'fenceReason',
] as const;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const RESTORE_ATTEMPTS = 3;
const RESTORE_DELAY_MS = 10;
const MAX_DIAGNOSTIC = 200;
/** The fence reason's bound; the reader re-bounds it like a written value. */
const MAX_FENCE_REASON = 120;

function ownerPath(home: string): string {
  return join(home, OWNER_BASENAME);
}

/**
 * What one path holds, with every failure folded into a value: `absent` for
 * ENOENT, `non-regular` for a symlink, directory, or a path that cannot be
 * `lstat`ed at all, `invalid` for a regular file whose bytes are not a valid
 * record, and `record` otherwise. A non-regular claim is never parsed, so a
 * planted link can neither redirect the read nor be mistaken for garbage.
 */
type ClaimRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'non-regular' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'record'; readonly record: HostOwnerRecord };

async function readClaim(path: string): Promise<ClaimRead> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch (err) {
    // ENOENT is "no owner"; EACCES/EIO/... leave the state unknown, and an
    // unknown owner must refuse rather than be reclaimed as free.
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'non-regular' };
  }
  if (!entry.isFile()) return { kind: 'non-regular' };
  try {
    const record = parseRecord(JSON.parse(await readFile(path, 'utf8')) as unknown);
    return record === null ? { kind: 'invalid' } : { kind: 'record', record };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Total validation: only known keys, `v === 1`, a safe-int pid > 0, a safe-int
 * `startTime` ≥ 0 or null, a 32-hex token, a journal-valid uid, a known command,
 * a safe-int `startedAt`, and — when present — a known sandbox mode, a known
 * fence state and a string fence reason. The seven pre-mode keys stay required;
 * the host facts are optional, so a record from any generation parses and an
 * unknown key still fails. Anything else is `null`, never a throw.
 */
function parseRecord(raw: unknown): HostOwnerRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (!keys.every((key) => (RECORD_KEYS as readonly string[]).includes(key))) return null;
  if (fields['v'] !== 1) return null;
  const pidValue = fields['pid'];
  const pid = typeof pidValue === 'number' && Number.isSafeInteger(pidValue) && pidValue > 0
    ? pidValue
    : null;
  if (pid === null) return null;
  const startValue = fields['startTime'];
  let startTime: number | null;
  if (startValue === null) {
    startTime = null;
  } else if (typeof startValue === 'number' && Number.isSafeInteger(startValue) && startValue >= 0) {
    startTime = startValue;
  } else {
    return null;
  }
  const token = fields['token'];
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const uid = fields['uid'];
  if (typeof uid !== 'string') return null;
  assertNodeUid(uid);
  const command = fields['command'];
  if (command !== 'start' && command !== 'resume') return null;
  const startedAtValue = fields['startedAt'];
  const startedAt = typeof startedAtValue === 'number' && Number.isSafeInteger(startedAtValue)
    ? startedAtValue
    : null;
  if (startedAt === null) return null;
  const sandbox = fields['sandbox'];
  if (sandbox !== undefined && sandbox !== 'landlock' && sandbox !== 'off') return null;
  const fence = fields['fence'];
  if (fence !== undefined && fence !== 'available' && fence !== 'unavailable') return null;
  const fenceReasonValue = fields['fenceReason'];
  if (fenceReasonValue !== undefined && typeof fenceReasonValue !== 'string') return null;
  return {
    v: 1, pid, startTime, token, uid, command, startedAt,
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(fence === undefined ? {} : { fence }),
    ...(fenceReasonValue === undefined
      ? {}
      : { fenceReason: boundedFenceReason(fenceReasonValue) }),
  };
}

/** The one bounded spelling of a fence reason: one line, no payload growth. */
function boundedFenceReason(reason: string): string {
  return singleLine(reason, MAX_FENCE_REASON);
}

/** `/proc/<pid>/stat`'s state character, or `null` when it cannot be read. */
async function procState(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state === '' ? null : state;
  } catch {
    return null;
  }
}

/**
 * The production liveness probe: `kill(pid, 0)` first, then the `/proc` state.
 *
 * `ESRCH` is dead and `EPERM` is alive (someone else owns the pid; `kill(0)`
 * still proves it exists). Any other `kill` failure is not evidence of life. A
 * zombie or a just-died-before-reaping host reads as dead here, so a killed but
 * unreaped host never looks running. An unreadable `/proc` is conservatively
 * alive: it cannot prove a *different* process holds the pid.
 */
async function defaultAlive(
  pid: number,
  readState: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM') return false;
  }
  const state = await readState(pid);
  return state !== 'Z' && state !== 'X';
}

async function isAlive(pid: number, deps: OwnerLivenessDeps): Promise<boolean> {
  if (deps.alive !== undefined) return await deps.alive(pid);
  return await defaultAlive(pid, deps.state ?? procState);
}

/**
 * The pinned classification order: a null record start time is `unverified`
 * before anything is signalled; a dead pid is `stale`; an unreadable current
 * start time is `unverified`; a different start time is `stale` (pid reuse).
 */
async function classify(
  record: HostOwnerRecord,
  deps: OwnerLivenessDeps,
): Promise<'live' | 'unverified' | 'stale'> {
  if (record.startTime === null) return 'unverified';
  if (!(await isAlive(record.pid, deps))) return 'stale';
  const current = await (deps.startTime ?? processStartTime)(record.pid);
  if (current === null) return 'unverified';
  return current === record.startTime ? 'live' : 'stale';
}

/**
 * Reads and classifies `<home>/host.json`. Total: every file, parse and field
 * failure yields `stale(record: null)`, so callers never need a read catch.
 */
export async function readOwner(home: string, deps: OwnerLivenessDeps = {}): Promise<OwnerState> {
  const claim = await readClaim(ownerPath(home));
  if (claim.kind === 'absent') return { kind: 'absent' };
  if (claim.kind !== 'record') return { kind: 'stale', record: null };
  const verdict = await classify(claim.record, deps);
  if (verdict === 'live') return { kind: 'live', record: claim.record };
  if (verdict === 'unverified') return { kind: 'unverified', record: claim.record };
  return { kind: 'stale', record: claim.record };
}

/**
 * Acquires this home's owner record for the running process.
 *
 * The record is proven before it is published — a process that cannot read its
 * own start time refuses with `HostConfigError` rather than writing a row no
 * later host could verify — and published through a private tmp that is hard
 * linked into place, so a reader never sees a partial record. A losing publish
 * (`EEXIST`) goes through the reclaim CAS; a lost race never deletes the
 * winner's record.
 *
 * @throws HostConfigError when the process identity cannot be proven, the home
 * cannot hold the tmp, or a moved `host.json` is not a regular file.
 * @throws HostAlreadyRunningError when a live or unverifiable owner holds the
 * home, or another record appears while reclaiming.
 */
export async function acquireOwner(
  home: string,
  input: {
    readonly uid: string; readonly command: HostCommand; readonly now?: () => number;
    readonly sandbox?: 'landlock' | 'off';
    readonly deps?: OwnerLivenessDeps;
  },
): Promise<OwnerHandle> {
  const uid = assertNodeUid(input.uid);
  const deps = input.deps ?? {};
  const startTime = await (deps.startTime ?? processStartTime)(process.pid);
  if (startTime === null) {
    throw new HostConfigError('cannot prove process identity: /proc unavailable');
  }
  const observed = await readOwner(home, deps);
  if (observed.kind === 'live') throw liveRefusal(home, observed.record);
  if (observed.kind === 'unverified') throw unverifiedRefusal(home, observed.record);
  const record: HostOwnerRecord = {
    v: 1,
    pid: process.pid,
    startTime,
    token: randomBytes(16).toString('hex'),
    uid,
    command: input.command,
    startedAt: (input.now ?? Date.now)(),
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
  };
  const target = ownerPath(home);
  const tmp = join(home, `.host.${record.pid}.${record.token}.tmp`);
  try {
    await writePrivate(tmp, record);
    if (!(await tryLink(tmp, target))) await reclaim(home, tmp, target, record, observed, deps);
    return new Claim(home, record, deps);
  } finally {
    // The tmp is unlinked on every exit — success, refusal or a moved claim —
    // so no `.host.*` temp outlives a decision.
    await unlinkQuietly(tmp);
  }
}

/** Writes the record to a fresh private file, fsynced before it is linked. */
async function writePrivate(path: string, record: HostOwnerRecord): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** `link`, with `EEXIST` as the false value a CAS interprets. */
async function tryLink(from: string, to: string): Promise<boolean> {
  try {
    await link(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * The reclaim CAS: move `host.json` aside, re-classify what actually moved, and
 * reclaim only a record that is still stale on re-read.
 *
 * The moved file — not the pre-read — is authoritative, because a peer may have
 * published between the failed link and the rename. A live or unverifiable
 * moved record is restored and the acquire refuses; a stale record is reclaimed
 * only when its token matches the stale record that was pre-read (or the
 * pre-read saw nothing usable); a non-regular moved claim is never parsed and
 * never unlinked.
 */
async function reclaim(
  home: string,
  tmp: string,
  target: string,
  record: HostOwnerRecord,
  observed: OwnerState,
  deps: OwnerLivenessDeps,
): Promise<void> {
  const claim = join(home, `.host.reclaim.${record.token}.tmp`);
  if (!(await moveOwnerTo(target, claim))) {
    // A peer removed host.json between our failed link and the rename; retry
    // the publish exactly once and let a second conflict be a lost race.
    if (await tryLink(tmp, target)) return;
    throw appearedRefusal(home);
  }
  const moved = await readClaim(claim);
  switch (moved.kind) {
    case 'record': {
      const verdict = await classify(moved.record, deps);
      if (verdict !== 'stale' || !matchesPreRead(observed, moved.record)) {
        // Never discard a record that is not the stale one this acquire
        // observed at the same path: restore it first, then refuse.
        if (!(await restoreClaim(claim, target))) {
          throw new HostAlreadyRunningError(
            `a host record appeared for ${home}; it could not be restored from ${claim}`,
          );
        }
        throw verdict === 'live'
          ? liveRefusal(home, moved.record)
          : verdict === 'unverified'
            ? unverifiedRefusal(home, moved.record)
            : appearedRefusal(home);
      }
      await discardClaim(claim);
      if (!(await tryLink(tmp, target))) throw appearedRefusal(home);
      return;
    }
    case 'invalid':
      // A regular file with no valid record: there is no token to match, and
      // no owner it could be protecting.
      await discardClaim(claim);
      if (!(await tryLink(tmp, target))) throw appearedRefusal(home);
      return;
    case 'non-regular':
      // A symlink, directory or unreadable claim is left exactly where the
      // rename put it: unlinking it could destroy something this protocol did
      // not create.
      throw new HostConfigError(
        `host.json is not a removable regular file; moved to ${claim}`,
      );
    case 'absent':
      if (await tryLink(tmp, target)) return;
      throw appearedRefusal(home);
  }
}

/** True when the moved stale record is the one the pre-read observed. */
function matchesPreRead(observed: OwnerState, moved: HostOwnerRecord): boolean {
  if (observed.kind === 'absent') return true;
  if (observed.kind !== 'stale') return false;
  if (observed.record === null) return true;
  return observed.record.token === moved.token;
}

/**
 * Restores a moved record to `host.json`, unlinking the claim on success.
 *
 * @returns `false` when every attempt still found a record at `host.json`.
 * @throws HostConfigError when the link fails for any reason other than a
 * conflict; the claim is left in place in both failure cases.
 */
async function restoreClaim(claim: string, target: string): Promise<boolean> {
  for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt += 1) {
    try {
      await link(claim, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new HostConfigError(`could not restore ${claim}`, { cause: err });
      }
      await sleep(RESTORE_DELAY_MS);
      continue;
    }
    try {
      await unlink(claim);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new HostConfigError(`could not restore ${claim}`, { cause: err });
      }
    }
    return true;
  }
  // The claim survives for the operator: a record is never discarded because a
  // transient winner held the path for 30 ms.
  return false;
}

/** `rename`, with ENOENT reported as "there was nothing to move". */
async function moveOwnerTo(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Unlinks a moved claim. ENOENT is success; `EISDIR` and `EPERM` are mapped to
 * `HostConfigError` because they mean the claim is not a removable regular
 * file. Any other failure propagates as observed rather than being re-labelled.
 */
async function discardClaim(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'EISDIR' || code === 'EPERM') {
      throw new HostConfigError(`host.json is not a removable regular file; moved to ${path}`);
    }
    throw err;
  }
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function liveRefusal(home: string, record: HostOwnerRecord): HostAlreadyRunningError {
  return new HostAlreadyRunningError(
    `a host is already running for ${home} (pid=${record.pid}, uid=${record.uid})`,
  );
}

function unverifiedRefusal(home: string, record: HostOwnerRecord): HostAlreadyRunningError {
  return new HostAlreadyRunningError(
    `a host record exists for ${home} (pid=${record.pid}); cannot verify it`,
  );
}

function appearedRefusal(home: string): HostAlreadyRunningError {
  return new HostAlreadyRunningError(`a host record appeared for ${home}`);
}

/**
 * The handle's release: the same CAS from the other side.
 *
 * `host.json` is moved aside and re-classified. Our token unlinks it; another
 * live or unverifiable record is restored (and the claim unlinked on success),
 * so a swapped-in record survives; a stale record or a malformed regular file is
 * unlinked; an absent path is already success. A non-regular moved record — a
 * link, a directory, or a path `lstat` cannot inspect — is refused with
 * `HostConfigError` and left at the claim path, exactly as the reclaim CAS
 * refuses it: this protocol unlinks only what it can prove is a removable
 * regular file. Idempotent, and a failed restore leaves the claim rather than
 * deleting a live owner's record.
 */
async function releaseRecord(
  home: string,
  record: HostOwnerRecord,
  deps: OwnerLivenessDeps,
): Promise<void> {
  const target = ownerPath(home);
  const claim = join(home, `.host.release.${record.token}.tmp`);
  if (!(await moveOwnerTo(target, claim))) return;
  const moved = await readClaim(claim);
  switch (moved.kind) {
    case 'absent':
      return;
    case 'non-regular':
      // The same rule as the reclaim CAS: a link or directory this protocol
      // did not create is moved but never unlinked. The refusal names the claim
      // and leaves it there for the operator.
      throw new HostConfigError(
        `host.json is not a removable regular file; moved to ${claim}`,
      );
    case 'invalid':
      await discardClaim(claim);
      return;
    case 'record': {
      if (moved.record.token === record.token) {
        await discardClaim(claim);
        return;
      }
      if ((await classify(moved.record, deps)) !== 'stale') {
        if (!(await restoreClaim(claim, target))) {
          throw new HostConfigError(`could not restore ${claim}`);
        }
        return;
      }
      await discardClaim(claim);
      return;
    }
  }
}

class Claim implements OwnerHandle {
  readonly record: HostOwnerRecord;
  private readonly home: string;
  private readonly deps: OwnerLivenessDeps;
  private released = false;

  constructor(home: string, record: HostOwnerRecord, deps: OwnerLivenessDeps) {
    this.home = home;
    this.record = record;
    this.deps = deps;
  }

  async release(): Promise<void> {
    if (this.released) return;
    await releaseRecord(this.home, this.record, this.deps);
    this.released = true;
  }

  /**
   * Annotates the published record with the fence fact. The current file is
   * re-read and must still carry this handle's `(pid, token)`; otherwise this
   * handle no longer owns the home and the write is skipped rather than
   * overwrite a record a reclaim swapped in. The replacement is atomic
   * (`atomicWriteFile`: 0600 tmp, fsync, rename) with the home entry synced
   * after, so `status` sees either the old record or the annotated one.
   */
  async annotate(input: {
    readonly fence: OwnerFence;
    readonly fenceReason?: string;
  }): Promise<void> {
    if (this.released) return;
    const target = ownerPath(this.home);
    const current = await readClaim(target);
    if (
      current.kind !== 'record'
      || current.record.pid !== this.record.pid
      || current.record.token !== this.record.token
    ) {
      return;
    }
    // Rebuilt explicitly, not spread: a second annotate must not carry a stale
    // `fenceReason` from the previous one when the new fact has none.
    const next: HostOwnerRecord = {
      v: current.record.v,
      pid: current.record.pid,
      startTime: current.record.startTime,
      token: current.record.token,
      uid: current.record.uid,
      command: current.record.command,
      startedAt: current.record.startedAt,
      ...(current.record.sandbox === undefined ? {} : { sandbox: current.record.sandbox }),
      fence: input.fence,
      ...(input.fenceReason === undefined
        ? {}
        : { fenceReason: boundedFenceReason(input.fenceReason) }),
    };
    await atomicWriteFile(target, JSON.stringify(next));
    await syncPath(this.home);
  }
}

/**
 * Asks the host recorded in `<home>/host.json` to stop: one SIGTERM, then a
 * fixed-interval poll of the same record until it releases the home.
 *
 * No host, a stale record, or an unverifiable one is refused without a signal.
 * The poll compares `(pid, startTime)`, not the pid alone, so a record that
 * reappears for a reused pid counts as the old host having released. There is
 * deliberately no read catch: `readOwner` is total. There is no SIGKILL, no
 * second signal and no escalation — `still-stopping` hands that decision back
 * to the operator.
 *
 * The wait is bounded by `timeoutMs` (10 s by default, no flag). Between the
 * `readOwner` above and the `kill` below there is an unavoidable PID-reuse
 * window: the OS could retire the recorded process and assign its pid to an
 * unrelated one. The recorded start time narrows that to a same-instant race;
 * it is not a guarantee, no second validation runs after the signal, and this
 * function does not claim absolute protection.
 */
export async function requestPause(
  home: string,
  opts: {
    readonly timeoutMs?: number; readonly intervalMs?: number;
    readonly deps?: OwnerLivenessDeps;
  } = {},
): Promise<PauseOutcome> {
  const deps = opts.deps ?? {};
  const state = await readOwner(home, deps);
  if (state.kind !== 'live') return { kind: 'no-host', state: state.kind };
  const target = state.record;
  const kill = deps.kill ?? process.kill;
  try {
    kill(target.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return { kind: 'exited' };
    throw new HostPauseError(
      `could not send SIGTERM to pid ${target.pid}: ${diagnostic(err)}`,
      { cause: err },
    );
  }
  const timeoutMs = opts.timeoutMs ?? PAUSE_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? PAUSE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
    const next = await readOwner(home, deps);
    if (next.kind === 'absent' || next.kind === 'stale') return { kind: 'exited' };
    if (
      next.kind === 'live'
      && (next.record.pid !== target.pid || next.record.startTime !== target.startTime)
    ) {
      return { kind: 'exited' };
    }
    // A mid-poll `unverified` keeps polling to the deadline: an unreadable
    // /proc is not evidence that the host released the cell.
    if (Date.now() >= deadline) return { kind: 'still-stopping', pid: target.pid };
  }
}

function diagnostic(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
