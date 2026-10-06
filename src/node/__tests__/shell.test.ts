import { afterEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeJson } from '../../journal/index.js';
import {
  DEFAULT_SHELL_ENV, renderShellText, runShell, shellArtifactBytes, shellFailure,
  shellIsError, shellWrapper,
} from '../tools/shell.js';
import type { ShellPolicy, ShellResult } from '../tools/shell.js';

/**
 * Shell tests (T7): real foreground child processes driven through `runShell`.
 *
 * Every spawning test uses a short, bounded policy so a stuck fixture fails fast
 * instead of blocking the suite, and only processes this suite started (tracked
 * by their real PIDs) are ever signalled — never an unrelated host process.
 */

const dirs: string[] = [];
const escapedPids: number[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const pid of escapedPids.splice(0)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function policy(over: Partial<ShellPolicy> = {}): ShellPolicy {
  return {
    timeoutMs: 5000, killGraceMs: 100, maxCaptureBytes: 1024 * 1024,
    drainDeadlineMs: 200, env: DEFAULT_SHELL_ENV, ...over,
  };
}

function run(
  cmd: string, cwd: string, over: Partial<ShellPolicy> = {}, signal?: AbortSignal,
): Promise<ShellResult> {
  return runShell(cmd, cwd, signal ?? new AbortController().signal, policy(over));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readPid(path: string, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return Number((await readFile(path, 'utf8')).trim());
    } catch {
      if (Date.now() > deadline) throw new Error(`pid file never appeared: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe('runShell: real shell fixtures', () => {
  it('runs a command in the given cwd and leaves its effect', async () => {
    const dir = await tempDir('c13-shell-');
    const result = await run('printf hello > note.txt', dir);
    expect(await readFile(join(dir, 'note.txt'), 'utf8')).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.spawnFailed).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.drainExpired).toBe(false);
    expect(shellIsError(result)).toBe(false);
    expect(shellFailure(result)).toBeNull();
  }, 8000);

  it('reports an ordinary nonzero exit as isError with a null failure', async () => {
    const dir = await tempDir('c13-shell-');
    const result = await run('exit 7', dir);
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(shellIsError(result)).toBe(true);
    expect(shellFailure(result)).toBeNull();
  }, 8000);

  it('reports a signal death with the explicit signal name', async () => {
    const dir = await tempDir('c13-shell-');
    const result = await run('kill -TERM $$', dir);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(shellIsError(result)).toBe(true);
    expect(shellFailure(result)).toEqual({ code: 'signal', status: null });
  }, 8000);

  it('reports a spawn failure when the cwd does not exist', async () => {
    const dir = await tempDir('c13-shell-');
    const result = await run('printf x', join(dir, 'missing'));
    expect(result.spawnFailed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(shellIsError(result)).toBe(true);
    expect(shellFailure(result)).toEqual({ code: 'spawn', status: null });
  }, 8000);

  it('times out a long command and leaves no surviving process or group', async () => {
    const dir = await tempDir('c13-shell-');
    const pidFile = join(dir, 'child.pid');
    const result = await run('echo $$ > child.pid; sleep 30', dir,
      { timeoutMs: 40, killGraceMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(shellIsError(result)).toBe(true);
    expect(shellFailure(result)).toEqual({ code: 'timeout', status: null });

    const pid = await readPid(pidFile);
    expect(alive(pid)).toBe(false);
    expect(() => process.kill(-pid, 0)).toThrow();
  }, 8000);

  it('marks truncation when output exceeds the injected capture cap', async () => {
    const dir = await tempDir('c13-shell-');
    const result = await run('head -c 100000 /dev/zero | base64 -w 0', dir,
      { maxCaptureBytes: 1024 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1024);
    expect(shellIsError(result)).toBe(true);
    expect(shellFailure(result)).toEqual({ code: 'output-limit', status: null });
  }, 8000);

  it('cancels a running command via the abort signal and leaves no survivor', async () => {
    const dir = await tempDir('c13-shell-');
    const pidFile = join(dir, 'child.pid');
    const controller = new AbortController();
    const running = run('echo $$ > child.pid; sleep 30 & wait', dir,
      { timeoutMs: 60_000 }, controller.signal);
    const pid = await readPid(pidFile);
    controller.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(shellIsError(result)).toBe(true);
    expect(shellFailure(result)).toEqual({ code: 'cancelled', status: null });
    expect(alive(pid)).toBe(false);
  }, 8000);

  it('returns cancelled without spawning when the signal is already aborted', async () => {
    const dir = await tempDir('c13-shell-');
    const controller = new AbortController();
    controller.abort();
    const result = await run('printf x > should-not-exist.txt', dir, {}, controller.signal);
    expect(result.cancelled).toBe(true);
    expect(result.spawnFailed).toBe(false);
    await expect(readFile(join(dir, 'should-not-exist.txt'))).rejects.toThrow();
  }, 8000);

  it('drains an escaped descendant: destroys its own pipes, records expiry, never kills it', async () => {
    const dir = await tempDir('c13-shell-');
    const pidFile = join(dir, 'escaped.pid');
    // `setsid` moves the descendant out of the shell's process group while it
    // still holds the inherited stdout/stderr pipes, so `close` never fires.
    // The leader waits until the escapee has written its PID — proof that
    // `setsid` already ran and it is no longer in the shell's group.
    const result = await run(
      "setsid sh -c 'echo $$ > escaped.pid; sleep 30' & "
      + 'until [ -s escaped.pid ]; do sleep 0.01; done',
      dir, { timeoutMs: 5000, drainDeadlineMs: 100 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.drainExpired).toBe(true);
    expect(result.truncated).toBe(true);
    expect(shellIsError(result)).toBe(true);

    const pid = await readPid(pidFile);
    escapedPids.push(pid);
    // The escaped child was NOT killed — the shell only tore down what it owned.
    expect(alive(pid)).toBe(true);
  }, 8000);

  it('checks the child environment is exactly the injected allowlist', async () => {
    const dir = await tempDir('c13-shell-');
    process.env['C13_PARENT_SECRET'] = 'topsecret-do-not-pass';
    try {
      const env = { ...DEFAULT_SHELL_ENV, C13_FAKE: 'fake-only' };
      const result = await run(
        'printf "%s\\n" "$PATH"; printf "%s\\n" "$C13_FAKE"; printf "%s\\n" "$HOME"; env',
        dir, { env },
      );
      const out = Buffer.from(result.stdout).toString('utf8');
      expect(out).toContain('PATH=/usr/bin:/bin');
      expect(out).toContain('C13_FAKE=fake-only');
      expect(out).not.toContain('topsecret-do-not-pass');
      expect(out).not.toContain('C13_PARENT_SECRET');
      expect(out).not.toContain('HOME=');
    } finally {
      delete process.env['C13_PARENT_SECRET'];
    }
  }, 8000);
});

describe('runShell: raw artifact wrapper', () => {
  it('is canonical JSON carrying every shell fact and base64-exact channels', async () => {
    const dir = await tempDir('c13-shell-');
    const result = await run('printf out; printf err >&2', dir);
    const bytes = shellArtifactBytes(result);
    expect(Buffer.from(bytes).toString('utf8')).toBe(canonicalizeJson(shellWrapper(result)));

    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
      stdoutBase64: string; stderrBase64: string; exitCode: number | null; signal: string | null;
      timedOut: boolean; truncated: boolean; spawnFailed: boolean; cancelled: boolean;
      drainExpired: boolean;
    };
    expect(Buffer.from(parsed.stdoutBase64, 'base64').toString('utf8')).toBe('out');
    expect(Buffer.from(parsed.stderrBase64, 'base64').toString('utf8')).toBe('err');
    expect(parsed).toMatchObject({
      exitCode: 0, signal: null, timedOut: false, truncated: false,
      spawnFailed: false, cancelled: false, drainExpired: false,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'cancelled', 'drainExpired', 'exitCode', 'signal', 'spawnFailed',
      'stderrBase64', 'stdoutBase64', 'timedOut', 'truncated',
    ]);
  }, 8000);

  it('renders fixed status/channel labels', async () => {
    const dir = await tempDir('c13-shell-');
    const result = await run('printf out; printf err >&2', dir);
    const text = renderShellText(result);
    expect(text).toContain('exitCode 0');
    expect(text).toContain('signal null');
    expect(text).toContain('stdout:\nout');
    expect(text).toContain('stderr:\nerr');
    expect(text).toContain('timedOut false truncated false');
  }, 8000);
});

function shellResult(over: Partial<ShellResult> = {}): ShellResult {
  return {
    stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0, signal: null,
    timedOut: false, truncated: false, spawnFailed: false, cancelled: false,
    drainExpired: false, ...over,
  };
}

describe('runShell: failure classification and precedence', () => {
  it('is spawn > cancelled > timeout > output-limit > signal', () => {
    expect(shellFailure(shellResult({
      spawnFailed: true, cancelled: true, timedOut: true, truncated: true, signal: 'SIGKILL',
    }))).toEqual({ code: 'spawn', status: null });
    expect(shellFailure(shellResult({
      cancelled: true, timedOut: true, truncated: true, signal: 'SIGKILL',
    }))).toEqual({ code: 'cancelled', status: null });
    expect(shellFailure(shellResult({
      timedOut: true, truncated: true, signal: 'SIGKILL',
    }))).toEqual({ code: 'timeout', status: null });
    expect(shellFailure(shellResult({
      truncated: true, signal: 'SIGTERM',
    }))).toEqual({ code: 'output-limit', status: null });
    expect(shellFailure(shellResult({ signal: 'SIGTERM' })))
      .toEqual({ code: 'signal', status: null });
  });

  it('treats ordinary nonzero exit and drain expiry as errors (drain via truncated)', () => {
    expect(shellIsError(shellResult({ exitCode: 3 }))).toBe(true);
    expect(shellFailure(shellResult({ exitCode: 3 }))).toBeNull();
    expect(shellIsError(shellResult({ exitCode: 0 }))).toBe(false);
    expect(shellIsError(shellResult({ drainExpired: true, truncated: true }))).toBe(true);
    expect(shellFailure(shellResult({ drainExpired: true, truncated: true })))
      .toEqual({ code: 'output-limit', status: null });
  });
});
