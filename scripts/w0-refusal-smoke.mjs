// The compiled C1 refusal smoke: a real cell, a real Git world, the real
// journals, a loopback fake provider. It proves the refusal path end to end:
// a chmod-000 file planted in the world makes a turn's commit refuse; the turn
// ends `waiting`, the kernel is alive with no fault event, `status` is degraded
// (exit 1 from the world sidecar alone: the host's explicit `--no-sandbox`
// opt-out is not a degradation, and storage=unquoted is normal), the next
// turn's model-visible context carries
// the bounded refusal line exactly once, and the node's OWN shell removes the
// blocker and writes, so the next turn's real commit — not a no-op attempt —
// clears the sidecar. It then plants an interrupted turn plus the same damage,
// resumes, asserts the boot reconcile refuses without wedging the home (the
// synthetic closer has no commit and the host boots), and lets the resumed
// node's shell repair it, with a second real commit advancing HEAD.
//
// Output contract: exactly `w0-refusal smoke: ok` on stdout, exit 0, whole run
// <= 180 s. On failure: `w0-refusal smoke: <label>: <message>`, the child's last
// 20 stderr lines (never request bodies) and exit 1. The fake key exists only in
// providers.json and the Authorization header; request bodies stay in memory.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { JournalWriter } from '../dist/journal/index.js';
import { C13_EVENT_TYPES } from '../dist/context/events.js';
import { loadVerifiedEvents } from '../dist/context/loader.js';
import { readWorldState } from '../dist/node/world-state.js';

const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));
const FAKE_KEY = 'w0-refusal-fake-key-3a5c9e11';
const UID = 'node-0';
const POLL_MS = 50;
const WAIT_MS = 20_000;

/** The only place the default reply text is spelled. */
const DEFAULT_TEXT_REPLY = { choices: [{ message: { role: 'assistant', content: 'idle' } }] };

const homes = [];
const liveChildren = new Set();
const liveServers = new Set();
let lastChild = null;

// --- small utilities -----------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function bounded(text, limit = 400) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function git(home, args) {
  return execFileSync('git', [
    '--git-dir', join(home, 'world.git'),
    '--work-tree', join(home, 'world'),
    ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function runCli(args) {
  const result = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8', timeout: 30_000,
  });
  return {
    code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
  };
}

async function newHome() {
  const home = await mkdtemp(join(tmpdir(), 'w0-refusal-'));
  homes.push(home);
  return home;
}

async function writeProviders(home, port) {
  const path = join(home, 'providers.json');
  await writeFile(path, JSON.stringify({
    llm: { key: FAKE_KEY, endpoint: `http://127.0.0.1:${port}/v1/chat/completions` },
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

const assistantText = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
const assistantTool = (name, args) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
  }],
});

/**
 * The shell command the node runs to recover: it removes the planted blockers
 * itself (the harness never repairs the world after the plant) and appends a
 * line, so the turn's commit is real and non-empty. Both names are removed
 * unconditionally; only one exists in each phase.
 */
const RECOVERY_CMD = "rm -f blocked.txt blocked2.txt; printf 'recovered\\n' >> recovered.txt";

