import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import {
  lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachCell, bootHygiene, cellHash, cellRootUnder, cellUnitName,
  cgroupCapabilities, detectLaunchMode, enableControllers, ensureLeaf, freezeSet,
  killLeaves, launchModeFromCgroup, limitLeaf, listLeaves, nodeLeaf, resolveAnchor,
  runLeaf, svcDir,
} from '../cgroups.js';

/**
 * The two independent capability classes, per the delegation contract — each
 * skip signature is probed separately, never one "no cgroup" flag:
 *  - freeze/kill: cgroup2 mount + a writable user-owned child + freeze/kill/events;
 *  - limits: `memory.max`/`pids.max` present in a child (a delegated parent).
 */
const anchor = resolveAnchor();

async function writableChild(): Promise<string | null> {
  if (anchor === null) return null;
  const probe = join(anchor, `.test-${process.pid}-${Date.now().toString(36)}`);
  try {
    await mkdir(probe);
    await writeFile(join(probe, 'cgroup.freeze'), '0');
    // Presence only: cgroup.kill accepts only `1`, so writing `0` would EINVAL.
    await lstat(join(probe, 'cgroup.kill'));
    await readFile(join(probe, 'cgroup.events'), 'utf8');
    return probe;
  } catch {
    await rmdir(probe).catch(() => {});
    return null;
  }
}

async function probeLimits(): Promise<boolean> {
  const probe = await writableChild();
  if (probe === null) return false;
  try {
    await readFile(join(probe, 'memory.max'), 'utf8');
    await readFile(join(probe, 'pids.max'), 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    await rmdir(probe).catch(() => {});
  }
}

const freezeLeaf = await writableChild();
const limitsAvailable = await probeLimits();
if (freezeLeaf !== null) await rmdir(freezeLeaf).catch(() => {});

let home = '';

async function freshRoot(): Promise<string> {
  const base = join(anchor as string, `.test-root-${process.pid}-${Date.now().toString(36)}`);
  await mkdir(base);
  return base;
}

/** Only leaf directories: cgroupfs also exposes control files at every level. */
async function leafDirs(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** cgroupfs removes directories, never files: leaves first, then the root. */
async function removeTree(root: string): Promise<void> {
  for (const name of await leafDirs(root)) {
    await rmdir(join(root, name)).catch(() => {});
  }
  await rmdir(root).catch(() => {});
}

async function waitForDead(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await readFile(`/proc/${pid}/stat`);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    } catch {
      return true;
    }
  }
  return false;
}

const LAUNCHER = new URL('../../../native/es-landlock/es-landlock', import.meta.url).pathname;

describe('cgroup naming', () => {
  it('derives a stable, valid unit name from the home', () => {
    const hash = cellHash('/home/a');
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(cellHash('/home/a')).toBe(hash);
    expect(cellHash('/home/a/')).toBe(hash);
    expect(cellHash('/home/b')).not.toBe(hash);
    expect(cellUnitName('/home/a')).toBe(`es-${hash}`);
    expect(cellUnitName('/home/a')).toMatch(/^[A-Za-z0-9:_.-]+$/);
    expect(cellRootUnder('/sys/fs/cgroup/x', '/home/a')).toBe(`/sys/fs/cgroup/x/es-${hash}`);
    expect(svcDir('/r')).toBe('/r/svc');
    expect(nodeLeaf('/r', 'node-0')).toBe('/r/node-node-0');
    expect(runLeaf('/r', 'abc')).toBe('/r/run-abc');
  });
});

