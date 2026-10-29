import {
  open,
  readdir,
  realpath,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  atomicWriteFile,
  canonicalizeJson,
  ensureDurableDirectory,
  isErrno,
  nodeDir,
  sha256HexOf,
  syncPath,
} from '../../journal/index.js';
import {
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_NAME_CHARS,
  MAX_PACKAGE_PURPOSE_CHARS,
  MAX_PACKAGE_SOURCE_BYTES,
  MAX_PACKAGE_SOURCE_BYTES_PER_NODE,
} from './constants.js';
import { PackageError } from './errors.js';

/**
 * The Package definition store (kernel.md, the local-log and sandbox
 * sections): the kernel-mediated, shell-invisible home of every definition a
 * node owns, under `nodes/<uid>/packages/<sha256>/`.
 *
 * Invariants this module owns:
 * - **fd-first define** — the source path is opened before anything is known
 *   about it, containment is proven on the pinned fd (`/proc/self/fd/N` is
 *   dentry truth, immune to a symlink-swap race), and the bytes are read from
 *   that fd only. Every out-of-containment outcome returns one fixed
 *   refusal message: no errno, no existence oracle over host paths.
 * - **Parse-only precheck** — the agent's source is parsed, never executed;
 *   any parse-time throw is `invalid-source` with a teaching hint.
 * - **Content addressing** — `id = sha256(canonicalJson(manifest) ‖ source)`;
 *   the identity is re-derived from the stored bytes at every scan, and a
 *   mismatch deletes the definition (corrupt bytes are worthless —
 *   re-defining the same source restores the exact identity).
 * - **Write-once persistence** — an existing id is a no-op returning the same
 *   id; owner-only modes throughout (0700 directories, 0600 files); every
 *   mutation fsyncs the directory entry.
 *
 * What this module never does: append events (the L4 handler is the append
 * home), own liveness (the registry's concern), grant or resolve anything
 * under the operator's real home, or journal a single source byte.
 */

/** A stored definition as the boot scan re-mounts it. */
export type PackageDefinition = {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly sourceBytes: number;
};

/** A definition the scan deleted: identified, with a bounded reason. */
export type CorruptDefinition = { readonly id: string; readonly reason: string };

/** The store's public surface; paths are injected by the caller (L4 wiring). */
export type PackageStore = {
  definePackage(input: {
    readonly name: string;
    readonly purpose: string;
    readonly path: string;
  }): Promise<{ readonly id: string; readonly sourceBytes: number }>;
  readMountedPackages(): Promise<{
    readonly mounted: readonly PackageDefinition[];
    readonly corrupt: readonly CorruptDefinition[];
  }>;
  /**
   * The stored source bytes of one definition, or null when the id is
   * unknown. The bytes are re-verified by the Run's verify-then-use at
   * spawn — this read is the delivery, not the proof.
   */
  readPackageSource(id: string): Promise<Buffer | null>;
  /**
   * The read-only listing: every definition is verified in place, NOTHING
   * is deleted — the read-only catalogue's own path. The deleting scan is
   * `readMountedPackages` (the boot re-mount's, whose corrupt deletions the
   * L5 caller reports through the gate).
   */
  listPackages(): Promise<{
    readonly definitions: readonly PackageDefinition[];
    readonly corrupt: readonly CorruptDefinition[];
  }>;
  undefinePackage(id: string): Promise<void>;
};

const ID_RE = /^[0-9a-f]{64}$/;
const SOURCE_FILE = 'package.js';
const MANIFEST_FILE = 'manifest.json';

/**
 * The one fixed out-of-containment refusal: an unopenable path, an
 * unresolvable fd and a resolved-outside path are indistinguishable by design
 * — the message never carries an errno or an existence fact about the host.
 */
const PATH_REFUSED_MESSAGE =
  'the source must resolve inside the world worktree or the node scratch';

