import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import * as pty from '@lydell/node-pty';
import { stdinWaitPids, sessionTtyTarget } from './proc.js';
import { probeSandbox } from './sandbox.js';
import type { SandboxSpec, SandboxStatus } from './sandbox.js';

/**
 * The persistent PTY shell (C1.4b, kernel.md §7): one bash session per
 * node, marker-encapsulated commands, typed statuses, reset-on-timeout.
 * The mechanics follow DeepSeek Harness's tool-bash-persistent; the divergences
 * are deliberate and documented in docs/plans/2026-10-15-c1-4b (arbitrations):
 * a stdin-wedged session is reset before the next command rather than fed,
 * completion wins over a same-tick abort, and a capture overflow never kills
 * the command.
 *
 * Confinement (C1.4c): constructed with a `SandboxSpec`, the session is the
 * vendored Landlock launcher's, not bash's — the launcher restricts itself and
 * `execve`s bash in place, so the pid, session and controlling tty the `/proc`
 * stdin proof keys off are preserved. A failed probe or a pre-start launcher
 * death (exit 125 carrying its `es-landlock:` stderr line) settles
 * `spawn-failed` with that diagnostic as the output — never a silent
 * unconfined shell; `sandboxStatus()` reports the probed ABI. `'off'` is the
 * explicit unconfined choice. This module still owns processes, not the whole
 * containment story: a reset kills the shell and lets the pty teardown SIGHUP
 * the foreground group — a backgrounded or SIGHUP-ignoring process can
 * survive, and the journal never claims otherwise. The session does not
 * survive a kernel restart (kernel.md §7).
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
 * `output` carries a diagnostic (the bounded launcher stderr); it never
 * reaches this shape on a normal path.
 */
export function failedOutcome(
  status: CommandStatus, fresh: 'stdin-wedge' | null, reset = false,
  output: Uint8Array = new Uint8Array(),
): CommandOutcome {
  return {
    status, exitCode: null, signal: null,
    output, truncated: false, reset, fresh,
  };
}

/** The narrow port dispatch depends on; the runtime binds its session to it. */
export type TerminalPort = {
  run(cmd: string, limits: CommandLimits, signal: AbortSignal): Promise<CommandOutcome>;
};

export interface TerminalRuntime extends TerminalPort {
  /** Kills the session and refuses later runs; safe to call twice. */
  dispose(killGraceMs: number): Promise<void>;
  /** Optional so factory-supplied runtimes (test seams) stay two-method. */
  sandboxStatus?(): SandboxStatus | null;
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
 * The bounded diagnostic retained from before the start marker: the launcher's
 * failure line lands there (it never runs the command), and a pre-start death
 * is classified from it. A fixed 4096 bytes is the plan's bound.
 */
const PRE_START_DIAGNOSTIC_BYTES = 4096;

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
 * One run's live stream capture: the nonce markers this command was written
 * with, the capture that frames it, and the subscription that feeds it. The
 * slot is replaced on a silent respawn; a settle and the run's `finally` read
 * the current slot, never a stale copy.
 */
type CaptureSlot = {
  readonly start: string;
  readonly end: string;
  readonly capture: CommandCapture;
  readonly subscription: { dispose(): void };
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
  /** The last `PRE_START_DIAGNOSTIC_BYTES` of pre-start-marker output, never in `output()`. */
  private preStartText = '';
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

  /** The retained pre-start bytes: a launcher's failure diagnostic, never a payload. */
  get preStart(): string { return this.preStartText; }

  get truncated(): boolean { return this.truncatedFlag; }

  /** The captured payload; a held-back marker prefix is never included. */
  output(): Uint8Array { return Buffer.concat(this.chunks); }

  /**
   * Retains pre-start bytes for the diagnostic, capped on bytes so a chatty
   * child cannot grow the string without bound. Only bytes the caller has
   * already ruled out as a marker prefix arrive here, so each byte is appended
   * exactly once.
   */
  private retainPreStart(text: string): void {
    if (text.length === 0) return;
    this.preStartText += text;
    if (Buffer.byteLength(this.preStartText) <= PRE_START_DIAGNOSTIC_BYTES) return;
    const bytes = Buffer.from(this.preStartText, 'utf8');
    this.preStartText = bytes.subarray(bytes.length - PRE_START_DIAGNOSTIC_BYTES).toString('utf8');
  }

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
        const hold = suffixOverlap(text, `${this.start}\r\n`);
        this.retainPreStart(text.slice(0, text.length - hold));
        this.carry = text.slice(text.length - hold);
        return;
      }
      this.retainPreStart(text.slice(0, m.index));
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

/**
 * The probe, memoized as a settled union: a failure is data, never a rejection.
 */
type ProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostic: Uint8Array };

