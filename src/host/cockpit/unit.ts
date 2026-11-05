import { probeSystemdUnit, stopSystemdUnit } from './runtime.js';

export type UnitState = 'busy' | 'absent' | 'unknown';

export type UnitProbe = {
  readonly state: UnitState;
  readonly detail: string;
};

export type UnitDeps = {
  readonly runSystemctl?: (args: readonly string[]) => Promise<string>;
};


/**
 * The exact transient unit's state. `not-found` is the only proof that the unit
 * is collected; a loaded unit is busy even when it reports inactive/dead, and
 * every probe failure is unknown (never free).
 */
export async function probeUnit(
  unit: string, deps: UnitDeps = {},
): Promise<UnitProbe> {
  let output: string;
  try {
    output = deps.runSystemctl !== undefined
      ? await deps.runSystemctl([
        'show', unit, '--no-pager',
        '--property=LoadState', '--property=ActiveState',
        '--property=SubState', '--property=ControlGroup',
      ])
      : await probeSystemdUnit(unit);
  } catch (err) {
    return { state: 'unknown', detail: err instanceof Error ? err.message.slice(0, 160) : 'probe failed' };
  }
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  const load = values.get('LoadState');
  const active = values.get('ActiveState');
  if (load === 'not-found') return { state: 'absent', detail: 'unit is not loaded' };
  if (load !== 'loaded') {
    return { state: 'unknown', detail: `unexpected LoadState=${load ?? 'missing'}` };
  }
  if (active === 'active' || active === 'activating'
    || active === 'deactivating' || active === 'reloading') {
    return { state: 'busy', detail: `unit is ${active}` };
  }
  // Loaded but not collected still owns the name/cgroup; never call it free.
  return {
    state: 'busy',
    detail: `unit remains loaded (${active ?? 'unknown'}/${values.get('SubState') ?? 'unknown'})`,
  };
}

/** Stops the exact transient unit when the owner signal was not enough. */
export async function stopUnit(unit: string, deps: UnitDeps = {}): Promise<void> {
  if (deps.runSystemctl !== undefined) await deps.runSystemctl(['stop', unit]);
  else await stopSystemdUnit(unit);
}
