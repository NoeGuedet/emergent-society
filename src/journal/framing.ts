import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const LEN_BYTES = 4;

/**
 * Frames carry a zstd content checksum (kernel.md §3: "independent checksummed
 * zstd frames"), which is what makes a corrupt frame detectable rather than
 * silently decodable.
 */
const COMPRESS_OPTIONS = {
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
} as const;

export function encodeBatch(lines: string[]): Buffer {
  const compressed = zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'), COMPRESS_OPTIONS);
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
  return zstdDecompressSync(compressed).toString('utf8').split('\n');
}

export function scanBatches(buf: Buffer): { batches: Buffer[]; tornBytes: number } {
  const batches: Buffer[] = [];
  let offset = 0;
  while (offset + LEN_BYTES <= buf.length) {
    const len = buf.readUInt32LE(offset);
    const end = offset + LEN_BYTES + len;
    if (end > buf.length) return { batches, tornBytes: buf.length - offset };
    const frame = buf.subarray(offset, end);
    try {
      // A batch is only a batch if it decodes: a length prefix can happen to
      // match a corrupt region, and a checksum failure means the tail is torn.
      zstdDecompressSync(frame.subarray(LEN_BYTES));
    } catch {
      return { batches, tornBytes: buf.length - offset };
    }
    batches.push(frame);
    offset = end;
  }
  return { batches, tornBytes: buf.length - offset };
}