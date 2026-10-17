import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import * as pty from '@lydell/node-pty';
import { stdinWaitPids } from './proc.js';

/**
 * The persistent PTY shell (C1.4b, kernel.md §4/§7): one bash session per
 * node, marker-encapsulated commands, typed statuses, reset-on-timeout.
 * The mechanics follow DeepSeek Harness's tool-bash-persistent; the divergences
 * are deliberate and documented in docs/plans/2026-10-15-c1-4b (arbitrations):
 * a stdin-wedged session is reset before the next command rather than fed,
 * completion wins over a same-tick abort, and a capture overflow never kills
 * the command. This module owns processes, not confinement: a reset kills the
 * shell and lets the pty teardown SIGHUP the foreground group — a backgrounded
 * or SIGHUP-ignoring process can survive, and the journal never claims
 * otherwise. The session does not survive a kernel restart (kernel.md §7).
 */

export type CommandLimits = {
  readonly timeoutMs: number; readonly killGraceMs: number; readonly maxCaptureBytes: number;
};

export type CommandStatus =
  'completed' | 'stdin_read' | 'timeout' | 'session_exit' | 'cancelled' | 'spawn-failed';

export type CommandOutcome = {
  readonly status: CommandStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: Uint8Array;
  readonly truncated: boolean;
  readonly reset: boolean;
  readonly fresh: 'stdin-wedge' | null;
};

/** The narrow port dispatch depends on; the runtime binds its session to it. */
export type TerminalPort = {
  run(cmd: string, limits: CommandLimits, signal: AbortSignal): Promise<CommandOutcome>;
};

export interface TerminalRuntime {
  run(cmd: string, limits: CommandLimits, signal: AbortSignal): Promise<CommandOutcome>;
  /** Kills the session and refuses later runs; safe to call twice. */
  dispose(reason: string, killGraceMs: number): Promise<void>;
}

export type TerminalFactory =
  (cwd: string, env: Readonly<Record<string, string>>) => TerminalRuntime;

/** The default session environment: an allowlist, never the parent's `process.env`. */
export const DEFAULT_TERMINAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TERM: 'dumb',
});

const POLL_MS = 25;
/** No stdin probe is consulted before this much time has passed since the write. */
const STDIN_GRACE_MS = 150;
/** Consecutive positive probes before a stdin_read settles. */
const STDIN_PROBES = 2;
/**
 * One probe is a full `/proc` walk (measured ~2 ms): probing on every 25 ms
 * tick would cost ~80 walks/second for the command's whole duration. 200 ms
 * keeps the proof cheap while `STDIN_PROBES` consecutive positives still
 * settle a stdin_read in well under a second.
 */
const STDIN_PROBE_INTERVAL_MS = 200;

/**
 * A reverse map built once from the platform's signal table: pty onExit reports
 * the signal as a number, and the renderer wants the name (`SIGSEGV`, not
 * `SIG11`). Unknown numbers still fall back to `SIG<n>`.
 */
const SIGNAL_NAMES: Readonly<Record<number, string>> =
  Object.fromEntries(Object.entries(osConstants.signals).map(([name, number]) => [number, name]));

/**
 * DSH's exact quoting: the wrapped line stays one physical line, no PS2 ever
 * echoes. A raw control byte in `cmd` (a stray Ctrl-C/Ctrl-D) would reach the
 * tty line discipline verbatim (INTR/EOF) — inherited from DSH and accepted:
 * the failure mode is a wedged or reset session, never an escape.
 */
