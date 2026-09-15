import { createHash } from 'node:crypto';
import { open as openFile, mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalizeJson, type JsonValue } from './canon.js';
import { GENESIS_HASH, makeEvent, envelopeJson, type EventDataFor, type EventEnvelope } from './envelope.js';
import { BlobStore, CLAIM_CHECK_THRESHOLD, MAX_BLOB_BYTES } from './blobs.js';
import { encodeBatch, scanBatches } from './framing.js';
import { isErrno, syncDir, syncFile } from './fsutil.js';
import { HEAD_FILE, type Head } from './head.js';
import { genesisState, verifyChain } from './verify.js';

export class SessionAlreadyOwnedError extends Error {
  constructor(nodeUid: string) {
    super(`journal for node "${nodeUid}" is already owned by a live writer`);
    this.name = 'SessionAlreadyOwnedError';
  }
}

export class JournalClosedError extends Error {
  constructor() {
    super('journal writer is closed');
    this.name = 'JournalClosedError';
  }
}

/**
 * The log ends in a fragment that is not a whole batch. Appending on top of it
 * would hide every later event from the reader, so the writer refuses and the
 * caller runs `repair()` first.
 */
export class TornTailError extends Error {
  constructor(public readonly dir: string, public readonly tornBytes: number) {
    super(`${dir}: torn trailing fragment of ${tornBytes} bytes — run repair() before opening`);
    this.name = 'TornTailError';
  }
}

/**
 * A batch failed to commit twice in a row. The batch is still pending, but the
 * log may now carry a partial frame, so retrying over it is no longer safe:
 * every further append/flush/close is refused instead of silently skipping the
 * events the caller already believes are logged.
 */
export class JournalPoisonedError extends Error {
  constructor(public readonly dir: string, reason: string) {
    super(`${dir}: journal writer is poisoned — ${reason}`);
    this.name = 'JournalPoisonedError';
  }
}

/**
 * A failed write restores the batch (retry semantics) rather than dropping it.
 * This many consecutive failures for the same batch poison the writer.
 */
const MAX_WRITE_FAILURE_STREAK = 2;

/** Upper bound on blob writes in flight, so a burst cannot exhaust fds. */
const MAX_CONCURRENT_BLOB_WRITES = 4;

/**
 * An entry carries the canonical bytes captured at `append`, so `flush` writes
 * exactly the lines that were hashed even if the caller mutates the payload
 * afterwards.
 */
interface PendingEvent {
  event: EventEnvelope;
  line: string;
}

/**
 * The only wall-clock read in src/journal/. Everything else takes time through
 * an injected `now()`, so C1.2's kernel clock can replace it wholesale.
 */
const systemClock = (): number => Date.now();

export class JournalWriter {
  private seq = 0;
  private prevHash = GENESIS_HASH;
  private firstHash: string | null = null;
  private pending: PendingEvent[] = [];
  /**
   * Blobs that must be durable before the events referencing them. Keyed by
   * content hash, so a burst referencing the same payload stores it once; an
   * entry is removed only once its `put` resolves, so a failed write is retried
   * by the next flush instead of leaving a dangling reference behind.
   */
  private pendingBlobs = new Map<string, Buffer>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  /** Serializes flushes so a burst can never be written twice. */
  private flushChain: Promise<void> = Promise.resolve();
  /** Bytes durably committed; the truncate target after a failed write. */
  private committedBytes = 0;
  /** On-disk watermark, which lags `seq` while a batch is still pending. */
  private committedSeq = 0;
  private committedLastHash = GENESIS_HASH;
  /** Streak of consecutive failed writes for the same batch. */
  private writeFailureStreak = 0;
  private poisoned = false;
  /** A write-behind failure, rethrown on the next append/flush/close. */
  private pendingFailure: Error | null = null;

  private constructor(
    private readonly dir: string,
    private readonly blobs: BlobStore,
    private readonly now: () => number,
    private readonly batchWindowMs: number,
    private readonly onError: ((err: Error) => void) | undefined,
    private readonly log: FileHandle,
  ) {}

