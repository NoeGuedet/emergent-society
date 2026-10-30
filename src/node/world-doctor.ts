import { lstat, mkdir, rename, statfs } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { singleLine } from '../text.js';
import {
  INDEX_STALE_MS,
  MAX_DOCTOR_PATH_CHARS,
  MAX_DOCTOR_SCAN_ENTRIES,
  MAX_TRACKED_UNREADABLE_PATHS,
  MIN_FREE_BYTES,
  QUARANTINE_MAX_BYTES,
  QUARANTINE_MAX_FILES,
} from './limits.js';
import { GitCommandError } from './errors.js';
import {
  maybeRemoveIndexLock,
  probeWorldLock,
  runGit,
  runGitWithStdin,
  type IndexLockCleanup,
  type WorldLockState,
} from './world-git.js';
import type { WorldRepo } from './world.js';

/**
 * The world doctor: the one boot-time inspection of the repository the kernel
 * is about to commit to. It is diagnostic by contract — it never refuses a
 * boot, never repairs history, and never edits the index — and it acts only
 * where it can prove the action safe:
 *
 * - a proven-stale `index.lock` is removed under the world flock (the same
 *   `flock -n <world.lock>` every mutating git child takes) and only when its
 *   mtime is older than `INDEX_STALE_MS`. A held lock is live: it is reported
 *   and never touched. Human git does not take this flock: the declared
 *   residual is covered by the age rule, never by a promise;
 * - the index is validated STRUCTURALLY only — readable, no unmerged stages,
 *   every named blob object exists. It is never compared to HEAD and never
 *   repaired; a dirty tree is reported through the ordinary diff/index
 *   listings (a count, never a payload) and left for the commit path;
 * - tracked unreadable paths are REPORTED (there is no per-path skip in
 *   `add --all`: the commit itself either succeeds or refuses typed);
 * - untracked, unstageable paths are QUARANTINED by move into
 *   `<home>/.es/quarantine/`, bounded by count/bytes and gated on free space.
 *   The named-turn recovery commit is untouched; a moved file is simply no
 *   longer an untracked world entry.
 *
 * The return value is a serializable report: counts, bounded relative names,
 * and enums only. `NodeDriver.open` writes it as the ignorable local event
 * `world/doctor`; the doctor itself never opens a writer.
 */

/** One structural index record: `git ls-files --stage -z` parsed. */
type IndexRecord = {
  readonly mode: string;
  readonly object: string;
  readonly stage: string;
  readonly path: string;
};

/** The index's structural state: readable, unmerged stages, missing named blobs. */
export type DoctorIndex = {
  readonly readable: boolean;
  readonly unmerged: number;
  readonly missingBlobs: number;
  /** Whether the blob check ran (false when it could not). */
  readonly blobsChecked: boolean;
};

/** The dirty-tree count: tracked and untracked entries, bounded by the scan cap. */
export type DoctorDirty = {
  readonly tracked: number;
  readonly untracked: number;
  /** Whether a listing was cut at the scan bound (the counts are then lower bounds). */
  readonly truncated: boolean;
  /** False when a listing command failed: the counts are unknown, not zero. */
  readonly known: boolean;
};

/** What quarantine moved: bounded counts and the bounded relative names. */
export type DoctorQuarantine = {
  readonly files: number;
  readonly bytes: number;
  readonly paths: string[];
  /** Whether the bound stopped the scan before every candidate was moved. */
  readonly truncated: boolean;
};

/** The free-space reading the quarantine gate used. */
export type DoctorFreeSpace = {
  readonly state: 'ok' | 'low' | 'unverifiable';
  readonly bytes: number | null;
};

/** The serializable doctor report; no absolute path and no unbounded payload. */
export type DoctorReport = {
  readonly lock: WorldLockState;
  readonly indexLock: IndexLockCleanup;
  readonly index: DoctorIndex;
  readonly dirty: DoctorDirty;
  readonly trackedUnreadable: string[];
  readonly quarantine: DoctorQuarantine;
  readonly freeSpace: DoctorFreeSpace;
};

/** The free-space probe: production reads `statfs(home)`. */
export type FreeSpaceProbe = () => Promise<{ readonly bytes: number; readonly inodes: number } | null>;

