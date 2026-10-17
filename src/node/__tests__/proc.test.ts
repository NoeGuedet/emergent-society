import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pty from '@lydell/node-pty';
import { stdinWaitPids } from '../tools/proc.js';

/**
 * Real PTYs, real processes: the proof is exercised against live /proc states.
 * Every test disposes its PTY. Positive assertions poll with a deadline —
 * never a fixed wall-clock sleep, so a loaded machine cannot flip a verdict.
 */
const linuxOnly = it.skipIf(process.platform !== 'linux');

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
  linuxOnly('flags a shell blocked in the read builtin', async () => {
    const shell = spawnBash();
    try {
      shell.onData(() => {});
      shell.write('read x\n');
      await waitFor(() => stdinWaitPids(shell.pid).includes(shell.pid));
    } finally {
      shell.kill();
    }
  }, 10000);

  linuxOnly('flags a foreground child blocked reading the tty', async () => {
    const shell = spawnBash();
    try {
      shell.onData(() => {});
      shell.write('cat\n');
      await waitFor(() => {
        const pids = stdinWaitPids(shell.pid);
        return pids.length > 0 && !pids.includes(shell.pid);
      });
    } finally {
      shell.kill();
    }
  }, 10000);

  linuxOnly('does not flag a foreground child that is merely busy', async () => {
    const shell = spawnBash();
    try {
      shell.onData(() => {});
      shell.write('sleep 30\n');
      // Gate on a positive observable — the sleep leading the foreground pgrp —
      // so a loaded CPU cannot sample the window before the fork; after that
      // the answer is [] and can never flip (sleep blocks in clock_nanosleep,
      // which the proof never lists).
      await waitFor(() => foregroundLeaderIs(shell.pid, 'sleep'));
      expect(stdinWaitPids(shell.pid)).toEqual([]);
      shell.write('\x03'); // Ctrl-C releases the sleep
    } finally {
      shell.kill();
    }
  }, 10000);

  linuxOnly('does NOT flag an idle shell at its prompt (poll-family wait)', async () => {
    // The prompt wait is `pselect6` — the poll family, deliberately unprovable
    // (arbitration 10); it is covered by the timeout path. Measured on the
    // target machine: syscall 270 with a0 = 1 (nfds — NOT an fd).
    const shell = spawnBash();
    try {
      let seen = '';
      shell.onData((chunk) => { seen += chunk; });
      // Gate on the prompt having been printed, so the negative assertion is
      // not vacuously true before the shell even starts.
      await waitFor(() => seen.length > 0);
      expect(stdinWaitPids(shell.pid)).toEqual([]);
    } finally {
      shell.kill();
    }
  }, 10000);

  linuxOnly('returns [] for a dead pid and never throws', () => {
    expect(stdinWaitPids(99999999)).toEqual([]);
    expect(stdinWaitPids(-1)).toEqual([]);
  });
});
