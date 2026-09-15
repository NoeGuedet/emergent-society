import { readFile, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { scanBatches } from './framing.js';
import { isErrno, syncDir, syncFile } from './fsutil.js';
import { HEAD_FILE, type Head } from './head.js';
import { HASH_RE, genesisState, verifyChain } from './verify.js';
import type { EventEnvelope } from './envelope.js';

export { ChainBreakError } from './verify.js';

/** Read-only. The reader never repairs on its own: repair() is explicit. */
export class JournalReader {
  private constructor(
    private readonly dir: string,
    private readonly known: ReadonlySet<string>,
  ) {}

  static async open(
    home: string, nodeUid: string, knownTypes: ReadonlySet<string>,
  ): Promise<JournalReader> {
    return new JournalReader(join(home, 'nodes', nodeUid), knownTypes);
  }

  private get logPath(): string { return join(this.dir, 'journal.v0.jsonl.zstd'); }

  async head(): Promise<Head | null> {
    // The head checkpoint is disposable: a missing, unreadable or malformed one
    // means "rebuild from the log", which is what events() does anyway.
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.dir, HEAD_FILE), 'utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const h = parsed as Record<string, unknown>;
    if (typeof h['first_hash'] !== 'string' || !HASH_RE.test(h['first_hash'])) return null;
    if (typeof h['last_hash'] !== 'string' || !HASH_RE.test(h['last_hash'])) return null;
    if (!Number.isSafeInteger(h['count']) || (h['count'] as number) < 0) return null;
    if (typeof h['ts'] !== 'number' || !Number.isFinite(h['ts'])) return null;
    return h as unknown as Head;
  }

  /**
   * Verifies and yields events in order. Only the `v`-matching, fully linked
   * prefix is served; a torn tail is where iteration stops.
   */
  async *events(fromSeq = 0): AsyncGenerator<EventEnvelope> {
    let raw: Buffer;
    try {
      raw = await readFile(this.logPath);
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
  const dir = join(home, 'nodes', nodeUid);
  const path = join(dir, 'journal.v0.jsonl.zstd');
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
    await rm(join(dir, HEAD_FILE), { force: true });
  }
  return { tornBytes };
}
