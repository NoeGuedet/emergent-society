import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_STORAGE_POLICY,
  KERNEL_RESERVE_BYTES,
  KERNEL_RESERVE_INODES,
  STORAGE_MIN_FREE_BYTES,
  STORAGE_MIN_FREE_INODES,
  StorageError,
  assertStorage,
  checkStorage,
  storageFact,
  type StorageConfig,
  type StorageFree,
  type StoragePolicy,
} from '../storage.js';
import { DEFAULT_STORAGE, statfsProbe } from '../node/storage-probe.js';

/**
 * The storage circuit breaker's pure half: the enforcement policy, the typed
 * refusal, and the injected probe that feeds it.
 *
 * The enforcement floors are deliberately separate from the C3 doctor's 20 GiB
 * REPORT floor: enforcing that floor would refuse every turn on this host's
 * 7.3 GiB `/tmp`, so the D8 case below proves the real probe on the test
 * filesystem passes the real enforcement constants. The quota record is never
 * detected — it exists only through the injected seam — so its 80 % boundary is
 * a pure unit test.
 */

/** A small policy so the at/one-over boundaries read in the test, not in hex. */
const policy: StoragePolicy = {
  minFreeBytes: 100, minFreeInodes: 10, reserveBytes: 50, reserveInodes: 5,
};

const free = (bytes: number, inodes: number): StorageFree => ({ bytes, inodes });

/** A probe returning `state.free`; the caller flips it between calls. */
function guard(state: { free: StorageFree | null }): StorageConfig {
  return { policy, probe: async () => state.free };
}

describe('the enforcement policy', () => {
  it('pins the enforcement floors and the reserve, separate from the C3 report floor', () => {
    expect(STORAGE_MIN_FREE_BYTES).toBe(2 * 1024 ** 3);
    expect(STORAGE_MIN_FREE_INODES).toBe(100_000);
    expect(KERNEL_RESERVE_BYTES).toBe(512 * 1024 ** 2);
    expect(KERNEL_RESERVE_INODES).toBe(10_000);
    expect(DEFAULT_STORAGE_POLICY).toEqual({
      minFreeBytes: STORAGE_MIN_FREE_BYTES,
      minFreeInodes: STORAGE_MIN_FREE_INODES,
      reserveBytes: KERNEL_RESERVE_BYTES,
      reserveInodes: KERNEL_RESERVE_INODES,
    });
    // No quota is detected: the production default is quoted only by injection.
    expect(DEFAULT_STORAGE_POLICY.quota).toBeUndefined();
    expect(storageFact(DEFAULT_STORAGE_POLICY)).toBe('unquoted');
  });

  it('passes exactly at min + reserve for bytes and refuses one byte under', () => {
    expect(() => assertStorage(policy, free(150, 100))).not.toThrow();
    let thrown: unknown;
    try {
      assertStorage(policy, free(149, 100));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).kind).toBe('bytes');
    // The detail is bounded and carries no path and no secret.
    expect((thrown as StorageError).detail.length).toBeGreaterThan(0);
    expect((thrown as StorageError).detail.length).toBeLessThanOrEqual(200);
    expect((thrown as StorageError).detail).not.toContain('/');
  });

  it('passes exactly at min + reserve for inodes and refuses one inode under', () => {
    expect(() => assertStorage(policy, free(1_000, 15))).not.toThrow();
    let thrown: unknown;
    try {
      assertStorage(policy, free(1_000, 14));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).kind).toBe('inodes');
    expect((thrown as StorageError).detail).not.toContain('/');
  });

  it('refuses a quota at one byte over 80 % and passes at exactly 80 %', () => {
    const quoted: StoragePolicy = { ...policy, quota: { usedBytes: 800, limitBytes: 1_000 } };
    expect(() => assertStorage(quoted, free(1_000, 1_000))).not.toThrow();
    expect(storageFact(quoted)).toBe('quoted');
    let thrown: unknown;
    try {
      assertStorage({ ...policy, quota: { usedBytes: 801, limitBytes: 1_000 } }, free(1_000, 1_000));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as StorageError).kind).toBe('quota');
    // A present quota with room is not a refusal, and an absent one never is.
    expect(() => assertStorage({ ...policy, quota: { usedBytes: 0, limitBytes: 1_000 } },
      free(150, 15))).not.toThrow();
  });

  it('degrades on a probe error: a null free reading never refuses', async () => {
    await expect(checkStorage(guard({ free: null }), '/nonexistent')).resolves.toBeUndefined();
    // A throwing probe is a probe error too: the caller-facing contract is a
    // null reading, and `checkStorage` applies it rather than trusting callers.
    const throwing: StorageConfig = {
      policy, probe: async () => { throw new Error('EIO'); },
    };
    await expect(checkStorage(throwing, '/nonexistent')).resolves.toBeUndefined();
  });

  it('refuses through checkStorage when the injected probe is low', async () => {
    await expect(checkStorage(guard({ free: free(149, 100) }), '/x'))
      .rejects.toBeInstanceOf(StorageError);
    await expect(checkStorage(guard({ free: free(150, 15) }), '/x')).resolves.toBeUndefined();
  });

  it('probes the home the caller names, so one cell cannot be checked against another', async () => {
    const seen: string[] = [];
    const config: StorageConfig = {
      policy, probe: async (home) => { seen.push(home); return free(1_000, 1_000); },
    };
    await checkStorage(config, '/cells/a');
    await checkStorage(config, '/cells/b');
    expect(seen).toEqual(['/cells/a', '/cells/b']);
  });
});