/** The store's input roots; kernel-supplied, never agent-authored. */
export type PackageStoreDeps = {
  readonly home: string;
  readonly uid: string;
  /** The world worktree root — relative define paths resolve against it. */
  readonly worldDir: string;
  /** The node's scratch leaf (`<home>/tmp/<uid>/`) — the other containment root. */
  readonly scratchDir: string;
};

/**
 * Builds a store over the injected roots: the cell `home` and node `uid` place
 * the definitions under `nodes/<uid>/packages/`; `worldDir` (the world
 * worktree root, also the relative-path base) and `scratchDir` (the node's
 * `<home>/tmp/<uid>/` leaf) are the two fd-first containment roots. The
 * caller owns these paths — kernel-supplied, never agent-authored — so the
 * store itself resolves nothing it was not handed.
 */
export async function createPackageStore(deps: PackageStoreDeps): Promise<PackageStore> {
  const packagesDir = join(nodeDir(deps.home, deps.uid), 'packages');
  // Realpath the injected roots when they exist: containment compares the
  // pinned fd's own realpath, so a symlinked world root must resolve before
  // comparing. The scratch leaf may not exist yet (it is created lazily) —
  // an absent root falls back to the lexical resolution, and define from it
  // simply fails containment until it does.
  const resolveRoot = async (path: string): Promise<string> => {
    const lexical = resolve(path);
    try {
      return await realpath(lexical);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT'
        || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return lexical;
      }
      throw err;
    }
  };
  const worldRoot = await resolveRoot(deps.worldDir);
  const scratchRoot = await resolveRoot(deps.scratchDir);

  function insideContainment(resolved: string): boolean {
    for (const root of [worldRoot, scratchRoot]) {
      if (resolved === root || resolved.startsWith(root + sep)) return true;
    }
    return false;
  }

  function validateInput(name: string, purpose: string, path: string): void {
    if (typeof name !== 'string' || name.length < 1
      || name.length > MAX_PACKAGE_NAME_CHARS
      || name.includes('/') || name.includes('\\') || name.includes('\0')
      || name === '.' || name === '..' || name.startsWith('.')
      || !name.isWellFormed()) {
      throw new PackageError(
        'invalid-argument',
        `a package name is 1-${MAX_PACKAGE_NAME_CHARS} well-formed characters`
        + ' without separators, NUL, a leading dot, or "."/".."',
      );
    }
    if (typeof purpose !== 'string' || purpose.length < 1
      || purpose.length > MAX_PACKAGE_PURPOSE_CHARS
      || !purpose.isWellFormed()) {
      throw new PackageError(
        'invalid-argument',
        `a package purpose is 1-${MAX_PACKAGE_PURPOSE_CHARS} well-formed characters`,
      );
    }
    if (typeof path !== 'string' || path.length === 0) {
      throw new PackageError('invalid-argument', 'the source path must be a nonempty string');
    }
  }

  /**
   * The fd-first read: open (non-blocking, so a FIFO cannot hang the kernel),
   * prove containment on the pinned fd, refuse non-regular files and
   * hardlinks, then read the bytes from the fd only — bounded by the
   * per-source cap.
   */
  async function readContainedSource(path: string): Promise<Buffer> {
    const candidate = isAbsolute(path) ? path : join(worldRoot, path);
    let handle: FileHandle;
    try {
      handle = await open(
        candidate, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
      );
    } catch {
      throw new PackageError('path-refused', PATH_REFUSED_MESSAGE);
    }
    try {
      let resolved: string;
      try {
        resolved = await realpath(`/proc/self/fd/${handle.fd}`);
      } catch {
        throw new PackageError('path-refused', PATH_REFUSED_MESSAGE);
      }
      if (!insideContainment(resolved)) {
        throw new PackageError('path-refused', PATH_REFUSED_MESSAGE);
      }
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new PackageError(
          'path-refused', 'the source must be a regular file, not a directory, FIFO or device',
        );
      }
      if (info.nlink > 1) {
        throw new PackageError(
          'path-refused', 'the source is hardlinked outside the grants',
        );
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > MAX_PACKAGE_SOURCE_BYTES) {
          throw new PackageError(
            'cap-exceeded',
            `the source exceeds the ${MAX_PACKAGE_SOURCE_BYTES}-byte per-definition cap`,
          );
        }
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      return Buffer.concat(chunks);
    } finally {
      await handle.close();
    }
  }

  /** Parse-only, never executed: any parse-time throw is a teaching refusal. */
  function parsePrecheck(source: string): void {
    try {
      // The agent's code is wrapped as one async function body; this compiles
      // it and discards the result — no byte is ever executed here.
      void new Function(`(async () => {\n${source}\n})()`);
    } catch (err) {
      const detail = err instanceof SyntaxError
        ? err.message
        : 'the parse ran out of stack (pathological nesting)';
      throw new PackageError(
        'invalid-source',
        `the source does not parse: ${detail} — plain JavaScript only: remove TypeScript annotations and balance brackets`,
      );
    }
  }

  /** The one identity: sha256(canonicalJson(manifest) ‖ utf8(source)). */
  function identity(manifest: { name: string; purpose: string }, source: Buffer): string {
    const manifestBytes = Buffer.from(canonicalizeJson(manifest), 'utf8');
    return sha256HexOf(Buffer.concat([manifestBytes, source]));
  }

  /** The sum of stored source bytes (stat sizes; the define-time cap input). */
  /** Reads the packages dir, mapping only absence to emptiness (never EACCES/EIO). */
  async function readPackagesDir(): Promise<Dirent[]> {
    try {
      return await readdir(packagesDir, { withFileTypes: true });
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return [];
      throw err;
    }
  }

  /** Stats one path, mapping only absence to null (never EACCES/EIO). */
  async function statOrNull(path: string): Promise<Stats | null> {
    try {
      return await stat(path);
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null;
      throw err;
    }
  }

  async function storedSourceBytes(): Promise<number> {
    let total = 0;
    for (const entry of await readPackagesDir()) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const info = await statOrNull(join(packagesDir, entry.name, SOURCE_FILE));
      if (info !== null) total += info.size;
    }
    return total;
  }

  async function definePackage(input: {
    readonly name: string;
    readonly purpose: string;
    readonly path: string;
  }): Promise<{ readonly id: string; readonly sourceBytes: number }> {
    validateInput(input.name, input.purpose, input.path);
    const source = await readContainedSource(input.path);
    parsePrecheck(source.toString('utf8'));
    const manifest = { name: input.name, purpose: input.purpose };
    const id = identity(manifest, source);

    const idDir = join(packagesDir, id);
    const existing = await statOrNull(idDir);
    if (existing !== null) {
      // Write-once: identical content is idempotent, the same id, a no-op.
      return { id, sourceBytes: source.length };
    }
    const stored = await storedSourceBytes();
    if (stored + source.length > MAX_PACKAGE_SOURCE_BYTES_PER_NODE) {
      throw new PackageError(
        'cap-exceeded',
        `the node's stored sources (${stored} bytes) plus this definition exceed the ${MAX_PACKAGE_SOURCE_BYTES_PER_NODE}-byte cap`,
      );
    }
    await ensureDurableDirectory(idDir, deps.home);
    await atomicWriteFile(join(idDir, SOURCE_FILE), source);
    await atomicWriteFile(join(idDir, MANIFEST_FILE), canonicalizeJson(manifest));
    await syncPath(idDir);
    return { id, sourceBytes: source.length };
  }

  async function readMountedPackages(): Promise<{
    readonly mounted: readonly PackageDefinition[];
    readonly corrupt: readonly CorruptDefinition[];
  }> {
    const mounted: PackageDefinition[] = [];
    const corrupt: CorruptDefinition[] = [];
    for (const entry of await readPackagesDir()) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const id = entry.name;
      const idDir = join(packagesDir, id);
      const verdict = await verifyStored(id, idDir);
      if (verdict.ok) {
        mounted.push(verdict.definition);
      } else {
        corrupt.push({ id, reason: verdict.reason });
        await rm(idDir, { recursive: true, force: true });
        await syncPath(packagesDir);
      }
    }
    return { mounted, corrupt };
  }

  /**
   * The scan's bounded read of one stored file: fd-first (O_NONBLOCK, so a
   * FIFO cannot hang the boot scan), regular files only, capped at
   * `maxBytes`. Any refusal is the scan's corrupt verdict — `null` — never a
   * thrown error: a corrupt or out-of-band entry is deleted, not fatal.
   */
  async function readStoredFile(path: string, maxBytes: number): Promise<Buffer | null> {
    let handle: FileHandle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    } catch {
      return null;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) return null;
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      return Buffer.concat(chunks);
    } catch {
      return null;
    } finally {
      await handle.close();
    }
  }

  /** Re-derives the identity from the stored bytes; the dir must hold exactly the two files. */
  async function verifyStored(
    id: string,
    idDir: string,
  ): Promise<
    | { readonly ok: true; readonly definition: PackageDefinition }
    | { readonly ok: false; readonly reason: string }
  > {
    const names = (await readdir(idDir)).sort();
    if (names.length !== 2 || names[0] !== MANIFEST_FILE || names[1] !== SOURCE_FILE) {
      return { ok: false, reason: 'unexpected directory contents' };
    }
    const source = await readStoredFile(join(idDir, SOURCE_FILE), MAX_PACKAGE_SOURCE_BYTES);
    const manifestRaw = await readStoredFile(join(idDir, MANIFEST_FILE), MAX_MANIFEST_BYTES);
    if (source === null || manifestRaw === null) {
      return {
        ok: false,
        reason: 'a storage file is missing, unreadable, non-regular or oversized',
      };
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestRaw.toString('utf8'));
    } catch {
      return { ok: false, reason: 'the manifest is not JSON' };
    }
    if (typeof manifest !== 'object' || manifest === null
      || !('name' in manifest) || !('purpose' in manifest)
      || typeof (manifest as { name: unknown }).name !== 'string'
      || typeof (manifest as { purpose: unknown }).purpose !== 'string') {
      return { ok: false, reason: 'the manifest shape is invalid' };
    }
    const typed = manifest as { name: string; purpose: string };
    try {
      validateInput(typed.name, typed.purpose, 'x');
    } catch {
      return { ok: false, reason: 'the manifest bounds are violated' };
    }
    if (identity(typed, source) !== id) {
      return { ok: false, reason: 'hash mismatch' };
    }
    return {
      ok: true,
      definition: { id, name: typed.name, purpose: typed.purpose, sourceBytes: source.length },
    };
  }

  async function undefinePackage(id: string): Promise<void> {
    // A malformed id is indistinguishable from an unknown one: fail-closed,
    // and the filesystem is never touched for garbage.
    const idDir = ID_RE.test(id) ? join(packagesDir, id) : null;
    if (idDir === null || await statOrNull(idDir) === null) {
      throw new PackageError('not-found', `no stored package ${id}`);
    }
    await rm(idDir, { recursive: true, force: true });
    await syncPath(packagesDir);
  }

  async function readPackageSource(id: string): Promise<Buffer | null> {
    // A malformed id is indistinguishable from an unknown one: no fs touch.
    if (!ID_RE.test(id)) return null;
    return readStoredFile(join(packagesDir, id, SOURCE_FILE), MAX_PACKAGE_SOURCE_BYTES);
  }

  async function listPackages(): Promise<{
    readonly definitions: readonly PackageDefinition[];
    readonly corrupt: readonly CorruptDefinition[];
  }> {
    const definitions: PackageDefinition[] = [];
    const corrupt: CorruptDefinition[] = [];
    for (const entry of await readPackagesDir()) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const verdict = await verifyStored(entry.name, join(packagesDir, entry.name));
      if (verdict.ok) definitions.push(verdict.definition);
      else corrupt.push({ id: entry.name, reason: verdict.reason });
    }
    return { definitions, corrupt };
  }

  return {
    definePackage, readMountedPackages, readPackageSource, listPackages, undefinePackage,
  };
}
