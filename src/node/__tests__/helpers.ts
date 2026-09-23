import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { collectEvents } from '../../journal/__tests__/helpers.js';
import type { EventEnvelope } from '../../journal/index.js';
import { NODE_EVENT_TYPES } from '../events.js';
import { HeadWatcher } from '../watcher.js';
import { WorldRepo } from '../world.js';

/**
 * Scaffolding shared by the node suites: a temp root holding one node home and
 * one world repo, torn down afterwards, plus the git-side helpers a test needs
 * to act as a second writer (another node, or the human).
 */

export interface WorldFixture {
  /** The node home: journals and blobs, one directory per node inside it. */
  readonly home: string;
  /** The world repo, shared by every node of the fixture. */
  readonly world: WorldRepo;
}

/**
 * Installs a fixture per test. `pollMs` 0 (the default) disables the watcher's
 * interval, so a suite drives movement with an explicit `poke()` or `check()`
 * instead of waiting on a clock; the interval itself is pinned by its own suite.
 */
export function useWorld(prefix: string, opts: { pollMs?: number } = {}): () => WorldFixture {
  let root = '';
  let fixture: WorldFixture | null = null;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), prefix));
    const world = await WorldRepo.init(join(root, 'world'));
    // The cadence is fixed before any driver can subscribe: the watcher is one
    // per repo and its first caller sets it.
    HeadWatcher.for(world, opts.pollMs ?? 0);
    fixture = { home: join(root, 'home'), world };
    await mkdir(fixture.home, { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    fixture = null;
    await rm(root, { recursive: true, force: true });
  });
  return () => {
    if (fixture === null) throw new Error('useWorld() read outside a test');
    return fixture;
  };
}

/** Runs a git command in a directory, as a test's own hand rather than a driver's. */
export async function gitIn(dir: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile('git', [...args], { cwd: dir }, (err, stdout, stderr) => {
      if (err !== null) reject(new Error(`git ${args.join(' ')}: ${stderr}`));
      else resolvePromise(stdout);
    });
  });
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
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email,
  };
  // `add --all` then `commit`, not `commit --all`: `-a` stages tracked
  // modifications only, so a newly written file would not be committed.
  await gitIn(world.path, ['add', '--all']);
  await new Promise<void>((resolvePromise, reject) => {
    execFile('git', ['commit', '--quiet', '--message', message], { cwd: world.path, env },
      (err, _stdout, stderr) => { if (err !== null) reject(new Error(stderr)); else resolvePromise(); });
  });
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
  const out = await gitIn(world.path, ['log', '--format=%H %an']);
  return out.split('\n').filter((line) => line !== '').reverse();
}

/** The paths HEAD's commit touched. */
export async function committedPaths(world: WorldRepo): Promise<string[]> {
  const out = await gitIn(world.path, ['show', '--pretty=format:', '--name-only', 'HEAD']);
  return out.split('\n').filter((line) => line !== '');
}

/** The commit's blob content, or null when the commit does not carry the path. */
export async function committedContent(world: WorldRepo, rel: string): Promise<string | null> {
  try {
    return await gitIn(world.path, ['show', `HEAD:${rel}`]);
  } catch {
    return null;
  }
}

/** Every event of one node's journal, in order. */
export function readNode(home: string, uid = 'n1'): Promise<EventEnvelope[]> {
  return collectEvents(home, NODE_EVENT_TYPES, uid);
}

/** The events of one type, typed loosely enough for assertions. */
export function eventsOf(events: readonly EventEnvelope[], type: string): EventEnvelope[] {
  return events.filter((e) => e.type === type);
}

/** The data of every event of one type. */
export function dataOf(events: readonly EventEnvelope[], type: string): unknown[] {
  return eventsOf(events, type).map((e) => e.data);
}
