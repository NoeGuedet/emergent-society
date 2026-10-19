import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import {
  access, chmod, mkdtemp, mkdir, rm, readFile, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { buildSandboxSpec, type SandboxSpec } from '../tools/sandbox.js';
import {
  DEFAULT_TERMINAL_ENV, PtyTerminalRuntime,
} from '../tools/terminal.js';
import type { CommandLimits, CommandOutcome, TerminalRuntime } from '../tools/terminal.js';

/**
 * Terminal tests (C1.4b): real PTYs, real bash, real processes. Assertions are
 * about statuses and bytes, never wall-clock timings; command timeouts in
 * fixtures stay ≥ 300 ms so a loaded machine cannot flip a verdict.
 */

let dir: string;
let runtimes: TerminalRuntime[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'c14b-terminal-'));
  runtimes = [];
});
afterEach(async () => {
  for (const rt of runtimes) await rt.dispose(100);
  await rm(dir, { recursive: true, force: true });
});

function terminal(): TerminalRuntime {
  const rt = new PtyTerminalRuntime(dir, DEFAULT_TERMINAL_ENV, 'off');
  runtimes.push(rt);
  return rt;
}

function limits(over: Partial<CommandLimits> = {}): CommandLimits {
  return { timeoutMs: 5000, killGraceMs: 100, maxCaptureBytes: 1024 * 1024, ...over };
}

function text(outcome: CommandOutcome): string {
  return Buffer.from(outcome.output).toString('utf8');
}

