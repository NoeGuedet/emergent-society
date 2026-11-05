import { expect, it } from 'vitest';
import { probeUnit, stopUnit } from '../cockpit/unit.js';

it('treats not-found as free, loaded as busy and probe failure as unknown', async () => {
  expect(await probeUnit('es-x', {
    runSystemctl: async () => 'LoadState=not-found\nActiveState=inactive\nSubState=dead\n',
  })).toMatchObject({ state: 'absent' });
  expect(await probeUnit('es-x', {
    runSystemctl: async () => 'LoadState=loaded\nActiveState=active\nSubState=running\n',
  })).toMatchObject({ state: 'busy' });
  expect(await probeUnit('es-x', {
    runSystemctl: async () => 'LoadState=loaded\nActiveState=inactive\nSubState=dead\n',
  })).toMatchObject({ state: 'busy' });
  expect(await probeUnit('es-x', {
    runSystemctl: async () => { throw new Error('dbus unavailable'); },
  })).toMatchObject({ state: 'unknown' });
  expect(await probeUnit('es-x', {
    runSystemctl: async () => 'nonsense\n',
  })).toMatchObject({ state: 'unknown' });
});

it('stops the exact unit through systemctl', async () => {
  let args: readonly string[] = [];
  await stopUnit('es-unit', {
    runSystemctl: async (next) => { args = next; return ''; },
  });
  expect(args).toEqual(['stop', 'es-unit']);
});
