import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock, guardLauncher, LockGuard, JournalLockBusyError, JournalLockUnavailableError,
  SessionAlreadyOwnedError, processStartTime, type OwnerIdentity,
} from '../lock.js';
import { JournalWriter, TornTailError } from '../writer.js';
import { repair } from '../reader.js';
import { lockPath, nodeDir, ownerPath } from '../layout.js';
import { appendTear, logPath, useTempHome, withFailingWrite } from './helpers.js';

const home = useTempHome('cell-lock-');
const FIXTURE = fileURLToPath(new URL('./fixtures/owner-child.mjs', import.meta.url));
const SLOW_FIXTURE = fileURLToPath(new URL('./fixtures/slow-guard-child.mjs', import.meta.url));
const FLOCK = '/usr/bin/flock';

async function identity(): Promise<OwnerIdentity> {
  return {
    pid: process.pid, startedAt: await processStartTime(process.pid), token: 'a'.repeat(32),
  };
}

interface ChildMessage {
  ready?: boolean;
  owned?: boolean;
  code?: number;
}

async function prepareDir(uid = 'n1'): Promise<string> {
  const dir = nodeDir(home(), uid);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function readOwnerRaw(dir: string): Promise<string | null> {
  try {
    return await readFile(ownerPath(dir), 'utf8');
  } catch {
    return null;
  }
}

async function ownerExists(dir: string): Promise<boolean> {
  try {
    await stat(ownerPath(dir));
    return true;
  } catch {
    return false;
  }
}

function waitMessage(child: ChildProcess, want: (m: ChildMessage) => boolean): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const message = raw as ChildMessage;
      if (want(message)) {
        child.off('message', onMessage);
        resolve(message);
      }
    };
    child.on('message', onMessage);
    child.once('error', reject);
  });
}

function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once('exit', () => resolve()); });
}

