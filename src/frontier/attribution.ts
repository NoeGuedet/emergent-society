import { open, stat, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CorruptionError, JournalClosedError, assertNodeUid, frontierLayout, isErrno,
  readFileOrNull, syncPath,
} from '../journal/index.js';
import type { Frontier } from './journal.js';

/**
 * The frontier attribution sidecar — the actor the frozen frontier cannot carry.
 *
 * The frontier's vocabulary is node-blind by design: the envelope is frozen and
 * `http/request` can express no node, turn, provider or Package field. The one
 * fact the exchange record therefore cannot hold — which node began the
 * exchange — is kept beside it, in `<home>/frontier/attribution.v0.jsonl`
 * (0600, append-only, kernel-owned): one `{v: 0, call, uid}` line per begun
 * exchange.
 *
 * The line is written after the `http/request` event (and its body blob) is
 * durable and before the transport sends, so an exchange that happened always
 * has its line; a crash in that window leaves the request durable and its actor
 * unknown — an honest gap, never an attribution without an exchange. A failed
 * append refuses the exchange before the send, so an effect is never attributed
 * after the fact. A torn tail (a crash inside one append) is dropped at open:
 * the file holds complete lines only.
 *
 * The sidecar is a lookup record, not a second truth: the journal remains the
 * only truth about the exchanges themselves, and its envelope, event schema and
 * vocabulary are untouched.
 */

/** The sidecar's file name inside the frontier directory. */
export const ATTRIBUTION_FILE = 'attribution.v0.jsonl';

/** The record format version, frozen with v0. */
const RECORD_VERSION = 0;

/** The bound on a call id this reader accepts: the gate mints UUIDs. */
const MAX_CALL_CHARS = 128;

/** Damage to the attribution sidecar: its complete lines must parse and validate. */
export class AttributionCorruptionError extends CorruptionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** One attribution line: the exchange's call id and the node that began it. */
export type AttributionRecord = {
  readonly v: 0;
  readonly call: string;
  readonly uid: string;
};

/** What a gate view writes its attribution to; `AttributionLog` is the kernel's. */
export type AttributionSink = {
  append(call: string, uid: string): Promise<void>;
};

/**
 * The kernel's append-only attribution writer.
 *
 * One instance lives beside the frontier journal it attributes; its handle is
 * opened on the first append (a cell that never crosses the wire creates no
 * file), every append is an `O_APPEND` write followed by one `fsync`, and the
 * directory entry is made durable when the file is created. `close` is
 * idempotent; an append after it is a programming error.
 */
export class AttributionLog implements AttributionSink {
  private handle: FileHandle | null = null;
  /** The in-flight first open, shared by concurrent appends: one handle. */
  private opening: Promise<FileHandle> | null = null;
  private closed = false;

  private constructor(private readonly dir: string, private readonly path: string) {}

  /**
   * Opens the home's attribution file, dropping a torn trailing fragment left
   * by a crash inside one append. A missing file is a brand-new sidecar, not an
   * error; any other read or truncation failure propagates (a kernel-owned
   * record that cannot be read is a refused open, never a silent reset).
   */
  static async open(home: string): Promise<AttributionLog> {
    const dir = frontierLayout(home).dir;
    const path = join(dir, ATTRIBUTION_FILE);
    const raw = await readFileOrNull(path);
    if (raw !== null && raw.length > 0) {
      const complete = raw.lastIndexOf(0x0a) + 1;
      if (complete < raw.length) await truncate(path, complete);
    }
    return new AttributionLog(dir, path);
  }

  /** Appends one complete line and makes it durable before returning. */
  async append(call: string, uid: string): Promise<void> {
    if (this.closed) throw new JournalClosedError();
    const handle = await this.file();
    const line = JSON.stringify({ v: RECORD_VERSION, call, uid }) + '\n';
    await handle.write(line, null, 'utf8');
    await handle.sync();
  }

  /** Closes the handle; idempotent, and the file's bytes are already durable. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.handle === null) return;
    const handle = this.handle;
    this.handle = null;
    await handle.close();
  }

  private async file(): Promise<FileHandle> {
    if (this.handle !== null) return this.handle;
    if (this.opening === null) this.opening = this.openHandle();
    return this.opening;
  }

  private async openHandle(): Promise<FileHandle> {
    try {
      const created = !(await pathExists(this.path));
      const handle = await open(this.path, 'a', 0o600);
      try {
        if (created) await syncPath(this.dir);
      } catch (err) {
        await handle.close().catch(() => {});
        throw err;
      }
      // A close that won the race: the sidecar must not keep a live handle.
      if (this.closed) {
        await handle.close().catch(() => {});
        throw new JournalClosedError();
      }
      this.handle = handle;
      return handle;
    } finally {
      this.opening = null;
    }
  }
}

/**
 * The per-node view of the frontier gate: every begun exchange is attributed to
 * `uid` before the caller may send. The view is a decorator over the one gate,
 * so the frontier's own validation, durability and read-back are unchanged; a
 * failed attribution propagates and the exchange is refused before the send.
 */
export function attributeFrontier(
  frontier: Frontier, uid: string, sink: AttributionSink,
): Frontier {
  const actor = assertNodeUid(uid);
  return {
    begin: async (input) => {
      const call = await frontier.begin(input);
      await sink.append(call.call, actor);
      return call;
    },
    complete: (call, outcome) => frontier.complete(call, outcome),
  };
}

/**
 * Reads every complete attribution record in order. A missing file is an empty
 * list; a trailing fragment with no newline is dropped exactly as the open-time
 * repair would drop it; a malformed complete line is a typed refusal, never
 * skipped.
 */
export async function readAttribution(home: string): Promise<AttributionRecord[]> {
  const raw = await readFileOrNull(join(frontierLayout(home).dir, ATTRIBUTION_FILE));
  if (raw === null) return [];
  const text = raw.toString('utf8');
  const lines = text.split('\n');
  // Our writer always terminates a line, so the last segment is either empty
  // (complete file) or a torn fragment: drop it.
  lines.pop();
  return lines.map((line, index) => parseRecord(line, index));
}

function parseRecord(line: string, index: number): AttributionRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    throw new AttributionCorruptionError(`attribution record ${index + 1} is not JSON`, { cause: err });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AttributionCorruptionError(`attribution record ${index + 1} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'call,uid,v') {
    throw new AttributionCorruptionError(`attribution record ${index + 1} has an unknown shape`);
  }
  const call = record['call'];
  if (record['v'] !== RECORD_VERSION) {
    throw new AttributionCorruptionError(`attribution record ${index + 1} has an unknown version`);
  }
  if (typeof call !== 'string' || call.length === 0 || call.length > MAX_CALL_CHARS) {
    throw new AttributionCorruptionError(`attribution record ${index + 1} has an invalid call id`);
  }
  if (typeof record['uid'] !== 'string') {
    throw new AttributionCorruptionError(`attribution record ${index + 1} has an invalid uid`);
  }
  return { v: RECORD_VERSION, call, uid: assertNodeUid(record['uid']) };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}


