import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import {
  dirname, isAbsolute, join, resolve, sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontierLayout, nodeDir, nodeLayout } from '../journal/index.js';
import { holdExclusiveLock } from '../locked-append.js';
import { WorldNotARepoError } from '../node/errors.js';
import { WorldRepo } from '../node/world.js';
import { migrationNote } from '../node/world-trust.js';
import { HostConfigError } from './errors.js';
import {
  ExecutionRefusalError, type ExecutionMarker, type ImageInspector, type InitRequest,
  assertNoPostInitVolumeEntries, assertVmInitPrerequisites, assertVmVolumes,
  ensureExecutionDirectory, hasVmEvidence, pinExecutionImage, readExecutionMarker,
  readVmNetworkRecord, writeExecutionMarker,
} from './execution.js';

/**
 * The cell home: its layout in one place, and the checks the host runs before
 * it trusts one.
 *
 * The home is the cell's durability root and the only host-owned directory
 * (kernel.md §3, plan §3.1): `world/` and `world.git/` from the node's
 * repository, `frontier/` for the cell's global journal, `nodes/<uid>/` for the
 * node's local log, plus two files the host owns — `providers.json` (mode 0600,
 * see `credentials.ts`) and `host.json` (the owner record, present only while a
 * host runs). The journal literals are derived through the journal's own
 * constructors, never re-spelled here; this module owns only the names the
 * host itself introduces.
 *
 * Two properties are enforced rather than documented. A home must sit outside
 * the project checkout — the world is agent-writable, so a home inside it
 * would hand the shell the journals and the credential file — and an existing
 * home must be a same-uid directory with no group or other access. The
 * containment check resolves the deepest ancestor that exists with `realpath`,
 * so a symlinked or not-yet-created home cannot smuggle itself into the
 * checkout; the permission check `lstat`s, so a symlink is refused rather than
 * followed and a permissive home is refused rather than silently repaired.
 *
 * `init` creates a missing home 0700 and the world pair; it never creates
 * `providers.json` (the operator writes the key, so no secret is ever generated
 * onto argv or a terminal) and it never creates `host.json` (only a running
 * host does). A home with exactly one of `world/` and `world.git/` is a partial
 * layout and is refused instead of guessed at — except the documented legacy
 * shape (`world/.git` present, `world.git` absent), which is refused with the
 * sanitizing migration recipe so neither `start` nor `init` tells the operator
 * to remove the recorded world.
 */

/** The cell home's absolute paths, derived from the journal's own literals. */
export type CellPaths = {
  readonly home: string; readonly world: string; readonly gitDir: string;
  readonly frontierDir: string; readonly nodeDir: string; readonly nodeLogFile: string;
  readonly providersFile: string; readonly ownerFile: string;
};

const WORLD_DIR = 'world';
const WORLD_GIT_DIR = 'world.git';
const PROVIDERS_BASENAME = 'providers.json';
const OWNER_BASENAME = 'host.json';
/**
 * The init section's exclusive lock. It lives in the owner-only `.es` and is
 * the one stable metadata effect a no-op or refused re-init may leave behind;
 * it is never a marker, a layout or a world artifact.
 */
const INIT_LOCK_FILE = 'init.lock';

/**
 * The project checkout, resolved once: `src/host/` (or `dist/host/`) is two
 * levels below the repository root in both the source tree and the build.
 */
let packageRoot: string | null = null;

async function packageRootPath(): Promise<string> {
  packageRoot ??= await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  return packageRoot;
}

/** The world pair, the one place this module spells either name. */
function worldPaths(home: string): { readonly world: string; readonly gitDir: string } {
  return { world: join(home, WORLD_DIR), gitDir: join(home, WORLD_GIT_DIR) };
}

/** `lstat`, with "absent" as `null` instead of a throw. */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * `stat`, with "absent" as `null` instead of a throw. The world pair is checked
 * with this, not `lstat`: `WorldRepo.open` resolves both paths with `realpath`,
 * so a symlinked `world/` or `world.git/` is a pair it accepts, and the layout
 * check must not refuse what the repository open accepts.
 */
async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** The deepest ancestor of `path` that exists, canonicalized. */
async function deepestExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * The cell home's world pair — the layout's one spelling, shared by
 * `cellPaths`, `initHome` and the one-shot `direct` command (which opens the
 * world without composing a node).
 */
export function worldPairOf(home: string): { readonly world: string; readonly gitDir: string } {
  return worldPaths(home);
}

/**
 * The cell home's credential store path — the layout's one spelling, shared by
 * `cellPaths` and every read that must refuse the store (the charter file's
 * and `direct`'s `--file`).
 */
