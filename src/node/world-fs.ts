import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import {
  lstat, mkdir, open, realpath, rename, unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/**
 * The host's one fd-anchored filesystem helper: every world or home path the
 * B2a chain resolves is walked and addressed through `/proc/self/fd`, never by
 * a path after the pin.
 *
 * The world is agent-writable, so a parent directory an operator path names can
 * be replaced between the kernel's check and its use. A path-based `lstat`,
 * `open`, `mkdir`, `chmod` or `rename` after the decision therefore addresses
 * whatever the attacker put there. This module removes that TOCTOU: the root
 * is resolved ONCE (the historical legacy world-root symlink is the trusted
 * API), every component below it is `lstatAt`'d and opened
 * `O_DIRECTORY|O_NOFOLLOW` relative to the pinned parent fd, and the final
 * entry is `lstatAt`/opened/renamed relative to that fd. A symlink or
 * non-directory component (or an `ELOOP`/`ENOTDIR` open race after a successful
 * lstat) is the typed unsafe-parent failure, distinct from the typed missing
 * (`ENOENT`) failure: only a genuinely missing entry is a deletion, never a
 * follow.
 *
 * The base probe: before the first per-entry lookup the helper proves
 * `<procRoot>/self/fd` is usable. A missing/unavailable base is the typed
 * proc-unavailable failure, never an ENOENT deletion — the doctor skips with
 * `truncated`, the operator source read refuses before any effect, and a
 * post-CAS materialization failure is a named warning.
 *
 * `mkdirAt`/`openPinnedDirAt` take a creation-only mode (the doctor passes
 * 0700; the default is 0o777 & umask), treat `EEXIST` as success and reopen
 * once, so a concurrent node `add --all` creating the same parent is not a
 * post-CAS failure. `procRoot` defaults to `/proc` and is a test-only seam,
 * never a CLI flag or environment variable.
 *
 * Every handle opened here is closed in a `finally` by its caller; this module
 * never closes a caller-owned root.
 */

/** The default proc filesystem root (the only production value). */
const DEFAULT_PROC_ROOT = '/proc';

/** The typed failure class: a bounded reason, never an unbounded message. */
export type WorldFsReason =
  | 'invalid-path'
  | 'missing'
  | 'unsafe-parent'
  | 'proc-unavailable'
  | 'io';

/** The base failure: every helper failure is one bounded, typed refusal. */
export class WorldFsError extends Error {
  readonly reason: WorldFsReason;
  /** The underlying errno label when there was one (never a path). */
  readonly errno: string | undefined;

  constructor(reason: WorldFsReason, message: string, errno?: string) {
    super(message);
    this.name = 'WorldFsError';
    this.reason = reason;
    this.errno = errno;
  }
}

/** The looked-up entry (or a parent component) does not exist. */
export class WorldFsMissingError extends WorldFsError {
  constructor(message: string, errno?: string) {
    super('missing', message, errno);
    this.name = 'WorldFsMissingError';
  }
}

/** A symlink/non-directory component, or an ELOOP/ENOTDIR open race. */
export class WorldFsUnsafeParentError extends WorldFsError {
  constructor(message: string, errno?: string) {
    super('unsafe-parent', message, errno);
    this.name = 'WorldFsUnsafeParentError';
  }
}

/** The `/proc` base (or `procRoot`) is missing or not usable. */
export class WorldFsProcUnavailableError extends WorldFsError {
  constructor(message: string, errno?: string) {
    super('proc-unavailable', message, errno);
    this.name = 'WorldFsProcUnavailableError';
  }
}

/** A path/name the helper refuses before touching the filesystem. */
export class WorldFsInvalidPathError extends WorldFsError {
  constructor(message: string) {
    super('invalid-path', message);
    this.name = 'WorldFsInvalidPathError';
  }
}

/** Any other bounded I/O failure (a permission, a device error, EXDEV). */
export class WorldFsIoError extends WorldFsError {
  constructor(message: string, errno?: string) {
    super('io', message, errno);
    this.name = 'WorldFsIoError';
  }
}

/** `openPinnedRoot`'s options; `resolved` skips the one realpath for a canonical path. */
export type OpenPinnedRootOptions = {
  readonly procRoot?: string;
  /** The caller already resolved the path (the operator read's ONE realpath). */
  readonly resolved?: boolean;
};

/** The per-call test seam for the proc root. */
export type PinnedOptions = {
  readonly procRoot?: string;
};

/** Directory creation: creation-only mode (a pre-existing directory is never re-moded). */
export type PinnedDirOptions = PinnedOptions & {
  readonly create?: boolean;
  readonly mode?: number;
};

/** `mkdirAt`'s creation mode only. */
export type MkNodOptions = PinnedOptions & {
  readonly mode?: number;
};

function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

function procRootOf(options: PinnedOptions): string {
  return options.procRoot ?? DEFAULT_PROC_ROOT;
}

/** One directory entry's path through the pinned parent fd. */
function procEntry(procRoot: string, fd: number, name: string): string {
  return join(procRoot, 'self', 'fd', String(fd), name);
}

/** The base the helper must prove before its first per-entry lookup. */
async function probeProc(procRoot: string): Promise<void> {
  const base = join(procRoot, 'self', 'fd');
  let entry: Stats;
  try {
    entry = await lstat(base);
  } catch (err) {
    throw new WorldFsProcUnavailableError(
      'the pinned read is unavailable: /proc/self/fd cannot be read', errnoOf(err));
  }
  if (!entry.isDirectory()) {
    throw new WorldFsProcUnavailableError(
      'the pinned read is unavailable: /proc/self/fd is not a directory');
  }
}

/** A single path name the helper addresses below a pinned fd. */
function assertName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/')
    || name.includes('\0')) {
    throw new WorldFsInvalidPathError(
      'a pinned path component must be a single non-empty name');
  }
}

