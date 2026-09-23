import { describe, expect, it } from 'vitest';
import * as node from '../index.js';
import {
  NODE_EVENT_TYPES, NodeDriver, UnsafeWorldPathError, WorldRepo,
  type ShutdownReason, type TurnEndOutcome,
} from '../index.js';

describe('the node public surface', () => {
  it('exposes the driver, the world repo and the event registry', () => {
    expect(typeof NodeDriver.open).toBe('function');
    expect(typeof WorldRepo.open).toBe('function');
    expect(typeof WorldRepo.init).toBe('function');
    expect(UnsafeWorldPathError.prototype).toBeInstanceOf(Error);
    expect(NODE_EVENT_TYPES).toBeInstanceOf(Set);
  });

  it('names the vocabulary its public methods take', () => {
    // Type-level: `stop()` takes a ShutdownReason and a closer carries a
    // TurnEndOutcome, so both belong to the surface a caller can name.
    const reason: ShutdownReason = 'stop-requested';
    const outcome: TurnEndOutcome = 'waiting';
    expect([reason, outcome]).toEqual(['stop-requested', 'waiting']);
  });

  it('keeps the implementation details out of the namespace', () => {
    // The latch and the HEAD watcher are internals the driver owns and may
    // change; the public surface deliberately does not name them (index.ts).
    expect('WakeLatch' in node).toBe(false);
    expect('HeadWatcher' in node).toBe(false);
  });

  it('names no transport', () => {
    // Retired by kernel.md §5.1: the world is the filesystem, so there is no
    // hub, no inbox and no message to mint an id for.
    expect('Hub' in node).toBe(false);
    expect('Inbox' in node).toBe(false);
    expect('messageId' in node).toBe(false);
  });
});
