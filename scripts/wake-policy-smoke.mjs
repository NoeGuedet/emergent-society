// The compiled wake-policy acceptance (wake v1): the real built CLI and host
// against a local scripted OpenAI-compatible loopback provider, on a quiet
// (unborn-HEAD) world. No live API, model server, new dependency or library
// mock; the fake key exists only in the 0600 providers.json and the
// Authorization header, and request bodies stay in memory.
//
// Output contract: exactly `wake-policy smoke: ok` on stdout, exit 0. The
// healthy run is expected to take about 11 s; a 20 s unref'd watchdog exits 1
// if it overruns, and each one-shot CLI invocation is bounded at 5 s. On
// failure: `wake-policy smoke: <label>: <message>`, the host's redacted last 20
// stderr lines and its exit code, exit 1. Every failure text (the message, CLI
// stderr, any exception) is redacted before it can be printed. There is no skip
// path. The claims are behavioural, never a phase upper bound, a promise that
// the whole run always fits one exact deadline, a live-model result or a promise
// that every self-initiated chain is economically bounded.
//
// The sequence (one provider request per turn):
//   0 start boot "boot"          idle text
//   1 cadence                    wait after_seconds 3 + execute sleep 2
//   2 timer                      idle text -> pause
//   3 resume initial "boot"      idle text
//   4 resumed cadence            idle text -> pause
// The host is left down 1500 ms (past at least one 1 s cadence slot) between
// the pauses; the resume must not replay a missed slot.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiled readers only: the writer is never opened by this script.
import { C13_EVENT_TYPES } from '../dist/context/events.js';
import { ContextFold } from '../dist/context/fold.js';
import { loadVerifiedEvents } from '../dist/context/loader.js';
import { defaultAgentConfig } from '../dist/context/config.js';

const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));
const UID = 'node-0';
const MODEL = 'wake-smoke';
const FAKE_KEY = `wake-policy-fake-key-${process.pid}-${Date.now().toString(36)}`;
const POLL_MS = 50;
const PHASE_MS = 15_000;
const CLI_TIMEOUT_MS = 5_000;
const WATCHDOG_MS = 20_000;

const homes = [];
const liveChildren = new Set();
const liveServers = new Set();
const captures = [];
let lastChild = null;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Every failure/observability string goes through this before it is printed. */
function redact(text) {
  return String(text ?? '').split(FAKE_KEY).join('<redacted: fake-key>');
}

function bounded(text, limit = 400) {
  return redact(text).replace(/\s+/g, ' ').trim().slice(0, limit);
}

const redacted = (line) => redact(line);

function tail() {
  if (lastChild === null) return '';
  const lines = lastChild.smoke.tail.map(redacted);
  return lines.length === 0
    ? ''
    : `\nhost stderr (last ${lines.length} lines):\n${lines.join('\n')}`;
}

function fail(label, message) {
  const code = lastChild?.smoke.exitCode;
  process.stderr.write(
    `wake-policy smoke: ${redact(label)}: ${bounded(message)}${tail()}\n`
    + (code !== undefined ? `host exit code: ${code}\n` : ''),
  );
  process.exitCode = 1;
}

/** A 50 ms poll racing the predicate, the child's exit and a per-phase deadline. */
async function waitFor(predicate, label, timeoutMs = PHASE_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    // `liveChildren` loses a child only at CLOSE, so a half-settled child (exit
    // seen, stdio still draining) keeps the poll alive until its final output is
    // captured; a closed one is a hard failure for the wait.
    if (lastChild !== null && !liveChildren.has(lastChild)) {
      throw new Error(`${label}: host exited with code ${lastChild.smoke.exitCode}`);
    }
    if (Date.now() >= deadline) throw new Error(`${label}: timed out after ${timeoutMs} ms`);
    await sleep(POLL_MS);
  }
}

function trackChild(child, captureStdout = false) {
  const capture = {
    lines: [], tail: [], events: [], exitCode: undefined, stdout: '', closed: null,
  };
  let resolveClosed;
  capture.closed = new Promise((resolve) => { resolveClosed = resolve; });
  child.smoke = capture;
  captures.push(capture);
  let pending = '';
  const accept = (line) => {
    if (line === '') return;
    capture.lines.push(line);
    capture.tail.push(line);
    if (capture.tail.length > 20) capture.tail.shift();
    try {
      capture.events.push(JSON.parse(line));
    } catch {
      // Not a JSONL diagnostic (a pty warning); the redacted tail keeps it.
    }
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    pending += chunk;
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl < 0) break;
      accept(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  });
  if (captureStdout && child.stdout !== null) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { capture.stdout += chunk; });
  }
  // `exit` records the code; `close` is the ONLY settlement signal: stdio can
  // still deliver after `exit`, and the secret scan needs every final byte.
  child.on('exit', (code) => { capture.exitCode = code; });
  child.on('error', (err) => { accept(`spawn error: ${err.name}`); });
  child.once('close', () => {
    if (pending !== '') { accept(pending); pending = ''; }
    resolveClosed();
    liveChildren.delete(child);
  });
  liveChildren.add(child);
  return capture;
}

