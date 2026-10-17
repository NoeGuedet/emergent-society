import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import * as pty from '@lydell/node-pty';
import { stdinWaitPids, sessionTtyTarget } from './proc.js';

/**
 * The persistent PTY shell (C1.4b, kernel.md §7): one bash session per
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

/**
 * The empty outcome of a run that never touches the session: a disposed or
 * spawn-failed runtime, or a pre-write cancellation. `reset` is true only when
 * the wedge reset already ran before the abort, and `fresh` still carries it.
 */
export function failedOutcome(
  status: CommandStatus, fresh: 'stdin-wedge' | null, reset = false,
): CommandOutcome {
  return {
    status, exitCode: null, signal: null,
    output: new Uint8Array(), truncated: false, reset, fresh,
  };
}

/** The narrow port dispatch depends on; the runtime binds its session to it. */
export type TerminalPort = {
  run(cmd: string, limits: CommandLimits, signal: AbortSignal): Promise<CommandOutcome>;
};

export interface TerminalRuntime extends TerminalPort {
  /** Kills the session and refuses later runs; safe to call twice. */
  dispose(killGraceMs: number): Promise<void>;
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
/**
 * How long the death path waits for node-pty's exit event before reporting an
 * unknown exit code: the event usually lands within a tick, and keeping the
 * shell's real code is worth a few polls — never the command timeout.
 */
const EXIT_REPORT_GRACE_MS = 250;
/**
 * How long the first pre-write freeze polls for the shell's pts fd 0. The
 * child's login_tty normally completes in a few milliseconds; this bound only
 * decides when the stdin proof is abandoned for the session (a missed proof
 * costs a timeout), never when the command is allowed to start.
 */
const TTY_FREEZE_DEADLINE_MS = 1000;
/**
 * No stdin probe is consulted before this much time has passed since the
 * command's start marker was SEEN, not since the write: a slow shell startup
 * must not eat the probe's grace window.
 */
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
 * `SIG11`). Aliases share a number (SIGABRT/SIGIOT): the first entry wins, so
 * the canonical name renders. Unknown numbers still fall back to `SIG<n>`.
 */
const SIGNAL_NAMES: Readonly<Record<number, string>> = (() => {
  const names: Record<number, string> = {};
  for (const [name, number] of Object.entries(osConstants.signals)) {
    names[number] ??= name;
  }
  return names;
})();

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

/**
 * A pid-level liveness check: node-pty's write never throws on a dead pty (it
 * console.errors and clears its queue), so the runtime must ask the kernel
 * itself. `kill(pid, 0)` only tests existence — it sends nothing.
 */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  exited: { readonly code: number | null; readonly signal: string | null } | null;
  /**
   * The pts path the shell's fd 0 resolved to at spawn (or the first pre-write
   * retry): the stdin proof is bound to this frozen target, so a later
   * redirection of fd 0 can never make the shell look stdin-blocked.
   */
  ttyTarget: string | null;
};

/**
 * One command's stream-level capture: start/end marker framing, the held-back
 * suffix that may be the beginning of a marker split across chunks, and the
 * bounded payload. Timeout/abort/reset policy stays in `runExclusive`.
 */
class CommandCapture {
  private readonly startRe: RegExp;
  private readonly endRe: RegExp;
  private readonly endPartial: RegExp;
  private carry = '';
  private startSeen = false;
  private startedAtMs: number | null = null;
  private readonly chunks: Buffer[] = [];
  private captured = 0;
  private truncatedFlag = false;
  /** Set when the end marker names the command's exit status. */
  exitCode: number | null = null;

  constructor(
    private readonly start: string,
    private readonly end: string,
    private readonly maxBytes: number,
  ) {
    this.startRe = new RegExp(`${start}\r?\n`);
    this.endRe = new RegExp(`${end}(\\d{1,3})\r?\n`);
    // A chunk may end inside the end marker: within the fixed part (covered by
    // suffixOverlap) or within the digits/CR that follow it (covered by this
    // partial). (Marker characters are [A-Za-z0-9_:.-], regex-safe.)
    this.endPartial = new RegExp(`${end}[0-9]{0,3}\r?$`);
  }

