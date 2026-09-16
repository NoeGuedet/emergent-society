import { describe, expect, it } from 'vitest';
import {
  Hub, NODE_EVENT_TYPES, NodeDriver, UnknownNodeError, messageId,
} from '../index.js';

describe('the node public surface', () => {
  it('exposes the driver, the hub, the event registry and message minting', () => {
    expect(typeof NodeDriver.open).toBe('function');
    expect(typeof Hub).toBe('function');
    expect(UnknownNodeError.prototype).toBeInstanceOf(Error);
    expect(NODE_EVENT_TYPES.size).toBe(8);
    expect(messageId('a', 1)).toBe('a/m1');
  });
});
