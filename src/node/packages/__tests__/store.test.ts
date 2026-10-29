import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writevSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PackageError } from '../errors.js';
import { createPackageStore } from '../store.js';

/**
 * The Package definition store (kernel.md, the local-log and sandbox sections):
 * an fd-first define (the pinned fd cannot be raced), a parse-only precheck,
 * content-addressed identities, write-once shell-invisible persistence, the
 * frozen caps, and a reopen scan that deletes corrupt bytes and reports them.
 * Every fixture is a mkdtemp tree; no path outside it is ever granted or read.
 */

const GOOD_SOURCE = 'return { tools: [] };\n';

function fixture(): {
  readonly home: string;
  readonly world: string;
  readonly scratch: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'es-packages-'));
  const world = join(home, 'world');
  const scratch = join(home, 'tmp', 'n1');
  mkdirSync(world, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  return { home, world, scratch };
}

async function store(f: { home: string; world: string; scratch: string }) {
  return await createPackageStore({
    home: f.home, uid: 'n1', worldDir: f.world, scratchDir: f.scratch,
  });
}

function worldFile(f: { world: string }, name: string, content = GOOD_SOURCE): string {
  const path = join(f.world, name);
  writeFileSync(path, content);
  return path;
}

describe('package store: argument validation', () => {
  it('refuses every malformed name and an out-of-bound purpose', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'good.js');
    const badNames = [
      'a/b', 'a\\b', '.', '..', 'a\0b', '.hidden', '', 'x'.repeat(65), 'a\uD800b',
    ];
    for (const name of badNames) {
      await expect(
        s.definePackage({ name, purpose: 'search', path: source }),
        JSON.stringify(name),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    await expect(
      s.definePackage({ name: 'grep_world', purpose: '', path: source }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      s.definePackage({ name: 'grep_world', purpose: 'y'.repeat(513), path: source }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    // A lone surrogate would otherwise escape canonicalization as a typed
    // NonCanonicalizableError instead of the store's own vocabulary.
    await expect(
      s.definePackage({ name: 'grep_world', purpose: 'p\uD800q', path: source }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    rmSync(f.home, { recursive: true, force: true });
  });

  it('refuses an empty path argument', async () => {
    const f = fixture();
    const s = await store(f);
    await expect(
      s.definePackage({ name: 'grep_world', purpose: 'search', path: '' }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    rmSync(f.home, { recursive: true, force: true });
  });
});

describe('package store: fd-first path resolution', () => {
  it('accepts a world file and a scratch file', async () => {
    const f = fixture();
    const s = await store(f);
    const worldPath = worldFile(f, 'world-src.js');
    const scratchPath = join(f.scratch, 'scratch-src.js');
    writeFileSync(scratchPath, GOOD_SOURCE);

    const fromWorld = await s.definePackage({
      name: 'grep_world', purpose: 'search the world', path: worldPath,
    });
    expect(fromWorld.id).toMatch(/^[0-9a-f]{64}$/);
    expect(fromWorld.sourceBytes).toBe(Buffer.byteLength(GOOD_SOURCE));

    const fromScratch = await s.definePackage({
      name: 'scratch_tool', purpose: 'from scratch', path: scratchPath,
    });
    expect(fromScratch.id).toMatch(/^[0-9a-f]{64}$/);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('resolves a relative path against the world worktree root', async () => {
    const f = fixture();
    const s = await store(f);
    worldFile(f, 'relative-src.js');
    const result = await s.definePackage({
      name: 'rel_tool', purpose: 'relative', path: 'relative-src.js',
    });
    expect(result.id).toMatch(/^[0-9a-f]{64}$/);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('returns ONE fixed refusal message for every out-of-containment outcome', async () => {
    const f = fixture();
    const s = await store(f);
    const outside = join(f.home, 'outside.js');
    writeFileSync(outside, GOOD_SOURCE);
    const missing = join(f.world, 'never-existed.js');

    const cases: string[] = [];
    for (const path of [outside, missing, '/proc/1/mem']) {
      try {
        await s.definePackage({ name: 'x', purpose: 'y', path });
      } catch (err) {
        expect(err).toBeInstanceOf(PackageError);
        expect((err as PackageError).code).toBe('path-refused');
        cases.push((err as Error).message);
      }
    }
    expect(cases).toHaveLength(3);
    expect(new Set(cases).size).toBe(1);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('refuses an in-world symlink that escapes the grants', async () => {
    const f = fixture();
    const s = await store(f);
    const outside = join(f.home, 'outside.js');
    writeFileSync(outside, GOOD_SOURCE);
    symlinkSync(outside, join(f.world, 'escape.js'));
    await expect(
      s.definePackage({ name: 'x', purpose: 'y', path: join(f.world, 'escape.js') }),
    ).rejects.toMatchObject({ code: 'path-refused' });
    rmSync(f.home, { recursive: true, force: true });
  });

  it('follows an in-world symlink to an in-world target', async () => {
    const f = fixture();
    const s = await store(f);
    worldFile(f, 'target.js', 'return { tools: [] }; // target\n');
    symlinkSync('target.js', join(f.world, 'alias.js'));
    const result = await s.definePackage({
      name: 'alias_tool', purpose: 'via alias', path: join(f.world, 'alias.js'),
    });
    expect(result.sourceBytes).toBe(Buffer.byteLength('return { tools: [] }; // target\n'));
    rmSync(f.home, { recursive: true, force: true });
  });

  it('refuses a FIFO, a directory and a hardlinked file', async () => {
    const f = fixture();
    const s = await store(f);
    const fifo = join(f.world, 'pipe.js');
    const made = spawnSync('mkfifo', [fifo]);
    expect(made.status).toBe(0);

    await expect(
      s.definePackage({ name: 'x', purpose: 'y', path: fifo }),
    ).rejects.toMatchObject({ code: 'path-refused' });

    await expect(
      s.definePackage({ name: 'x', purpose: 'y', path: f.world }),
    ).rejects.toMatchObject({ code: 'path-refused' });

    const target = worldFile(f, 'hardlinked.js');
    const link = join(f.world, 'hardlink.js');
    linkSync(target, link);
    await expect(
      s.definePackage({ name: 'x', purpose: 'y', path: link }),
    ).rejects.toMatchObject({ code: 'path-refused' });
    rmSync(f.home, { recursive: true, force: true });
  });

  it('reads the pinned fd: a repointed symlink never changes a stored definition', async () => {
    const f = fixture();
    const s = await store(f);
    const a = worldFile(f, 'a.js', 'return { tools: [] }; // a\n');
    const b = worldFile(f, 'b.js', 'return { tools: [] }; // b\n');
    const alias = join(f.world, 'swap.js');
    symlinkSync('a.js', alias);

    const first = await s.definePackage({
      name: 'swap_tool', purpose: 'swapped', path: alias,
    });
    // Repoint the alias: the stored definition still names a's bytes, and a
    // fresh define through the repointed alias is a different package.
    rmSync(alias);
    symlinkSync('b.js', alias);
    const second = await s.definePackage({
      name: 'swap_tool2', purpose: 'swapped', path: alias,
    });
    expect(second.id).not.toBe(first.id);
    expect(b).not.toBe(a);
    rmSync(f.home, { recursive: true, force: true });
  });
});

describe('package store: parse precheck (parse-only, never executed)', () => {
  it('refuses TS-annotated source with the teaching hint', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'ts.js', 'const x: number = 1;\nreturn { tools: [] };\n');
    const err = await s.definePackage({
      name: 'ts_tool', purpose: 'p', path: source,
    }).catch((e: unknown) => e as PackageError);
    expect(err).toBeInstanceOf(PackageError);
    expect((err as PackageError).code).toBe('invalid-source');
    expect((err as Error).message).toMatch(/TypeScript|annotation/i);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('refuses unbalanced source with the teaching hint', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'unbalanced.js', 'return { tools: [] ;\n');
    await expect(
      s.definePackage({ name: 'u_tool', purpose: 'p', path: source }),
    ).rejects.toMatchObject({ code: 'invalid-source' });
    rmSync(f.home, { recursive: true, force: true });
  });

  it('classifies a pathological-nesting RangeError as invalid-source', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'deep.js', `return ${'('.repeat(50_000)}1${')'.repeat(49_999)};\n`);
    await expect(
      s.definePackage({ name: 'd_tool', purpose: 'p', path: source }),
    ).rejects.toMatchObject({ code: 'invalid-source' });
    rmSync(f.home, { recursive: true, force: true });
  });
});

describe('package store: identity, idempotence and persistence', () => {
  it('is idempotent on identical content (same id, one directory)', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'same.js');
    const first = await s.definePackage({
      name: 'grep_world', purpose: 'search', path: source,
    });
    const second = await s.definePackage({
      name: 'grep_world', purpose: 'search', path: source,
    });
    expect(second.id).toBe(first.id);
    const packagesDir = join(f.home, 'nodes', 'n1', 'packages');
    expect(existsSync(join(packagesDir, first.id))).toBe(true);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('gives different content a different id', async () => {
    const f = fixture();
    const s = await store(f);
    const a = worldFile(f, 'one.js', 'return { tools: [] }; // one\n');
    const b = worldFile(f, 'two.js', 'return { tools: [] }; // two\n');
    const one = await s.definePackage({ name: 't', purpose: 'p', path: a });
    const two = await s.definePackage({ name: 't', purpose: 'p', path: b });
    const three = await s.definePackage({ name: 't', purpose: 'different', path: a });
    expect(two.id).not.toBe(one.id);
    expect(three.id).not.toBe(one.id);
    expect(three.id).not.toBe(two.id);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('persists across a store reopen (no driver involved)', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'persist.js');
    const defined = await s.definePackage({
      name: 'grep_world', purpose: 'search', path: source,
    });
    const reopened = await store(f);
    const { mounted, corrupt } = await reopened.readMountedPackages();
    expect(corrupt).toEqual([]);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({
      id: defined.id, name: 'grep_world', purpose: 'search',
      sourceBytes: Buffer.byteLength(GOOD_SOURCE),
    });
    const sourceBytes = readFileSync(join(
      f.home, 'nodes', 'n1', 'packages', defined.id, 'package.js',
    ), 'utf8');
    expect(sourceBytes).toBe(GOOD_SOURCE);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('writes owner-only trees (0700 directories, 0600 files)', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'modes.js');
    const { id } = await s.definePackage({
      name: 'grep_world', purpose: 'search', path: source,
    });
    const packagesDir = join(f.home, 'nodes', 'n1', 'packages');
    const idDir = join(packagesDir, id);
    const umask = process.umask();
    const permissionBits = (path: string): number => statSync(path).mode & 0o7777;
    expect(permissionBits(packagesDir)).toBe(0o700 & ~umask);
    expect(permissionBits(idDir)).toBe(0o700 & ~umask);
    expect(permissionBits(join(idDir, 'package.js'))).toBe(0o600 & ~umask);
    expect(permissionBits(join(idDir, 'manifest.json'))).toBe(0o600 & ~umask);
    rmSync(f.home, { recursive: true, force: true });
  });
});

describe('package store: caps', () => {
  it('refuses a source over the 1 MiB per-source cap', async () => {
    const f = fixture();
    const s = await store(f);
    const path = join(f.world, 'big.js');
    const fd = openSync(path, 'w');
    writevSync(fd, [Buffer.from('return 1;'), Buffer.alloc(1024 * 1024)]);
    closeSync(fd);
    await expect(
      s.definePackage({ name: 'big_tool', purpose: 'p', path }),
    ).rejects.toMatchObject({ code: 'cap-exceeded' });
    rmSync(f.home, { recursive: true, force: true });
  });

  it('asserts the 64 MiB node cap at the boundary (no real 64 MiB write)', async () => {
    const f = fixture();
    const s = await store(f);
    const small = await s.definePackage({
      name: 'small', purpose: 'p', path: worldFile(f, 'small.js', 'return 1;\n'),
    });

    // Fabricate one near-cap stored definition with a sparse package.js: the
    // define-time cap check stats stored sizes, so the boundary is exact.
    const fakeId = 'e'.repeat(64);
    const fakeDir = join(f.home, 'nodes', 'n1', 'packages', fakeId);
    mkdirSync(fakeDir, { mode: 0o700 });
    const fakeSource = join(fakeDir, 'package.js');
    writeFileSync(fakeSource, 'return 1;\n');
    const budget = 64 * 1024 * 1024 - 2 * Buffer.byteLength('return 1;\n')
      - small.sourceBytes;
    truncateSync(fakeSource, Buffer.byteLength('return 1;\n') + budget);

    const lastAccepted = await s.definePackage({
      name: 'last', purpose: 'p', path: worldFile(f, 'last.js', 'return 1;\n'),
    });
    expect(lastAccepted.id).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      s.definePackage({
        name: 'refused', purpose: 'p', path: worldFile(f, 'refused.js', 'return 2;\n'),
      }),
    ).rejects.toMatchObject({ code: 'cap-exceeded' });
    rmSync(f.home, { recursive: true, force: true });
  });
});

describe('package store: the reopen scan', () => {
  it('deletes a corrupted definition and reports it (hash mismatch)', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'corrupt-me.js');
    const { id } = await s.definePackage({
      name: 'corrupt_me', purpose: 'p', path: source,
    });
    const idDir = join(f.home, 'nodes', 'n1', 'packages', id);
    chmodSync(join(idDir, 'package.js'), 0o600);
    writeFileSync(join(idDir, 'package.js'), GOOD_SOURCE + '// mutated\n');

    const { mounted, corrupt } = await s.readMountedPackages();
    expect(mounted).toEqual([]);
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]).toMatchObject({ id });
    expect(existsSync(idDir)).toBe(false);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('deletes a definition whose stored source is a FIFO (the scan never hangs)', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'fifo-scan.js');
    const { id } = await s.definePackage({
      name: 'fifo_scan', purpose: 'p', path: source,
    });
    const idDir = join(f.home, 'nodes', 'n1', 'packages', id);
    rmSync(join(idDir, 'package.js'));
    const made = spawnSync('mkfifo', [join(idDir, 'package.js')]);
    expect(made.status).toBe(0);

    const { mounted, corrupt } = await s.readMountedPackages();
    expect(mounted).toEqual([]);
    expect(corrupt).toHaveLength(1);
    expect(existsSync(idDir)).toBe(false);
    rmSync(f.home, { recursive: true, force: true });
  });

  it('deletes a definition directory carrying a stray file', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'stray.js');
    const { id } = await s.definePackage({
      name: 'stray', purpose: 'p', path: source,
    });
    const idDir = join(f.home, 'nodes', 'n1', 'packages', id);
    writeFileSync(join(idDir, 'stray.txt'), 'stray\n');

    const { mounted, corrupt } = await s.readMountedPackages();
    expect(mounted).toEqual([]);
    expect(corrupt).toHaveLength(1);
    expect(existsSync(idDir)).toBe(false);
    rmSync(f.home, { recursive: true, force: true });
  });
});

describe('package store: undefine', () => {
  it('deletes the definition directory and refuses an unknown id', async () => {
    const f = fixture();
    const s = await store(f);
    const source = worldFile(f, 'gone.js');
    const { id } = await s.definePackage({
      name: 'gone', purpose: 'p', path: source,
    });
    const idDir = join(f.home, 'nodes', 'n1', 'packages', id);
    await s.undefinePackage(id);
    expect(existsSync(idDir)).toBe(false);
    await expect(s.undefinePackage('f'.repeat(64)))
      .rejects.toMatchObject({ code: 'not-found' });
    rmSync(f.home, { recursive: true, force: true });
  });

  it('refuses a malformed id without touching the filesystem', async () => {
    const f = fixture();
    const s = await store(f);
    await expect(s.undefinePackage('not-an-id'))
      .rejects.toMatchObject({ code: 'not-found' });
    rmSync(f.home, { recursive: true, force: true });
  });
});


describe('package store: symlinked cell layouts', () => {
  it('defines from a symlinked world root (realpath containment)', async () => {
    const f = fixture();
    // The world reached through a symlink: containment compares the pinned
    // fd's realpath, so the root must resolve before comparing.
    const link = join(f.home, 'world-link');
    symlinkSync(f.world, link);
    const s = await createPackageStore({
      home: f.home, uid: 'n1', worldDir: link, scratchDir: f.scratch,
    });
    writeFileSync(join(f.world, 'via-link.js'), GOOD_SOURCE);
    const result = await s.definePackage({
      name: 'via_link', purpose: 'through the symlink', path: 'via-link.js',
    });
    expect(result.id).toMatch(/^[0-9a-f]{64}$/);
    rmSync(f.home, { recursive: true, force: true });
  });
});
