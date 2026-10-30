/**
 * The storage circuit breaker's pure half (W0-d, lite): the enforcement policy,
 * the typed refusal, and the probe seam's types. No imports — this module is
 * the one home of the storage vocabulary, so the journal and frontier layers
 * can depend on it without a node-side import.
 *
 * The kernel writes its truth (the frontier journal, the local log, blobs)
 * before an effect. A full disk can lose the record or deadlock the gate, so
 * three homes refuse the effect instead: the journal writer's flush, the
 * frontier gate's `begin`, and the driver's turn start. This module decides
 * *when* to refuse; the homes decide *where*.
 *
 * Two floors are deliberately distinct. The enforcement floor here
 * (`STORAGE_MIN_FREE_BYTES` + `KERNEL_RESERVE_BYTES`, and the inode pair) is the
 * circuit breaker. The C3 world doctor's `MIN_FREE_BYTES = 20 GiB` (in
 * `limits.ts`) is the REPORTED storage-health floor: enforcing it would refuse
 * every turn on this host's 7.3 GiB test filesystem, so it stays a report.
 *
 * A quota record is never detected: `quota` exists only through the test-only
 * `HostDeps.storageQuota` seam. Without one the fact is `unquoted` — never a
 * refusal. The unit is the cell (per-node attribution is a later wave).
 */

/** A free-space reading: bytes available and inodes available. */
export type StorageFree = {
  readonly bytes: number;
  readonly inodes: number;
};

/**
 * The injected quota record: used bytes against a limit. The refusal watermark
 * is 80 % of the limit, leaving the last fifth as the kernel's headroom.
 */
export type StorageQuota = {
  readonly usedBytes: number;
  readonly limitBytes: number;
};

/**
 * The enforcement policy. `minFree*` is the absolute floor and `reserve*` the
 * kernel's own headroom; the two are added, so a probe must report at least
 * `min + reserve` for the home to proceed.
 */
export type StoragePolicy = {
  readonly minFreeBytes: number;
  readonly minFreeInodes: number;
  readonly reserveBytes: number;
  readonly reserveInodes: number;
  readonly quota?: StorageQuota;
};

/**
 * The probe seam. It reads `home`'s filesystem and returns the free reading, or
 * `null` when it cannot read one — a probe error degrades, it never refuses.
 * Production is `statfsProbe`; the tests inject low/high/null values.
 */
export type StorageProbe = (home: string) => Promise<StorageFree | null>;

/** The injected storage seam: the policy plus the probe the three homes share. */
export type StorageConfig = {
  readonly policy: StoragePolicy;
  readonly probe: StorageProbe;
};

/**
 * The operator-visible storage fact: `quoted` only when a quota record was
 * injected, `unquoted` for every production cell (no quota is detected).
 */
export type StorageFact = 'quoted' | 'unquoted';

export type StorageErrorKind = 'bytes' | 'inodes' | 'quota';

/**
 * The typed refusal of a storage-gated effect. Bounded by construction: a kind
 * plus a one-line detail carrying two integers — never a path, a payload or a
 * secret. It is not a write failure: the writer's poison machinery does not
 * see it, and the batch it refused stays pending.
 */
export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  readonly detail: string;

  constructor(kind: StorageErrorKind, detail: string) {
    super(`storage refused (${kind}): ${detail}`);
    this.name = 'StorageError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** The enforcement floor for free bytes: 2 GiB. */
export const STORAGE_MIN_FREE_BYTES = 2 * 1024 ** 3;
/** The enforcement floor for free inodes: 100,000. */
export const STORAGE_MIN_FREE_INODES = 100_000;
/** The kernel's byte headroom on top of the floor: 512 MiB. */
export const KERNEL_RESERVE_BYTES = 512 * 1024 ** 2;
/** The kernel's inode headroom on top of the floor: 10,000. */
export const KERNEL_RESERVE_INODES = 10_000;

/**
 * The production enforcement policy. It carries no quota: a quota is only ever
 * injected, so every ordinary cell is `unquoted` and never refused for it.
 */
export const DEFAULT_STORAGE_POLICY: StoragePolicy = Object.freeze({
  minFreeBytes: STORAGE_MIN_FREE_BYTES,
  minFreeInodes: STORAGE_MIN_FREE_INODES,
  reserveBytes: KERNEL_RESERVE_BYTES,
  reserveInodes: KERNEL_RESERVE_INODES,
});

/** One bounded integer for a refusal detail: no path, no payload. */
function bounded(value: number): string {
  return Number.isFinite(value) ? String(Math.trunc(value)) : 'unknown';
}

/**
 * A reading is usable only as a finite non-negative safe integer. A malformed
 * value (a NaN/Infinity from a broken probe seam, a negative counter) is a
 * failed reading, not a low one: it degrades exactly like a `null` probe.
 */
function validReading(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Refuses the effect when the free reading is under the policy's floor.
 *
 * Bytes and inodes are checked against `min + reserve` (inclusive: exactly at
 * the floor passes, one unit under refuses). A present quota refuses above 80 %
 * of its limit (`usedBytes > limit - ceil(limit / 5)`), so exactly 80 % passes
 * and one byte over refuses. An absent quota is never a refusal.
 *
 * A malformed reading or quota — a non-finite/negative/non-integer value — is a
 * FAILED reading, not a low one, and degrades exactly like a `null` probe: the
 * breaker refuses only on a trustworthy value, and never passes a NaN quota.
 *
 * @throws StorageError with the failing kind and a bounded detail.
 */
export function assertStorage(policy: StoragePolicy, free: StorageFree): void {
  if (!validReading(free.bytes) || !validReading(free.inodes)) return;
  const bytesFloor = policy.minFreeBytes + policy.reserveBytes;
  if (!(free.bytes >= bytesFloor)) {
    throw new StorageError(
      'bytes',
      `free bytes ${bounded(free.bytes)} below the ${bounded(bytesFloor)}-byte floor`,
    );
  }
  const inodesFloor = policy.minFreeInodes + policy.reserveInodes;
  if (!(free.inodes >= inodesFloor)) {
    throw new StorageError(
      'inodes',
      `free inodes ${bounded(free.inodes)} below the ${bounded(inodesFloor)}-inode floor`,
    );
  }
  const quota = policy.quota;
  if (quota !== undefined) {
    if (!validReading(quota.usedBytes) || !validReading(quota.limitBytes)) return;
    const watermark = quota.limitBytes - Math.ceil(quota.limitBytes / 5);
    if (quota.usedBytes > watermark) {
      throw new StorageError(
        'quota',
        `used bytes ${bounded(quota.usedBytes)} above the ${bounded(watermark)}-byte quota watermark`,
      );
    }
  }
}

/**
 * The shared home-side check: probe, then assert. A probe that returns `null`,
 * one that throws, or a malformed reading degrades and never refuses; the
 * caller's effect proceeds on the writer's own guarantees.
 *
 * @throws StorageError when a readable probe is under the policy.
 */
export async function checkStorage(config: StorageConfig, home: string): Promise<void> {
  let free: StorageFree | null;
  try {
    free = await config.probe(home);
  } catch {
    free = null;
  }
  if (free === null) return;
  assertStorage(config.policy, free);
}

/** The operator-visible fact for a policy: a presented quota, or none. */
export function storageFact(policy: StoragePolicy): StorageFact {
  return policy.quota === undefined ? 'unquoted' : 'quoted';
}
