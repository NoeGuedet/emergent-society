import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import {
  dirname, isAbsolute, join, resolve, sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontierLayout, nodeDir, nodeLayout } from '../journal/index.js';
import { WorldNotARepoError } from '../node/errors.js';
import { WorldRepo } from '../node/world.js';
import { migrationNote } from '../node/world-trust.js';
import { HostConfigError } from './errors.js';

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
    providersFile: join(home, PROVIDERS_BASENAME),
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
 * Prepares the cell home and its world pair, idempotently.
 *
 * A missing home is created 0700 (the umask is overridden by the explicit
 * `chmod`); an existing one must already pass `assertHomePermissions`. Both
 * world paths present opens the repository (and lets its trust checks run);
 * neither initializes it; a legacy in-world `.git` is refused with the
 * migration recipe (exit 2, the world kept); any other partial layout is
 * refused. The credential file and the owner record are never created here.
 *
 * @returns `created: true` when the world pair was initialized by this call.
 */
export async function initHome(home: string): Promise<{ readonly created: boolean }> {
  await assertHomeOutsideCheckout(home);
  if ((await lstatOrNull(home)) === null) {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
  } else {
    await assertHomePermissions(home);
  }
  const { world, gitDir } = worldPaths(home);
  const [worldEntry, gitEntry] = await Promise.all([
    lstatOrNull(world), lstatOrNull(gitDir),
  ]);
  if (worldEntry !== null && gitEntry !== null) {
    await WorldRepo.open(world, { gitDir });
    return { created: false };
  }
  if (worldEntry === null && gitEntry === null) {
    await WorldRepo.init(world, { gitDir });
    return { created: true };
  }
  const legacy = await legacyWorldError(world, gitDir, gitEntry === null);
  if (legacy !== null) throw legacy;
  throw new HostConfigError(
    'partial cell layout: expected both <home>/world and <home>/world.git; '
    + 'remove the stray entry and run init again',
  );
}
