import { isAbsolute } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { assertNodeUid } from '../journal/index.js';
import { UsageError } from './errors.js';

/**
 * The first-light command line: argv in, one validated command out.
 *
 * Parsing is split from dispatch so every refusal has a single shape. The
 * subcommand token is sliced off first and each command gets its own
 * `parseArgs` table with `strict: true` and `allowPositionals: false`, which
 * makes an unknown flag, a stray value or a flag the command does not own
 * (`--uid` on `pause`, `--model` on `resume`) a refusal rather than something
 * silently ignored. `parseArgs` reports all of those as a `TypeError`; here
 * they become `UsageError`, the one error `runCli` maps to exit `2`, so no
 * `node:util` type ever escapes to the operator as a stack trace.
 *
 * Everything a purely syntactic check can catch lives here: an absolute home,
 * a uid that is one safe path segment, a non-empty `--model`/`--heading`, and
 * an absolute non-empty `--charter-file` on `start`. Whether a home exists,
 * whether `mock-model` is acceptable, or whether a journaled config exists is
 * the host gate's decision (also exit `2`, but after a real fold), not argv
 * parsing's.
 *
 * `USAGE` names the five commands, the exit codes, and the eight §3.9
 * disclosures, so `--help` is honest about what a stop, a resume, a pause and
 * a status actually guarantee.
 */

/** The uid a host uses when the operator does not pass `--uid`. */
const DEFAULT_UID = 'node-0';

/**
 * One command's parsed option table, read by flag name. `parseArgs` may yield a
 * string, a boolean or an array (for a `multiple` flag); every accessor below
 * narrows with `typeof`, so a value no flag in these tables can produce is
 * still refused rather than trusted.
 */
type OptionValues = Readonly<Record<string, unknown>>;

/** The command line the first-light host accepts. */
export type HostCliCommand =
  | { readonly command: 'help' }
  | { readonly command: 'init'; readonly home: string }
  | {
      readonly command: 'start'; readonly home: string; readonly uid: string;
      readonly model: string; readonly heading: string; readonly noSandbox: boolean;
      readonly charterFile?: string;
    }
  | {
      readonly command: 'resume'; readonly home: string; readonly uid: string;
      readonly noSandbox: boolean;
    }
  | { readonly command: 'pause'; readonly home: string }
  | { readonly command: 'status'; readonly home: string; readonly json: boolean };

/** The five-command help text, its exit codes and the eight disclosures. */
export const USAGE = `Usage:
  node dist/host/main.js init   --home <abs-dir>
  node dist/host/main.js start  --home <abs-dir> --model <id> --heading <text> [--charter-file <abs-path>] [--uid node-0] [--no-sandbox]
  node dist/host/main.js resume --home <abs-dir> [--uid node-0] [--no-sandbox]
  node dist/host/main.js pause  --home <abs-dir>
  node dist/host/main.js status --home <abs-dir> [--json]

Exit codes: 0 ok, 1 runtime failure, 2 usage/config/no running host, 3 pause delivered, host still stopping.
The LLM key lives only in <home>/providers.json (mode 0600); it is never accepted on argv or in the environment.
Stop interrupts in-flight work; partial world writes may be committed; the shell does not survive and
resume starts a fresh PTY; resume is a full fold and unresolved effects are not re-executed; resume
spends one turn. pause returns 0 once the host has released its cell, not necessarily after process reaping.
A live or unverified host.json blocks a new host; delete it only if you are certain no host runs.
--charter-file replaces the default charter on a start into a cell with no journaled
configuration (including the boot-recovery start); resume refuses it — the journaled
config wins. The file's content is journaled as configuration; never point it at a
secret-bearing file.
`;

/**
 * `parseArgs` for one command's table, with its `TypeError` surfaced as a
 * `UsageError`. The args are copied because `parseArgs` takes a mutable array
 * and the caller's argv must not be.
 */
