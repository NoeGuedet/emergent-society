import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { nodeLayout } from '../../journal/layout.js';
import { buildSandboxSpec, type SandboxSpec } from '../tools/sandbox.js';
import { DEFAULT_TERMINAL_ENV, PtyTerminalRuntime } from '../tools/terminal.js';
import type { CommandLimits, CommandOutcome, TerminalRuntime } from '../tools/terminal.js';

/**
 * The confinement battery (C1.4c): real confined sessions through
 * `PtyTerminalRuntime` behind the real Landlock launcher, over a real spec —
 * a tmp home and world, and a canary credential store at
 * `<home>/providers.json`. Four faces, each a non-vacuous assertion:
 *
 * - the credential guarantee: the canary's *content* is unreadable and
 *   unwritable from raw bash, including the escape shapes, while the
 *   unconfined kernel still reads it;
 * - the out-of-worktree paths: the world's git dir (`<root>/world.git`, next
 *   to the worktree) and the node's journal (`<home>/nodes/<uid>`) are EACCES
 *   for read and write, by relative and absolute path — never ENOENT;
 * - the world stays usable: file operations, executable scripts, large
 *   heredocs against the scratch `TMPDIR`, the system toolchain, `/proc`,
 *   the ptrace face and the granted devices all work;
 * - the boundary edges: signal scoping, `/tmp` and `/dev/pts` denials, reset
 *   resilience, and the honest residual that metadata mutations
 *   (`stat`/`chmod`) still succeed — arbitration 13.
 *
 * Every test asserts statuses and bytes, never wall-clock timings; command
 * timeouts stay ≥ 300 ms and every test carries an explicit vitest timeout.
 * The vitest globalSetup builds the launcher, so a full run always has it; a
 * direct run without it skips loudly instead of failing.
 */

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const launcherBinary = join(projectRoot, 'native', 'es-landlock', 'es-landlock');
const launcherPresent = existsSync(launcherBinary);
const TEST_TIMEOUT_MS = 20_000;
/** Unique enough that no output can contain it by accident. */
const CANARY = 'ES_C14C_CANARY_9c1f4a7b2e';
/** A marker in the world git dir's config: its bytes must never reach the shell. */
const GIT_CANARY = 'ES_C14C_GIT_CANARY_5d8e2f1a';
/** A marker in the node's journal log: its bytes must never reach the shell. */
const JOURNAL_CANARY = 'ES_C14C_JOURNAL_CANARY_2b7c4d9e';
/** The uid `confined()` builds the spec for; the journal is addressed through it. */
const NODE_UID = 'node-a';

if (!launcherPresent) {
  console.warn(
    '[sandbox-confinement] native/es-landlock/es-landlock is absent: skipping the '
      + 'confinement battery. Run `npm run build:native` (npm test builds it in globalSetup).',
  );
}

let root = '';
let home = '';
let world = '';
let canaryPath = '';
/** `<root>/world.git` — the world's git dir, outside the worktree (helpers.ts layout). */
let worldGit = '';
/** `<home>/nodes/<uid>` and the log inside it, as the journal layer lays them out. */
let journalDir = '';
let journalFile = '';
let runtimes: TerminalRuntime[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'c14c-confinement-'));
  home = join(root, 'home');
  world = join(root, 'world');
  await mkdir(home);
  await mkdir(world);
  canaryPath = join(home, 'providers.json');
  await writeFile(canaryPath, `${CANARY}\n`, { mode: 0o644 });
  // The umask can only clear bits from `writeFile`'s mode; pin the literal mode
  // the residual test asserts, independent of the caller's environment.
  await chmod(canaryPath, 0o644);

  // The world's git dir lives NEXT TO the worktree, not inside it (the layout
  // `useWorld` pins in helpers.ts). It is written by hand rather than
  // initialized as a repo: a `.git` inside the world would make `git status`
  // succeed and void the "not a git repository" assertion below.
  worldGit = join(root, 'world.git');
  await mkdir(worldGit);
  await writeFile(join(worldGit, 'HEAD'), 'ref: refs/heads/main\n', { mode: 0o644 });
  await writeFile(
    join(worldGit, 'config'),
    `[core]\n\trepositoryformatversion = 0\n# ${GIT_CANARY}\n`,
    { mode: 0o644 },
  );

  // The journal's real on-disk layout, written from the kernel side with the
  // modes the journal layer creates (0700/0600): no turn runs in this suite, so
  // the fixture supplies the log the battery attacks.
  const layout = nodeLayout(home, NODE_UID);
  journalDir = layout.dir;
  await mkdir(journalDir, { recursive: true, mode: 0o700 });
  await chmod(journalDir, 0o700);
  journalFile = join(layout.dir, layout.logFile);
  await writeFile(journalFile, `${JOURNAL_CANARY}\n`, { mode: 0o600 });
  await chmod(journalFile, 0o600);

  runtimes = [];
});