/** The doctor's declared bounds and seams; production passes only `home`. */
export type DoctorOptions = {
  readonly home: string;
  readonly now?: () => number;
  /** The test seam for an absent flock (production resolves the prerequisite from PATH). */
  readonly flock?: string;
  /** The test seam for the free-space gate (production reads `statfs`). */
  readonly freeSpace?: FreeSpaceProbe;
  readonly quarantineMaxFiles?: number;
  readonly quarantineMaxBytes?: number;
  readonly indexStaleMs?: number;
  readonly maxTrackedUnreadable?: number;
  readonly timeoutMs?: number;
};

/** The default git deadline for one doctor listing (the plumbing bound). */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

/** The quarantine destination, next to the world lock the doctor and git share. */
export function quarantineDir(home: string): string {
  return join(home, '.es', 'quarantine');
}

/** One bounded, single-line relative path: never a payload, never an absolute path. */
function reportPath(rel: string): string {
  return singleLine(rel, MAX_DOCTOR_PATH_CHARS);
}

/** A git path is safe to address under the world root when it has no traversal. */
function safeRelative(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.includes('\0')) return false;
  return rel.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** The staged index records; a malformed record is skipped, never guessed at. */
function parseIndexRecords(out: string): IndexRecord[] {
  const records: IndexRecord[] = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const firstSpace = record.indexOf(' ');
    if (tab === -1 || firstSpace === -1) continue;
    // `<mode> <object> <stage>\t<path>`: the stage field is before the tab, so
    // splitting the metadata on spaces never swallows the path.
    const metadata = record.slice(0, tab).split(' ');
    if (metadata.length !== 3) continue;
    records.push({
      mode: metadata[0]!,
      object: metadata[1]!,
      stage: metadata[2]!,
      path: record.slice(tab + 1),
    });
  }
  return records;
}

/** One `-z` listing, bounded by the scan cap; `truncated` is a lower-bound count. */
type Listing = { readonly names: readonly string[]; readonly truncated: boolean };

function boundListing(names: string[], max: number): Listing {
  return names.length > max
    ? { names: names.slice(0, max), truncated: true }
    : { names, truncated: false };
}

/** A plain `-z` listing through the bounded git process layer. */
async function listZ(
  world: WorldRepo, args: readonly string[], timeoutMs: number, max: number,
): Promise<Listing> {
  const out = await runGit(world.path, [...world.gitBaseArgs(), ...args], undefined, timeoutMs);
  const names = out.split('\0').filter((name) => name !== '');
  return boundListing(names, max);
}

/** The doctor's bounded git call: diagnostics never throw past this module. */
function doctorGit(
  world: WorldRepo, args: readonly string[], timeoutMs: number,
): Promise<string> {
  return runGit(world.path, [...world.gitBaseArgs(), ...args], undefined, timeoutMs);
}

/** Whether one untracked path is unstageable for this process (readability/owner/special). */
function unstageable(entry: Stats, uid: number | undefined): boolean {
  if (uid !== undefined && entry.uid !== uid) return true;
  if (entry.isSymbolicLink()) return false;
  if (entry.isFile()) return (entry.mode & 0o400) === 0;
  if (entry.isDirectory()) return (entry.mode & 0o500) !== 0o500;
  // A FIFO/socket/device is not stageable content: git's reader would block on
  // it (a FIFO) or record something that is not a file. It is moved aside.
  return true;
}

/** Reads free bytes/inodes for the quarantine gate; null is unverifiable. */
async function defaultFreeSpace(home: string): Promise<{ bytes: number; inodes: number } | null> {
  try {
    const fs = await statfs(home);
    return { bytes: fs.bavail * fs.bsize, inodes: fs.ffree };
  } catch {
    return null;
  }
}