/** Existence probe, the same one the runtime uses: a reaped pid answers ESRCH. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Poll-with-deadline (the house pattern) rather than a fixed settle. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  expect(predicate()).toBe(true);
}

describe('PtyTerminalRuntime', () => {
  it('runs a command and reads its sliced output and exit code', async () => {
    const outcome = await terminal().run('echo hello-$((6*7))', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({
      status: 'completed', exitCode: 0, truncated: false, reset: false, fresh: null,
    });
    expect(text(outcome)).toMatch(/hello-42\r?\n/);
  }, 10000);

  it('keeps shell state across calls (cwd, exports)', async () => {
    const rt = terminal();
    await rt.run('mkdir sub && cd sub && export MARKER=kept', limits(), new AbortController().signal);
    const outcome = await rt.run('pwd && echo "$MARKER"', limits(), new AbortController().signal);
    expect(outcome.status).toBe('completed');
    expect(text(outcome)).toContain(join(dir, 'sub'));
    expect(text(outcome)).toContain('kept');
  }, 10000);

  it('runs a multi-line command without PS2 noise', async () => {
    const outcome = await terminal().run('printf \'a\\nb\\n\'\necho done', limits(), new AbortController().signal);
    expect(outcome.status).toBe('completed');
    expect(text(outcome)).toMatch(/a\r?\nb\r?\n/);
    expect(text(outcome)).toContain('done');
    expect(text(outcome)).not.toContain('> ');
  }, 10000);

  it('sees only the injected environment', async () => {
    const outcome = await terminal().run('echo "P=$PATH H=${HOME:-unset}"', limits(), new AbortController().signal);
    expect(text(outcome)).toContain('P=/usr/bin:/bin');
    expect(text(outcome)).toContain('H=unset');
  }, 10000);

  it('an `exit` command ends the session (session_exit carries the shell code)', async () => {
    const outcome = await terminal().run('exit 3', { ...limits() }, new AbortController().signal);
    expect(outcome.status).toBe('session_exit');
    expect(outcome.exitCode).toBe(3);
    // node-pty reports signal 0 for a clean exit: the outcome must say null.
    expect(outcome.signal).toBeNull();
    expect(outcome.reset).toBe(true);
  }, 10000);

  it('a shell killed by a signal is a session_exit by signal and resets the session', async () => {
    const rt = terminal();
    const outcome = await rt.run('kill -9 $$', limits(), new AbortController().signal);
    // node-pty's exit code for a signal death varies: only the signal is asserted.
    expect(outcome).toMatchObject({ status: 'session_exit', signal: 'SIGKILL', reset: true });
    const next = await rt.run('echo fresh', limits(), new AbortController().signal);
    expect(next).toMatchObject({ status: 'completed', exitCode: 0, fresh: null });
  }, 15000);

  it('completes the idle-death path: a shell killed at rest respawns silently', async () => {
    const rt = terminal();
    const signal = new AbortController().signal;
    // The background subshell records the shell pid, kills it ~200 ms later.
    // `$$` (not `$PPID`) is the invoking shell's pid inside a subshell;
    // `$PPID` would signal the kernel process.
    const first = await rt.run(
      '(echo $$ > killed.pid; sleep 0.2; kill -9 $$) & echo scheduled', limits(), signal);
    expect(first).toMatchObject({ status: 'completed', exitCode: 0 });
    const pidFile = join(dir, 'killed.pid');
    let pid = 0;
    await waitFor(() => {
      try {
        pid = Number(readFileSync(pidFile, 'utf8'));
        return Number.isSafeInteger(pid) && pid > 0;
      } catch {
        return false;
      }
    });
    // Poll until the shell is reaped. From then on either its exit event has
    // landed (idle-death branch) or the pre-write probe sees the death — both
    // now take the same silent-respawn path, so no fixed settle is needed.
    await waitFor(() => !alive(pid));
    const outcome = await rt.run('echo alive', limits(), signal);
    expect(outcome).toMatchObject({
      status: 'completed', exitCode: 0, reset: false, fresh: null,
    });
    expect(text(outcome)).toContain('alive');
  }, 15000);

  it('a shell killed mid-command fails fast as session_exit, not at the timeout', async () => {
    const rt = terminal();
    const signal = new AbortController().signal;
    // The killer waits for the second command's own marker, so it can only fire
    // after that command has been written and is in flight — no scheduling
    // window stands between the write and the kill (a kill before the write
    // would leave the runtime to respawn silently and report `timeout`). The
    // poll is bounded (~10 s) so a regression that never writes the marker
    // leaves no orphaned loop behind, and it kills only when the marker exists,
    // so a missing marker fails as `timeout` instead of a false `session_exit`.
    await rt.run(
      '(i=0; while [ ! -f mid.marker ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done; '
        + 'if [ -f mid.marker ]; then kill -9 $$; fi) & echo scheduled',
      limits(), signal);
    const outcome = await rt.run(
      'echo mid > mid.marker; sleep 30', limits({ timeoutMs: 5000 }), signal);
    expect(outcome).toMatchObject({ status: 'session_exit', reset: true });
    const next = await rt.run('echo fresh', limits(), signal);
    expect(next).toMatchObject({ status: 'completed', exitCode: 0, fresh: null });
  }, 15000);

  it('renders a signal death by its canonical name (SIGABRT, not SIGIOT)', async () => {
    const outcome = await terminal().run('kill -6 $$', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'session_exit', signal: 'SIGABRT', reset: true });
  }, 15000);

  it('a plain failing command keeps the session alive', async () => {
    const rt = terminal();
    const bad = await rt.run('false', limits(), new AbortController().signal);
    expect(bad).toMatchObject({ status: 'completed', exitCode: 1, reset: false });
    const good = await rt.run('echo alive', limits(), new AbortController().signal);
    expect(good.status).toBe('completed');
    expect(text(good)).toContain('alive');
  }, 10000);

  it('a command waiting on stdin yields stdin_read and is not reset', async () => {
    const rt = terminal();
    const outcome = await rt.run('read answer', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'stdin_read', exitCode: null, reset: false });
  }, 15000);

  it('the next command after a stdin_read resets first and reports it', async () => {
    const rt = terminal();
    await rt.run('read answer', limits(), new AbortController().signal);
    const outcome = await rt.run('echo fresh', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'completed', exitCode: 0, fresh: 'stdin-wedge' });
    expect(text(outcome)).toContain('fresh');
  }, 15000);

  it('a pre-write abort after a stdin wedge reports the reset it performed', async () => {
    const rt = terminal();
    const wedged = await rt.run('read answer', limits(), new AbortController().signal);
    expect(wedged.status).toBe('stdin_read');
    // The wedge reset runs before the abort check, so the session WAS killed:
    // the outcome must say so instead of hiding the reset behind reset:false.
    const controller = new AbortController();
    controller.abort();
    const outcome = await rt.run('echo never', limits(), controller.signal);
    expect(outcome).toMatchObject({
      status: 'cancelled', reset: true, fresh: 'stdin-wedge',
    });
  }, 15000);

  it('a redirected-stdin read completes without wedging or resetting the session', async () => {
    const rt = terminal();
    const signal = new AbortController().signal;
    // The proof must not mistake this builtin's pipe fd 0 for the tty: the
    // command runs to completion, and the session survives for the next call.
    const redirected = await rt.run(
      'read x < <(sleep 1; echo hi); echo "got:$x"', limits(), signal);
    expect(redirected).toMatchObject({
      status: 'completed', exitCode: 0, reset: false, fresh: null,
    });
    expect(text(redirected)).toContain('got:hi');
    const followUp = await rt.run('echo same-session', limits(), signal);
    expect(followUp).toMatchObject({
      status: 'completed', exitCode: 0, reset: false, fresh: null,
    });
    expect(text(followUp)).toContain('same-session');
  }, 15000);

  it('a timeout returns the partial output and resets the session', async () => {
    const rt = terminal();
    // 3 s, not a 700 ms race: the assertion is that output written before the
    // timeout survives it, so the bound must not compete with a loaded shell's
    // startup. The sleep keeps the command running until the timeout fires.
    const outcome = await rt.run('echo before; sleep 30', limits({ timeoutMs: 3000 }),
      new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'timeout', exitCode: null, reset: true });
    expect(text(outcome)).toContain('before');
    const next = await rt.run('echo fresh', limits(), new AbortController().signal);
    expect(next).toMatchObject({ status: 'completed', exitCode: 0, fresh: null });
  }, 15000);

  it('a backgrounded command returns immediately and lives in the session', async () => {
    const rt = terminal();
    const outcome = await rt.run('(sleep 30; touch bg-done.txt) & BGJOB=$!; echo "launched $BGJOB"',
      limits(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(text(outcome)).toContain('launched');
    // The background job is still running: the file does not exist yet.
    await expect(readFile(join(dir, 'bg-done.txt'), 'utf8')).rejects.toThrow();
    // SIGTERM the pid the session itself remembered — never a global pattern.
    // (Its `sleep` child may outlive it briefly; harmless to every assertion,
    // and the runtime's own reset/teardown is what a real session would do.)
    await rt.run('kill "$BGJOB" 2>/dev/null || true', limits(), new AbortController().signal);
  }, 15000);

  it('a capture overflow keeps the prefix and still completes the command', async () => {
    const rt = terminal();
    const outcome = await rt.run('seq 1 5000', limits({ maxCaptureBytes: 4096 }),
      new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'completed', exitCode: 0, truncated: true });
    expect(outcome.output.length).toBe(4096);
  }, 15000);

  it('captures a large chunk-split output byte-exactly with no marker leak', async () => {
    const rt = terminal();
    const signal = new AbortController().signal;
    const expected = Buffer.from(
      Array.from({ length: 200000 }, (_, i) => `${i + 1}\r\n`).join(''), 'utf8');
    const outcome = await rt.run('seq 1 200000',
      limits({ timeoutMs: 20000, maxCaptureBytes: 2 * 1024 * 1024 }), signal);
    expect(outcome).toMatchObject({ status: 'completed', exitCode: 0, truncated: false });
    const captured = Buffer.from(outcome.output);
    // Exact bytes: no duplicate, dropped or held-back tail at any chunk edge,
    // and no marker bytes spliced into the payload.
    expect(captured.equals(expected)).toBe(true);
    expect(captured.includes('__ES_EXECUTE_')).toBe(false);
    // The cap is byte-exact, not chunk-granular: the retained prefix equals
    // the expected prefix up to the boundary.
    const capped = await rt.run('seq 1 200000',
      limits({ timeoutMs: 20000, maxCaptureBytes: 100000 }), signal);
    expect(capped).toMatchObject({ status: 'completed', exitCode: 0, truncated: true });
    expect(Buffer.from(capped.output).equals(expected.subarray(0, 100000))).toBe(true);
  }, 30000);

  it('an abort mid-command cancels and resets the session', async () => {
    const rt = terminal();
    const controller = new AbortController();
    // Abort only after a positive observable proves the command was written and
    // running: a pre-write abort legitimately answers `reset: false`, so a timer
    // race would assert the wrong path under load.
    const started = join(dir, 'abort-started.txt');
    const pending = rt.run(`touch '${started}' && sleep 30`, limits(), controller.signal);
    await waitFor(() => {
      try { readFileSync(started); return true; } catch { return false; }
    });
    controller.abort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'cancelled', reset: true });
  }, 15000);

  it('a pre-write abort cancels without touching the session', async () => {
    const rt = terminal();
    const controller = new AbortController();
    controller.abort();
    const outcome = await rt.run('echo never', limits(), controller.signal);
    expect(outcome).toMatchObject({ status: 'cancelled', reset: false });
    // The session was never spawned: a later healthy call boots it fresh.
    const next = await rt.run('echo booted', limits(), new AbortController().signal);
    expect(next.status).toBe('completed');
  }, 15000);

  it('concurrent calls serialize on the one session', async () => {
    const rt = terminal();
    const signal = new AbortController().signal;
    const first = rt.run('sleep 0.3; echo one >> order.txt', limits(), signal);
    const second = rt.run('echo two >> order.txt', limits(), signal);
    await Promise.all([first, second]);
    expect(await readFile(join(dir, 'order.txt'), 'utf8')).toBe('one\ntwo\n');
  }, 15000);

  it('a disposed runtime reports spawn-failed and dispose is idempotent', async () => {
    const rt = terminal();
    await rt.run('echo once', limits(), new AbortController().signal);
    await rt.dispose(100);
    await rt.dispose(100);
    const outcome = await rt.run('echo never', limits(), new AbortController().signal);
    expect(outcome.status).toBe('spawn-failed');
  }, 15000);

  it('dispose waits behind an in-flight command, then refuses later runs', async () => {
    const rt = terminal();
    const signal = new AbortController().signal;
    const inFlight = rt.run('sleep 0.4; echo finished', limits(), signal);
    // Disposal is FIFO: this promise settles only after the command does, and
    // the command must still complete rather than be torn down mid-write.
    const disposing = rt.dispose(100);
    const outcome = await inFlight;
    expect(outcome).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(text(outcome)).toContain('finished');
    await disposing;
    const after = await rt.run('echo never', limits(), signal);
    expect(after.status).toBe('spawn-failed');
  }, 15000);

  it('a spawn failure is an outcome carrying the pre-flight diagnostic, never a throw', async () => {
    // The cwd pre-flight (statSync) refuses a missing directory before node-pty
    // can fork a child that would die in chdir masquerading as a session_exit.
    const missing = join(dir, 'no-such-dir');
    const rt = new PtyTerminalRuntime(missing, DEFAULT_TERMINAL_ENV, 'off');
    runtimes.push(rt);
    const outcome = await rt.run('echo x', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'spawn-failed', exitCode: null, reset: false });
    // The thrown error's message is the outcome's diagnostic: a spawn failure
    // that raced the filesystem must not look like a failed probe.
    expect(text(outcome)).toContain(missing);
  }, 10000);

  it('bounds the spawn diagnostic instead of carrying a raw error message', async () => {
    // A cwd longer than PATH_MAX makes the pre-flight's `statSync` throw with
    // the attempted path in its message. That message must not become the
    // outcome verbatim: the diagnostic shares the pre-start stderr's bound.
    const longCwd = join(dir, 'x'.repeat(10_000));
    const rt = new PtyTerminalRuntime(longCwd, DEFAULT_TERMINAL_ENV, 'off');
    runtimes.push(rt);
    const outcome = await rt.run('echo x', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'spawn-failed', exitCode: null, reset: false });
    expect(outcome.output.length).toBe(4096);
    expect(text(outcome)).toContain('ENAMETOOLONG');
  }, 10000);

  it('surfaces the exact pre-flight message when the cwd is not a directory', async () => {
    const notADirectory = join(dir, 'cwd-is-a-file');
    await writeFile(notADirectory, 'this is not a directory\n');
    const rt = new PtyTerminalRuntime(notADirectory, DEFAULT_TERMINAL_ENV, 'off');
    runtimes.push(rt);
    const outcome = await rt.run('echo x', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'spawn-failed', exitCode: null, reset: false });
    expect(text(outcome)).toContain(`execute cwd is not a directory: ${notADirectory}`);
  }, 10000);

  it('surfaces the spawn diagnostic when the pre-write respawn throws', async () => {
    // The second catch (the respawn after a fresh fork is found dead before the
    // command is written) is only reachable through an OS-level race: the
    // spawn's tty is normally already frozen when the runtime looks, so no
    // await separates the two liveness probes and a wall-clock test would be
    // flaky by construction. The branch under test is the catch-and-diagnose
    // wiring, not the PTY: the session is real, and only the second `kill(pid,
    // 0)` probe is substituted to report the death the branch exists for.
    const cwd = join(dir, 'respawn-cwd');
    await mkdir(cwd);
    const rt = new PtyTerminalRuntime(cwd, DEFAULT_TERMINAL_ENV, 'off');
    runtimes.push(rt);
    const signal = new AbortController().signal;
    const first = await rt.run('echo $$', limits(), signal);
    expect(first).toMatchObject({ status: 'completed', exitCode: 0 });
    const shellPid = Number(text(first).trim());
    expect(Number.isSafeInteger(shellPid) && shellPid > 0).toBe(true);

    // Let the entry check's probe pass, then report the shell gone on every
    // later one — the documented "freshly forked shell died before the write"
    // state. The cwd becomes a file at the same time, so the respawn's own
    // pre-flight is what throws.
    let probes = 0;
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === shellPid && sig === 0) {
        probes += 1;
        if (probes > 1) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      }
      return realKill(pid, sig);
    });
    try {
      await rm(cwd, { recursive: true, force: true });
      await writeFile(cwd, 'this is not a directory\n');
      const outcome = await rt.run('echo never', limits(), signal);
      expect(outcome).toMatchObject({ status: 'spawn-failed', exitCode: null, reset: false });
      expect(text(outcome)).toContain(`execute cwd is not a directory: ${cwd}`);
      expect(probes).toBeGreaterThanOrEqual(2);
    } finally {
      killSpy.mockRestore();
      // The runtime dropped the session before the respawn threw; reap it here.
      try { realKill(shellPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, 15000);

  it('a spawn failure after a stdin wedge reports the reset it performed', async () => {
    // The wedge reset runs before the respawn; when that respawn then fails,
    // the outcome must not claim reset:false — the session was killed.
    const gone = join(dir, 'vanishing');
    await mkdir(gone);
    const rt = new PtyTerminalRuntime(gone, DEFAULT_TERMINAL_ENV, 'off');
    runtimes.push(rt);
    const wedged = await rt.run('read answer', limits(), new AbortController().signal);
    expect(wedged.status).toBe('stdin_read');
    await rm(gone, { recursive: true, force: true });
    const outcome = await rt.run('echo never', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({
      status: 'spawn-failed', exitCode: null, reset: true, fresh: 'stdin-wedge',
    });
    // The reset-and-refuse path carries its own diagnostic too.
    expect(text(outcome)).toContain(gone);
  }, 15000);
});

/**
 * The confined spawn (C1.4c): real PTYs behind the real launcher. World and
 * home are separate leaves of the suite's temp root (the builder refuses a home
 * inside the world); the launcher suites skip when the binary is absent — the
 * vitest globalSetup builds it, so a full run always has it.
 */
