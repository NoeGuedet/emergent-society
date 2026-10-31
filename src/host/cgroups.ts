import { createHash } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import {
  lstat, mkdir, readdir, readFile, rmdir, writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * The per-cell cgroup tree, created by the kernel at boot and attached to the
 * confined children by the vendored launcher.
 *
 * Layout (one shape for every launch mode, so the delegated service launch
 * changes an anchor, never the tree):
 *
 *   <anchor>/es-<sha256(home)[:12]>        the cell root
 *     svc/                                 the kernel moves itself here at boot
 *     node-<uid>/                          one leaf per node session
 *     run-<runId>/                         one leaf per package Run
 *
 * The kernel moves itself into `svc/` FIRST: a cgroup that still holds a
 * process cannot enable controllers on its `cgroup.subtree_control` ("no
 * internal processes"), so the limit-carrying leaves must be siblings of
 * `svc/`, not its children. `freeze` and `kill` work on any user-owned child
 * even without controllers; `memory.max`/`pids.max` only appear once the
 * anchor's parent enabled `+memory +pids` (the delegated launch, W0-a2).
 *
 * The attach is OPTIONAL AND DEGRADING: a host without cgroup v2 (or without
 * write access to its own cgroup) runs Landlock-only with a typed reason,
 * never failing the shell closed. Fail-closed stays Landlock's contract.
 */

/** The cgroup2 filesystem magic (`statfs().type`), used to verify the mount. */
const CGROUP2_SUPER_MAGIC = 0x63677270;

/**
 * The W0 limits module: every bound in one place. `ES_*` overrides exist for
 * the smokes (a smaller cap is cheaper to hit); they are NOT AgentConfig
 * fields — journaled configs never reach existing cells, so a config key would
 * silently exercise the defaults forever.
 */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  // An empty or NaN override must never become a zero cap (a pids.max=0 leaf
  // cannot spawn) or silently drop the cap: fall back to the default.
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const LIMITS = {
  /** A node session's cgroup caps (the shell's own leaf; Runs have their own). */
  nodeMemoryMaxBytes: positiveInt('ES_NODE_MEMORY_MAX_BYTES', 4 * 1024 ** 3),
  nodePidsMax: positiveInt('ES_NODE_PIDS_MAX', 1024),
  /** The kernel's own `svc/` caps (kernel + its git + any off-cell tree). */
  svcMemoryMaxBytes: positiveInt('ES_SVC_MEMORY_MAX_BYTES', 4 * 1024 ** 3),
  svcPidsMax: positiveInt('ES_SVC_PIDS_MAX', 1024),
  freezeDeadlineMs: 2000,
  freezePollMs: 20,
} as const;

/** The two independent capability classes — never one "cgroup unavailable" flag. */
export type CgroupCapabilities = {
  /** `cgroup.freeze`/`cgroup.kill` on a user-owned child leaf (works unprivileged). */
  readonly freezeKill: boolean;
  /** `memory.max`/`pids.max` present in a leaf (requires a delegated parent). */
  readonly limits: boolean;
};

export type CellCgroup =
  | { readonly ok: true; readonly root: string; readonly limits: boolean }
  | { readonly ok: false; readonly reason: string };

/** `<home>`'s stable cgroup name; the hash keeps the unit/dir name valid and unique.
 * The path is normalized first (trailing separators, `.`, `..` — `resolve` does not
 * consult the filesystem, so a symlinked spelling hashes differently); a2's
 * unit-name stability depends on the same spelling being used at both call sites. */
export function cellHash(home: string): string {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
}

/** The cell root directory name (`es-<hash>`); also the systemd unit/slice stem. */
export function cellUnitName(home: string): string {
  return `es-${cellHash(home)}`;
}

/** The cell root under an anchor cgroup (`<anchor>/es-<hash>`). */
export function cellRootUnder(anchor: string, home: string): string {
  return join(anchor, cellUnitName(home));
}

/** The kernel's own cgroup inside the cell tree. */
export function svcDir(root: string): string {
  return join(root, 'svc');
}

/** A node session's leaf. */
export function nodeLeaf(root: string, uid: string): string {
  return join(root, `node-${uid}`);
}

/** A package Run's leaf. */
export function runLeaf(root: string, runId: string): string {
  return join(root, `run-${runId}`);
}

/**
 * The runtime anchor: the kernel's own cgroup, resolved from `/proc/self/cgroup`
 * (the `0::` line) and the cgroup2 mount discovered in `/proc/self/mounts`,
 * verified by the statfs magic. Never a hardcoded unit/slice path — a
 * `--slice=` launch creates nested slices whose names only the runtime knows.
 * Returns `null` when there is no cgroup2 hierarchy at all.
 */
export function resolveAnchor(): string | null {
  const mount = findCgroup2Mount();
  if (mount === null) return null;
  let raw: string;
  try {
    raw = readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return null;
  }
  const line = raw.split('\n').find((entry) => entry.startsWith('0::'));
  if (line === undefined) return null;
  const rel = line.slice(3).trim();
  if (rel === '' || rel === '/') return mount;
  return join(mount, rel);
}

function findCgroup2Mount(): string | null {
  let raw: string;
  try {
    raw = readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const fields = line.split(' ');
    const path = fields[1];
    if (fields.length < 3 || fields[2] !== 'cgroup2' || path === undefined) continue;
    try {
      if (statfsSyncType(path) === CGROUP2_SUPER_MAGIC) return path;
    } catch {
      // An unreadable mount entry is not evidence of a usable hierarchy.
    }
  }
  return null;
}

function statfsSyncType(path: string): number {
  return statfsSync(path).type;
}

/** The verified capability classes for this host (probe leaves, cleaned up). */
export async function cgroupCapabilities(anchor: string | null): Promise<CgroupCapabilities> {
  if (anchor === null) return { freezeKill: false, limits: false };
  const probe = join(anchor, `.probe-${process.pid}-${Date.now().toString(36)}`);
  let freezeKill = false;
  let limits = false;
  try {
    await mkdir(probe);
    try {
      await writeFile(join(probe, 'cgroup.freeze'), '1');
      await writeFile(join(probe, 'cgroup.freeze'), '0');
      freezeKill = true;
    } catch {
      freezeKill = false;
    }
    // `memory.max` exists in the leaf only when the anchor's parent enabled
    // the controller — the non-mutating limit probe (never writes subtree
    // control on the anchor: under `npm test` that anchor is the worker).
    try {
      await readFile(join(probe, 'memory.max'), 'utf8');
      await readFile(join(probe, 'pids.max'), 'utf8');
      limits = true;
    } catch {
      limits = false;
    }
  } catch {
    // mkdir failed: no writable child cgroup on this host.
  } finally {
    await rmdir(probe).catch(() => {});
  }
  return { freezeKill, limits };
}

/**
 * Builds the cell tree and moves the kernel into `svc/`, once per host boot.
 *
 * Degrading by design: every failure returns `{ok:false, reason}` and leaves
 * no partial tree behind. The caller proceeds Landlock-only and records the
 * reason; it never refuses to boot.
 */
export async function attachCell(home: string, anchor?: string): Promise<CellCgroup> {
  const resolved = anchor !== undefined ? anchor : resolveAnchor();
  if (resolved === null) {
    return { ok: false, reason: 'cgroup2-unavailable' };
  }
  const root = cellRootUnder(resolved, home);
  const svc = svcDir(root);
  try {
    // Recursive: a crash may leave the root behind with stale leaves; the
    // caller's boot hygiene reaps them.
    await mkdir(root, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `cell-root: ${describeFsError(err)}` };
  }
  try {
    await mkdir(svc, { recursive: true });
    // The self-move is the load-bearing step: it frees the cell root for the
    // controller enable and makes the leaves limit-capable in a2.
    await writeFile(join(svc, 'cgroup.procs'), String(process.pid));
    const own = await readFile('/proc/self/cgroup', 'utf8');
    const line = own.split('\n').find((entry) => entry.startsWith('0::'));
    // The /proc path is relative to the cgroup mount root; compare the tail.
    const tail = `/${cellUnitName(home)}/svc`;
    if (line === undefined || !line.endsWith(tail)) {
      await rmdir(svc).catch(() => {});
      await rmdir(root).catch(() => {});
      return { ok: false, reason: 'self-move-unverified' };
    }
  } catch (err) {
    await rmdir(svc).catch(() => {});
    await rmdir(root).catch(() => {});
    return { ok: false, reason: `attach: ${describeFsError(err)}` };
  }
  // Delegated only: enable the controllers on the (now process-free) anchor and
  // the cell root, then bound the kernel's own leaf. A non-delegated host fails
  // these writes by design; the cell then runs Landlock-only for limits.
  const limits = await enableControllers(resolved, root)
    && await limitLeaf(svc, { memoryMaxBytes: LIMITS.svcMemoryMaxBytes, pidsMax: LIMITS.svcPidsMax });
  return { ok: true, root, limits };
}

/**
 * Enables `+memory +pids` on the anchor and the cell root. Both must be
 * process-free (the kernel lives in `svc/`): the "no internal processes" rule
 * is a property of the cgroup whose own subtree_control is written. Returns
 * whether BOTH writes stuck; a host without delegation refuses (EACCES/EBUSY)
 * and the answer is `false` — never an error.
 */
export async function enableControllers(anchor: string, cellRoot: string): Promise<boolean> {
  for (const dir of [anchor, cellRoot]) {
    try {
      await writeFile(join(dir, 'cgroup.subtree_control'), '+memory +pids');
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Writes a leaf's memory/pids caps. Best-effort: a leaf whose parent never
 * enabled the controllers has no `memory.max` file, and the answer is `false`.
 */
export async function limitLeaf(
  leaf: string,
  caps: { readonly memoryMaxBytes: number; readonly pidsMax: number },
): Promise<boolean> {
  try {
    await writeFile(join(leaf, 'memory.max'), String(caps.memoryMaxBytes));
    await writeFile(join(leaf, 'pids.max'), String(caps.pidsMax));
    return true;
  } catch {
    return false;
  }
}

/**
 * The launch mode, read from the runtime: a transient systemd service makes
 * the kernel the unit's MainPID, so its cgroup basename ends in `.service`;
 * a direct `npm start` runs in whatever scope the shell inherited. Used for
 * the honest `host/boot` line.
 */
export function detectLaunchMode(): 'service' | 'direct' {
  const anchor = resolveAnchor();
  return anchor === null ? 'direct' : launchModeFromCgroup(anchor);
}

/** The pure predicate behind `detectLaunchMode`: any path segment ending in
 * `.service` is a transient systemd service (its MainPID is the kernel); a
 * scope or anything else is a direct launch. Segment-based so the post-move
 * path (`<unit>.service/es-<hash>/svc`) still classifies as service. Split out
 * so tests can cover the shapes without moving the worker. */
export function launchModeFromCgroup(cgroupPath: string): 'service' | 'direct' {
  return cgroupPath.split('/').some((segment) => segment.endsWith('.service')
    // Every user process lives under `user@<uid>.service`; the user manager is
    // not the launch unit.
    && !/^user@\d+\.service$/u.test(segment))
    ? 'service' : 'direct';
}

/** Creates (or reuses) a leaf under the cell root. */
export async function ensureLeaf(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * The cell's Run leaves under `root`, sorted, as absolute paths. Strictly
 * non-destructive: one `readdir`, never a thaw, kill or removal, so the commit
 * fence can enumerate what to freeze without racing the boot hygiene or the
 * reaper. Only directories are leaves (cgroupfs exposes its control files at
 * every level); a missing root lists as empty, and a Run leaf created after the
 * list is simply not fenced by this attempt — it was not inside the critical
 * section's snapshot. The node's own leaf is named explicitly by the caller
 * (it may not exist yet and is created by the fence).
 *
 * Only ENOENT/ENOTDIR means "gone": the root or a listed leaf that provably
 * vanished is not a failure. Any other readdir/lstat errno (EACCES, EIO,
 * ELOOP) propagates, because silently returning the survivors would let the
 * fence report `fenced: true` with an unstattable Run leaf outside the frozen
 * set.
 */
export async function listLeaves(root: string): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const names: string[] = [];
  for (const name of entries) {
    if (!name.startsWith('run-')) continue;
    try {
      const entry = await lstat(join(root, name));
      if (entry.isDirectory()) names.push(name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A leaf removed between readdir and lstat is gone, not a failure; any
      // other errno is not evidence the leaf vanished.
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw err;
    }
  }
  return names.sort().map((name) => join(root, name));
}

export type FreezeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Freezes the given leaves and waits for `cgroup.events` to report `frozen 1`
 * on each, bounded by the deadline. On any failure it thaws everything and
 * returns a typed refusal — a caller must never be left frozen.
 *
 * A leaf that vanishes between the freeze write and a poll is GONE, not
 * pending: a removed cgroup has no process left to freeze, so its `ENOENT`
 * removes it from the wait instead of holding every other leaf (or a commit)
 * to the full deadline. An unreadable events file that is not ENOENT is still
 * not proof of a freeze and keeps waiting; only the deadline ends that wait.
 */
export async function freezeSet(
  leaves: readonly string[],
  opts: { readonly deadlineMs: number; readonly pollMs: number },
): Promise<FreezeVerdict> {
  if (leaves.some(isSvcLeaf)) {
    // Freezing the kernel's own leaf is never a fence; a caller bug must not
    // try (the write would succeed and freeze the kernel itself).
    return { ok: false, reason: 'svc-leaf-refused' };
  }
  for (const leaf of leaves) {
    try {
      await writeFile(join(leaf, 'cgroup.freeze'), '1');
    } catch (err) {
      await thawSet(leaves);
      return { ok: false, reason: `freeze-write: ${describeFsError(err)}` };
    }
  }
  const deadline = Date.now() + opts.deadlineMs;
  let waiting = [...leaves];
  for (;;) {
    let pending = 0;
    const gone: string[] = [];
    for (const leaf of waiting) {
      let frozen = false;
      try {
        const events = await readFile(join(leaf, 'cgroup.events'), 'utf8');
        frozen = /^\s*frozen\s+1\s*$/mu.test(events);
      } catch (err) {
        // ENOENT is "the leaf no longer exists": nothing in it can move, and
        // waiting for its events could only end at the deadline.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          gone.push(leaf);
          continue;
        }
        // Any other unreadable events file is not proof of a freeze; keep
        // waiting rather than report a freeze we cannot see.
      }
      if (!frozen) pending += 1;
    }
    if (gone.length > 0) {
      waiting = waiting.filter((leaf) => !gone.includes(leaf));
    }
    if (pending === 0) return { ok: true };
    if (Date.now() >= deadline) {
      await thawSet(leaves);
      return { ok: false, reason: 'freeze-timeout' };
    }
    await sleep(opts.pollMs);
  }
}

/** Thaws the given leaves; writes are best-effort (a removed leaf is already safe). */
export async function thawSet(leaves: readonly string[]): Promise<void> {
  for (const leaf of leaves) {
    if (isSvcLeaf(leaf)) continue;
    await writeFile(join(leaf, 'cgroup.freeze'), '0').catch(() => {});
  }
}

/**
 * Kills every task in the given leaves via `cgroup.kill`, then clears the
 * freeze bit (a kill leaves `frozen 1` behind — measured). Missing leaves are
 * already safe.
 */
export async function killLeaves(leaves: readonly string[]): Promise<void> {
  for (const leaf of leaves) {
    if (isSvcLeaf(leaf)) continue;
    await writeFile(join(leaf, 'cgroup.kill'), '1').catch(() => {});
    await writeFile(join(leaf, 'cgroup.freeze'), '0').catch(() => {});
  }
}

/**
 * Reaps one Run's leaf at teardown: `cgroup.kill` kills every task in the leaf
 * (the Run's descendants included — a guest can fork children that outlive the
 * main pid), then the empty leaf is removed so per-Run leaves do not accumulate
 * for the host's lifetime. A leaf that does not disappear within the freeze
 * deadline (a survivor, or an unremovable cgroupfs entry) is left in place and
 * `false` is returned; boot hygiene is the backstop. Missing leaves are already
 * safe.
 */
export async function reapRunLeaf(leaf: string): Promise<boolean> {
  if (isSvcLeaf(leaf)) return false;
  await killLeaves([leaf]);
  const deadline = Date.now() + LIMITS.freezeDeadlineMs;
  for (;;) {
    try {
      await rmdir(leaf);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(LIMITS.freezePollMs);
  }
}

/** The kernel's own leaf is never a fence/reap target. */
function isSvcLeaf(leaf: string): boolean {
  return leaf === 'svc' || leaf.endsWith('/svc');
}

/**
 * What boot hygiene proved: the leaves it visited, the ones it could not
 * remove, and — when the cell root itself could not be listed — the bounded
 * errno of that failure. A leaf that survives `rmdir` (a process outlived the
 * kill, or the thaw write failed) is named here; the host reports it on
 * `host/degraded` instead of booting silently over a possibly frozen leaf. The
 * same rule covers an unreadable listing: a non-ENOENT/ENOTDIR readdir or leaf
 * lstat is a bounded diagnostic (`listError`), never a silent "nothing to do".
 */
export type BootHygiene = {
  readonly reaped: number;
  readonly failed: readonly string[];
  /** The cell root's listing errno when it could not be read; never a path. */
  readonly listError?: string;
};

/**
 * Boot hygiene: every leaf of this home's cell root is thawed and killed at
 * composition — a `cgroup.freeze` bit persists across a crash, so a leaf left
 * frozen by a dead kernel would freeze the next node on entry. `svc/` is
 * skipped: it holds the kernel itself. A leaf that cannot be removed after the
 * thaw/kill is not swallowed: it is returned in `failed` so the host can emit a
 * bounded diagnostic (the frozen or busy leaf stays on disk). Only
 * ENOENT/ENOTDIR means the root is gone; any other readdir/lstat failure is
 * reported through `listError`/`failed` instead of being read as absence.
 */
export async function bootHygiene(root: string): Promise<BootHygiene> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { reaped: 0, failed: [] };
    return { reaped: 0, failed: [], listError: describeFsError(err) };
  }
  let reaped = 0;
  const failed: string[] = [];
  for (const name of entries) {
    // readdir on a cgroup also lists its control files (cgroup.controllers,
    // …); only the leaf directories are children of the cell.
    if (!(name.startsWith('node-') || name.startsWith('run-'))) continue;
    const leaf = join(root, name);
    await thawSet([leaf]);
    await killLeaves([leaf]);
    try {
      await rmdir(leaf);
    } catch {
      // Still present after thaw+kill: a surviving process or a failed thaw.
      // The name (a leaf basename, never a path) is the bounded diagnostic; an
      // lstat we cannot trust (EACCES/EIO) is also not proof the leaf is gone.
      try {
        await lstat(leaf);
        failed.push(name);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') failed.push(name);
      }
    }
    reaped += 1;
  }
  return { reaped, failed };
}

/** Best-effort removal of the cell tree (the self-move leaf first, then the root). */
export async function detachCell(root: string): Promise<void> {
  await rmdir(svcDir(root)).catch(() => {});
  await rmdir(root).catch(() => {});
}

function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
