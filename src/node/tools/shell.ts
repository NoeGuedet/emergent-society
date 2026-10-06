import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { canonicalizeJson } from '../../journal/index.js';
import type { JsonValue } from '../../journal/index.js';
import type { ArtifactRef, SafeFailure } from '../../context/contracts.js';

/**
 * Foreground shell execution (T7, kernel.md §4).
 *
 * One command runs in a detached Linux process group with only the injected
 * allowlisted environment; stdout and stderr are captured together under one
 * byte cap, and the returned `ShellResult` carries every fact as a distinct
 * flag. `runShell` resolves only after the leader is gone and its pipes, group
 * and timers are torn down: a timeout, an output overflow or a cancellation
 * sends SIGTERM to the group, escalates to SIGKILL after the configured grace,
 * then either sees `close` or, after a persisted drain deadline, records that an
 * escaped descendant still held the pipe (`drainExpired`) — it never claims to
 * have confined or killed a process it does not own.
 *
 * Environment sanitization is not confinement: raw bash can still escape the
 * world. The allowlist only reduces accidental host-key inheritance.
 */

export type ShellResult = {
  readonly stdout: Uint8Array; readonly stderr: Uint8Array;
  readonly exitCode: number | null; readonly signal: string | null;
  readonly timedOut: boolean; readonly truncated: boolean;
  readonly spawnFailed: boolean; readonly cancelled: boolean;
  readonly drainExpired: boolean;
};

export type ShellPolicy = {
  readonly timeoutMs: number; readonly killGraceMs: number;
  readonly maxCaptureBytes: number; readonly drainDeadlineMs: number;
  readonly env: Readonly<Record<string, string>>;
};

/** The default child environment: an allowlist, never the parent's `process.env`. */
export const DEFAULT_SHELL_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TERM: 'dumb',
});

/** The canonical-JSON wrapper carrying every shell fact for the raw artifact. */
export type ShellWrapper = {
  readonly stdoutBase64: string; readonly stderrBase64: string;
  readonly exitCode: number | null; readonly signal: string | null;
  readonly timedOut: boolean; readonly truncated: boolean;
  readonly spawnFailed: boolean; readonly cancelled: boolean; readonly drainExpired: boolean;
};

export function shellWrapper(result: ShellResult): ShellWrapper {
  return {
    stdoutBase64: Buffer.from(result.stdout).toString('base64'),
    stderrBase64: Buffer.from(result.stderr).toString('base64'),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    spawnFailed: result.spawnFailed,
    cancelled: result.cancelled,
    drainExpired: result.drainExpired,
  };
}

/** The canonical UTF-8 bytes of the raw wrapper artifact's content. */
export function shellArtifactBytes(result: ShellResult): Uint8Array {
  return Buffer.from(canonicalizeJson(shellWrapper(result) as unknown as JsonValue), 'utf8');
}

/**
 * `isError` is true for any failure flag, an explicit signal, or a nonzero exit;
 * an ordinary nonzero exit is an error with a null `failure` (no SafeFailure).
 */
export function shellIsError(result: ShellResult): boolean {
  return result.spawnFailed || result.cancelled || result.timedOut || result.truncated
    || result.drainExpired || result.signal !== null
    || (result.exitCode !== null && result.exitCode !== 0);
}

/**
 * The fixed precedence when more than one condition holds:
 * spawn > cancelled > timeout > output-limit (truncated) > signal. An ordinary
 * nonzero exit yields null. `drainExpired` is always accompanied by `truncated`,
 * so it classifies as output-limit.
 */
export function shellFailure(result: ShellResult): SafeFailure | null {
  if (result.spawnFailed) return { code: 'spawn', status: null };
  if (result.cancelled) return { code: 'cancelled', status: null };
  if (result.timedOut) return { code: 'timeout', status: null };
  if (result.truncated) return { code: 'output-limit', status: null };
  if (result.signal !== null) return { code: 'signal', status: null };
  return null;
}

function decodeUtf8(bytes: Uint8Array): string {
  // Non-fatal decoding replaces each invalid sequence with U+FFFD, the same
  // deterministic policy the Git renderer applies.
  return new TextDecoder('utf-8').decode(bytes);
}

/** Fixed status/channel labels over the decoded channels. */
export function renderShellText(result: ShellResult): string {
  const exitCode = result.exitCode === null ? 'null' : String(result.exitCode);
  const signal = result.signal === null ? 'null' : result.signal;
  return [
    `exitCode ${exitCode}`,
    `signal ${signal}`,
    `timedOut ${result.timedOut} truncated ${result.truncated} `
      + `spawnFailed ${result.spawnFailed} cancelled ${result.cancelled} `
      + `drainExpired ${result.drainExpired}`,
    'stdout:',
    decodeUtf8(result.stdout),
    'stderr:',
    decodeUtf8(result.stderr),
  ].join('\n');
}

