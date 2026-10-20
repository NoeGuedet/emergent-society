import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLock, guardLauncher, LockGuard, JournalLockBusyError, JournalLockUnavailableError,
  SessionAlreadyOwnedError, processStartTime, type OwnerIdentity,
} from '../lock.js';
import { JournalWriter, TornTailError } from '../writer.js';
import { repair } from '../reader.js';
import { frontierLayout, nodeLayout, type JournalLayout } from '../layout.js';
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

async function prepareLayout(uid = 'n1'): Promise<JournalLayout> {
  const layout = nodeLayout(home(), uid);
  await mkdir(layout.dir, { recursive: true });
  return layout;
}

function ownerPathOf(layout: JournalLayout): string {
  return join(layout.dir, layout.ownerFile);
}

function lockPathOf(layout: JournalLayout): string {
  return join(layout.dir, layout.lockFile);
}

async function readOwnerRaw(layout: JournalLayout): Promise<string | null> {
  try {
    return await readFile(ownerPathOf(layout), 'utf8');
  } catch {
    return null;
  }
}

async function ownerExists(layout: JournalLayout): Promise<boolean> {
  try {
    await stat(ownerPathOf(layout));
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
    await expect(stat(nodeLayout(home(), 'ghost').dir)).rejects.toThrow();
  });

  it('grants exactly one live owner among many concurrent acquisitions', async () => {
    const layout = await prepareLayout();
    const results = await Promise.allSettled([
      acquireLock(layout), acquireLock(layout), acquireLock(layout),
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
    const layout = await prepareLayout();
    await writeFile(ownerPathOf(layout), JSON.stringify({ pid: 999999999, startedAt: 1, token: 'x'.repeat(32) }));
    const owner = await acquireLock(layout);
    await expect(acquireLock(layout)).rejects.toThrow(SessionAlreadyOwnedError);
    await owner.release();
  });

  it('is token-bound: a replaced owner record is never removed', async () => {
    const layout = await prepareLayout();
    const first = await acquireLock(layout);
    // A later owner reclaimed the journal after the first was assumed dead.
    await writeFile(ownerPathOf(layout), JSON.stringify({
      pid: process.pid, startedAt: await processStartTime(process.pid), token: 'b'.repeat(32),
    }));
    await first.release();
    expect(JSON.parse((await readOwnerRaw(layout))!).token).toBe('b'.repeat(32));
    await rm(ownerPathOf(layout), { force: true });
  });

  it('release is idempotent and cannot remove a later live owner', async () => {
    const layout = await prepareLayout();
    const first = await acquireLock(layout);
    await first.release();
    const later = await acquireLock(layout);
    await first.release();
    expect(await ownerExists(layout)).toBe(true);
    await later.release();
    expect(await ownerExists(layout)).toBe(false);
  });

  it('reclaims a stale legacy sidecar record but refuses a live one', async () => {
    const layout = await prepareLayout();
    await writeFile(lockPathOf(layout), '999999999');
    const owner = await acquireLock(layout);
    await owner.release();
    await writeFile(lockPathOf(layout), JSON.stringify({
      pid: process.pid, startedAt: await processStartTime(process.pid),
    }));
    await expect(acquireLock(layout)).rejects.toThrow(SessionAlreadyOwnedError);
  });

  it('pins the local lock and owner file names beside the log', async () => {
    const layout = await prepareLayout();
    const owner = await acquireLock(layout);
    expect((await readdir(layout.dir)).sort()).toEqual([layout.lockFile, layout.ownerFile].sort());
    await owner.release();
    expect(await readdir(layout.dir)).toEqual([layout.lockFile]);
  });

  it('pre-creates a fresh flock sidecar with the journal mode 0600', async () => {
    const layout = await prepareLayout();
    const sidecar = lockPathOf(layout);
    const owner = await acquireLock(layout);
    const created = await stat(sidecar);
    expect(created.isFile()).toBe(true);
    expect(created.mode & 0o777).toBe(0o600);
    await owner.release();
  });

  it('never re-modes an existing sidecar and keeps its inode across acquire and re-acquire', async () => {
    const layout = await prepareLayout();
    const sidecar = lockPathOf(layout);
    // The umask can only clear bits from writeFile's mode; pin the literal mode
    // the test asserts, independent of the caller's environment.
    await writeFile(sidecar, 'legacy', { mode: 0o644 });
    await chmod(sidecar, 0o644);
    const planted = await stat(sidecar);
    expect(planted.mode & 0o777).toBe(0o644);
    const first = await acquireLock(layout);
    const acquired = await stat(sidecar);
    expect(acquired.isFile()).toBe(true);
    expect(acquired.ino).toBe(planted.ino);
    expect(acquired.mode & 0o777).toBe(0o644);
    await first.release();
    const second = await acquireLock(layout);
    const again = await stat(sidecar);
    expect(again.ino).toBe(planted.ino);
    expect(again.mode & 0o777).toBe(0o644);
    await second.release();
  });
});