function spawnHost(args) {
  const child = spawn(process.execPath, [MAIN, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  trackChild(child);
  lastChild = child;
  return child;
}

const parkedCount = (child) => child.smoke.events
  .filter((event) => event.event === 'host/parked').length;

async function waitParked(child, count) {
  await waitFor(() => parkedCount(child) >= count, `host/parked #${count}`);
}

async function waitClosed(child) {
  await child.smoke.closed;
  return child.smoke.exitCode;
}

/**
 * One-shot CLI call: ASYNC spawn with a bounded 5 s timeout, tracked like any
 * host child. It never blocks the event loop, so the 20 s watchdog can fire and
 * settle it; a timeout SIGKILLs and awaits `close`, then reports exit null.
 */
async function runCli(args) {
  const child = spawn(process.execPath, [MAIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = trackChild(child, true);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, CLI_TIMEOUT_MS);
  await capture.closed;
  clearTimeout(timer);
  return {
    code: capture.exitCode, stdout: capture.stdout,
    stderr: capture.lines.join('\n'), timedOut,
  };
}

/** One redacted CLI-failure sentence for an assertion message. */
function cliFailure(label, result) {
  const exit = result.timedOut ? 'timed out' : `exit ${result.code ?? 'null'}`;
  return `${label} (${exit}): ${bounded(result.stderr)}`;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const requests = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const index = requests.length;
        const body = Buffer.concat(chunks).toString('utf8');
        const receivedAt = Date.now();
        requests.push({
          body, authorization: req.headers.authorization ?? null, receivedAt, respondedAt: null,
        });
        const reply = replies[index] ?? idleReply();
        const payload = JSON.stringify(reply);
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        });
        res.end(payload);
        requests[index].respondedAt = Date.now();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      liveServers.add(server);
      resolve({ server, port: server.address().port, requests });
    });
  });
}

const assistantText = (content) => ({
  choices: [{ message: { role: 'assistant', content } }],
});
const idleReply = () => assistantText('idle');
const call = (id, name, args) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const replies = [
  idleReply(),
  {
    choices: [{ message: {
      role: 'assistant', content: null,
      tool_calls: [
        call('call_wait_1', 'wait', { after_seconds: 3 }),
        call('call_exec_1', 'execute', { cmd: 'sleep 2' }),
      ],
    } }],
  },
  idleReply(),
  idleReply(),
  idleReply(),
];

