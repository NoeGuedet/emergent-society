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

it('caps an invalid event at the same absolute field budget and names it host/log-error', () => {
  const fields = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  expect(() => log.emit('Turn/Start', fields)).not.toThrow();
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.event).toBe('host/log-error');
  expect(parsed.error).toBe('invalid-event');
  // The substituted `error` field counts against the same 11, so the line is
  // still at most 12 keys (event + 11) rather than 13.
  expect(Object.keys(parsed)).toHaveLength(12);
  expect(lines[0]!.endsWith('\n')).toBe(true);
  expect(lines[0]!.indexOf('\n')).toBe(lines[0]!.length - 1);
});

it('keeps the canonical error value when an invalid event carries its own error field', () => {
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  log.emit('NOPE', { error: 'spoofed', turn: 0 });
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.event).toBe('host/log-error');
  expect(parsed.error).toBe('invalid-event');
  expect(parsed.turn).toBe(0);
  expect(Object.keys(parsed)).toHaveLength(3);
});

it('never lets a throwing sink fail the emit', () => {
  const log = createHostLog(() => { throw new Error('sink'); });
  expect(() => log.emit('host/boot', { turn: 0 })).not.toThrow();
});
