import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/** Makes a freshly created or renamed directory entry durable. */
export async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Fsyncs a single file path (used after truncation, a metadata-only change). */
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/** Writes the whole buffer, retrying short writes until it is all durable. */
export async function writeAll(handle: FileHandle, buf: Buffer): Promise<void> {
  let written = 0;
  while (written < buf.length) {
    const { bytesWritten } = await handle.write(buf, written, buf.length - written, null);
    if (bytesWritten === 0) throw new Error('journal write made no progress');
    written += bytesWritten;
  }
}