describe('journal ownership across processes', () => {
  it('refuses a live child owner and reclaims a killed one without unlinking', async () => {
    const layout = await prepareLayout();
    const child = fork(FIXTURE, [
      layout.dir, 'hold', layout.lockFile, layout.ownerFile,
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      const message = await waitMessage(child, (m) => m.owned !== undefined);
      expect(message.owned).toBe(true);
      await expect(JournalWriter.open(home(), 'n1')).rejects.toThrow(SessionAlreadyOwnedError);
      expect((await stat(lockPathOf(layout))).isFile()).toBe(true);

      child.kill('SIGKILL');
      await waitExit(child);
      const w = await JournalWriter.open(home(), 'n1');
      await w.close();
      expect((await stat(lockPathOf(layout))).isFile()).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await waitExit(child);
    }
  });

  it('yields exactly one owner from two contenders released by an IPC barrier', async () => {
    const layout = await prepareLayout();
    const childArgv = [layout.dir, 'contend', layout.lockFile, layout.ownerFile];
    const a = fork(FIXTURE, childArgv, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const b = fork(FIXTURE, childArgv, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
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
      expect(await ownerExists(layout)).toBe(true);
    } finally {
      a.kill('SIGKILL');
      b.kill('SIGKILL');
      await Promise.all([waitExit(a), waitExit(b)]);
    }
  });
});

describe('ownership guard failure', () => {
  it('bounds a lingering guard, kills it, and leaves no record or lock', async () => {
    const layout = await prepareLayout();
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
      const guard = new LockGuard(layout);
      const started = Date.now();
      const err = await guard.run('acquire', await identity()).catch((e: unknown) => e);
      const elapsed = Date.now() - started;
      expect(err).toBeInstanceOf(JournalLockUnavailableError);
      // The positive fact is the typed failure; this bound only proves the
      // shortened 800 ms timeout was honored rather than the 10 s default. It is
      // deliberately loose so a loaded host's process reaping cannot flip it.
      expect(elapsed).toBeLessThan(5000);
      expect(await ownerExists(layout)).toBe(false);
      // No orphan still holds the kernel lock: a fresh flock acquires it at once.
      const probe = spawnSync(FLOCK, ['--nonblock', '--exclusive', lockPathOf(layout), '/bin/true']);
      expect(probe.status).toBe(0);
    } finally {
      spy.mockRestore();
    }
  }, 15_000);

  it('reports a spawn failure as unavailable and spawns no cleanup release', async () => {
    const layout = await prepareLayout();
    const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stderr: null, kill: () => true });
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn flock ENOENT'), { code: 'ENOENT' })));
      return child;
    });
    try {
      const err = await acquireLock(layout).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JournalLockUnavailableError);
      expect(err).not.toBeInstanceOf(JournalLockBusyError);
      // The guard never ran, so a cleanup release would be a guaranteed no-op.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(await ownerExists(layout)).toBe(false);
  });

  it('maps the reserved conflict exit code to busy, never to unavailable', async () => {
    const layout = await prepareLayout();
    const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation(() =>
      spawn('/bin/sh', ['-c', 'exit 3'], { stdio: ['ignore', 'ignore', 'pipe'] }));
    try {
      const err = await acquireLock(layout).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JournalLockBusyError);
      expect(err).not.toBeInstanceOf(SessionAlreadyOwnedError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('maps real flock contention on the sidecar to busy, never unavailable', async () => {
    const layout = await prepareLayout();
    const marker = join(home(), 'sidecar-held');
    // A real flock holds the sidecar (the marker is touched only after the lock
    // is acquired), so the guard's flock meets genuine contention.
    const holder = spawn(FLOCK, [
      '-F', '--exclusive', lockPathOf(layout), '/bin/sh', '-c', `touch '${marker}'; sleep 30`,
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
        const err = await acquireLock(layout).catch((e: unknown) => e);
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
    const layout = await prepareLayout();
    const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation(() =>
      spawn('/bin/sh', ['-c', 'exit 1'], { stdio: ['ignore', 'ignore', 'pipe'] }));
    try {
      const err = await acquireLock(layout).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JournalLockUnavailableError);
      expect(err).not.toBeInstanceOf(JournalLockBusyError);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('names the frontier, never a node, in a guard failure', async () => {
    const layout = frontierLayout(home());
    await mkdir(layout.dir, { recursive: true });
    const spy = vi.spyOn(guardLauncher, 'spawn').mockImplementation(() => {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stderr: null, kill: () => true });
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn flock ENOENT'), { code: 'ENOENT' })));
      return child;
    });
    try {
      const err = await acquireLock(layout).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JournalLockUnavailableError);
      expect((err as JournalLockUnavailableError).label).toBe('frontier');
      expect((err as Error).message).toContain('journal "frontier"');
    } finally {
      spy.mockRestore();
    }
  });

  it('persists the whole owner record through short writeSync calls', async () => {
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
    const layout = nodeLayout(home(), 'n1');
    await mkdir(layout.dir, { recursive: true });
    const res = spawnSync(process.execPath, [
      helper, 'acquire', layout.dir, String(process.pid), 'null', token,
      '--lock', layout.lockFile, '--owner', layout.ownerFile,
    ], { env: { ...process.env, NODE_OPTIONS: `--require ${preload}` } });
    expect(res.status).toBe(0);
    // The record is the complete JSON object, not a truncated prefix.
    expect(JSON.parse(await readFile(ownerPathOf(layout), 'utf8')))
      .toEqual({ pid: process.pid, startedAt: null, token });
  });

  it('rejects unknown commands and malformed tokens without writing a record', async () => {
    const layout = await prepareLayout();
    const helper = fileURLToPath(new URL('../lock-guard.mjs', import.meta.url));
    const names = ['--lock', layout.lockFile, '--owner', layout.ownerFile];
    const unknown = spawnSync(process.execPath, [
      helper, 'bogus', layout.dir, '1', '1', 'a'.repeat(32), ...names,
    ]);
    expect(unknown.status).toBe(12);
    const badToken = spawnSync(process.execPath, [
      helper, 'acquire', layout.dir, String(process.pid), 'null', 'not-a-token', ...names,
    ]);
    expect(badToken.status).toBe(12);
    expect(await ownerExists(layout)).toBe(false);
  });

  it('refuses a separator, dot-dot, or control character in the guard file names', async () => {
    const layout = await prepareLayout();
    const helper = fileURLToPath(new URL('../lock-guard.mjs', import.meta.url));
    const token = 'a'.repeat(32);
    const base = [helper, 'acquire', layout.dir, String(process.pid), 'null', token];
    const status = (lockFile: string, ownerFile: string): number | null =>
      spawnSync(process.execPath, [...base, '--lock', lockFile, '--owner', ownerFile]).status;
    expect(status('..', layout.ownerFile)).toBe(12);
    expect(status('../escape', layout.ownerFile)).toBe(12);
    expect(status(layout.lockFile, '..')).toBe(12);
    expect(status(layout.lockFile, 'a/b')).toBe(12);
    // A control character is not a name a diagnostic can safely carry. NUL
    // cannot cross `spawn`, so the guard's argv check is exercised with a
    // printable-control neighbor.
    expect(status('lock\u0001name', layout.ownerFile)).toBe(12);
    expect(status(layout.lockFile, 'owner\nname')).toBe(12);
    expect(await ownerExists(layout)).toBe(false);
  });

  it('refuses a control character in either name with the typed error', async () => {
    const layout = await prepareLayout();
    // NUL is the case that currently escapes `basename` and reaches `spawn`,
    // whose raw TypeError is not the ownership layer's typed refusal.
    for (const bad of [
      { lockFile: 'lock\u0000name' },
      { ownerFile: 'owner\u0001name' },
    ]) {
      const guard = new LockGuard({ ...layout, ...bad });
      const guarded = await guard.run('acquire', await identity()).catch((e: unknown) => e);
      expect(guarded).toBeInstanceOf(JournalLockUnavailableError);
      expect(guarded).not.toBeInstanceOf(TypeError);
      const acquired = await acquireLock({ ...layout, ...bad }).catch((e: unknown) => e);
      expect(acquired).toBeInstanceOf(JournalLockUnavailableError);
      expect(acquired).not.toBeInstanceOf(TypeError);
    }
    expect(await ownerExists(layout)).toBe(false);
  });

  it('refuses an unsafe layout name before building the guard argv', async () => {
    const layout = await prepareLayout();
    const spy = vi.spyOn(guardLauncher, 'spawn');
    try {
      // A non-string name must reach the typed refusal, not `basename`'s
      // ERR_INVALID_ARG_TYPE: a hand-built layout is not type-checked at runtime.
      const badNames = [
        { lockFile: '..' }, { lockFile: 'a/b' }, { ownerFile: '../escape' },
        { lockFile: 42 as unknown as string },
        { ownerFile: null as unknown as string },
      ];
      for (const bad of badNames) {
        const guard = new LockGuard({ ...layout, ...bad });
        const err = await guard.run('acquire', await identity()).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(JournalLockUnavailableError);
        expect((err as JournalLockUnavailableError).label).toBe('n1');
        // The parent's sidecar pre-creation is refused too, before any path is used.
        const acquired = await acquireLock({ ...layout, ...bad }).catch((e: unknown) => e);
        expect(acquired).toBeInstanceOf(JournalLockUnavailableError);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('releases ownership when writer.open fails after acquiring', async () => {
    const w = await JournalWriter.open(home(), 'n1');
    w.append('test/ping', { n: 0 });
    await w.close();
    await appendTear(home());
    await expect(JournalWriter.open(home(), 'n1')).rejects.toThrow(TornTailError);
    expect(await ownerExists(nodeLayout(home(), 'n1'))).toBe(false);
    const owner = await acquireLock(nodeLayout(home(), 'n1'));
    await owner.release();
  });

  it('releases ownership even when close() flushes into a failure', async () => {
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000 });
    w.append('test/ping', { n: 0 });
    await expect(withFailingWrite(home(), () => w.close(), 1)).rejects.toThrow('injected EIO');
    expect(await ownerExists(nodeLayout(home(), 'n1'))).toBe(false);
  });
});

describe('owner record read semantics', () => {
  it('treats an unparseable owner record as no owner and reclaims it', async () => {
    const layout = await prepareLayout();
    await writeFile(ownerPathOf(layout), '{"pid": not-json');
    const owner = await acquireLock(layout);
    await owner.release();
  });

  it.skipIf(process.getuid?.() === 0)(
    'fails closed when the owner record is unreadable instead of overwriting it',
    async () => {
      const layout = await prepareLayout();
      const original = JSON.stringify({ pid: 999999999, startedAt: 1, token: 'c'.repeat(32) });
      await writeFile(ownerPathOf(layout), original);
      await chmod(ownerPathOf(layout), 0o000);
      try {
        const err = await acquireLock(layout).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(JournalLockUnavailableError);
      } finally {
        await chmod(ownerPathOf(layout), 0o600).catch(() => {});
      }
      // A live owner's record was not replaced by a blind new record.
      expect(await readFile(ownerPathOf(layout), 'utf8')).toBe(original);
    },
  );
});
