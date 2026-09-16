import { describe, expect, it } from 'vitest';
import { messageId } from '../message.js';

describe('messageId', () => {
  it('is deterministic per sender and sequence', () => {
    expect(messageId('alice', 1)).toBe('alice/m1');
    expect(messageId('alice', 2)).toBe('alice/m2');
    expect(messageId('bob', 1)).toBe('bob/m1');
  });
});