export function providersFileOf(home: string): string {
  return join(home, PROVIDERS_BASENAME);
}

/**
 * The cell home's paths. The node paths go through the journal's constructors,
 * so the uid is validated once, there, and `'nodes'`/`'frontier'` are never
 * spelled here.
 *
 * @throws InvalidNodeUidError when the uid is not a safe path segment.
 */
export function cellPaths(home: string, uid: string): CellPaths {
  const local = nodeLayout(home, uid);
  const { world, gitDir } = worldPaths(home);
  return {
    home,
    world,
    gitDir,
    frontierDir: frontierLayout(home).dir,
    nodeDir: nodeDir(home, uid),
    nodeLogFile: join(local.dir, local.logFile),
    providersFile: providersFileOf(home),
    ownerFile: join(home, OWNER_BASENAME),
  };
}

/**
 * Refuses a home that is not a same-uid directory with no group/other bits.
 * `lstat` is deliberate: a symlink is refused as observed rather than followed,
 * and an existing permissive home is never repaired here.
 */
export async function assertHomePermissions(home: string): Promise<void> {
  const entry = await lstatOrNull(home);
  if (entry === null) throw new HostConfigError('home does not exist; run init');
  if (!entry.isDirectory()) {
    throw new HostConfigError(`home must be a directory: ${home}`);
  }
  const uid = process.getuid?.();
  const foreignOwner = uid !== undefined && entry.uid !== uid;
  if (foreignOwner || (entry.mode & 0o077) !== 0) {
    throw new HostConfigError(
      `home must be owned by the host uid with mode 0700; chmod 700 ${home}`,
    );
  }
}

/**
 * Refuses a home inside the project checkout, whether or not it exists yet.
 *
 * The target is resolved through its deepest existing ancestor, so a symlinked
 * ancestor or a to-be-created path is compared canonically against the
 * checkout's own `realpath`: a link into the checkout is refused before
 * anything is written below it.
 *
 * @throws HostConfigError when the home is relative or resolves inside the
 * checkout.
 */
export async function assertHomeOutsideCheckout(home: string): Promise<void> {
  if (!isAbsolute(home)) {
    throw new HostConfigError(`home must be an absolute path: ${home}`);
  }
  const target = resolve(home);
  const root = await packageRootPath();
  const ancestor = await deepestExistingAncestor(target);
  if (ancestor === root || ancestor.startsWith(root + sep)) {
    throw new HostConfigError(`home must be outside the project checkout: ${target}`);
  }
}

/**
 * Refuses a home whose world pair is missing or not a pair of directories.
 *
 * The pair is probed with `stat`, so a symlinked `world/`/`world.git/` that
 * `WorldRepo.open` resolves is accepted here too; only a missing or
 * non-directory target is refused.
 */
export async function assertCellLayout(home: string): Promise<void> {
  const { world, gitDir } = worldPaths(home);
  const [worldEntry, gitEntry] = await Promise.all([
    statOrNull(world), statOrNull(gitDir),
  ]);
  if (worldEntry?.isDirectory() !== true || gitEntry?.isDirectory() !== true) {
    const legacy = await legacyWorldError(world, gitDir, gitEntry === null);
    if (legacy !== null) throw legacy;
    throw new HostConfigError('cell layout is not initialized; run init');
  }
}

/**
 * The documented legacy shape: the world directory exists with its git dir
 * inside it (`world/.git`) and the external `world.git` is absent. The layout
 * gate runs before `WorldRepo.open`, so it must recognize this shape itself
 * and surface the sanitizing recipe instead of sending the operator to `init`,
 * which would then advise removing the world (and its recorded history).
 * `WorldNotARepoError` is the same refusal class `open` uses, so start/resume
 * map it to exit 2 and `init` does too.
 */
async function legacyWorldError(
  world: string, gitDir: string, externalAbsent: boolean,
): Promise<WorldNotARepoError | null> {
  if (!externalAbsent) return null;
  if ((await lstatOrNull(join(world, '.git'))) === null) return null;
  return new WorldNotARepoError(world, migrationNote(world, gitDir));
}

/**
 * The default internal init request: a fresh home records the Landlock backend.
 * B8 is the only brick allowed to expose a backend flag on the CLI.
 */
const DEFAULT_INIT_REQUEST: InitRequest = { backend: 'landlock' };

/** The typed partial-layout refusal (exit 2, zero completion writes). */
function layoutDamaged(detail: string): never {
  throw new ExecutionRefusalError('execution/layout-damaged', detail);
}

/** A missing-marker home that already carries actual VM evidence. */
function absentVmEvidence(): never {
  throw new ExecutionRefusalError(
    'execution/marker-absent-vm-evidence',
    'actual VM evidence exists but the immutable execution marker is missing; '
    + 'the home is not initialized or run as host Landlock',
  );
}

