import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

/**
 * The Linux /proc proof that a session's foreground process group waits on
 * tty stdin (C1.4b). A PTY stream cannot say "the command waits for input" —
 * only the process table can. The proof is conservative by construction: it
 * covers `read`/`splice` on fd 0 and `epoll_wait` watching fd 0, bound to the
 * session's own tty; poll-family waits (their fd sets live in kernel memory
 * — a `/proc/<pid>/mem` read would race the live blocked task) and /dev/tty
 * re-openers (sudo) are unprovable here and return
 * false, so a missed proof costs a timeout, never a false positive. Every
 * read is best-effort: a racing exit or an unexpected shape yields no flag.
 *
 * The syscall table is x86-64's: on any other architecture the numbers mean
 * different calls, so the proof answers "not provable" rather than guessing
 * (a wrong `read` number would silently disable detection, and a wrong epoll
 * number could misread another call). The session's tty target is frozen by
 * `sessionTtyTarget` while the shell is still at its prompt and every
 * candidate's fd 0 must resolve to that exact pts path: a builtin with a
 * redirected stdin (`read x < <(…)`) is NOT waiting on the session's tty, and
 * calling it a stdin_read would make the next run kill a live command.
 * Off Linux (or off x86-64) the answer is always "not provable" ([]).
 */

type ProcStat = {
  readonly session: number; readonly pgrp: number; readonly ttyNr: number; readonly tpgid: number;
};

/**
 * x86-64 syscall numbers: read and splice take the fd as a0. (`readv`, 19,
 * would qualify too; shells essentially never use it on the tty, so the
 * timeout path covers it — a missed proof is conservative.)
 */
const FD0_SYSCALLS = new Set([0, 275]);
/**
 * x86-64 epoll_wait/epoll_pwait: the watched fds live in the epoll fd's fdinfo.
 * (`epoll_pwait2`, 441, is deliberately not listed: a missed proof is
 * conservative — it costs a timeout, never a false positive.)
 */
const EPOLL_SYSCALLS = new Set([232, 281]);

function readStat(pid: number): ProcStat | null {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = text.lastIndexOf(')');
  if (close === -1) return null;
  const rest = text.slice(close + 2).split(' ');
  // Fields after comm: 3 state, 4 ppid, 5 pgrp, 6 session, 7 tty_nr, 8 tpgid.
  const pgrp = Number(rest[2]);
  const session = Number(rest[3]);
  const ttyNr = Number(rest[4]);
  const tpgid = Number(rest[5]);
  if (!Number.isSafeInteger(pgrp) || !Number.isSafeInteger(session)
    || !Number.isSafeInteger(ttyNr) || !Number.isSafeInteger(tpgid)) {
    return null;
  }
  return { session, pgrp, ttyNr, tpgid };
}

/** The epoll instance `fd` of `pid` watches fd 0 iff its fdinfo lists `tfd: 0`. */
function epollWatchesStdin(pid: number, fd: string): boolean {
  let info: string;
  try {
    info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
  } catch {
    return false;
  }
  return /^tfd:\s+0\s/m.test(info);
}

function waitsOnTtyStdin(pid: number, ttyTarget: string): boolean {
  let fd0: string;
  try {
    fd0 = readlinkSync(`/proc/${pid}/fd/0`);
  } catch {
    return false;
  }
  // The candidate's stdin must be the session's own pts — not merely equal to
  // whatever the shell's fd 0 is right now (which a redirected builtin changes).
  if (fd0 !== ttyTarget) return false;
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return false;
  }
  for (const tid of tasks) {
    let sys: string;
    try {
      sys = readFileSync(`/proc/${pid}/task/${tid}/syscall`, 'utf8');
    } catch {
      continue;
    }
    const parts = sys.trim().split(' ');
    const nr = Number(parts[0]);
    if (!Number.isSafeInteger(nr)) continue;
    if (FD0_SYSCALLS.has(nr) && parts[1] === '0x0') return true;
    if (EPOLL_SYSCALLS.has(nr)) {
      // Only the epoll instance actually being waited on (a0) counts — any
      // other eventpoll fd the process merely owns is irrelevant.
      const epfd = Number(parts[1]);
      if (!Number.isSafeInteger(epfd)) continue;
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${epfd}`);
      } catch {
        continue;
      }
      if (target === 'anon_inode:[eventpoll]' && epollWatchesStdin(pid, String(epfd))) return true;
    }
  }
  return false;
}

/**
 * The `/dev/pts/<minor>` path a Linux `tty_nr` names, or null for any other
 * device kind (or no tty at all). pts devices have major 136; the dev_t minor
 * is split across the low and high halves of the encoded number.
 */
function ptsTarget(ttyNr: number): string | null {
  const major = (ttyNr >> 8) & 0xfff;
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
  return major === 136 ? `/dev/pts/${minor}` : null;
}

/**
 * The pts path fd 0 of `pid` resolves to, or null when it is not a pts device
 * (a pipe, a file, a dead process), not the child's own controlling terminal,
 * or not readable. The caller freezes the returned path while the shell is
 * idle: the proof is about the session's tty, not about whatever a later
 * redirection temporarily puts on fd 0.
 *
 * `forkpty` returns before the child's `login_tty`, so an immediate read can
 * still see the spawner's inherited session, ctty and fd 0 — and that pair
 * agrees with itself, so matching fd 0 against tty_nr alone would freeze the
 * PARENT's pts. `login_tty` calls `setsid` and then `TIOCSCTTY`: requiring the
 * pid to lead its own session proves the tty_nr is the freshly acquired slave,
 * not the inherited one. (Before `setsid` the session is the spawner's; between
 * `setsid` and `TIOCSCTTY` tty_nr is 0; between `TIOCSCTTY` and the fd dup,
 * fd 0 still names the inherited tty.)
 */
export function sessionTtyTarget(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readStat(pid);
    if (stat === null || stat.session !== pid) return null;
    const own = ptsTarget(stat.ttyNr);
    if (own === null) return null;
    return readlinkSync(`/proc/${pid}/fd/0`) === own ? own : null;
  } catch {
    return null;
  }
}

/**
 * The pids of `shellPid`'s foreground process group blocked reading the
 * session's tty, or [] when none — or when anything cannot be read. `ttyTarget`
 * is the path frozen by `sessionTtyTarget`; without it nothing is provable. An
 * idle shell at its prompt is NOT flagged: it waits in `pselect6` (the poll
 * family, unprovable by design), which is exactly why no gating is needed
 * against the prompt state — it is invisible to this proof.
 */
export function stdinWaitPids(shellPid: number, ttyTarget: string | null): number[] {
  if (process.platform !== 'linux' || process.arch !== 'x64') return [];
  if (ttyTarget === null || !ttyTarget.startsWith('/dev/pts/')) return [];
  try {
    const shell = readStat(shellPid);
    if (shell === null || shell.tpgid <= 0 || shell.ttyNr === 0) return [];
    const hits: number[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === 0) continue;
      const stat = readStat(pid);
      if (stat === null || stat.pgrp !== shell.tpgid || stat.ttyNr !== shell.ttyNr) continue;
      if (waitsOnTtyStdin(pid, ttyTarget)) hits.push(pid);
    }
    return hits;
  } catch {
    return [];
  }
}
