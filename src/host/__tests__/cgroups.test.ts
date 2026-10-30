import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachCell, bootHygiene, cellHash, cellRootUnder, cellUnitName,
  cgroupCapabilities, ensureLeaf, freezeSet, killLeaves, nodeLeaf,
  resolveAnchor, runLeaf, svcDir,
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
      // 1. The exec'd program sees the leaf at its first instruction.
      const res = spawnSync(
        LAUNCHER,
        ['--cgroup', leaf, ...grants, '--', '/bin/sh', '-c', 'exec cat /proc/self/cgroup'],
        { encoding: 'utf8', timeout: 10_000 },
      );
      expect(res.status, `stdout=${res.stdout} stderr=${res.stderr}`).toBe(0);
      expect((res.stdout ?? '').trim()).toMatch(/\/node-test$/u);
      // 2. The attached pid is the spawn's own pid (execve in place, not a fork).
      const child = spawn(LAUNCHER, ['--cgroup', leaf, ...grants, '--', '/bin/sleep', '2'], { stdio: 'ignore' });
      try {
        const applied = await readFile(`/proc/${child.pid as number}/cgroup`, 'utf8');
        expect(applied.trim()).toMatch(/\/node-test$/u);
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
      expect(await bootHygiene(root)).toBe(2);
      expect((await lstat(a).catch(() => null))).toBeNull();
      expect((await lstat(b).catch(() => null))).toBeNull();
      expect((await lstat(svcDir(root)).catch(() => null))).not.toBeNull();
    } finally {
      await removeTree(root);
    }
  }, 15_000);

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
});