/**
 * The loopback fake provider. Any request whose body carries the refusal line
 * is a recovery turn: it answers with one `execute` call, delayed so the status
 * read happens while the turn is in flight rather than after its commit. Every
 * other request answers text. Bodies stay in memory and are never printed.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const requests = [];
    // One armed recovery per phase: the first carrier request repairs, and the
    // chained turn that follows gets text (the carrier stays in history, so an
    // unconditional execute would loop). The smoke re-arms before the resume.
    let recoveryArmed = true;
    // The armed recovery reply is HELD, not delayed: the smoke observes
    // `pending`, reads status while the turn is in flight, then releases it.
    // That makes the ordering a proof, not a race against a timer.
    let held = null;
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ body, authorization: req.headers.authorization ?? null });
        if (recoveryArmed && body.includes('commit refused')) {
          recoveryArmed = false;
          held = {
            res,
            payload: JSON.stringify(assistantTool('execute', { cmd: RECOVERY_CMD })),
          };
          return;
        }
        const payload = JSON.stringify(DEFAULT_TEXT_REPLY);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        });
        res.end(payload);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      liveServers.add(server);
      resolve({
        server,
        port: server.address().port,
        requests,
        armRecovery: () => { recoveryArmed = true; },
        get pending() { return held !== null; },
        releaseRecovery: () => {
          const reply = held;
          held = null;
          if (reply === null || reply.res.destroyed) return;
          reply.res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(reply.payload)),
          });
          reply.res.end(reply.payload);
        },
      });
    });
  });
}

function stopServer(handle) {
  if (handle === null) return;
  handle.server.close();
  handle.server.closeAllConnections();
  liveServers.delete(handle.server);
}

// --- the host child and its stderr JSONL capture -------------------------------

function spawnHost(args) {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  const capture = { lines: [], tail: [], events: [], exitCode: undefined };
  child.smoke = capture;
  let pending = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    pending += chunk;
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl < 0) break;
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line === '') continue;
      capture.lines.push(line);
      capture.tail.push(line);
      if (capture.tail.length > 20) capture.tail.shift();
      try { capture.events.push(JSON.parse(line)); } catch { /* not JSONL */ }
    }
  });
  child.on('exit', (code) => { capture.exitCode = code; liveChildren.delete(child); });
  liveChildren.add(child);
  lastChild = child;
  return child;
}

const sawEvent = (child, name) => child.smoke.events.some((event) => event.event === name);
const bootLine = (child) => child.smoke.events.find((event) => event.event === 'host/boot');

const redactedTail = (lines) => lines.map((line) => (line.includes(FAKE_KEY) ? '<redacted>' : line));

function tailText(child) {
  return child === null || child.smoke === undefined
    ? ''
    : `\nhost stderr (last ${child.smoke.tail.length} lines):\n${redactedTail(child.smoke.tail).join('\n')}`;
}

async function waitFor(pred, { child, timeoutMs = WAIT_MS, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (child !== undefined && child.smoke.exitCode !== undefined) {
      throw new Error(`${label}: host exited with code ${child.smoke.exitCode}${tailText(child)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timed out after ${timeoutMs} ms${tailText(child)}`);
    }
    await sleep(POLL_MS);
  }
}

async function waitDone(child) {
  await once(child, 'close');
}

async function localEvents(home) {
  return await loadVerifiedEvents(home, UID, C13_EVENT_TYPES);
}

/** A live-writer read can lose a race with a batch write; retry rather than flake. */
async function stableEvents(home) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await localEvents(home);
    } catch {
      await sleep(POLL_MS);
    }
  }
  return await localEvents(home);
}

async function hasRefusal(home) {
  try {
    return (await localEvents(home)).some((event) => event.type === 'world/commit-refused');
  } catch {
    return false;
  }
}

