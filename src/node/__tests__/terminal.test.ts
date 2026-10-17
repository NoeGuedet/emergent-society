import { Buffer } from 'node:buffer';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  const rt = new PtyTerminalRuntime(dir, DEFAULT_TERMINAL_ENV);
  runtimes.push(rt);
  return rt;
}

function limits(over: Partial<CommandLimits> = {}): CommandLimits {
  return { timeoutMs: 5000, killGraceMs: 100, maxCaptureBytes: 1024 * 1024, ...over };
}

function text(outcome: CommandOutcome): string {
  return Buffer.from(outcome.output).toString('utf8');
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
    // The background subshell kills the shell ~200 ms later and then proves it
    // happened by touching the marker. `$$` (not `$PPID`) is the invoking
    // shell's pid inside a subshell; `$PPID` would signal the kernel process.
    const first = await rt.run(
      '(sleep 0.2; kill -9 $$; : > killed.marker) & echo scheduled', limits(), signal);
    expect(first).toMatchObject({ status: 'completed', exitCode: 0 });
    const marker = join(dir, 'killed.marker');
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await readFile(marker); break; } catch { /* not yet */ }
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    // Let node-pty deliver the exit event: this test exercises the idle-death
    // respawn, not the pre-write liveness fallback.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    const outcome = await rt.run('echo alive', limits(), signal);
    expect(outcome).toMatchObject({
      status: 'completed', exitCode: 0, reset: false, fresh: null,
    });
    expect(text(outcome)).toContain('alive');
  }, 15000);

  it('a shell killed mid-command fails fast as session_exit, not at the timeout', async () => {
    const rt = terminal();
    const signal = new AbortController().signal;
    // The second run is issued immediately and writes while the shell is still
    // alive; the scheduled kill then lands mid-command. The poll-cadence
    // liveness re-check must settle in milliseconds, not 300 s.
    await rt.run('(sleep 0.2; kill -9 $$) & echo scheduled', limits(), signal);
    const started = Date.now();
    const outcome = await rt.run('sleep 30', limits({ timeoutMs: 5000 }), signal);
    expect(outcome).toMatchObject({ status: 'session_exit', reset: true });
    expect(Date.now() - started).toBeLessThan(4000);
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

  it('a timeout returns the partial output and resets the session', async () => {
    const rt = terminal();
    const outcome = await rt.run('echo before; sleep 30', limits({ timeoutMs: 700 }),
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
    const pending = rt.run('sleep 30', limits(), controller.signal);
    setTimeout(() => { controller.abort(); }, 300);
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

  it('a spawn failure is an outcome, never a throw', async () => {
    // The cwd pre-flight (statSync) refuses a missing directory before node-pty
    // can fork a child that would die in chdir masquerading as a session_exit.
    const rt = new PtyTerminalRuntime(join(dir, 'no-such-dir'), DEFAULT_TERMINAL_ENV);
    runtimes.push(rt);
    const outcome = await rt.run('echo x', limits(), new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'spawn-failed', exitCode: null, reset: false });
  }, 10000);
});
