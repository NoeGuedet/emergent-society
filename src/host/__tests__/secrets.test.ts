import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadVerifiedEvents } from '../../context/loader.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { JournalReader, frontierLayout, type EventEnvelope } from '../../journal/index.js';
import { FRONTIER_EVENT_TYPES } from '../../frontier/index.js';
import { WorldRepo, gitEnv } from '../../node/world.js';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import { serveJson } from '../../node/__tests__/helpers.js';
import { TEST_STORAGE } from '../../frontier/__tests__/helpers.js';
import { createHostLog } from '../observe.js';
import { composeCell, type Cell } from '../host.js';

/**
 * The composed cell's secret hygiene: one real turn against a loopback fake
 * provider, then every resolved surface the cell can write is searched for the
 * injected model key.
 *
 * Raw `.zstd` journal bytes are not scanned — they are compressed, so absence
 * there proves nothing. The scan reads what the kernel and the operator can
 * read: resolved local events, frontier events, every blob, the world's git
 * history and worktree, and the injected host log. The key is allowed to appear
 * in exactly one place: the `Authorization` header the transport wrote, captured
 * by the loopback server itself.
 */

const LLM_KEY = 'sentinel-llm-key-not-a-real-key';

const config = validateAgentConfig({
  ...defaultAgentConfig(), model: 'first-light-test', heading: 'First light.',
});

let home = '';
/** The one cell this case composed, settled by teardown even after a failure. */
let cell: Cell | null = null;
/** Its driver run, awaited by teardown so a live cell is never closed under a turn. */
let run: Promise<void> | null = null;

afterEach(async () => {
  let clean = true;
  if (cell !== null) {
    cell.driver.stop('stop-requested');
    if (run !== null) {
      try {
        await run;
      } catch {
        clean = false;
      }
    }
    try {
      await cell.close();
    } catch {
      clean = false;
    }
  }
  // A home is removed only once the cell's writers released it: a failed
  // teardown leaves it in place for inspection instead of deleting it under a
  // live journal.
  if (home !== '' && clean) await rm(home, { recursive: true, force: true });
  home = '';
  cell = null;
  run = null;
});

/** One git invocation addressed by absolute pair paths, never a cwd-relative pair. */
function git(gitDir: string, world: string, args: readonly string[]): string {
  return execFileSync('git', ['--git-dir', gitDir, '--work-tree', world, ...args], {
    encoding: 'utf8',
    env: gitEnv(),
  });
}

/** Every regular file below `dir`, as absolute paths. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

it('journals no byte of the model key outside the authorization header it wrote', async () => {
  home = await mkdtemp(join(tmpdir(), 'es-host-secrets-'));
  const gitDir = join(home, 'world.git');
  const worldPath = join(home, 'world');
  const world = await WorldRepo.init(worldPath, { gitDir });
  // A human seed commit, made with the identity this fixture supplies rather
  // than whatever the ambient git config happens to hold.
  execFileSync('git', [
    '--git-dir', world.gitDir, '--work-tree', world.path, 'commit', '--allow-empty',
    '--message', 'seed',
  ], {
    encoding: 'utf8',
    // The kernel's controlled environment, not the ambient one: a host
    // GIT_DIR/global config must not reach this fixture any more than production.
    env: gitEnv({
      GIT_AUTHOR_NAME: 'human', GIT_AUTHOR_EMAIL: 'human@world.local',
      GIT_COMMITTER_NAME: 'human', GIT_COMMITTER_EMAIL: 'human@world.local',
    }),
  });

  const script = [
    { role: 'assistant', content: null,
      tool_calls: [{ id: 'e0', type: 'function',
        function: { name: 'execute',
          arguments: JSON.stringify({ cmd: "printf 'scanned\\n' > note.txt" }) } }] },
    { role: 'assistant', content: 'done' },
  ];
  const server = await serveJson((_req, i) => ({
    body: JSON.stringify({ choices: [{ message: script[i] ?? { role: 'assistant', content: 'idle' } }] }),
  }));
  const lines: string[] = []; const log = createHostLog((l) => lines.push(l));
  const credential = { endpoint: `${server.url}/v1/chat/completions`,
    key: LLM_KEY, credentialId: 'llm' as const };
  try {
    const composed = await composeCell({
      home, uid: 'node-0', config, credential, providers: {}, sandbox: false, pollMs: 0, log,
      storage: TEST_STORAGE,
    });
    cell = composed;
    const done = composed.driver.run();
    run = done;
    // An unawaited failure must not surface as an unhandled rejection; teardown
    // still awaits (and sees) the original promise.
    void done.catch(() => {});
    await vi.waitFor(() => expect(composed.driver.state).toBe('waiting'), { timeout: 10_000 });
    composed.driver.stop('stop-requested'); await done; await composed.close();

    // 1. Every resolved local event, both the payload and its raw envelope.
    const events = await loadVerifiedEvents(home, 'node-0', C13_EVENT_TYPES);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(JSON.stringify(event.data)).not.toContain(LLM_KEY);
      expect(JSON.stringify(event.raw.data)).not.toContain(LLM_KEY);
    }

    // 2. Every frontier event.
    const reader = await JournalReader.openIn(frontierLayout(home), {
      knownTypes: FRONTIER_EVENT_TYPES,
    });
    const frontier: EventEnvelope[] = [];
    for await (const event of reader.events()) frontier.push(event);
    expect(frontier.length).toBeGreaterThan(0);
    for (const event of frontier) expect(JSON.stringify(event.data)).not.toContain(LLM_KEY);

    // 3. Every blob, read as bytes rather than as a journal record.
    const blobRoot = join(home, 'blobs');
    let blobs = 0;
    for (const dir of await readdir(blobRoot)) {
      for (const name of await readdir(join(blobRoot, dir))) {
        expect(await readFile(join(blobRoot, dir, name), 'utf8')).not.toContain(LLM_KEY);
        blobs += 1;
      }
    }
    expect(blobs).toBeGreaterThan(0);

    // 4. The world: the patch history, the messages and every worktree file.
    const patches = git(world.gitDir, world.path, ['log', '-p', '--all']);
    expect(patches).toContain('note.txt');
    expect(patches).not.toContain(LLM_KEY);
    expect(git(world.gitDir, world.path, ['log', '--format=%B', '--all']))
      .not.toContain(LLM_KEY);
    const worktree = await filesUnder(world.path);
    expect(worktree.some((path) => path.endsWith('note.txt'))).toBe(true);
    for (const path of worktree) expect(await readFile(path, 'utf8')).not.toContain(LLM_KEY);

    // 5. The injected host log, not whatever reached process.stderr.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(LLM_KEY);

    // 6. The one allowed occurrence: the header the transport wrote. The bodies
    // never carry it, and the fake server never echoed either back.
    expect(server.requests.map((request) => request.authorization))
      .toEqual([`Bearer ${LLM_KEY}`, `Bearer ${LLM_KEY}`]);
    for (const request of server.requests) {
      expect(request.body.toString('utf8')).not.toContain(LLM_KEY);
    }
  } finally {
    await server.close();
  }
}, 30_000);