describe('the statfs probe', () => {
  let home = '';
  beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'es-storage-probe-')); });
  afterAll(async () => { await rm(home, { recursive: true, force: true }); });

  it('returns safe positive byte and inode readings for a real directory', async () => {
    const reading = await statfsProbe(home);
    expect(reading).not.toBeNull();
    expect(Number.isSafeInteger(reading!.bytes)).toBe(true);
    expect(Number.isSafeInteger(reading!.inodes)).toBe(true);
    expect(reading!.bytes).toBeGreaterThan(0);
    expect(reading!.inodes).toBeGreaterThan(0);
  });

  it('returns null for a missing path: a probe error degrades, never refuses', async () => {
    await expect(statfsProbe(join(home, 'nope'))).resolves.toBeNull();
  });

  it('passes the real enforcement floors on this host when the host is above them', async ({ skip }) => {
    // The composed default carries the real probe and the production policy —
    // a fact independent of this host's free space.
    expect(DEFAULT_STORAGE.policy).toBe(DEFAULT_STORAGE_POLICY);
    expect(DEFAULT_STORAGE.probe).toBe(statfsProbe);
    const reading = await statfsProbe(home);
    expect(reading).not.toBeNull();
    const bytesFloor = STORAGE_MIN_FREE_BYTES + KERNEL_RESERVE_BYTES;
    const inodesFloor = STORAGE_MIN_FREE_INODES + KERNEL_RESERVE_INODES;
    if (reading!.bytes < bytesFloor || reading!.inodes < inodesFloor) {
      // A legitimate low-space/low-inode host must not fail the suite: the
      // production floors are the invariant, this host's reading is not.
      skip();
    }
    expect(() => assertStorage(DEFAULT_STORAGE_POLICY, reading!)).not.toThrow();
  });
});

describe('malformed readings and quotas', () => {
  it('degrades a malformed reading or quota instead of refusing (symmetric with a probe error)', () => {
    expect(() => assertStorage(policy, free(Number.NaN, 1_000))).not.toThrow();
    expect(() => assertStorage(policy, free(1_000, Number.POSITIVE_INFINITY))).not.toThrow();
    expect(() => assertStorage(policy, free(-1, 1_000))).not.toThrow();
    expect(() => assertStorage(policy, free(1.5, 1_000))).not.toThrow();
    expect(() => assertStorage(
      { ...policy, quota: { usedBytes: Number.NaN, limitBytes: 100 } }, free(1_000, 1_000),
    )).not.toThrow();
    expect(() => assertStorage(
      { ...policy, quota: { usedBytes: 10, limitBytes: Number.NaN } }, free(1_000, 1_000),
    )).not.toThrow();
    expect(() => assertStorage(
      { ...policy, quota: { usedBytes: -1, limitBytes: 100 } }, free(1_000, 1_000),
    )).not.toThrow();
  });

  it('checkStorage degrades a malformed probe reading', async () => {
    const config: StorageConfig = { policy, probe: async () => free(Number.NaN, 1_000) };
    await expect(checkStorage(config, '/tmp')).resolves.toBeUndefined();
  });
});
