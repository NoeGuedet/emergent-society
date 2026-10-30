#!/usr/bin/env node
// W0-c / C2 acceptance: the commit fence against a real cell and a real cgroup.
//
// Run with `node scripts/w0-fence-smoke.mjs` after `npm run build` (the smoke
// imports the compiled host from dist). It is manual and never runs in a gate;
// no npm script is added for it.
//
// Skips (exit 0, prints "skipped") when cgroup v2 or freeze/kill is unavailable
// — a skip is never reported as a pass.
//
// Scenarios:
//  1. TURNS: a real host, a real cell tree, and a writer injected into the
//     node's own leaf via `<cell root>/node-node-0/cgroup.procs`. The boot turn
//     freezes an EMPTY leaf and commits. Then 20 turns are driven through the
//     fake provider (each woken by a foreign human commit); every commit must
//     log `host/fence {state:'fenced'}` and the writer's world-file counter
//     must not move inside the sampled fence window. The kernel's git is put
//     behind a shim that sleeps in `write-tree`, widening the critical section
//     so the sample is deterministic rather than a race. After each park the
//     writer must move again (the release proved, not assumed).
//  2. THAW-ON-FAILURE: a cell composed with a fence port over a FAKE cgroupfs
//     leaf whose `frozen` bit never lands. The port returns `freeze-failed`,
//     thaws, and the commit refuses typed (`freeze-timeout`, degraded sidecar);
//     a foreign wake then lets the next shell turn run and commit both turns'
//     writes. (The cgroup-free variant of this is in the Vitest suite; this is
//     the compiled-side witness.)
//  3. CRASH-INSIDE-FREEZE: freeze the node leaf, SIGKILL the kernel, boot the
//     SAME launch shape; boot hygiene must thaw/kill the stale leaf and the
//     shell must answer (a fresh committed file).
//  4. UNFENCED: a `--no-sandbox` host has no fence; its boot line, owner record
//     and `status` carry `fence=unavailable`, and its commit still lands.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cellUnitName, detachCell, killLeaves, nodeLeaf, resolveAnchor, thawSet,
} from '../dist/host/cgroups.js';
import { createFencePort } from '../dist/host/fence.js';
import { composeCell } from '../dist/host/host.js';
import { createHostLog } from '../dist/host/observe.js';
import { readWorldState } from '../dist/node/world-state.js';
import { defaultAgentConfig, validateAgentConfig } from '../dist/context/config.js';
import { HeadWatcher } from '../dist/node/watcher.js';
import { WorldRepo } from '../dist/node/world.js';

const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));
const FAKE_KEY = 'w0-fence-fake-key-5b7e';
const TURNS = 20;
const SHIM_SLEEP_SECONDS = 0.3;

const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function waitFor(probe, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function countLines(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').length;
  } catch {
    return 0;
  }
}

function realGitPath() {
  return execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
}

/** A PATH shim that sleeps inside the commit's critical section. */
function writeGitShim(dir) {
  const script = [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  if [ "$a" = "write-tree" ]; then sleep ' + SHIM_SLEEP_SECONDS + '; break; fi',
    'done',
    `exec ${JSON.stringify(realGitPath())} "$@"`,
    '',
  ].join('\n');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'git');
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  return dir;
}

/** One real cell home with its world pair. */
async function makeCellHome() {
  const home = mkdtempSync(join(tmpdir(), 'es-w0-fence-'));
  execFileSync(process.execPath, [MAIN, 'init', '--home', home], { stdio: 'ignore' });
  return home;
}

