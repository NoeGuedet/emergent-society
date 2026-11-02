import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from '@lydell/node-pty';
import {
  afterEach, beforeAll, expect, it,
} from 'vitest';
import { GATEWAY_CHARTER_FILE } from '../../overlay/charter.js';
import { readChat } from '../chat.js';

/**
 * The compiled `chat` session's Ctrl-C wiring — the one seam the injected
 * `waitSignal` unit test cannot prove.
 *
 * This test runs the REAL compiled CLI in a REAL PTY (`@lydell/node-pty`, the
 * repo's terminal precedent) and delivers a real SIGINT to the child while its
 * bounded wait is running: the wait must abort with the saved-message notice,
 * the session must survive and re-prompt, and Ctrl-D (EOF) must exit 0. The
 * record the human typed must already be durable when the signal lands, so the
 * proof covers the whole path (append under the chat lock → wait → interrupt).
 *
 * The proof is on the compiled artifact, so the current sources are compiled
 * first with the project's own build script (the gate runs the same build
 * afterwards); a stale `dist/` can never make this test pass against old code.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'dist', 'host', 'main.js');

beforeAll(() => {
  const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000,
  });
  if (built.status !== 0) {
    throw new Error(
      `the compiled CLI could not be built (${built.status}): ${built.stderr ?? ''}`,
    );
  }
}, 180_000);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Poll-with-deadline: a loaded machine can delay a poll, never flip a verdict. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  expect(await predicate()).toBe(true);
}

it('a real SIGINT interrupts the WAIT, the session re-prompts, and EOF exits 0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'es-chat-sigint-'));
  dirs.push(home);
  // Configured (the charter sidecar exists) but no host runs: the session
  // enters the bounded wait, which is where the SIGINT must land.
  await writeFile(join(home, GATEWAY_CHARTER_FILE), 'You are the gateway overlay.\n',
    { encoding: 'utf8', mode: 0o600 });

  const term = pty.spawn(process.execPath, [CLI, 'chat', '--home', home], {
    name: 'dumb', cols: 120, rows: 40, cwd: ROOT,
    env: { ...process.env, TERM: 'dumb' },
  });
  let seen = '';
  const state: { exit: { exitCode: number; signal?: number } | null } = { exit: null };
  term.onData((chunk) => { seen += chunk; });
  term.onExit((event) => { state.exit = event; });
  try {
    // The prompt means the history rendered and the loop is reading.
    await waitFor(() => seen.includes('> '));
    term.write('a message for the wait\n');
    // The record's fsync lands before the append resolves; the session then
    // checks the overlay sidecar and enters the wait (and installs its SIGINT
    // handler). The short grace is the listener-installation window, not a
    // verdict poll: once the durable record is visible, the wait follows
    // within a couple of event-loop turns.
    await waitFor(async () => (await readChat(home))
      .some((message) => message.text === 'a message for the wait'));
    await new Promise((resolve) => { setTimeout(resolve, 500); });

    expect(process.kill(term.pid, 'SIGINT')).toBe(true);
    await waitFor(() => seen.includes('wait interrupted — your message is saved'));

    // The session survived the interrupt and is waiting at the prompt again.
    // Ctrl-D (EOF on an empty line) ends it cleanly.
    term.write('\u0004');
    await waitFor(() => state.exit !== null);
    expect(state.exit!.exitCode).toBe(0);
    expect((await readChat(home)).map((message) => [message.uid, message.text]))
      .toEqual([['human', 'a message for the wait']]);
  } finally {
    if (state.exit === null) term.kill();
  }
}, 60_000);