export class PtyTerminalRuntime implements TerminalRuntime {
  private session: Session | null = null;
  /** A command left waiting on stdin; the next run resets before writing. */
  private wedged = false;
  /** Consumed by the run that respawns after a wedge. */
  private wedgedFresh: 'stdin-wedge' | null = null;
  private disposed = false;
  /** The FIFO that serializes writes on the one session. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The built policy, or null for the explicit unconfined choice. */
  private readonly spec: SandboxSpec | null;
  /**
   * The probe, assigned synchronously on first use: a failure never re-probes
   * within this runtime and never rejects an await. A stop discards the whole
   * runtime (the loop builds a fresh session per driver), so the next driver's
   * fresh runtime probes again — the deliberate asymmetry with the loop's
   * persistent build-failure memo.
   */
  private probeMemo: Promise<ProbeResult> | null = null;
  /** `{mode:'off'}` from construction, null until a probe succeeds, then the probed status. */
  private status: SandboxStatus | null;

  constructor(
    private readonly cwd: string,
    private readonly env: Readonly<Record<string, string>>,
    sandbox: SandboxSpec | 'off',
  ) {
    this.spec = sandbox === 'off' ? null : sandbox;
    this.status = this.spec === null ? { mode: 'off' } : null;
  }

  /** The shell sandbox status: 'off' when unconfined, the probed ABI after a success, else null. */
  sandboxStatus(): SandboxStatus | null { return this.status; }

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

