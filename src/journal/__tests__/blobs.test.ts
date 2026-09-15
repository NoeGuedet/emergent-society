import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BlobStore, CLAIM_CHECK_THRESHOLD, InvalidBlobHashError } from '../blobs.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cell-blobs-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('BlobStore', () => {
  it('stores content-addressed bytes', async () => {
    const store = new BlobStore(home);
    const content = Buffer.from('hello blob');
    const hash = await store.put(content);
    expect(hash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(await store.has(hash)).toBe(true);
    expect((await store.get(hash)).equals(content)).toBe(true);
  });
  it('is idempotent: putting the same content twice yields the same hash', async () => {
    const store = new BlobStore(home);
    const content = Buffer.alloc(CLAIM_CHECK_THRESHOLD + 1, 0x61);
    expect(await store.put(content)).toBe(await store.put(content));
  });
  it('rejects a hash that does not exist', async () => {
    const store = new BlobStore(home);
    await expect(store.get('f'.repeat(64))).rejects.toThrow();
  });
  it('reports absence without throwing', async () => {
    const store = new BlobStore(home);
    expect(await store.has('f'.repeat(64))).toBe(false);
  });
  it('never overwrites an existing blob', async () => {
    const store = new BlobStore(home);
    const hash = await store.put(Buffer.from('stable'));
    await store.put(Buffer.from('stable'));
    expect((await store.get(hash)).toString('utf8')).toBe('stable');
  });
  it('rejects a hash that is not 64 lowercase hex characters', async () => {
    const store = new BlobStore(home);
    const bad = [
      '../secret', 'A'.repeat(64), 'f'.repeat(63), 'f'.repeat(65),
      'zz'.repeat(32), '', 'f/g'.repeat(21) + 'f',
    ];
    for (const hash of bad) {
      await expect(store.get(hash)).rejects.toThrow(InvalidBlobHashError);
      await expect(store.has(hash)).rejects.toThrow(InvalidBlobHashError);
    }
  });
  it('cannot be escaped by a traversal-shaped hash', async () => {
    const store = new BlobStore(home);
    const outside = join(home, 'secret.txt');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outside, 'do not read me');
    await expect(store.get('../secret.txt')).rejects.toThrow(InvalidBlobHashError);
    await expect(store.has('../secret.txt')).rejects.toThrow(InvalidBlobHashError);
  });
});