describe('journal ownership', () => {
  it('refuses repair while a live writer owns the journal and truncates nothing', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    await appendTear(home());
    const before = (await readFile(logPath(home()))).length;
    await expect(repair(home(), 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
    expect((await readFile(logPath(home()))).length).toBe(before);
    await w.close();
    expect(await repair(home(), 'n1')).toEqual({ tornBytes: 9 });
  });

  it('repair on a missing journal creates nothing', async () => {
    expect(await repair(home(), 'ghost')).toEqual({ tornBytes: 0 });
    await expect(stat(nodeDir(home(), 'ghost'))).rejects.toThrow();
  });

  it('grants exactly one live owner among many concurrent acquisitions', async () => {
    const dir = await prepareDir();
    const results = await Promise.allSettled([
      acquireLock(dir, 'n1'), acquireLock(dir, 'n1'), acquireLock(dir, 'n1'),
    ]);
    const owned = results.filter((r) => r.status === 'fulfilled');
    expect(owned).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        // Under load a loser may legitimately lose the flock wait and be busy
        // rather than observe the winner's finished record.
        expect(
          r.reason instanceof SessionAlreadyOwnedError || r.reason instanceof JournalLockBusyError,
        ).toBe(true);
      }
    }
    await (owned[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });

  it('reclaims a stale owner record but refuses a live one', async () => {
    const dir = await prepareDir();
    await writeFile(ownerPath(dir), JSON.stringify({ pid: 999999999, startedAt: 1, token: 'x'.repeat(32) }));
    const owner = await acquireLock(dir, 'n1');
    await expect(acquireLock(dir, 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
    await owner.release();
  });

  it('is token-bound: a replaced owner record is never removed', async () => {
    const dir = await prepareDir();
    const first = await acquireLock(dir, 'n1');
    // A later owner reclaimed the journal after the first was assumed dead.
    await writeFile(ownerPath(dir), JSON.stringify({
      pid: process.pid, startedAt: await processStartTime(process.pid), token: 'b'.repeat(32),
    }));
    await first.release();
    expect(JSON.parse((await readOwnerRaw(dir))!).token).toBe('b'.repeat(32));
    await rm(ownerPath(dir), { force: true });
  });

  it('release is idempotent and cannot remove a later live owner', async () => {
    const dir = await prepareDir();
    const first = await acquireLock(dir, 'n1');
    await first.release();
    const later = await acquireLock(dir, 'n1');
    await first.release();
    expect(await ownerExists(dir)).toBe(true);
    await later.release();
    expect(await ownerExists(dir)).toBe(false);
  });

  it('reclaims a stale legacy sidecar record but refuses a live one', async () => {
    const dir = await prepareDir();
    await writeFile(lockPath(dir), '999999999');
    const owner = await acquireLock(dir, 'n1');
    await owner.release();
    await writeFile(lockPath(dir), JSON.stringify({
      pid: process.pid, startedAt: await processStartTime(process.pid),
    }));
    await expect(acquireLock(dir, 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
  });

  it('keeps the flock sidecar inode across acquire and release', async () => {
    const dir = await prepareDir();
    const before = (await stat(lockPath(dir)).catch(() => null));
    const owner = await acquireLock(dir, 'n1');
    await owner.release();
    const after = await stat(lockPath(dir));
    expect(after.isFile()).toBe(true);
    if (before !== null) expect(after.ino).toBe(before.ino);
  });
});

describe('journal ownership across processes', () => {
  it('refuses a live child owner and reclaims a killed one without unlinking', async () => {
    const dir = await prepareDir();
    const child = fork(FIXTURE, [dir, 'hold'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      const message = await waitMessage(child, (m) => m.owned !== undefined);
      expect(message.owned).toBe(true);
      await expect(JournalWriter.open(home(), 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
      expect((await stat(lockPath(dir))).isFile()).toBe(true);

      child.kill('SIGKILL');
      await waitExit(child);
      const w = await JournalWriter.open(home(), 'n1');
      await w.close();
      expect((await stat(lockPath(dir))).isFile()).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await waitExit(child);
    }
  });

  it('yields exactly one owner from two contenders released by an IPC barrier', async () => {
    const dir = await prepareDir();
    const a = fork(FIXTURE, [dir, 'contend'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const b = fork(FIXTURE, [dir, 'contend'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      const readyA = waitMessage(a, (m) => m.ready === true);
      const readyB = waitMessage(b, (m) => m.ready === true);
      await Promise.all([readyA, readyB]);
      const ownedA = waitMessage(a, (m) => m.owned !== undefined);
      const ownedB = waitMessage(b, (m) => m.owned !== undefined);
      a.send('go');
      b.send('go');
      const [ra, rb] = await Promise.all([ownedA, ownedB]);
      expect([ra, rb].filter((r) => r.owned === true)).toHaveLength(1);
      expect([ra, rb].filter((r) => r.owned === false)).toHaveLength(1);
      expect(await ownerExists(dir)).toBe(true);
    } finally {
      a.kill('SIGKILL');
      b.kill('SIGKILL');
      await Promise.all([waitExit(a), waitExit(b)]);
    }
  });
});

describe('ownership guard failure', () => {
  it('bounds a lingering guard, kills it, and leaves no record or lock', async () => {
    const dir = await prepareDir();
    const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation((args: string[]) => {
      // Run the real `flock` with the production options, but swap the helper
      // for a stand-in that outlives the shortened wait. `flock -F` execs it in
      // place, so the timeout must kill it and release the lock.
      const next = [...args];
      const commandAt = next.indexOf('acquire');
      next[commandAt - 1] = SLOW_FIXTURE;
      return spawn(FLOCK, next, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 800 });
    });
    try {
      const guard = new LockGuard(dir, 'n1');
      const started = Date.now();
      const err = await guard.run('acquire', await identity()).catch((e: unknown) => e);
      const elapsed = Date.now() - started;
      expect(err).toBeInstanceOf(JournalLockUnavailableError);
      expect(elapsed).toBeLessThan(1800);
      expect(await ownerExists(dir)).toBe(false);
      // No orphan still holds the kernel lock: a fresh flock acquires it at once.
      const probe = spawnSync(FLOCK, ['--nonblock', '--exclusive', lockPath(dir), '/bin/true']);
      expect(probe.status).toBe(0);
    } finally {
      spy.mockRestore();
    }
  }, 15_000);

  it('reports a spawn failure as unavailable and spawns no cleanup release', async () => {
    const dir = await prepareDir();
    const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stderr: null, kill: () => true });
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn flock ENOENT'), { code: 'ENOENT' })));
      return child;
    });
    try {
      const err = await acquireLock(dir, 'n1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JournalLockUnavailableError);
      expect(err).not.toBeInstanceOf(JournalLockBusyError);
      // The guard never ran, so a cleanup release would be a guaranteed no-op.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await ownerExists(dir)).toBe(false);
  });

  it('maps the reserved conflict exit code to busy, never to unavailable', async () => {
    const dir = await prepareDir();
    const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation(() =>
      spawn('/bin/sh', ['-c', 'exit 3'], { stdio: ['ignore', 'ignore', 'pipe'] }));
    try {
      const err = await acquireLock(dir, 'n1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JournalLockBusyError);
      expect(err).not.toBeInstanceOf(SessionAlreadyOwnedError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('maps real flock contention on the sidecar to busy, never unavailable', async () => {
    const dir = await prepareDir();
    const marker = join(home(), 'sidecar-held');
    // A real flock holds the sidecar (the marker is touched only after the lock
    // is acquired), so the guard's flock meets genuine contention.
    const holder = spawn(FLOCK, [
      '-F', '--exclusive', lockPath(dir), '/bin/sh', '-c', `touch '${marker}'; sleep 30`,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      await vi.waitFor(async () => { await stat(marker); }, { timeout: 5_000 });
      const realSpawn = guardLauncher.spawn.bind(guardLauncher);
      const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation((args: string[], timeoutMs: number) => {
        // Keep the production flock flags and helper; only shorten the wait so
        // the contended guard is observed at once rather than after 5 seconds.
        return realSpawn(args.map((a) => (a.startsWith('--wait=') ? '--wait=0' : a)), timeoutMs);
      });
      try {
        const err = await acquireLock(dir, 'n1').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(JournalLockBusyError);
        expect(err).not.toBeInstanceOf(JournalLockUnavailableError);
      } finally {
        spy.mockRestore();
      }
    } finally {
      holder.kill('SIGKILL');
      await new Promise<void>((resolvePromise) => holder.once('exit', () => resolvePromise()));
    }
  }, 15_000);

  it('treats any other guard exit code as unavailable, not busy', async () => {
    const dir = await prepareDir();
    const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation(() =>
      spawn('/bin/sh', ['-c', 'exit 1'], { stdio: ['ignore', 'ignore', 'pipe'] }));
    try {
      const err = await acquireLock(dir, 'n1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JournalLockUnavailableError);
      expect(err).not.toBeInstanceOf(JournalLockBusyError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('persists the whole owner record through short writeSync calls', async () => {
    const dir = await prepareDir();
    const preload = join(home(), 'shortwrite-preload.cjs');
    // A test-owned preload that forces every `writeSync` to advance at most three
    // bytes, then re-syncs the builtin ESM bindings so the helper's named import
    // sees the patched function. No production testing flag is involved.
    await writeFile(preload, [
      "const fs = require('node:fs');",
      'const real = fs.writeSync;',
      'function short(fd, buf, offset, length, position) {',
      '  const off = offset ?? 0;',
      '  const len = length ?? buf.length - off;',
      '  return real.call(fs, fd, buf, off, Math.min(len, 3), position ?? null);',
      '}',
      'fs.writeSync = function (fd, buffer, offset, length, position) {',
      "  if (typeof buffer === 'string') return short(fd, Buffer.from(buffer, 'utf8'), 0, undefined, position);",
      '  if (Buffer.isBuffer(buffer)) return short(fd, buffer, offset, length, position);',
      '  return real.apply(fs, arguments);',
      '};',
      "require('node:module').syncBuiltinESMExports();",
      '',
    ].join('\n'));
    const helper = fileURLToPath(new URL('../lock-guard.mjs', import.meta.url));
    const token = 'b'.repeat(32);
    const res = spawnSync(process.execPath, [
      helper, 'acquire', dir, String(process.pid), 'null', token,
    ], { env: { ...process.env, NODE_OPTIONS: `--require ${preload}` } });
    expect(res.status).toBe(0);
    // The record is the complete JSON object, not a truncated prefix.
    expect(JSON.parse(await readFile(ownerPath(dir), 'utf8')))
      .toEqual({ pid: process.pid, startedAt: null, token });
  });

  it('rejects unknown commands and malformed tokens without writing a record', async () => {
    const dir = await prepareDir();
    const helper = fileURLToPath(new URL('../lock-guard.mjs', import.meta.url));
    const unknown = spawnSync(process.execPath, [helper, 'bogus', dir, '1', '1', 'a'.repeat(32)]);
    expect(unknown.status).toBe(12);
    const badToken = spawnSync(process.execPath, [
      helper, 'acquire', dir, String(process.pid), 'null', 'not-a-token',
    ]);
    expect(badToken.status).toBe(12);
    expect(await ownerExists(dir)).toBe(false);
  });

  it('releases ownership when writer.open fails after acquiring', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await appendTear(home());
    await expect(JournalWriter.open(home(), 'n1')).rejects.toThrow(TornTailError);
    expect(await ownerExists(nodeDir(home(), 'n1'))).toBe(false);
    const owner = await acquireLock(nodeDir(home(), 'n1'), 'n1');
    await owner.release();
  });

  it('releases ownership even when close() flushes into a failure', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await expect(withFailingWrite(home(), () => w.close(), 1)).rejects.toThrow('injected EIO');
    expect(await ownerExists(nodeDir(home(), 'n1'))).toBe(false);
  });
});

describe('owner record read semantics', () => {
  it('treats an unparseable owner record as no owner and reclaims it', async () => {
    const dir = await prepareDir();
    await writeFile(ownerPath(dir), '{"pid": not-json');
    const owner = await acquireLock(dir, 'n1');
    await owner.release();
  });

  it.skipIf(process.getuid?.() === 0)(
    'fails closed when the owner record is unreadable instead of overwriting it',
    async () => {
      const dir = await prepareDir();
      const original = JSON.stringify({ pid: 999999999, startedAt: 1, token: 'c'.repeat(32) });
      await writeFile(ownerPath(dir), original);
      await chmod(ownerPath(dir), 0o000);
      try {
        const err = await acquireLock(dir, 'n1').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(JournalLockUnavailableError);
      } finally {
        await chmod(ownerPath(dir), 0o600).catch(() => {});
      }
      // A live owner's record was not replaced by a blind new record.
      expect(await readFile(ownerPath(dir), 'utf8')).toBe(original);
    },
  );
});