describe.skipIf(anchor === null)('cgroup anchor', () => {
  it('resolves the kernel cgroup from /proc, verified by the cgroup2 magic', async () => {
    expect(anchor).not.toBeNull();
    expect(anchor).toMatch(/^\//);
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n').find((entry) => entry.startsWith('0::'));
    expect(line).toBeDefined();
    const rel = (line as string).slice(3).trim();
    if (rel !== '' && rel !== '/') expect((anchor as string).endsWith(rel)).toBe(true);
    const controllers = await lstat(join(anchor as string, 'cgroup.controllers'));
    expect(controllers.isFile()).toBe(true);
  });
});

describe('launch shape and limits (unprivileged answers)', () => {
  it('classifies the launch shape from the cgroup basename', () => {
    expect(launchModeFromCgroup('/x/es-ab.service')).toBe('service');
    expect(launchModeFromCgroup('/x/es-ab.service/svc')).toBe('service');
    expect(launchModeFromCgroup('/x/dsh-subprocess-1.scope')).toBe('direct');
    expect(launchModeFromCgroup('/x/es-ab.slice')).toBe('direct');
    // The user manager's own segment is present in EVERY user path; it must
    // never be mistaken for the launch unit.
    expect(launchModeFromCgroup('/user.slice/user@1000.service/app.slice/es-x.scope'))
      .toBe('direct');
    // The runner is not a transient service: the honest boot line is direct.
    expect(detectLaunchMode()).toBe('direct');
  });
  it('does not claim limit capability unprivileged', async () => {
    if (anchor === null || limitsAvailable) return; // delegated host: nothing to assert
    const root = await freshRoot();
    const leaf = join(root, 'node-x');
    try {
      await ensureLeaf(leaf);
      expect(await limitLeaf(leaf, { memoryMaxBytes: 1_000_000, pidsMax: 10 })).toBe(false);
      expect(await enableControllers(anchor as string, root)).toBe(false);
    } finally {
      await removeTree(root);
    }
  });
});

describe.skipIf(freezeLeaf === null)('cgroup attach, freeze and kill', () => {
  it('attaches the kernel into svc/ and detaches cleanly', async () => {
    const base = await freshRoot();
    try {
      const res = await attachCell(home, base);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const own = await readFile('/proc/self/cgroup', 'utf8');
      expect(own.trim()).toMatch(new RegExp(`/${cellUnitName(home)}/svc$`, 'u'));
      // Move back before removing the tree, so the worker does not live inside it.
      await writeFile(join(anchor as string, 'cgroup.procs'), String(process.pid));
    } finally {
      await rmdir(join(base, cellUnitName(home), 'svc')).catch(() => {});
      await rmdir(join(base, cellUnitName(home))).catch(() => {});
      await rmdir(base).catch(() => {});
      expect(await readFile('/proc/self/cgroup', 'utf8')).toContain(
        (anchor as string).split('/').pop() as string,
      );
    }
  });

  it('launcher --cgroup attaches before exec, in place', async () => {
    const base = await freshRoot();
    try {
      const leaf = join(base, 'node-test');
      await ensureLeaf(leaf);
      // The system grants a real invocation always carries (resolved: the
      // merged-usr spellings are symlinks and the launcher refuses them).
      const grants = [...['/usr', '/bin', '/lib', '/lib64'].flatMap((candidate) => {
        try {
          return ['--rox', realpathSync(candidate)];
        } catch {
          return [];
        }
      }), '--ro', realpathSync('/proc')];
      // One spawn, read while alive: the child's own cgroup names the leaf
      // AFTER its execve (the join happens pre-restriction, pre-exec), which
      // proves both the attach-before-exec ordering and the in-place exec.
      const child = spawn(
        LAUNCHER,
        ['--cgroup', leaf, ...grants, '--', '/bin/sleep', '5'],
        { stdio: 'ignore' },
      );
      try {
        const deadline = Date.now() + 5000;
        let applied = '';
        while (Date.now() < deadline) {
          applied = (await readFile(`/proc/${child.pid as number}/cgroup`, 'utf8')).trim();
          if (applied.endsWith('/node-test')) break;
          await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
        expect(applied).toMatch(/\/node-test$/u);
      } finally {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => {});
      }
    } finally {
      await removeTree(base);
    }
  }, 15_000);

  it('freezes a leaf, then kills its tree and thaws it', async () => {
    const root = await freshRoot();
    const leaf = join(root, 'node-test');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid as number;
    try {
      await ensureLeaf(leaf);
      await writeFile(join(leaf, 'cgroup.procs'), String(pid));
      expect(await freezeSet([leaf], { deadlineMs: 2000, pollMs: 20 })).toEqual({ ok: true });
      expect(await readFile(join(leaf, 'cgroup.events'), 'utf8')).toMatch(/frozen 1/u);
      await killLeaves([leaf]);
      expect(await waitForDead(pid)).toBe(true);
      expect((await readFile(join(leaf, 'cgroup.freeze'), 'utf8')).trim()).toBe('0');
    } finally {
      child.kill('SIGKILL');
      await killLeaves([leaf]);
      await removeTree(root);
    }
  }, 15_000);

  it('refuses to freeze the kernel\'s own svc leaf', async () => {
    const root = await freshRoot();
    try {
      expect(await freezeSet([svcDir(root)], { deadlineMs: 100, pollMs: 10 }))
        .toEqual({ ok: false, reason: 'svc-leaf-refused' });
    } finally {
      await removeTree(root);
    }
  });

  it('boot hygiene thaws then kills every leaf except svc/', async () => {
    const root = await freshRoot();
    try {
      const a = join(root, 'node-a');
      const b = join(root, 'run-b');
      await ensureLeaf(a);
      await ensureLeaf(b);
      await ensureLeaf(svcDir(root));
      await writeFile(join(a, 'cgroup.freeze'), '1');
      expect(await bootHygiene(root)).toEqual({ reaped: 2, failed: [] });
      expect((await lstat(a).catch(() => null))).toBeNull();
      expect((await lstat(b).catch(() => null))).toBeNull();
      expect((await lstat(svcDir(root)).catch(() => null))).not.toBeNull();
    } finally {
      await removeTree(root);
    }
  }, 15_000);

  it('reports a leaf it could not remove after the thaw/kill', async () => {
    // A plain directory shaped like a cgroup leaf: the thaw/kill writes create
    // their control files, and the extra file keeps rmdir from succeeding. The
    // host must name it rather than boot silently over it.
    const root = await mkdtemp(join(tmpdir(), 'es-boot-stuck-'));
    try {
      const stuck = join(root, 'node-stuck');
      await mkdir(stuck);
      await writeFile(join(stuck, 'keep'), 'x');
      expect(await bootHygiene(root)).toEqual({ reaped: 1, failed: ['node-stuck'] });
      expect(await lstat(stuck).catch(() => null)).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports both capability classes without mutating the anchor', async () => {
    const caps = await cgroupCapabilities(anchor as string);
    // Freeze/kill work unprivileged on this host.
    expect(caps.freezeKill).toBe(true);
    // Limits exist only under a delegated launch; assert the probed truth so a
    // delegated host does not fail this case.
    expect(caps.limits).toBe(limitsAvailable);
    const own = await readFile('/proc/self/cgroup', 'utf8');
    expect(own).toMatch(new RegExp((anchor as string).split('/').pop() as string, 'u'));
  });

  // G2: the commit fence freezes an EMPTY node leaf on a boot-reconcile or an
  // idle turn, before any shell has run. The transition must be a tested fact,
  // not an assumption: an empty cgroup still reports `frozen 1` promptly.
  it('freezes an empty leaf: no process, frozen 1, then thaw', async () => {
    const root = await freshRoot();
    const leaf = join(root, 'node-empty');
    try {
      await ensureLeaf(leaf);
      const started = Date.now();
      expect(await freezeSet([leaf], { deadlineMs: 2000, pollMs: 20 })).toEqual({ ok: true });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await readFile(join(leaf, 'cgroup.events'), 'utf8')).toMatch(/frozen 1/u);
      expect((await readFile(join(leaf, 'cgroup.procs'), 'utf8')).trim()).toBe('');
      await writeFile(join(leaf, 'cgroup.freeze'), '0');
      expect(await readFile(join(leaf, 'cgroup.events'), 'utf8')).toMatch(/^\s*frozen\s+0\s*$/mu);
    } finally {
      await writeFile(join(leaf, 'cgroup.freeze'), '0').catch(() => {});
      await removeTree(root);
    }
  }, 15_000);
});

// The fence's enumeration and vanished-leaf semantics are filesystem facts, not
// cgroup facts: they run on a plain temp directory so every host exercises them.
describe('leaf enumeration and vanished leaves', () => {
  it('lists only run-* directories, sorted, and never mutates them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'es-listleaves-'));
    try {
      await mkdir(join(root, 'run-b'));
      await mkdir(join(root, 'run-a'));
      await mkdir(join(root, 'node-node-0'));
      await mkdir(join(root, 'svc'));
      await writeFile(join(root, 'run-file'), 'not a leaf');
      expect(await listLeaves(root)).toEqual([join(root, 'run-a'), join(root, 'run-b')]);
      // Non-destructive: readdir/lstat only, nothing thawed, killed or removed.
      for (const name of ['run-a', 'run-b', 'node-node-0', 'svc', 'run-file']) {
        expect((await lstat(join(root, name))).isDirectory()).toBe(name !== 'run-file');
      }
      expect(await listLeaves(join(root, 'missing'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a leaf whose events file vanished as gone, not as a timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'es-vanish-'));
    const leaf = join(root, 'run-gone');
    try {
      await mkdir(leaf); // no cgroup.events: the leaf is "gone" after the write
      const started = Date.now();
      expect(await freezeSet([leaf], { deadlineMs: 500, pollMs: 20 })).toEqual({ ok: true });
      expect(Date.now() - started).toBeLessThan(400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('times out a leaf that never reports frozen, and thaws it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'es-nofreeze-'));
    const leaf = join(root, 'run-stuck');
    try {
      await mkdir(leaf);
      await writeFile(join(leaf, 'cgroup.events'), 'frozen 0\n');
      expect(await freezeSet([leaf], { deadlineMs: 100, pollMs: 10 }))
        .toEqual({ ok: false, reason: 'freeze-timeout' });
      expect((await readFile(join(leaf, 'cgroup.freeze'), 'utf8')).trim()).toBe('0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
