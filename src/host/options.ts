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
 * `USAGE` names the six commands, the exit codes, and the eight §3.9
 * disclosures, so `--help` is honest about what a stop, a resume, a pause, a
 * status and the interactive chat session actually guarantee.
 */

/** The uid a host uses when the operator does not pass `--uid`. */
const DEFAULT_UID = 'node-0';

/** The chat session's default history bound (`--tail`). */
const CHAT_DEFAULT_TAIL = 20;

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
      readonly model?: string; readonly heading?: string; readonly noSandbox: boolean;
      readonly charterFile?: string; readonly nodesFile?: string;
      readonly gatewayCharter?: string; readonly gatewayModel?: string;
    }
  | {
      readonly command: 'resume'; readonly home: string; readonly uid: string;
      readonly noSandbox: boolean; readonly nodesFile?: string;
    }
  | { readonly command: 'pause'; readonly home: string }
  | { readonly command: 'status'; readonly home: string; readonly json: boolean }
  | {
      readonly command: 'chat'; readonly home: string; readonly tail: number;
      readonly conversation: boolean; readonly json: boolean;
    };

/**
 * The six-command help text, its exit codes and the disclosures: the charter
 * file's discipline, the nodes file's contract, the gateway overlay's config
 * home, the interactive chat session's prompt loop, and the eight §3.9
 * stop/resume/status facts.
 */