/** Maps a lookup/open failure onto the typed missing/unsafe/io families. */
function mapEntryError(err: unknown, what: string): never {
  const code = errnoOf(err);
  if (code === 'ENOENT') {
    throw new WorldFsMissingError(`${what} is missing`, code);
  }
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR') {
    throw new WorldFsUnsafeParentError(
      `${what} is a symlink or a non-directory; refusing to follow it`, code);
  }
  throw new WorldFsIoError(`${what} could not be read (${code ?? 'unknown failure'})`, code);
}

/** Maps an open failure: a symlink leaf/parent is unsafe, never missing. */
function mapOpenError(err: unknown, what: string): never {
  const code = errnoOf(err);
  if (code === 'ENOENT') throw new WorldFsMissingError(`${what} is missing`, code);
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    throw new WorldFsUnsafeParentError(
      `${what} is a symlink or a non-directory; refusing to follow it`, code);
  }
  throw new WorldFsIoError(`${what} could not be opened (${code ?? 'unknown failure'})`, code);
}

/**
 * Resolves `path` ONCE and opens it as a pinned directory
 * (`O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK`).
 *
 * A caller that already resolved the path (the operator read's single
 * `realpath(worldRoot)`) passes `resolved: true`, so the canonical world root is
 * never resolved a second time. The returned handle is the caller's to close.
 */
export async function openPinnedRoot(
  path: string, options: OpenPinnedRootOptions = {},
): Promise<FileHandle> {
  if (!isAbsolute(path)) {
    throw new WorldFsInvalidPathError('a pinned root must be an absolute path');
  }
  let resolved = path;
  if (options.resolved !== true) {
    try {
      resolved = await realpath(path);
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorldFsMissingError('the pinned root is missing', code);
      }
      if (code === 'ELOOP') {
        throw new WorldFsUnsafeParentError(
          'the pinned root is a symlink loop; refusing to follow it', code);
      }
      throw new WorldFsIoError(
        `the pinned root could not be resolved (${code ?? 'unknown failure'})`, code);
    }
  }
  let handle: FileHandle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK,
    );
  } catch (err) {
    mapOpenError(err, 'the pinned root');
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new WorldFsUnsafeParentError('the pinned root is not a directory');
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    if (err instanceof WorldFsError) throw err;
    throw new WorldFsIoError('the pinned root could not be inspected', errnoOf(err));
  }
}