afterEach(async () => {
  for (const rt of runtimes) await rt.dispose(100);
  // Defensive: the `/tmp` denial test must prove itself without leaving
  // anything behind even if the confinement were somehow absent.
  await rm('/tmp/es-c14c-x', { force: true });
  await rm(root, { recursive: true, force: true });
});

function limits(over: Partial<CommandLimits> = {}): CommandLimits {
  return { timeoutMs: 5000, killGraceMs: 100, maxCaptureBytes: 8 * 1024 * 1024, ...over };
}

function text(outcome: CommandOutcome): string {
  return Buffer.from(outcome.output).toString('utf8');
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** A process's exec-time environ (NUL-separated), or null when it is gone. */
async function environOf(pid: number): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return null;
  }
}

/** The real policy (default launcher), a runtime whose cwd is the world. */
async function confined(): Promise<{ rt: PtyTerminalRuntime; spec: SandboxSpec }> {
  const spec = await buildSandboxSpec({ world, home, uid: NODE_UID });
  const rt = new PtyTerminalRuntime(world, DEFAULT_TERMINAL_ENV, spec);
  runtimes.push(rt);
  return { rt, spec };
}

describe('the credential guarantee', () => {
  it.skipIf(!launcherPresent)(
    'denies reading the canary by relative and absolute path and never leaks its bytes',
    async () => {
      const { rt } = await confined();
      const outcome = await rt.run(
        'cat ../home/providers.json; echo "relative-status:$?"; '
          + `cat '${canaryPath}'; echo "absolute-status:$?"`,
        limits(), signal(),
      );
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      // Two denials, one per path shape; neither operation may succeed.
      expect(out.match(/Permission denied/g)?.length).toBe(2);
      expect(out).toMatch(/relative-status:[1-9]\d*/);
      expect(out).toMatch(/absolute-status:[1-9]\d*/);
      // The guarantee is about content: the bytes never reach the shell.
      expect(out).not.toContain(CANARY);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'denies appending to and truncating the canary, leaving it byte-identical',
    async () => {
      const { rt } = await confined();
      const before = await readFile(canaryPath);
      const outcome = await rt.run(
        `echo x >> '${canaryPath}'; echo "append-status:$?"; `
          + `: > '${canaryPath}'; echo "truncate-status:$?"`,
        limits(), signal(),
      );
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      expect(out.match(/Permission denied/g)?.length).toBe(2);
      expect(out).toMatch(/append-status:[1-9]\d*/);
      expect(out).toMatch(/truncate-status:[1-9]\d*/);
      // Read from the unconfined test process: the write paths never landed.
      const after = await readFile(canaryPath);
      expect(after.equals(before)).toBe(true);
      expect(after.toString('utf8')).toBe(`${CANARY}\n`);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'denies the escape shapes: a world symlink, /proc/self/root and a nested bash',
    async () => {
      // A world symlink whose target is outside every grant.
      await symlink(canaryPath, join(world, 'canary-link'));
      const { rt } = await confined();
      const outcome = await rt.run(
        'cat canary-link; echo "symlink-status:$?"; '
          + `cat /proc/self/root${canaryPath}; echo "procroot-status:$?"; `
          + `bash -c "echo nested-ran; cat '${canaryPath}'"; echo "nested-status:$?"`,
        limits(), signal(),
      );
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      // The nested bash really executed: its denial is not a dead command.
      expect(out).toContain('nested-ran');
      expect(out.match(/Permission denied/g)?.length).toBe(3);
      expect(out).toMatch(/symlink-status:[1-9]\d*/);
      expect(out).toMatch(/procroot-status:[1-9]\d*/);
      expect(out).toMatch(/nested-status:[1-9]\d*/);
      expect(out).not.toContain(CANARY);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'leaves the kernel side untouched: the canary is readable outside and the status is full',
    async () => {
      const { rt } = await confined();
      // Before any run the ABI is unknown — never "off".
      expect(rt.sandboxStatus()).toBeNull();
      const outcome = await rt.run('true', limits(), signal());
      expect(outcome).toMatchObject({ status: 'completed', exitCode: 0 });
      const status = rt.sandboxStatus();
      expect(status).toMatchObject({ mode: 'landlock', enforcement: 'full' });
      if (status?.mode === 'landlock') expect(status.abi).toBeGreaterThanOrEqual(3);
      expect(await readFile(canaryPath, 'utf8')).toBe(`${CANARY}\n`);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the out-of-worktree paths', () => {
  it.skipIf(!launcherPresent)(
    'denies the world git dir by relative and absolute path, for reads and writes',
    async () => {
      // Outside control: the git dir's files exist and are readable from the
      // unconfined kernel, so every denial below is EACCES, never ENOENT.
      const headPath = join(worldGit, 'HEAD');
      const configPath = join(worldGit, 'config');
      expect(await readFile(headPath, 'utf8')).toBe('ref: refs/heads/main\n');
      const configBefore = await readFile(configPath);
      const { rt } = await confined();
      const outcome = await rt.run(
        'cat ../world.git/HEAD; echo "git-relative-read:$?"; '
          + `cat '${headPath}'; echo "git-absolute-read:$?"; `
          // The canary-bearing config is read too: the read must fail, and the
          // marker's absence below is then a real statement about the denial
          // rather than about a file nothing tried to read.
          + `cat '${configPath}'; echo "git-config-read:$?"; `
          // Metadata is unmediated (arbitration 13): the stat succeeding on the
          // very file the read could not open is what proves EACCES, not ENOENT.
          + `stat -c 'git-head-size:%s' '${headPath}'; echo "git-stat:$?"; `
          + `echo x >> '${configPath}'; echo "git-append:$?"; `
          + `printf 'planted\\n' > '${join(worldGit, 'planted')}'; echo "git-create:$?"; `
          + `ls '${worldGit}'; echo "git-ls:$?"`,
        limits(), signal(),
      );
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      // Reads: both path shapes are refused with EACCES.
      expect(out).toContain('cat: ../world.git/HEAD: Permission denied');
      expect(out).toContain(`cat: ${headPath}: Permission denied`);
      expect(out).toContain(`cat: ${configPath}: Permission denied`);
      expect(out).toMatch(/git-relative-read:[1-9]\d*/);
      expect(out).toMatch(/git-absolute-read:[1-9]\d*/);
      expect(out).toMatch(/git-config-read:[1-9]\d*/);
      expect(out).toMatch(/git-head-size:\d+/);
      expect(out).toMatch(/git-stat:0/);
      // Writes: appending to a config, creating an entry, and listing the dir.
      expect(out).toContain(`cannot open directory '${worldGit}'`);
      expect(out).toMatch(/git-append:[1-9]\d*/);
      expect(out).toMatch(/git-create:[1-9]\d*/);
      expect(out).toMatch(/git-ls:[1-9]\d*/);
      expect(out.match(/Permission denied/g)?.length).toBe(6);
      // Non-vacuous: nothing landed, and no config byte reached the shell.
      await expect(stat(join(worldGit, 'planted'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(configPath)).equals(configBefore)).toBe(true);
      expect(out).not.toContain(GIT_CANARY);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'denies a world symlink that names the git dir, for reads and writes',
    async () => {
      // The link itself lives inside the granted world, but the rule binds to
      // the resolved object: following it must be EACCES, not permission
      // inherited from the link's location.
      await symlink(worldGit, join(world, 'git-link'));
      const configBefore = await readFile(join(worldGit, 'config'));
      const { rt } = await confined();
      const outcome = await rt.run(
        'cat git-link/config; echo "git-link-read:$?"; '
          + 'echo x >> git-link/config; echo "git-link-append:$?"',
        limits(), signal(),
      );
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      expect(out).toContain('cat: git-link/config: Permission denied');
      expect(out.match(/Permission denied/g)?.length).toBe(2);
      expect(out).toMatch(/git-link-read:[1-9]\d*/);
      expect(out).toMatch(/git-link-append:[1-9]\d*/);
      // Non-vacuous: the append never landed and no config byte leaked.
      expect((await readFile(join(worldGit, 'config'))).equals(configBefore)).toBe(true);
      expect(out).not.toContain(GIT_CANARY);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'denies the node journal directory and log, for reads and writes',
    async () => {
      // Outside control: the log exists at the journal layer's own path and is
      // readable here — the bytes below are there to leak.
      expect(await readFile(journalFile, 'utf8')).toBe(`${JOURNAL_CANARY}\n`);
      const journalBefore = await readFile(journalFile);
      const { rt } = await confined();
      const outcome = await rt.run(
        `ls '${journalDir}'; echo "journal-ls:$?"; `
          + `ls ../home/nodes/${NODE_UID}; echo "journal-relative-ls:$?"; `
          + `cat '${journalFile}'; echo "journal-read:$?"; `
          + `stat -c 'journal-size:%s' '${journalFile}'; echo "journal-stat:$?"; `
          + `printf 'planted\\n' > '${join(journalDir, 'planted')}'; echo "journal-create:$?"; `
          + `: > '${journalFile}'; echo "journal-truncate:$?"`,
        limits(), signal(),
      );
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      // The directory cannot even be listed (READ_DIR denied), by either shape.
      expect(out).toContain(`cannot open directory '${journalDir}': Permission denied`);
      expect(out).toContain(
        `cannot open directory '../home/nodes/${NODE_UID}': Permission denied`);
      expect(out).toMatch(/journal-ls:[1-9]\d*/);
      expect(out).toMatch(/journal-relative-ls:[1-9]\d*/);
      // The log itself: the read is EACCES, and the stat proves it exists.
      expect(out).toContain(`cat: ${journalFile}: Permission denied`);
      expect(out).toMatch(/journal-read:[1-9]\d*/);
      expect(out).toMatch(/journal-size:\d+/);
      expect(out).toMatch(/journal-stat:0/);
      // Writes: a new entry in the directory, a truncation of the log.
      expect(out).toMatch(/journal-create:[1-9]\d*/);
      expect(out).toMatch(/journal-truncate:[1-9]\d*/);
      expect(out.match(/Permission denied/g)?.length).toBe(5);
      // Non-vacuous: the log is byte-identical and no journal byte leaked.
      await expect(stat(join(journalDir, 'planted'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readFile(journalFile)).equals(journalBefore)).toBe(true);
      expect(out).not.toContain(JOURNAL_CANARY);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the world stays usable', () => {
  it.skipIf(!launcherPresent)(
    'supports file operations everywhere in the world, including an executable script',
    async () => {
      const { rt } = await confined();
      const outcome = await rt.run([
        "printf 'one\\n' > world-file.txt",
        "printf 'two\\n' >> world-file.txt",
        'mkdir subdir',
        "printf '#!/bin/sh\\necho script-ran\\n' > run-me.sh",
        'chmod +x run-me.sh',
        './run-me.sh',
        'mv world-file.txt renamed.txt',
        'cat renamed.txt',
        'rm renamed.txt',
        'rmdir subdir',
        'test ! -e renamed.txt && test ! -d subdir && echo world-ops-ok',
      ].join(' && '), limits(), signal());
      expect(outcome).toMatchObject({ status: 'completed', exitCode: 0 });
      const out = text(outcome);
      // Write + append + rename + read-back all landed, the script executed.
      expect(out).toMatch(/one\r?\ntwo\r?\n/);
      expect(out).toContain('script-ran');
      expect(out).toContain('world-ops-ok');
      expect(out).not.toContain('Permission denied');
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'stages a large heredoc through the scratch TMPDIR and owns HOME',
    async () => {
      const { rt, spec } = await confined();
      // 100 lines × 700 chars = 70 000 bytes of body plus 100 newlines: past
      // bash's pipe buffer, so the heredoc is spilled to a file in $TMPDIR.
      const body = `${'a'.repeat(700)}\n`.repeat(100);
      const outcome = await rt.run(
        `cat <<'ES_C14C_BIG' > big.txt\n${body}ES_C14C_BIG\n`
          + `wc -c < big.txt\nprintf 'tmpdir:%s\\n' "$TMPDIR"`,
        // A load-proofing watchdog, not a behavior expectation: the confined
        // PTY can stall past the idle ~160 ms under full-suite parallel load.
        limits({ timeoutMs: 60_000 }), signal(),
      );
      expect(outcome).toMatchObject({ status: 'completed', exitCode: 0 });
      expect(text(outcome)).toMatch(/70100/);
      // The spill landed in the scratch leaf, not in an inherited TMPDIR.
      expect(text(outcome)).toContain(`tmpdir:${spec.env.TMPDIR}`);
      // The bytes are really on disk in the world, not silently dropped.
      const info = await stat(join(world, 'big.txt'));
      expect(info.size).toBe(70_100);
      const homeOutcome = await rt.run('printenv HOME', limits(), signal());
      expect(homeOutcome).toMatchObject({ status: 'completed', exitCode: 0 });
      expect(text(homeOutcome)).toContain(spec.env.HOME);
    },
    90_000,
  );

  it.skipIf(!launcherPresent)(
    'runs seq, grep, uname, id, git --version, and git status says not a repository',
    async () => {
      const { rt } = await confined();
      const outcome = await rt.run(
        'seq 1 3; '
          + 'printf "grep-count:%s\\n" "$(printf \'needle\\n\' | grep -c needle)"; '
          + 'uname -a; '
          + 'echo "id:$(id -un)"; '
          + 'git --version; '
          + 'git status 2>&1; echo "git-status:$?"',
        limits(), signal(),
      );
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      expect(out).toMatch(/1\r?\n2\r?\n3/);
      expect(out).toContain('grep-count:1');
      expect(out).toMatch(/Linux /);
      expect(out).toContain(`id:${userInfo().username}`);
      expect(out).toMatch(/git version \d+\.\d+/);
      // Arbitration 1: the world's history is not discoverable from the shell.
      expect(out).toMatch(/not a git repository/);
      expect(out).toMatch(/git-status:[1-9]\d*/);
      // The narrow /etc set suffices: git does not fail on a missing config.
      expect(out).not.toContain('Permission denied');
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'reads /proc through ps and completes a process-substitution read',
    async () => {
      const { rt } = await confined();
      const outcome = await rt.run(
        'echo "self:$$"; ps -p $$ -o pid=,comm=; '
          + `ps -o pid= -p ${process.pid}; `
          + 'read x < <(sleep 1; echo hi); echo "got:$x"',
        limits(), signal(),
      );
      expect(outcome).toMatchObject({ status: 'completed', exitCode: 0 });
      const out = text(outcome);
      const self = /self:(\d+)/.exec(out);
      if (self === null) throw new Error('the shell pid marker is missing');
      // `ps` reads its own domain's /proc freely and names the shell. The pid
      // column is right-justified to the widest pid, so a 7-digit pid fills it
      // and carries no leading space — match the row, not a fixed padding.
      expect(out).toMatch(new RegExp(`^\\s*${self[1]}\\s+bash\\s*$`, 'm'));
      expect(out).toMatch(/bash/);
      // Another process's cmdline/stat stay world-readable (the documented
      // residual); the pid is listed even though its environ is not.
      expect(out).toContain(String(process.pid));
      expect(out).toContain('got:hi');
      expect(out).not.toContain('Permission denied');
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'denies /proc/<outside>/environ and fd/0 but keeps /proc/<outside>/stat readable',
    async () => {
      // /proc/<pid>/environ is fixed at exec time, so a runtime `process.env`
      // write never appears there. The sentinel instead rides the exec
      // environment of a plainly spawned sibling — outside the shell's
      // Landlock domain, and readable by this unconfined test process, which
      // is the control proving the bytes are there to leak.
      const sentinel = 'ES_C14C_ENV_SENTINEL_4f1c9a';
      const sibling = spawn('sleep', ['30'], {
        env: { ...process.env, ES_C14C_ENV_SENTINEL: sentinel },
        stdio: 'ignore',
      });
      const pid = sibling.pid;
      if (pid === undefined) throw new Error('could not spawn the sentinel sibling');
      try {
        // Unconfined control: the sentinel IS in the outside environ. Retry
        // the read: on Linux the fork/exec window can still expose the
        // parent's environ, so a single read may momentarily miss it.
        await vi.waitFor(async () => {
          const control = await environOf(pid);
          expect(control).not.toBeNull();
          expect(control).toContain(sentinel);
        }, { timeout: 15_000 });

        const { rt } = await confined();
        const outcome = await rt.run(
          `test -L /proc/${pid}/fd/0 && echo fd0-present; `
            + `cat /proc/${pid}/environ; echo "environ-status:$?"; `
            + `r=$(readlink -v /proc/${pid}/fd/0 2>&1); s=$?; `
            + `printf 'readlink:[%s] readlink-status:%s\\n' "$r" "$s"; `
            + `printf 'stat-first:%s\\n' "$(cut -d' ' -f1 /proc/${pid}/stat)"`,
          limits(), signal(),
        );
        expect(outcome.status).toBe('completed');
        const out = text(outcome);
        // Metadata is unmediated: the fd link exists, so the denial below
        // cannot be ENOENT (a closed/absent fd 0 would fail this control).
        expect(out).toContain('fd0-present');
        expect(out).toMatch(/environ-status:[1-9]\d*/);
        // The environ denial itself is EACCES on the environ path.
        expect(out).toMatch(new RegExp(`cat: /proc/${pid}/environ: Permission denied`));
        // uutils readlink is silent by default; -v names the errno, proving
        // EACCES rather than any other readlink failure.
        expect(out).toMatch(
          /readlink:\[readlink: \/proc\/\d+\/fd\/0: Permission denied\] readlink-status:[1-9]\d*/,
        );
        // Non-vacuous: the denied environ demonstrably carries this sentinel.
        expect(out).not.toContain(sentinel);
        // The residual: stat is world-readable across domains.
        expect(out).toContain(`stat-first:${pid}`);
      } finally {
        sibling.kill('SIGKILL');
        if (sibling.exitCode === null && sibling.signalCode === null) {
          await new Promise<void>((resolve) => {
            sibling.once('exit', () => resolve());
          });
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'grants exactly the devices: /dev/null, /dev/zero, /dev/urandom and the inherited tty',
    async () => {
      const { rt } = await confined();
      const outcome = await rt.run(
        'echo hi > /dev/null && echo devnull-ok; '
          + 'printf "zero:%s\\n" "$(head -c 1 /dev/zero | wc -c)"; '
          + 'printf "random:%s\\n" "$(head -c 1 /dev/urandom | wc -c)"; '
          + 'stty -a > /dev/null && echo stty-ok; '
          + 'ls /dev/pts 2>&1; echo "pts-status:$?"',
        limits(), signal(),
      );
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      expect(out).toContain('devnull-ok');
      expect(out).toContain('zero:1');
      expect(out).toContain('random:1');
      expect(out).toContain('stty-ok');
      // /dev/pts is deliberately never granted (cross-terminal injection).
      expect(out).toContain('Permission denied');
      expect(out).toMatch(/pts-status:[1-9]\d*/);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the boundary edges', () => {
  it.skipIf(!launcherPresent)(
    'scopes signals: an outside pid is EPERM while its own tree is signalable',
    async () => {
      const { rt } = await confined();
      const outcome = await rt.run(
        `kill -0 ${process.pid}; echo "outside-status:$?"; `
          + 'sleep 5 & p=$!; kill "$p"; echo "own-status:$?"; '
          + 'wait "$p" 2>/dev/null; echo own-tree-ok',
        limits(), signal(),
      );
      expect(outcome).toMatchObject({ status: 'completed', exitCode: 0 });
      const out = text(outcome);
      expect(out.match(/Operation not permitted/g)?.length).toBe(1);
      expect(out).toMatch(/outside-status:[1-9]\d*/);
      expect(out).toContain('own-status:0');
      expect(out).toContain('own-tree-ok');
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'denies writes to /tmp',
    async () => {
      const { rt } = await confined();
      const outcome = await rt.run(
        'touch /tmp/es-c14c-x; echo "tmp-status:$?"', limits(), signal());
      expect(outcome.status).toBe('completed');
      const out = text(outcome);
      expect(out).toContain('Permission denied');
      expect(out).toMatch(/tmp-status:[1-9]\d*/);
      // Cleanup from the unconfined side, defensive: nothing was created.
      await rm('/tmp/es-c14c-x', { force: true });
      await expect(stat('/tmp/es-c14c-x')).rejects.toMatchObject({ code: 'ENOENT' });
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!launcherPresent)(
    'stays confined after a denied command and a stdin-wedge reset',
    async () => {
      const { rt } = await confined();
      const denied = await rt.run(`cat '${canaryPath}'`, limits(), signal());
      expect(denied.status).toBe('completed');
      expect(denied.exitCode).not.toBe(0);
      const wedged = await rt.run('read x', limits(), signal());
      expect(wedged).toMatchObject({ status: 'stdin_read', reset: false });
      // The wedge reset spawns a fresh session; it must be confined too.
      const after = await rt.run(`cat '${canaryPath}'`, limits(), signal());
      expect(after).toMatchObject({ status: 'completed', fresh: 'stdin-wedge' });
      expect(after.exitCode).not.toBe(0);
      expect(text(after)).toContain('Permission denied');
      expect(text(after)).not.toContain(CANARY);
    },
    30_000,
  );

  it.skipIf(!launcherPresent)(
    'pins the honest residual: stat and chmod on the canary succeed',
    async () => {
      const { rt } = await confined();
      const outcome = await rt.run(
        `stat -c '%n %a' '${canaryPath}'; echo "stat-status:$?"; `
          + `chmod 600 '${canaryPath}'; echo "chmod-status:$?"`,
        limits(), signal(),
      );
      expect(outcome).toMatchObject({ status: 'completed', exitCode: 0 });
      const out = text(outcome);
      expect(out).toContain(`${canaryPath} 644`);
      expect(out).toMatch(/stat-status:0/);
      expect(out).toMatch(/chmod-status:0/);
      // Non-vacuous: the metadata mutation really landed, then is restored.
      expect((await stat(canaryPath)).mode & 0o777).toBe(0o600);
      await chmod(canaryPath, 0o644);
      expect((await stat(canaryPath)).mode & 0o777).toBe(0o644);
    },
    TEST_TIMEOUT_MS,
  );
});
