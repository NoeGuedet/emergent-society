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

  it('consumes a claim when the turn ends chained or waiting', () => {
    for (const outcome of ['chained', 'waiting'] as const) {
      const inbox = new Inbox();
      inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }));
      inbox.apply(env('inbox/claim', { turn: 0, messages: ['a/m1'] }));
      inbox.apply(env('turn/end', { turn: 0, outcome }));
      expect(inbox.size).toBe(0);
      expect(inbox.pendingMessages()).toEqual([]);
    }
  });

  it('re-presents the claimed messages when the turn is interrupted', () => {
    const inbox = new Inbox();
    inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }));
    inbox.apply(env('message/received', { id: 'a/m2', from: 'a', kind: 'chat', body: 'two' }));
    inbox.apply(env('inbox/claim', { turn: 0, messages: ['a/m2', 'a/m1'] }));
    expect(inbox.size).toBe(0);
    inbox.apply(env('turn/end', { turn: 0, outcome: 'interrupted', synthetic: true }));
    // Claim order, not arrival order: the release restores what the turn held.
    expect(inbox.pendingMessages().map((m) => m.id)).toEqual(['a/m2', 'a/m1']);
  });

  it('re-presents the claimed messages when the turn errors', () => {
    const inbox = new Inbox();
    inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }));
    inbox.apply(env('inbox/claim', { turn: 3, messages: ['a/m1'] }));
    inbox.apply(env('turn/end', { turn: 3, outcome: 'error', error: 'boom' }));
    expect(inbox.pendingMessages().map((m) => m.id)).toEqual(['a/m1']);
  });

  it('releases the frozen message itself, not a copy', () => {
    const inbox = new Inbox();
    inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }));
    const delivered = inbox.pendingMessages()[0];
    inbox.apply(env('inbox/claim', { turn: 0, messages: ['a/m1'] }));
    inbox.apply(env('turn/end', { turn: 0, outcome: 'interrupted', synthetic: true }));
    const released = inbox.pendingMessages()[0];
    expect(released).toBe(delivered);
    expect(Object.isFrozen(released)).toBe(true);
  });

  it('re-presents a released message before a later arrival, preserving the tail policy', () => {
    const inbox = new Inbox();
    inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }));
    inbox.apply(env('inbox/claim', { turn: 0, messages: ['a/m1'] }));
    inbox.apply(env('message/received', { id: 'a/m2', from: 'a', kind: 'chat', body: 'two' }));
    inbox.apply(env('turn/end', { turn: 0, outcome: 'interrupted', synthetic: true }));
    expect(inbox.pendingMessages().map((m) => m.id)).toEqual(['a/m2', 'a/m1']);
  });

  it('leaves no release state behind for a turn that ended before the next claim', () => {
    const inbox = new Inbox();
    inbox.apply(env('message/received', { id: 'a/m1', from: 'a', kind: 'chat', body: 'one' }));
    inbox.apply(env('inbox/claim', { turn: 0, messages: ['a/m1'] }));
    inbox.apply(env('turn/end', { turn: 0, outcome: 'chained' }));
    inbox.apply(env('message/received', { id: 'a/m2', from: 'a', kind: 'chat', body: 'two' }));
    inbox.apply(env('inbox/claim', { turn: 1, messages: ['a/m2'] }));
    inbox.apply(env('turn/end', { turn: 1, outcome: 'waiting' }));
    expect(inbox.size).toBe(0);
  });

  it('ignores a turn/end for a turn that claimed nothing', () => {
    const inbox = new Inbox();
    inbox.apply(env('turn/end', { turn: 7, outcome: 'interrupted', synthetic: true }));
    expect(inbox.size).toBe(0);
  });
});