/** `lstat` one entry relative to a pinned parent fd (the final entry is not followed). */
export async function lstatAt(
  parentFd: number, name: string, options: PinnedOptions = {},
): Promise<Stats> {
  assertName(name);
  const procRoot = procRootOf(options);
  await probeProc(procRoot);
  try {
    return await lstat(procEntry(procRoot, parentFd, name));
  } catch (err) {
    mapEntryError(err, 'the pinned entry');
  }
}

/** Opens one leaf relative to a pinned parent fd, always `O_NOFOLLOW|O_NONBLOCK`. */
export async function openLeafAt(
  parentFd: number, name: string, flags: number, options: PinnedOptions = {},
): Promise<FileHandle> {
  assertName(name);
  const procRoot = procRootOf(options);
  await probeProc(procRoot);
  try {
    return await open(
      procEntry(procRoot, parentFd, name),
      flags | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (err) {
    mapOpenError(err, 'the pinned leaf');
  }
}

/** Changes one open handle's mode (never a path). */
export async function chmodFd(handle: FileHandle, mode: number): Promise<void> {
  try {
    await handle.chmod(mode);
  } catch (err) {
    throw new WorldFsIoError(
      `the pinned entry's mode could not be set (${errnoOf(err) ?? 'unknown failure'})`,
      errnoOf(err),
    );
  }
}

/** Creates one directory relative to a pinned parent fd; `EEXIST` is success. */
export async function mkdirAt(
  parentFd: number, name: string, options: MkNodOptions = {},
): Promise<void> {
  assertName(name);
  const procRoot = procRootOf(options);
  await probeProc(procRoot);
  try {
    await mkdir(procEntry(procRoot, parentFd, name), options.mode ?? 0o777);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'EEXIST') return;
    if (code === 'ENOENT') throw new WorldFsMissingError('the pinned parent is missing', code);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new WorldFsUnsafeParentError(
        'the pinned parent is a symlink or a non-directory; refusing to follow it', code);
    }
    throw new WorldFsIoError(
      `the pinned directory could not be created (${code ?? 'unknown failure'})`, code);
  }
}

/**
 * Opens (and, with `create`, creates) one directory relative to a pinned parent
 * fd. The walk `lstatAt`s the component before opening it: a symlink or
 * non-directory is the typed unsafe-parent failure, a missing one is created
 * (EEXIST success) and reopened exactly once. `mode` applies only to creation.
 */
export async function openPinnedDirAt(
  parentFd: number, name: string, options: PinnedDirOptions = {},
): Promise<FileHandle> {
  assertName(name);
  let entry: Stats;
  try {
    entry = await lstatAt(parentFd, name, options);
  } catch (err) {
    if (!(err instanceof WorldFsMissingError) || options.create !== true) throw err;
    await mkdirAt(parentFd, name, options);
    entry = await lstatAt(parentFd, name, options);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new WorldFsUnsafeParentError(
      'a pinned directory component is a symlink or a non-directory; refusing to follow it');
  }
  const procRoot = procRootOf(options);
  let handle: FileHandle;
  try {
    handle = await open(
      procEntry(procRoot, parentFd, name),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
      | fsConstants.O_NONBLOCK,
    );
  } catch (err) {
    mapOpenError(err, 'a pinned directory component');
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new WorldFsUnsafeParentError(
        'a pinned directory component is not a directory; refusing to follow it');
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    if (err instanceof WorldFsError) throw err;
    throw new WorldFsIoError('a pinned directory could not be inspected', errnoOf(err));
  }
}

