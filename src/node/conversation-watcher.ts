import { statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { GATEWAY_ADDRESSEE, isErrno } from '../journal/index.js';
import { NOOP } from '../util.js';
import {
  CONVERSATION_FILE, DEFAULT_THREAD_READ, parseConversationLineOrNull, readConversationThread,
} from './conversation.js';

/**
 * The conversation watcher (the interface's arrival signal): one per cell
 * home, keyed on the conversation stream's path, kept for the process
 * lifetime like `HeadWatcher`.
 *
 * It watches the FILE'S SIZE, not mtime and not a HEAD condition: an append by
 * any process is a size change, a shrink (the host's boot repair, or a
 * truncation) resets the watermark, and no reader ever sees a half-written
 * record because the tail read drops its torn fragment. The interval runs only
 * while something is subscribed (a parked driver, or the overlay's own
 * host-side subscription); an in-process append calls `poke`, which schedules
 * the same size check without waiting out the interval — never a detour of
 * `HeadWatcher`'s HEAD-conditioned path.
 *
 * The watcher also owns the per-recipient PENDING NOTICE — the notification
 * that is NOT a tool. On every change it reads the appended region (bounded),
 * resolves each new record's `to`, and arms that recipient's notice: a count
 * and the newest sender. The notice is cleared by the runtime only after the
 * record rendered into a request the kernel actually sent; a booted node's
 * notice arms from its thread's bounded tail (`armBoot`), never from the whole
 * history. A record whose `to` names an absent recipient (a departed node, or
 * the gateway before the overlay exists) arms a notice no driver reads: the
 * record waits honestly in the stream.
 */

const DEFAULT_POLL_MS = 250;

/** The bound on one change's armed region; older bytes are not re-scanned. */
const MAX_ARM_SCAN_BYTES = 64 * 1024;

/** One pending notice: how many arrived, the newest sender, and a version. */
export type ConversationNotice = {
  readonly count: number;
  /** The newest addressed record's sender. */
  readonly newestFrom: string;
  /** Monotonic per recipient: a wake fires once per version. */
  readonly version: number;
};

/** What a driver needs from the watcher; the runtime needs `noticeFor`/`consume` too. */
export type ConversationSource = {
  subscribe(listener: () => void): () => void;
  noticeFor(uid: string): ConversationNotice | null;
  armBoot(uid: string, n?: number): Promise<void>;
};

/** The runtime's read-and-clear seam over the pending notice. */
export type ConversationNoticeSource = {
  current(): ConversationNotice | null;
  consume(version: number): void;
};

type Pending = { count: number; newestFrom: string; version: number };

export class ConversationWatcher {
  /**
   * One watcher per conversation stream, kept for the process lifetime: the
   * instance a driver subscribes to must be the instance the host's append
   * pokes, or the in-process arrival would be lost (the HeadWatcher retention
   * argument, identical).
   */
  private static readonly instances = new Map<string, ConversationWatcher>();

  private readonly path: string;
  private readonly pending = new Map<string, Pending>();
  /** The stream size already examined; starts at the boot size. */
  private watermark: number;
  private version = 0;
  /**
   * How many gateway-addressed records this watcher has observed. The gateway
   * is not a node recipient (its records arm no node notice), so its arrivals
   * are counted here instead: the overlay's host-side subscription compares
   * this count across notifications and cycles only when it grew — the
   * addressee filter, applied where the records are resolved.
   */
  private gatewayArrivals = 0;
  private checking: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private scheduled = false;
  /**
   * Which addressees are live recipients. The host installs its roster; an
   * absent (departed, never-composed) uid is never armed, so the stream's
   * record for it waits with NO notice, exactly as the interface's rule says.
   * Unset means "arm every node addressee" (the library composition: no
   * process reads the notice, so it is inert either way).
   */
  private recipientFilter: ((uid: string) => boolean) | null = null;

  private constructor(
    private readonly home: string, private readonly pollMs: number,
  ) {
    this.path = join(home, CONVERSATION_FILE);
    this.watermark = bootSize(this.path);
  }

  /**
   * The watcher of `home`. The first caller sets the cadence (one per stream,
   * the interval is a property of the stream); `pollMs` 0 disables the
   * interval and leaves `poke`/`check` as the only sources.
   */
  static for(home: string, pollMs: number = DEFAULT_POLL_MS): ConversationWatcher {
    const key = join(home, CONVERSATION_FILE);
    const existing = ConversationWatcher.instances.get(key);
    if (existing !== undefined) return existing;
    const watcher = new ConversationWatcher(home, pollMs);
    ConversationWatcher.instances.set(key, watcher);
    return watcher;
  }

  /** How many listeners are subscribed — a test seam, not an API. */
  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** The stream's path (the instance key). */
  get streamPath(): string {
    return this.path;
  }

  /**
   * Installs the live-recipient predicate (the host's roster). A null filter
   * restores "arm every node addressee". Never retroactive: already-armed
   * notices are left to their recipients' own consume.
   */
  setRecipientFilter(filter: ((uid: string) => boolean) | null): void {
    this.recipientFilter = filter;
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

  /**
   * Signals an append in this process (the host's port calls it after a write),
   * so a parked recipient wakes without waiting out the interval. Unlike
   * `HeadWatcher.poke` it does NOT return early with no subscribers: the same
   * check also ARMS the pending notices, which matters while every recipient is
   * running (a running node reads the notice on its next assembled request).
   */
  poke(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.check();
    });
  }

  /**
   * One size read and, when the stream changed, one bounded arm + one
   * notification. Checks are serialized (the interval's tick and a poke's
   * cannot both announce one change); a failed read leaves the watermark in
   * place so the next tick retries instead of losing an arrival.
   */
  async check(): Promise<void> {
    const previous = this.checking ?? Promise.resolve();
    const next = previous.then(() => this.read(), () => this.read());
    this.checking = next.then(NOOP, NOOP);
    return next;
  }

  /**
   * The gateway-addressed records observed so far (monotonic). The overlay's
   * trigger: a notification whose count did not grow is not an arrival.
   */
  gatewayArrivalCount(): number {
    return this.gatewayArrivals;
  }

  /** The pending notice for `uid`, or null. */
  noticeFor(uid: string): ConversationNotice | null {
    const pending = this.pending.get(uid);
    if (pending === undefined) return null;
    return { count: pending.count, newestFrom: pending.newestFrom, version: pending.version };
  }

  /** Clears a notice iff it is still the one that was rendered (version-token). */
  consume(uid: string, version: number): void {
    const pending = this.pending.get(uid);
    if (pending !== undefined && pending.version === version) this.pending.delete(uid);
  }

  /**
   * The boot rule: a node booting with unread mail arms a notice from its
   * thread's bounded tail (the last n records, never the history), at the cost
   * of one possibly-redundant consult when everything was already read.
   */
  async armBoot(uid: string, n: number = DEFAULT_THREAD_READ): Promise<void> {
    const thread = await readConversationThread(this.home, uid, n);
    for (const record of thread.records) {
      if (record.to === uid) this.arm(uid, record.from);
    }
  }

  private arm(uid: string, from: string): void {
    if (this.recipientFilter !== null && !this.recipientFilter(uid)) return;
    const previous = this.pending.get(uid);
    this.version += 1;
    this.pending.set(uid, {
      count: (previous?.count ?? 0) + 1,
      newestFrom: from,
      version: this.version,
    });
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
    if (size > this.watermark) {
      try {
        await this.armRegion(this.watermark, size);
      } catch {
        // A failed read delays the arming; the watermark stays where it was and
        // the next tick retries. A timer callback has no caller to reject into.
        return;
      }
    }
    // Grow or shrink: the watermark always follows the observed size, so a
    // shrink (the boot repair) is a reset, never a re-read of old bytes.
    this.watermark = size;
    this.notify();
  }

  /** Arms every recipient addressed in [start, end); a degraded line is skipped. */
  private async armRegion(start: number, end: number): Promise<void> {
    const from = Math.max(start, end - MAX_ARM_SCAN_BYTES);
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
    if (from > 0) {
      if (buffer[0] === 0x0a) text = text.slice(1);
      else {
        const newline = text.indexOf('\n');
        text = newline === -1 ? '' : text.slice(newline + 1);
      }
    }
    const lines = text.split('\n');
    // The trailing segment is either empty or a torn fragment: never a record.
    lines.pop();
    for (const line of lines) {
      const record = parseConversationLineOrNull(line);
      if (record === null) continue;
      // The gateway and the human are not node recipients; a record addressed
      // to them waits in the stream (the absent-recipient rule). A
      // gateway-addressed record is the OVERLAY's arrival instead: counted, so
      // its host-side subscription can filter on it (the overlay's own sends
      // name a node addressee and are never counted, so they never re-trigger).
      if (record.to === GATEWAY_ADDRESSEE) {
        if (record.from !== GATEWAY_ADDRESSEE) this.gatewayArrivals += 1;
        continue;
      }
      if (record.to === record.from) continue;
      this.arm(record.to, record.from);
    }
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

/** The stream's size at watcher construction: the boot watermark. */
function bootSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
