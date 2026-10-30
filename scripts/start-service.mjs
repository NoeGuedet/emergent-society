#!/usr/bin/env node
// The delegated launch: runs the kernel as the MainPID of a transient systemd
// user service in a delegated slice. systemd's KillMode=control-group then
// reaps the whole cell cgroup (shell, Runs, daemons) when the kernel dies —
// the W0-b reaper, with no custom binary. Without this wrapper the kernel runs
// directly (the documented direct-path residual: nothing reaps its descendants).
//
// Usage: node scripts/start-service.mjs <host verb> --home <abs-dir> [host args…]
//
// Requires: systemd --user running, and `loginctl enable-linger $USER` if the
// cell must survive logout. The wrapper refuses when systemd-run is missing.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));

const args = process.argv.slice(2);
const homeIndex = args.indexOf('--home');
const homeValue = homeIndex === -1 ? undefined : args[homeIndex + 1];
if (homeValue === undefined || homeValue === '') {
  console.error('usage: node scripts/start-service.mjs <verb> --home <abs-dir> [host args…]');
  process.exit(2);
}

// MUST equal cgroups.cellHash: sha256(resolve(home))[:12]. A drift here makes
// the unit/slice name disagree with the cell cgroup tree.
const hash = createHash('sha256').update(resolve(homeValue)).digest('hex').slice(0, 12);
const unit = `es-${hash}`;

// Test-only limit overrides must cross into the unit (systemd-run's service
// path does not inherit the caller's environment).
const env = [];
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('ES_') && value !== undefined) env.push('-E', `${name}=${value}`);
}

// A failed transient unit keeps its name loaded and blocks the same name;
// --collect removes units on exit, and this reset clears a crash residue.
spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' });

const res = spawnSync(
  'systemd-run',
  [
    '--user', '--collect', '--wait',
    `--unit=${unit}`, `--slice=${unit}`,
    '--property=Delegate=yes',
    '--property=KillMode=control-group',
    '--property=TimeoutStopSec=45',
    // argv is taken literally: a heading/charter containing ${...} must not be
    // expanded by the manager's environment.
    '--expand-environment=no',
    ...env,
    '--', process.execPath, MAIN, ...args,
  ],
  { stdio: 'inherit' },
);
if (res.error !== undefined) {
  console.error(`start-service: systemd-run unavailable: ${res.error.message}`);
  process.exit(2);
}
process.exit(res.status ?? 1);
