import { statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { HUMAN_AUTHOR, isErrno } from '../journal/index.js';
import { NOOP } from '../util.js';
import { CHAT_FILE, parseChatLineOrNull } from './chat.js';

/**
 * The chat log's arrival signal: the overlay's second trigger.
 *
 * Mirrors `ConversationWatcher`: one instance per chat log, keyed on its path,
 * kept for the process lifetime; it watches the FILE'S SIZE (an append by any
 * process is a size change, a shrink — the host's boot repair — resets the
 * watermark), polls on the same 250 ms class with an unref'd interval that runs
 * only while something is subscribed, and `poke` lets an in-process append
 * schedule the same check without waiting out the interval.
 *
 * THE ACTOR FILTER is this watcher's own rule: a growth that contains at least
 * one `uid: human` record notifies the listeners; the overlay's OWN
 * `uid: gateway` deliveries grow the file but never re-trigger it (the echo
 * rule, exactly as its conversation sends never re-trigger the conversation
 * watcher). The appended region is read (bounded) and parsed to resolve the
 * actors, so the filter is a fact of the bytes, not of who called `poke`.
 * Cross-process arrivals (the future session's or `direct`'s writes) are caught
 * by the size poll.
 */

const DEFAULT_POLL_MS = 250;

/** The bound on one change's scanned region; older bytes are not re-scanned. */
const MAX_SCAN_BYTES = 64 * 1024;

export class ChatWatcher {
  private static readonly instances = new Map<string, ChatWatcher>();

  private readonly path: string;
  /** The log's size already examined; starts at the construction size. */
  private watermark: number;
  private checking: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private scheduled = false;

  private constructor(home: string, private readonly pollMs: number) {
    this.path = join(home, CHAT_FILE);
    this.watermark = bootSize(this.path);
  }

  /** The watcher of `home`; the first caller sets the cadence (one per log). */
  static for(home: string, pollMs: number = DEFAULT_POLL_MS): ChatWatcher {
    const key = join(home, CHAT_FILE);
    const existing = ChatWatcher.instances.get(key);
    if (existing !== undefined) return existing;
    const watcher = new ChatWatcher(home, pollMs);
    ChatWatcher.instances.set(key, watcher);
    return watcher;
  }

  /** How many listeners are subscribed — a test seam, not an API. */
  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** The chat log's path (the instance key). */
  get chatPath(): string {
    return this.path;
  }

  /**
   * Registers a listener and returns its removal. The interval runs only while
   * something is subscribed; the unref'd timer never decides a process's
   * lifetime.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.startTimer();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopTimer();
    };
  }

  /** Signals an in-process append so the check need not wait out the interval. */
  poke(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.check();
    });
  }

  /**
   * One size read and, when the log changed, one bounded actor read and (only
   * for a human record) one notification. Checks are serialized; a failed read
   * leaves the watermark in place so the next tick retries.
   */
  async check(): Promise<void> {
    const previous = this.checking ?? Promise.resolve();
    const next = previous.then(() => this.read(), () => this.read());
    this.checking = next.then(NOOP, NOOP);
    return next;
  }

  private async read(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) return;
      size = 0;
    }
    if (size === this.watermark) return;
    let human = false;
    if (size > this.watermark) {
      try {
        human = await this.humanRegion(this.watermark, size);
      } catch {
        // A failed read delays the notification; the watermark stays and the
        // next tick retries. A timer callback has no caller to reject into.
        return;
      }
    }
    // Grow or shrink: the watermark always follows the observed size, so a
    // shrink (the boot repair) is a reset, never a re-read of old bytes.
    this.watermark = size;
    // Only a HUMAN record is an arrival. The overlay's own uid:'gateway'
    // delivery grows the file and is silently absorbed here.
    if (human) this.notify();
  }

  /** Whether [start, end) holds at least one human record; degraded lines skipped. */
  private async humanRegion(start: number, end: number): Promise<boolean> {
    const from = Math.max(start, end - MAX_SCAN_BYTES);
    const position = from > 0 ? from - 1 : 0;
    const length = end - position;
    const buffer = Buffer.alloc(length);
    const handle = await open(this.path, 'r');
    let read = 0;
    try {
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
    } finally {
      await handle.close();
    }
    let text = buffer.subarray(0, read).toString('utf8');
    // A window that starts mid-record drops its leading fragment.
    if (from > 0) {
      if (buffer[0] === 0x0a) text = text.slice(1);
      else {
        const newline = text.indexOf('\n');
        text = newline === -1 ? '' : text.slice(newline + 1);
      }
    }
    const lines = text.split('\n');
    // The trailing segment is empty or a torn fragment: never a record.
    lines.pop();
    let human = false;
    for (const line of lines) {
      const record = parseChatLineOrNull(line);
      if (record !== null && record.uid === HUMAN_AUTHOR) human = true;
    }
    return human;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* one listener cannot break the others */ }
    }
  }

  private startTimer(): void {
    if (this.timer !== null || this.pollMs <= 0) return;
    this.timer = setInterval(() => { void this.check(); }, this.pollMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** The log's size at watcher construction: the boot watermark. */
function bootSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
