#!/usr/bin/env node
// W0-a2 acceptance: the delegated launch reaps its whole cell cgroup when the
// kernel dies, and `pause` stops the host through the same shape.
//
// Skips (exit 0, prints "skipped") when cgroup v2 is absent, `systemd-run` is
// missing, or the systemd `--user` manager does not answer — a skip is never
// reported as a pass.
//
// Flow: temp home -> loopback fake provider -> launch via start-service.mjs ->
// wait for host/parked -> inject a setsid'd sleeper into the cell cgroup ->
// SIGKILL the unit's MainPID -> assert the sleeper is gone and the cgroup tree
// empty/gone within the deadline -> restart, `pause`, assert the host stops.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAnchor } from '../dist/host/cgroups.js';
import { C13_EVENT_TYPES } from '../dist/context/events.js';
import { loadVerifiedEvents } from '../dist/context/loader.js';

const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const WRAPPER = join(REPO, 'scripts/start-service.mjs');
const FAKE_KEY = 'w0-reap-fake-key-2f1c';
const REPLY = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'idle' } }] });
const REAP_DEADLINE_MS = 5_000;
let currentUnit = '';

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * The systemd `--user` manager answers, not merely that the binary exists:
 * `systemd-run --version` reads the executable and contacts nothing, so it
 * cannot tell a host with the binary and no user manager (where the smoke must
 * skip, not fail) from a usable one. `show-environment` is a manager round trip
 * with no unit or property semantics.
 */