  /**
   * Runs the memoized functional probe. The union is assigned synchronously
   * before the first await, so two runs never probe twice, and a rejection
   * never escapes: a probe failure is data.
   */
  private probeOnce(spec: SandboxSpec): Promise<ProbeResult> {
    this.probeMemo ??= (async () => {
      try {
        const probed = await probeSandbox(spec);
        this.status = { mode: 'landlock', abi: probed.abi, enforcement: probed.enforcement };
        return { ok: true } as const;
      } catch (err) {
        // T3 attaches the launcher's bounded stderr to the message: it becomes
        // the run's output, which `renderExecuteText` renders on any status.
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, diagnostic: Buffer.from(message) } as const;
      }
    })();
    return this.probeMemo;
  }

  private spawnFresh(): Session {
    // Pre-flight the cwd: node-pty never throws for a bad one (the child dies
    // in chdir with exit 1), which would masquerade as a session_exit.
    if (!statSync(this.cwd).isDirectory()) {
      throw new Error(`execute cwd is not a directory: ${this.cwd}`);
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) env[key] = value;
    const spec = this.spec;
    const proc = spec === null
      ? pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
          // node-pty forces the child's TERM to `name`, so the name IS the TERM;
          // it also injects PWD=cwd. Neither comes from the parent's environment.
          name: 'dumb', cols: 160, rows: 40, cwd: this.cwd, env,
        })
      : pty.spawn(spec.launcherPath, [...spec.spawnArgv], {
          // The sandbox's own env (HOME/TMPDIR/HISTFILE) is applied last and
          // wins over the allowlist; node-pty's forced PWD/TERM run after the
          // merge and cannot clash with those keys.
          name: 'dumb', cols: 160, rows: 40, cwd: this.cwd, env: { ...env, ...spec.env },
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
    if (this.spec !== null) {
      // The functional probe gates the first run (and is reused afterwards).
      // Re-checking the abort after it settles — success or failure — keeps a
      // clean stop during the probe from journaling a spurious spawn failure.
      const probed = await this.probeOnce(this.spec);
      if (signal.aborted) return failedOutcome('cancelled', fresh, wedgeReset);
      if (!probed.ok) {
        return failedOutcome('spawn-failed', fresh, wedgeReset, probed.diagnostic);
      }
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

    /**
     * A command's capture and its data subscription. `attach` disposes the
     * previous slot and subscribes to the new session in the spawn's own
     * synchronous stack: node-pty's `spawn` returns before the child's
     * `login_tty`, and a launcher's pre-start stderr lands in that window — a
     * subscription created one timer tick later already loses it.
     */
    const attach = (target: Session, previous: CaptureSlot | null): CaptureSlot => {
      previous?.subscription.dispose();
      const nonce = randomUUID();
      const start = `__ES_EXECUTE_START_${nonce}__`;
      const end = `__ES_EXECUTE_END_${nonce}:`;
      const capture = new CommandCapture(start, end, limits.maxCaptureBytes);
      return {
        start, end, capture,
        subscription: target.proc.onData((raw) => { capture.feed(raw); }),
      };
    };
    // The slot is mutable and every closure reads it: after a respawn a settle
    // must dispose the live subscription, never the retired one.
    let slot = attach(session, null);

    try {
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
        slot = attach(session, slot);
        await this.freezeTtyTarget(session, signal);
      }
      if (signal.aborted) return failedOutcome('cancelled', fresh, wedgeReset);

      const settle = async (
        status: CommandStatus, exitCode: number | null, signalName: string | null,
        reset: boolean, diagnostic?: Uint8Array,
      ): Promise<CommandOutcome> => {
        slot.subscription.dispose();
        // The held-back carry is never captured on a non-completed path: it was
        // held back BECAUSE it is a prefix of the end marker (or the marker plus
        // partial digits) — protocol bytes, or output indistinguishable from
        // them. On the completed path the same bytes DO join the capture: the
        // end match slices the stream before itself, so CommandCapture.output()
        // is exactly the payload either way.
        const outcome: CommandOutcome = {
          status, exitCode, signal: signalName,
          output: diagnostic ?? slot.capture.output(),
          truncated: slot.capture.truncated, reset, fresh,
        };
        // A timeout, a cancellation and a session death all reset the session;
        // stdin_read deliberately leaves it wedged.
        if (reset) await this.reset(limits.killGraceMs);
        return outcome;
      };

      /**
       * The documented 125 conjunction (arbitration 8): a confined session
       * that died before the start marker, with exit code exactly 125 and the
       * launcher's `es-landlock:` line retained. An unknown (null) code fails
       * deliberately — the diagnostic is what makes the classification, and a
       * shell that never ran is a spawn failure either way.
       */
      const launcherDiagnostic = (exit: { readonly code: number | null }): Uint8Array | null => {
        if (this.spec === null) return null;
        if (slot.capture.startedAt !== null) return null;
        if (exit.code !== 125) return null;
        if (!slot.capture.preStart.includes('es-landlock:')) return null;
        return Buffer.from(slot.capture.preStart, 'utf8');
      };

      session.proc.write(
        `printf '%s\\n' ${quoteForBash(slot.start)}; eval -- ${quoteForBash(cmd)}; `
        + `__es_status=$?; printf '%s%s\\n' ${quoteForBash(slot.end)} "$__es_status"\n`,
      );
      const writeAt = Date.now();
      const deadline = writeAt + limits.timeoutMs;
      let probes = 0;
      let lastProbeAt = 0;
      for (;;) {
        await pause(POLL_MS);
        if (slot.capture.exitCode !== null) {
          return settle('completed', slot.capture.exitCode, null, false);
        }
        if (session.exited !== null) {
          const diagnostic = launcherDiagnostic(session.exited);
          if (diagnostic !== null) return settle('spawn-failed', null, null, true, diagnostic);
          return settle('session_exit', session.exited.code, session.exited.signal, true);
        }
        // The exit event can lag a killed pid (or the pty can swallow the
        // write): fail fast with the bytes captured so far instead of
        // stalling to the timeout. The completed check above is first, so a
        // command whose end marker already landed still wins.
        if (!alive(session.pid)) {
          const exit = await this.exitedOrUnknown(session);
          const diagnostic = launcherDiagnostic(exit);
          if (diagnostic !== null) return settle('spawn-failed', null, null, true, diagnostic);
          return settle('session_exit', exit.code, exit.signal, true);
        }
        if (signal.aborted) {
          return settle('cancelled', null, null, true);
        }
        if (Date.now() >= deadline) {
          return settle('timeout', null, null, true);
        }
        if (slot.capture.startedAt !== null
          && Date.now() >= slot.capture.startedAt + STDIN_GRACE_MS
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
      slot.subscription.dispose();
    }
  }
}
