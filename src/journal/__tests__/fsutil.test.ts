import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile, open as openFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureDurableDirectory } from '../fsutil.js';

const run = promisify(execFile);
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Runs the real public API in a child process whose cwd is a scratch directory,
 * so relative homes can be exercised without `process.chdir` in the shared
 * worker. Vite loads the TypeScript sources (`ssrLoadModule`), the same way the
 * test suite does.
 */
const PUBLIC_PROBE = `
const repo = process.env.TASK3A_REPO;
const { createServer } = await import(repo + '/node_modules/vite/dist/node/index.js');
const server = await createServer({
  root: repo, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom',
});
try {
  const { JournalWriter } = await server.ssrLoadModule('/src/journal/writer.ts');
  const { BlobStore } = await server.ssrLoadModule('/src/journal/blobs.ts');
  for (const home of ['./cell', 'cell/', './cell//', '', '.']) {
    const w = await JournalWriter.open(home, 'n1', { batchWindowMs: 60000 });
    w.append('test/ping', { n: 0 });
    await w.flush();
    await w.close();
  }
  for (const home of ['./cell', 'cell/']) {
    const store = new BlobStore(home);
    const hash = await store.put(Buffer.from(home));
    if (!(await store.has(hash))) throw new Error('blob missing under ' + home);
  }
  process.stdout.write('OK');
} finally {
  await server.close();
}
`;

let home = '';

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cell-fsutil-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

/**
 * Records the real path behind every `FileHandle#sync` while `fn` runs. The fd
 * is resolved through `/proc`, so the assertion is about the directories the
 * kernel was actually asked to flush — not about which helper was called.
 */
async function recordSyncs<T>(fn: () => Promise<T>): Promise<{ result: T; synced: string[] }> {
  const probe = await openFile(join(home, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const real = proto.sync;
  const synced: string[] = [];
  const spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: FileHandle) {
    synced.push(await readlink(`/proc/self/fd/${this.fd}`));
    return real.call(this);
  });
  try {
    return { result: await fn(), synced };
  } finally {
    spy.mockRestore();
  }
}

describe('ensureDurableDirectory', () => {
  it('creates a two-level chain and fsyncs each parent entry top-down', async () => {
    const dir = join(home, 'nodes', 'n1');
    const { synced } = await recordSyncs(() => ensureDurableDirectory(dir, home));
    // `nodes`'s entry in home, then `n1`'s entry in nodes: a crash between the
    // two can lose the leaf, never point at a non-existent parent.
    expect(synced).toEqual([home, join(home, 'nodes')]);
    expect((await stat(dir)).isDirectory()).toBe(true);
    // Real persisted values, not just call discipline: content written under the
    // new chain is readable back.
    await writeFile(join(dir, 'marker'), 'v');
    expect(await readFile(join(dir, 'marker'), 'utf8')).toBe('v');
  });

  it('fsyncs the trusted root even when an intermediate directory already exists', async () => {
    // Another writer can create `blobs` and die before syncing its parent, so the
    // present directory is not proof: the root must be synced for its entry.
    const blobs = join(home, 'blobs');
    await mkdir(blobs);
    const dir = join(blobs, 'ab');
    const { synced } = await recordSyncs(() => ensureDurableDirectory(dir, home));
    expect(synced).toEqual([home, blobs]);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('never walks above the trusted root', async () => {
    const dir = join(home, 'blobs', 'cd');
    const { synced } = await recordSyncs(() => ensureDurableDirectory(dir, home));
    // The mkdtemp parent is never touched; every synced path is home or below it.
    expect(synced.every((p) => p === home || p.startsWith(`${home}/`))).toBe(true);
    expect(synced).toContain(home);
  });

  it('rejects a leaf that exists as a file with ENOTDIR', async () => {
    const dir = join(home, 'nodes', 'n1');
    await mkdir(join(home, 'nodes'), { recursive: true });
    await writeFile(dir, 'not a directory');
    const err = await ensureDurableDirectory(dir, home).catch((e: unknown) => e) as NodeJS.ErrnoException;
    expect(err.code).toBe('ENOTDIR');
  });

  it('does not swallow a non-EEXIST mkdir failure', async () => {
    // `blobs` is a file, so creating the shard inside it must fail ENOTDIR
    // rather than being reported as an already-created directory.
    await writeFile(join(home, 'blobs'), 'file');
    const err = await ensureDurableDirectory(join(home, 'blobs', 'ef'), home)
      .catch((e: unknown) => e) as NodeJS.ErrnoException;
    expect(err.code).toBe('ENOTDIR');
  });

  it('propagates a parent fsync failure and re-proves on the next call', async () => {
    const dir = join(home, 'nodes', 'n2');
    const probe = await openFile(join(home, 'probe2'), 'w');
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const real = proto.sync;
    const spy = vi.spyOn(proto, 'sync').mockImplementation(async function (this: FileHandle) {
      if ((await readlink(`/proc/self/fd/${this.fd}`)) === home) {
        throw Object.assign(new Error('injected parent fsync EIO'), { code: 'EIO' });
      }
      return real.call(this);
    });
    await expect(ensureDurableDirectory(dir, home)).rejects.toThrow('injected parent fsync EIO');
    spy.mockRestore();
    // No call is remembered, so the retry creates and syncs for real instead of
    // trusting the earlier failure.
    await ensureDurableDirectory(dir, home);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('creates and proves a missing trusted root and its chain', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'cell-fsutil-outer-'));
    try {
      const missingHome = join(outer, 'cell');
      const dir = join(missingHome, 'nodes', 'n1');
      const { synced } = await recordSyncs(() => ensureDurableDirectory(dir, missingHome));
      // The absent home is created and its own entry in `outer` is synced before
      // the levels below it.
      expect(synced).toEqual([outer, missingHome, join(missingHome, 'nodes')]);
      expect((await stat(dir)).isDirectory()).toBe(true);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it('rejects a directory that is not inside the trusted root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cell-fsutil-outside-'));
    try {
      await expect(ensureDurableDirectory(join(outside, 'n1'), home)).rejects.toThrow('not inside');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts a trusted root spelled with a trailing slash, dot segment, or doubled separator', async () => {
    const dir = join(home, 'nodes', 'n1');
    // `dir` is built by `path.join`, but callers pass `root` verbatim: raw string
    // equality must not reject a root that only differs in spelling.
    for (const root of [`${home}/`, `${home}//`, join(home, '.'), join(home, 'nodes', '..')]) {
      await ensureDurableDirectory(dir, root);
    }
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('does not confuse a sibling that shares the root name as a prefix', async () => {
    const sibling = `${home}-sibling`;
    await mkdir(join(sibling, 'n1'), { recursive: true });
    try {
      await expect(ensureDurableDirectory(join(sibling, 'n1'), home)).rejects.toThrow('not inside');
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('accepts non-normalized relative homes through the public writer and blob store', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cell-fsutil-cwd-'));
    try {
      const script = join(cwd, 'probe.mjs');
      await writeFile(script, PUBLIC_PROBE);
      const { stdout } = await run(process.execPath, [script], {
        cwd, env: { ...process.env, TASK3A_REPO: REPO }, timeout: 60_000,
      });
      expect(stdout.trim()).toBe('OK');
      // The relative and empty homes really created their trees under the cwd.
      expect((await stat(join(cwd, 'cell', 'nodes', 'n1'))).isDirectory()).toBe(true);
      expect((await stat(join(cwd, 'nodes', 'n1'))).isDirectory()).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
