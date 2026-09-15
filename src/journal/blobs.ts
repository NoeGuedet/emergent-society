import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Format constant — a payload at or beyond this size is stored as a blob. */
export const CLAIM_CHECK_THRESHOLD = 16 * 1024;

export class BlobStore {
  constructor(private readonly home: string) {}

  private dirFor(hash: string): string {
    return join(this.home, 'blobs', hash.slice(0, 2));
  }

  private pathFor(hash: string): string {
    return join(this.dirFor(hash), hash);
  }

  async put(content: Buffer): Promise<string> {
    const hash = createHash('sha256').update(content).digest('hex');
    const dir = this.dirFor(hash);
    const path = this.pathFor(hash);
    await mkdir(dir, { recursive: true });
    // Content addressing makes an existing blob byte-identical to what we were
    // asked to store, so there is nothing to write.
    if (await this.has(hash)) return hash;
    // Write, fsync and rename a temporary file: a crash mid-write then cannot
    // leave a torn blob under a name that later reads would trust.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx');
    try {
      await handle.write(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    await syncDir(dir);
    return hash;
  }

  async get(hash: string): Promise<Buffer> {
    return readFile(this.pathFor(hash));
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.pathFor(hash));
      return true;
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return false;
      throw err;
    }
  }
}

/** Makes a freshly created directory entry durable (rename targets are fsynced). */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}