import { execFile } from 'node:child_process';
import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAs, gitIn, useWorld } from '../../node/__tests__/helpers.js';
import { presentWorld } from '../diff.js';

/**
 * The bounded pinned Git perception (T4): `presentWorld` selects the newest
 * capped commits, renders ordered per-commit foreign patches oldest-first under
 * one shared byte budget, and records renderer identity. These fixtures use real
 * Git repositories through the node helpers.
 */

const fixture = useWorld('context-diff-');
const MISSING = 'a'.repeat(40);
const AGGREGATE = 'rendering truncated; remaining selected commits not shown';

/** Writes a byte payload and commits it, returning the commit hash. */
async function commitBytes(worldPath: string, author: string, rel: string, bytes: Buffer): Promise<string> {
  const path = join(worldPath, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
  await gitIn(worldPath, ['add', '-A']);
  const email = `${author.replace(/[^A-Za-z0-9._-]/g, '-')}@world.local`;
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['commit', '--quiet', '-m', 'bytes'], {
      cwd: worldPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email,
      },
    }, (err, _out, stderr) => { if (err) reject(new Error(stderr)); else resolve(); });
  });
  return (await gitIn(worldPath, ['rev-parse', 'HEAD'])).trim();
}

describe('presentWorld concrete rendering', () => {
  it('includes a foreign first commit additions from the empty tree', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 4096, 4096);
    expect(p.uid).toBe('n1');
    expect(p.commits).toEqual([{ hash: c1, author: 'n2' }]);
    expect(p.effectiveFrom).toBeNull();
    expect(p.fallback).toBe('none');
    expect(p.listTruncated).toBe(false);
    expect(p.truncated).toBe(false);
    expect(p.included).toEqual([c1]);
    expect(p.omittedOwn).toEqual([]);
    expect(p.text).toContain(`commit ${c1}\nauthor n2\nparent none\n`);
    expect(p.text).toContain('+one');
  });

  it('produces empty text for a same-hash range', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const p = await presentWorld(world, 'n1', { from: c1, to: c1 }, 4096, 4096);
    expect(p.commits).toEqual([]);
    expect(p.text).toBe('');
    expect(p.truncated).toBe(false);
  });

  it('excludes an own commit patch and records it in omittedOwn', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const c2 = await commitAs(world, 'n1', { 'b.txt': 'two\n' });
    const p = await presentWorld(world, 'n1', { from: null, to: c2 }, 4096, 4096);
    expect(p.commits.map((c) => c.hash)).toEqual([c1, c2]);
    expect(p.included).toEqual([c1]);
    expect(p.omittedOwn).toEqual([c2]);
    expect(p.text).toContain(`commit ${c2} author n1 omitted: own commit`);
    expect(p.text).not.toContain('b/b.txt');
    expect(p.text).toContain('+one');
    expect(p.text).toContain('attribution: commit author names the closer');
  });

  it('presents add then remove in two foreign commits, both ordered oldest-first', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    await rm(join(world.path, 'a.txt'));
    const c2 = await commitAs(world, 'n2', { 'b.txt': 'keep\n' });
    const p = await presentWorld(world, 'n1', { from: null, to: c2 }, 8192, 4096);
    expect(p.commits.map((c) => c.hash)).toEqual([c1, c2]);
    expect(p.included).toEqual([c1, c2]);
    const at = (needle: string): number => p.text.indexOf(needle);
    expect(at(`commit ${c1}`)).toBeGreaterThanOrEqual(0);
    expect(at(`commit ${c1}`)).toBeLessThan(at(`commit ${c2}`));
    expect(at('+one')).toBeGreaterThanOrEqual(0);
    expect(at('+one')).toBeLessThan(at('-one'));
  });

  it('pins to the requested to even after HEAD moves', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const c2 = await commitAs(world, 'n2', { 'b.txt': 'two\n' });
    const c3 = await commitAs(world, 'n2', { 'c.txt': 'three\n' });
    const p = await presentWorld(world, 'n1', { from: null, to: c2 }, 8192, 4096);
    expect(p.commits.map((c) => c.hash)).toEqual([c1, c2]);
    expect(p.text).not.toContain(c3);
    // c2 is still HEAD~1; the newer c3 is ignored because `to` is pinned.
    expect(await world.headHash()).toBe(c3);
  });

  it('does not run a working-tree external diff or textconv during retrieval', async () => {
    const { world } = fixture();
    const marker = join(world.path, 'MARKER');
    const script = join(world.path, 'evil.sh');
    await writeFile(script, `#!/bin/sh\ntouch ${marker}\nexit 0\n`, { mode: 0o755 });
    // Committed attributes point every text file at a driver whose config is
    // repo-local; the hermetic view has no such config and passes --no-textconv.
    await commitAs(world, 'n2', { '.gitattributes': '*.txt diff=evil\n', 'a.txt': 'content\n' });
    await gitIn(world.path, ['config', 'diff.evil.textconv', script]);
    await gitIn(world.path, ['config', 'diff.external', script]);
    const head = (await gitIn(world.path, ['rev-parse', 'HEAD'])).trim();
    const p = await presentWorld(world, 'n1', { from: null, to: head }, 8192, 4096);
    expect(p.text).toContain('+content');
    // The marker file must not exist: no external diff/textconv process ran.
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await gitIn(world.path, ['--version'])).toMatch(/^git version \d+\./);
  });
});

