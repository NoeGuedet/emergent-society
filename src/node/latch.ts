/**
 * The wake latch: the coalescing signal from the world's watcher to a parked
 * loop. It is in-memory only — after a restart its state is reconstructed from
 * the journal: a node whose watermark is behind HEAD wakes on its first turn.
 */
export class WakeLatch {
  private requested = false;
  private waiter: (() => void) | null = null;

  /**
   * Arms the latch and releases any parked waiter.
   * @returns whether this call was the one that armed the latch — the
   * coalescence fact: several wakes landing before the loop looks again are one
   * turn, not one turn per wake.
   */
  request(): boolean {
    const first = !this.requested;
    this.requested = true;
    if (this.waiter !== null) {
      this.waiter();
      this.waiter = null;
    }
    return first;
  }

  /** Consumes a pending request at once, or parks until the next one. */
  async wait(): Promise<void> {
    if (this.requested) {
      this.requested = false;
      return;
    }
    await new Promise<void>((resolve) => { this.waiter = resolve; });
    this.requested = false;
  }

  /** Drops an unconsumed request, for a caller that learned of the world by another route. */
  clear(): void {
    this.requested = false;
  }
}