/** HEAD, or null on an unborn branch (the first start's baseline). */
function tryHead(home) {
  try {
    return git(home, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

function statusReport(home, acceptable) {
  const result = runCli(['status', '--home', home, '--json']);
  assert.ok(acceptable.includes(result.code),
    `status exited ${result.code}: ${bounded(result.stderr)}`);
  return JSON.parse(result.stdout);
}

/**
 * One plant: a TRACKED unreadable file makes `git add --all` exit 128. It must
 * be tracked: an untracked unreadable file is the doctor's quarantine case
 * (moved aside at boot, which would let the commit succeed), while a tracked
 * one is only REPORTED — the doctor never moves it — so the refusal path is
 * exercised deterministically.
 */
async function plantUnreadableTracked(home, rel) {
  const path = join(home, 'world', rel);
  await writeFile(path, 'unreadable');
  git(home, ['add', '--', rel]);
  git(home, [
    '-c', 'user.name=harness', '-c', 'user.email=harness@world.local',
    'commit', '--quiet', '--message', `plant ${rel}`,
  ]);
  await chmod(path, 0o000);
}

// --- the scenario ---------------------------------------------------------------

async function main() {
  const home = await newHome();
  let server = null;
  let child = null;
  try {
    const init = runCli(['init', '--home', home]);
    assert.equal(init.code, 0, `init failed: ${bounded(init.stderr)}`);
    server = await startServer();
    await writeProviders(home, server.port);

    // 1. Plant the damage, start the cell, and wait for the refused turn. The
    //    precondition is asserted before the kernel can act: the file exists,
    //    is unreadable, and the world starts healthy (no sidecar). The harness
    //    never repairs the world: the node's own shell does, in the retry turn.
    const blocked = join(home, 'world', 'blocked.txt');
    await plantUnreadableTracked(home, 'blocked.txt');
    assert.equal((await lstat(blocked)).mode & 0o777, 0o000, 'the planted file is unreadable');
    assert.equal((await readWorldState(home)).degraded, false, 'the home starts healthy');
    const headBefore = tryHead(home);
    child = spawnHost(['start', '--home', home, '--model', 'w0-refusal-test',
      '--heading', 'Refusal smoke.', '--no-sandbox']);
    await waitFor(() => hasRefusal(home),
      { child, label: 'the first turn records a refusal' });

    const refused = await stableEvents(home);
    const endIndex = refused.findIndex((event) => event.type === 'turn/end');
    const refusalIndex = refused.findIndex((event) => event.type === 'world/commit-refused');
    assert.ok(endIndex >= 0 && refusalIndex === endIndex + 1,
      'the refusal event follows the closer in the local log');
    const end = refused[endIndex];
    assert.equal(end.data.outcome, 'waiting', 'the refused turn ends waiting');
    assert.equal('commit' in end.data, false, 'a refused turn names no commit');
    const refusal = refused[refusalIndex];
    assert.equal(refusal.ignorable, true, 'the refusal event is ignorable');
    assert.equal(refusal.data.refusal.reason, 'git-exit', 'the refusal reason is git-exit');

    // 2. The retry turn is in flight and its recovery reply is HELD: the
    //    operator status reads below therefore happen before the recovery
    //    commit, deterministically (no sleep, no race with a timer).
    await waitFor(() => server.pending, { child, label: 'the retry turn is in flight' });

    // 3. The kernel is alive, no fault event was logged, and status is
    //    degraded, exiting 1 for the sidecar alone (the host's explicit
    //    --no-sandbox opt-out never degrades the exit).
    assert.equal(child.smoke.exitCode, undefined, 'the kernel must not exit on a refusal');
    assert.ok(child.pid !== undefined, 'the kernel has a pid');
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'the kernel process is alive');
    for (const name of ['host/error', 'driver/error']) {
      assert.equal(child.smoke.events.some((event) => event.event === name), false,
        `no ${name} event on a refusal`);
    }
    const degraded = statusReport(home, [1]);
    assert.equal(degraded.world.state, 'degraded', 'status world state is degraded');
    assert.equal(degraded.world.reason, 'git-exit', 'status carries the refusal reason');
    assert.equal(degraded.frontier.error, null, 'the exit 1 is the sidecar, not the frontier');
    assert.equal(degraded.world.error, null, 'the exit 1 is the sidecar, not the world read');
    const human = runCli(['status', '--home', home]);
    assert.equal(human.code, 1, 'the human degraded report exits 1');
    assert.equal(server.pending, true, 'the recovery reply is still held');
    assert.ok(human.stdout.includes('world-state: degraded reason=git-exit'),
      'the human report names the degraded world');

    // 4. The next turn's model-visible context carries the bounded system line
    //    exactly once: one durable group, one occurrence. This script is a
    //    manual acceptance artifact (run after `npm run build`); it is
    //    deliberately not wired to an npm script.
    const carrier = server.requests.find((request) => request.body.includes('commit refused'));
    assert.ok(carrier !== undefined, 'the retry turn request is present');
    const messages = JSON.parse(carrier.body).messages;
    const carriers = messages.filter((message) => message.role === 'system'
      && message.content.startsWith('commit refused ('));
    assert.equal(carriers.length, 1,
      'the next turn sees the refusal carrier exactly once');
    assert.match(carriers[0].content, /^commit refused \(git-exit\): /,
      'the carrier names the cause');
    assert.equal(carriers[0].content.includes('\n'), false, 'the carrier is one line');
    const occurrences = messages.reduce((total, message) => total
      + (typeof message.content === 'string'
        ? (message.content.match(/commit refused/g) ?? []).length : 0), 0);
    assert.equal(occurrences, 1, 'the carrier phrase occurs exactly once in the request');

    // 5. Release the held recovery: the node's own shell removes the blocker
    //    and writes, so the retry turn's commit is real; that commit — not a
    //    no-op attempt — clears the sidecar, and its closer joins the hash.
    server.releaseRecovery();
    await waitFor(() => {
      try {
        return git(home, ['log', '-1', '--format=%an%x00%s']).trim() === 'node-0\0turn 1';
      } catch {
        return false;
      }
    }, { child, label: 'the retry turn commits after the shell repair' });
    assert.equal(await readFile(join(home, 'world', 'recovered.txt'), 'utf8'), 'recovered\n',
      'the shell repair wrote a world file');
    const headAfter = git(home, ['rev-parse', 'HEAD']).trim();
    assert.notEqual(headAfter, headBefore, 'a real commit moved HEAD');
    const recoveryEnd = (await stableEvents(home)).filter((event) => event.type === 'turn/end'
      && 'commit' in event.data).pop();
    assert.equal(recoveryEnd.data.commit, headAfter, 'the closer joins the commit hash');
    await waitFor(async () => (await readWorldState(home)).degraded === false,
      { child, label: 'the sidecar clears on a successful commit' });
    // The world sidecar is what must read healthy here; a clean fenced cell
    // would exit 0 on the same storage=unquoted fact.
    // Absent, not merely healthy: a malformed file would also read healthy.
    await assert.rejects(lstat(join(home, 'world-state.json')), /ENOENT/,
      'the sidecar file is removed');
    const healthy = statusReport(home, [0]);
    assert.equal(healthy.world.state, 'healthy', 'status is healthy after the commit');
    assert.equal(healthy.world.error, null, 'the healthy report has no world error');

    // 5. Pause, then plant an interrupted turn and resume: the boot reconcile
    //    must refuse, write the synthetic closer WITHOUT a commit, and boot.
    const exited = once(child, 'exit');
    const pause = runCli(['pause', '--home', home]);
    assert.equal(pause.code, 0, `pause failed: ${bounded(pause.stderr)}`);
    const [pauseCode] = await exited;
    assert.equal(pauseCode, 0, 'the paused host exits 0');
    await waitDone(child);

    // The tracked blocker must be in place before the opening range is captured.
    await plantUnreadableTracked(home, 'blocked2.txt');
    const head = git(home, ['rev-parse', 'HEAD']).trim();
    const writer = await JournalWriter.open(home, UID);
    writer.append('turn/start', {
      turn: 2, trigger: 'wakeup', world: { from: head, to: head },
    });
    await writer.flush();
    await writer.close();

    const blocked2 = join(home, 'world', 'blocked2.txt');
    assert.equal((await lstat(blocked2)).mode & 0o777, 0o000,
      'the boot-phase file is unreadable');
    server.armRecovery();
    child = spawnHost(['resume', '--home', home, '--no-sandbox']);
    await waitFor(() => sawEvent(child, 'host/boot'), { child, label: 'the damaged home boots' });
    const boot = bootLine(child);
    assert.ok(boot !== undefined, 'the boot line is present');
    assert.equal(boot.world, 'degraded', 'the boot line carries the replayed sidecar');

    const resumed = await stableEvents(home);
    const synthetic = resumed.find((event) => event.type === 'turn/end'
      && event.data.synthetic === true && event.data.turn === 2);
    assert.ok(synthetic !== undefined, 'the interrupted turn is closed synthetically');
    assert.equal(synthetic.data.outcome, 'interrupted', 'the synthetic closer is interrupted');
    assert.equal('commit' in synthetic.data, false, 'the refused recovery names no commit');
    assert.ok(resumed.some((event) => event.type === 'world/commit-refused'
      && event.data.turn === 2), 'the boot refusal is recorded');
    await waitFor(async () => (await readWorldState(home)).degraded === true,
      { child, label: 'the boot refusal sets the sidecar' });
    // The resumed node's first turn is in flight with its recovery reply held:
    // the status read observes the booted degraded state before that commit.
    await waitFor(() => server.pending, { child, label: 'the resumed turn is in flight' });
    const degradedAgain = statusReport(home, [1]);
    assert.equal(degradedAgain.world.state, 'degraded', 'the booted home is degraded');
    assert.equal(degradedAgain.frontier.error, null, 'the booted exit 1 is the sidecar');
    assert.equal(degradedAgain.world.error, null, 'the booted exit 1 is not a world read');
    assert.equal(server.pending, true, 'the resumed recovery reply is still held');
    server.releaseRecovery();

    // 6. The resumed node's own shell repairs the world in its first turn; a
    //    real commit (not a no-op attempt) clears the sidecar and advances HEAD.
    await waitFor(() => {
      try {
        return git(home, ['rev-parse', 'HEAD']).trim() !== head;
      } catch {
        return false;
      }
    }, { child, label: 'the resumed home commits after its shell repair' });
    const recoveredLines = (await readFile(join(home, 'world', 'recovered.txt'), 'utf8'))
      .trim().split('\n');
    assert.ok(recoveredLines.length >= 2, 'the resumed turn appended to recovered.txt');
    await waitFor(async () => (await readWorldState(home)).degraded === false,
      { child, label: 'the resumed home clears the sidecar on a real commit' });
    await assert.rejects(lstat(join(home, 'world-state.json')), /ENOENT/,
      'the resumed sidecar file is removed');
    const healthyAgain = statusReport(home, [0]);
    assert.equal(healthyAgain.world.state, 'healthy',
      'the resumed home is healthy after the commit');

    const exitedAgain = once(child, 'exit');
    const pauseAgain = runCli(['pause', '--home', home]);
    assert.equal(pauseAgain.code, 0, `second pause failed: ${bounded(pauseAgain.stderr)}`);
    const [resumeCode] = await exitedAgain;
    assert.equal(resumeCode, 0, 'the resumed host exits 0');
    await waitDone(child);
  } finally {
    if (child !== null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    stopServer(server);
  }
}

// The global watchdog: an unref'd 175 s timer that kills every live host and
// fails with a label. `process.exit` skips the top-level finally, so cleanup
// runs here first.
const watchdog = setTimeout(() => {
  for (const child of [...liveChildren]) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  for (const server of [...liveServers]) {
    try { server.close(); server.closeAllConnections(); } catch { /* closed */ }
  }
  for (const home of homes) { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } }
  console.error(`w0-refusal smoke: watchdog fired at 175 s${tailText(lastChild)}`);
  process.exit(1);
}, 175_000);
watchdog.unref();

try {
  await main();
  console.log('w0-refusal smoke: ok');
} catch (err) {
  console.error(`w0-refusal smoke: ${err instanceof Error ? err.message : String(err)}${tailText(lastChild)}`);
  process.exitCode = 1;
} finally {
  for (const child of [...liveChildren]) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  for (const server of [...liveServers]) {
    try { server.close(); server.closeAllConnections(); } catch { /* closed */ }
  }
  for (const home of homes) { await rm(home, { recursive: true, force: true }).catch(() => {}); }
}
