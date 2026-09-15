import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isErrno, syncDir } from './fsutil.js';

/**
 * Format constant — a payload whose canonical UTF-8 byte length is at or beyond
 * this is stored as a blob (kernel.md §3: "~8-16 KB"). Changing it changes the
 * format, i.e. it requires `v: 1`.
 */
export const CLAIM_CHECK_THRESHOLD = 16 * 1024;

/**
 * Format constant — a claim-checked payload is never *stored* whole past this
 * size. Beyond it the blob holds a prefix and the reference is marked
 * `truncated: true` with the original byte size, so the loss is explicit
 * (kernel.md §3: "truncation of giant payloads marked `truncated: true` +
 * original size — never silent"). Changing it changes the format (`v: 1`).
 */
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** A blob name is the lowercase hex SHA-256 of its content. */
const BLOB_HASH_RE = /^[0-9a-f]{64}$/;

export class InvalidBlobHashError extends Error {
  constructor(hash: string) {
    super(`not a blob hash: ${JSON.stringify(hash)}`);
    this.name = 'InvalidBlobHashError';
  }
}

export class BlobStore {
  constructor(private readonly home: string) {}

  private dirFor(hash: string): string {
    return join(this.home, 'blobs', hash.slice(0, 2));
  }

  private pathFor(hash: string): string {
    // The hash names a path component, so it is validated before use: an
    // unchecked value like `../secret` would escape `home` on the read path.
    if (!BLOB_HASH_RE.test(hash)) throw new InvalidBlobHashError(hash);
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
    // leave a torn blob under a name that later reads would trust. On any
    // failure the temp file is removed, so failed writes leave nothing behind.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(tmp, 'wx');
    try {
      await handle.write(content);
      await handle.sync();
      await handle.close();
      await rename(tmp, path);
    } catch (err) {
      await handle.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
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
