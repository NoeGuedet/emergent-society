import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { TEST_STORAGE } from '../../frontier/__tests__/helpers.js';
import { JournalReader } from '../../journal/index.js';
import { serveJson, type LoopServer } from '../../node/__tests__/helpers.js';
import { WorldRepo } from '../../node/world.js';
import type { StorageFree, StorageQuota } from '../../storage.js';
import { StorageError } from '../../storage.js';
import { composeCell, startHost, type HostHandle, type HostOptions } from '../host.js';
import { createHostLog, type HostLog } from '../observe.js';
import { readOwner } from '../owner.js';
import { formatStatus, readStatus } from '../status.js';

/**
 * The operator-visible storage fact and the no-fail-closed boot.
 *
 * The production shape is quoted only by injection: with no quota the host
 * boots, the boot line says `storage=unquoted`, the owner record carries it and
 * `status` surfaces it (JSON always; the human line only for the normal
 * production `unquoted` fact). A low disk defers turns but never refuses the boot, and a probe
 * failure is one bounded diagnostic with the fact unchanged.
 */

const idleReply = {
  body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'idle' } }] }),
};

const hostDeps = {
  installSignals: false, keepAlive: false,
  attachToCell: async () => ({ ok: false as const, reason: 'test-stub' }),
} as const;

let home = '';
let log: HostLog;
let lines: string[] = [];
let opts: HostOptions;
let server: LoopServer | null = null;
const tracked: HostHandle[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'es-storage-host-'));
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  lines = [];
  log = createHostLog((line) => lines.push(line));
  opts = {
    home, uid: 'node-0', command: 'start', model: 'first-light-test',
    heading: 'First light.', sandbox: false, pollMs: 0, log,
  };
});

afterEach(async () => {
  for (const handle of tracked.splice(0)) {
    handle.stop();
    await handle.done;
  }
  if (server !== null) {
    await server.close();
    server = null;
  }
  await rm(home, { recursive: true, force: true });
  home = '';
});

function track(handle: HostHandle): HostHandle {
  tracked.push(handle);
  return handle;
}

/** Starts the loopback provider and writes the 0600 credential store. */
async function serve(): Promise<void> {
  const started = await serveJson(() => idleReply);
  server = started;
  await writeFile(
    join(home, 'providers.json'),
    JSON.stringify({ llm: { key: 'sentinel-llm-key', endpoint: `${started.url}/v1/chat/completions` } }),
    { mode: 0o600 },
  );
}

function logged(): { readonly event: string; readonly [key: string]: unknown }[] {
  return lines.map((line) => JSON.parse(line) as { readonly event: string; readonly [key: string]: unknown });
}

async function waitFor(event: string): Promise<void> {
  await vi.waitFor(() => {
    expect(logged().map((entry) => entry.event)).toContain(event);
  }, { timeout: 15_000 });
}

/** Every local-log event of node-0. */
async function localEvents() {
  const reader = await JournalReader.open(home, 'node-0', { knownTypes: C13_EVENT_TYPES });
  const events: { readonly type: string }[] = [];
  for await (const event of reader.events()) events.push(event);
  return events;
}

it('boots unquoted with no injected quota: boot line, owner record and status', async () => {
  await serve();
  // The boot probe is the controlled HIGH seam, not the host's /tmp headroom:
  // otherwise this case would pass or fail on the test machine's free space.
  const h = track(startHost(opts, { ...hostDeps, freeSpace: TEST_STORAGE.probe }));
  await waitFor('host/parked');
  const boot = logged().find((entry) => entry.event === 'host/boot');
  expect(boot).toMatchObject({ storage: 'unquoted' });

  const owner = await readOwner(home);
  expect(owner.kind).toBe('live');
  if (owner.kind === 'live') expect(owner.record.storage).toBe('unquoted');

  const report = await readStatus(home);
  expect(report.host).toMatchObject({ state: 'running', storage: 'unquoted' });
  expect(formatStatus(report)).toContain('storage=unquoted');

  h.stop();
  expect(await h.done).toBe(0);
}, 30_000);

it('boots quoted when a quota record is injected, with no human degradation line', async () => {
  await serve();
  const quota: StorageQuota = { usedBytes: 1, limitBytes: 1_000 };
  const h = track(startHost(opts, {
    ...hostDeps, storageQuota: quota, freeSpace: TEST_STORAGE.probe,
  }));
  await waitFor('host/parked');
  const boot = logged().find((entry) => entry.event === 'host/boot');
  expect(boot).toMatchObject({ storage: 'quoted' });

  const owner = await readOwner(home);
  expect(owner.kind).toBe('live');
  if (owner.kind === 'live') expect(owner.record.storage).toBe('quoted');

  const report = await readStatus(home);
  expect(report.host).toMatchObject({ state: 'running', storage: 'quoted' });
  // A quoted host is not a degraded fact: the human line stays byte-identical.
  expect(formatStatus(report)).not.toContain('storage=');

  h.stop();
  expect(await h.done).toBe(0);
}, 30_000);

