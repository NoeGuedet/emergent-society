import { describe, it, expect } from 'vitest';
import { zstdCompressSync } from 'node:zlib';
import {
  decodeBatch, encodeBatch, scanBatches, CorruptFrameError, MAX_DECOMPRESSED_BATCH_BYTES,
} from '../framing.js';

describe('framed zstd batches', () => {
  it('round-trips a batch of lines', () => {
    const lines = ['{"a":1}', '{"b":2}'];
    expect(decodeBatch(encodeBatch(lines))).toEqual(lines);
  });
  it('walks concatenated batches', () => {
    const buf = Buffer.concat([encodeBatch(['1']), encodeBatch(['2', '3'])]);
    const { batches, tornBytes } = scanBatches(buf);
    expect(tornBytes).toBe(0);
    expect(batches.map((b) => b.lines)).toEqual([['1'], ['2', '3']]);
    expect(batches.map((b) => b.size)).toEqual([encodeBatch(['1']).length, encodeBatch(['2', '3']).length]);
  });
  it('reports a torn trailing fragment without throwing', () => {
    const buf = Buffer.concat([encodeBatch(['ok']), encodeBatch(['cut']).subarray(0, 9)]);
    const { batches, tornBytes } = scanBatches(buf);
    expect(batches.map((b) => b.lines)).toEqual([['ok']]);
    expect(tornBytes).toBeGreaterThan(0);
  });
  it('handles an empty buffer', () => {
    expect(scanBatches(Buffer.alloc(0))).toEqual({ batches: [], tornBytes: 0 });
  });
  it('reports a trailing fragment shorter than a length prefix as torn', () => {
    const { tornBytes } = scanBatches(Buffer.from([1, 2]));
    expect(tornBytes).toBe(2);
  });
  it('rejects a corrupt complete frame as interior corruption', () => {
    const corrupt = Buffer.from(encodeBatch(['x']));
    corrupt.fill(0xff, 4);
    let caught: unknown;
    try { scanBatches(corrupt); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(CorruptFrameError);
    expect((caught as CorruptFrameError).offset).toBe(0);
  });
  it('rejects a corrupt middle frame at its exact offset rather than reporting the tail as torn', () => {
    const first = encodeBatch(['1']);
    const middle = Buffer.from(encodeBatch(['2']));
    middle.fill(0xff, 4);
    const last = encodeBatch(['3']);
    const buf = Buffer.concat([first, middle, last]);
    let caught: unknown;
    try { scanBatches(buf); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(CorruptFrameError);
    expect((caught as CorruptFrameError).offset).toBe(first.length);
  });
  it('rejects a zero-length frame instead of mistaking it for a torn tail', () => {
    const buf = Buffer.concat([Buffer.alloc(4), encodeBatch(['after'])]);
    expect(() => scanBatches(buf)).toThrow(CorruptFrameError);
  });
  it('round-trips content with newlines and unicode', () => {
    const lines = ['a",b\\c', 'é\u2028日'];
    expect(decodeBatch(encodeBatch(lines))).toEqual(lines);
  });
  it('bounds decompression to the documented per-batch maximum', () => {
    expect(MAX_DECOMPRESSED_BATCH_BYTES).toBe(64 * 1024 * 1024);
    // A frame that expands past the bound is refused rather than allocated.
    const bomb = Buffer.from(zstdCompressBomb());
    expect(() => decodeBatch(bomb)).toThrow();
  });
});

function zstdCompressBomb(): Buffer {
  // 70 MiB of zeros compresses tiny and exceeds the 64 MiB output bound.
  const compressed = zstdCompressSync(Buffer.alloc(70 * 1024 * 1024));
  const out = Buffer.alloc(4 + compressed.length);
  out.writeUInt32LE(compressed.length, 0);
  compressed.copy(out, 4);
  return out;
}
