import { open as openFile, mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { canonicalizeJson, sha256HexOf, type JsonValue } from './canon.js';
import { GENESIS_HASH, makeEvent, envelopeJson, type EventDataFor, type EventEnvelope } from './envelope.js';
import { BlobStore, CLAIM_CHECK_THRESHOLD, MAX_BLOB_BYTES } from './blobs.js';
import { encodeBatch, scanBatches } from './framing.js';
import { isErrno, syncDir, syncFile, writeAll } from './fsutil.js';
import { headPath, journalPath, nodeDir, type Head } from './layout.js';
import { acquireLock, releaseLock, SessionAlreadyOwnedError } from './lock.js';
import { genesisState, verifyChain } from './verify.js';

export { SessionAlreadyOwnedError };

/**
 * The append side of the journal: the only writer of a node's canonical log.
 *
 * Appends are synchronous and in-memory; a bounded write-behind window turns a
 * burst into one framed batch with one `write` + `fsync`, and `flush` is the
 * explicit barrier callers use before a model request or a top-level tool
 * effect. Ownership is exclusive (see `lock.ts`), and a batch is never dropped:
 * a failed write is retried, and a writer that cannot make progress ends in a
 * typed terminal state rather than silently skipping events the caller was told
 * were logged.
 */
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

/**
 * Upper bound on blob writes in flight, so a burst cannot exhaust fds. This
 * deliberately bounds file descriptors only, not memory: a burst of huge
 * payloads is still held whole in `pendingBlobs`. That is accepted for C1.1 —
 * the backpressure policy (bounded queue, shedding, or an ingest cap) is a
 * C1.2+ decision, and forcing one here would freeze a policy the journal has
 * no basis to choose yet.
 */
const MAX_CONCURRENT_BLOB_WRITES = 4;

/**
 * The write-behind window: the first event of a burst starts the clock (no
 * debounce) and one batch is written when it elapses.
 */
const DEFAULT_BATCH_WINDOW_MS = 200;

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
 * The on-disk watermark. It lags `seq`/`prevHash` while a batch is pending, and
 * is the rollback target when a write fails: `bytes` is the last durable length,
 * `seq`/`lastHash` describe the last durable event.
 */
interface Watermark {
  /** Bytes durably committed; the truncate target after a failed write. */
  bytes: number;
  seq: number;
  lastHash: string;
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
  /** On-disk watermark, which lags `seq` while a batch is still pending. */
  private committed: Watermark = { bytes: 0, seq: 0, lastHash: GENESIS_HASH };
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
    const dir = nodeDir(home, nodeUid);
    await mkdir(dir, { recursive: true });
    await acquireLock(dir, nodeUid);
    let log: FileHandle;
    try {
      // 'a' both creates the log and makes every write an append: no code path
      // can seek backwards into journaled history.
      log = await openFile(journalPath(dir), 'a');
    } catch (err) {
      await releaseLock(dir);
      throw err;
    }
    const w = new JournalWriter(
      dir, new BlobStore(home),
      opts.now ?? systemClock, opts.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS, opts.onError, log,
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

  private get logPath(): string { return journalPath(this.dir); }
  private get headFilePath(): string { return headPath(this.dir); }

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
    this.committed = { bytes: raw.length, seq: this.seq, lastHash: this.prevHash };
  }

  /** Synchronous and in-memory: the hot path never blocks on I/O. */
  append<T extends string>(
    type: T, data: EventDataFor<T>, opts?: { ignorable?: boolean },
  ): EventEnvelope<EventDataFor<T>>;
  append(type: string, data: JsonValue, opts: { ignorable?: boolean } = {}): EventEnvelope {
    // A write-behind failure must be seen before anything else is accepted:
    // the caller has to know the previous burst is not durable.
    this.throwIfUnusable();
    if (this.closed) throw new JournalClosedError();
    const e = makeEvent({
      type, data: this.claimCheck(data), seq: this.seq, time: this.now(),
      prevHash: this.prevHash, ...opts,
    });
    this.seq += 1;
    this.prevHash = e.hash;
    this.firstHash ??= e.hash;
    // The canonical line is captured here, once: `flush` writes these exact
    // bytes, so a caller mutating `data` afterwards cannot desynchronize the
    // persisted bytes from the hash that was chained.
    this.pending.push({ event: e, line: canonicalizeJson(envelopeJson(e)) });
    // No debounce: the window starts with the first event of the burst. The
    // guard makes a timer that outlives `close()` a no-op instead of a
    // synchronous throw from `flush()` inside a callback nothing can catch.
    this.timer ??= setTimeout(() => {
      if (this.closed) return;
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
    const blobHash = sha256HexOf(stored);
    this.pendingBlobs.set(blobHash, stored);
    const ref: Record<string, JsonValue> = { blob: blobHash, size: bytes.length };
    if (truncated) ref['truncated'] = true;
    return ref;
  }

  /**
   * The barrier: pending burst → one frame, one write, one fsync.
   *
   * Total in promise style: `async` so the closed guard becomes a rejection
   * rather than a synchronous throw, which a caller reaching it through a
   * callback (the write-behind timer) could not catch.
   */
  async flush(): Promise<void> {
    // Flushing a closed writer would have nothing to flush into: the handle is
    // gone, so the write would fail obscurely. Refuse it like an append.
    if (this.closed) throw new JournalClosedError();
    await this.enqueueFlush();
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
   * commits an event whose blob is not on disk. A blob failure counts into the
   * same poison streak as a log-write failure, so a permanently failing blob
   * store ends in a typed terminal state rather than rejecting forever.
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
      if (failure) {
        this.writeFailureStreak += 1;
        if (this.writeFailureStreak >= MAX_WRITE_FAILURE_STREAK) this.poisoned = true;
        throw failure;
      }
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
    const last = batch[batch.length - 1]!;
    this.committed = {
      bytes: this.committed.bytes + frame.length,
      seq: last.event.seq + 1,
      lastHash: last.event.hash,
    };
    this.writeFailureStreak = 0;
    this.pendingFailure = null;
    await this.writeHead();
  }

  /** Rolls the log back to the last durable byte; false if the rollback failed. */
  private async truncateToCommitted(): Promise<boolean> {
    try {
      await truncate(this.logPath, this.committed.bytes);
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
      last_hash: this.committed.lastHash,
      count: this.committed.seq,
      ts: this.now(),
    };
    // Atomic replace: a crash can leave the previous head, never a torn one.
    // The tmp file is fsynced before the rename, so the rename cannot become
    // durable ahead of the contents it points at; on failure it is removed so
    // the directory cannot collect stale checkpoints.
    const tmp = `${this.headFilePath}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(head));
      await syncFile(tmp);
      await rename(tmp, this.headFilePath);
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

  private throwIfUnusable(): void {
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
