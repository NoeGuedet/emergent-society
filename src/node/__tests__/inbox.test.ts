import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../journal/index.js';
import { Inbox } from '../inbox.js';

function env(type: string, data: unknown, seq = 1): EventEnvelope {
  return { v: 0, type, seq, time: 1, prev_hash: '', hash: '', data } as EventEnvelope;
}

describe('Inbox', () => {
  it('queues received messages in arrival order until claimed', () => {
    const inbox = new Inbox();
    inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }, 1));
    inbox.apply(env('message/received', { id: 'a/m2', from: 'a', kind: 'chat', body: 'two' }, 2));
    expect(inbox.size).toBe(2);
    expect(inbox.pendingMessages().map((m) => m.id)).toEqual(['a/m1', 'a/m2']);
    inbox.apply(env('inbox/claim', { turn: 0, messages: ['a/m1', 'a/m2'] }, 3));
    expect(inbox.size).toBe(0);
  });

  it('is idempotent by message id', () => {
    const inbox = new Inbox();
    inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }));
    inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }));
    expect(inbox.size).toBe(1);
  });

  it('ignores events that are not its own', () => {
    const inbox = new Inbox();
    inbox.apply(env('turn/start', { turn: 0, trigger: 'boot' }));
    expect(inbox.size).toBe(0);
  });

  it('keeps replyTo when present', () => {
    const inbox = new Inbox();
    inbox.apply(env('message/received', {
      id: 'a/m2', from: 'a', kind: 'answer', body: '42', replyTo: 'n1/m1',
    }));
    expect(inbox.pendingMessages()[0]).toEqual({
      id: 'a/m2', from: 'a', kind: 'answer', body: '42', replyTo: 'n1/m1',
    });
  });
});
