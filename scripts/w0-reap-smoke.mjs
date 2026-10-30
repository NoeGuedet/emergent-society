#!/usr/bin/env node
// W0-a2 acceptance: the delegated launch reaps its whole cell cgroup when the
// kernel dies, and `pause` stops the host through the same shape.
//
// Skips (exit 0, prints "skipped") when the user manager / systemd-run is
// unavailable or cgroup v2 is absent — a skip is never reported as a pass.
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

const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const WRAPPER = join(REPO, 'scripts/start-service.mjs');
const FAKE_KEY = 'w0-reap-fake-key-2f1c';
const REPLY = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'idle' } }] });
const REAP_DEADLINE_MS = 5_000;
let currentUnit = '';

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

function available() {
  try {
    execFileSync('systemd-run', ['--version'], { stdio: 'ignore' });
  } catch {
    return false;
  }
  return resolveAnchor() !== null;
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
    console.log('w0 reap smoke: skipped (no systemd user manager)');
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

    // Pause proof: a second boot, then the operator verb stops it.
    const second = spawn(
      process.execPath,
      [WRAPPER, 'start', '--home', home, '--model', 'w0-reap-probe', '--heading', 'Reap smoke 2.'],
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
    // Never leave a live transient service, wrapper or sleeper behind.
    spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' });
    for (const child of [launchRef.value, secondRef.value, sleeperRef.value]) {
      if (child !== null && child !== undefined && child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
    await new Promise((done) => server.close(done));
    rmSync(home, { recursive: true, force: true });
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
