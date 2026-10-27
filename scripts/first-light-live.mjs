// The opt-in wrapper for the real first-light run (T9): the one sanctioned way
// to hand the compiled host a real model credential. The live run spends real
// tokens, so it is gated behind ES_LIVE_LLM=1 — the gate is the first
// statement of the wrapper and nothing (no fs, no network) runs before it.
//
// The wrapper adds no policy of its own: it checks the two preconditions the
// operator can get wrong silently (the compiled entry and a 0600 credential
// store), then execs the host with inherited stdio and stays up to forward
// signals and report the child's exit code. The credential store's content is
// never read, never printed.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The opt-in gate: the first statement. Without the flag the wrapper prints a
// bounded refusal naming the exact invocation and exits 2 — no filesystem
// access, no network, no accidental spend of real tokens.
if (process.env.ES_LIVE_LLM !== '1') {
  process.stdout.write(
    'live:first-light refused: the live-model run is opt-in only and never runs by accident.\n'
    + 'Set ES_LIVE_LLM=1 and invoke exactly:\n'
    + '  ES_LIVE_LLM=1 npm run live:first-light -- --home <abs-home> --model <model-id> --heading <heading-text>\n'
    + '  ES_LIVE_LLM=1 npm run live:first-light -- --home <abs-home> --resume\n',
  );
  process.exitCode = 2;
} else {
  await run();
}

/** The wrapper's own flag surface: --home, --model, --heading, --resume. */
function readFlags(argv) {
  const flags = { home: undefined, model: undefined, heading: undefined, resume: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--resume') {
      flags.resume = true;
    } else if (arg === '--home' || arg === '--model' || arg === '--heading') {
      const value = argv[i + 1];
      if (value === undefined) return { error: `${arg} requires a value` };
      flags[arg.slice(2)] = value;
      i += 1;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { flags };
}

async function run() {
  const parsed = readFlags(process.argv.slice(2));
  const refuse = (message) => {
    process.stdout.write(`live:first-light refused: ${message}\n`);
    process.exitCode = 2;
  };
  if (parsed.error !== undefined) {
    refuse(parsed.error);
    return;
  }
  const { home, model, heading, resume } = parsed.flags;
  if (typeof home !== 'string' || home === '' || !isAbsolute(home)) {
    refuse('--home <abs-dir> is required and must be absolute');
    return;
  }
  // Resume takes the home only: the journaled config wins, mirroring the CLI's
  // own refusal of --model/--heading on resume.
  if (resume && (model !== undefined || heading !== undefined)) {
    refuse('resume takes no --model or --heading; the journaled config wins');
    return;
  }
  if (!resume && (typeof model !== 'string' || model === ''
    || typeof heading !== 'string' || heading === '')) {
    refuse('start requires --model <model-id> and --heading <heading-text> (or use --resume)');
    return;
  }

  // Resolved once, used for both the existence check and the spawn, so the
  // wrapper works from any cwd.
  const MAIN = fileURLToPath(new URL('../dist/host/main.js', import.meta.url));
  try {
    const info = await lstat(MAIN);
    if (!info.isFile()) throw new Error('not a regular file');
  } catch {
    process.stdout.write(
      'live:first-light refused: the compiled entry dist/host/main.js is missing; run `npm run build` first\n',
    );
    process.exitCode = 1;
    return;
  }

  // The credential store must exist and grant nothing to group or other. Its
  // content is never read and never printed — only its mode is inspected.
  const providers = join(home, 'providers.json');
  let store;
  try {
    store = await lstat(providers);
  } catch {
    refuse(`${providers} does not exist; create it with mode 0600 and an llm entry`);
    return;
  }
  if (!store.isFile() || (store.mode & 0o077) !== 0) {
    refuse(`${providers} must be a regular file with mode 0600 (no group or other access)`);
    return;
  }

  const argv = resume
    ? ['resume', '--home', home]
    : ['start', '--home', home, '--model', model, '--heading', heading];
  const child = spawn(process.execPath, [MAIN, ...argv], { stdio: 'inherit' });

  // Installing SIGINT/SIGTERM listeners removes Node's default behavior for
  // them (the process docs' single sentence), so the wrapper survives the
  // signal and only forwards it. With stdio:'inherit' the terminal's Ctrl-C
  // also reaches the child directly through the foreground process group; that
  // double signal is benign because the host's stop() is idempotent
  // (src/host/host.ts:370-373).
  const forward = (signal) => { child.kill(signal); };
  process.on('SIGINT', () => { forward('SIGINT'); });
  process.on('SIGTERM', () => { forward('SIGTERM'); });

  const [code] = await once(child, 'exit');
  // Signal death reports code === null; it maps to a deterministic 1 — the
  // host's own failure code — instead of the POSIX 128+signal convention (the
  // plan's D2 ruling).
  process.exitCode = code === null ? 1 : code;
}
