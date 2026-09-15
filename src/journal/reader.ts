import { readFile, rm, truncate } from 'node:fs/promises';
import { scanBatches } from './framing.js';
import { isErrno, syncDir, syncFile } from './fsutil.js';
import { headPath, journalPath, nodeDir, parseHead, type Head } from './layout.js';
import { genesisState, verifyChain } from './verify.js';
import type { EventEnvelope } from './envelope.js';

export { ChainBreakError } from './verify.js';

/**
 * The read side of the journal: verification and crash repair.
 *
 * `events()` serves only the fully linked, `v`-matching prefix of a node's log
 * and refuses to rebuild past a break rather than guessing; the reader is
 * otherwise stateless and never mutates the log. `repair()` is a free function
 * because discarding a torn trailing fragment is an explicit operator action
 * that runs *before* the writer opens (kernel.md §3), not something a reader
 * should decide on its own.
 */
export class JournalReader {
  private constructor(
    private readonly dir: string,
    private readonly known: ReadonlySet<string>,
  ) {}

  static async open(
    home: string, nodeUid: string, knownTypes: ReadonlySet<string>,
  ): Promise<JournalReader> {
    return new JournalReader(nodeDir(home, nodeUid), knownTypes);
  }

  async head(): Promise<Head | null> {
    // The head checkpoint is disposable: a missing, unreadable or malformed one
    // means "rebuild from the log", which is what events() does anyway.
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
   */
  async *events(fromSeq = 0): AsyncGenerator<EventEnvelope> {
    let raw: Buffer;
    try {
      raw = await readFile(journalPath(this.dir));
    } catch (err) {
      // A missing log is an empty journal. Anything else (EACCES, EIO) must not
      // be mistaken for genesis.
      if (isErrno(err, 'ENOENT')) return;
      throw err;
    }
    const { batches } = scanBatches(raw);
    for (const e of verifyChain(batches, this.known, genesisState())) {
      if (e.seq >= fromSeq) yield e;
    }
  }
}

/** Discards a physically torn trailing fragment. The only destructive path. */
export async function repair(home: string, nodeUid: string): Promise<{ tornBytes: number }> {
  const dir = nodeDir(home, nodeUid);
  const path = journalPath(dir);
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { tornBytes: 0 };
    throw err;
  }
  // scanBatches throws CorruptFrameError on interior corruption: repair must
  // never truncate through valid committed events, so that error propagates
  // and nothing is deleted.
  const { tornBytes } = scanBatches(raw);
  if (tornBytes > 0) {
    await truncate(path, raw.length - tornBytes);
    await syncFile(path);
    await syncDir(dir);
    // The head checkpoint may now point past the truncation point; it is
    // disposable, so it is removed and rebuilt from the log on the next flush.
    await rm(headPath(dir), { force: true });
  }
  return { tornBytes };
}
