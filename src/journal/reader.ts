import { readFile, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { BlobStore, isBlobRef, resolveBlobRef } from './blobs.js';
import { scanBatches } from './framing.js';
import { readFileOrNull, syncPath } from './fsutil.js';
import { assertLayoutNames, nodeLayout, parseHead, type Head, type JournalLayout } from './layout.js';
import { acquireLock } from './lock.js';
import { genesisState, verifyChain } from './verify.js';
import type { EventEnvelope } from './envelope.js';

/** Options for `JournalReader.open` and `JournalReader.openIn`. */
export interface JournalReaderOptions {
  knownTypes: ReadonlySet<string>;
  /**
   * Resolve claim-checked `data` references through the blob store, so a caller
   * replaying into projections sees the original payloads. Each resolved blob is
   * verified against the reference that names it — exact byte length, SHA-256
   * digest and JSON body — and a flagged truncated reference is refused. Defaults
   * to false: events are served raw, exactly as journaled.
   */
  resolveBlobs?: boolean;
}

/**
 * The read side of the journal: verification and crash repair.
 *
 * `events()` serves only the fully linked, `v`-matching prefix of a journal's
 * log and refuses to rebuild past a break rather than guessing; the reader is
 * otherwise stateless and never mutates the log.
 */
export class JournalReader {
  /**
   * Torn bytes reported by the most recent `events()` scan. Informational only:
   * `events()` still serves the verified prefix and stops at the tear. It lets a
   * concurrent reader of a live journal distinguish "the writer has not landed
   * the tail yet" from "the log ended cleanly".
   */
  private lastTornBytes = 0;

  private constructor(
    private readonly layout: JournalLayout,
    private readonly known: ReadonlySet<string>,
    private readonly blobs: BlobStore | null,
  ) {}

  /**
   * Opens a reader over a node's local log.
   *
   * `knownTypes` is required: a reader that cannot say which event types it
   * understands cannot honour the "refuse to rebuild" rule, so there is no
   * correct default. Registries compose per module — each module exports the
   * runtime set for its own event map (`NODE_EVENT_TYPES` for the node driver)
   * — and a caller passes the union of the types it can replay.
   *
   * @throws never — the log is read lazily by `events()`.
   */
  static async open(
    home: string, nodeUid: string, opts: JournalReaderOptions,
  ): Promise<JournalReader> {
    return JournalReader.openIn(nodeLayout(home, nodeUid), opts);
  }

  /**
   * Opens a reader over the journal a layout names.
   *
   * @throws InvalidJournalLayoutError when the layout's file names are unsafe
   * or not pairwise distinct; the log itself is read lazily by `events()`.
   */
  static async openIn(
    layout: JournalLayout, opts: JournalReaderOptions,
  ): Promise<JournalReader> {
    assertLayoutNames(layout);
    return new JournalReader(
      layout, opts.knownTypes,
      opts.resolveBlobs === true ? new BlobStore(layout.home) : null,
    );
  }

  private get logPath(): string { return join(this.layout.dir, this.layout.logFile); }
  private get headFilePath(): string { return join(this.layout.dir, this.layout.headFile); }

  /**
   * The torn trailing bytes seen by the last `events()` read attempt (0 before
   * the first attempt, when the log is missing, or when the scan threw). This
   * is a diagnostic, not a gate: it never changes which events are served.
   */
  tornBytes(): number {
    return this.lastTornBytes;
  }

  /**
   * Reads the chain checkpoint, or null when it is missing, unreadable or
   * malformed (the head is disposable and rebuilt from the log).
   *
   * @throws never — a bad head is reported as null, never thrown.
   */
  async head(): Promise<Head | null> {
    // The head checkpoint is disposable: a missing, unreadable or malformed one
    // means "rebuild from the log", which is what events() does anyway. Unlike
    // the log itself, no read error here is worth surfacing.
    let raw: string;
    try {
      raw = await readFile(this.headFilePath, 'utf8');
    } catch {
      return null;
    }
    return parseHead(raw);
  }

  /**
   * Verifies and yields events in order. Only the `v`-matching, fully linked
   * prefix is served; a torn tail is where iteration stops.
   *
   * @throws ChainBreakError on a broken link, a seq gap, a hash mismatch, a
   * non-v0 envelope, a non-canonical line or a malformed line; CorruptFrameError
   * on interior damage;
   * UnknownEventTypeError on an unknown non-ignorable type; with
   * `resolveBlobs`, TruncatedBlobError on a truncated reference,
   * BlobIntegrityError when the blob is missing or does not match its reference
   * (digest, length or a non-JSON body), and the blob store's own errors on an
   * unreadable blob.
   */
  async *events(fromSeq = 0): AsyncGenerator<EventEnvelope> {
    // Every read attempt starts from a clean slate: a log that vanished, or a
    // scan that throws, must not leave a prior attempt's torn tail on the
    // accessor. The field is only set again when a scan completes.
    this.lastTornBytes = 0;
    // A missing log is an empty journal. Anything else (EACCES, EIO) must not
    // be mistaken for genesis, so readFileOrNull rethrows it.
    const raw = await readFileOrNull(this.logPath);
    if (raw === null) return;
    const { batches, tornBytes } = scanBatches(raw);
    // Record the scan outcome before yielding: a caller iterating a live log
    // can see whether the prefix it just read ends in an in-flight write.
    this.lastTornBytes = tornBytes;
    for (const e of verifyChain(batches, this.known, genesisState())) {
      if (e.seq >= fromSeq) yield await this.resolveData(e);
    }
  }

  /**
   * Substitutes the original payload for a claim-check reference. Resolution
   * happens after verification: the chain always verifies the bytes exactly as
   * journaled, reference and all. The blob is read through the journal's one
   * verified path, so a flagged prefix, a digest or length mismatch, or a
   * non-JSON body is refused rather than served as the payload.
   */
  private async resolveData(e: EventEnvelope): Promise<EventEnvelope> {
    const blobs = this.blobs;
    if (blobs === null || !isBlobRef(e.data)) return e;
    const ref = e.data;
    // The shared verified read refuses a flagged prefix before the read, so a
    // truncated reference stays TruncatedBlobError even if its blob is gone.
    return { ...e, data: await resolveBlobRef(ref, (hash) => blobs.get(hash)) };
  }
}

/**
 * Discards a physically torn trailing fragment. The only destructive path.
 *
 * A free function, not a reader method: discarding a fragment is an explicit
 * operator action that runs *before* the writer opens (kernel.md §3), so it
 * needs no reader instance and can never happen as a side effect of reading.
 *
 * It takes exclusive ownership for the duration, so it can never truncate a log
 * a live writer is appending to; a live owner is refused. A journal that does
 * not exist is untouched (no directory or lock is created just to repair it).
 *
 * @throws SessionAlreadyOwnedError when a live writer owns the journal.
 * @throws JournalLockBusyError / JournalLockUnavailableError when the ownership
 * guard cannot run; the log is left untouched.
 * @throws CorruptFrameError on interior corruption — it refuses to truncate
 * through valid committed events; any other read error propagates.
 */
export async function repair(home: string, nodeUid: string): Promise<{ tornBytes: number }> {
  return repairIn(nodeLayout(home, nodeUid));
}

/**
 * The layout-explicit form of `repair`, for any journal (the frontier included).
 *
 * @throws InvalidJournalLayoutError when the layout's file names are unsafe or
 * not pairwise distinct; nothing is probed or truncated before that refusal.
 */
export async function repairIn(layout: JournalLayout): Promise<{ tornBytes: number }> {
  assertLayoutNames(layout);
  const { dir } = layout;
  const path = join(layout.dir, layout.logFile);
  const headFile = join(layout.dir, layout.headFile);
  // Probe first: repairing a journal that does not exist must not create one.
  if ((await readFileOrNull(path)) === null) return { tornBytes: 0 };
  const ownership = await acquireLock(layout);
  let result: { tornBytes: number } | undefined;
  let failed = false;
  let failure: unknown;
  try {
    // Read under ownership, so the length cannot change between scan and
    // truncate.
    const raw = await readFileOrNull(path);
    if (raw === null) {
      result = { tornBytes: 0 };
    } else {
      // scanBatches throws CorruptFrameError on interior corruption: repair must
      // never truncate through valid committed events, so that error propagates
      // and nothing is deleted.
      const { tornBytes } = scanBatches(raw);
      if (tornBytes > 0) {
        // Order matters: the stale head is removed and its unlink made durable
        // BEFORE the log is shortened. A crash at any point then leaves at
        // worst a torn tail that a later repair re-truncates — never a durable
        // head whose count points past a shorter, durable log. (Truncating
        // first would open a window where a crash resurrects the old head over
        // already-shortened bytes.)
        await rm(headFile, { force: true });
        // The unlink is a directory metadata change: without this sync a crash
        // can resurrect the removed head.
        await syncPath(dir);
        await truncate(path, raw.length - tornBytes);
        // The new length is file metadata, fsynced before the caller trusts it.
        await syncPath(path);
      }
      result = { tornBytes };
    }
  } catch (err) {
    failed = true;
    failure = err;
  }
  // The release always runs, but a body failure outranks a release failure: in a
  // plain `finally` a rejected release would replace the original error, hiding
  // the CorruptFrameError that tells the operator to inspect instead of retry.
  // A release failure on an otherwise successful body still propagates.
  try {
    await ownership.release();
  } catch (err) {
    if (!failed) {
      failed = true;
      failure = err;
    }
  }
  if (failed) throw failure;
  return result!;
}
