import { readFile, rm, truncate } from 'node:fs/promises';
import { scanBatches } from './framing.js';
import { readFileOrNull, syncPath } from './fsutil.js';
import { headPath, journalPath, nodeDir, parseHead, type Head } from './layout.js';
import { genesisState, verifyChain } from './verify.js';
import type { EventEnvelope } from './envelope.js';

/**
 * The read side of the journal: verification and crash repair.
 *
 * `events()` serves only the fully linked, `v`-matching prefix of a node's log
 * and refuses to rebuild past a break rather than guessing; the reader is
 * otherwise stateless and never mutates the log.
 */
export class JournalReader {
  private constructor(
    private readonly dir: string,
    private readonly known: ReadonlySet<string>,
  ) {}

  /**
   * Opens a reader over a node's journal.
   *
   * `knownTypes` is required: a reader that cannot say which event types it
   * understands cannot honour the "refuse to rebuild" rule, so there is no
   * correct default. (Deriving it from a runtime registry is C1.2 design.)
   *
   * @throws never — the log is read lazily by `events()`.
   */
  static async open(
    home: string, nodeUid: string, opts: { knownTypes: ReadonlySet<string> },
  ): Promise<JournalReader> {
    return new JournalReader(nodeDir(home, nodeUid), opts.knownTypes);
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
   * UnknownEventTypeError on an unknown non-ignorable type.
   */
  async *events(fromSeq = 0): AsyncGenerator<EventEnvelope> {
    // A missing log is an empty journal. Anything else (EACCES, EIO) must not
    // be mistaken for genesis, so readFileOrNull rethrows it.
    const raw = await readFileOrNull(journalPath(this.dir));
    if (raw === null) return;
    const { batches } = scanBatches(raw);
    for (const e of verifyChain(batches, this.known, genesisState())) {
      if (e.seq >= fromSeq) yield e;
    }
  }
}

/**
 * Discards a physically torn trailing fragment. The only destructive path.
 *
 * A free function, not a reader method: discarding a fragment is an explicit
 * operator action that runs *before* the writer opens (kernel.md §3), so it
 * needs no reader instance and can never happen as a side effect of reading.
 *
 * @throws CorruptFrameError on interior corruption — it refuses to truncate
 * through valid committed events; any other read error propagates.
 */
export async function repair(home: string, nodeUid: string): Promise<{ tornBytes: number }> {
  const dir = nodeDir(home, nodeUid);
  const path = journalPath(dir);
  const raw = await readFileOrNull(path);
  if (raw === null) return { tornBytes: 0 };
  // scanBatches throws CorruptFrameError on interior corruption: repair must
  // never truncate through valid committed events, so that error propagates
  // and nothing is deleted.
  const { tornBytes } = scanBatches(raw);
  if (tornBytes > 0) {
    await truncate(path, raw.length - tornBytes);
    // The truncation and its directory entry are both metadata changes, so both
    // are fsynced before the caller trusts the new length.
    await syncPath(path);
    await syncPath(dir);
    // The head checkpoint may now point past the truncation point; it is
    // disposable, so it is removed and rebuilt from the log on the next flush.
    await rm(headPath(dir), { force: true });
  }
  return { tornBytes };
}