  static async open(
    home: string, nodeUid: string,
    opts: {
      now?: () => number;
      batchWindowMs?: number;
      /** Observes write-behind failures; the failure still surfaces on the next call. */
      onError?: (err: Error) => void;
    } = {},
  ): Promise<JournalWriter> {
    const dir = join(home, 'nodes', nodeUid);
    await mkdir(dir, { recursive: true });
    await acquireLock(dir, nodeUid);
    let log: FileHandle;
    try {
      // 'a' both creates the log and makes every write an append: no code path
      // can seek backwards into journaled history.
      log = await openFile(join(dir, 'journal.v0.jsonl.zstd'), 'a');
    } catch (err) {
      await releaseLock(dir);
      throw err;
    }
    const w = new JournalWriter(
      dir, new BlobStore(home),
      opts.now ?? systemClock, opts.batchWindowMs ?? 200, opts.onError, log,
    );
    try {
      // The log file was just created: fsync the directory so its entry is
      // durable even if the process dies before the first flush.
      await syncDir(dir);
      await w.resume();
    } catch (err) {
      await w.forceClose();
      throw err;
    }
    return w;
  }

  private get logPath(): string { return join(this.dir, 'journal.v0.jsonl.zstd'); }
  private get headPath(): string { return join(this.dir, HEAD_FILE); }