describe('presentWorld renderer metadata', () => {
  it('records the exact policy, attrSource and trimmed git --version form', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 4096, 4096);
    expect(p.renderer).toEqual({
      policy: 'commit-patches-v1',
      gitVersion: (await gitIn(world.path, ['--version'])).replace(/\r?\n$/, ''),
      attrSource: 'to',
    });
    expect(p.renderer.gitVersion).toMatch(/^git version \d+/);
    expect(p.renderer.gitVersion).not.toContain('\n');
  });
});

describe('presentWorld negative and bounded fixtures', () => {
  it('flags an unreachable from and rejects a nonexistent to', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const p = await presentWorld(world, 'n1', { from: MISSING, to: c1 }, 4096, 4096);
    expect(p.fallback).toBe('unreachable-from');
    expect(p.effectiveFrom).toBeNull();
    expect(p.text).toContain('fallback: from unreachable; full history shown');

    await expect(presentWorld(world, 'n1', { from: null, to: MISSING }, 4096, 4096)).rejects.toThrow();
  });

  it('rejects rather than falling back when the repository is unreadable', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const objects = join(world.path, '.git', 'objects');
    await chmod(objects, 0o000);
    try {
      await expect(presentWorld(world, 'n1', { from: c1, to: c1 }, 4096, 4096)).rejects.toThrow();
    } finally {
      await chmod(objects, 0o755);
    }
  });

  it('fails closed when the isolated view cannot be created', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const c2 = await commitAs(world, 'n2', { 'b.txt': 'two\n' });
    await rm(join(world.path, '.git', 'objects'), { recursive: true, force: true });
    // The object database the view would share is gone: the renderer rejects
    // instead of silently rendering from the working tree.
    await expect(world.diff({ from: c1, to: c2 }, 4096)).rejects.toThrow();
  });

  it('bounds a 2 MiB multibyte/control file within maxBytes with a visible notice', async () => {
    const { world } = fixture();
    const chunk = 'ligne\t\u00e9\u4e2d\u6d4b\n';
    const big = chunk.repeat(Math.ceil((2 * 1024 * 1024) / Buffer.byteLength(chunk, 'utf8')));
    const c1 = await commitAs(world, 'n2', { 'big.txt': big });
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 4096, 4096);
    expect(p.truncated).toBe(true);
    expect(Buffer.byteLength(p.text, 'utf8')).toBeLessThanOrEqual(4096);
    expect(p.text).toContain('patch truncated after');
    expect(p.text.includes('\uFFFD')).toBe(false);
  });

  it('replaces invalid bytes deterministically and keeps emitted bytes == bytesRetained <= maxBytes', async () => {
    const { world } = fixture();
    const invalid = Buffer.concat([Buffer.from('ok '), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from(' end\n')]);
    const c1 = await commitBytes(world.path, 'n2', 'bad.bin', invalid);
    const capture = await world.diff({ from: null, to: c1 }, 4096);
    expect(capture.text).toContain('\uFFFD');
    expect(capture.bytesRetained).toBe(Buffer.byteLength(capture.text, 'utf8'));
    expect(capture.bytesRetained).toBeLessThanOrEqual(4096);
  });

  it('never exceeds the single shared budget and emits the exact aggregate omission literal', async () => {
    const { world } = fixture();
    const hashes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      hashes.push(await commitAs(world, 'n2', { [`f${i}.txt`]: `${`row ${i} `.repeat(40)}\n` }));
    }
    const to = hashes.at(-1) ?? null;
    const p = await presentWorld(world, 'n1', { from: null, to }, 512, 4096);
    expect(p.truncated).toBe(true);
    expect(Buffer.byteLength(p.text, 'utf8')).toBeLessThanOrEqual(512);
    expect(p.text).toContain(AGGREGATE);
    // Accounting is oldest-first: the first selected commit is rendered, later
    // commits are not, and `included` names only what was presented.
    expect(p.text).toContain(`commit ${hashes[0]}`);
    expect(p.text).not.toContain(hashes.at(-1) ?? 'missing');
    expect(p.included.length).toBeLessThan(hashes.length);
    for (const hash of p.included) {
      expect(p.text).toContain(`commit ${hash}`);
      expect(p.commits.some((c) => c.hash === hash)).toBe(true);
    }
  });
});
