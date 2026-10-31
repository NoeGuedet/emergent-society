// The compiled first-light smoke (T9): the five-command CLI end to end — real
// processes, the real Git world, the real journals, the real PTY — against a
// loopback fake provider, plus one Landlock-on boot. Stdlib only; the journal
// and context facts are read through the compiled readers from dist/, never
// through the writer. E requires Linux with Landlock ABI ≥ 3
//
// Output contract: exactly `first-light smoke: ok (A/B/C/D/E)` on stdout
// (with ` (E skipped)` appended when the Landlock probe reports
// unavailability), exit 0, whole run <= 180 s. On failure:
// `scenario <X>: <message>`, the child's last 20 stderr lines (never request
// bodies) and the child exit code, exit 1.
//
// Secrets discipline: the fake key exists only in providers.json and in the
// Authorization header the host writes; the loopback server's request records
// stay in memory and are asserted on, never printed, logged or serialized.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

// Compiled readers only — `openFrontierJournal` (the writer) is never called.
import { JournalReader, frontierLayout, nodeLayout } from '../dist/journal/index.js';
import { C13_EVENT_TYPES } from '../dist/context/events.js';
import { loadVerifiedEvents } from '../dist/context/loader.js';
import { ContextFold } from '../dist/context/fold.js';
import { FRONTIER_EVENT_TYPES } from '../dist/frontier/index.js';

const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('../native/es-landlock/es-landlock', import.meta.url));
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/** The fake credential: never a real key, only ever in providers.json. */
const FAKE_KEY = 'first-light-fake-key-7c4d2a08';
const UID = 'node-0';
const POLL_MS = 50;
const WAIT_MS = 15_000;
/** The only place the fake reply text is spelled. */
const DEFAULT_TEXT_REPLY = { choices: [{ message: { role: 'assistant', content: 'idle' } }] };

const homes = [];
const liveChildren = new Set();
const liveServers = new Set();
let lastChild = null;
let currentScenario = 'A';

// --- small utilities -----------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A bounded, single-line failure label: never a payload, never a body. */
function bounded(text, limit = 400) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function isFile(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Walks a directory tree, yielding `{ rel, path, entry }` per file system entry. */
async function walkTree(dir, path = dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(path, entry.name);
    out.push({ rel, path: full, entry });
    if (entry.isDirectory()) out.push(...await walkTree(full, full, rel));
  }
  return out;
}

/** The world repository's plumbing, addressed through its own pair of paths. */
function git(home, args) {
  return execFileSync('git', [
    '--git-dir', join(home, 'world.git'),
    '--work-tree', join(home, 'world'),
    ...args,
  ], { encoding: 'utf8' });
}

// --- the host child and its stderr JSONL capture -------------------------------

/**
 * Spawns one host command with stderr piped and the reader attached inside
 * this helper, before the child is returned: a piped-but-unread stderr can
 * deadlock the host once the pipe buffer fills (Node docs).
 *
 * The capture keeps every stderr line (for the key scan), a ring buffer of the
 * last 20 lines (for failure reports), the parsed JSONL events (for waits),
 * and the exit code recorded by a watcher attached at spawn so no exit event
 * can ever be missed.
 */
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
      try {
        capture.events.push(JSON.parse(line));
      } catch {
        // Not a JSONL event (a stack trace, a pty warning); the tail keeps it.
      }
    }
  });
  child.on('exit', (code) => { capture.exitCode = code; liveChildren.delete(child); });
  liveChildren.add(child);
  lastChild = child;
  return child;
}

const sawEvent = (child, name) => child.smoke.events.some((event) => event.event === name);
const bootLine = (child) => child.smoke.events.find((event) => event.event === 'host/boot');

/** The failure tail with the fake key redacted: the invariant is local, not inherited from observe.ts. */
const redactedTail = (lines) => lines.map((line) => (line.includes(FAKE_KEY) ? '<redacted: fake-key>' : line));