/** The fake provider; `replyFor(index)` chooses the message body. */
async function serveProvider(replyFor) {
  const server = createServer((request, response) => {
    request.resume();
    const index = server.__count ?? 0;
    server.__count = index + 1;
    const body = replyFor(index);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: body }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` };
}

const content = (text) => ({ role: 'assistant', content: text });
const execute = (cmd, index) => ({
  role: 'assistant', content: null,
  tool_calls: [{
    id: `e${index}`, type: 'function', function: { name: 'execute', arguments: JSON.stringify({ cmd }) },
  }],
});

function writeProviders(home, endpoint) {
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ llm: { key: FAKE_KEY, endpoint } }), {
    mode: 0o600,
  });
  chmodSync(join(home, 'providers.json'), 0o600);
}

/** A host child whose stderr JSONL is parsed incrementally. */
function startHostChild(home, env, { command = 'start', extraArgs = [] } = {}) {
  const args = [MAIN, command, '--home', home];
  if (command === 'start') args.push('--model', 'w0-fence-probe', '--heading', 'Fence smoke.');
  args.push(...extraArgs);
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  const fences = [];
  let parks = 0;
  let rawStderr = '';
  let buffer = '';
  const handle = (line) => {
    if (line.trim() === '') return;
    try {
      const entry = JSON.parse(line);
      logs.push(entry);
      if (entry.event === 'host/fence') fences.push(entry);
      if (entry.event === 'host/parked') parks += 1;
    } catch {
      rawStderr += `${line}\n`;
    }
  };
  child.stderr.on('data', (chunk) => {
    buffer += String(chunk);
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) handle(line);
  });
  child.stdout.on('data', () => {});
  const exited = once(child, 'exit').then(([code]) => code);
  return {
    child, logs, fences, get parks() { return parks; }, exited,
    get rawStderr() { return rawStderr; },
    stop() {
      const outcome = spawnSync(process.execPath, [MAIN, 'pause', '--home', home], {
        encoding: 'utf8', timeout: 40_000,
      });
      if (outcome.status !== 0 && outcome.status !== 3) {
        throw new Error(`pause exited ${outcome.status}: ${outcome.stderr}`);
      }
    },
  };
}

/** A human (foreign) commit in the cell's world; the node wakes on it. */
function foreignCommit(home, name, subject) {
  const world = join(home, 'world');
  const gitDir = join(home, 'world.git');
  writeFileSync(join(world, name), 'x\n');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'human', GIT_AUTHOR_EMAIL: 'human@world.local',
    GIT_COMMITTER_NAME: 'human', GIT_COMMITTER_EMAIL: 'human@world.local',
  };
  execFileSync('git', ['--git-dir', gitDir, '--work-tree', world, 'add', '--all'], { env });
  execFileSync(
    'git', ['--git-dir', gitDir, '--work-tree', world, 'commit', '--quiet', '-m', subject], { env },
  );
}

function headHas(home, name) {
  try {
    execFileSync('git', [
      '--git-dir', join(home, 'world.git'), '--work-tree', join(home, 'world'), 'show', `HEAD:${name}`,
    ], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Starts a writer appending one line per 2 ms and joins it into `leaf`. */
async function startWriter(leaf, counter) {
  await mkdir(leaf, { recursive: true });
  const script = [
    "const fs=require('node:fs');",
    `const p=${JSON.stringify(counter)};`,
    "setInterval(()=>{try{fs.appendFileSync(p,'x\\n')}catch{}},2);",
  ].join('');
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('writer did not spawn');
  await writeFile(join(leaf, 'cgroup.procs'), String(pid));
  await waitFor(async () => {
    const own = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => '');
    return own.trim().endsWith(`/${leaf.split('/').pop()}`);
  }, 5000, 'writer joined the node leaf');
  return child;
}

async function releaseCell(root) {
  const leaf = nodeLeaf(root, 'node-0');
  await thawSet([leaf]);
  await killLeaves([leaf]);
  await rmdir(leaf).catch(() => {});
  // The kernel's self-move leaf and the root itself; a failed crash recovery
  // must not leave an es-<hash> tree behind for the next operator.
  await detachCell(root);
}

async function freezeAvailable() {
  const anchor = resolveAnchor();
  if (anchor === null) return false;
  const probe = join(anchor, `.es-fence-smoke-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    await mkdir(probe);
    await writeFile(join(probe, 'cgroup.freeze'), '0');
    await readFile(join(probe, 'cgroup.events'), 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    await rmdir(probe).catch(() => {});
  }
}

// --- scenario 1: the fence across 20 driven turns -----------------------------

async function scenarioTurns(shimDir) {
  const home = await makeCellHome();
  const provider = await serveProvider((index) => {
    if (index === 0) return content('idle');
    return index % 2 === 1 ? execute('printf x >> ticks.txt', index) : content('idle');
  });
  const root = join(resolveAnchor(), cellUnitName(home));
  const leaf = nodeLeaf(root, 'node-0');
  const counter = join(home, 'world', 'counter.log');
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` };
  let host;
  let writer = null;
  try {
    writeProviders(home, provider.url);
    host = startHostChild(home, env);
    await waitFor(() => host.parks >= 1 && host.logs.some((e) => e.event === 'host/boot'), 25_000,
      'the boot turn to park');
    // The boot turn had no shell and no Run: the fence created and froze an
    // EMPTY node leaf, and the commit was not refused.
    assert.equal(host.fences.length, 1, 'one fence around the boot commit');
    assert.equal(host.fences[0].state, 'fenced', 'the boot commit is fenced');
    assert.ok(host.fences[0].leaves >= 1, 'the empty node leaf was frozen');
    await waitFor(() => existsSync(leaf), 5000, 'the node leaf');
    assert.equal(readFileSync(join(leaf, 'cgroup.procs'), 'utf8').trim(), '',
      'the boot-turn leaf is empty before any shell');
    assert.equal((await readWorldState(home)).degraded, false, 'no refusal at boot');
    assert.equal(host.logs.some((e) => e.event === 'host/degraded'), false,
      'no degraded attach in this scenario');

    writer = await startWriter(leaf, counter);
    const samples = [];
    for (let turn = 0; turn < TURNS; turn += 1) {
      const fencesBefore = host.fences.length;
      const parksBefore = host.parks;
      foreignCommit(home, `human-${turn}.txt`, `human turn ${turn}`);
      await waitFor(() => host.fences.length > fencesBefore, 20_000, `fence ${turn}`);
      const entry = host.fences.at(-1);
      assert.equal(entry.state, 'fenced', `turn ${turn} fence engaged`);
      const before = countLines(counter);
      await sleep(60);
      const after = countLines(counter);
      assert.equal(after, before,
        `turn ${turn}: the writer advanced inside the fence (${before} -> ${after})`);
      samples.push({ before, after });
      await waitFor(() => host.parks > parksBefore, 20_000, `park ${turn}`);
      await waitFor(() => countLines(counter) > before, 5000,
        `turn ${turn}: the writer resumed after release`);
    }
    assert.equal(samples.length, TURNS, 'every driven turn sampled');
    assert.equal(host.fences.length, TURNS + 1,
      `every commit engaged the fence (${host.fences.length} fences)`);
    assert.ok(host.fences.every((entry) => entry.state === 'fenced'),
      'no commit was refused: the fence never failed');
    assert.ok(host.fences.every((entry) => entry.leaves >= 1),
      'every fence froze at least the node leaf');
    assert.equal((await readWorldState(home)).degraded, false, 'the world stayed healthy');
    assert.ok(headHas(home, 'ticks.txt'), 'the shell turns committed their world files');
    host.stop();
    assert.equal(await host.exited, 0, 'the host stops cleanly');
  } finally {
    if (host !== undefined && host !== null && host.child.exitCode === null) {
      host.child.kill('SIGKILL');
    }
    if (writer !== null) writer.kill('SIGKILL');
    await releaseCell(root);
    await rmdir(root).catch(() => {});
    await provider.server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

// --- scenario 2: a freeze failure refuses, thaws, and the shell answers ------

async function scenarioThawOnFailure() {
  const home = await mkdtemp(join(tmpdir(), 'es-w0-fence-thaw-'));
  const fakeRoot = await mkdtemp(join(tmpdir(), 'es-w0-fence-fakefs-'));
  const provider = await serveProvider((index) => {
    if (index === 0) return execute('printf one > before.txt', index);
    if (index === 1) return content('idle');
    if (index === 2) return execute('printf two > after.txt', index);
    return content('idle');
  });
  const lines = [];
  const log = createHostLog((line) => lines.push(line));
  const fakeLeaf = nodeLeaf(fakeRoot, 'node-0');
  let cell = null;
  try {
    await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
    const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
    const seed = await world.headHash();
    await mkdir(fakeLeaf, { recursive: true });
    // A cgroupfs-shaped leaf whose `frozen` bit never lands: the LIMITS freeze
    // deadline expires, the port thaws, and the driver refuses typed.
    await writeFile(join(fakeLeaf, 'cgroup.events'), 'frozen 0\n');
    const realPort = createFencePort({ root: fakeRoot, uid: 'node-0', log });
    // Every acquire goes through the REAL port; only the fake leaf's frozen bit
    // is scripted — first it never lands (the failure), then it does.
    const port = {
      acquire: () => realPort.acquire(),
      release: () => realPort.release(),
    };
    const config = validateAgentConfig({
      ...defaultAgentConfig(), model: 'first-light-test', heading: 'Fence thaw.',
    });
    cell = await composeCell({
      home, uid: 'node-0', config,
      credential: { endpoint: provider.url, key: 'sentinel-llm-key', credentialId: 'llm' },
      providers: {}, sandbox: false, pollMs: 25, log, fence: port,
    });
    const running = cell.driver.run();
    await waitFor(() => cell.driver.state === 'waiting', 20_000, 'the refused turn to park');
    assert.ok(lines.some((line) => line.includes('"event":"host/fence"')
      && line.includes('"state":"freeze-failed"')), 'the port logged the freeze failure');
    assert.equal(readFileSync(join(fakeLeaf, 'cgroup.freeze'), 'utf8').trim(), '0',
      'the failed fence thawed the fake leaf');
    assert.equal(readFileSync(join(world.path, 'before.txt'), 'utf8'), 'one',
      'the shell ran before the refusal');
    assert.equal((await readWorldState(home)).degraded, true, 'the refusal degraded the sidecar');
    assert.equal(await world.headHash(), seed, 'the refused commit published nothing');

    // A foreign commit wakes the node; the next shell turn answers and its
    // commit sweeps in the refused turn's write. The fake leaf's frozen bit now
    // lands, so the second acquire really fences (and really logs).
    await writeFile(join(fakeLeaf, 'cgroup.events'), 'frozen 1\n');
    await foreignCommit(home, 'human.txt', 'human wake');
    await HeadWatcher.for(world).check();
    await waitFor(async () => (await world.commitsForTurn(seed, 'node-0', 1)).length === 1,
      20_000, 'the second turn to commit');
    assert.equal(readFileSync(join(world.path, 'before.txt'), 'utf8'), 'one');
    assert.equal(readFileSync(join(world.path, 'after.txt'), 'utf8'), 'two',
      'the shell answered after the refusal');
    assert.equal((await readWorldState(home)).degraded, false,
      'the successful commit cleared the sidecar');
    assert.ok(headHas(home, 'before.txt') && headHas(home, 'after.txt'),
      'both turns were attributed by the later commit');
    assert.ok(lines.filter((line) => line.includes('"event":"host/fence"')
      && line.includes('"state":"fenced"')).length >= 1, 'a later commit was fenced');
    cell.driver.stop('stop-requested');
    await running;
    await cell.close();
    cell = null;
  } finally {
    if (cell !== null) {
      cell.driver.stop('stop-requested');
      await cell.driver.run().catch(() => {});
      await cell.close().catch(() => {});
    }
    await provider.server.close();
    await rm(fakeRoot, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

// --- scenario 3: SIGKILL inside the freeze, same-shape boot thaws ------------

async function scenarioCrashInsideFreeze() {
  const home = await makeCellHome();
  let executeCount = 0;
  const provider = await serveProvider((index) => {
    if (index % 2 === 0) {
      executeCount += 1;
      return execute(`printf alive > alive-${executeCount}.txt`, index);
    }
    return content('idle');
  });
  const root = join(resolveAnchor(), cellUnitName(home));
  const leaf = nodeLeaf(root, 'node-0');
  let host = null;
  let second = null;
  try {
    writeProviders(home, provider.url);
    host = startHostChild(home, process.env);
    await waitFor(() => host.parks >= 1, 25_000, 'the first boot to park');
    assert.ok(headHas(home, 'alive-1.txt'), 'the first shell answered');
    await waitFor(() => existsSync(leaf), 5000, 'the node leaf');
    // Freeze the leaf ourselves — the exact on-disk state a crash between the
    // fence's freeze and its release leaves behind.
    await writeFile(join(leaf, 'cgroup.freeze'), '1');
    await waitFor(async () => /^\s*frozen\s+1\s*$/mu.test(
      await readFile(join(leaf, 'cgroup.events'), 'utf8')), 5000, 'the leaf to freeze');
    const pid = host.child.pid;
    process.kill(pid, 'SIGKILL');
    await host.exited;
    assert.equal((await readFile(join(leaf, 'cgroup.freeze'), 'utf8')).trim(), '1',
      'the freeze bit survives the SIGKILL (the crash residual)');

    // SAME launch shape (direct, same home): boot hygiene must thaw and kill the
    // stale leaf before this boot, and the new shell must answer.
    second = startHostChild(home, process.env, { command: 'resume' });
    await waitFor(() => second.parks >= 1, 25_000, 'the second boot to park');
    assert.ok(second.logs.some((entry) => entry.event === 'host/boot' && entry.fence === 'available'),
      'the same-shape boot reports fence=available');
    assert.ok(headHas(home, 'alive-2.txt'), 'the shell answered after the crash-inside-freeze boot');
    const freeze = existsSync(join(leaf, 'cgroup.freeze'))
      ? readFileSync(join(leaf, 'cgroup.freeze'), 'utf8').trim()
      : '0';
    assert.equal(freeze, '0', 'the stale leaf was thawed by boot hygiene');
    second.stop();
    assert.equal(await second.exited, 0, 'the second host stops cleanly');
  } finally {
    if (host !== null && host.child.exitCode === null) host.child.kill('SIGKILL');
    if (second !== null && second.child.exitCode === null) second.child.kill('SIGKILL');
    await releaseCell(root);
    await rmdir(root).catch(() => {});
    await provider.server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

// --- scenario 4: an unfenced host is a visible, durable fact ------------------

async function scenarioUnfenced() {
  const home = await makeCellHome();
  const provider = await serveProvider((index) => {
    if (index === 0) return execute('printf off > off.txt', index);
    return content('idle');
  });
  let host = null;
  try {
    writeProviders(home, provider.url);
    host = startHostChild(home, process.env, { extraArgs: ['--no-sandbox'] });
    await waitFor(() => host.parks >= 1 && host.logs.some((entry) => entry.event === 'host/boot'),
      25_000, 'the unfenced host to park');
    const boot = host.logs.find((entry) => entry.event === 'host/boot');
    assert.equal(boot.fence, 'unavailable', 'the boot line carries fence=unavailable');
    assert.equal(host.fences.length, 0, 'no fence port ran on an off cell');
    assert.ok(headHas(home, 'off.txt'), 'the unfenced commit still landed');
    const owner = JSON.parse(readFileSync(join(home, 'host.json'), 'utf8'));
    assert.equal(owner.fence, 'unavailable', 'the owner record carries the fact');
    const statusJson = spawnSync(process.execPath, [MAIN, 'status', '--home', home, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(statusJson.status, 0, `status --json exited ${statusJson.status}`);
    const report = JSON.parse(statusJson.stdout);
    assert.equal(report.host.state, 'running');
    assert.equal(report.host.fence, 'unavailable', 'status --json carries host.fence');
    const statusHuman = spawnSync(process.execPath, [MAIN, 'status', '--home', home], {
      encoding: 'utf8',
    });
    assert.equal(statusHuman.status, 0);
    assert.ok(statusHuman.stdout.includes('fence=unavailable'),
      'the human host line carries fence=unavailable');
    host.stop();
    assert.equal(await host.exited, 0, 'the unfenced host stops cleanly');
  } finally {
    if (host !== null && host.child.exitCode === null) host.child.kill('SIGKILL');
    await provider.server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  if (!existsSync(MAIN)) {
    console.error('w0 fence smoke: dist is missing; run `npm run build` first');
    process.exitCode = 1;
    return;
  }
  if (!(await freezeAvailable())) {
    console.log('w0 fence smoke: skipped (cgroup v2 freeze/kill unavailable)');
    return;
  }
  const shimDir = mkdtempSync(join(tmpdir(), 'es-w0-fence-shim-'));
  writeGitShim(shimDir);
  const ran = [];
  try {
    await scenarioTurns(shimDir);
    ran.push(`turns=${TURNS}`);
    await scenarioThawOnFailure();
    ran.push('thaw-on-failure');
    await scenarioCrashInsideFreeze();
    ran.push('crash-inside-freeze');
    await scenarioUnfenced();
    ran.push('unfenced');
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
  console.log(`w0 fence smoke: ok (${ran.join(', ')})`);
}

main().catch((err) => {
  console.error(`w0 fence smoke: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