it('does not refuse the boot on a low probe: turns defer and the boot fact stays unquoted', async () => {
  await serve();
  const state: { free: StorageFree | null } = { free: { bytes: 1, inodes: 1 } };
  const h = track(startHost(opts, { ...hostDeps, freeSpace: async () => state.free }));
  await waitFor('host/boot');
  // The driver's turn-start home defers on the same probe; the host reports it
  // through the driver's diagnostic channel. Wait for the named line itself, not
  // merely for the channel's first event, so the assertion cannot race it.
  await vi.waitFor(() => {
    expect(logged()).toContainEqual(expect.objectContaining({
      event: 'driver/error', error: 'StorageDeferredError',
    }));
  }, { timeout: 15_000 });
  expect(logged().find((entry) => entry.event === 'host/boot')).toMatchObject({ storage: 'unquoted' });
  expect((await localEvents()).filter((event) => event.type === 'turn/start')).toHaveLength(0);

  // The close's final flush needs the probe high (a low disk refuses it), so
  // this recovery is load-bearing: without it the stop fails and the pending
  // boot fact is lost. Assert that the fact lands — the setup is falsifiable.
  state.free = { bytes: 10 * 1024 ** 3, inodes: 1_000_000 };
  h.stop();
  expect(await h.done).toBe(0);
  const after = await localEvents();
  expect(after.filter((event) => event.type === 'turn/start')).toHaveLength(0);
  expect(after.filter((event) => event.type === 'node/boot')).toHaveLength(1);
}, 30_000);

it('forwards the injected storage seam to the frontier gate and the local writer', async () => {
  await serve();
  const LOW: StorageFree = { bytes: 1, inodes: 1 };
  const HIGH: StorageFree = { bytes: 10 * 1024 ** 3, inodes: 1_000_000 };
  const state = { free: LOW };
  let captured: Awaited<ReturnType<typeof composeCell>> | null = null;
  const h = track(startHost(opts, {
    ...hostDeps,
    freeSpace: async () => state.free,
    compose: async (o) => {
      const cell = await composeCell(o);
      captured = cell;
      return cell;
    },
  }));
  // Wait for the named turn-start deferral, not the generic channel: the open's
  // own doctor-flush also emits `driver/error` (a plain StorageError) before
  // `composeCell` returns, so a generic wait can observe it before `captured`
  // is assigned — the parallel-load flake this test used to exhibit.
  await vi.waitFor(() => {
    expect(logged()).toContainEqual(expect.objectContaining({
      event: 'driver/error', error: 'StorageDeferredError',
    }));
  }, { timeout: 15_000 });
  expect(captured).not.toBeNull();
  // The driver's LOCAL writer received the seam: the boot fact is still
  // pending, not durable. A regression that passed DEFAULT_STORAGE here would
  // land node/boot despite the injected low reading.
  expect((await localEvents()).filter((event) => event.type === 'node/boot')).toHaveLength(0);
  // The FRONTIER writer/gate received the same seam: begin refuses before any
  // blob or event exists. A regression at `openFrontierJournal` would begin.
  await expect(captured!.frontier.gate.begin({
    method: 'POST',
    url: 'https://h/v1/x',
    headers: {},
    body: Buffer.from('{"a":1}'),
    encoding: 'utf8',
  })).rejects.toBeInstanceOf(StorageError);
  // Recover the disk so the stop's close flush can land the pending boot fact.
  state.free = HIGH;
  h.stop();
  expect(await h.done).toBe(0);
}, 30_000);

it('logs one bounded storage-probe diagnostic on a probe failure and keeps unquoted', async () => {
  await serve();
  const h = track(startHost(opts, { ...hostDeps, freeSpace: async () => null }));
  await waitFor('host/parked');
  expect(logged()).toContainEqual(expect.objectContaining({
    event: 'host/degraded', reason: 'storage-probe',
  }));
  expect(logged().find((entry) => entry.event === 'host/boot')).toMatchObject({ storage: 'unquoted' });
  const owner = await readOwner(home);
  if (owner.kind === 'live') expect(owner.record.storage).toBe('unquoted');
  h.stop();
  expect(await h.done).toBe(0);
}, 30_000);