function tailText(child) {
  return child === null || child.smoke === undefined
    ? ''
    : `\nhost stderr (last ${child.smoke.tail.length} lines):\n${redactedTail(child.smoke.tail).join('\n')}`;
}

/**
 * A 50 ms poll racing three outcomes: the predicate holds, the host exited, or
 * the deadline passed. A rejection carries the label, the exit code (or the
 * running state) and the last 20 stderr lines.
 */
async function waitFor(pred, { child, timeoutMs = WAIT_MS, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (child !== undefined && child.smoke.exitCode !== undefined) {
      throw new Error(`${label}: host exited with code ${child.smoke.exitCode}${tailText(child)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: timed out after ${timeoutMs} ms (host still running)${tailText(child)}`,
      );
    }
    await sleep(POLL_MS);
  }
}

/** Waits for the child to be fully done: 'close' fires after 'exit' and after the stdio streams have drained, so the last JSONL diagnostics are already captured. */
async function waitDone(child) {
  await once(child, 'close');
}

/** A one-shot CLI call in a genuinely separate process (`pause`, `status --json`). */
function runCli(args) {
  // The timeout bounds the one blocked-sync seam: a hung CLI child would block
  // the event loop, where the unref'd watchdog timer cannot fire. SIGTERM after
  // 60 s yields status null, which the callers' exit-code asserts report.
  const result = spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A tracked scenario home; every home is removed in the global cleanup. */
async function newHome() {
  const home = await mkdtemp(join(tmpdir(), 'first-light-'));
  homes.push(home);
  return home;
}

/** Writes the 0600 credential store with the fake key and the loopback endpoint. */
async function writeProviders(home, port) {
  const path = join(home, 'providers.json');
  await writeFile(path, JSON.stringify({
    llm: { key: FAKE_KEY, endpoint: `http://127.0.0.1:${port}/v1/chat/completions` },
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * The hermetic loopback fake provider: an explicit 127.0.0.1 bind, an
 * in-memory request array (never printed, logged or serialized), a scripted
 * queue whose exhausted tail answers a fixed text reply, and a `'hold'` entry
 * that never responds — the client-side abort then surfaces as the request's
 * 'close' event, which needs no special handling here.
 */
function startServer(queue) {
  return new Promise((resolve, reject) => {
    const requests = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
          authorization: req.headers.authorization ?? null,
        });
        const entry = queue.shift();
        if (entry === 'hold') return;
        const reply = entry === undefined ? DEFAULT_TEXT_REPLY : entry;
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

/** Per-scenario server cleanup; `closeAllConnections` after `close` so a held request cannot hang the close forever. */
function stopServer(handle) {
  if (handle === null) return;
  handle.server.close();
  handle.server.closeAllConnections();
  liveServers.delete(handle.server);
}

// --- fake chat responses --------------------------------------------------------

function assistantText(content) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

function assistantTool(name, args) {
  return {
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
  };
}

// --- compiled-reader helpers -----------------------------------------------------

const localEvents = (home) => loadVerifiedEvents(home, UID, C13_EVENT_TYPES);

/** The frontier journal's verified events, through the journal's own reader. */
async function frontierEvents(home) {
  const reader = await JournalReader.openIn(frontierLayout(home), {
    knownTypes: FRONTIER_EVENT_TYPES,
  });
  const out = [];
  for await (const event of reader.events()) out.push(event);
  return out;
}

const ofType = (events, type) => events.filter((event) => event.type === type);
const countType = (events, type) => ofType(events, type).length;

/**
 * No retry: a retry is the only producer of a second request in one group, so
 * every group must hold exactly one request. Never compares body bytes.
 */
function assertNoRetry(frontier, label) {
  const groups = new Map();
  for (const event of ofType(frontier, 'http/request')) {
    groups.set(event.data.group, (groups.get(event.data.group) ?? 0) + 1);
  }
  for (const [group, count] of groups) {
    assert.equal(count, 1, `${label}: group ${group} saw ${count} requests (a retry)`);
  }
}

/** A `node-0` commit with the given subject whose tree names the given file. */
function commitIncludes(home, subject, file) {
  const log = git(home, ['log', '--format=%H%x00%an%x00%s']);
  for (const line of log.split('\n')) {
    if (line.trim() === '') continue;
    const [hash, author, commitSubject] = line.split('\0');
    if (author !== UID || commitSubject !== subject) continue;
    const names = git(home, ['ls-tree', '-r', '--name-only', hash]).split('\n');
    if (names.includes(file)) return true;
  }
  return false;
}

/** `status --json`, accepting the exit codes the caller lists (0 ok, 1 degraded). */
function statusReport(home, acceptable) {
  const result = runCli(['status', '--home', home, '--json']);
  assert.ok(acceptable.includes(result.code),
    `status exited ${result.code}: ${bounded(result.stderr)}`);
  return JSON.parse(result.stdout);
}

/**
 * The key scan: the resolved local-log payloads, the frontier payloads, every
 * blob byte, every world file and every captured stderr line must be free of
 * the fake key. Returns the places it was found (empty means clean).
 */
async function scanForKey(home, child) {
  const found = [];
  const check = (where, text) => {
    if (text.includes(FAKE_KEY)) found.push(where);
  };
  for (const event of await localEvents(home)) {
    check('local log payload', JSON.stringify(event.data));
  }
  for (const event of await frontierEvents(home)) {
    check('frontier payload', JSON.stringify(event.data));
  }
  for (const root of [join(home, 'blobs'), join(home, 'world'), join(home, 'world.git')]) {
    try {
      for (const { path, entry } of await walkTree(root)) {
        if (entry.isFile()) check(path, await readFile(path, 'utf8'));
      }
    } catch {
      // A missing directory is simply nothing to scan.
    }
  }
  if (child !== null && child.smoke !== undefined) {
    for (const line of child.smoke.lines) check('captured stderr', line);
  }
  return found;
}

// --- scenarios -------------------------------------------------------------------

/** A. Fresh start → turn → park → status → pause → resume. */
async function scenarioA() {
  // A.1 — build layout only; the boot-line assertion belongs after the boot.
  assert.ok(await isFile(join(DIST, 'journal', 'lock-guard.mjs')),
    'A: dist/journal/lock-guard.mjs is missing');
  assert.ok(await isFile(MAIN), 'A: dist/host/main.js is missing');
  for (const { rel, entry } of await walkTree(DIST)) {
    assert.ok(rel !== 'src' && rel !== 'native', `A: dist/${rel} must not exist`);
    assert.ok(!rel.split('/').includes('__tests__'), `A: dist/${rel} must not exist`);
    assert.ok(!(entry.isFile() && entry.name.endsWith('.test.js')),
      `A: dist/${rel} must not be emitted`);
  }
  assert.ok(await isExecutableFile(LAUNCHER), 'A: the Landlock launcher is missing');

  const home = await newHome();
  let server = null;
  let child = null;
  try {
    // A.2 — init, then the 0600 credential store with the fake key.
    const init = runCli(['init', '--home', home]);
    assert.equal(init.code, 0, `A: init failed: ${bounded(init.stderr)}`);
    server = await startServer([
      assistantTool('execute', { cmd: "printf 'hi\\n' > first.txt" }),
      assistantText('done'),
    ]);
    await writeProviders(home, server.port);

    // A.4 — start; the boot turn ends and the host parks.
    child = spawnHost(['start', '--home', home, '--model', 'first-light-test',
      '--heading', 'First light.', '--no-sandbox']);
    await waitFor(() => sawEvent(child, 'host/parked'),
      { child, label: 'A: host/parked after start' });

    // A.5 — the world, the commit, the boot line, the local-log census, the
    // frontier counts, the key scan and the Authorization header.
    assert.equal(await readFile(join(home, 'world', 'first.txt'), 'utf8'), 'hi\n',
      'A: world/first.txt content');
    const subject = git(home, ['log', '-1', '--format=%an%x00%s']).trim();
    assert.equal(subject, 'node-0\0turn 0',
      `A: world commit author/subject is ${JSON.stringify(subject)}`);
    const boot = bootLine(child);
    assert.ok(boot !== undefined, 'A: no host/boot line was captured');
    assert.equal(boot.sandbox, 'off', `A: boot line sandbox is ${JSON.stringify(boot.sandbox)}`);
    const layout = nodeLayout(home, UID);
    assert.ok(await isFile(join(layout.dir, layout.logFile)), 'A: the local log is missing');

    const events = await localEvents(home);
    assert.equal(countType(events, 'node/boot'), 1, 'A: node/boot census');
    assert.equal(ofType(events, 'node/boot')[0].data.reason, 'start', 'A: node/boot reason');
    assert.equal(countType(events, 'turn/start'), 1, 'A: turn/start census');
    const turnStart = ofType(events, 'turn/start')[0];
    assert.equal(turnStart.data.turn, 0, 'A: turn/start turn');
    assert.equal(turnStart.data.trigger, 'boot', 'A: turn/start trigger (no seed commit)');
    assert.equal(countType(events, 'world/perception'), 1, 'A: world/perception census');
    assert.equal(countType(events, 'assistant/message'), 2, 'A: assistant/message census');
    assert.equal(countType(events, 'tool/call'), 1, 'A: tool/call census');
    assert.equal(countType(events, 'tool/result'), 1, 'A: tool/result census');
    assert.equal(countType(events, 'turn/end'), 1, 'A: turn/end census');
    const turnEnd = ofType(events, 'turn/end')[0];
    assert.equal(turnEnd.data.outcome, 'waiting', 'A: turn/end outcome');
    assert.equal(typeof turnEnd.data.commit, 'string', 'A: turn/end carries a commit');
    assert.equal(countType(events, 'node/shutdown'), 0, 'A: no node/shutdown yet');

    const frontier = await frontierEvents(home);
    assert.equal(countType(frontier, 'http/request'), 2, 'A: frontier request count');
    assert.equal(countType(frontier, 'http/response'), 2, 'A: frontier response count');
    assert.equal(countType(frontier, 'http/incomplete'), 0, 'A: frontier incomplete count');

    const leaks = await scanForKey(home, child);
    assert.deepEqual(leaks, [], `A: the fake key leaked into: ${leaks.join(', ')}`);
    assert.ok(server.requests.some((r) => r.authorization === `Bearer ${FAKE_KEY}`),
      'A: the server never saw Bearer <fake>');

    // A.6 — status while the host runs. A running host is not degraded by the
    // normal `storage=unquoted` fact or by its explicit `--no-sandbox` opt-out
    // (`sandbox=off`), so the exit is 0; an unintended fence=unavailable would
    // be the degradation.
    const running = statusReport(home, [0]);
    assert.equal(running.host.state, 'running', 'A: status host state');
    assert.equal(running.frontier.counts['http/request'], 2, 'A: status request count');
    assert.notEqual(running.world.head, null, 'A: status world head');

    // A.7 — pause: the exit listener is attached before the pause is triggered.
    const exited = once(child, 'exit');
    const pause = runCli(['pause', '--home', home]);
    assert.equal(pause.code, 0, `A: pause failed: ${bounded(pause.stderr)}`);
    const [pauseCode] = await exited;
    assert.equal(pauseCode, 0, 'A: paused host exit code');
    await waitDone(child);
    const afterPause = await localEvents(home);
    const last = afterPause[afterPause.length - 1];
    assert.equal(last.type, 'node/shutdown', 'A: the last local event is not node/shutdown');
    assert.equal(last.data.reason, 'stop-requested', 'A: node/shutdown reason');
    assert.equal(statusReport(home, [0]).host.state, 'idle', 'A: status idle after pause');

    // A.8 — resume: boot reason, exactly one system/message, the fold's model,
    // three requests, then pause again (exit listener attached first).
    child = spawnHost(['resume', '--home', home, '--no-sandbox']);
    await waitFor(() => sawEvent(child, 'host/parked'),
      { child, label: 'A: host/parked after resume' });
    const resumed = await localEvents(home);
    const boots = ofType(resumed, 'node/boot');
    assert.equal(boots[boots.length - 1].data.reason, 'resume', 'A: last node/boot reason');
    assert.equal(countType(resumed, 'system/message'), 1, 'A: exactly one system/message');
    const fold = new ContextFold();
    await fold.observe(await loadVerifiedEvents(home, UID, C13_EVENT_TYPES));
    const config = fold.snapshot().config;
    assert.ok(config !== null, 'A: the fold has no config');
    assert.equal(config.value.model, 'first-light-test', 'A: the fold config model');
    assert.equal(statusReport(home, [0]).frontier.counts['http/request'], 3,
      'A: status request count after resume');
    const exitedAgain = once(child, 'exit');
    const pauseAgain = runCli(['pause', '--home', home]);
    assert.equal(pauseAgain.code, 0, `A: second pause failed: ${bounded(pauseAgain.stderr)}`);
    const [resumeCode] = await exitedAgain;
    assert.equal(resumeCode, 0, 'A: resumed host exit code');
    await waitDone(child);
  } finally {
    stopServer(server);
  }
}

/** B. Pause with the provider request in flight. */
async function scenarioB() {
  const home = await newHome();
  let server = null;
  let child = null;
  try {
    const init = runCli(['init', '--home', home]);
    assert.equal(init.code, 0, `B: init failed: ${bounded(init.stderr)}`);
    // The first scripted reply holds; every later request answers text.
    server = await startServer(['hold']);
    await writeProviders(home, server.port);

    child = spawnHost(['start', '--home', home, '--model', 'first-light-test',
      '--heading', 'B in-flight pause.', '--no-sandbox']);
    await waitFor(() => server.requests.length === 1,
      { child, label: 'B: the first request was recorded' });

    const exited = once(child, 'exit');
    const pause = runCli(['pause', '--home', home]);
    assert.equal(pause.code, 0, `B: pause failed: ${bounded(pause.stderr)}`);
    const [pauseCode] = await exited;
    assert.equal(pauseCode, 0, 'B: paused host exit code');
    await waitDone(child);

    // B.3 — one request, one cancelled terminal, turn/end waiting, no retry:
    // `cancelled` is not in the adapter's retryable set, so nothing re-sends.
    const frontier = await frontierEvents(home);
    assert.equal(countType(frontier, 'http/request'), 1, 'B: frontier request count');
    assert.equal(countType(frontier, 'http/response'), 1, 'B: frontier response count');
    const response = ofType(frontier, 'http/response')[0];
    assert.equal(response.data.error?.code ?? null, 'cancelled', 'B: response error code');
    assertNoRetry(frontier, 'B');
    const events = await localEvents(home);
    assert.equal(countType(events, 'turn/end'), 1, 'B: turn/end census');
    assert.equal(ofType(events, 'turn/end')[0].data.outcome, 'waiting',
      'B: turn/end outcome');

    // B.4 — resume: the interrupted call has no later attempt in its group and
    // the resume request is a new group. Body bytes are never compared.
    child = spawnHost(['resume', '--home', home, '--no-sandbox']);
    await waitFor(() => sawEvent(child, 'host/parked'),
      { child, label: 'B: host/parked after resume' });
    const frontierAfter = await frontierEvents(home);
    assert.equal(countType(frontierAfter, 'http/request'), 2, 'B: resume request count');
    assertNoRetry(frontierAfter, 'B');
    const groups = ofType(frontierAfter, 'http/request').map((e) => e.data.group);
    assert.equal(new Set(groups).size, groups.length, 'B: the resume request is a new group');

    const exitedAgain = once(child, 'exit');
    const pauseAgain = runCli(['pause', '--home', home]);
    assert.equal(pauseAgain.code, 0, `B: second pause failed: ${bounded(pauseAgain.stderr)}`);
    const [resumeCode] = await exitedAgain;
    assert.equal(resumeCode, 0, 'B: resumed host exit code');
    await waitDone(child);
  } finally {
    stopServer(server);
  }
}

/** C. Crash mid-provider (SIGKILL), then resume. */
async function scenarioC() {
  const home = await newHome();
  let server = null;
  let child = null;
  try {
    const init = runCli(['init', '--home', home]);
    assert.equal(init.code, 0, `C: init failed: ${bounded(init.stderr)}`);
    server = await startServer(['hold']);
    await writeProviders(home, server.port);

    child = spawnHost(['start', '--home', home, '--model', 'first-light-test',
      '--heading', 'C crash mid-provider.', '--no-sandbox']);
    await waitFor(() => server.requests.length === 1,
      { child, label: 'C: the first request was recorded' });
    child.kill('SIGKILL');
    await waitDone(child);

    // A SIGKILL can leave the frontier/world probe degraded, and status exits 1
    // for a degraded report: accept 0 or 1 and assert only the host state.
    const report = statusReport(home, [0, 1]);
    assert.equal(report.host.state, 'stale', 'C: status host state after the crash');

    child = spawnHost(['resume', '--home', home, '--no-sandbox']);
    await waitFor(() => sawEvent(child, 'host/parked'),
      { child, label: 'C: host/parked after resume' });
    const frontier = await frontierEvents(home);
    assert.equal(countType(frontier, 'http/incomplete'), 1, 'C: exactly one http/incomplete');
    const events = await localEvents(home);
    assert.ok(ofType(events, 'turn/end').some((e) => e.data.outcome === 'interrupted'),
      'C: no turn/end with outcome interrupted');

    // Pause the resumed host (exit 0), then resume again — never two concurrent
    // resumes.
    const exited = once(child, 'exit');
    const pause = runCli(['pause', '--home', home]);
    assert.equal(pause.code, 0, `C: pause failed: ${bounded(pause.stderr)}`);
    const [pauseCode] = await exited;
    assert.equal(pauseCode, 0, 'C: resumed host exit code');
    await waitDone(child);

    child = spawnHost(['resume', '--home', home, '--no-sandbox']);
    await waitFor(() => sawEvent(child, 'host/parked'),
      { child, label: 'C: host/parked after the second resume' });
    const exitedAgain = once(child, 'exit');
    const pauseAgain = runCli(['pause', '--home', home]);
    assert.equal(pauseAgain.code, 0, `C: second pause failed: ${bounded(pauseAgain.stderr)}`);
    const [resumeCode] = await exitedAgain;
    assert.equal(resumeCode, 0, 'C: the second resume exit code');
    await waitDone(child);
    const frontierAfter = await frontierEvents(home);
    assert.equal(countType(frontierAfter, 'http/incomplete'), 1,
      'C: the http/incomplete count changed after the second resume');
  } finally {
    stopServer(server);
  }
}

/** D. Crash mid-execute (SIGKILL), then resume without re-execution. */
async function scenarioD() {
  const home = await newHome();
  let server = null;
  let child = null;
  try {
    const init = runCli(['init', '--home', home]);
    assert.equal(init.code, 0, `D: init failed: ${bounded(init.stderr)}`);
    server = await startServer([
      assistantTool('execute', { cmd: 'touch crash.txt && sleep 5' }),
    ]);
    await writeProviders(home, server.port);

    child = spawnHost(['start', '--home', home, '--model', 'first-light-test',
      '--heading', 'D crash mid-execute.', '--no-sandbox']);
    const crashFile = join(home, 'world', 'crash.txt');
    await waitFor(async () => isFile(crashFile),
      { child, label: 'D: world/crash.txt exists' });
    child.kill('SIGKILL');
    await waitDone(child);

    // Resume with text replies for the boot turn, then park and pause.
    child = spawnHost(['resume', '--home', home, '--no-sandbox']);
    await waitFor(() => sawEvent(child, 'host/parked'),
      { child, label: 'D: host/parked after resume' });
    const exited = once(child, 'exit');
    const pause = runCli(['pause', '--home', home]);
    assert.equal(pause.code, 0, `D: pause failed: ${bounded(pause.stderr)}`);
    const [pauseCode] = await exited;
    assert.equal(pauseCode, 0, 'D: resumed host exit code');
    await waitDone(child);

    assert.ok(commitIncludes(home, 'turn 0', 'crash.txt'),
      'D: no node-0 "turn 0" commit includes crash.txt');
    const events = await localEvents(home);
    const closers = ofType(events, 'turn/end').filter((e) => e.data.outcome === 'interrupted');
    assert.equal(closers.length, 1, 'D: interrupted closer count');
    const synthetic = ofType(events, 'tool/result').filter((e) =>
      e.data.synthetic === true
      && typeof e.data.message?.content === 'string'
      && e.data.message.content.includes('Outcome unknown after interruption; not re-executed'));
    assert.equal(synthetic.length, 1, 'D: synthetic unknown-outcome result count');
    // The orphaned `sleep` may outlive the SIGKILL (PTY grandchildren are not
    // killed on Linux); its timing is deliberately never asserted.

    // A second resume after pausing adds no second interrupted closer.
    child = spawnHost(['resume', '--home', home, '--no-sandbox']);
    await waitFor(() => sawEvent(child, 'host/parked'),
      { child, label: 'D: host/parked after the second resume' });
    const exitedAgain = once(child, 'exit');
    const pauseAgain = runCli(['pause', '--home', home]);
    assert.equal(pauseAgain.code, 0, `D: second pause failed: ${bounded(pauseAgain.stderr)}`);
    const [resumeCode] = await exitedAgain;
    assert.equal(resumeCode, 0, 'D: the second resume exit code');
    await waitDone(child);
    const eventsAfter = await localEvents(home);
    const closersAfter = ofType(eventsAfter, 'turn/end')
      .filter((e) => e.data.outcome === 'interrupted');
    assert.equal(closersAfter.length, 1, 'D: a second interrupted closer appeared');
    const syntheticAfter = ofType(eventsAfter, 'tool/result').filter((e) =>
      e.data.synthetic === true
      && typeof e.data.message?.content === 'string'
      && e.data.message.content.includes('Outcome unknown after interruption; not re-executed'));
    assert.equal(syntheticAfter.length, 1, 'D: a second synthetic result appeared');
  } finally {
    stopServer(server);
  }
}

/** E. Sandbox ON, compiled: a Landlock-confined boot on a fresh home. */
async function scenarioE() {
  const home = await newHome();
  let server = null;
  let child = null;
  try {
    // A fresh home: A–D's homes carry journaled configs, so start would refuse.
    const init = runCli(['init', '--home', home]);
    assert.equal(init.code, 0, `E: init failed: ${bounded(init.stderr)}`);
    server = await startServer([
      assistantTool('execute', { cmd: "printf 'hi\\n' > sandbox.txt" }),
      assistantText('done'),
    ]);
    await writeProviders(home, server.port);
    // The probe writes into these directories, so they must exist first.
    await mkdir(join(home, 'nodes', UID), { recursive: true });

    // Availability detection only, never a policy replay: this grant set is
    // deliberately smaller than the runtime's `buildSandboxSpec` policy (D5).
    // `--ro /proc` stays: the probe's ptrace pair stats /proc/<parent>.
    const probe = spawnSync(LAUNCHER, [
      '--probe', '--probe-deny', join(home, 'providers.json'),
      '--probe-rw', join(home, 'world'), '--probe-rw', join(home, 'nodes', UID),
      '--rw', join(home, 'world'), '--rw', join(home, 'nodes', UID), '--ro', '/proc',
    ], { encoding: 'utf8', timeout: 30_000 });
    if (probe.status === 125
      && /Landlock ABI 3 or newer is required|Function not implemented|es-landlock: landlock:/
        .test(probe.stderr)) {
      // The one unavailability signature converts to a skip; any other non-zero
      // probe (usage errors also exit 125) is a failure.
      console.log('scenario E skipped: Landlock unavailable');
      return { skipped: true };
    }
    assert.equal(probe.status, 0,
      `E: the Landlock probe failed (${probe.status}): ${bounded(probe.stderr)}`);

    // Start without --no-sandbox: confinement is the default.
    child = spawnHost(['start', '--home', home, '--model', 'first-light-test',
      '--heading', 'Sandboxed first light.']);
    await waitFor(() => sawEvent(child, 'host/parked'),
      { child, label: 'E: host/parked after start' });
    const boot = bootLine(child);
    assert.ok(boot !== undefined, 'E: no host/boot line was captured');
    assert.equal(boot.sandbox, 'landlock', `E: boot line sandbox is ${JSON.stringify(boot.sandbox)}`);
    assert.equal(await readFile(join(home, 'world', 'sandbox.txt'), 'utf8'), 'hi\n',
      'E: world/sandbox.txt content');
    assert.ok(commitIncludes(home, 'turn 0', 'sandbox.txt'),
      'E: no node-0 "turn 0" commit names sandbox.txt');
    const events = await localEvents(home);
    const spawnFailed = ofType(events, 'tool/result')
      .filter((e) => e.data.failure?.code === 'spawn');
    assert.equal(spawnFailed.length, 0, 'E: the execute tool failed to spawn under Landlock');

    const exited = once(child, 'exit');
    const pause = runCli(['pause', '--home', home]);
    assert.equal(pause.code, 0, `E: pause failed: ${bounded(pause.stderr)}`);
    const [pauseCode] = await exited;
    assert.equal(pauseCode, 0, 'E: host exit code');
    await waitDone(child);
    return { skipped: false };
  } finally {
    stopServer(server);
  }
}

// --- failure report and entry point ----------------------------------------------

function fail(scenario, err) {
  const lines = [`scenario ${scenario}: ${err instanceof Error ? err.message : String(err)}`];
  const child = lastChild;
  if (child !== null && child.smoke !== undefined) {
    lines.push(`host stderr (last ${child.smoke.tail.length} lines):`);
    lines.push(...redactedTail(child.smoke.tail));
    lines.push(`host exit code: ${
      child.smoke.exitCode === undefined ? 'still running' : String(child.smoke.exitCode)
    }`);
  } else {
    lines.push('host exit code: none (no host was spawned)');
  }
  console.log(lines.join('\n'));
  process.exitCode = 1;
}

async function main() {
  const scenarios = [
    ['A', scenarioA],
    ['B', scenarioB],
    ['C', scenarioC],
    ['D', scenarioD],
  ];
  for (const [name, run] of scenarios) {
    currentScenario = name;
    lastChild = null;
    try {
      await run();
    } catch (err) {
      fail(name, err);
      return;
    }
  }
  currentScenario = 'E';
  lastChild = null;
  let eSkipped = false;
  try {
    eSkipped = (await scenarioE()).skipped;
  } catch (err) {
    fail('E', err);
    return;
  }
  console.log(`first-light smoke: ok (A/B/C/D/E)${eSkipped ? ' (E skipped)' : ''}`);
}

// The global watchdog guarantees the 180 s budget: an unref'd timer that kills
// every live host and fails with a labeled message. `process.exit` skips the
// top-level finally, so the same cleanup backstop runs here first — a
// watchdog-triggered failure must not leak homes or leave sockets parked.
const watchdog = setTimeout(() => {
  for (const child of [...liveChildren]) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const server of [...liveServers]) {
    try {
      server.close();
      server.closeAllConnections();
    } catch {
      // Already closed.
    }
  }
  for (const home of homes) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Best effort at exit time.
    }
  }
  console.error(`first-light smoke: watchdog fired at 175 s in scenario ${currentScenario}; live hosts killed`);
  process.exit(1);
}, 175_000);
watchdog.unref();

try {
  await main();
} catch (err) {
  fail(currentScenario, err);
} finally {
  // The global cleanup backstop: children first (kills go through the handle
  // only), then the servers, then every tracked home.
  for (const child of [...liveChildren]) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const server of [...liveServers]) {
    try {
      server.close();
      server.closeAllConnections();
    } catch {
      // Already closed.
    }
  }
  for (const home of homes) {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}
