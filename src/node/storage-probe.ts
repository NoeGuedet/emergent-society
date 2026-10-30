import { statfs } from 'node:fs/promises';
import {
  DEFAULT_STORAGE_POLICY, type StorageConfig, type StorageFree,
} from '../storage.js';

/**
 * The free-space probe (W0-d): `statfs` over the cell home, bigint-safe.
 *
 * It lives here, not in `src/storage.ts`, because the probe is the one node-side
 * dependency: the pure policy module keeps `journal/` and `frontier/` free of
 * node imports, and both of those layers receive the probe through their
 * options instead. A probe failure — a vanished home, an EACCES, an EIO — is a
 * `null` reading: the circuit breaker degrades, it never refuses on an
 * unreadable filesystem.
 *
 * `bsize * bavail` and `ffree` are bigint at the syscall; each is clamped to
 * `Number.MAX_SAFE_INTEGER` so a giant filesystem cannot produce a lossy float.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** One nonnegative safe integer from a bigint syscall reading. */
function clamp(value: bigint): number {
  if (value <= 0n) return 0;
  return value > MAX_SAFE ? Number.MAX_SAFE_INTEGER : Number(value);
}

/**
 * Reads `home`'s free bytes and inodes.
 *
 * @returns the reading, or `null` when `statfs` fails: a probe error degrades.
 */
export async function statfsProbe(home: string): Promise<StorageFree | null> {
  try {
    const fs = await statfs(home, { bigint: true });
    return { bytes: clamp(fs.bsize * fs.bavail), inodes: clamp(fs.ffree) };
  } catch {
    return null;
  }
}

/**
 * The production storage seam: the enforcement policy over the real probe. The
 * host composes it from its test-only deps; the driver uses it when no seam was
 * injected. It carries no quota: production is always `unquoted`.
 */
export const DEFAULT_STORAGE: StorageConfig = Object.freeze({
  policy: DEFAULT_STORAGE_POLICY,
  probe: statfsProbe,
});
