import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const LEN_BYTES = 4;

/**
 * Format constant — a durable batch never decompresses to more than this. It
 * bounds the allocation a single frame can force (`maxOutputLength`), so a
 * crafted or corrupt frame cannot expand without limit (zstd bomb).
 */
export const MAX_DECOMPRESSED_BATCH_BYTES = 64 * 1024 * 1024;

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
export class CorruptFrameError extends Error {
  constructor(public readonly offset: number, reason: string) {
    super(`corrupt frame at byte ${offset}: ${reason}`);
    this.name = 'CorruptFrameError';
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
  const compressed = zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'), COMPRESS_OPTIONS);
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
 * Walks the length-prefixed frames of a log.
 *
 * Two different damage modes are distinguished, because only one may be
 * repaired destructively:
 *  - a frame whose announced length runs past the end of the file is a
 *    **torn tail** — reported as `tornBytes` and never thrown;
 *  - a complete frame that fails to decode (or a zero-length frame, which is
 *    not a valid frame) is **interior corruption** — a hard `CorruptFrameError`,
 *    carrying the offset so the operator can inspect it.
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
      return { batches, tornBytes: buf.length - offset };
    }
    let lines: string[];
    try {
      lines = decompress(buf.subarray(offset + LEN_BYTES, end));
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
