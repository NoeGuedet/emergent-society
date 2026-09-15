import { describe, it, expect } from 'vitest';
import { encodeBatch, decodeBatch, scanBatches } from '../framing.js';

describe('framed zstd batches', () => {
  it('round-trips a batch of lines', () => {
    const lines = ['{"a":1}', '{"b":2}'];
    expect(decodeBatch(encodeBatch(lines))).toEqual(lines);
  });
  it('walks concatenated batches', () => {
    const buf = Buffer.concat([encodeBatch(['1']), encodeBatch(['2', '3'])]);
    const { batches, tornBytes } = scanBatches(buf);
    expect(tornBytes).toBe(0);
    expect(batches.map(decodeBatch)).toEqual([['1'], ['2', '3']]);
  });
  it('reports a torn trailing fragment without throwing', () => {
    const buf = Buffer.concat([encodeBatch(['ok']), encodeBatch(['cut']).subarray(0, 9)]);
    const { batches, tornBytes } = scanBatches(buf);
    expect(batches.map(decodeBatch)).toEqual([['ok']]);
    expect(tornBytes).toBeGreaterThan(0);
  });
  it('handles an empty buffer', () => {
    expect(scanBatches(Buffer.alloc(0))).toEqual({ batches: [], tornBytes: 0 });
  });
  it('reports a corrupt-but-complete frame as torn', () => {
    const frame = encodeBatch(['x']);
    const corrupt = Buffer.from(frame);
    corrupt.fill(0xff, 4);
    const { batches, tornBytes } = scanBatches(corrupt);
    expect(batches).toHaveLength(0);
    expect(tornBytes).toBe(corrupt.length);
  });
  it('round-trips content with newlines and unicode', () => {
    const lines = ['a",b\\c', 'é\u2028日'];
    expect(decodeBatch(encodeBatch(lines))).toEqual(lines);
  });
});