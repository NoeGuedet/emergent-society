import type { WorldRepo } from './world.js';

/**
 * HEAD is re-read at this cadence while at least one node is parked on the
 * world. It costs a process spawn, never a token: a node waiting on an
 * unchanged world is silent, and the only price of the wait is this read.
 */
export const DEFAULT_POLL_MS = 250;

/**
 * The kernel's HEAD watcher (kernel.md §5.2): the one source of "the world may
 * have moved" for every node parked on a given world repo.
 *
 * It watches the world's git HEAD — HEAD, not the filesystem: no inotify, no
 * partial-write races, no missed events. HEAD moves exactly once per turn, at a
 * point the kernel controls, so there is nothing to debounce and no window in
 * which the world is half-observed. A commit made in this process is announced
 * at once (`poke`); a commit made outside it (the human's, another process's)
 * is caught by the interval.
 *
 * The watcher announces *movement*, not wakeups: whether a movement concerns a
 * given node is that node's predicate (HEAD advanced with a commit the node did
 * not author), evaluated by its listener. That is why one watcher can serve
 * every node of a world with different watermarks.
 */
export class HeadWatcher {
  /**
   * One watcher per world repo, keyed by its canonical root, kept for the life
   * of the process: the instance a driver subscribes to must be the instance
   * the committing driver pokes, or the in-process signal would be lost.
   */
  private static readonly instances = new Map<string, HeadWatcher>();

  /** The HEAD last announced; `undefined` until the first read. */
  private lastHead: string | null | undefined;
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private scheduled = false;

  private constructor(private readonly world: WorldRepo, private readonly pollMs: number) {}

  /**
   * The watcher of `world`. The first caller sets the cadence — the watcher is
   * one per repo, and its interval is a property of the world, not of a node.
   * `pollMs` 0 disables the interval (the in-process poke and an explicit
   * `check()` remain the only sources).
   */
  static for(world: WorldRepo, pollMs: number = DEFAULT_POLL_MS): HeadWatcher {
    const existing = HeadWatcher.instances.get(world.path);
    if (existing !== undefined) return existing;
    const watcher = new HeadWatcher(world, pollMs);
    HeadWatcher.instances.set(world.path, watcher);
    return watcher;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Registers a listener and returns its removal. The interval runs only while
   * something is parked: a kernel whose nodes are all working holds no timer.
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
   * Signals that a commit just landed in this process, so the other parked
   * nodes wake without waiting out the interval — a dialogue is alternating
   * commits, and the interval would otherwise be its latency. Coalesced:
   * several pokes before the read runs are one evaluation.
   */
  poke(): void {
    if (this.listeners.size === 0 || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.check();
    });
  }

  /**
   * Reads HEAD and notifies every listener if it moved since the last read.
   *
   * A failed read leaves the last announced HEAD in place and returns: the next
   * tick retries, so a transient git failure delays a wake instead of losing
   * it, and a timer callback has no caller to reject into.
   */
  async check(): Promise<void> {
    let head: string | null;
    try {
      head = await this.world.headHash();
    } catch {
      return;
    }
    if (head === this.lastHead) return;
    this.lastHead = head;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      // Listeners start an asynchronous evaluation and report their own
      // failures; a synchronous throw here must not cut the notification short
      // for the listeners after it.
      try { listener(); } catch { /* one listener cannot break the others */ }
    }
  }

  private startTimer(): void {
    if (this.timer !== null || this.pollMs <= 0) return;
    this.timer = setInterval(() => { void this.check(); }, this.pollMs);
    // A parked node's promise keeps nothing alive on its own; the kernel holds
    // the loop. The watcher must not be the handle that keeps the process up.
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
