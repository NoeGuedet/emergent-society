// The compiled packages smoke (C1.5 scenario F): the C2 criterion path
// through the real compiled host — the five-command CLI, the real journals,
// the real Run machinery (sandbox off, like the A–E smoke's scenarios A–D;
// scenario E owns the confinement proof) — against a loopback fake provider with a
// state-machine reply queue (the package id is a runtime fact, read from the
// model-visible history, never scripted statically).
//
// The spine: define (from a world file) → run → funneled call → stop →
// SIGKILL the host → resume → re-mount → re-run → pause. The frozen-offering
// invariant is asserted compiled-side: every request body's tools array is
// byte-identical across the whole lifecycle.
//
// Output contract: exactly `packages smoke: ok (F)` on stdout, exit 0, whole
// run <= 90 s. On failure: `scenario F: <message>`, the host's last 20
// stderr lines (never request bodies) and its exit code, exit 1.
//
// Secrets discipline: the fake key exists only in providers.json and in the
// Authorization header the host writes; the loopback server's request
// records stay in memory, asserted on, never printed.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

// Compiled readers only — the writer is never called from the smoke.
import { C13_EVENT_TYPES } from '../dist/context/events.js';
import { loadVerifiedEvents } from '../dist/context/loader.js';
import { JournalReader, frontierLayout } from '../dist/journal/index.js';
import { FRONTIER_EVENT_TYPES } from '../dist/frontier/index.js';

const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));
const UID = 'node-0';
const POLL_MS = 50;
const WAIT_MS = 20_000;

/** The fake credential: never a real key, only ever in providers.json. */
const FAKE_KEY = 'packages-smoke-fake-key-31f9c0aa';

/** The authored Package source — the committed fixture's exact shape. */
const ECHO_SOURCE = 'return { tools: [{ name: "echo_text",'
  + ' description: "echoes the text",'
  + ' parameters: { type: "object",'
  + ' properties: { text: { type: "string", minLength: 1 } },'
  + ' required: ["text"], additionalProperties: false },'
  + ' handler: async (args) => ({ echoed: args.text }) }] };\n';

const ID_RE = /id ([0-9a-f]{64})/;

const home = await mkdtemp(join(tmpdir(), 'packages-smoke-'));
let child = null;
let server = null;
let phase = 'define';
let session = 1;
let packageId = '';

// The global watchdog guarantees the 90 s budget: an unref'd timer registered
// BEFORE the scenario, killing the live host and failing with a labeled
// message. `process.exit` skips the finally, so the cleanup backstop runs
// here first — a watchdog-triggered failure must not leak the home.
const watchdog = setTimeout(() => {
  try { if (child !== null && child.smoke.exitCode === undefined) child.kill('SIGKILL'); } catch { /* gone */ }
  try { if (server !== null) { server.server.close(); server.server.closeAllConnections(); } } catch { /* gone */ }
  import('node:fs').then((fs) => fs.rmSync(home, { recursive: true, force: true })).catch(() => {});
  console.error('packages smoke: watchdog fired at 85 s; the live host was killed');
  process.exit(1);
}, 85_000);
watchdog.unref();

// --- utilities -------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function bounded(text, limit = 400) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function waitFor(probe, label) {
  for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
    if (await probe()) return;
    await sleep(POLL_MS);
  }
  throw new Error(`timeout: ${typeof label === 'string' ? label : label.label}`);
}

function runCli(args) {
  const result = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8', timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The tracked host child with the JSONL stderr capture (the A–E pattern). */
function spawnHost(args) {
  const host = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  const capture = { tail: [], events: [], exitCode: undefined };
  host.smoke = capture;
  let pending = '';
  host.stderr.setEncoding('utf8');
  host.stderr.on('data', (chunk) => {
    pending += chunk;
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl < 0) break;
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line === '') continue;
      capture.tail.push(line);
      if (capture.tail.length > 20) capture.tail.shift();
      try {
        capture.events.push(JSON.parse(line));
      } catch { /* not JSON: keep in the tail only */ }
    }
  });
  host.on('exit', (code) => { capture.exitCode = code; });
  return host;
}

const waitDone = (host) => once(host, 'exit');

const sawEvent = (host, type) =>
  host.smoke.events.some((event) => event.event === type);

// --- the loopback provider with the state machine ---------------------------------

/**
 * The reply queue is a function of the request body: the package id is a
 * runtime fact, so the responder reads the model-visible history (the last
 * tool result) and scripts the next call from it — exactly what a model
 * would do with the announcement in its history.
 */
function startServer(respond) {
  return new Promise((resolve, reject) => {
    const bodies = [];
    const srv = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        bodies.push(body);
        let reply;
        try {
          reply = respond(body);
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ smokeError: bounded(err.message) }));
          return;
        }
        const payload = JSON.stringify(reply);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        });
        res.end(payload);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ server: srv, port: srv.address().port, bodies });
    });
  });
}