/** A destination that does not overwrite a previous boot's quarantine entry. */
async function uniqueQuarantinePath(dest: string): Promise<string | null> {
  for (let n = 0; n < 100; n += 1) {
    const candidate = n === 0 ? dest : `${dest}.${n}`;
    try {
      await lstat(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return candidate;
      return null;
    }
  }
  return null;
}

/**
 * Runs the world doctor against an opened repository. Never throws for a world
 * fact: every section is bounded and catches its own failure into the report.
 * The one thing it may throw is a programming error in the report itself.
 */
export async function runWorldDoctor(
  world: WorldRepo, opts: DoctorOptions,
): Promise<DoctorReport> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const baseArgs = world.gitBaseArgs();
  const home = opts.home;
  const maxTracked = opts.maxTrackedUnreadable ?? MAX_TRACKED_UNREADABLE_PATHS;
  const staleMs = opts.indexStaleMs ?? INDEX_STALE_MS;
  const maxQuarantineFiles = opts.quarantineMaxFiles ?? QUARANTINE_MAX_FILES;
  const maxQuarantineBytes = opts.quarantineMaxBytes ?? QUARANTINE_MAX_BYTES;
  const flock = opts.flock;

  // --- the world lock and a proven-stale index.lock -------------------------
  const lock = await probeWorldLock(baseArgs, flock === undefined ? {} : { flock });
  let indexLock: IndexLockCleanup;
  if (lock === 'held') indexLock = 'kept';
  else if (lock === 'unverifiable') indexLock = 'unverifiable';
  else {
    indexLock = await maybeRemoveIndexLock(
      baseArgs, now() - staleMs, flock === undefined ? {} : { flock },
    );
  }

  // --- the index, structurally only ----------------------------------------
  let records: IndexRecord[] = [];
  let readable = true;
  try {
    records = parseIndexRecords(
      await doctorGit(world, ['ls-files', '--stage', '-z'], timeoutMs),
    );
  } catch {
    readable = false;
  }
  const unmerged = records.filter((record) => record.stage !== '0').length;
  let missingBlobs = 0;
  let blobsChecked = readable;
  if (readable) {
    const objects = [...new Set(records
      .filter((record) => record.stage === '0' && record.mode !== '160000')
      .map((record) => record.object))];
    if (objects.length > 0) {
      try {
        const out = await runGitWithStdin(
          world.path,
          [...baseArgs, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
          Buffer.from(`${objects.join('\n')}\n`, 'utf8'),
          timeoutMs,
        );
        blobsChecked = true;
        for (const line of out.split('\n')) {
          if (line.endsWith(' missing')) missingBlobs += 1;
        }
      } catch {
        blobsChecked = false;
      }
    }
  }

  // --- the dirty tree and the tracked unreadable paths ---------------------
  let dirty: DoctorDirty = {
    tracked: 0, untracked: 0, truncated: false, known: true,
  };
  let trackedUnreadable: string[] = [];
  let untracked: readonly string[] = [];
  const trackedPaths = new Set(records.map((record) => record.path));
  try {
    let head: string | null;
    try {
      const out = (await doctorGit(world, ['rev-parse', '--verify', '--quiet', 'HEAD'], timeoutMs))
        .trim();
      head = out === '' ? null : out;
    } catch (err) {
      // Exit 1 is the unborn branch (the one git fact here); anything else is
      // an unreadable world, reported as an unknown dirty count.
      if (err instanceof GitCommandError && err.exitCode === 1) head = null;
      else throw err;
    }
    const worktree = await listZ(
      world, ['diff-files', '--name-only', '-z'], timeoutMs, MAX_DOCTOR_SCAN_ENTRIES,
    );
    const staged: Listing = head === null
      ? boundListing([...trackedPaths], MAX_DOCTOR_SCAN_ENTRIES)
      : await listZ(
        world, ['diff-index', '--cached', '--name-only', '-z', 'HEAD'],
        timeoutMs, MAX_DOCTOR_SCAN_ENTRIES,
      );
    const changed = new Set([...worktree.names, ...staged.names]);
    const others = await listZ(
      world, ['ls-files', '--others', '--exclude-standard', '-z'],
      timeoutMs, MAX_DOCTOR_SCAN_ENTRIES,
    );
    untracked = others.names;
    dirty = {
      tracked: Math.min(changed.size, MAX_DOCTOR_SCAN_ENTRIES),
      untracked: untracked.length,
      truncated: worktree.truncated || staged.truncated || others.truncated,
      known: true,
    };
  } catch {
    dirty = { ...dirty, known: false };
  }

  // Tracked unreadable paths: the pre-add check. The commit has no per-path
  // skip, so this is a REPORT — the commit itself succeeds or refuses typed.
  // The lstat sweep is bounded by the doctor scan cap (a 300k-entry world must
  // not turn one boot into 300k syscalls); when the cap is hit the report says
  // `dirty.truncated`, never a silent partial list.
  const uid = process.getuid?.();
  const unreadable: string[] = [];
  let scanned = 0;
  let scanTruncated = false;
  for (const rel of trackedPaths) {
    if (unreadable.length >= maxTracked) break;
    if (scanned >= MAX_DOCTOR_SCAN_ENTRIES) {
      scanTruncated = true;
      break;
    }
    scanned += 1;
    if (!safeRelative(rel)) continue;
    try {
      const entry = await lstat(join(world.path, rel));
      if (!entry.isFile() && !entry.isDirectory()) continue;
      if (unstageable(entry, uid)) unreadable.push(reportPath(rel));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A deleted tracked path is not unreadable; any other errno is.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadable.push(reportPath(rel));
    }
  }
  if (scanTruncated) dirty = { ...dirty, truncated: true };
  trackedUnreadable = unreadable;

  // --- free space and the untracked quarantine -----------------------------
  const probe = opts.freeSpace ?? (() => defaultFreeSpace(home));
  const free = await probe();
  const freeSpace: DoctorFreeSpace = free === null
    ? { state: 'unverifiable', bytes: null }
    : { state: free.bytes >= MIN_FREE_BYTES ? 'ok' : 'low', bytes: free.bytes };
  let quarantine: DoctorQuarantine = {
    files: 0, bytes: 0, paths: [], truncated: false,
  };
  // Quarantine is a move, so it only runs when the world lock probe is free and
  // the disk has room for the bounded move: a held lock is a live writer's
  // index, and an unverifiable probe or less room than the move could ever need
  // is not a place to perform the boot's one mutation. The probe is a CHECK,
  // not a held lock: a peer that acquires the flock after it can interleave a
  // commit with the move (declared residual; the files it targets are the
  // unstageable ones git cannot add). The 20 GiB storage floor is reported
  // separately as `freeSpace.state` (a low disk is a fact, not a refusal to
  // rename a file within the same filesystem).
  const roomForMove = free !== null
    && free.bytes >= Math.min(QUARANTINE_MAX_BYTES, maxQuarantineBytes)
    && free.inodes >= Math.min(QUARANTINE_MAX_FILES, maxQuarantineFiles);
  if (lock === 'free' && roomForMove) {
    const moved: string[] = [];
    let bytes = 0;
    let truncated = false;
    for (const rel of untracked) {
      if (moved.length >= maxQuarantineFiles || bytes >= maxQuarantineBytes) {
        truncated = true;
        break;
      }
      if (!safeRelative(rel)) continue;
      const abs = join(world.path, rel);
      let entry;
      try {
        entry = await lstat(abs);
      } catch {
        // Gone between the listing and the stat, or opaque: nothing to move.
        continue;
      }
      if (!unstageable(entry, uid)) continue;
      const size = Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : 0;
      if (moved.length + 1 > maxQuarantineFiles || bytes + size > maxQuarantineBytes) {
        truncated = true;
        continue;
      }
      const dir = quarantineDir(home);
      const dest = await uniqueQuarantinePath(join(dir, rel));
      if (dest === null) {
        truncated = true;
        continue;
      }
      try {
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await rename(abs, dest);
      } catch {
        // A move we cannot prove (a read-only home, a cross-filesystem home)
        // leaves the entry where it is; the commit will refuse typed.
        continue;
      }
      moved.push(reportPath(rel));
      bytes += size;
    }
    quarantine = { files: moved.length, bytes, paths: moved, truncated };
  } else if (untracked.length > 0) {
    // No free-space proof: moving files aside is refused, never guessed at.
    quarantine = { files: 0, bytes: 0, paths: [], truncated: true };
  }

  return {
    lock,
    indexLock,
    index: { readable, unmerged, missingBlobs, blobsChecked },
    dirty,
    trackedUnreadable,
    quarantine,
    freeSpace,
  };
}

// --- the report's replay validator ------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function int(value: unknown, min = 0): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
    ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T : null;
}

