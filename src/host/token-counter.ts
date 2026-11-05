import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteFile, syncPath } from '../journal/index.js';
import type { NodeTokenBudgetPort } from '../provider/adapter.js';
import { HostConfigError } from './errors.js';

/** The one host-owned node-token sidecar inside the home's private `.es`. */
export const NODE_TOKEN_LIMIT_FILE = 'node-token-limit.json';

export type NodeTokenState = 'active' | 'exhausted' | 'unknown';

/** The complete persisted counter. There is no second ledger or identity record. */
export type NodeTokenSnapshot = {
  readonly v: 0;
  readonly limitTokens: number;
  readonly usedTokens: number;
  readonly state: NodeTokenState;
};

/** What one node model attempt may do against the shared counter. */
export type NodeTokenAdmission = 'admit' | 'exhausted' | 'unknown';

export type NodeTokenCounterOptions = {
  /** Present only on a fresh `start --token-limit`; never on resume. */
  readonly createLimit?: number;
  /** Fired once after the counter becomes terminal in memory. Never awaited here. */
  readonly onTerminal?: () => void;
};

const STATE_VALUES: ReadonlySet<string> = new Set(['active', 'exhausted', 'unknown']);

function filePath(home: string): string {
  return join(home, '.es', NODE_TOKEN_LIMIT_FILE);
}

function safePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseSnapshot(raw: string): NodeTokenSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HostConfigError('the node token limit file is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostConfigError('the node token limit file has an invalid shape');
  }
  const record = value as Record<string, unknown>;
  if (record['v'] !== 0 || !safePositive(record['limitTokens'])
    || !safeNonNegative(record['usedTokens'])
    || typeof record['state'] !== 'string' || !STATE_VALUES.has(record['state'])) {
    throw new HostConfigError('the node token limit file has invalid fields');
  }
  return {
    v: 0, limitTokens: record['limitTokens'], usedTokens: record['usedTokens'],
    state: record['state'] as NodeTokenState,
  };
}

/**
 * Reads the sidecar without following a link and without requiring it to exist.
 * A malformed/permissive record is a configuration refusal, not "no budget".
 */
export async function readNodeTokenSnapshot(home: string): Promise<NodeTokenSnapshot | null> {
  const path = filePath(home);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new HostConfigError('the node token limit file must not be a symlink');
    }
    throw err;
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || (entry.mode & 0o777) !== 0o600
      || (process.getuid?.() !== undefined && entry.uid !== process.getuid!())) {
      throw new HostConfigError('the node token limit file must be a same-uid 0600 regular file');
    }
    return parseSnapshot(await handle.readFile('utf8'));
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The shared aggregate counter. `record`/`markUnknown` are serialized by a
 * promise queue; every successful mutation replaces the sidecar atomically and
 * syncs it before the adapter's response continues. The state becomes terminal
 * synchronously, so admission never needs to wait for IO.
 */
export class NodeTokenCounter implements NodeTokenBudgetPort {
  private dirty = false;
  private writeLoop: Promise<void> | null = null;
  private notified = false;

  private constructor(
    private readonly path: string,
    private snapshotValue: NodeTokenSnapshot,
    private readonly onTerminal?: () => void,
  ) {}

