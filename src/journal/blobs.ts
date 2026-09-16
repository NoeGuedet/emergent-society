import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256HexOf } from './canon.js';
import { JournalError } from './errors.js';
import { atomicWriteFile, isErrno, syncPath } from './fsutil.js';

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

export class InvalidBlobHashError extends JournalError {
  constructor(hash: string) {
    super(`not a blob hash: ${JSON.stringify(hash)}`);
  }
}

/**
 * The reference `JournalWriter.claimCheck` substitutes for a payload whose
 * canonical size is at or past CLAIM_CHECK_THRESHOLD: `data` becomes
 * `{ blob, size }` (plus `truncated: true` past MAX_BLOB_BYTES) and the
 * canonical bytes of the original payload go to the blob store.
 */
export interface BlobRef {
  blob: string;
  size: number;
  truncated?: boolean;
}

/**
 * A claim-checked payload past MAX_BLOB_BYTES is stored as a prefix only. The
 * reference is honest about the loss, so resolving it is refused outright
 * rather than served as if whole (kernel.md §3: never silent).
 */
export class TruncatedBlobError extends JournalError {
  constructor(public readonly hash: string, public readonly size: number) {
    super(`blob ${hash} is a truncated prefix of a ${size}-byte payload — the original is unrecoverable`);
  }
}

/**
 * Recognizes the exact shape claimCheck writes. The key set must match exactly:
 * a caller's own `{ blob, size, … }` payload must never be mistaken for a
 * reference and rewritten under it.
 */
export function isBlobRef(data: unknown): data is BlobRef {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const keys = Object.keys(data).sort();
  const expected = 'truncated' in data ? ['blob', 'size', 'truncated'] : ['blob', 'size'];
  if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) return false;
  const ref = data as Record<string, unknown>;
  return typeof ref['blob'] === 'string' && typeof ref['size'] === 'number'
    && (ref['truncated'] === undefined || ref['truncated'] === true);
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
    const hash = sha256HexOf(content);
    const dir = this.dirFor(hash);
    const path = this.pathFor(hash);
    await mkdir(dir, { recursive: true });
    // Content addressing makes an existing blob byte-identical to what we were
    // asked to store, so there is nothing to write.
    if (await this.has(hash)) return hash;
    // Write, fsync and rename a temporary file: a crash mid-write then cannot
    // leave a torn blob under a name that later reads would trust.
    await atomicWriteFile(path, content);
    await syncPath(dir);
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
