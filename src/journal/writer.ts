import { open as openFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalizeJson, sha256Hex, type JsonValue } from './canon.js';
import { GENESIS_HASH, makeEvent, type EventEnvelope } from './envelope.js';
import { BlobStore, CLAIM_CHECK_THRESHOLD } from './blobs.js';
import { decodeBatch, encodeBatch, scanBatches } from './framing.js';

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
 * The only wall-clock read in src/journal/. Everything else takes time through
 * an injected `now()`, so C1.2's kernel clock can replace it wholesale.
 */
const systemClock = (): number => Date.now();

/** Chain checkpoint — `journal.v0.head`. Disposable, rebuildable from the log. */
export interface Head {
  first_hash: string;
  last_hash: string;
  count: number;
  ts: number;
}

export class JournalWriter {
  private seq = 0;
  private prevHash = GENESIS_HASH;
  private firstHash: string | null = null;
  private pending: EventEnvelope[] = [];
  private pendingBlobs: Promise<unknown>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  /** Serializes flushes so a burst can never be written twice. */
  private flushChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly dir: string,
    private readonly blobs: BlobStore,
    private readonly now: () => number,
    private readonly batchWindowMs: number,
    private readonly log: FileHandle,
  ) {}

  static async open(
    home: string, nodeUid: string,
    opts: { now?: () => number; batchWindowMs?: number } = {},
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
      opts.now ?? systemClock, opts.batchWindowMs ?? 200, log,
    );
    try {
      await w.resume();
    } catch (err) {
      await w.forceClose();
      throw err;
    }
    return w;
  }

  private get logPath(): string { return join(this.dir, 'journal.v0.jsonl.zstd'); }
  private get headPath(): string { return join(this.dir, 'journal.v0.head'); }
  private get lockPath(): string { return join(this.dir, 'journal.v0.lock'); }

  private async resume(): Promise<void> {
    let raw: Buffer;
    try { raw = await readFile(this.logPath); } catch { return; }
    // repair() must have run first (kernel.md §3: at boot, before the writer
    // opens). Appending after a torn fragment would bury the fragment inside
    // the log, where the reader — which stops at the first torn region —
    // could never see the events that follow it.
    const { batches, tornBytes } = scanBatches(raw);
    if (tornBytes > 0) throw new TornTailError(this.dir, tornBytes);
    for (const frame of batches) {
      for (const line of decodeBatch(frame)) {
        const e = JSON.parse(line) as EventEnvelope;
        this.seq = e.seq + 1;
        this.prevHash = e.hash;
        this.firstHash ??= e.hash;
      }
    }
  }

  /** Synchronous and in-memory: the hot path never blocks on I/O. */
  append(type: string, data: JsonValue, opts: { ignorable?: boolean } = {}): EventEnvelope {
    if (this.closed) throw new JournalClosedError();
    const e = makeEvent({
      type, data: this.claimCheck(data), seq: this.seq, time: this.now(),
      prevHash: this.prevHash,
      ...(opts.ignorable !== undefined ? { ignorable: opts.ignorable } : {}),
    });
    this.seq += 1;
    this.prevHash = e.hash;
    this.firstHash ??= e.hash;
    this.pending.push(e);
    // No debounce: the window starts with the first event of the burst.
    this.timer ??= setTimeout(() => { void this.flush().catch(() => {}); }, this.batchWindowMs);
    return e;
  }

  private claimCheck(data: JsonValue): JsonValue {
    const canonical = canonicalizeJson(data);
    if (canonical.length < CLAIM_CHECK_THRESHOLD) return data;
    this.pendingBlobs.push(this.blobs.put(Buffer.from(canonical, 'utf8')));
    return { blob: sha256Hex(canonical), size: canonical.length };
  }

  /** The barrier: pending burst → one frame, one write, one fsync. */
  flush(): Promise<void> {
    const next = this.flushChain.then(() => this.flushOnce());
    // Keep the chain alive after a rejection so later flushes still run; the
    // caller of this call still sees the original rejection.
    this.flushChain = next.catch(() => {});
    return next;
  }

  private async flushOnce(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    // A blob must be durable before the events that reference it.
    await Promise.all(this.pendingBlobs.splice(0));
    if (this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    const frame = encodeBatch(events.map((e) => canonicalizeJson(e as unknown as JsonValue)));
    await writeAll(this.log, frame);
    await this.log.sync();
    await this.writeHead();
  }

  private async writeHead(): Promise<void> {
    const head: Head = {
      first_hash: this.firstHash ?? GENESIS_HASH,
      last_hash: this.prevHash,
      count: this.seq,
      ts: this.now(),
    };
    // Atomic replace: a crash can leave the previous head, never a torn one.
    const tmp = `${this.headPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(head));
    await rename(tmp, this.headPath);
    await syncDir(this.dir);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    await this.forceClose();
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

async function syncDir(dir: string): Promise<void> {
  const handle = await openFile(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

function lockPathFor(dir: string): string {
  return join(dir, 'journal.v0.lock');
}

async function acquireLock(dir: string, nodeUid: string): Promise<void> {
  const lockPath = lockPathFor(dir);
  try {
    await writeFile(lockPath, String(process.pid), { flag: 'wx' });
    return;
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err;
  }
  if (await isLockHeldByLiveProcess(lockPath)) throw new SessionAlreadyOwnedError(nodeUid);
  // Stale lock: the previous owner is gone.
  await rm(lockPath, { force: true });
  try {
    await writeFile(lockPath, String(process.pid), { flag: 'wx' });
  } catch (err) {
    // Another writer won the race between the removal and this write.
    if (isErrno(err, 'EEXIST')) throw new SessionAlreadyOwnedError(nodeUid);
    throw err;
  }
}

async function isLockHeldByLiveProcess(lockPath: string): Promise<boolean> {
  const pid = Number((await readFile(lockPath, 'utf8')).trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours — still a live owner.
    return !isErrno(err, 'ESRCH');
  }
}

async function releaseLock(dir: string): Promise<void> {
  await rm(lockPathFor(dir), { force: true });
}