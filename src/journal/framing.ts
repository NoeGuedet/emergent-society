import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { CorruptionError, JournalError } from './errors.js';

const LEN_BYTES = 4;

/** Every zstd frame begins with this magic number. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Format constant — a durable batch decompresses to strictly fewer than this.
 * It bounds the allocation a single frame can force (`maxOutputLength`), so a
 * crafted or corrupt frame cannot expand without limit (zstd bomb). The writer
 * must never emit a frame its own reader would refuse: a burst is split into
 * consecutive frames below the bound, and a single event that alone reaches it
 * is refused at append.
 */
export const MAX_DECOMPRESSED_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * A batch whose decompressed content reaches the frame bound. The frame would
 * be minted but every reader and `repair()` would refuse it, so it is refused
 * before any bytes are written.
 */
export class OversizedBatchError extends JournalError {
  constructor(public readonly bytes: number) {
    super(`batch decompresses to ${bytes} bytes, at or over the ${MAX_DECOMPRESSED_BATCH_BYTES}-byte frame bound`);
  }
}

/**
 * A single event line that alone reaches the frame bound. No split can make it
 * fit, so the event can never be committed; `append` refuses it while the
 * writer is still clean rather than admitting an event that could only poison
 * the journal.
 */
export class OversizedEventError extends JournalError {
  constructor(public readonly bytes: number) {
    super(`event is ${bytes} bytes, at or over the ${MAX_DECOMPRESSED_BATCH_BYTES}-byte frame bound`);
  }
}

/**
 * Frames carry a zstd content checksum (kernel.md §3: "independent checksummed
 * zstd frames"), which is what makes a corrupt frame detectable rather than
 * silently decodable.
 */
const COMPRESS_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
} as const;

/**
 * A frame is complete (its announced length fits in the file) but does not
 * decode. That is interior corruption, not a torn tail: the missing bytes are
 * not at the end, so truncating to this offset would silently discard valid
 * committed events.
 */
export class CorruptFrameError extends CorruptionError {
  constructor(public readonly offset: number, reason: string) {
    super(`corrupt frame at byte ${offset}: ${reason}`);
  }
}

/** A decoded durable batch, with the frame it came from. */
export interface ScannedBatch {
  /** Offset of the frame's length prefix in the log. */
  offset: number;
  /** Byte length of the whole frame (prefix included). */
  size: number;
  lines: string[];
}

export function encodeBatch(lines: string[]): Buffer {
  const raw = Buffer.from(lines.join('\n'), 'utf8');
  // The compressed length is not the durable bound: `decompress` caps the
  // *output*, so an over-bound frame would be minted here and then refused by
  // every reader (and by `repair`). Refuse it at the writer instead.
  if (raw.length >= MAX_DECOMPRESSED_BATCH_BYTES) {
    throw new OversizedBatchError(raw.length);
  }
  const compressed = zstdCompressSync(raw, COMPRESS_OPTIONS);
  if (compressed.length > 0xffffffff) {
    throw new RangeError(`batch compresses to ${compressed.length} bytes, over the u32 frame limit`);
  }
  const out = Buffer.alloc(LEN_BYTES + compressed.length);
  out.writeUInt32LE(compressed.length, 0);
  compressed.copy(out, LEN_BYTES);
  return out;
}

export function decodeBatch(frame: Buffer): string[] {
  const len = frame.readUInt32LE(0);
  const compressed = frame.subarray(LEN_BYTES, LEN_BYTES + len);
  if (compressed.length !== len) {
    throw new Error(`truncated frame: announced ${len} bytes, ${compressed.length} present`);
  }
  return decompress(compressed);
}

/**
 * Decides whether the region starting at `offset` is a torn tail (a partial
 * write, which repair may discard) or corruption of a length prefix (which it
 * must not).
 *
 * A length prefix whose announced frame overruns EOF is ambiguous on its own: a
 * partial write and a bit-flipped prefix look the same. The discriminator is
 * the payload behind the prefix. At the start of the region, a zstd frame always
 * begins with the magic `28 B5 2F FD`; if the prefix is corrupt, whatever
 * length it announces, the bytes there are still the start of a real frame,
 * which decodes — or at least begins to — rather than failing cleanly. So:
 *  - if the remaining bytes do not start with the magic, the region is not the
 *    start of a frame at all → treat as torn (the "too short to tell" case,
 *    fewer than 8 bytes, is accepted as torn for the same reason);
 *  - if they do start with it and the whole available payload decodes, then a
 *    complete frame was present and only the prefix lied → corruption;
 *  - if they start with it but the payload is a strict, undecodable prefix of a
 *    frame (`Z_BUF_ERROR` / truncated-input), it is a genuine partial write →
 *    torn.
 */
function isTornTail(buf: Buffer, offset: number): boolean {
  const payloadStart = offset + LEN_BYTES;
  const available = buf.subarray(payloadStart);
  if (available.length < ZSTD_MAGIC.length * 2) return true;
  if (!available.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) return true;
  try {
    decompress(available);
    return false;
  } catch {
    return true;
  }
}

/**
 * Walks the length-prefixed frames of a log.
 *
 * Damage modes are distinguished, because only one may be repaired
 * destructively:
 *  - a frame whose announced length runs past the end of the file and whose
 *    payload is a genuine partial write is a **torn tail** — reported as
 *    `tornBytes` and never thrown;
 *  - a complete frame that fails to decode (or a zero-length frame, which is
 *    not a valid frame, or an overrunning prefix whose payload decodes) is
 *    **interior corruption** — a hard `CorruptFrameError`, carrying the offset
 *    so the operator can inspect it.
 */
export function scanBatches(buf: Buffer): { batches: ScannedBatch[]; tornBytes: number } {
  const batches: ScannedBatch[] = [];
  let offset = 0;
  while (offset + LEN_BYTES <= buf.length) {
    const len = buf.readUInt32LE(offset);
    if (len === 0) {
      throw new CorruptFrameError(offset, 'zero-length frame');
    }
    const end = offset + LEN_BYTES + len;
    if (end > buf.length) {
      if (!isTornTail(buf, offset)) {
        throw new CorruptFrameError(offset, 'length prefix does not frame the bytes present');
      }
      return { batches, tornBytes: buf.length - offset };
    }
    let lines: string[];
    try {
      lines = decodeBatch(buf.subarray(offset, end));
    } catch (err) {
      throw new CorruptFrameError(offset, err instanceof Error ? err.message : 'decode failed');
    }
    batches.push({ offset, size: end - offset, lines });
    offset = end;
  }
  return { batches, tornBytes: buf.length - offset };
}

function decompress(compressed: Buffer): string[] {
  if (compressed.length === 0) throw new Error('empty compressed payload');
  const raw = zstdDecompressSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BATCH_BYTES });
  return raw.toString('utf8').split('\n');
}