/**
 * The read-only presence classification of the world pair. Presence is
 * `lstat`'s: a dangling `world`/`world.git` symlink is PRESENT (and is then
 * refused as a partial or an invalid pair), never mistaken for an absent side
 * that a fresh init might write into. A historical pair whose two names are
 * symlinks to directories is still both-present, and `WorldRepo.open` is what
 * decides whether it is valid. A final repository is never inferred from
 * presence alone.
 */
async function worldPairState(home: string): Promise<'both-present' | 'world-only' | 'git-only' | 'neither'> {
  const { world, gitDir } = worldPaths(home);
  const [worldEntry, gitEntry] = await Promise.all([
    lstatOrNull(world), lstatOrNull(gitDir),
  ]);
  if (worldEntry !== null && gitEntry !== null) return 'both-present';
  if (worldEntry !== null) return 'world-only';
  if (gitEntry !== null) return 'git-only';
  return 'neither';
}

/**
 * The read-only both-present classification: `WorldRepo.open` is the only
 * arbiter of a valid pair (the external non-bare gitdir, the absolute
 * `core.worktree`, the unborn-HEAD shape). A gitdir git rejects — raw empty,
 * non-repository, corrupt or partial — is the typed zero-write
 * `execution/layout-damaged`, never a raw `WorldNotARepoError` and never an
 * adoption. Its sanitizing migration recipe is preserved in the refusal
 * detail. `UnsafeWorldPathError` (a world resolving to `$HOME` or a broad root)
 * and any other environment failure keep their own bounded refusal.
 */
async function assertBothValid(home: string): Promise<void> {
  const { world, gitDir } = worldPaths(home);
  try {
    await WorldRepo.open(world, { gitDir });
  } catch (error) {
    if (error instanceof WorldNotARepoError) {
      layoutDamaged(
        'the world pair is not a valid repository; nothing is adopted or re-initialized: '
        + error.message,
      );
    }
    throw error;
  }
}

/**
 * A valid marker re-init. A matching backend is idempotent and never rewrites
 * the marker, but it is not an early return: the requested image identity, the
 * world pair and (for a VM marker) the volume roots and network record are
 * revalidated, and a mismatch is refused with zero completion writes. A valid
 * `vm-qemu` marker revalidates its two volume roots and its strict network
 * record before the world is opened; no VM execution is activated here.
 */
async function initMarkedHome(
  home: string, marker: ExecutionMarker, request: InitRequest, inspect?: ImageInspector,
): Promise<{ readonly created: boolean }> {
  if (marker.backend !== request.backend) {
    throw new ExecutionRefusalError(
      'execution/marker-conflict',
      `the home marker selects ${marker.backend}, not ${request.backend}`,
    );
  }
  if (marker.backend === 'vm-qemu' && request.backend === 'vm-qemu') {
    // The requested image is compared against the immutable pin BEFORE any
    // completion or filesystem check: a different base image is never an
    // idempotent retry, even when no inspector is supplied.
    if (resolve(request.imagePath) !== marker.image.path) {
      throw new ExecutionRefusalError(
        'execution/marker-conflict',
        `the home marker pins image ${marker.image.path}, not ${resolve(request.imagePath)}`,
      );
    }
    if (inspect !== undefined) {
      // Re-pin the immutable identity from the file itself: a tampered or
      // replaced image at the same path is refused, and the old pin is never
      // rewritten.
      const pinned = await pinExecutionImage(home, marker.image.path, inspect);
      if (pinned.path !== marker.image.path
        || pinned.sha256 !== marker.image.sha256
        || pinned.bytes !== marker.image.bytes) {
        throw new ExecutionRefusalError(
          'execution/marker-conflict',
          `the image at ${marker.image.path} no longer matches the immutable marker pin`,
        );
      }
    }
  }
  const { world, gitDir } = worldPaths(home);
  const state = await worldPairState(home);
  if (state !== 'both-present') {
    // The legacy in-world `.git` shape keeps its sanitizing migration recipe
    // (the world and its history are never advised away) for a Landlock marker.
    // Any other missing or one-sided pair is an uncertain partial: the
    // immutable marker cannot prove that no history existed, so no world is
    // completed or adopted.
    if (state === 'world-only' && marker.backend === 'landlock') {
      const legacy = await legacyWorldError(world, gitDir, true);
      if (legacy !== null) throw legacy;
    }
    return layoutDamaged(
      'the execution marker exists but the world pair is absent or partial; '
      + 'the marker cannot prove that no history existed, so nothing is adopted',
    );
  }
  if (marker.backend === 'vm-qemu') {
    await assertVmVolumes(home);
    await readVmNetworkRecord(home);
    // A lost+found at either mounted root after the marker exists is a
    // post-init reappearance: the fresh cleanup never re-runs, and the entry is
    // never removed or accepted as a retry.
    await assertNoPostInitVolumeEntries(home);
    await assertBothValid(home);
    return { created: false };
  }
  // A valid landlock marker opens only a pair the repository accepts as valid;
  // an invalid gitdir is the typed zero-write layout refusal, while the
  // unsafe-path refusal keeps its own bounded message.
  await assertBothValid(home);
  return { created: false };
}

