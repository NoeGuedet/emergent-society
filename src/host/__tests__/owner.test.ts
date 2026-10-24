import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { processStartTime } from '../../journal/lock.js';
import { HostAlreadyRunningError, HostConfigError, HostPauseError } from '../errors.js';
import {
  acquireOwner, PAUSE_POLL_MS, PAUSE_TIMEOUT_MS, readOwner, requestPause, type OwnerHandle,
} from '../owner.js';

/**
 * The owner record's wire shape, re-stated so the fixtures do not depend on the
 * module's own type export; a fixture that drifts from the record fails the
 * reader's exact-key validation, which is the point of these cases.
 */
type OwnerJson = {
  v: 1; pid: number; startTime: number | null; token: string;
  uid: string; command: 'start' | 'resume'; startedAt: number;
};

let home = '';

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'es-owner-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function startOf(pid: number): Promise<number | null> {
  return processStartTime(pid);
}

/** A complete, valid record with the caller's overrides. */
async function ownerJson(partial: Partial<OwnerJson> = {}): Promise<OwnerJson> {
  return {
    v: 1,
    pid: process.pid,
    startTime: await startOf(process.pid),
    token: 'a'.repeat(32),
    uid: 'node-0',
    command: 'start',
    startedAt: Date.now(),
    ...partial,
  };
}

/** Writes a complete, valid record to `host.json`, mode 0600. */
async function writeOwner(partial: Partial<OwnerJson>): Promise<void> {
  await writeFile(join(home, 'host.json'), JSON.stringify(await ownerJson(partial)), {
    mode: 0o600,
  });
}

/** A pid the OS has already reaped, so its liveness probe is a plain miss. */
function reapedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', () => { resolve(child.pid as number); });
  });
}

it('publishes a 0600 record, leaves no tmp, and reads it back live', async () => {
  const h = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  expect((await stat(join(home, 'host.json'))).mode & 0o077).toBe(0);
  expect((await readdir(home)).filter((n) => n.startsWith('.host.'))).toEqual([]);
  const s = await readOwner(home);
  expect(s.kind).toBe('live');
  if (s.kind === 'live') {
    expect(s.record.pid).toBe(process.pid);
    expect(s.record.token).toBe(h.record.token);
  }
  await h.release();
  expect((await readOwner(home)).kind).toBe('absent');
  await h.release(); // idempotent
});

it('refuses a second live owner and leaves the first record intact', async () => {
  const a = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  const before = await readFile(join(home, 'host.json'), 'utf8');
  const err = await acquireOwner(home, { uid: 'node-0', command: 'resume' })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HostAlreadyRunningError);
  expect(String(err)).toMatch(/pid=\d+/);
  expect(String(err)).toMatch(/uid=node-0/);
  expect(await readFile(join(home, 'host.json'), 'utf8')).toBe(before);
  await a.release();
});

it('exactly one of two concurrent acquisitions wins; the winner release removes its record', async () => {
  const [a, b] = await Promise.allSettled([
    acquireOwner(home, { uid: 'node-0', command: 'start' }),
    acquireOwner(home, { uid: 'node-0', command: 'start' }),
  ]);
  const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
  expect(fulfilled).toHaveLength(1);
  const s = await readOwner(home);
  expect(s.kind).toBe('live');
  const winner = (fulfilled[0] as PromiseFulfilledResult<OwnerHandle>).value;
  expect((await readdir(home)).filter((n) => n.startsWith('.host.'))).toEqual([]);
  await winner.release();
  expect((await readOwner(home)).kind).toBe('absent');
});

it('reclaims a dead pid, a reused pid and malformed JSON', async () => {
  const dead = await reapedPid();
  await writeOwner({ pid: dead, startTime: 1 });
  expect((await readOwner(home)).kind).toBe('stale');
  const h = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  await h.release();
  await writeOwner({ pid: process.pid, startTime: (await startOf(process.pid))! + 1 });
  expect((await readOwner(home)).kind).toBe('stale');
  await writeFile(join(home, 'host.json'), '{bad json', { mode: 0o600 });
  expect((await readOwner(home)).kind).toBe('stale');
  const h2 = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  expect((await readOwner(home)).kind).toBe('live');
  expect((await readdir(home)).filter((n) => n.startsWith('.host.'))).toEqual([]);
  await h2.release();
  await mkdir(join(home, 'host.json'));
  await expect(acquireOwner(home, { uid: 'node-0', command: 'start' }))
    .rejects.toBeInstanceOf(HostConfigError);
});

it('treats a null startTime or an unreadable /proc as unverified and refuses to acquire', async () => {
  await writeOwner({ pid: process.pid, startTime: null });
  expect((await readOwner(home)).kind).toBe('unverified');
  await expect(acquireOwner(home, { uid: 'node-0', command: 'start' }))
    .rejects.toBeInstanceOf(HostAlreadyRunningError);
  await writeOwner({ pid: process.pid, startTime: 1 });
  const deps = { startTime: async () => null, alive: () => true };
  expect((await readOwner(home, deps)).kind).toBe('unverified');
});