/**
 * Cuts only at a code-point boundary, so a retained multibyte character is never
 * split and no U+FFFD is introduced by the model-text bound itself.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * Bounds the model-visible tool text to `maxBytes` UTF-8 bytes, measured after
 * deterministic decoding. The notice names the captured raw artifact's digest
 * and captured byte count — the retained prefix's own facts when capture was
 * incomplete, never the complete original's.
 */
export function boundShellText(text: string, maxBytes: number, raw: ArtifactRef): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const retained = truncateUtf8(text, maxBytes);
  const retainedBytes = Buffer.byteLength(retained, 'utf8');
  return retained + `\n[output truncated: showing ${retainedBytes} of ${raw.bytes} bytes; `
    + `raw sha256 ${raw.sha256}]`;
}

function cancelledResult(): ShellResult {
  return {
    stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: null, signal: null,
    timedOut: false, truncated: false, spawnFailed: false, cancelled: true, drainExpired: false,
  };
}

/**
 * Runs `/bin/bash --noprofile --norc -c <cmd>` in `cwd` as a detached process
 * group. The returned promise settles only after every pipe, listener and timer
 * this call owns has been released.
 */
export function runShell(
  cmd: string, cwd: string, signal: AbortSignal, policy: ShellPolicy,
): Promise<ShellResult> {
  // An abort that landed before spawn (including one during the caller's
  // `tool/call` flush) returns cancelled without ever spawning.
  if (signal.aborted) return Promise.resolve(cancelledResult());

  return new Promise<ShellResult>((resolve) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(policy.env)) env[key] = value;

    let child: ChildProcess;
    try {
      child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', cmd], {
        cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env,
      });
    } catch {
      resolve({
        stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: null, signal: null,
        timedOut: false, truncated: false, spawnFailed: true, cancelled: false, drainExpired: false,
      });
      return;
    }

    const pid = child.pid;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let captured = 0;
    let capped = false;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let spawnFailed = false;
    let drainExpired = false;
    let exitCode: number | null = null;
    let signalName: string | null = null;
    let leaderExited = false;
    let closed = false;
    let settled = false;
    let terminated = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
      if (graceTimer !== undefined) { clearTimeout(graceTimer); graceTimer = undefined; }
      if (drainTimer !== undefined) { clearTimeout(drainTimer); drainTimer = undefined; }
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal.removeEventListener('abort', onAbort);
      // Destroy only the local pipe ends this call owns; a still-running escaped
      // descendant is deliberately left alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks),
        exitCode, signal: signalName, timedOut, truncated, spawnFailed, cancelled, drainExpired,
      });
    };

    const killGroup = (sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try { process.kill(-pid, sig); } catch { /* the group may already be gone */ }
    };

    const terminate = (): void => {
      if (terminated) return;
      terminated = true;
      killGroup('SIGTERM');
      if (graceTimer === undefined) {
        graceTimer = setTimeout(() => { killGroup('SIGKILL'); }, policy.killGraceMs);
      }
    };

    const onAbort = (): void => {
      if (settled || leaderExited) return;
      cancelled = true;
      terminate();
    };

    const overflow = (): void => {
      if (capped) return;
      capped = true;
      truncated = true;
      terminate();
    };

    const captureInto = (target: Buffer[], chunk: Buffer): void => {
      if (capped) return;
      const remaining = policy.maxCaptureBytes - captured;
      if (remaining <= 0) { overflow(); return; }
      if (chunk.length > remaining) {
        target.push(Buffer.from(chunk.subarray(0, remaining)));
        captured += remaining;
        overflow();
      } else {
        target.push(Buffer.from(chunk));
        captured += chunk.length;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => { captureInto(stdoutChunks, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { captureInto(stderrChunks, chunk); });

    child.on('error', () => {
      // A synchronous/async spawn failure: no exit event will carry a code.
      if (!leaderExited && !settled) { spawnFailed = true; settle(); }
    });

    child.on('exit', (code, sig) => {
      leaderExited = true;
      exitCode = code;
      signalName = sig;
      if (timeoutTimer !== undefined) { clearTimeout(timeoutTimer); timeoutTimer = undefined; }
      if (graceTimer !== undefined) { clearTimeout(graceTimer); graceTimer = undefined; }
      // Reap any same-group descendant best effort; an escaped group is not ours.
      killGroup('SIGKILL');
      if (closed) { settle(); return; }
      drainTimer = setTimeout(() => {
        // The leader is gone but something still holds the pipe: destroy our own
        // ends, mark the capture incomplete, and leave the escapee alive.
        drainExpired = true;
        truncated = true;
        settle();
      }, policy.drainDeadlineMs);
    });

    child.on('close', () => {
      closed = true;
      if (drainTimer !== undefined) { clearTimeout(drainTimer); drainTimer = undefined; }
      if (leaderExited) settle();
    });

    signal.addEventListener('abort', onAbort, { once: true });
    timeoutTimer = setTimeout(() => {
      if (settled || leaderExited) return;
      timedOut = true;
      terminate();
    }, policy.timeoutMs);
  });
}