const assistantTool = (name, args, id = 'call_1') => ({
  choices: [{
    message: {
      role: 'assistant', content: null,
      tool_calls: [{
        id, type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
  }],
});

const assistantText = (content) => ({
  choices: [{ message: { role: 'assistant', content } }],
});

/** The last tool-result content in a request body's history. */
function lastToolResult(body) {
  const parsed = JSON.parse(body);
  let content = null;
  for (const message of parsed.messages ?? []) {
    if (message.role === 'tool') content = message.content;
  }
  return content;
}

/** The state machine: session 1 defines, runs, funnels and stops; the
 * restart's session 2 re-runs; each session parks with a text reply. */
function respond(body) {
  const last = lastToolResult(body);
  if (session === 1) {
    if (phase === 'define') {
      phase = 'run';
      return assistantTool('extend', {
        verb: 'define', name: 'echo_pkg', purpose: 'echo things', path: 'echo.js',
      });
    }
    if (phase === 'run') {
      const match = last !== null ? ID_RE.exec(last) : null;
      assert.ok(match !== null, `the define result carries the id: ${bounded(last)}`);
      packageId = match[1];
      phase = 'call';
      return assistantTool('extend', { verb: 'run', id: packageId }, 'call_2');
    }
    if (phase === 'call') {
      phase = 'stop';
      return assistantTool('extend', {
        verb: 'call', tool: 'echo_text', args: { text: 'funneled in the smoke' },
      }, 'call_3');
    }
    if (phase === 'stop') {
      assert.ok(last !== null && last.includes('funneled in the smoke'),
        `the funneled result reached the history: ${bounded(last)}`);
      phase = 'park';
      return assistantTool('extend', { verb: 'stop', id: packageId }, 'call_4');
    }
    return assistantText('parking before the crash');
  }
  if (phase === 'rerun') {
    phase = 'park2';
    return assistantTool('extend', { verb: 'run', id: packageId }, 'call_5');
  }
  return assistantText('done');
}

// --- the compiled readers -----------------------------------------------------------

const localEvents = async () => loadVerifiedEvents(home, UID, C13_EVENT_TYPES);

async function frontierEvents() {
  const reader = await JournalReader.openIn(frontierLayout(home), {
    knownTypes: FRONTIER_EVENT_TYPES,
  });
  const out = [];
  for await (const event of reader.events()) out.push(event);
  return out;
}

const ofType = (events, type) => events.filter((event) => event.type === type);

// --- the scenario -------------------------------------------------------------------

try {
  // F.1 — init; the echo source lands in the world before the first boot.
  const init = runCli(['init', '--home', home]);
  assert.equal(init.code, 0, `F: init failed: ${bounded(init.stderr)}`);
  await writeFile(join(home, 'world', 'echo.js'), ECHO_SOURCE);

  // F.2 — the loopback server first, then the 0600 provider store with the
  // real port: one write, one chmod.
  server = await startServer(respond);
  const providersPath = join(home, 'providers.json');
  await writeFile(providersPath, JSON.stringify({
    llm: { key: FAKE_KEY, endpoint: `http://127.0.0.1:${server.port}/v1/chat/completions` },
  }), { mode: 0o600 });
  await chmod(providersPath, 0o600);

  // F.3 — start: define → run → funneled call → stop, then the host parks.
  child = spawnHost(['start', '--home', home, '--model', 'packages-smoke-test',
    '--heading', 'Scenario F.', '--no-sandbox']);
  await waitFor(() => sawEvent(child, 'host/parked'),
    { label: 'F: host/parked after the first session' });

  // F.4 — session 1's census, through the compiled reader.
  {
    const events = await localEvents();
    assert.equal(ofType(events, 'package/define').length, 1,
      'F: exactly one package/define');
    const define = ofType(events, 'package/define')[0];
    assert.equal(define.data.name, 'echo_pkg');
    assert.ok(/^[0-9a-f]{64}$/.test(define.data.id), 'F: the definition id is sha256');
    assert.equal(ofType(events, 'package/run').length, 1, 'F: one run fact');
    assert.equal(ofType(events, 'package/effect').length, 1, 'F: one effect fact');
    assert.equal(ofType(events, 'package/effect')[0].data.tool, 'echo_text');
    assert.equal(ofType(events, 'package/stop').length, 1, 'F: one verb stop');
    assert.equal(ofType(events, 'package/stop')[0].data.reason, 'verb');
    const funneled = ofType(events, 'tool/result')
      .find((event) => (event.data.message?.content ?? '').includes('funneled in the smoke'));
    assert.ok(funneled !== undefined, 'F: the funneled result is durable');
    assert.equal(funneled.data.frontierCall, null, 'F: a funneled result crosses no frontier');
    assert.equal(ofType(events, 'package/error').length, 0, 'F: no crash facts');
    // No stored source byte ever entered an event.
    for (const event of events) {
      const encoded = JSON.stringify(event.data);
      assert.ok(!encoded.includes('handler: async'),
        'F: package source bytes leaked into a local-log event');
    }
  }

  // F.5 — the SIGKILL crash between sessions, then the resume.
  child.kill('SIGKILL');
  await waitDone(child);

  session = 2;
  phase = 'rerun';
  child = spawnHost(['resume', '--home', home, '--no-sandbox']);
  await waitFor(() => sawEvent(child, 'host/parked'),
    { label: 'F: host/parked after the resume + re-run' });

  // F.6 — the paused exit and the final census.
  const exited = once(child, 'exit');
  const pause = runCli(['pause', '--home', home]);
  assert.equal(pause.code, 0, `F: pause failed: ${bounded(pause.stderr)}`);
  const [pauseCode] = await exited;
  assert.equal(pauseCode, 0, 'F: the resumed host exits cleanly');

  {
    const events = await localEvents();
    // The re-run: the definition survived the crash+resume.
    assert.equal(ofType(events, 'package/run').length, 2, 'F: two run facts (one per session)');
    const runs = ofType(events, 'package/run');
    assert.equal(runs[0].data.id, runs[1].data.id, 'F: both runs name the same package');
    // The second session's stop is the host's (the pause disposed the live
    // re-run): reason host-stop.
    const stops = ofType(events, 'package/stop');
    assert.equal(stops.length, 2, 'F: two stop facts');
    assert.equal(stops[1].data.reason, 'host-stop', 'F: the pause is a host-stop');
    // The re-run re-registered the tool: one effect per runId.
    const effects = ofType(events, 'package/effect');
    assert.equal(effects.length, 2, 'F: one effect per run');
    assert.ok(effects.every((event) => event.data.tool === 'echo_text'),
      'F: both effects name the echo tool');
    assert.equal(ofType(events, 'package/error').length, 0,
      'F: no crash facts across the crash and the host-stop');
  }

  // F.7 — the frontier knows nothing of Packages; the local log carries all.
  const frontier = await frontierEvents();

  assert.ok(frontier.some((event) => event.type === 'http/response'),
    'F: the frontier recorded the model exchanges');
  assert.ok(frontier.every((event) => !event.type.startsWith('package/')),
    'F: no package fact crossed the frontier');

  // F.8 — the frozen-offering invariant, compiled-side: every request body's
  // tools array is byte-identical across the whole lifecycle.
  // Session 1: define, run, call, stop, park = 5 requests; session 2's
  // re-run and park = 2 more (the resume replays no request).
  assert.ok(server.bodies.length >= 7,
    `F: expected 7+ requests, got ${server.bodies.length}`);
  const toolsArrays = server.bodies.map((body) => {
    const parsed = JSON.parse(body);
    return JSON.stringify(parsed.tools ?? null);
  });
  const distinct = new Set(toolsArrays);
  assert.equal(distinct.size, 1,
    'F: the tools array changed across the package lifecycle (cache invalidation)');
  const tools = JSON.parse(toolsArrays[0]);
  assert.equal(tools.length, 5, 'F: the offering is the frozen five');
  assert.ok(tools.some((tool) => tool.function?.name === 'extend'),
    'F: extend is offered');

  // F.9 — the run leaves are reaped; the package definition persists.
  const packagesDir = join(home, 'nodes', UID, 'packages');
  const ids = await readdir(packagesDir);
  assert.equal(ids.length, 1, 'F: exactly one stored definition');
  assert.equal(ids[0], packageId, 'F: the stored definition is the defined id');
  const runsDir = join(home, 'nodes', UID, 'runs');
  let runsLeft = null;
  try { runsLeft = await readdir(runsDir); } catch { /* absent: also clean */ }
  assert.ok(runsLeft === null || runsLeft.length === 0,
    'F: no run leaf survives the stops');

  console.log('packages smoke: ok (F)');
} catch (err) {
  console.error(`scenario F: ${bounded(err.message)}`);
  if (child !== null) {
    for (const line of child.smoke.tail) console.error(`  ${line}`);
    console.error(`  host exit code: ${child.smoke.exitCode}`);
  }
  process.exitCode = 1;
} finally {
  // The capture's exitCode is undefined until the 'exit' event lands
  // (Node's own child.exitCode is null while alive — a different value).
  if (child !== null && child.smoke.exitCode === undefined) child.kill('SIGKILL');
  if (server !== null) {
    server.server.close();
    server.server.closeAllConnections();
  }
  await rm(home, { recursive: true, force: true }).catch(() => {});
}