const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const launcherBinary = join(projectRoot, 'native', 'es-landlock', 'es-landlock');
const launcherPresent = existsSync(launcherBinary);

async function sandboxDirs(): Promise<{ world: string; home: string }> {
  const world = join(dir, 'sb-world');
  const home = join(dir, 'sb-home');
  await mkdir(world);
  await mkdir(home);
  return { world, home };
}

async function realSpec(): Promise<{ spec: SandboxSpec; world: string }> {
  const { world, home } = await sandboxDirs();
  return { spec: await buildSandboxSpec({ world, home, uid: 'node-a' }), world };
}

describe('PtyTerminalRuntime confinement', () => {
  it.skipIf(!launcherPresent)(
    'runs a command under the real launcher and reports the probed status',
    async () => {
      const { spec, world } = await realSpec();
      const rt = new PtyTerminalRuntime(world, DEFAULT_TERMINAL_ENV, spec);
      runtimes.push(rt);
      // Not probed yet: the status is unknown, never "off".
      expect(rt.sandboxStatus()).toBeNull();
      const outcome = await rt.run('echo ok', limits(), new AbortController().signal);
      expect(outcome).toMatchObject({
        status: 'completed', exitCode: 0, truncated: false, reset: false, fresh: null,
      });
      expect(text(outcome)).toContain('ok');
      expect(text(outcome)).not.toContain('__ES_EXECUTE_');
      const status = rt.sandboxStatus();
      expect(status?.mode).toBe('landlock');
      if (status?.mode === 'landlock') {
        expect(status.abi).toBeGreaterThanOrEqual(3);
        expect(status.enforcement).toBe('full');
      }
    },
    20000,
  );

  it(
    'a failed probe settles spawn-failed with its diagnostic and is never re-probed',
    async () => {
      const { world, home } = await sandboxDirs();
      const counter = join(dir, 'probe-count.txt');
      const launcher = join(dir, 'es-landlock-failing');
      await writeFile(launcher, '#!/bin/sh\n'
        + `printf 'x\\n' >> '${counter}'\n`
        + "printf 'es-landlock: probe-deny: Permission denied\\n' >&2\nexit 125\n");
      await chmod(launcher, 0o755);
      const spec = await buildSandboxSpec({ world, home, uid: 'node-a', launcherPath: launcher });
      const rt = new PtyTerminalRuntime(world, DEFAULT_TERMINAL_ENV, spec);
      runtimes.push(rt);
      const first = await rt.run('echo one', limits(), new AbortController().signal);
      const second = await rt.run('echo two', limits(), new AbortController().signal);
      for (const outcome of [first, second]) {
        expect(outcome).toMatchObject({ status: 'spawn-failed', exitCode: null, reset: false });
        expect(text(outcome)).toContain('es-landlock: probe-deny: Permission denied');
      }
      // One probe across two runs: the settled memo, not a per-run retry.
      expect(await readFile(counter, 'utf8')).toBe('x\n');
      expect(rt.sandboxStatus()).toBeNull();
    },
    20000,
  );

  it.skipIf(!launcherPresent)(
    'classifies a pre-start launcher death as spawn-failed carrying its line',
    async () => {
      const { spec, world } = await realSpec();
      const rt = new PtyTerminalRuntime(world, DEFAULT_TERMINAL_ENV, spec);
      runtimes.push(rt);
      const signal = new AbortController().signal;
      const first = await rt.run('echo alive', limits(), signal);
      expect(first).toMatchObject({ status: 'completed', exitCode: 0 });
      const exited = await rt.run('exit 0', limits(), signal);
      expect(exited.status).toBe('session_exit');
      // Delete a grant that is not the cwd: the launcher's grant open hits
      // ENOENT before any restriction, so it dies 125 with its `es-landlock:`
      // line and bash never runs. (Deleting the world would trip the cwd
      // pre-flight and prove nothing.)
      await rm(spec.scratchDir, { recursive: true, force: true });
      let outcome = await rt.run('echo never', limits(), signal);
      if (outcome.status !== 'spawn-failed') {
        // The bounded retry covers the `exitedOrUnknown` unknown-code window on
        // a loaded machine: the conjunction fails on a null code by design, so
        // one more deterministic pre-start death is asked for.
        outcome = await rt.run('echo never', limits(), signal);
      }
      expect(outcome.status).toBe('spawn-failed');
      expect(text(outcome)).toContain('es-landlock:');
      expect(outcome.reset).toBe(true);
    },
    30000,
  );

  it.skipIf(!launcherPresent)(
    'owns HOME, TMPDIR and HISTFILE, and leaves no history in the world',
    async () => {
      const { spec, world } = await realSpec();
      const rt = new PtyTerminalRuntime(world, DEFAULT_TERMINAL_ENV, spec);
      runtimes.push(rt);
      const signal = new AbortController().signal;
      const outcome = await rt.run(
        'printf "%s|%s|%s\\n" "$HOME" "$TMPDIR" "$HISTFILE"', limits(), signal);
      expect(outcome.status).toBe('completed');
      expect(text(outcome)).toContain(
        `${spec.env.HOME}|${spec.env.TMPDIR}|/dev/null`);
      // An interactive bash commits `.bash_history` into $HOME at exit unless
      // HISTFILE is /dev/null — and $HOME is the (writable) world.
      const exited = await rt.run('exit 0', limits(), signal);
      expect(exited.status).toBe('session_exit');
      await expect(access(join(world, '.bash_history')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    },
    20000,
  );
});
