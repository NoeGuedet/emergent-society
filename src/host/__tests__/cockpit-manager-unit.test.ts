import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type { PauseOutcome } from '../owner.js';
import { CockpitManager } from '../cockpit/manager.js';
import { RunsStore, type RunManifest } from '../cockpit/runs.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ID = '22222222-2222-4222-8222-222222222222';

async function fixture(unitInitially: 'absent' | 'busy' = 'absent'): Promise<{
  store: RunsStore; manifest: RunManifest; children: EventEmitter[]; state: { unit: 'absent' | 'busy' };
  make: (state: { unit: 'absent' | 'busy' }) => CockpitManager;
}> {
  const root = await mkdtemp(join(tmpdir(), 'es-cockpit-unit-'));
  roots.push(root);
  const store = await RunsStore.open(join(root, 'runs'));
  const manifest: RunManifest = {
    v: 0, id: ID, label: 'run', heading: 'Run.', nodeModel: 'm',
    gatewayModel: 'g', nodeCount: 1, spawn: false, createdAt: 1,
  };
  await mkdir(join(root, 'runs', ID, 'home'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'runs', ID, 'run.json'), JSON.stringify(manifest), { mode: 0o600 });
  const state = { unit: unitInitially };
  const children: EventEmitter[] = [];
  const spawn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('../cockpit/runtime.js').spawnStartService;
  const requestPause = (async (): Promise<PauseOutcome> => {
    setTimeout(() => children.at(-1)?.emit('exit', 0), 0);
    return { kind: 'exited' };
  }) as unknown as typeof import('../owner.js').requestPause;
  const make = (target: { unit: 'absent' | 'busy' }) => new CockpitManager(
    store, { emit: () => {} }, {
      spawn, requestPause,
      probeUnit: async () => (target.unit === 'absent'
        ? { state: 'absent', detail: 'unit is not loaded' }
        : { state: 'busy', detail: 'unit is active' }),
      stopUnit: async () => { target.unit = 'absent'; },
      sleep: async () => {},
    },
  );
  return { store, manifest, children, state, make };
}

it('retains the slot after an unexpected wrapper exit while the unit is active', async () => {
  const { manifest, children, state, make } = await fixture();
  const manager = make(state);
  await manager.launch(manifest, 5);
  state.unit = 'busy';
  children[0]!.emit('exit', 1);
  await vi.waitFor(() => {
    expect(manager.active()).not.toBeNull();
    expect(manager.active()?.blocked).toContain('active');
  });
  await expect(manager.launch(manifest, 5)).rejects.toThrow('one active run');
  state.unit = 'absent';
  await manager.pause(ID);
  expect(manager.active()).toBeNull();
});

it('stops and waits for the exact unit before freeing a paused slot', async () => {
  const { manifest, state, make } = await fixture();
  const manager = make(state);
  await manager.launch(manifest, 5);
  state.unit = 'busy';
  await manager.pause(ID);
  expect(manager.active()).toBeNull();
});

it('reconciles a lost wrapper to a blocked unverified slot, never free', async () => {
  const { state, make } = await fixture('busy');
  const manager = make(state);
  await manager.reconcile();
  expect(manager.active()).toMatchObject({ id: ID, child: null });
  expect(manager.active()?.blocked).toBeTruthy();
  state.unit = 'absent';
  await manager.pause(ID);
  expect(manager.active()).toBeNull();
});