function boundedPath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (value.length > MAX_DOCTOR_PATH_CHARS) return null;
  if (singleLine(value, MAX_DOCTOR_PATH_CHARS) !== value) return null;
  // The writer emits world-relative names; the validator enforces the same
  // shape so a forged event cannot smuggle an absolute or traversing path into
  // the replay report.
  if (value.startsWith('/') || value.split('/').some((part) => part === '..')) return null;
  return value;
}

function boundedPaths(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const entry of value) {
    const path = boundedPath(entry);
    if (path === null) return null;
    out.push(path);
  }
  return out;
}

/**
 * Total validation of one `world/doctor` payload. The writer is the kernel,
 * but replay must not trust a journal from a different build: every key is
 * known, every count is a bounded nonnegative integer, every enum is from the
 * one vocabulary, every path is a bounded single line, and the list lengths
 * stay within the same bounds the doctor writes. `null` means "not a report".
 */
export function parseDoctorReport(value: unknown): DoctorReport | null {
  if (!isRecord(value)
    || !onlyKeys(value, [
      'lock', 'indexLock', 'index', 'dirty', 'trackedUnreadable', 'quarantine', 'freeSpace',
    ])) return null;
  const lock = enumOf(value['lock'], ['free', 'held', 'unverifiable'] as const);
  const indexLock = enumOf(
    value['indexLock'], ['absent', 'removed', 'kept', 'unverifiable'] as const);
  if (lock === null || indexLock === null) return null;

  const indexValue = value['index'];
  if (!isRecord(indexValue) || !onlyKeys(
    indexValue, ['readable', 'unmerged', 'missingBlobs', 'blobsChecked'],
  )) return null;
  const readable = bool(indexValue['readable']);
  const unmerged = int(indexValue['unmerged']);
  const missingBlobs = int(indexValue['missingBlobs']);
  const blobsChecked = bool(indexValue['blobsChecked']);
  if (readable === null || unmerged === null || missingBlobs === null
    || blobsChecked === null) return null;

  const dirtyValue = value['dirty'];
  if (!isRecord(dirtyValue) || !onlyKeys(
    dirtyValue, ['tracked', 'untracked', 'truncated', 'known'],
  )) return null;
  const tracked = int(dirtyValue['tracked']);
  const untracked = int(dirtyValue['untracked']);
  const dirtyTruncated = bool(dirtyValue['truncated']);
  const dirtyKnown = bool(dirtyValue['known']);
  if (tracked === null || untracked === null || dirtyTruncated === null
    || dirtyKnown === null) return null;

  const trackedUnreadable = boundedPaths(
    value['trackedUnreadable'], MAX_TRACKED_UNREADABLE_PATHS);
  if (trackedUnreadable === null) return null;

  const quarantineValue = value['quarantine'];
  if (!isRecord(quarantineValue) || !onlyKeys(
    quarantineValue, ['files', 'bytes', 'paths', 'truncated'],
  )) return null;
  const files = int(quarantineValue['files']);
  const bytes = int(quarantineValue['bytes']);
  const quarantineTruncated = bool(quarantineValue['truncated']);
  const quarantinePaths = boundedPaths(quarantineValue['paths'], QUARANTINE_MAX_FILES);
  if (files === null || bytes === null || quarantineTruncated === null
    || quarantinePaths === null || files !== quarantinePaths.length) return null;

  const freeValue = value['freeSpace'];
  if (!isRecord(freeValue) || !onlyKeys(freeValue, ['state', 'bytes'])) return null;
  const state = enumOf(freeValue['state'], ['ok', 'low', 'unverifiable'] as const);
  const freeBytes = freeValue['bytes'] === null ? null : int(freeValue['bytes']);
  if (state === null || (freeValue['bytes'] !== null && freeBytes === null)) return null;
  if ((state === 'unverifiable') !== (freeBytes === null)) return null;

  return {
    lock,
    indexLock,
    index: { readable, unmerged, missingBlobs, blobsChecked },
    dirty: {
      tracked, untracked, truncated: dirtyTruncated, known: dirtyKnown,
    },
    trackedUnreadable,
    quarantine: {
      files, bytes, paths: quarantinePaths, truncated: quarantineTruncated,
    },
    freeSpace: { state, bytes: freeBytes },
  };
}
