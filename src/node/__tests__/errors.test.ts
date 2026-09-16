import { describe, expect, it } from 'vitest';
import { Inbox } from '../inbox.js';
import {
  MessageTooLargeError, NodeAlreadyBootedError, NodeError, NodeStateError, UnknownNodeError,
} from '../errors.js';

describe('the node error family', () => {
  it('names itself off new.target', () => {
    expect(new UnknownNodeError('x').name).toBe('UnknownNodeError');
    expect(new NodeAlreadyBootedError('x').name).toBe('NodeAlreadyBootedError');
    expect(new NodeStateError('bad state').name).toBe('NodeStateError');
    expect(new MessageTooLargeError(1, 2).name).toBe('MessageTooLargeError');
  });

  it('is one catchable family', () => {
    expect(new UnknownNodeError('x')).toBeInstanceOf(NodeError);
    expect(new NodeStateError()).toBeInstanceOf(NodeError);
    expect(new MessageTooLargeError(20, 10)).toBeInstanceOf(Error);
  });

  it('carries the offending value', () => {
    expect(new UnknownNodeError('ghost').uid).toBe('ghost');
    expect(new NodeAlreadyBootedError('a').uid).toBe('a');
    expect(new MessageTooLargeError(20, 10)).toMatchObject({ bytes: 20, limit: 10 });
  });
});

describe('the inbox projection', () => {
  it('freezes messages on insert', () => {
    const inbox = new Inbox();
    inbox.apply({
      type: 'message/received',
      data: { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' },
    });
    // Without this, a dropped insert leaves pendingMessages() empty and
    // Object.isFrozen(undefined) === true would pass the test vacuously.
    expect(inbox.size).toBe(1);
    expect(Object.isFrozen(inbox.pendingMessages()[0])).toBe(true);
  });

  it('refuses an unresolved claim-check reference', () => {
    const inbox = new Inbox();
    expect(() => inbox.apply({
      type: 'message/received',
      data: { blob: 'ab'.repeat(32), size: 123 },
    })).toThrow(NodeStateError);
    expect(inbox.size).toBe(0);
  });

  it('still stores a message a blob-ref guard cannot mistake for a reference', () => {
    const inbox = new Inbox();
    inbox.apply({
      type: 'message/received',
      data: { id: 'a/m1', from: 'a', kind: 'chat', body: 'one', blob: 'ab'.repeat(32) },
    });
    // Same reason as the freeze test above: the message must actually be there.
    expect(inbox.size).toBe(1);
    expect(Object.isFrozen(inbox.pendingMessages()[0])).toBe(true);
  });
});