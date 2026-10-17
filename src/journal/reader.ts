import { readFile, rm, truncate } from 'node:fs/promises';
import {
  BlobStore, assertBlobRefReadable, isBlobRef, parseBlobJson, throwBlobReadError,
} from './blobs.js';
import { scanBatches } from './framing.js';
import { readFileOrNull, syncPath } from './fsutil.js';
import { headPath, journalPath, nodeDir, parseHead, type Head } from './layout.js';
import { acquireLock } from './lock.js';
import { genesisState, verifyChain } from './verify.js';
import type { EventEnvelope } from './envelope.js';

/** Options for `JournalReader.open`. */
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
 * `events()` serves only the fully linked, `v`-matching prefix of a node's log
 * and refuses to rebuild past a break rather than guessing; the reader is
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
    private readonly dir: string,
    private readonly known: ReadonlySet<string>,
    private readonly blobs: BlobStore | null,
  ) {}

  /**
   * Opens a reader over a node's journal.
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
    return new JournalReader(
      nodeDir(home, nodeUid), opts.knownTypes,
      opts.resolveBlobs === true ? new BlobStore(home) : null,
    );
  }

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
      raw = await readFile(headPath(this.dir), 'utf8');
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
   * non-v0 envelope or a malformed line; CorruptFrameError on interior damage;
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
    const raw = await readFileOrNull(journalPath(this.dir));
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
    if (this.blobs === null || !isBlobRef(e.data)) return e;
    const ref = e.data;
    // Refuse a flagged prefix *before* the read: resolution of a truncated
    // reference must stay TruncatedBlobError even if its blob file is gone.
    assertBlobRefReadable(ref);
    // The boundary's one verified-read mapping: a missing blob is an
    // unrecoverable integrity failure, not a transient environment error, while
    // an unreadable one (EACCES, EIO) keeps its own type.
    const bytes = await this.blobs.get(ref.blob)
      .catch((err: unknown) => throwBlobReadError(ref, err));
    return { ...e, data: parseBlobJson(ref, bytes) };
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
  const dir = nodeDir(home, nodeUid);
  const path = journalPath(dir);
  // Probe first: repairing a journal that does not exist must not create one.
  if ((await readFileOrNull(path)) === null) return { tornBytes: 0 };
  const ownership = await acquireLock(dir, nodeUid);
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
        await truncate(path, raw.length - tornBytes);
        // The truncation and its directory entry are both metadata changes, so
        // both are fsynced before the caller trusts the new length.
        await syncPath(path);
        await syncPath(dir);
        // The head checkpoint may now point past the truncation point; it is
        // disposable, so it is removed and rebuilt from the log on the next flush.
        await rm(headPath(dir), { force: true });
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