/**
 * Prepares the cell home and its world pair, idempotently, and records the
 * immutable execution backend.
 *
 * A missing home is created 0700 (the umask is overridden by the explicit
 * `chmod`); an existing one must already pass `assertHomePermissions`. The
 * whole init then runs under the exclusive `<home>/.es/init.lock`: `.es` and
 * that stable lock file are the one metadata effect allowed before
 * classification, so two concurrent inits serialize — the first writes the
 * marker/world, the second acquires the lock afterwards, re-reads the marker
 * and is idempotent. The marker is read before any layout or world write. A
 * matching marker is never rewritten; a valid marker with a missing/partial
 * world pair is an uncertain partial (zero writes). Without a marker the
 * read-only world pair decides: both valid is the unchanged legacy Landlock
 * home (no marker is written, except that actual VM evidence refuses); a
 * both-present but invalid pair, either side alone, or a dangling link is a
 * partial layout; neither present is a fresh home. The default fresh home
 * writes the `landlock` marker atomically BEFORE the world pair, exactly as
 * today's `initHome` flow did otherwise. An explicit `vm-qemu` request
 * validates the mounted volumes, the strict network record, both pristine
 * roots and the image, then refuses because B1 does not activate the VM; it
 * never writes a marker or a world. The credential file and the owner record
 * are never created here.
 *
 * @returns `created: true` when the world pair was initialized by this call.
 */
export async function initHome(
  home: string, request: InitRequest = DEFAULT_INIT_REQUEST, inspect?: ImageInspector,
): Promise<{ readonly created: boolean }> {
  await assertHomeOutsideCheckout(home);
  if ((await lstatOrNull(home)) === null) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
  } else {
    await assertHomePermissions(home);
  }
  const esDir = await ensureExecutionDirectory(home);
  const lock = await holdExclusiveLock(join(esDir, INIT_LOCK_FILE))
    .catch(() => layoutDamaged(
      'the init lock could not be acquired; no marker, layout or world write was made',
    ));
  try {
    const marker = await readExecutionMarker(home);
    if (marker !== null) return await initMarkedHome(home, marker, request, inspect);
    const { world, gitDir } = worldPaths(home);
    const state = await worldPairState(home);
    if (state === 'both-present') {
      // Classify the pair before any VM or legacy decision: a both-present but
      // invalid pair (raw empty/non-repository/corrupt gitdir, a dangling link) is
      // the typed zero-write layout refusal, never "the home already has a valid
      // world". The repository open is read-only and runs before any write.
      await assertBothValid(home);
      if (await hasVmEvidence(home)) return absentVmEvidence();
      if (request.backend === 'vm-qemu') {
        throw new ExecutionRefusalError(
          'execution/marker-absent',
          'the home already has a valid world but no execution marker; a VM backend is never an upgrade',
        );
      }
      return { created: false };
    }
    if (state === 'world-only') {
      if (request.backend === 'vm-qemu') {
        return await assertVmInitPrerequisites(home, request.imagePath, inspect);
      }
      const legacy = await legacyWorldError(world, gitDir, true);
      if (legacy !== null) throw legacy;
      return layoutDamaged(
        'partial cell layout: expected both <home>/world and <home>/world.git; '
        + 'remove the stray entry and run init again',
      );
    }
    if (state === 'git-only') {
      return layoutDamaged(
        'partial cell layout: expected both <home>/world and <home>/world.git; '
        + 'remove the stray entry and run init again',
      );
    }
    if (request.backend === 'vm-qemu') {
      return await assertVmInitPrerequisites(home, request.imagePath, inspect);
    }
    if (await hasVmEvidence(home)) return absentVmEvidence();
    await writeExecutionMarker(home, {
      v: 1, backend: 'landlock', createdAt: Date.now(),
    });
    await WorldRepo.init(world, { gitDir });
    return { created: true };
  } finally {
    // The guard holds the descriptor; ending its stdin is the release. A
    // failure here must not mask the init outcome (a dead child already
    // released the lock).
    await lock.release().catch(() => {});
  }
}