it('refuses a symlink and a directory at host.json; the link target is untouched', async () => {
  const target = join(home, 'target');
  // The target is a valid, live owner record: if `readOwner` followed the link
  // it would read `live`, so `stale(record: null)` below is the proof that the
  // `lstat` refusal fires before any read.
  const live = JSON.stringify(await ownerJson());
  await writeFile(target, live, { mode: 0o600 });
  await symlink(target, join(home, 'host.json'));
  expect(await readOwner(home)).toEqual({ kind: 'stale', record: null });
  expect(await readFile(target, 'utf8')).toBe(live);
  await rm(join(home, 'host.json'));
  await mkdir(join(home, 'host.json'));
  expect(await readOwner(home)).toEqual({ kind: 'stale', record: null });
});

it('release does not delete another token\'s record', async () => {
  const h = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  const other = { ...h.record, token: 'b'.repeat(32) };
  await writeFile(join(home, 'host.json'), JSON.stringify(other), { mode: 0o600 });
  await h.release();
  expect((await readOwner(home)).kind).toBe('live');
});

it('release refuses a moved non-regular record and leaves its target untouched', async () => {
  const h = await acquireOwner(home, { uid: 'node-0', command: 'start' });
  const target = join(home, 'live-record');
  const live = JSON.stringify(await ownerJson({ token: 'b'.repeat(32) }));
  await writeFile(target, live, { mode: 0o600 });
  await rm(join(home, 'host.json'));
  await symlink(target, join(home, 'host.json'));
  const err = await h.release().catch((e: unknown) => e);
  // Reclaim and release apply the same rule: a record this protocol did not
  // create is moved but never unlinked, and the refusal names the claim.
  expect(err).toBeInstanceOf(HostConfigError);
  expect(String(err)).toMatch(/not a removable regular file/);
  expect(await readFile(target, 'utf8')).toBe(live);
  const claims = (await readdir(home)).filter((n) => n.startsWith('.host.release.'));
  expect(claims).toHaveLength(1);
  const claim = join(home, claims[0] as string);
  expect((await lstat(claim)).isSymbolicLink()).toBe(true);
  // The moved link is the only owner-path record left; `host.json` stays absent
  // until the operator removes the claim, which is the disclosed consequence of
  // refusing rather than unlinking.
  expect((await readOwner(home)).kind).toBe('absent');
  expect(String(err)).toContain(claim);
});

it('delivers SIGTERM and waits for the child to exit', async () => {
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000);"],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  const start = await startOf(child.pid!);
  expect(start).not.toBeNull();
  await writeOwner({ pid: child.pid!, startTime: start });
  const exited = once(child, 'exit');
  expect(await requestPause(home, { timeoutMs: 2000, intervalMs: 25 })).toEqual({ kind: 'exited' });
  const [code] = await exited;
  expect(code).toBe(0);
}, 10_000);

it('reports still-stopping without killing a child that ignores SIGTERM', async () => {
  const child = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000);"],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  const start = await startOf(child.pid!);
  expect(start).not.toBeNull();
  await writeOwner({ pid: child.pid!, startTime: start });
  const out = await requestPause(home, { timeoutMs: 150, intervalMs: 25 });
  expect(out).toEqual({ kind: 'still-stopping', pid: child.pid });
  expect(child.exitCode).toBeNull();
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}, 10_000);

it('refuses an unverified owner and a stale owner without sending a signal', async () => {
  await writeOwner({ pid: process.pid, startTime: null });
  const kill = vi.fn();
  expect(await requestPause(home, { deps: { kill } }))
    .toEqual({ kind: 'no-host', state: 'unverified' });
  const dead = await reapedPid();
  await writeOwner({ pid: dead, startTime: 1 });
  expect(await requestPause(home, { deps: { kill } }))
    .toEqual({ kind: 'no-host', state: 'stale' });
  expect(kill).not.toHaveBeenCalled();
  expect(PAUSE_TIMEOUT_MS).toBe(10_000);
  expect(PAUSE_POLL_MS).toBe(100);
});

it('reads a zombie as dead and a sleeping process as live', async () => {
  const start = await startOf(process.pid);
  expect(start).not.toBeNull();
  await writeOwner({ pid: process.pid, startTime: start });
  expect((await readOwner(home, { state: async () => 'Z' })).kind).toBe('stale');
  expect((await readOwner(home, { state: async () => 'S' })).kind).toBe('live');
});

it('maps kill ESRCH to exited and any other kill failure to HostPauseError', async () => {
  await writeOwner({ pid: process.pid, startTime: await startOf(process.pid) });
  expect(await requestPause(home, {
    timeoutMs: 50,
    intervalMs: 10,
    deps: {
      kill: () => {
        const e = new Error('gone') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      },
    },
  })).toEqual({ kind: 'exited' });
  await expect(requestPause(home, {
    timeoutMs: 50,
    intervalMs: 10,
    deps: {
      kill: () => {
        const e = new Error('denied') as NodeJS.ErrnoException;
        e.code = 'EPERM';
        throw e;
      },
    },
  })).rejects.toBeInstanceOf(HostPauseError);
});