  static async open(
    home: string, options: NodeTokenCounterOptions = {},
  ): Promise<NodeTokenCounter | null> {
    const path = filePath(home);
    const existing = await readNodeTokenSnapshot(home);
    if (existing !== null) {
      if (options.createLimit !== undefined && options.createLimit !== existing.limitTokens) {
        throw new HostConfigError(
          `the stored node token limit is ${existing.limitTokens}; refusing ${options.createLimit}`,
        );
      }
      return new NodeTokenCounter(path, existing, options.onTerminal);
    }
    if (options.createLimit === undefined) return null;
    if (!safePositive(options.createLimit)) {
      throw new HostConfigError('the node token limit must be a positive safe integer');
    }
    const initial: NodeTokenSnapshot = {
      v: 0, limitTokens: options.createLimit, usedTokens: 0, state: 'active',
    };
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // A concurrent creator won: load and re-check its immutable limit.
      const raced = await readNodeTokenSnapshot(home);
      if (raced === null) throw err;
      if (raced.limitTokens !== options.createLimit) {
        throw new HostConfigError(
          `the stored node token limit is ${raced.limitTokens}; refusing ${options.createLimit}`,
        );
      }
      return new NodeTokenCounter(path, raced, options.onTerminal);
    }
    try {
      await handle.writeFile(`${JSON.stringify(initial)}\n`, 'utf8');
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
    await handle.close();
    await syncPath(dirname(path));
    return new NodeTokenCounter(path, initial, options.onTerminal);
  }

  snapshot(): NodeTokenSnapshot {
    return this.snapshotValue;
  }

  admit(): NodeTokenAdmission {
    if (this.snapshotValue.state === 'unknown') return 'unknown';
    if (this.snapshotValue.state === 'exhausted'
      || this.snapshotValue.usedTokens >= this.snapshotValue.limitTokens) return 'exhausted';
    return 'admit';
  }

  async record(inputTokens: number, outputTokens: number): Promise<void> {
    if (!safeNonNegative(inputTokens) || !safeNonNegative(outputTokens)) {
      await this.markUnknown();
      return;
    }
    // The aggregate and terminal transition are SYNCHRONOUS: admission closes
    // before an earlier write can finish. A response already admitted after a
    // terminal state still adds its reported usage (overshoot is honest), but
    // the terminal state is never revived.
    const usedTokens = this.snapshotValue.usedTokens + inputTokens + outputTokens;
    const state: NodeTokenState = this.snapshotValue.state === 'unknown'
      ? 'unknown'
      : usedTokens >= this.snapshotValue.limitTokens ? 'exhausted'
        : this.snapshotValue.state === 'exhausted' ? 'exhausted' : 'active';
    this.snapshotValue = { ...this.snapshotValue, usedTokens, state };
    if (state !== 'active') this.notify();
    await this.scheduleWrite();
  }

  async markUnknown(): Promise<void> {
    if (this.snapshotValue.state === 'unknown') return;
    this.snapshotValue = { ...this.snapshotValue, state: 'unknown' };
    this.notify();
    await this.scheduleWrite();
  }

  /**
   * Writes the CURRENT snapshot, never an older queued one. A mutation that
   * lands while a write is in flight sets `dirty` and is written by the next
   * iteration; a terminal state therefore cannot be replaced by a stale active
   * snapshot.
   */
  private scheduleWrite(): Promise<void> {
    this.dirty = true;
    if (this.writeLoop === null) {
      this.writeLoop = (async () => {
        while (this.dirty) {
          this.dirty = false;
          const snapshot = this.snapshotValue;
          try {
            await this.persist(snapshot);
          } catch {
            this.snapshotValue = { ...this.snapshotValue, state: 'unknown' };
            this.notify();
            this.dirty = false;
            break;
          }
        }
      })().finally(() => {
        this.writeLoop = null;
        if (this.dirty) void this.scheduleWrite();
      });
    }
    return this.writeLoop;
  }

  private notify(): void {
    if (this.notified) return;
    this.notified = true;
    this.onTerminal?.();
  }

  private async persist(snapshot: NodeTokenSnapshot): Promise<void> {
    const entry = await lstat(this.path);
    if (!entry.isFile() || (entry.mode & 0o777) !== 0o600
      || (process.getuid?.() !== undefined && entry.uid !== process.getuid!())) {
      throw new HostConfigError('the node token limit file is no longer a same-uid 0600 regular file');
    }
    await atomicWriteFile(this.path, `${JSON.stringify(snapshot)}\n`);
    await syncPath(dirname(this.path));
  }
}
