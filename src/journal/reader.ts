import { open as openFile, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { FORMAT_VERSION, GENESIS_HASH, assertKnownType, verifyEvent, type EventEnvelope } from './envelope.js';
import { decodeBatch, scanBatches } from './framing.js';
import type { Head } from './writer.js';

export class ChainBreakError extends Error {
  constructor(public readonly seq: number, reason: string) {
    super(`hash chain broken at seq ${seq}: ${reason}`);
    this.name = 'ChainBreakError';
  }
}

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
    try {
      return JSON.parse(await readFile(join(this.dir, 'journal.v0.head'), 'utf8')) as Head;
    } catch {
      // The head checkpoint is disposable: a missing one means "rebuild from
      // the log", which is what events() does anyway.
      return null;
    }
  }

  /**
   * Verifies and yields events in order. Only the `v`-matching, fully linked
   * prefix is served; a torn tail is where iteration stops.
   */
  async *events(fromSeq = 0): AsyncGenerator<EventEnvelope> {
    let raw: Buffer;
    try { raw = await readFile(this.logPath); } catch { return; }
    const { batches } = scanBatches(raw);
    let prevHash = GENESIS_HASH;
    let expectedSeq = 0;
    for (const frame of batches) {
      for (const line of decodeBatch(frame)) {
        const e = JSON.parse(line) as EventEnvelope;
        // A format change (v: 1) is a different file, never an in-place
        // mutation, so a v-mismatch means the reader must refuse to rebuild.
        if (e.v !== FORMAT_VERSION) {
          throw new ChainBreakError(e.seq, `unsupported format version ${e.v}`);
        }
        if (e.seq !== expectedSeq) throw new ChainBreakError(e.seq, `expected seq ${expectedSeq}`);
        if (e.prev_hash !== prevHash) throw new ChainBreakError(e.seq, 'prev_hash mismatch');
        if (!verifyEvent(e)) throw new ChainBreakError(e.seq, 'hash recomputation failed');
        assertKnownType(e.type, e.ignorable ?? false, this.known);
        prevHash = e.hash;
        expectedSeq += 1;
        if (e.seq >= fromSeq) yield e;
      }
    }
  }
}

/** Discards a physically torn trailing fragment. The only destructive path. */
export async function repair(home: string, nodeUid: string): Promise<{ tornBytes: number }> {
  const path = join(home, 'nodes', nodeUid, 'journal.v0.jsonl.zstd');
  let raw: Buffer;
  try { raw = await readFile(path); } catch { return { tornBytes: 0 }; }
  const { tornBytes } = scanBatches(raw);
  if (tornBytes > 0) {
    await truncate(path, raw.length - tornBytes);
    const handle = await openFile(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return { tornBytes };
}