function parseStrict(
  args: readonly string[],
  options: ParseArgsOptionsConfig,
): OptionValues {
  try {
    const { values } = parseArgs({
      args: [...args], options, strict: true, allowPositionals: false,
    });
    return values;
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
}

/** `--home`, required and absolute on every command. */
function homeOf(values: OptionValues, command: string): string {
  const home = values['home'];
  if (typeof home !== 'string' || home === '') {
    throw new UsageError(`${command} requires --home <abs-dir>`);
  }
  if (!isAbsolute(home)) {
    throw new UsageError(`--home must be an absolute path: ${home}`);
  }
  return home;
}

/** `--uid`, defaulted and validated as one safe path segment. */
function uidOf(values: OptionValues): string {
  const uid = values['uid'];
  if (uid === undefined) return DEFAULT_UID;
  if (typeof uid !== 'string') throw new UsageError('--uid takes a value');
  try {
    return assertNodeUid(uid);
  } catch {
    throw new UsageError(`--uid is not a safe node uid: ${uid}`);
  }
}

/** A required non-empty string flag. */
function textOf(values: OptionValues, flag: string, command: string): string {
  const value = values[flag];
  if (typeof value !== 'string' || value === '') {
    throw new UsageError(`${command} requires --${flag} <value>`);
  }
  return value;
}

function parseInit(args: readonly string[]): HostCliCommand {
  const values = parseStrict(args, { home: { type: 'string' } });
  return { command: 'init', home: homeOf(values, 'init') };
}

function parseStart(args: readonly string[]): HostCliCommand {
  const values = parseStrict(args, {
    home: { type: 'string' },
    model: { type: 'string' },
    heading: { type: 'string' },
    'charter-file': { type: 'string' },
    uid: { type: 'string' },
    'no-sandbox': { type: 'boolean' },
  });
  // `--charter-file` is optional and absolute like `--home`: the operator's
  // own path, read once at the start gate, never defaulted to `undefined`
  // under `exactOptionalPropertyTypes` (an absent flag stays an absent key).
  const charterFile = values['charter-file'];
  if (charterFile !== undefined) {
    if (typeof charterFile !== 'string' || charterFile === '') {
      throw new UsageError('--charter-file takes a value');
    }
    if (!isAbsolute(charterFile)) {
      throw new UsageError(`--charter-file must be an absolute path: ${charterFile}`);
    }
  }
  return {
    command: 'start',
    home: homeOf(values, 'start'),
    uid: uidOf(values),
    model: textOf(values, 'model', 'start'),
    heading: textOf(values, 'heading', 'start'),
    noSandbox: values['no-sandbox'] === true,
    ...(charterFile !== undefined ? { charterFile } : {}),
  };
}

/** `--model`/`--heading` are absent from this table on purpose: resume refuses them. */
function parseResume(args: readonly string[]): HostCliCommand {
  const values = parseStrict(args, {
    home: { type: 'string' },
    uid: { type: 'string' },
    'no-sandbox': { type: 'boolean' },
  });
  return {
    command: 'resume',
    home: homeOf(values, 'resume'),
    uid: uidOf(values),
    noSandbox: values['no-sandbox'] === true,
  };
}

/** No `--uid` here: one host owns a home, for any uid, so pause targets the record. */
function parsePause(args: readonly string[]): HostCliCommand {
  const values = parseStrict(args, { home: { type: 'string' } });
  return { command: 'pause', home: homeOf(values, 'pause') };
}

/**
 * No `--uid`/`--model` here: status reports on the whole home, not on one
 * node's configuration, so both are an unknown-flag refusal.
 */
function parseStatus(args: readonly string[]): HostCliCommand {
  const values = parseStrict(args, {
    home: { type: 'string' },
    json: { type: 'boolean' },
  });
  return { command: 'status', home: homeOf(values, 'status'), json: values['json'] === true };
}

/**
 * Parses the command line after `node dist/host/main.js`.
 *
 * Help is resolved before the subcommand is sliced: an empty argv, `--help` or
 * `-h` is the help command, because printing usage must not require a valid
 * command line. Any other leading token must be one of the five commands.
 *
 * @throws UsageError for an unknown command, an unknown or missing flag, a
 * relative home, a malformed uid, an empty `--model`/`--heading`, or a relative
 * or empty `--charter-file`.
 */
export function parseHostCommand(argv: readonly string[]): HostCliCommand {
  const name = argv[0];
  if (name === undefined || name === '--help' || name === '-h') return { command: 'help' };
  const rest = argv.slice(1);
  switch (name) {
    case 'init': return parseInit(rest);
    case 'start': return parseStart(rest);
    case 'resume': return parseResume(rest);
    case 'pause': return parsePause(rest);
    case 'status': return parseStatus(rest);
    default: throw new UsageError(`unknown command: ${name}`);
  }
}
