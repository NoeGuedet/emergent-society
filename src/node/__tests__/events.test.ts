import { describe, expect, it } from 'vitest';
import { JournalWriter } from '../../journal/index.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { collectEvents, useTempHome } from '../../journal/__tests__/helpers.js';

const home = useTempHome('node-events-');

describe('node event types', () => {
  it('registers exactly the seven driver types', () => {
    expect([...NODE_EVENT_TYPES].sort()).toEqual([
      'inbox/claim', 'message/received', 'message/sent',
      'node/boot', 'node/shutdown', 'turn/end', 'turn/start',
    ]);
  });

  it('round-trips a typed event through the writer and reader', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('turn/start', { turn: 0, trigger: 'boot' });
    w.append('message/received', {
      id: 'x/m1', from: 'x', kind: 'chat', wakeupRequested: false, body: 'hi',
    });
    await w.close();
    const events = await collectEvents(home(), NODE_EVENT_TYPES);
    expect(events.map((e) => e.type)).toEqual(['turn/start', 'message/received']);
    expect(events[0]?.data).toEqual({ turn: 0, trigger: 'boot' });
  });
});