/** A fresh handle on one already-pinned directory (the zero-segment parent). */
async function duplicatePinnedDir(fd: number, procRoot: string): Promise<FileHandle> {
  await probeProc(procRoot);
  let handle: FileHandle;
  try {
    // The proc fd entry IS a magic symlink to the pinned directory: following
    // that one kernel-owned link is the point of the duplicate. Every component
    // below it is still walked with O_NOFOLLOW.
    handle = await open(
      procEntry(procRoot, fd, ''),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NONBLOCK,
    );
  } catch (err) {
    mapOpenError(err, 'the pinned root');
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new WorldFsUnsafeParentError('the pinned root is not a directory');
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => {});
    if (err instanceof WorldFsError) throw err;
    throw new WorldFsIoError('the pinned root could not be inspected', errnoOf(err));
  }
}

/**
 * Walks `segments` below a pinned root fd and returns a handle on the final
 * directory (the caller's root fd is never closed). Every component is
 * `lstatAt`'d before its no-follow open, so a hostile interior symlink is the
 * typed unsafe-parent failure, never a follow or a deletion. With `create`,
 * missing components are created through the pinned fd (`mkdirAt`; `EEXIST`
 * success) and reopened once. Zero segments returns a duplicate of the root.
 */
export async function openPinnedParent(
  rootFd: number, segments: readonly string[], options: PinnedDirOptions = {},
): Promise<FileHandle> {
  const procRoot = procRootOf(options);
  for (const segment of segments) assertName(segment);
  if (segments.length === 0) return duplicatePinnedDir(rootFd, procRoot);
  let currentFd = rootFd;
  let current: FileHandle | null = null;
  try {
    for (const segment of segments) {
      const next = await openPinnedDirAt(currentFd, segment, options);
      if (current !== null) await current.close().catch(() => {});
      current = next;
      currentFd = next.fd;
    }
  } catch (err) {
    if (current !== null) await current.close().catch(() => {});
    throw err;
  }
  if (current === null) {
    // Unreachable: a non-empty walk always pins one handle.
    throw new WorldFsIoError('the pinned parent walk produced no directory');
  }
  return current;
}

/**
 * Renames one pinned entry into another pinned directory. The final entries are
 * addressed relative to the pinned fds, so a parent swapped at either end
 * cannot redirect the move; `EXDEV` and every other failure stay typed.
 */
export async function renameAt(
  srcFd: number, srcName: string, dstFd: number, dstName: string,
  options: PinnedOptions = {},
): Promise<void> {
  assertName(srcName);
  assertName(dstName);
  const procRoot = procRootOf(options);
  await probeProc(procRoot);
  try {
    await rename(
      procEntry(procRoot, srcFd, srcName), procEntry(procRoot, dstFd, dstName));
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') throw new WorldFsMissingError('a pinned rename end is missing', code);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new WorldFsUnsafeParentError(
        'a pinned rename end is a symlink or a non-directory; refusing to follow it', code);
    }
    throw new WorldFsIoError(
      `the pinned rename failed (${code ?? 'unknown failure'})`, code);
  }
}

/** Unlinks one entry relative to a pinned fd; `ENOENT` stays the typed missing arm. */
export async function unlinkAt(
  fd: number, name: string, options: PinnedOptions = {},
): Promise<void> {
  assertName(name);
  const procRoot = procRootOf(options);
  await probeProc(procRoot);
  try {
    await unlink(procEntry(procRoot, fd, name));
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') throw new WorldFsMissingError('the pinned entry is missing', code);
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new WorldFsUnsafeParentError(
        'a pinned unlink parent is a symlink or a non-directory; refusing to follow it', code);
    }
    throw new WorldFsIoError(
      `the pinned entry could not be removed (${code ?? 'unknown failure'})`, code);
  }
}

/** The canonical path of a pinned fd (the containment proof on an fd, never a path). */
export async function realpathFd(handle: FileHandle, options: PinnedOptions = {}): Promise<string> {
  const procRoot = procRootOf(options);
  await probeProc(procRoot);
  try {
    return await realpath(procEntry(procRoot, handle.fd, ''));
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT') {
      throw new WorldFsProcUnavailableError(
        'the pinned fd cannot be resolved: /proc is unavailable', code);
    }
    throw new WorldFsIoError(
      `the pinned fd could not be resolved (${code ?? 'unknown failure'})`, code);
  }
}
