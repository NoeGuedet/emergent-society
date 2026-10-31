import { open, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JournalClosedError, assertNodeUid, isErrno, readFileOrNull, syncPath,
} from '../journal/index.js';
import { MAX_SPEAK_BYTES } from '../node/tools/extend.js';

/**
 * The agent-zero chat log: the human channel's delivery surface, outside the
 * world.
 *
 * The channel is the one sanctioned exception to "communication is a file"
 * (the human has no file to read). It is a projection of the frontier, not a
 * third record: `speak` is an ordinary kernel-mediated tool call, so the
 * message's exact bytes are already durable in the frontier response body
 * before the effect; this file is the human-facing rendering of those calls
 * (one line per message), owned by the kernel, mode 0600, append-only, and
 * rebuildable from the frontier. A torn tail from a crash inside one append is
 * dropped at open, exactly like the attribution sidecar's.
 */

/** The chat log's file name inside the cell home. */
export const CHAT_FILE = 'chat.v0.jsonl';

/** One delivered message. */
export type ChatMessage = {
  readonly v: 0;
  readonly at: number;
  readonly uid: string;
  readonly text: string;
};

/**
 * The kernel's append-only chat writer. The handle is opened on the first
 * message; every append is one `O_APPEND` write followed by one `fsync`, and
 * the directory entry is made durable when the file is created.
 */
export class ChatLog {
  private handle: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;
  private closed = false;

  private constructor(private readonly dir: string, private readonly path: string) {}

  /** Opens the home's chat log, dropping a torn trailing fragment. */
  static async open(home: string): Promise<ChatLog> {
    const path = join(home, CHAT_FILE);
    const raw = await readFileOrNull(path);
    if (raw !== null && raw.length > 0) {
      const complete = raw.lastIndexOf(0x0a) + 1;
      if (complete < raw.length) await truncate(path, complete);
    }
    return new ChatLog(home, path);
  }

  /** Appends one message and makes it durable before returning. */
  async append(uid: string, text: string, at: number): Promise<void> {
    if (this.closed) throw new JournalClosedError();
    const actor = assertNodeUid(uid);
    if (text.trim() === '') throw new Error('a spoken message cannot be blank');
    if (Buffer.byteLength(text, 'utf8') > MAX_SPEAK_BYTES) {
      throw new Error(`a spoken message cannot exceed ${MAX_SPEAK_BYTES} bytes`);
    }
    const handle = await this.file();
    const line = JSON.stringify({ v: 0, at, uid: actor, text }) + '\n';
    await handle.write(line, null, 'utf8');
    await handle.sync();
  }

  /** Closes the handle; idempotent, the bytes are already durable. */
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

/** Reads every complete chat line in order; a missing file is an empty chat. */
export async function readChat(home: string): Promise<ChatMessage[]> {
  const raw = await readFileOrNull(join(home, CHAT_FILE));
  if (raw === null) return [];
  const lines = raw.toString('utf8').split('\n');
  // Our writer always terminates a line; the last segment is empty or torn.
  lines.pop();
  return lines.map((line, index) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) {
      throw new Error(`chat record ${index + 1} is not an object`);
    }
    const record = value as Record<string, unknown>;
    if (record['v'] !== 0 || typeof record['at'] !== 'number'
      || typeof record['uid'] !== 'string' || typeof record['text'] !== 'string') {
      throw new Error(`chat record ${index + 1} has an invalid shape`);
    }
    return { v: 0, at: record['at'], uid: record['uid'], text: record['text'] };
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await open(path, 'r').then((handle) => handle.close());
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}
