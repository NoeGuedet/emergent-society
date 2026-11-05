import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const START_SERVICE = fileURLToPath(
  new URL('../../../scripts/start-service.mjs', import.meta.url),
);
const execFileAsync = promisify(execFile);

export type { ChildProcess };

/**
 * The one operator spawn: the existing wrapper around this process, with the
 * host argv built by the manager. No caller-supplied command or shell.
 */
export function spawnStartService(args: readonly string[]): ChildProcess {
  return spawn(process.execPath, [START_SERVICE, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Exact systemd user-unit probe; no caller-supplied systemctl verb. */
export async function probeSystemdUnit(unit: string): Promise<string> {
  const result = await execFileAsync('systemctl', [
    '--user', 'show', unit, '--no-pager',
    '--property=LoadState', '--property=ActiveState',
    '--property=SubState', '--property=ControlGroup',
  ], { timeout: 10_000, maxBuffer: 16 * 1024 });
  return result.stdout;
}

/** Exact systemd user-unit stop; no caller-supplied systemctl verb. */
export async function stopSystemdUnit(unit: string): Promise<string> {
  const result = await execFileAsync('systemctl', ['--user', 'stop', unit], {
    timeout: 10_000, maxBuffer: 16 * 1024,
  });
  return result.stdout;
}
