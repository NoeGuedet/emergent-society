import { describe, expect, it } from 'vitest';
import { JournalWriter } from '../../journal/index.js';
import { collectEvents, useTempHome } from '../../journal/__tests__/helpers.js';
import { NODE_EVENT_TYPES } from '../events.js';

const home = useTempHome('node-events-');

describe('node event types', () => {
  it('registers exactly the four driver types', () => {
    expect([...NODE_EVENT_TYPES].sort()).toEqual([
      'node/boot', 'node/shutdown', 'turn/end', 'turn/start',
    ]);
  });

  it('carries no message vocabulary', () => {
    // The transport is retired (kernel.md §5.1): no `message/*` type survives,
    // because a node communicates by writing files in the world.
    expect([...NODE_EVENT_TYPES].filter((type) => type.startsWith('message/'))).toEqual([]);
  });

  it('round-trips a typed event through the writer and reader', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
    w.append('turn/end', { turn: 0, outcome: 'waiting' }, { ignorable: true });
    await w.close();
    const events = await collectEvents(home(), NODE_EVENT_TYPES);
    expect(events.map((e) => e.type)).toEqual(['turn/start', 'turn/end']);
    expect(events[0]?.data).toEqual({ turn: 0, trigger: 'boot', world: { from: null, to: null } });
    expect(events[1]?.ignorable).toBe(true);
  });
});
