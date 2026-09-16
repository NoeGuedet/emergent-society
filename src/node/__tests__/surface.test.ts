import { describe, expect, it } from 'vitest';
import * as node from '../index.js';
import {
  Hub, NODE_EVENT_TYPES, NodeDriver, UnknownNodeError, messageId,
} from '../index.js';

describe('the node public surface', () => {
  it('exposes the driver, the hub, the event registry and message minting', () => {
    expect(typeof NodeDriver.open).toBe('function');
    expect(typeof Hub).toBe('function');
    expect(UnknownNodeError.prototype).toBeInstanceOf(Error);
    expect(NODE_EVENT_TYPES).toBeInstanceOf(Set);
    expect(typeof messageId).toBe('function');
  });

  it('keeps the implementation details out of the namespace', () => {
    // Inbox and WakeLatch are internals the driver owns and may change; the
    // public surface deliberately does not name them (index.ts).
    expect('Inbox' in node).toBe(false);
    expect('WakeLatch' in node).toBe(false);
  });
});
