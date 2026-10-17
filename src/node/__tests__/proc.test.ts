import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pty from '@lydell/node-pty';
import { sessionTtyTarget, stdinWaitPids } from '../tools/proc.js';

/**
 * Real PTYs, real processes: the proof is exercised against live /proc states.
 * Every test disposes its PTY. Positive assertions poll with a deadline —
 * never a fixed wall-clock sleep, so a loaded machine cannot flip a verdict.
 * The syscall table is x86-64's, so the live proof is gated on that arch too.
 */
const proofOnly = it.skipIf(process.platform !== 'linux' || process.arch !== 'x64');
const python = '/usr/bin/python3';
/** The epoll branch's fixture needs CPython; skip cleanly where it is absent. */
const epollOnly = it.skipIf(
  process.platform !== 'linux' || process.arch !== 'x64' || !existsSync(python),
);

function spawnBash(): pty.IPty {
  return pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
    name: 'dumb', cols: 160, rows: 40, cwd: '/tmp',
    env: { TERM: 'dumb', PATH: '/usr/bin:/bin' },
  });
}

/** Poll-with-deadline at a gentle 100 ms: a predicate call can be a full /proc walk, so a hot loop would self-DoS a loaded machine. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  expect(predicate()).toBe(true);
}

/** The frozen tty target: available as soon as node-pty has set up the slave. */
async function frozenTarget(shell: pty.IPty): Promise<string> {
  let target = sessionTtyTarget(shell.pid);
  await waitFor(() => {
    target = sessionTtyTarget(shell.pid);
    return target !== null;
  });
  return target!;
}

/** The current syscall number and a0 of the shell (null when unreadable/running). */
function syscallOf(pid: number): { readonly nr: number; readonly a0: string } | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/task/${pid}/syscall`, 'utf8');
  } catch {
    return null;
  }
  const parts = text.trim().split(' ');
  const nr = Number(parts[0]);
  return Number.isSafeInteger(nr) && parts[1] !== undefined ? { nr, a0: parts[1]! } : null;
}

function fd0Of(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/fd/0`);
  } catch {
    return null;
  }
}

/** /proc/<pid>/stat, split after the LAST ')' so a comm holding spaces or parens cannot shift the fields. */
function statFields(pid: number): { readonly comm: string; readonly pgrp: number; readonly tpgid: number } | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(' ');
  const pgrp = Number(rest[2]);
  const tpgid = Number(rest[5]);
  return Number.isSafeInteger(pgrp) && Number.isSafeInteger(tpgid)
    ? { comm: text.slice(open + 1, close), pgrp, tpgid }
    : null;
}

/** True once a process named `comm` leads the shell's foreground process group (the foreground pgrp's id IS its leader's pid). */
function foregroundLeaderIs(shellPid: number, comm: string): boolean {
  const shellStat = statFields(shellPid);
  if (shellStat === null || shellStat.tpgid === shellStat.pgrp) return false;
  const leader = statFields(shellStat.tpgid);
  return leader !== null && leader.comm === comm;
}

describe('stdinWaitPids', () => {
  proofOnly('flags a shell blocked in the read builtin', async () => {
    const shell = spawnBash();
    try {
      shell.onData(() => {});
      const target = await frozenTarget(shell);
      shell.write('read x\n');
      await waitFor(() => stdinWaitPids(shell.pid, target).includes(shell.pid));
    } finally {
      shell.kill();
    }
  }, 10000);

  proofOnly('flags a foreground child blocked reading the tty', async () => {
    const shell = spawnBash();
    try {
      shell.onData(() => {});
      const target = await frozenTarget(shell);
      shell.write('cat\n');
      await waitFor(() => {
        const pids = stdinWaitPids(shell.pid, target);
        return pids.length > 0 && !pids.includes(shell.pid);
      });
    } finally {
      shell.kill();
    }
  }, 10000);

  epollOnly('flags an epoll_wait that watches fd 0', async () => {
    const shell = spawnBash();
    try {
      shell.onData(() => {});
      const target = await frozenTarget(shell);
      // CPython's select.epoll() blocks in epoll_wait(232) with the epoll fd as
      // a0; its fdinfo lists `tfd: 0` for the registered stdin. The proof's
      // epoll branch is otherwise unreachable from a shell.
      shell.write(`python3 -c 'import select; e=select.epoll(); e.register(0, select.EPOLLIN); e.poll()'\n`);
      await waitFor(() => {
        const pids = stdinWaitPids(shell.pid, target);
        return pids.length > 0 && !pids.includes(shell.pid);
      });
    } finally {
      shell.kill();
    }
  }, 10000);

  proofOnly('does not flag a foreground child that is merely busy', async () => {
    const shell = spawnBash();
    try {
      shell.onData(() => {});
      const target = await frozenTarget(shell);
      shell.write('sleep 30\n');
      // Gate on a positive observable — the sleep leading the foreground pgrp —
      // so a loaded CPU cannot sample the window before the fork; after that
      // the answer is [] and can never flip (sleep blocks in clock_nanosleep,
      // which the proof never lists).
      await waitFor(() => foregroundLeaderIs(shell.pid, 'sleep'));
      expect(stdinWaitPids(shell.pid, target)).toEqual([]);
      shell.write('\x03'); // Ctrl-C releases the sleep
    } finally {
      shell.kill();
    }
  }, 10000);

  proofOnly('does NOT flag a builtin whose stdin is redirected off the tty', async () => {
    const shell = spawnBash();
    try {
      shell.onData(() => {});
      const target = await frozenTarget(shell);
      shell.write('read x < <(sleep 1; echo hi)\n');
      // Gate on the redirect being live: the shell is in read(0), but its fd 0
      // is the process-substitution pipe, not the session's pts. A proof that
      // compared fd 0 with "whatever the shell's fd 0 is now" would lie here
      // (and the next run would kill the still-running command).
      await waitFor(() => syscallOf(shell.pid)?.nr === 0 && fd0Of(shell.pid) !== target);
      expect(fd0Of(shell.pid)).not.toBe(target);
      expect(stdinWaitPids(shell.pid, target)).toEqual([]);
    } finally {
      shell.kill();
    }
  }, 10000);

  proofOnly('does NOT flag an idle shell at its prompt (poll-family wait)', async () => {
    // The prompt wait is `pselect6` — the poll family, deliberately unprovable
    // (arbitration 10); it is covered by the timeout path. Measured on the
    // target machine: syscall 270 with a0 = 1 (nfds — NOT an fd).
    const shell = spawnBash();
    try {
      let seen = '';
      shell.onData((chunk) => { seen += chunk; });
      const target = await frozenTarget(shell);
      // Gate on the prompt having been printed, so the negative assertion is
      // not vacuously true before the shell even starts.
      await waitFor(() => seen.length > 0);
      expect(stdinWaitPids(shell.pid, target)).toEqual([]);
    } finally {
      shell.kill();
    }
  }, 10000);

  it('returns [] for a dead pid and never throws', () => {
    expect(stdinWaitPids(99999999, '/dev/pts/0')).toEqual([]);
    expect(stdinWaitPids(-1, '/dev/pts/0')).toEqual([]);
  });

  it('returns [] without a frozen pts target (nothing is provable)', () => {
    expect(stdinWaitPids(process.pid, null)).toEqual([]);
    expect(stdinWaitPids(process.pid, '/dev/null')).toEqual([]);
  });
});
