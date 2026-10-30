// The compiled C1 refusal smoke: a real cell, a real Git world, the real
// journals, a loopback fake provider. It proves the refusal path end to end:
// a chmod-000 file planted in the world makes a turn's commit refuse; the turn
// ends `waiting`, the kernel stays alive, `status` is degraded (exit 1), the
// next turn's model-visible context carries the bounded refusal line, and a
// later turn commits and clears the sidecar. It then plants an interrupted turn
// plus the same damage, resumes, and asserts the boot reconcile refuses without
// wedging the home (the synthetic closer has no commit and the host boots).
//
// Output contract: exactly `w0-refusal smoke: ok` on stdout, exit 0, whole run
// <= 180 s. On failure: `w0-refusal smoke: <label>: <message>`, the child's last
// 20 stderr lines (never request bodies) and exit 1. The fake key exists only in
// providers.json and the Authorization header; request bodies stay in memory.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
 * The loopback fake provider. The first request whose body carries the refusal
 * line is the retry turn: it answers with one `execute` call that writes
 * `second.txt`, so that turn's commit is a real non-empty commit. Every other
 * request answers text. Bodies stay in memory and are never printed.
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const requests = [];
    let retryServed = false;
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ body, authorization: req.headers.authorization ?? null });
        let reply;
        if (!retryServed && body.includes('commit refused')) {
          retryServed = true;
          reply = assistantTool('execute', { cmd: "printf 'second\\n' > second.txt" });
        } else {
          reply = DEFAULT_TEXT_REPLY;
        }
        const payload = JSON.stringify(reply);
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
      resolve({ server, port: server.address().port, requests });
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

function statusReport(home, acceptable) {
  const result = runCli(['status', '--home', home, '--json']);
  assert.ok(acceptable.includes(result.code),
    `status exited ${result.code}: ${bounded(result.stderr)}`);
  return JSON.parse(result.stdout);
}

/** The exact command that repairs the world: restore the mode, then remove. */
async function unblock(path) {
  await chmod(path, 0o600).catch(() => {});
  await rm(path, { force: true }).catch(() => {});
}

/** One plant: an untracked unreadable file makes `git add --all` exit 128. */
async function plantUnreadable(path) {
  await writeFile(path, 'unreadable');
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

    // 1. Plant the damage, start the cell, and wait for the refused turn.
    const blocked = join(home, 'world', 'blocked.txt');
    await plantUnreadable(blocked);
    child = spawnHost(['start', '--home', home, '--model', 'w0-refusal-test',
      '--heading', 'Refusal smoke.', '--no-sandbox']);
    await waitFor(() => hasRefusal(home),
      { child, label: 'the first turn records a refusal' });

    // Repair immediately: the bounded retry (1 s) is the second turn.
    await unblock(blocked);

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

    // 2. The kernel is alive and status says degraded, exiting 1.
    assert.equal(child.smoke.exitCode, undefined, 'the kernel must not exit on a refusal');
    const degraded = statusReport(home, [1]);
    assert.equal(degraded.world.state, 'degraded', 'status world state is degraded');
    assert.equal(degraded.world.reason, 'git-exit', 'status carries the refusal reason');
    const human = runCli(['status', '--home', home]);
    assert.equal(human.code, 1, 'the human degraded report exits 1');
    assert.ok(human.stdout.includes('world-state: degraded reason=git-exit'),
      'the human report names the degraded world');

    // 3. The next turn's model-visible context carries the bounded system line
    //    exactly once: the carrier is one durable group, not a line re-rendered
    //    or duplicated per turn. This script is a manual acceptance artifact
    //    (run after `npm run build`); it is deliberately not wired to an npm
    //    script.
    await waitFor(() => server.requests.some((request) => request.body.includes('commit refused')),
      { child, label: 'the retry turn is sent' });
    const carrier = server.requests.find((request) => request.body.includes('commit refused'));
    const messages = JSON.parse(carrier.body).messages;
    const carriers = messages.filter((message) => message.role === 'system'
      && message.content.includes('commit refused (git-exit)'));
    assert.equal(carriers.length, 1,
      'the next turn sees the refusal carrier exactly once');

    // 4. The second turn commits; the sidecar is cleared by the success.
    await waitFor(() => {
      try {
        return git(home, ['log', '-1', '--format=%an%x00%s']).trim() === 'node-0\0turn 1';
      } catch {
        return false;
      }
    }, { child, label: 'the second turn commits' });
    assert.equal(await readFile(join(home, 'world', 'second.txt'), 'utf8'), 'second\n',
      'the second turn wrote its world file');
    await waitFor(async () => (await readWorldState(home)).degraded === false,
      { child, label: 'the sidecar clears on a successful commit' });
    const healthy = statusReport(home, [0]);
    assert.equal(healthy.world.state, 'healthy', 'status is healthy after the commit');

    // 5. Pause, then plant an interrupted turn and resume: the boot reconcile
    //    must refuse, write the synthetic closer WITHOUT a commit, and boot.
    const exited = once(child, 'exit');
    const pause = runCli(['pause', '--home', home]);
    assert.equal(pause.code, 0, `pause failed: ${bounded(pause.stderr)}`);
    const [pauseCode] = await exited;
    assert.equal(pauseCode, 0, 'the paused host exits 0');
    await waitDone(child);

    const head = git(home, ['rev-parse', 'HEAD']).trim();
    const writer = await JournalWriter.open(home, UID);
    writer.append('turn/start', {
      turn: 2, trigger: 'wakeup', world: { from: head, to: head },
    });
    await writer.flush();
    await writer.close();

    const blocked2 = join(home, 'world', 'blocked2.txt');
    await plantUnreadable(blocked2);
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
    const degradedAgain = statusReport(home, [1]);
    assert.equal(degradedAgain.world.state, 'degraded', 'the booted home is degraded');

    // 6. Repair and let the bounded retry clear it: the home stays serviceable.
    await unblock(blocked2);
    await waitFor(async () => (await readWorldState(home)).degraded === false,
      { child, label: 'the resumed home clears the sidecar on success' });
    assert.equal(statusReport(home, [0]).world.state, 'healthy',
      'the resumed home is healthy after the retry commit');

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
