import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { JournalError } from './errors.js';

/**
 * Durable-write plumbing: the small set of fsync/rename primitives the journal
 * uses everywhere. Keeping them together is what makes the discipline auditable
 * — a file that is written but never fsynced is a crash-corruption bug, and
 * there is exactly one shape each such sequence takes.
 */

/** Makes a path's directory entry durable. Works for a directory or a file. */
export async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes `data` to `path` atomically: a uniquely named temp file is written and
 * fsynced, then renamed into place, so a crash leaves either the previous
 * contents or the new ones — never a torn file. The temp file is removed on
 * failure, so a failed write cannot litter the directory.
 *
 * The rename only makes the entry durable once the *directory* is fsynced;
 * callers that need that guarantee follow with `syncPath(dirname)`.
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx');
  try {
    if (typeof data === 'string') await handle.write(data);
    else await handle.write(data, 0, data.length, null);
    await handle.sync();
    await handle.close();
    await rename(tmp, path);
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** True when `path` exists; ENOENT is "missing", EACCES/EIO are failures. */
async function pathIsPresent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}

function ignoreExisting(err: unknown): void {
  if (!isErrno(err, 'EEXIST')) throw err;
}

/**
 * The levels to create and prove for `dir`, leaf-first, stopping at `root` — the
 * trusted boundary — or, when `root` is omitted, at `dir`'s first existing
 * ancestor. A missing `root` is not a stop: it is returned as a level too, along
 * with its own missing ancestors up to the first that exists, so a caller may
 * open a journal under a home that does not exist yet.
 *
 * @throws when `dir` is not inside a provided `root`.
 */
async function levelsToProve(dir: string, root: string | undefined): Promise<string[]> {
  const levels: string[] = [];
  if (root === undefined) {
    // No trusted root: prove `dir` and every missing ancestor against the first
    // ancestor that already exists, which is the only boundary available.
    levels.push(dir);
    let cur = dirname(dir);
    for (;;) {
      if (await pathIsPresent(cur)) return levels;
      levels.push(cur);
      const up = dirname(cur);
      if (up === cur) return levels;
      cur = up;
    }
  }
  let cur = dir;
  let atRoot = true;
  for (;;) {
    if (atRoot && cur === root) {
      if (await pathIsPresent(cur)) return levels;
      atRoot = false; // root itself is missing: create and prove it as well
    } else if (!atRoot && await pathIsPresent(cur)) {
      return levels;
    }
    levels.push(cur);
    const up = dirname(cur);
    if (up === cur) {
      if (cur !== root) throw new Error(`${dir} is not inside ${root}`);
      return levels;
    }
    cur = up;
  }
}

/**
 * Creates `dir` — and every missing ancestor down from the trusted `root` — and
 * makes each level's *parent directory entry* durable before returning.
 *
 * A directory survives a crash only once the parent holding its entry has been
 * fsynced, so `mkdir -p` is not durable. This proves the chain from `root` down
 * to `dir`, top-down: the topmost level is synced against `root` itself, so a
 * directory another process created and did not sync cannot become a false trust
 * anchor, and the concurrent-creator window is closed.
 *
 * `root` is the trusted boundary — the cell home, which the caller owns and which
 * is durable independently of the journal. Only the chain at or below `root` is
 * touched. When `root` is missing it is created like any other level and its own
 * missing ancestors are created and proven up to the first that already exists,
 * which then becomes the boundary; with no `root` the boundary is `dir`'s first
 * existing ancestor. Nothing is cached: every call re-proves the chain, so a
 * deleted or substituted directory is never trusted through a stale pathname.
 *
 * `dir` is normally built with `path.join` (which normalizes `.`/`..`/doubled
 * separators) while `root` is passed verbatim, so both are resolved to absolute,
 * normalized paths before comparing; `resolve` is lexical, so an existing symlink
 * in either path is preserved rather than followed.
 *
 * @throws ENOENT/EACCES/EIO from `stat`/`mkdir`/`syncPath`, and ENOTDIR when the
 * leaf (or an ancestor) that must be a directory is a file; also throws before
 * any I/O when `dir` is not inside a provided `root`.
 */
export async function ensureDurableDirectory(dir: string, root?: string): Promise<void> {
  const target = resolve(dir);
  const trusted = root === undefined ? undefined : resolve(root);
  const levels = await levelsToProve(target, trusted);
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i]!;
    await mkdir(level).catch(ignoreExisting);
    await syncPath(dirname(level));
  }
  // `mkdir` reports EEXIST for a file just as for a directory; only the leaf is
  // checked here, because a file in an ancestor makes the next `mkdir` fail
  // ENOTDIR on its own.
  const info = await stat(target);
  if (!info.isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${target}`), { code: 'ENOTDIR' });
  }
}

/** Reads a file, mapping ENOENT to `null` and rethrowing every other error. */
export async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    // A missing file is "nothing here"; EACCES/EIO must not be mistaken for it.
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
}

export function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/** The log handle accepted writes but made no progress, so the flush is stuck. */
export class JournalWriteStalledError extends JournalError {
  constructor() {
    super('journal write made no progress');
  }
}

/** Writes the whole buffer, retrying short writes until it is all durable. */
export async function writeAll(handle: FileHandle, buf: Buffer): Promise<void> {
  let written = 0;
  while (written < buf.length) {
    const { bytesWritten } = await handle.write(buf, written, buf.length - written, null);
    if (bytesWritten === 0) throw new JournalWriteStalledError();
    written += bytesWritten;
  }
}