export const USAGE = `Usage:
  node dist/host/main.js init   --home <abs-dir>
  node dist/host/main.js start  --home <abs-dir> --model <id> --heading <text> [--charter-file <abs-path>] [--gateway-charter <abs-path> [--gateway-model <id>]] [--uid node-0] [--no-sandbox]
  node dist/host/main.js start  --home <abs-dir> --nodes-file <abs-path> [--gateway-charter <abs-path> [--gateway-model <id>]] [--no-sandbox]
  node dist/host/main.js resume --home <abs-dir> [--uid node-0] [--no-sandbox]
  node dist/host/main.js resume --home <abs-dir> --nodes-file <abs-path> [--no-sandbox]
  node dist/host/main.js pause  --home <abs-dir>
  node dist/host/main.js status --home <abs-dir> [--json]
  node dist/host/main.js chat   --home <abs-dir> [--tail N] [--conversation] [--json]

Exit codes: 0 ok, 1 runtime failure, 2 usage/config/no running host, 3 pause delivered, host still stopping.
The LLM key lives only in <home>/providers.json (mode 0600); it is never accepted on argv or in the environment.
Stop interrupts in-flight work; partial world writes may be committed; the shell does not survive and
resume starts a fresh PTY; resume is a full fold and unresolved effects are not re-executed; resume
spends one turn. pause returns 0 once the host has released its cell, not necessarily after process reaping.
A live or unverified host.json blocks a new host; delete it only if you are certain no host runs.
--charter-file is the base of the composed charter on a start into a cell with no journaled
configuration (including the boot-recovery start); the kernel appends the node identity sentence;
resume refuses it — the journaled config wins. The file's content is journaled as configuration;
never point it at a secret-bearing file.
--nodes-file is a JSON array of {uid, model, heading, charterFile?, spawn?} entries (at most 16,
unique uids): each node gets its own local log, scratch leaf and cgroup leaf, and all share the
home's world and frontier journal. spawn: true declares the kernel's spawn capability for that
node; the grant is declared, never implicit — a solo boot grants nobody; grant by booting a
one-entry nodes file with spawn: true. --nodes-file replaces --uid/--model/--heading/
--charter-file and is read at the config gate; on resume entries declare only uid and spawn —
the journaled config wins.
--gateway-charter is the gateway overlay's charter (the host-side digest service over the
conversation and chat logs, never a node): it is persisted as <home>/gateway.charter.md and
--gateway-model (validated against the provider store's declared catalog, defaulting to its
first entry) beside it. A start without --gateway-charter runs a nodes-only host (even when a
pair is already persisted); resume takes the persisted configuration — the flags are refused
there (the persisted configuration wins). The charter is read up to the capture bound, but the
assembled request is bounded by the overlay policy (2 MiB) and refused at send: an oversize
charter starts and then fails every cycle.
chat is the interactive human↔overlay session (the CLI's first interactive command): it renders
the recent chat log first (both sides' records, the newest --tail records, default 20), then reads
one message per line from stdin — each non-blank line of at most 8192 bytes is saved as a human
record and the overlay's response is rendered when it arrives. The wait is bounded (60 s, with a
still-waiting note at intervals): on timeout the message stays saved and the next overlay cycle
digests it; Ctrl-C aborts the wait, not the session. An absent gateway charter sidecar is detected
up front and the message is saved for when the overlay is configured. --conversation renders the
raw nodes↔overlay stream beside the chat; --json prints the chat records as JSON and exits. A
non-TTY stdin (a pipe or EOF) renders the history and exits, so a scripted chat never blocks.
EOF/Ctrl-D exits 0; a corrupt interior chat record renders what it can with a degraded notice and
exits 1; a missing home exits 2.
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
    'nodes-file': { type: 'string' },
    'gateway-charter': { type: 'string' },
    'gateway-model': { type: 'string' },
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
  // The gateway overlay's config home (O4). The charter is the operator's own
  // absolute path, read once at the start gate; the model is an id validated
  // against the declared catalog, and a model without a charter would be
  // silently unused, so the pair is enforced here.
  const gatewayCharter = values['gateway-charter'];
  if (gatewayCharter !== undefined) {
    if (typeof gatewayCharter !== 'string' || gatewayCharter === '') {
      throw new UsageError('--gateway-charter takes a value');
    }
    if (!isAbsolute(gatewayCharter)) {
      throw new UsageError(`--gateway-charter must be an absolute path: ${gatewayCharter}`);
    }
  }
  const gatewayModel = values['gateway-model'];
  if (gatewayModel !== undefined) {
    if (typeof gatewayModel !== 'string' || gatewayModel === '') {
      throw new UsageError('--gateway-model takes a value');
    }
    if (gatewayCharter === undefined) {
      throw new UsageError('--gateway-model requires --gateway-charter');
    }
  }
  const home = homeOf(values, 'start');
  const nodesFile = nodesFileOf(values);
  if (nodesFile !== undefined) {
    // The file carries every node's config: a solo flag beside it would be
    // ambiguous, so the parser refuses it rather than letting one silently win.
    for (const flag of ['uid', 'model', 'heading', 'charter-file']) {
      if (values[flag] !== undefined) {
        throw new UsageError(`--nodes-file replaces --${flag}; pass it in the nodes file`);
      }
    }
    return {
      command: 'start', home, uid: DEFAULT_UID, noSandbox: values['no-sandbox'] === true,
      nodesFile,
      ...(gatewayCharter !== undefined ? { gatewayCharter } : {}),
      ...(gatewayModel !== undefined ? { gatewayModel } : {}),
    };
  }
  return {
    command: 'start',
    home,
    uid: uidOf(values),
    model: textOf(values, 'model', 'start'),
    heading: textOf(values, 'heading', 'start'),
    noSandbox: values['no-sandbox'] === true,
    ...(charterFile !== undefined ? { charterFile } : {}),
    ...(gatewayCharter !== undefined ? { gatewayCharter } : {}),
    ...(gatewayModel !== undefined ? { gatewayModel } : {}),
  };
}

/** `--nodes-file`, optional and absolute like the other operator paths. */
function nodesFileOf(values: OptionValues): string | undefined {
  const nodesFile = values['nodes-file'];
  if (nodesFile === undefined) return undefined;
  if (typeof nodesFile !== 'string' || nodesFile === '') {
    throw new UsageError('--nodes-file takes a value');
  }
  if (!isAbsolute(nodesFile)) {
    throw new UsageError(`--nodes-file must be an absolute path: ${nodesFile}`);
  }
  return nodesFile;
}

/** `--model`/`--heading` are absent from this table on purpose: resume refuses them. */
function parseResume(args: readonly string[]): HostCliCommand {
  const values = parseStrict(args, {
    home: { type: 'string' },
    'nodes-file': { type: 'string' },
    uid: { type: 'string' },
    'no-sandbox': { type: 'boolean' },
  });
  const nodesFile = nodesFileOf(values);
  if (nodesFile !== undefined && values['uid'] !== undefined) {
    throw new UsageError('--nodes-file replaces --uid; pass the uids in the nodes file');
  }
  return {
    command: 'resume',
    home: homeOf(values, 'resume'),
    uid: uidOf(values),
    noSandbox: values['no-sandbox'] === true,
    ...(nodesFile !== undefined ? { nodesFile } : {}),
  };
}

/** No `--uid` here: one host owns a home, for any uid, so pause targets the record. */
function parsePause(args: readonly string[]): HostCliCommand {
  const values = parseStrict(args, { home: { type: 'string' } });
  return { command: 'pause', home: homeOf(values, 'pause') };
}

/**
 * The chat session's flags: `--tail` bounds the rendered history (a positive
 * integer, default 20), `--conversation` adds the raw stream beside the chat,
 * and `--json` is the one-shot scripted read. No `--uid`: the session is the
 * human's surface, not a node's.
 */
function parseChat(args: readonly string[]): HostCliCommand {
  const values = parseStrict(args, {
    home: { type: 'string' },
    tail: { type: 'string' },
    conversation: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  let tail = CHAT_DEFAULT_TAIL;
  const raw = values['tail'];
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) {
      throw new UsageError('--tail takes a positive integer');
    }
    tail = Number(raw);
    if (!Number.isSafeInteger(tail) || tail < 1) {
      throw new UsageError('--tail takes a positive integer');
    }
  }
  return {
    command: 'chat',
    home: homeOf(values, 'chat'),
    tail,
    conversation: values['conversation'] === true,
    json: values['json'] === true,
  };
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
 * command line. Any other leading token must be one of the six commands.
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
    case 'chat': return parseChat(rest);
    default: throw new UsageError(`unknown command: ${name}`);
  }
}
