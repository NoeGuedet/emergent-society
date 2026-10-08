import { describe, expect, it, vi } from 'vitest';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BlobStore, JournalWriter, MAX_BLOB_BYTES, TruncatedBlobError,
  isBlobRef, isCorruption, isRetryable,
} from '../../journal/index.js';
import {
  appendForgedBlobRef, useTempHome, collectEvents, payloadOfCanonicalBytes,
} from '../../journal/__tests__/helpers.js';
import {
  BlobIntegrityError, loadVerifiedEvents, rawEnvelopes, sourceOf,
} from '../loader.js';

const home = useTempHome('c13-loader-');
const KNOWN = new Set(['test/big']);

function blobPath(hash: string): string {
  return join(home(), 'blobs', hash.slice(0, 2), hash);
}

async function writeBig(label: string): Promise<{ hash: string; text: string }> {
  const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
  const text = label.repeat(4000); // a payload well past CLAIM_CHECK_THRESHOLD
  writer.append('test/big', { payload: text });
  await writer.close();
  const raw = await collectEvents(home(), KNOWN);
  const data = raw[0]?.data;
  if (!isBlobRef(data)) throw new Error('expected the writer to claim-check the payload');
  return { hash: data.blob, text };
}

describe('loadVerifiedEvents', () => {
  it('resolves a claim-checked payload while retaining the raw envelope', async () => {
    const text = 'abc'.repeat(8000);
    const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
    writer.append('test/big', { payload: text });
    await writer.close();

    const events = await loadVerifiedEvents(home(), 'n1', KNOWN);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.data).toEqual({ payload: text });
    expect(isBlobRef(event.data)).toBe(false);
    expect(isBlobRef(event.raw.data)).toBe(true);
    expect(event.seq).toBe(event.raw.seq);
    expect(event.hash).toBe(event.raw.hash);
    expect(sourceOf(event)).toEqual({ seq: event.seq, hash: event.hash });
    expect(rawEnvelopes(events)[0]?.data).toBe(event.raw.data);
  });

  it('serves a verified suffix from a watermark', async () => {
    const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
    writer.append('test/big', { n: 1 });
    writer.append('test/big', { n: 2 });
    writer.append('test/big', { n: 3 });
    await writer.close();
    const suffix = await loadVerifiedEvents(home(), 'n1', KNOWN, 1);
    expect(suffix.map((e) => (e.data as { n: number }).n)).toEqual([2, 3]);
  });

  it('rejects a blob substituted with a different valid JSON value under the same hash', async () => {
    const { hash } = await writeBig('substitute');
    await writeFile(blobPath(hash), JSON.stringify({ substituted: true }));
    await expect(loadVerifiedEvents(home(), 'n1', KNOWN)).rejects.toThrow(BlobIntegrityError);
  });

  it('rejects a missing blob as a BlobIntegrityError, not a raw ENOENT', async () => {
    const { hash } = await writeBig('missing');
    await rm(blobPath(hash), { force: true });
    const err = await loadVerifiedEvents(home(), 'n1', KNOWN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobIntegrityError);
    expect((err as BlobIntegrityError).hash).toBe(hash);
  });

  it('rejects a short blob', async () => {
    const { hash } = await writeBig('short');
    const content = await readFile(blobPath(hash));
    await writeFile(blobPath(hash), content.subarray(0, Math.floor(content.length / 2)));
    await expect(loadVerifiedEvents(home(), 'n1', KNOWN)).rejects.toThrow(BlobIntegrityError);
  });

  it('rethrows a blob read EIO as a retryable environment error, not corruption', async () => {
    await writeBig('eio-x'); // long enough that writeBig's payload is claim-checked
    const spy = vi.spyOn(BlobStore.prototype, 'get').mockRejectedValue(
      Object.assign(new Error('injected EIO'), { code: 'EIO' }),
    );
    try {
      const err = await loadVerifiedEvents(home(), 'n1', KNOWN).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(BlobIntegrityError);
      expect(isCorruption(err)).toBe(false);
      expect(isRetryable(err)).toBe(true);
      expect((err as { code?: string }).code).toBe('EIO');
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.getuid?.() === 0)('rethrows a real EACCES blob read, not corruption', async () => {
    const { hash } = await writeBig('eacces');
    await chmod(blobPath(hash), 0o000);
    const err = await loadVerifiedEvents(home(), 'n1', KNOWN).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BlobIntegrityError);
    expect(isCorruption(err)).toBe(false);
    expect(isRetryable(err)).toBe(true);
  });

  it('rejects a truncated reference outright', async () => {
    const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
    // Canonical data past MAX_BLOB_BYTES is stored as a truncated prefix.
    writer.append('test/big', { payload: 'x'.repeat(4 * 1024 * 1024 + 16) });
    await writer.close();
    const raw = await collectEvents(home(), KNOWN);
    expect(isBlobRef(raw[0]?.data)).toBe(true);
    expect((raw[0]?.data as { truncated?: boolean }).truncated).toBe(true);
    await expect(loadVerifiedEvents(home(), 'n1', KNOWN)).rejects.toThrow(TruncatedBlobError);
  });

  it('rejects a reference the writer flagged truncated even when digest and size match', async () => {
    // Exactly MAX_BLOB_BYTES canonical bytes: the whole payload is stored, so
    // digest and byte length agree with the reference and only the flag rejects.
    const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
    writer.append('test/big', payloadOfCanonicalBytes(MAX_BLOB_BYTES));
    await writer.close();
    const raw = await collectEvents(home(), KNOWN);
    const ref = raw[0]?.data;
    if (!isBlobRef(ref)) throw new Error('expected a claim-check reference');
    expect(ref.truncated).toBe(true);
    expect(ref.size).toBe(MAX_BLOB_BYTES);
    await expect(loadVerifiedEvents(home(), 'n1', KNOWN)).rejects.toThrow(TruncatedBlobError);
  });

  it('accepts a payload one byte under MAX_BLOB_BYTES losslessly', async () => {
    const input = payloadOfCanonicalBytes(MAX_BLOB_BYTES - 1);
    const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
    writer.append('test/big', input);
    await writer.close();
    const events = await loadVerifiedEvents(home(), 'n1', KNOWN);
    expect(events[0]?.data).toEqual(input);
  });

  it('rejects a payload one byte over MAX_BLOB_BYTES', async () => {
    const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
    writer.append('test/big', payloadOfCanonicalBytes(MAX_BLOB_BYTES + 1));
    await writer.close();
    await expect(loadVerifiedEvents(home(), 'n1', KNOWN)).rejects.toThrow(TruncatedBlobError);
  });

  it('wraps a verified non-JSON blob body in a typed error, not a raw SyntaxError', async () => {
    const writer = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60000 });
    writer.append('test/big', { n: 0 });
    await writer.close();
    await appendForgedBlobRef(home(), Buffer.from('{ not json'));
    const err = await loadVerifiedEvents(home(), 'n1', KNOWN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobIntegrityError);
    expect(err).not.toBeInstanceOf(SyntaxError);
  });
});