function quoteForBash(value: string): string {
  return `$'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}'`;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** The longest suffix of `text` that is a prefix of `wanted` (0 when none). */
function suffixOverlap(text: string, wanted: string): number {
  const max = Math.min(text.length, wanted.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (text.endsWith(wanted.slice(0, n))) return n;
  }
  return 0;
}

type Session = {
  readonly proc: pty.IPty;
  readonly pid: number;
  exited: { readonly code: number; readonly signal: string | null } | null;
};

type CommandState = {
  readonly startRe: RegExp;
  readonly endRe: RegExp;
  readonly endPartial: RegExp;
  carry: string;
  startSeen: boolean;
  readonly chunks: Buffer[];
  captured: number;
  truncated: boolean;
  exitCode: number | null;
};

export class PtyTerminalRuntime implements TerminalRuntime {
  private session: Session | null = null;
  /** A command left waiting on stdin; the next run resets before writing. */
  private wedged = false;
  /** Consumed by the run that respawns after a wedge. */
  private wedgedFresh: 'stdin-wedge' | null = null;
  private disposed = false;
  /** The FIFO that serializes writes on the one session. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cwd: string,
    private readonly env: Readonly<Record<string, string>>,
  ) {}

  run(cmd: string, limits: CommandLimits, signal: AbortSignal): Promise<CommandOutcome> {
    const task = this.queue.then(() => this.runExclusive(cmd, limits, signal));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * Kills the session and refuses later runs; safe to call twice. Disposal is
   * FIFO behind an in-flight command: it runs only after that command settles,
   * and the wait is bounded only by that command's own timeout. A caller
   * shutting down must abort in-flight work first (the driver does).
   */
  async dispose(_reason: string, killGraceMs: number): Promise<void> {
    const task = this.queue.then(async () => {
      this.disposed = true;
      await this.killSession(killGraceMs);
    });
    this.queue = task.then(() => undefined, () => undefined);
    await task;
  }

  private spawnFresh(): Session {
    // Pre-flight the cwd: node-pty never throws for a bad one (the child dies
    // in chdir with exit 1), which would masquerade as a session_exit.
    if (!statSync(this.cwd).isDirectory()) {
      throw new Error(`execute cwd is not a directory: ${this.cwd}`);
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) env[key] = value;
    const proc = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
      // node-pty forces the child's TERM to `name`, so the name IS the TERM;
      // it also injects PWD=cwd. Neither comes from the parent's environment.
      name: 'dumb', cols: 160, rows: 40, cwd: this.cwd, env,
    });
    const session: Session = { proc, pid: proc.pid, exited: null };
    proc.onExit(({ exitCode, signal }) => {
      // node-pty reports the signal as a NUMBER in practice (the d.ts types it
      // optional, so the check stays): 0 for a clean exit — only a nonzero
      // signal names a death.
      session.exited = {
        code: exitCode,
        signal: signal === undefined || signal === 0
          ? null : (SIGNAL_NAMES[signal] ?? `SIG${signal}`),
      };
    });
    // Echo suppression keeps the stream clean; correctness never depends on it
    // (the marker regexes cannot match the echoed wrapper line).
    proc.write('stty -echo\n');
    this.session = session;
    return session;
  }

  /**
   * SIGTERM, then SIGKILL after the grace; the pty teardown SIGHUPs the
   * foreground group. Interactive bash ignores SIGTERM (measured: still alive
   * 60 s later), so the escalation is load-bearing, not defensive — every
   * reset costs one grace period.
   */
  private async killSession(killGraceMs: number): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session === null || session.exited !== null) return;
    try { session.proc.kill('SIGTERM'); } catch { /* already gone */ }
    const deadline = Date.now() + killGraceMs;
    while (session.exited === null && Date.now() < deadline) await pause(POLL_MS);
    if (session.exited === null) {
      try { session.proc.kill('SIGKILL'); } catch { /* already gone */ }
      const hard = Date.now() + killGraceMs;
      while (session.exited === null && Date.now() < hard) await pause(POLL_MS);
    }
  }

  /** Kills the session so the next run respawns a fresh one. */
  private async reset(killGraceMs: number): Promise<void> {
    await this.killSession(killGraceMs);
    this.wedged = false;
  }

  private async runExclusive(
    cmd: string, limits: CommandLimits, signal: AbortSignal,
  ): Promise<CommandOutcome> {
    if (this.disposed) {
      return {
        status: 'spawn-failed', exitCode: null, signal: null,
        output: new Uint8Array(), truncated: false, reset: false, fresh: null,
      };
    }
    if (this.wedged) {
      // A session waiting on stdin cannot accept a new command line: reset it
      // first, and let the outcome say so. (The interactive `write` verb is
      // deliberately not built yet.)
      await this.reset(limits.killGraceMs);
      this.wedgedFresh = 'stdin-wedge';
    }
    // Consumed by this call, whatever path it takes — never leaked to a later one.
    const fresh = this.wedgedFresh;
    this.wedgedFresh = null;
    if (signal.aborted) {
      return {
        status: 'cancelled', exitCode: null, signal: null,
        output: new Uint8Array(), truncated: false, reset: false, fresh,
      };
    }
    let session = this.session;
    if (session !== null && session.exited !== null) {
      // The shell died while IDLE (a stray SIGHUP, a background job's signal):
      // an idle spawn has no state to lose, so respawn silently rather than
      // write into a dead pty and settle a stale session_exit.
      this.session = null;
      session = null;
    }
    if (session === null) {
      try {
        session = this.spawnFresh();
      } catch {
        return {
          status: 'spawn-failed', exitCode: null, signal: null,
          output: new Uint8Array(), truncated: false, reset: false, fresh,
        };
      }
    }

    const nonce = randomUUID();
    const start = `__ES_EXECUTE_START_${nonce}__`;
    const end = `__ES_EXECUTE_END_${nonce}:`;
    const state: CommandState = {
      startRe: new RegExp(`${start}\r?\n`),
      endRe: new RegExp(`${end}(\\d{1,3})\r?\n`),
      // A chunk may end inside the end marker: within the fixed part (covered
      // by suffixOverlap) or within the digits/CR that follow it (covered by
      // this partial). (Marker characters are [A-Za-z0-9_:.-], regex-safe.)
      endPartial: new RegExp(`${end}[0-9]{0,3}\r?$`),
      carry: '',
      startSeen: false,
      chunks: [],
      captured: 0,
      truncated: false,
      exitCode: null,
    };
    const capture = (text: string): void => {
      if (text.length === 0 || state.truncated) return;
      const bytes = Buffer.from(text, 'utf8');
      const remaining = limits.maxCaptureBytes - state.captured;
      if (bytes.length <= remaining) {
        state.chunks.push(bytes);
        state.captured += bytes.length;
        return;
      }
      if (remaining > 0) {
        state.chunks.push(bytes.subarray(0, remaining));
        state.captured += remaining;
      }
      // The command still runs to its own end; only the capture stops.
      state.truncated = true;
    };
    const onData = (raw: string): void => {
      if (state.exitCode !== null) return;
      let text = state.carry + raw;
      state.carry = '';
      if (!state.startSeen) {
        const m = state.startRe.exec(text);
        if (m === null) {
          state.carry = text.slice(text.length - suffixOverlap(text, `${start}\r\n`));
          return;
        }
        state.startSeen = true;
        text = text.slice(m.index + m[0].length);
      }
      const endMatch = state.endRe.exec(text);
      if (endMatch !== null) {
        capture(text.slice(0, endMatch.index));
        state.exitCode = Number(endMatch[1]);
        return;
      }
      // Hold back whatever could be the beginning of an end marker split
      // across chunks: a suffix that prefixes the fixed marker, or the marker
      // plus a not-yet-complete `\d{1,3}\r?\n` tail at the string end.
      const partial = state.endPartial.exec(text);
      const hold = Math.max(
        partial === null ? 0 : text.length - partial.index,
        suffixOverlap(text, end),
      );
      capture(text.slice(0, text.length - hold));
      state.carry = text.slice(text.length - hold);
    };
    const subscription = session.proc.onData(onData);

    const output = (): Uint8Array => Buffer.concat(state.chunks);
    const settle = async (
      status: CommandStatus, exitCode: number | null, signalName: string | null,
      reset: boolean,
    ): Promise<CommandOutcome> => {
      subscription.dispose();
      // The held-back carry is never captured on a non-completed path: it was
      // held back BECAUSE it is a prefix of the end marker (or the marker plus
      // partial digits) — protocol bytes, or output indistinguishable from
      // them. On the completed path the same bytes DO join the capture: the
      // end match slices the stream before itself.
      state.carry = '';
      const outcome: CommandOutcome = {
        status, exitCode, signal: signalName,
        output: output(), truncated: state.truncated, reset, fresh,
      };
      // A timeout, a cancellation and a session death all reset the session;
      // stdin_read deliberately leaves it wedged.
      if (reset) await this.reset(limits.killGraceMs);
      return outcome;
    };

    try {
      session.proc.write(
        `printf '%s\\n' ${quoteForBash(start)}; eval -- ${quoteForBash(cmd)}; `
        + `__es_status=$?; printf '%s%s\\n' ${quoteForBash(end)} "$__es_status"\n`,
      );
      const writeAt = Date.now();
      const deadline = writeAt + limits.timeoutMs;
      let probes = 0;
      let lastProbeAt = 0;
      for (;;) {
        await pause(POLL_MS);
        if (state.exitCode !== null) {
          return settle('completed', state.exitCode, null, false);
        }
        if (session.exited !== null) {
          return settle('session_exit', session.exited.code, session.exited.signal, true);
        }
        if (signal.aborted) {
          return settle('cancelled', null, null, true);
        }
        if (Date.now() >= deadline) {
          return settle('timeout', null, null, true);
        }
        if (state.startSeen
          && Date.now() >= writeAt + STDIN_GRACE_MS
          && Date.now() >= lastProbeAt + STDIN_PROBE_INTERVAL_MS) {
          lastProbeAt = Date.now();
          probes = stdinWaitPids(session.pid).length > 0 ? probes + 1 : 0;
          if (probes >= STDIN_PROBES) {
            // The session stays wedged: the command still waits on stdin, and
            // the next run resets before writing (the `fresh` trailer).
            this.wedged = true;
            return settle('stdin_read', null, null, false);
          }
        }
      }
    } finally {
      subscription.dispose();
    }
  }
}