async function writeProviders(home, port) {
  const path = join(home, 'providers.json');
  await writeFile(path, JSON.stringify({
    llm: { key: FAKE_KEY, endpoint: `http://127.0.0.1:${port}/v1/chat/completions` },
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

const triggerOf = (event) => event.data.trigger;
const starts = (events) => events.filter((event) => event.type === 'turn/start');
const ends = (events) => events.filter((event) => event.type === 'turn/end');

const RECEIPT_RE = /^Kernel turn receipt: opened_at=(\S+); trigger=([a-z]+); since_last_recorded_end_ms=(\S+)\.$/;

function bodyOf(request) {
  return JSON.parse(request.body);
}

function receiptOf(request) {
  const body = bodyOf(request);
  const lines = body.messages
    .filter((message) => message.role === 'system' && typeof message.content === 'string')
    .map((message) => message.content)
    .filter((content) => content.startsWith('Kernel turn receipt: '));
  assert.equal(lines.length, 1, 'each turn request carries exactly one opening receipt');
  return lines[0];
}

function waitToolOf(body) {
  const tools = body.tools ?? [];
  const wait = tools.find((tool) => tool.function?.name === 'wait');
  assert.ok(wait !== undefined, 'the request advertises the wait tool');
  return wait.function;
}



async function main() {
  const home = await mkdtemp(join(tmpdir(), 'wake-policy-'));
  homes.push(home);
  const init = await runCli(['init', '--home', home]);
  assert.equal(init.code, 0, cliFailure('init failed', init));

  const { server, port, requests } = await startServer();
  const providersPath = join(home, 'providers.json');
  await writeProviders(home, port);
  const providersInfo = await lstat(providersPath);
  assert.ok(providersInfo.isFile(), 'providers.json is a regular file');
  assert.equal(providersInfo.uid, process.getuid(), 'providers.json is same-uid');
  assert.equal(providersInfo.mode & 0o777, 0o600, 'providers.json is 0600');

  let child = spawnHost([
    'start', '--home', home, '--model', MODEL, '--heading', 'Wake smoke.',
    '--heartbeat-seconds', '1', '--no-sandbox',
  ]);
  await waitParked(child, 1);
  await waitParked(child, 2);
  await waitParked(child, 3);
  const pause1 = await runCli(['pause', '--home', home]);
  assert.equal(pause1.code, 0, cliFailure('first pause failed', pause1));
  assert.equal(await waitClosed(child), 0, 'the first host exits 0');

  // Down past at least one 1 s cadence slot: the resume must open one initial
  // turn and one fresh cadence, never a burst of missed slots.
  await sleep(1500);

  child = spawnHost(['resume', '--home', home, '--no-sandbox']);
  await waitParked(child, 1);
  await waitParked(child, 2);
  const pause2 = await runCli(['pause', '--home', home]);
  assert.equal(pause2.code, 0, cliFailure('second pause failed', pause2));
  assert.equal(await waitClosed(child), 0, 'the resumed host exits 0');

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  liveServers.delete(server);

  // --- observations from the compiled readers, after both hosts closed -------
  const events = await loadVerifiedEvents(home, UID, C13_EVENT_TYPES);
  const turnStarts = starts(events);
  const turnEnds = ends(events);
  assert.equal(requests.length, 5, 'exactly five provider requests');
  assert.equal(turnStarts.length, 5, 'exactly five turn/start');
  assert.equal(turnEnds.length, 5, 'exactly five turn/end');
  assert.deepEqual(turnStarts.map(triggerOf), ['boot', 'cadence', 'timer', 'boot', 'cadence']);
  assert.ok(!turnStarts.some((event) => triggerOf(event) === 'wakeup'
    || triggerOf(event) === 'conversation'), 'the quiet solo run has no wakeup/conversation turn');

  for (const request of requests) {
    // Boolean on purpose: a failing assert.equal would print the actual header
    // (the fake Bearer) into the operator's failure text.
    assert.ok(request.authorization === `Bearer ${FAKE_KEY}`,
      'every request carries the expected Bearer authorization');
  }

  // The journaled modern config is folded (never assumed inline/artifact-free).
  const fold = new ContextFold();
  await fold.observe(events);
  const config = fold.snapshot().config?.value;
  assert.ok(config !== undefined, 'the local log holds a configuration');
  assert.equal(config.version, 1, 'the configuration version is 1');
  assert.deepEqual(config.policy.wake, { heartbeatSeconds: 1 }, 'policy.wake is exactly heartbeat 1');
  assert.ok(!('wakeBudgetPerHour' in config.policy), 'fresh composition omits the old cost key');
  const expectedPolicy = { ...defaultAgentConfig().policy };
  delete expectedPolicy.wakeBudgetPerHour;
  expectedPolicy.wake = { heartbeatSeconds: 1 };
  assert.deepEqual(config.policy, expectedPolicy,
    'every other policy field equals the factory policy minus the old key');

  // Every request is its turn's ordinal 0 and carries exactly one receipt.
  const boots = events.filter((event) => event.type === 'node/boot');
  assert.equal(boots.length, 2, 'one start boot and one resume boot');
  assert.equal(boots.at(-1).data.reason, 'resume', 'the last boot reason is resume');
  const firstShutdown = events.findIndex((event) => event.type === 'node/shutdown');
  const resumeBoot = events.findIndex((event, index) => index > firstShutdown
    && event.type === 'node/boot');
  assert.ok(firstShutdown >= 0 && resumeBoot > firstShutdown, 'shutdown precedes the resume boot');

  for (let index = 0; index < 5; index += 1) {
    const request = requests[index];
    assert.equal(waitToolOf(bodyOf(request)).parameters.properties.after_seconds !== undefined,
      true, `request ${index} advertises after_seconds`);
    assert.deepEqual(
      Object.keys(waitToolOf(bodyOf(request)).parameters.properties).sort(),
      ['after_seconds', 'until'], 'the modern wait advertises after_seconds and until only');
    const receipt = receiptOf(request);
    const match = RECEIPT_RE.exec(receipt);
    assert.ok(match !== null, `request ${index} receipt matches the exact template`);
    const [, iso, trigger, elapsed] = match;
    assert.equal(trigger, triggerOf(turnStarts[index]), `request ${index} receipt trigger`);
    assert.ok(iso.endsWith('Z'), `request ${index} receipt is UTC`);
    assert.equal(Date.parse(iso), turnStarts[index].time,
      `request ${index} receipt opened_at is the turn/start envelope time`);
    if (index === 0) {
      assert.equal(elapsed, 'unavailable', 'the first turn has no preceding recorded end');
    } else {
      assert.equal(Number(elapsed), turnStarts[index].time - turnEnds[index - 1].time,
        `request ${index} receipt elapsed is since the preceding recorded turn/end`);
    }
  }

  // Slow dispatch continued after the wait: both calls completed; the execute's
  // own two seconds are visible before the turn closed.
  const calls = events
    .filter((event) => event.type === 'tool/call' && event.data.request?.turn === 1)
    .map((event) => event.data.call);
  assert.equal(calls.length, 2, 'the cadence turn called wait and execute');
  assert.deepEqual(calls.map((call_) => call_.function.name), ['wait', 'execute'],
    'the cadence turn advertised wait then execute');
  assert.equal(calls.find((call_) => call_.function.name === 'execute')?.function.arguments,
    JSON.stringify({ cmd: 'sleep 2' }), 'the execute command is the deliberate sleep');
  const turn1Results = events.filter((event) => event.type === 'tool/result'
    && event.data.request?.turn === 1);
  assert.equal(turn1Results.length, 2, 'both turn-1 calls have results');
  for (const result of turn1Results) {
    assert.equal(result.data.isError, false, 'turn-1 results are not errors');
    assert.equal(result.data.synthetic, false, 'turn-1 results are not synthetic');
  }
  assert.ok(turnEnds[1].time - requests[1].respondedAt >= 1800,
    'the slow execute continued for at least 1800 ms before the turn ended');

  // Actual-park anchor and floor suppression: the 1 s rest/grid lower bound on
  // the cadence turn, and a ~3 s relative timer anchored at the park (a timer
  // precomputed at dispatch would land about 1 s after the park).
  assert.ok(turnStarts[1].time - turnEnds[0].time >= 900,
    'the cadence turn respects the 1 s rest/grid lower bound');
  assert.ok(turnStarts[2].time - turnEnds[1].time >= 2500,
    'the relative timer is anchored at the actual park, not at dispatch');
  assert.equal(triggerOf(turnStarts[2]), 'timer', 'turn 2 is the explicit timer');

  // Resume/no missed-slot burst: exactly two post-resume starts, the first not
  // cadence, the second a fresh cadence at least the rest bound later; no two
  // post-resume starts closer than 500 ms.
  const postResume = turnStarts.filter((event) => event.seq > events[resumeBoot].seq);
  assert.equal(postResume.length, 2, 'exactly two post-resume turns');
  assert.notEqual(triggerOf(postResume[0]), 'cadence', 'the resume initial turn is not cadence');
  assert.equal(triggerOf(postResume[1]), 'cadence', 'the resumed cadence turn fires');
  assert.ok(postResume[1].time - turnEnds[3].time >= 900,
    'the resumed cadence respects the rest/grid lower bound');
  assert.ok(postResume[1].time - postResume[0].time >= 500,
    'no two post-resume starts are closer than 500 ms');

  // Secrets discipline: the fake key appears in no child stderr/stdout line and
  // in no request body; this is the REAL generated key, not a placeholder.
  for (const capture of captures) {
    for (const line of [...capture.lines, capture.stdout]) {
      assert.ok(!line.includes(FAKE_KEY), 'the fake key never reaches child output');
    }
  }
  assert.ok(!requests.some((request) => request.body.includes(FAKE_KEY)),
    'the fake key never rides a request body');
}

let completed = false;
const watchdog = setTimeout(() => {
  for (const child of liveChildren) child.kill('SIGKILL');
  for (const server of liveServers) {
    server.closeAllConnections();
    server.close();
  }
  for (const home of homes) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.stderr.write(`wake-policy smoke: watchdog: exceeded ${WATCHDOG_MS} ms\n`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

try {
  await main();
  completed = true;
  clearTimeout(watchdog);
  process.stdout.write('wake-policy smoke: ok\n');
} catch (error) {
  fail('run', error instanceof Error ? error.message : String(error));
} finally {
  // `liveChildren` holds exactly the children not yet CLOSED: kill each and
  // await its close, so final stdio is settled before the home goes.
  for (const child of [...liveChildren]) {
    child.kill('SIGKILL');
    await child.smoke.closed;
  }
  for (const server of liveServers) {
    server.closeAllConnections();
    server.close();
  }
  // Every temp home goes, on success and on failure: the script's own tracked
  // children/servers are settled above. The watchdog is the bounded backstop.
  for (const home of homes) await rm(home, { recursive: true, force: true }).catch(() => {});
}

if (!completed) process.exitCode = 1;
