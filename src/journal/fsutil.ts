import { open, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
