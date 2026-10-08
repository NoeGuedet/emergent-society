import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256HexOf, type JsonValue } from './canon.js';
import { CorruptionError, JournalError } from './errors.js';
import { atomicWriteFile, ensureDurableDirectory, isErrno, syncPath } from './fsutil.js';

/**
 * Format constant — a payload whose canonical UTF-8 byte length is at or beyond
 * this is stored as a blob (kernel.md §3: the format constant 16 KiB,
 * inclusive). Changing it changes the format, i.e. it requires `v: 1`.
 */
export const CLAIM_CHECK_THRESHOLD = 16 * 1024;

/**
 * Format constant — a claim-checked payload is never *stored* whole at or
 * beyond this size. At or beyond it the blob holds a prefix and the reference
 * is marked `truncated: true` with the original byte size, so the loss is
 * explicit (kernel.md §3: "truncation of giant payloads marked `truncated:
 * true` + original size — never silent"). Changing it changes the format
 * (`v: 1`).
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
 * `{ blob, size }` (plus `truncated: true` at or above MAX_BLOB_BYTES) and the
 * canonical bytes of the original payload go to the blob store.
 */
export interface BlobRef {
  blob: string;
  size: number;
  truncated?: boolean;
}

/**
 * A claim-checked payload at or above MAX_BLOB_BYTES is stored as a prefix
 * only. The reference is honest about the loss, so resolving it is refused
 * outright rather than served as if whole (kernel.md §3: never silent).
 */
export class TruncatedBlobError extends JournalError {
  constructor(public readonly hash: string, public readonly size: number) {
    super(`blob ${hash} is a truncated prefix of a ${size}-byte payload — the original is unrecoverable`);
  }
}

/**
 * A claim-check blob whose bytes do not match the reference that names it, or
 * whose body is not the JSON the reference stands for. The bytes are corrupt
 * source data, so this is classified as corruption — inspect before retrying —
 * not a retryable environment failure.
 */
export class BlobIntegrityError extends CorruptionError {
  constructor(
    public readonly hash: string,
    public readonly expectedBytes: number,
    public readonly actualBytes: number,
  ) {
    super('claim-check blob failed integrity verification');
  }
}

/**
 * Refuses a reference flagged `truncated` before its blob is read: the blob is a
 * prefix of a payload whose original is unrecoverable, so every verified read
 * must reject it rather than serve the prefix as whole (kernel.md §3).
 */
export function assertBlobRefReadable(ref: BlobRef): void {
  if (ref.truncated === true) throw new TruncatedBlobError(ref.blob, ref.size);
}

/**
 * Verifies the bytes a reference names before they are trusted or parsed: the
 * exact byte length and the SHA-256 digest must match. Content addressing is not
 * re-checked by the store's raw `get`, so every verified read routes through
 * here; a mismatch is source corruption, not a retryable environment failure.
 */
export function assertBlobBytes(ref: BlobRef, bytes: Buffer): void {
  if (bytes.length !== ref.size || sha256HexOf(bytes) !== ref.blob) {
    throw new BlobIntegrityError(ref.blob, ref.size, bytes.length);
  }
}

/**
 * The one verified read of a claim-checked payload: it refuses a truncated
 * reference, proves the digest and exact byte length, then parses the JSON body.
 * A body that is not JSON is reported as `BlobIntegrityError`, never a raw
 * `SyntaxError`, so a caller classifies exactly one corruption kind.
 */
export function parseBlobJson(ref: BlobRef, bytes: Buffer): JsonValue {
  assertBlobRefReadable(ref);
  assertBlobBytes(ref, bytes);
  try {
    return JSON.parse(bytes.toString('utf8')) as JsonValue;
  } catch {
    throw new BlobIntegrityError(ref.blob, ref.size, bytes.length);
  }
}

/**
 * The boundary's mapping of a failed blob read. Only a *missing* blob (ENOENT)
 * is an integrity failure — the payload is unrecoverable — so it becomes
 * `BlobIntegrityError`. Every other failure (EACCES, EIO, or an
 * `InvalidBlobHashError` for a path-shaped hash) is an environment or input
 * problem, and is rethrown unchanged so it keeps its truthful type and cause and
 * is never reclassified as corruption by the verified-read path.
 */
export function throwBlobReadError(ref: BlobRef, err: unknown): never {
  if (isErrno(err, 'ENOENT')) throw new BlobIntegrityError(ref.blob, ref.size, 0);
  throw err;
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
    // The shard's entry — and every level newly created to reach it — must be
    // durable before a log entry can reference this blob, or a crash could keep
    // the reference and lose the directory that holds the bytes. `home` is the
    // trusted root; the chain is re-proved on every call, never cached.
    await ensureDurableDirectory(dir, this.home);
    // Content addressing makes an existing blob byte-identical to what we were
    // asked to store, so there is nothing to write.
    if (await this.has(hash)) return hash;
    // Write, fsync and rename a temporary file: a crash mid-write then cannot
    // leave a torn blob under a name that later reads would trust.
    await atomicWriteFile(path, content);
    await syncPath(dir);
    return hash;
  }

  /**
   * The raw stored bytes, without verification: content addressing is not
   * re-checked here, so a caller holding a reference must prove the digest and
   * byte length (`assertBlobBytes`/`parseBlobJson`) before trusting them.
   */
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
