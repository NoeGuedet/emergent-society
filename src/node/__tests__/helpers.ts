import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { collectEvents } from '../../journal/__tests__/helpers.js';
import type { EventEnvelope } from '../../journal/index.js';
import { openTestFrontier } from '../../frontier/__tests__/helpers.js';
import type { FrontierJournal } from '../../frontier/index.js';
import type { ProviderPolicy } from '../../provider/adapter.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { HeadWatcher } from '../watcher.js';
import { WorldRepo, gitEnv } from '../world.js';

/**
 * Scaffolding shared by the node suites: a temp root holding one node home and
 * one world repo, torn down afterwards, plus the git-side helpers a test needs
 * to act as a second writer (another node, or the human), the cell's frontier
 * journal the adapter must cross, and the loopback-server/clock fixtures the
 * HTTP-crossing suites share.
 */

export interface WorldFixture {
  /** The node home: journals and blobs, one directory per node inside it. */
  readonly home: string;
  /** The world repo, shared by every node of the fixture. */
  readonly world: WorldRepo;
  /**
   * The cell's frontier journal, opened on first use and memoized. The teardown
   * closes it (tolerating a fault-poisoned writer's rejection) before removing
   * the home, so a test that never asks for it leaves no `frontier/` directory.
   */
  frontier(): Promise<FrontierJournal>;
}

/**
 * Installs a fixture per test. `pollMs` 0 (the default) disables the watcher's
 * interval, so a suite drives movement with an explicit `poke()` or `check()`
 * instead of waiting on a clock; the interval itself is pinned by its own suite.
 */
export function useWorld(prefix: string, opts: { pollMs?: number } = {}): () => WorldFixture {
  let root = '';
  let fixture: WorldFixture | null = null;
  let opening: Promise<FrontierJournal> | null = null;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), prefix));
    const world = await WorldRepo.init(join(root, 'world'), { gitDir: join(root, 'world.git') });
    // The cadence is fixed before any driver can subscribe: the watcher is one
    // per repo and its first caller sets it.
    HeadWatcher.for(world, opts.pollMs ?? 0);
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    opening = null;
    fixture = {
      home, world,
      frontier: () => {
        if (opening === null) {
          opening = openTestFrontier(home, () => world.headHash()).catch((err: unknown) => {
            opening = null;
            throw err;
          });
        }
        return opening;
      },
    };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    fixture = null;
    const pending = opening;
    opening = null;
    if (pending !== null) {
      const journal = await pending.catch(() => null);
      if (journal !== null) await journal.close().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  return () => {
    if (fixture === null) throw new Error('useWorld() read outside a test');
    return fixture;
  };
}

/**
 * Runs a git command in a raw directory, as a test's own hand rather than a
 * driver's. The environment is the kernel's controlled one: a fixture must not
 * inherit a host `GIT_DIR`/global config any more than production may. A test
 * that deliberately needs a host-ambient read (the replace-ref sanity check)
 * passes its own environment. No pair is prepended: this is for repo creation,
 * `--version`, and other calls that address a directory rather than an opened
 * world.
 */
export async function gitRaw(
  dir: string, args: readonly string[], env: NodeJS.ProcessEnv = gitEnv(),
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile('git', [...args], { cwd: dir, env }, (err, stdout, stderr) => {
      if (err !== null) reject(new Error(`git ${args.join(' ')}: ${stderr}`));
      else resolvePromise(stdout);
    });
  });
}

/**
 * Runs a git command against an opened world: the same controlled environment
 * and the world's own pair plus defense-in-depth overrides, exactly as the
 * kernel addresses the repository.
 */
export async function gitIn(
  world: WorldRepo, args: readonly string[], env: NodeJS.ProcessEnv = gitEnv(),
): Promise<string> {
  return gitRaw(world.path, [...world.gitBaseArgs(), ...args], env);
}

/**
 * Writes files into the world's working tree and commits them as `author` —
 * the shape of another node's turn-end, or of the human's commit (§5.1). The
 * driver is never asked to do this: a test that woke a node through its own
 * commit would not be testing a foreign wake.
 */
export async function commitAs(
  world: WorldRepo, author: string, files: Record<string, string>, message = 'foreign turn',
): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(world.path, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const email = `${author.replace(/[^A-Za-z0-9._-]/g, '-')}@world.local`;
  const env = gitEnv({
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email,
  });
  // `add --all` then `commit`, not `commit --all`: `-a` stages tracked
  // modifications only, so a newly written file would not be committed.
  await gitIn(world, ['add', '--all']);
  await gitIn(world, ['commit', '--quiet', '--message', message], env);
  const head = await world.headHash();
  if (head === null) throw new Error('commitAs left an unborn HEAD');
  return head;
}

/** Writes a file into the world's working tree without committing it. */
export async function writeWorldFile(world: WorldRepo, rel: string, content: string): Promise<void> {
  const path = join(world.path, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** The world's history, oldest first, as `hash author` pairs. */
export async function worldLog(world: WorldRepo): Promise<string[]> {
  const out = await gitIn(world, ['log', '--format=%H %an']);
  return out.split('\n').filter((line) => line !== '').reverse();
}

/** The paths HEAD's commit touched. */
export async function committedPaths(world: WorldRepo): Promise<string[]> {
  const out = await gitIn(world, ['show', '--pretty=format:', '--name-only', 'HEAD']);
  return out.split('\n').filter((line) => line !== '');
}

/** The commit's blob content, or null when the commit does not carry the path. */
export async function committedContent(world: WorldRepo, rel: string): Promise<string | null> {
  try {
    return await gitIn(world, ['show', `HEAD:${rel}`]);
  } catch {
    return null;
  }
}

/** Every event of one node's journal, in order. */
export function readNode(home: string, uid = 'n1'): Promise<EventEnvelope[]> {
  return collectEvents(home, NODE_EVENT_TYPES, uid);
}

// --- the loopback-server and timing fixtures --------------------------------------

/** One request a fixture loopback server received. */
export type RecordedRequest = {
  readonly url: string;
  readonly body: Buffer;
  readonly authorization: string | undefined;
};

/**
 * A loopback server answering one JSON body per request. The responder runs
 * before the response is written, so a test can assert receipt-time facts (the
 * frontier harness's proof 2 does exactly that). A responder throw is recorded
 * in `failures`, not swallowed; the response degrades to a 500 so the run still
 * settles and the test can report the failure.
 */
export type LoopServer = {
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly failures: unknown[];
  close(): Promise<void>;
};

/** Stops a fixture server, closing live connections first so no socket hangs. */
export function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
}

/** Starts a loopback JSON server on an ephemeral port. */
export async function serveJson(
  respond: (
    request: RecordedRequest, index: number,
  ) => { status?: number; body: string } | Promise<{ status?: number; body: string }>,
): Promise<LoopServer> {
  const requests: RecordedRequest[] = [];
  const failures: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const request = {
          url: req.url ?? '',
          body: Buffer.concat(chunks),
          authorization: req.headers.authorization,
        };
        const index = requests.length;
        requests.push(request);
        try {
          const reply = await respond(request, index);
          res.statusCode = reply.status ?? 200;
          res.setHeader('content-type', 'application/json');
          res.end(reply.body);
        } catch (err) {
          failures.push(err);
          res.statusCode = 500;
          res.end('{}');
        }
      })();
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    failures,
    close: () => closeServer(server),
  };
}

/** The adapter's timing port: real timers, no sleeps beyond a retry delay. */
export const providerPolicy: ProviderPolicy = {
  delay: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  }),
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => { clearTimeout(timer); };
  },
};
