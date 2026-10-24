import { expect, it } from 'vitest';
import { createHostLog } from '../observe.js';

it('writes one JSON object per line and cannot be overridden by a field named event', () => {
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  log.emit('host/boot', { home: '/x', model: 'm', sandbox: 'landlock' });
  log.emit('turn/start', { event: 'spoofed', turn: 0 });
  expect(JSON.parse(lines[0]!)).toEqual({ event: 'host/boot', home: '/x', model: 'm', sandbox: 'landlock' });
  expect(JSON.parse(lines[1]!).event).toBe('turn/start');
  expect(lines.every((l) => l.endsWith('\n') && l.indexOf('\n') === l.length - 1)).toBe(true);
});

it('caps at 11 fields and truncates strings to 200 code points, stripping control chars', () => {
  const fields = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
  const lines: string[] = []; createHostLog((l) => lines.push(l)).emit('host/boot', fields);
  expect(Object.keys(JSON.parse(lines[0]!))).toHaveLength(12); // event + 11
  const long = 'a'.repeat(250) + '\u0000\n';
  const out: string[] = []; createHostLog((l) => out.push(l)).emit('host/boot', { long });
  expect((JSON.parse(out[0]!).long as string)).toHaveLength(200);
  expect((JSON.parse(out[0]!).long as string)).not.toContain('\u0000');
});