  private async resume(): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readFile(this.logPath);
    } catch (err) {
      // A missing log is a brand-new journal. Any other read error (EACCES,
      // EIO) must not be mistaken for genesis: forking the chain from seq 0
      // over an existing log would corrupt it silently.
      if (isErrno(err, 'ENOENT')) return;
      throw err;
    }
    // repair() must have run first (kernel.md §3: at boot, before the writer
    // opens). Appending after a torn fragment would bury the fragment inside
    // the log, where the reader — which stops at the first torn region —
    // could never see the events that follow it.
    const { batches, tornBytes } = scanBatches(raw);
    if (tornBytes > 0) throw new TornTailError(this.dir, tornBytes);
    // Verify the full chain exactly as the reader would, and refuse to append
    // onto a tail that does not verify.
    const state = genesisState();
    for (const e of verifyChain(batches, null, state)) {
      this.firstHash ??= e.hash;
    }
    this.seq = state.seq;
    this.prevHash = state.prevHash;
    this.committedBytes = raw.length;
    this.committedSeq = this.seq;
    this.committedLastHash = this.prevHash;
  }

  /** Synchronous and in-memory: the hot path never blocks on I/O. */
  append<T extends string>(
    type: T, data: EventDataFor<T>, opts?: { ignorable?: boolean },
  ): EventEnvelope<EventDataFor<T>>;
  append(type: string, data: JsonValue, opts: { ignorable?: boolean } = {}): EventEnvelope {
    // A write-behind failure must be seen before anything else is accepted:
    // the caller has to know the previous burst is not durable.
    this.throwIfFailed();
    if (this.closed) throw new JournalClosedError();
    const e = makeEvent({
      type, data: this.claimCheck(data), seq: this.seq, time: this.now(),
      prevHash: this.prevHash,
      ...(opts.ignorable !== undefined ? { ignorable: opts.ignorable } : {}),
    });
    this.seq += 1;
    this.prevHash = e.hash;
    this.firstHash ??= e.hash;
    // The canonical line is captured here, once: `flush` writes these exact
    // bytes, so a caller mutating `data` afterwards cannot desynchronize the
    // persisted bytes from the hash that was chained.
    this.pending.push({ event: e, line: canonicalizeJson(envelopeJson(e)) });
    // No debounce: the window starts with the first event of the burst.
    this.timer ??= setTimeout(() => {
      void this.flush().catch((err: unknown) => { this.recordAsyncFailure(err); });
    }, this.batchWindowMs);
    return e;
  }

  private claimCheck(data: JsonValue): JsonValue {
    const canonical = canonicalizeJson(data);
    const bytes = Buffer.from(canonical, 'utf8');
    // The threshold is a byte count, and so is the reported size: measuring in
    // UTF-16 code units would let a multibyte payload far over 16 KB stay
    // inline, and would understate the size of what was stored.
    if (bytes.length < CLAIM_CHECK_THRESHOLD) return data;
    // Past MAX_BLOB_BYTES the payload is not stored whole: the blob holds a
    // prefix and the reference says so (`truncated: true` + original size).
    const truncated = bytes.length >= MAX_BLOB_BYTES;
    const stored = truncated ? bytes.subarray(0, MAX_BLOB_BYTES) : bytes;
    const blobHash = createHash('sha256').update(stored).digest('hex');
    this.pendingBlobs.set(blobHash, stored);
    const ref: Record<string, JsonValue> = { blob: blobHash, size: bytes.length };
    if (truncated) ref['truncated'] = true;
    return ref;
  }

  /** The barrier: pending burst → one frame, one write, one fsync. */
  flush(): Promise<void> {
    // Flushing a closed writer would have nothing to flush into: the handle is
    // gone, so the write would fail obscurely. Refuse it like an append.
    if (this.closed) throw new JournalClosedError();
    return this.enqueueFlush();
  }

  private enqueueFlush(): Promise<void> {
    const next = this.flushChain.then(() => this.flushOnce());
    // Keep the chain alive after a rejection so later flushes still run; the
    // caller of this call still sees the original rejection.
    this.flushChain = next.catch(() => {});
    return next;
  }

  /**
   * Makes every outstanding blob durable, newest set first, at a bounded
   * concurrency. Entries leave the map only once their write has resolved, so a
   * failed `put` stays queued and the next flush retries it — the writer never
   * commits an event whose blob is not on disk.
   */
  private async drainBlobs(): Promise<void> {
    while (this.pendingBlobs.size > 0) {
      const entries = [...this.pendingBlobs];
      const succeeded: string[] = [];
      const failure = await runBounded(entries, MAX_CONCURRENT_BLOB_WRITES, async ([hash, bytes]) => {
        await this.blobs.put(bytes);
        succeeded.push(hash);
      });
      for (const hash of succeeded) this.pendingBlobs.delete(hash);
      if (failure) throw failure;
    }
  }

  private async flushOnce(): Promise<void> {
    this.throwIfPoisoned();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // A blob must be durable before the events that reference it. An `append`
    // can land during the await, so drain until nothing is outstanding.
    await this.drainBlobs();
    if (this.pending.length === 0) {
      // Nothing to retry, but a failure recorded by a prior timer flush (e.g. a
      // failed head checkpoint write) must still surface to the caller.
      if (this.pendingFailure) throw this.pendingFailure;
      return;
    }
    // Captured synchronously (no await between the two statements), so the
    // batch and its blob set are fixed together.
    const batch = this.pending;
    this.pending = [];
    const frame = encodeBatch(batch.map((p) => p.line));
    try {
      await writeAll(this.log, frame);
      await this.log.sync();
    } catch (err) {
      // Restore the batch at the front of `pending` (order preserved) and roll
      // the log back to the last durable byte, so the retry is clean.
      this.pending = batch.concat(this.pending);
      this.writeFailureStreak += 1;
      const rolledBack = await this.truncateToCommitted();
      // A failed rollback leaves a partial frame in the log: retrying over it
      // would bury the tear, so the writer is poisoned outright.
      if (!rolledBack || this.writeFailureStreak >= MAX_WRITE_FAILURE_STREAK) {
        this.poisoned = true;
      }
      throw err;
    }
    this.committedBytes += frame.length;
    this.committedSeq = batch[batch.length - 1]!.event.seq + 1;
    this.committedLastHash = batch[batch.length - 1]!.event.hash;
    this.writeFailureStreak = 0;
    this.pendingFailure = null;
    await this.writeHead();
  }

  /** Rolls the log back to the last durable byte; false if the rollback failed. */
  private async truncateToCommitted(): Promise<boolean> {
    try {
      await truncate(this.logPath, this.committedBytes);
      return true;
    } catch {
      // The caller poisons the writer: appending over a partial frame would
      // hide the tear from every later reader.
      return false;
    }
  }

  private async writeHead(): Promise<void> {
    const head: Head = {
      first_hash: this.firstHash ?? GENESIS_HASH,
      last_hash: this.committedLastHash,
      count: this.committedSeq,
      ts: this.now(),
    };
    // Atomic replace: a crash can leave the previous head, never a torn one.
    // The tmp file is fsynced before the rename, so the rename cannot become
    // durable ahead of the contents it points at; on failure it is removed so
    // the directory cannot collect stale checkpoints.
    const tmp = `${this.headPath}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(head));
      await syncFile(tmp);
      await rename(tmp, this.headPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    await syncDir(this.dir);
  }

  async close(): Promise<void> {
    // `closed` is set on entry so an append racing the flush is refused rather
    // than accepted and then dropped. `finally` guarantees the handle and lock
    // are released even when the flush rejects.
    if (this.closed) return;
    this.closed = true;
    try {
      this.throwIfPoisoned();
      // Attempt a final flush: a burst that failed on the write-behind path is
      // retried here, so close() rejects only when the events really could not
      // be committed.
      await this.enqueueFlush();
    } finally {
      await this.forceClose();
    }
  }

  private throwIfPoisoned(): void {
    if (this.poisoned) {
      throw new JournalPoisonedError(this.dir, 'a batch failed to commit twice');
    }
  }

  private throwIfFailed(): void {
    this.throwIfPoisoned();
    if (this.pendingFailure) throw this.pendingFailure;
  }

  private recordAsyncFailure(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.pendingFailure = error;
    this.onError?.(error);
  }

  private async forceClose(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.log.close();
    await releaseLock(this.dir);
  }
}

async function writeAll(handle: FileHandle, buf: Buffer): Promise<void> {
  let written = 0;
  while (written < buf.length) {
    const { bytesWritten } = await handle.write(buf, written, buf.length - written, null);
    if (bytesWritten === 0) throw new Error('journal write made no progress');
    written += bytesWritten;
  }
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. It waits for every
 * item to settle (so all side effects have completed) and returns the first
 * error rather than rejecting early, letting the caller record the work that
 * did succeed.
 */
async function runBounded<T>(
  items: T[], limit: number, fn: (item: T) => Promise<void>,
): Promise<Error | null> {
  let next = 0;
  let firstError: Error | null = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        firstError ??= err instanceof Error ? err : new Error(String(err));
      }
    }
  });
  await Promise.all(workers);
  return firstError;
}

function lockPathFor(dir: string): string {
  return join(dir, 'journal.v0.lock');
}

interface LockRecord {
  pid: number;
  /** Process start time, so a recycled PID is detected as stale. */
  startedAt: number | null;
}

async function acquireLock(dir: string, nodeUid: string): Promise<void> {
  const lockPath = lockPathFor(dir);
  const record = JSON.stringify(await currentLockRecord());
  try {
    await writeFile(lockPath, record, { flag: 'wx' });
    return;
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err;
  }
  if (await isLockHeldByLiveProcess(lockPath)) throw new SessionAlreadyOwnedError(nodeUid);
  // Stale lock: the previous owner is gone.
  await rm(lockPath, { force: true });
  try {
    await writeFile(lockPath, record, { flag: 'wx' });
  } catch (err) {
    // Another writer won the race between the removal and this write.
    if (isErrno(err, 'EEXIST')) throw new SessionAlreadyOwnedError(nodeUid);
    throw err;
  }
}

async function currentLockRecord(): Promise<LockRecord> {
  return { pid: process.pid, startedAt: await processStartTime(process.pid) };
}

/**
 * Process start time in clock ticks since boot, read from `/proc/<pid>/stat`
 * field 22 (the value after the command in parentheses and the state char).
 * Together with the PID it identifies a process across PID reuse. Returns null
 * where `/proc` is unavailable, falling back to pid-only behaviour.
 */
async function processStartTime(pid: number): Promise<number | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const field = rest[19];
  if (field === undefined) return null;
  const value = Number(field);
  return Number.isFinite(value) ? value : null;
}

/**
 * The PID range `process.kill` accepts. A value outside it names no process at
 * all, so such a lock is stale rather than an unkillable live owner.
 */
const MAX_PID = 2 ** 31 - 1;

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_PID;
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return null;
  }
  // Tolerate the bare-PID lock written by an older writer.
  const barePid = Number(raw.trim());
  if (isPid(barePid)) return { pid: barePid, startedAt: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isPid(parsed['pid'])) return null;
    const startedAt = parsed['startedAt'];
    if (startedAt !== null && (typeof startedAt !== 'number' || !Number.isFinite(startedAt))) {
      return null;
    }
    return { pid: parsed['pid'], startedAt: startedAt as number | null };
  } catch {
    return null;
  }
}

async function isLockHeldByLiveProcess(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath);
  // Unparseable contents do not identify a live owner, so the lock is stale.
  if (record === null) return false;
  try {
    process.kill(record.pid, 0);
  } catch (err) {
    // EPERM means the process exists but is not ours — still a live owner.
    return !isErrno(err, 'ESRCH');
  }
  // The PID is alive; check that it is the same process and not a recycled one.
  if (record.startedAt === null) return true;
  const actual = await processStartTime(record.pid);
  // An unreadable start time cannot disprove ownership: treat it as live.
  if (actual === null) return true;
  return actual === record.startedAt;
}

async function releaseLock(dir: string): Promise<void> {
  await rm(lockPathFor(dir), { force: true });
}
