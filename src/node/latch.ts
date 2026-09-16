/**
 * The wake latch: the coalescing signal from the transport to a parked loop.
 * It is in-memory only — after a restart its state is reconstructed (a node
 * whose journal ends on `waiting` with unclaimed mail wakes immediately).
 */
export class WakeLatch {
  private requested = false;
  private waiter: (() => void) | null = null;

  /**
   * Arms the latch and releases any parked waiter.
   * @returns whether this call was the one that armed the latch — the
   * coalescence fact the transport journals as `wakeupRequested`.
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

  /** Drops an unconsumed request (the loop observed the inbox directly). */
  clear(): void {
    this.requested = false;
  }
}