function userManagerAvailable() {
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function available() {
  try {
    execFileSync('systemd-run', ['--version'], { stdio: 'ignore' });
  } catch {
    return false;
  }
  return userManagerAvailable() && resolveAnchor() !== null;
}

async function waitForValue(probe, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitFor(predicate, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function cgroupOfPidSync(pid) {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
  } catch {
    return null;
  }
}

async function cgroupOfPid(pid) {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
  } catch {
    return null;
  }
}

async function procsIn(cgroupPath) {
  try {
    const raw = await readFile(cgroupPath, 'utf8');
    return raw.split('\n').filter((line) => line !== '');
  } catch (err) {
    // Only ENOENT is "the cgroup is gone"; anything else is a real error.
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function main() {
  if (!available()) {
    console.log('w0 reap smoke: skipped (cgroup v2, systemd-run or the systemd --user manager unavailable)');
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'es-w0-reap-'));
  const launchRef = { value: null }; const secondRef = { value: null }; const sleeperRef = { value: null };
  const hash = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
  const unit = `es-${hash}`;
  currentUnit = unit;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(REPLY);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    // A cell home the kernel accepts: init, then the credential store.
    execFileSync(process.execPath, [MAIN, 'init', '--home', home], { stdio: 'ignore' });
    writeFileSync(join(home, 'providers.json'), JSON.stringify({
      llm: { key: FAKE_KEY, endpoint: `http://127.0.0.1:${port}/v1/chat/completions` },
    }), { mode: 0o600 });
    chmodSync(join(home, 'providers.json'), 0o600);

    const launch = spawn(
      process.execPath,
      [WRAPPER, 'start', '--home', home, '--model', 'w0-reap-probe', '--heading', 'Reap smoke.'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    launchRef.value = launch;
    const launchExit = once(launch, 'exit').then(() => undefined);
    let stderr = '';
    launch.stderr.on('data', (chunk) => { stderr += String(chunk); });
    launch.stdout.on('data', () => {});

    // Boot: the owner record appears live; the unit runs the kernel as MainPID.
    await waitFor(async () => {
      try {
        return execFileSync('systemctl', [
          '--user', 'show', unit, '-p', 'ActiveState', '--value',
        ], { encoding: 'utf8' }).trim() === 'active';
      } catch {
        return false;
      }
    }, 20_000, 'unit active');

    const control = execFileSync('systemctl', [
      '--user', 'show', unit, '-p', 'ControlGroup', '--value',
    ], { encoding: 'utf8' }).trim();
    const mainPid = Number(execFileSync('systemctl', [
      '--user', 'show', unit, '-p', 'MainPID', '--value',
    ], { encoding: 'utf8' }).trim());
    assert.ok(Number.isInteger(mainPid) && mainPid > 0, 'MainPID is a live pid');
    // The kernel moves itself into svc/ during boot; poll rather than race it.
    await waitFor(async () => {
      const cgroup = await cgroupOfPid(mainPid);
      return cgroup !== null && cgroup.endsWith(`/${unit}/svc`);
    }, 15_000, 'kernel joined svc/');
    const mainCgroup = await cgroupOfPid(mainPid);

    const cellRoot = `/sys/fs/cgroup${control}/${unit}`;
    // The controllers enabled by the delegated launch are the a2 claim; poll
    // (the kernel enables them during boot) and require BOTH.
    await waitFor(async () => {
      try {
        const ctl = await readFile(join(cellRoot, 'cgroup.subtree_control'), 'utf8');
        return ctl.includes('memory') && ctl.includes('pids');
      } catch {
        return false;
      }
    }, 15_000, 'cell controllers enabled');

    // Wait until the first host's configuration is durably journaled (the ready
    // phase precedes the boot turn): the second launch is then deterministically
    // a `resume` (a SIGKILL during the ready phase would leave the home in
    // either state). The wrapper's stderr does not carry the kernel's lines —
    // systemd keeps them in the user journal — so read the local log.
    await waitFor(async () => {
      try {
        const events = await loadVerifiedEvents(home, 'node-0', C13_EVENT_TYPES);
        return events.some((event) => event.type === 'system/message');
      } catch {
        return false;
      }
    }, 20_000, 'first host configuration journaled');

    // A setsid'd sleeper joins a fresh node leaf — the class that outlived the
    // kernel in the incident. Node's detached option calls setsid on the child
    // itself, so the recorded pid IS the sleeper (an inner `setsid` would fork).
    const reapLeaf = join(cellRoot, 'node-reap-test');
    await mkdir(reapLeaf);
    const sleeper = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    sleeperRef.value = sleeper;
    const sleeperPid = sleeper.pid;
    assert.ok(Number.isInteger(sleeperPid) && sleeperPid > 0, 'sleeper pid');
    writeFileSync(join(reapLeaf, 'cgroup.procs'), String(sleeperPid));
    // Pre-kill proof: the sleeper really is in the target leaf (a vacuous
    // injection would make the post-kill emptiness check meaningless).
    await waitFor(async () => {
      const procs = await procsIn(join(reapLeaf, 'cgroup.procs'));
      const own = cgroupOfPidSync(sleeperPid);
      return procs !== null && procs.includes(String(sleeperPid))
        && own !== null && own.endsWith('/node-reap-test');
    }, 5_000, 'sleeper in the target leaf');

    // SIGKILL the kernel (not the wrapper's systemd-run client).
    process.kill(mainPid, 'SIGKILL');
    const killedAt = Date.now();
    await waitFor(async () => {
      const leafProcs = await procsIn(join(reapLeaf, 'cgroup.procs'));
      return leafProcs === null || leafProcs.length === 0;
    }, REAP_DEADLINE_MS, 'reaped the node leaf');
    await waitFor(async () => {
      const procs = await procsIn(join(cellRoot, 'svc', 'cgroup.procs'));
      return procs === null || procs.length === 0;
    }, REAP_DEADLINE_MS, 'reaped the cell cgroup');
    const reapedInMs = Date.now() - killedAt;
    await waitFor(async () => {
      try {
        const state = execFileSync('systemctl', [
          '--user', 'show', unit, '-p', 'ActiveState', '--value',
        ], { encoding: 'utf8' }).trim();
        return state === 'failed' || state === 'inactive';
      } catch {
        return true;
      }
    }, REAP_DEADLINE_MS, 'unit stopping');
    await launchExit;

    // Pause proof: a second boot, then the operator verb stops it. The first
    // run journaled the cell's configuration, so the second launch is `resume`
    // (a `start` is refused by the config gate by design).
    const second = spawn(
      process.execPath,
      [WRAPPER, 'resume', '--home', home],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    secondRef.value = second;
    const secondExit = once(second, 'exit').then(() => undefined);
    const secondPid = await waitForValue(async () => {
      try {
        const pid = Number(execFileSync('systemctl', [
          '--user', 'show', unit, '-p', 'MainPID', '--value',
        ], { encoding: 'utf8' }).trim());
        if (!Number.isInteger(pid) || pid <= 0) return null;
        const cgroup = await cgroupOfPid(pid);
        return cgroup !== null && cgroup.endsWith(`/${unit}/svc`) ? pid : null;
      } catch {
        return null;
      }
    }, 20_000, 'second kernel in svc');
    const pause = spawnSync(process.execPath, [MAIN, 'pause', '--home', home], {
      encoding: 'utf8', timeout: 40_000,
    });
    assert.ok(pause.status === 0 || pause.status === 3, `pause exited ${pause.status}: ${pause.stderr}`);
    await Promise.race([secondExit, new Promise((done) => { setTimeout(done, REAP_DEADLINE_MS * 2); })]);
    // The paused kernel releases the cell: its cgroup tree is empty/gone.
    await waitFor(async () => {
      const procs = await procsIn(join(cellRoot, 'svc', 'cgroup.procs'));
      return procs === null || procs.length === 0;
    }, REAP_DEADLINE_MS * 2, 'paused cell reaped');
    void secondPid;

    console.log(`w0 reap smoke: ok (reaped in ${reapedInMs} ms; pause exit ${pause.status})`);
    void stderr;
  } finally {
    // Never leave a live transient service, wrapper or sleeper behind. The
    // wrapper creates BOTH the unit and its implicit `--slice=<unit>` slice:
    // stopping only the service leaves the slice active forever, so the slice
    // is stopped and reset-failed as well.
    spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'stop', `${unit}.slice`], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'reset-failed', `${unit}.slice`], { stdio: 'ignore' });
    for (const child of [launchRef.value, secondRef.value, sleeperRef.value]) {
      if (child !== null && child !== undefined && child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
    await new Promise((done) => server.close(done));
    rmSync(home, { recursive: true, force: true });
  }
  // The cleanup contract is a fact, not a hope: no unit or slice of this run
  // (named by the home hash) may survive the smoke. A short poll absorbs the
  // user manager's asynchronous unloading.
  await waitFor(() => {
    const left = esUnits().filter((name) => name.includes(hash));
    return left.length === 0;
  }, REAP_DEADLINE_MS, 'no es-* leftover unit or slice');
}

/** The user manager's loaded es-* unit/slice names (never a path). */
function esUnits() {
  try {
    return execFileSync('systemctl', [
      '--user', 'list-units', 'es-*', '--all', '--no-legend', '--plain',
    ], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim().split(/\s+/u)[0] ?? '')
      .filter((name) => name !== '');
  } catch {
    return [];
  }
}

main().catch((err) => {
  console.error(`w0 reap smoke: ${err instanceof Error ? err.message : String(err)}`);
  try {
    console.error(execFileSync('journalctl', [
      '--user', '-u', currentUnit, '--no-pager', '-n', '20',
    ], { encoding: 'utf8' }));
  } catch { /* diagnostics only */ }
  process.exit(1);
});
