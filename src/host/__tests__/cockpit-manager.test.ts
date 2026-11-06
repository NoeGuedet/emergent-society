import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { CockpitManager } from '../cockpit/manager.js';
import { RunsStore, type RunManifest } from '../cockpit/runs.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('reserves one active slot, launches the fixed wrapper args, and pauses it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'es-cockpit-manager-'));
  roots.push(root);
  const store = await RunsStore.open(join(root, 'runs'));
  const manifest: RunManifest = {
    v: 0, id: '11111111-1111-4111-8111-111111111111',
    label: 'run', heading: 'Run.', nodeModel: 'm', gatewayModel: 'g',
    nodeCount: 1, spawn: false, createdAt: 1,
  };
  await mkdir(join(root, 'runs', manifest.id, 'home'), { recursive: true, mode: 0o700 });
  const calls: string[][] = [];
  const children: EventEmitter[] = [];
  const spawn = ((args: readonly string[]) => {
    calls.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('../cockpit/runtime.js').spawnStartService;
  const requestPause = (async () => {
    setTimeout(() => children.at(-1)?.emit('exit', 0), 0);
  }) as unknown as typeof import('../owner.js').requestPause;
  let unitState: 'absent' | 'busy' = 'absent';
  const manager = new CockpitManager(store, { emit: () => {} }, {
    spawn, requestPause,
    probeUnit: async () => (unitState === 'absent'
      ? { state: 'absent', detail: 'unit is not loaded' }
      : { state: 'busy', detail: 'unit is active' }),
    stopUnit: async () => { unitState = 'absent'; },
    sleep: async () => {},
  });

  const active = await manager.launch(manifest, 5);
  expect(active.id).toBe(manifest.id);
  expect(calls[0]).toEqual(expect.arrayContaining([
    'start', '--token-limit', '5', '--gateway-model', 'g', '--nodes-file',
    '--heartbeat-seconds', '300',
  ]));
  expect(calls[0]).not.toContain('--no-sandbox');

  await expect(manager.launch(manifest, 5)).rejects.toThrow('one active run');
  await manager.pause(manifest.id);
  expect(manager.active()).toBeNull();

  await manager.observe(manifest);
  expect(calls[1]).toEqual(expect.arrayContaining(['resume', '--observer']));
  expect(calls[1]).not.toContain('--heartbeat-seconds');
  expect(calls[1]).not.toContain('--token-limit');
  expect(manager.active()?.id).toBe(manifest.id);
  await manager.pause(manifest.id);
  expect(manager.active()).toBeNull();
  expect(children).toHaveLength(2);
}, 10_000);
