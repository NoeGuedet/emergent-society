import { cellHash } from '../cgroups.js';
import { readOwner, requestPause } from '../owner.js';
import { probeUnit, stopUnit, type UnitProbe } from './unit.js';
import { spawnStartService, type ChildProcess } from './runtime.js';
import type { RunsStore, RunManifest } from './runs.js';

export type ActiveRun = {
  readonly id: string;
  readonly home: string;
  readonly unit: string;
  readonly child: ChildProcess | null;
  readonly childExited: boolean;
  readonly diagnostics: string[];
  readonly blocked: string | null;
};

type Slot = Omit<ActiveRun, 'childExited'> & {
  readonly manifest: RunManifest;
  childExited: boolean;
};

type ManagerDeps = {
  readonly spawn?: typeof spawnStartService;
  readonly requestPause?: typeof requestPause;
  readonly probeUnit?: (unit: string) => Promise<UnitProbe>;
  readonly stopUnit?: (unit: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
};

export class CockpitManager {
  private slot: Slot | null = null;
  private readonly starts = new Set<Promise<unknown>>();
  private readonly spawnChild: typeof spawnStartService;
  private readonly pauseHost: typeof requestPause;
  private readonly probe: (unit: string) => Promise<UnitProbe>;
  private readonly stopExactUnit: (unit: string) => Promise<void>;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly runs: RunsStore,
    private readonly log: { emit(event: string, data?: unknown): void },
    deps: ManagerDeps = {},
  ) {
    this.spawnChild = deps.spawn ?? spawnStartService;
    this.pauseHost = deps.requestPause ?? requestPause;
    this.probe = deps.probeUnit ?? ((unit) => probeUnit(unit));
    this.stopExactUnit = deps.stopUnit ?? ((unit) => stopUnit(unit));
    this.wait = deps.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  }

  active(): ActiveRun | null {
    return this.slot;
  }

  async reconcile(): Promise<void> {
    for (const manifest of await this.runs.list()) {
      const home = await this.runs.home(manifest.id);
      const unit = unitOf(home);
      const probe = await this.probe(unit);
      const owner = await readOwner(home).catch(() => null);
      if (probe.state !== 'absent' || owner?.kind === 'live') {
        this.slot = {
          id: manifest.id, home, unit, child: null, childExited: true,
          diagnostics: [probe.detail],
          blocked: probe.state === 'absent'
            ? 'owner is live without a managed unit' : probe.detail,
          manifest,
        };
        return;
      }
    }
  }

  async launch(manifest: RunManifest, limit: number): Promise<ActiveRun> {
    if (this.slot !== null) throw new Error('one active run is allowed');
    const home = await this.runs.home(manifest.id);
    const slot = this.reserve(manifest, home);
    const probe = await this.probe(slot.unit);
    if (probe.state !== 'absent') {
      this.slot = { ...slot, blocked: probe.detail };
      throw new Error(`run unit is not free: ${probe.detail}`);
    }
    const args = [
      'start',
      '--home', home,
      '--nodes-file', await this.runs.nodesFile(manifest.id),
      '--gateway-charter', await this.runs.charterFile(manifest.id),
      '--gateway-model', manifest.gatewayModel,
      '--token-limit', String(limit),
      '--heartbeat-seconds', '300',
    ];
    return await this.spawnSlot(slot, args);
  }

  async observe(manifest: RunManifest): Promise<ActiveRun> {
    if (this.slot !== null) throw new Error('one active run is allowed');
    const home = await this.runs.home(manifest.id);
    const slot = this.reserve(manifest, home);
    const probe = await this.probe(slot.unit);
    if (probe.state !== 'absent') {
      this.slot = { ...slot, blocked: probe.detail };
      throw new Error(`run unit is not free: ${probe.detail}`);
    }
    return await this.spawnSlot(
      slot, ['resume', '--home', home, '--observer'],
    );
  }

  private reserve(manifest: RunManifest, home: string): Slot {
    const slot: Slot = {
      id: manifest.id, home, unit: unitOf(home), child: null, childExited: true,
      diagnostics: [], blocked: null, manifest,
    };
    this.slot = slot;
    return slot;
  }

  private async spawnSlot(slot: Slot, args: readonly string[]): Promise<ActiveRun> {
    try {
      const child = this.spawnChild([...args]);
      slot = { ...slot, child, childExited: false };
      this.slot = slot;
      const capture = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line === '') continue;
          slot.diagnostics.push(line.slice(0, 500));
          if (slot.diagnostics.length > 40) slot.diagnostics.shift();
        }
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.once('exit', () => {
        slot.childExited = true;
        void this.afterChildExit(slot);
      });
      const started = new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      this.starts.add(started.catch(() => {}));
      await started;
      return slot;
    } catch (err) {
      if (this.slot?.id === slot.id) this.slot = null;
      throw err;
    }
  }

  private async afterChildExit(slot: Slot): Promise<void> {
    const probe = await this.probe(slot.unit).catch(
      (): UnitProbe => ({ state: 'unknown', detail: 'unit probe failed' }),
    );
    const owner = await readOwner(slot.home).catch(() => null);
    if (probe.state === 'absent' && owner?.kind !== 'live') {
      if (this.slot?.id === slot.id) this.slot = null;
      return;
    }
    if (this.slot?.id === slot.id) {
      this.slot = {
        ...slot,
        child: null,
        childExited: true,
        blocked: probe.state === 'absent' ? 'owner is live without a managed unit' : probe.detail,
      };
    }
  }

  async pause(id: string): Promise<void> {
    if (this.slot === null || this.slot.id !== id) {
      throw new Error('no active run with that id');
    }
    const slot = this.slot;
    let pauseOutcome: Awaited<ReturnType<typeof requestPause>> | null = null;
    try {
      pauseOutcome = await this.pauseHost(slot.home);
    } catch (err) {
      slot.diagnostics.push(`pause request failed: ${err instanceof Error ? err.message : 'error'}`);
    }
    let probe = await this.probe(slot.unit).catch(
      (): UnitProbe => ({ state: 'unknown', detail: 'unit probe failed' }),
    );
    if (probe.state === 'busy') {
      try {
        await this.stopExactUnit(slot.unit);
      } catch (err) {
        slot.diagnostics.push(`unit stop failed: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    const deadline = Date.now() + 50_000;
    for (;;) {
      probe = await this.probe(slot.unit).catch(
        (): UnitProbe => ({ state: 'unknown', detail: 'unit probe failed' }),
      );
      const owner = await readOwner(slot.home).catch(() => null);
      const childDone = slot.child === null || slot.childExited;
      if (probe.state === 'absent' && owner?.kind !== 'live' && childDone) {
        if (this.slot?.id === id) this.slot = null;
        return;
      }
      if (Date.now() >= deadline) break;
      await this.wait(100);
    }
    const reason = probe.state === 'absent'
      ? 'unit is absent but the owner or wrapper is still live'
      : probe.detail;
    this.slot = { ...slot, blocked: reason };
    this.log.emit('cockpit/pause-unverified', { id, unit: slot.unit });
    throw new Error(
      `pause could not verify unit completion${pauseOutcome === null ? ' (no pause outcome)' : ''}`,
    );
  }

  async shutdown(): Promise<void> {
    if (this.slot !== null) await this.pause(this.slot.id).catch(() => {});
    await Promise.allSettled([...this.starts]);
  }
}

function unitOf(home: string): string {
  return `es-${cellHash(home)}`;
}
