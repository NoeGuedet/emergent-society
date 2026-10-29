import { join } from 'node:path';
import { KernelError } from '../errors.js';
import { HostConfigError, UsageError } from './errors.js';
import { startHost, type HostHandle, type HostOptions } from './host.js';
import { initHome } from './layout.js';
import { createHostLog, type HostLog } from './observe.js';
import { parseHostCommand, USAGE, type HostCliCommand } from './options.js';
import { requestPause, type PauseOutcome } from './owner.js';
import { formatStatus, readStatus, type StatusReport } from './status.js';

/**
 * The dispatch between argv and the host: one exit code, two sinks, no policy.
 *
 * This module owns the command-line contract an operator and a shell script
 * see: `0` for success, `1` for a runtime failure (or a `status` report that
 * was produced but is degraded), `2` for a usage or configuration refusal
 * (and for "no running host"), `3` for a pause that was delivered while the
 * host was still stopping. Every refusal is printed once, on stderr, and a
 * usage error prints the whole `USAGE` text exactly once so the operator
 * never has to guess which flag was missing.
 *
 * The seams exist so the mapping is testable without a process, a signal or
 * a network: `startHost` returns a handle instead of owning the process, the
 * log takes the CLI's own stderr sink, and `requestPause`/`readStatus` are
 * substitutable. `runCli` resolves each default exactly once at entry, so a
 * `deps` object with no fields is the production behavior — including
 * `process.stdout`/`stderr`.
 *
 * A refused `start`/`resume` is not caught here: `startHost` never rejects
 * `done`, it resolves the code the host already journaled, so the lifetime's
 * own mapping (`HostConfigError` → 2, everything else → 1) is the one the
 * shell sees. `init`, `pause` and `status` are one-shot calls with no
 * lifetime, so their failures are mapped here.
 */

/** The two operator sinks; production defaults write to `process`. */
export type CliDeps = {
  readonly startHost?: (options: HostOptions) => HostHandle;
  readonly requestPause?: (home: string) => Promise<PauseOutcome>;
  readonly readStatus?: (home: string) => Promise<StatusReport>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly createLog?: (write: (line: string) => void) => HostLog;
};

type Sink = (text: string) => void;

/** The two commands that run a host lifetime. */
type HostRun = Extract<HostCliCommand, { readonly command: 'start' | 'resume' }>;

/** The one read-only command. */
type StatusRun = Extract<HostCliCommand, { readonly command: 'status' }>;

/** The bounded failure label: a kernel refusal's message, otherwise a name. */
function failureOf(error: unknown): string {
  if (error instanceof KernelError) return error.message;
  return error instanceof Error ? error.name : 'Error';
}

/**
 * `init`: creates the home and the world pair, then tells the operator where
 * the credential store goes.
 *
 * The providers path is printed rather than created — the key is written by the
 * operator, so no secret is ever generated onto a terminal or into a journal —
 * and the hint names the real path, not a `<home>` placeholder, so it can be
 * pasted as-is. A `HostConfigError` (a permissive home, a partial layout) is a
 * configuration refusal (`2`); anything else is a runtime failure (`1`).
 */
async function runInit(home: string, out: Sink, err: Sink): Promise<number> {
  try {
    const { created } = await initHome(home);
    out(`${created ? 'initialized' : 'already initialized'} ${home}\n`);
    out(
      `write ${join(home, 'providers.json')} (mode 0600) with `
      + '{ "llm": { "key": "…", "endpoint": "https://…/v1/chat/completions" } }\n',
    );
    return 0;
  } catch (error) {
    err(`error: ${failureOf(error)}\n`);
    return error instanceof HostConfigError ? 2 : 1;
  }
}

/**
 * `start`/`resume`: one host, whose exit code is the lifetime's.
 *
 * The sandbox defaults to Landlock (`{}`) and `--no-sandbox` is the only way to
 * say otherwise, so confinement is opt-out and loud. `model`/`--heading`/
 * `charterFile` are spread in only for `start`: under
 * `exactOptionalPropertyTypes` an explicit `undefined` would be a different
 * option object than an absent one, and a resume that carried the keys would be
 * lying about what it supplied.
 */