  /** When the start marker was seen; the stdin grace is anchored here, not at the write. */
  get startedAt(): number | null { return this.startedAtMs; }

  get truncated(): boolean { return this.truncatedFlag; }

  /** The captured payload; a held-back marker prefix is never included. */
  output(): Uint8Array { return Buffer.concat(this.chunks); }

  private capture(text: string): void {
    if (text.length === 0 || this.truncatedFlag) return;
    const bytes = Buffer.from(text, 'utf8');
    const remaining = this.maxBytes - this.captured;
    if (bytes.length <= remaining) {
      this.chunks.push(bytes);
      this.captured += bytes.length;
      return;
    }
    if (remaining > 0) {
      this.chunks.push(bytes.subarray(0, remaining));
      this.captured += remaining;
    }
    // The command still runs to its own end; only the capture stops.
    this.truncatedFlag = true;
  }

  feed(raw: string): void {
    if (this.exitCode !== null) return;
    let text = this.carry + raw;
    this.carry = '';
    if (!this.startSeen) {
      const m = this.startRe.exec(text);
      if (m === null) {
        this.carry = text.slice(text.length - suffixOverlap(text, `${this.start}\r\n`));
        return;
      }
      this.startSeen = true;
      this.startedAtMs = Date.now();
      text = text.slice(m.index + m[0].length);
    }
    const endMatch = this.endRe.exec(text);
    if (endMatch !== null) {
      this.capture(text.slice(0, endMatch.index));
      this.exitCode = Number(endMatch[1]);
      return;
    }
    // Hold back whatever could be the beginning of an end marker split
    // across chunks: a suffix that prefixes the fixed marker, or the marker
    // plus a not-yet-complete `\d{1,3}\r?\n` tail at the string end.
    const partial = this.endPartial.exec(text);
    const hold = Math.max(
      partial === null ? 0 : text.length - partial.index,
      suffixOverlap(text, this.end),
    );
    this.capture(text.slice(0, text.length - hold));
    this.carry = text.slice(text.length - hold);
  }
}

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
  async dispose(killGraceMs: number): Promise<void> {
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
    const session: Session = {
      proc, pid: proc.pid, exited: null, ttyTarget: sessionTtyTarget(proc.pid),
    };
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

  /**
   * The pty's own exit record, or an unknown one when the event has not landed
   * yet. A pid probe can notice a death before SIGCHLD reaches node-pty; the
   * short grace keeps the real exit code (an `exit 3` must not render as an
   * unknown code) without ever approaching the command timeout. The synthetic
   * state is stored so a later kill does not wait a second grace for an event
   * that already happened.
   */
  private async exitedOrUnknown(
    session: Session,
  ): Promise<{ readonly code: number | null; readonly signal: string | null }> {
    const deadline = Date.now() + EXIT_REPORT_GRACE_MS;
    while (session.exited === null && Date.now() < deadline) await pause(POLL_MS);
    session.exited ??= { code: null, signal: null };
    return session.exited;
  }

  /**
   * Freezes the session's pts target before its first write. `pty.spawn`
   * returns before the child's login_tty, so an immediate read can still see
   * the inherited socket fd 0: poll until the slave pts appears. The value is
   * kept for the session once frozen. On deadline expiry the target stays null
   * and the stdin proof is disabled for that session — a missed proof costs a
   * timeout, never a false positive. Off Linux, after an abort, or once the pid
   * is no longer alive, return without burning the deadline; an unreaped zombie
   * still satisfies `kill(pid, 0)`, so that window is not detected here and can
   * poll to the deadline — bounded to one 1 s window, with the same conservative
   * outcome.
   */
  private async freezeTtyTarget(session: Session, signal: AbortSignal): Promise<void> {
    if (session.ttyTarget !== null || process.platform !== 'linux') return;
    const deadline = Date.now() + TTY_FREEZE_DEADLINE_MS;
    for (;;) {
      session.ttyTarget = sessionTtyTarget(session.pid);
      if (session.ttyTarget !== null || signal.aborted || !alive(session.pid)
        || Date.now() >= deadline) {
        return;
      }
      await pause(POLL_MS);
    }
  }

  private async runExclusive(
    cmd: string, limits: CommandLimits, signal: AbortSignal,
  ): Promise<CommandOutcome> {
    if (this.disposed) return failedOutcome('spawn-failed', null);
    let wedgeReset = false;
    if (this.wedged) {
      // A session waiting on stdin cannot accept a new command line: reset it
      // first, and let the outcome say so. (The interactive `write` verb is
      // deliberately not built yet.)
      await this.reset(limits.killGraceMs);
      this.wedgedFresh = 'stdin-wedge';
      wedgeReset = true;
    }
    // Consumed by this call, whatever path it takes — never leaked to a later one.
    const fresh = this.wedgedFresh;
    this.wedgedFresh = null;
    if (signal.aborted) {
      // The wedge reset above DID kill the session: report it truthfully even
      // though this call itself writes nothing.
      return failedOutcome('cancelled', fresh, wedgeReset);
    }
    let session = this.session;
    if (session !== null && (session.exited !== null || !alive(session.pid))) {
      // The shell died while IDLE (a stray SIGHUP, a background job's signal),
      // including a death whose exit event has not landed yet: an idle spawn
      // has no state to lose, so respawn silently rather than write into a
      // dead pty and settle a stale session_exit.
      this.session = null;
      session = null;
    }
    if (session === null) {
      try {
        session = this.spawnFresh();
      } catch {
        return failedOutcome('spawn-failed', fresh, wedgeReset);
      }
    }
    await this.freezeTtyTarget(session, signal);
    // A freshly forked shell can still die before this command is written;
    // that is still an idle death (nothing was written), so respawn once and
    // proceed silently.
    if (!alive(session.pid)) {
      this.session = null;
      try {
        session = this.spawnFresh();
      } catch {
        return failedOutcome('spawn-failed', fresh, wedgeReset);
      }
      await this.freezeTtyTarget(session, signal);
    }
    if (signal.aborted) return failedOutcome('cancelled', fresh, wedgeReset);

    const nonce = randomUUID();
    const start = `__ES_EXECUTE_START_${nonce}__`;
    const end = `__ES_EXECUTE_END_${nonce}:`;
    const capture = new CommandCapture(start, end, limits.maxCaptureBytes);
    const subscription = session.proc.onData((raw) => { capture.feed(raw); });

    const settle = async (
      status: CommandStatus, exitCode: number | null, signalName: string | null,
      reset: boolean,
    ): Promise<CommandOutcome> => {
      subscription.dispose();
      // The held-back carry is never captured on a non-completed path: it was
      // held back BECAUSE it is a prefix of the end marker (or the marker plus
      // partial digits) — protocol bytes, or output indistinguishable from
      // them. On the completed path the same bytes DO join the capture: the
      // end match slices the stream before itself, so CommandCapture.output()
      // is exactly the payload either way.
      const outcome: CommandOutcome = {
        status, exitCode, signal: signalName,
        output: capture.output(), truncated: capture.truncated, reset, fresh,
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
        if (capture.exitCode !== null) {
          return settle('completed', capture.exitCode, null, false);
        }
        if (session.exited !== null) {
          return settle('session_exit', session.exited.code, session.exited.signal, true);
        }
        // The exit event can lag a killed pid (or the pty can swallow the
        // write): fail fast with the bytes captured so far instead of
        // stalling to the timeout. The completed check above is first, so a
        // command whose end marker already landed still wins.
        if (!alive(session.pid)) {
          const exit = await this.exitedOrUnknown(session);
          return settle('session_exit', exit.code, exit.signal, true);
        }
        if (signal.aborted) {
          return settle('cancelled', null, null, true);
        }
        if (Date.now() >= deadline) {
          return settle('timeout', null, null, true);
        }
        if (capture.startedAt !== null
          && Date.now() >= capture.startedAt + STDIN_GRACE_MS
          && Date.now() >= lastProbeAt + STDIN_PROBE_INTERVAL_MS) {
          lastProbeAt = Date.now();
          probes = stdinWaitPids(session.pid, session.ttyTarget).length > 0 ? probes + 1 : 0;
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