async function runHost(command: HostRun, deps: CliDeps, err: Sink): Promise<number> {
  const makeLog = deps.createLog ?? createHostLog;
  const log = makeLog((line) => { err(line); });
  const sandbox = command.noSandbox ? false : {};
  const handle = (deps.startHost ?? startHost)({
    home: command.home,
    uid: command.uid,
    command: command.command,
    sandbox,
    log,
    ...(command.command === 'start'
      ? {
          model: command.model,
          heading: command.heading,
          ...(command.charterFile !== undefined ? { charterFile: command.charterFile } : {}),
        }
      : {}),
  });
  return await handle.done;
}

/** The distinct explanation for each way a pause found no live host. */
function noHostMessage(home: string, state: 'absent' | 'stale' | 'unverified'): string {
  switch (state) {
    case 'absent':
      return `no host is running for ${home}\n`;
    case 'stale':
      return `no live host for ${home}; its stale host.json is reclaimed by the next start or resume\n`;
    case 'unverified':
      return `a host record exists for ${home}; cannot verify it, so no signal was sent\n`;
  }
}

/**
 * `pause`: one SIGTERM to the recorded host, then a poll of its owner record.
 *
 * `exited` is "the host released its cell", not "the process was reaped"; the
 * `USAGE` text carries that phrasing, so an operator never reads the `0` as a
 * claim about reaping. A missing, stale or unverifiable record is a `2` (no
 * running host to pause) and never a signal, and `still-stopping` is a `3`: the
 * shell has been told the pause was delivered and the decision is now the
 * operator's.
 */
async function runPause(home: string, deps: CliDeps, out: Sink, err: Sink): Promise<number> {
  let outcome: PauseOutcome;
  try {
    outcome = await (deps.requestPause ?? requestPause)(home);
  } catch (error) {
    err(`error: ${failureOf(error)}\n`);
    return 1;
  }
  switch (outcome.kind) {
    case 'exited':
      out(`paused ${home}\n`);
      return 0;
    case 'no-host':
      err(noHostMessage(home, outcome.state));
      return 2;
    case 'still-stopping':
      err(`host pid=${outcome.pid} was signalled but is still stopping ${home}\n`);
      return 3;
  }
}

/**
 * `status`: one read-only report, printed before the exit code it earns.
 *
 * The report is the authority and the exit code the coarse signal (the
 * systemctl precedent): a degraded report — a frontier or world failure
 * already folded into it — is still printed in full, then the command returns
 * `1`. `--json` is the machine mode, one `JSON.stringify(report)` line with
 * the error names included; the human lines never print one. A missing or
 * non-directory home is a `HostConfigError` (`2`); any other throw is a
 * runtime failure (`1`) with a bounded label.
 */
async function runStatus(
  command: StatusRun,
  deps: CliDeps,
  out: Sink,
  err: Sink,
): Promise<number> {
  try {
    const report = await (deps.readStatus ?? readStatus)(command.home);
    out(command.json ? `${JSON.stringify(report)}\n` : `${formatStatus(report)}\n`);
    return report.frontier.error !== null || report.world.error !== null ? 1 : 0;
  } catch (error) {
    err(`error: ${failureOf(error)}\n`);
    return error instanceof HostConfigError ? 2 : 1;
  }
}

/**
 * Runs one command line and resolves the process exit code.
 *
 * Usage is resolved first because a malformed command line still has to be able
 * to print it, and every parse refusal is one `error:` line plus the whole
 * `USAGE` — never a second copy, so a script that greps for `Usage:` sees one.
 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out: Sink = deps.stdout ?? ((text) => { process.stdout.write(text); });
  const err: Sink = deps.stderr ?? ((text) => { process.stderr.write(text); });
  let command: HostCliCommand;
  try {
    command = parseHostCommand(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`error: ${error.message}\n${USAGE}`);
    return 2;
  }
  switch (command.command) {
    case 'help':
      out(USAGE);
      return 0;
    case 'init':
      return await runInit(command.home, out, err);
    case 'start':
    case 'resume':
      return await runHost(command, deps, err);
    case 'pause':
      return await runPause(command.home, deps, out, err);
    case 'status':
      return await runStatus(command, deps, out, err);
  }
}
