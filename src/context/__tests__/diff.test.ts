import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAs, gitIn, gitRaw, useWorld, writeWorldFile } from '../../node/__tests__/helpers.js';
import { WorldRepo, gitEnv } from '../../node/world.js';
import type { GateScope } from '../../node/gate.js';
import { createBoundaryRegistry } from '../events.js';
import type { WorldPerception } from '../contracts.js';
import { RENDER_POLICY, presentWorld } from '../diff.js';

/**
 * The bounded pinned Git perception (T4): `presentWorld` selects the newest
 * capped commits and budgets them NEWEST-first — a wake must never spend the
 * byte budget on the oldest history and drop the commits that just landed —
 * then emits the kept commits oldest-first so the reading order stays
 * chronological, and records renderer identity. These fixtures use real Git
 * repositories through the node helpers.
 */

const fixture = useWorld('context-diff-');
const MISSING = 'a'.repeat(40);

/** The exact aggregate omission line for a given dropped range. */
const omissionLine = (count: number, oldest: string | null): string =>
  `rendering truncated; ${count} older commit(s) not shown`
  + (oldest === null ? '' : ` (oldest omitted ${oldest.slice(0, 12)})`);

/** Writes a byte payload and commits it, returning the commit hash. */
async function commitBytes(world: WorldRepo, author: string, rel: string, bytes: Buffer): Promise<string> {
  const path = join(world.path, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
  await gitIn(world, ['add', '-A']);
  const email = `${author.replace(/[^A-Za-z0-9._-]/g, '-')}@world.local`;
  await gitIn(world, ['commit', '--quiet', '-m', 'bytes'], gitEnv({
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email,
  }));
  return (await gitIn(world, ['rev-parse', 'HEAD'])).trim();
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
    // This writes into the now-trusted git dir *after* `open` and never
    // re-opens: the trust scan is an open-time gate, not a per-command one, and
    // the hermetic renderer is what neutralizes the driver here.
    await gitIn(world, ['config', 'diff.evil.textconv', script]);
    await gitIn(world, ['config', 'diff.external', script]);
    const head = (await gitIn(world, ['rev-parse', 'HEAD'])).trim();
    const p = await presentWorld(world, 'n1', { from: null, to: head }, 8192, 4096);
    expect(p.text).toContain('+content');
    // The marker file must not exist: no external diff/textconv process ran.
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await gitIn(world, ['--version'])).toMatch(/^git version \d+\./);
  });
});

describe('world reads ignore a refs/replace projection', () => {
  /** Creates a commit object with `author` and `message` over an existing tree. */
  async function commitTreeAs(world: WorldRepo, tree: string, message: string, author: string): Promise<string> {
    const email = `${author}@world.local`;
    return (await gitIn(world, ['commit-tree', tree, '-m', message], gitEnv({
      GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email,
    }))).trim();
  }

  it('reads the physical commit author and subject, not the replacement', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const tree = (await gitIn(world, ['rev-parse', `${c1}^{tree}`])).trim();
    const replacement = await commitTreeAs(world, tree, 'forged subject', 'attacker');
    await gitIn(world, ['replace', c1, replacement]);

    // Deliberately the host env, not gitEnv: only an uncontrolled read projects
    // the forgery, so this proves the kernel's env is what neutralizes it below.
    expect(await gitIn(world, ['log', '--format=%an', '-1', c1], process.env)).toBe('attacker\n');
    expect(await gitIn(world, ['log', '--format=%s', '-1', c1], process.env)).toBe('forged subject\n');

    // The kernel's git environment neutralizes the projection: the log and the
    // rev-list traversal report the physical author.
    expect(await world.commitsSince(null)).toEqual([{ hash: c1, author: 'n1' }]);
    expect((await world.commitsIn({ from: null, to: c1 }, 4096)).commits)
      .toEqual([{ hash: c1, author: 'n1' }]);

    // The rendered perception carries the physical facts and no forged text.
    const p = await presentWorld(world, 'n2', { from: null, to: c1 }, 8192, 4096);
    expect(p.text).toContain(`commit ${c1}\nauthor n1\nparent none\n`);
    expect(p.text).not.toContain('attacker');
    expect(p.text).not.toContain('forged subject');
  });
});

describe('presentWorld on a SHA-256 world', () => {
  it('renders a foreign first commit patch and a subsequent commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-diff-sha256-'));
    const dir = join(root, 'world');
    const gitDir = join(root, 'world.git');
    await mkdir(dir, { recursive: true });
    await gitRaw(dir, [
      '--git-dir', gitDir, '--work-tree', dir,
      'init', '--quiet', '--object-format=sha256', '--initial-branch=main',
    ]);
    try {
      const world = await WorldRepo.open(dir, { gitDir });
      const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
      const p1 = await presentWorld(world, 'n1', { from: null, to: c1 }, 4096, 4096);
      expect(p1.included).toEqual([c1]);
      expect(p1.text).toContain('+one');
      const c2 = await commitAs(world, 'n2', { 'b.txt': 'two\n' });
      const p2 = await presentWorld(world, 'n1', { from: c1, to: c2 }, 8192, 4096);
      expect(p2.included).toEqual([c2]);
      expect(p2.text).toContain('+two');
      expect(p2.text).not.toContain('+one');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('presentWorld renderer metadata', () => {
  it('records the exact policy, attrSource and trimmed git --version form', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 4096, 4096);
    expect(p.renderer).toEqual({
      policy: RENDER_POLICY,
      gitVersion: (await gitIn(world, ['--version'])).replace(/\r?\n$/, ''),
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

  it.skipIf(process.getuid?.() === 0)('rejects rather than falling back when the repository is unreadable', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const objects = join(world.gitDir, 'objects');
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
    await rm(join(world.gitDir, 'objects'), { recursive: true, force: true });
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
    const c1 = await commitBytes(world, 'n2', 'bad.bin', invalid);
    const capture = await world.diff({ from: null, to: c1 }, 4096);
    expect(capture.text).toContain('\uFFFD');
    expect(capture.bytesRetained).toBe(Buffer.byteLength(capture.text, 'utf8'));
    expect(capture.bytesRetained).toBeLessThanOrEqual(4096);
  });

  it('budgets newest-first: the waking commits are kept, the oldest are named', async () => {
    const { world } = fixture();
    const hashes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      hashes.push(await commitAs(world, 'n2', { [`f${i}.txt`]: `${`row ${i} `.repeat(40)}\n` }));
    }
    const to = hashes.at(-1) ?? null;
    const p = await presentWorld(world, 'n1', { from: null, to }, 512, 4096);
    expect(p.truncated).toBe(true);
    expect(Buffer.byteLength(p.text, 'utf8')).toBeLessThanOrEqual(512);
    // Newest-first budgeting: the newest commit is presented, the oldest is
    // dropped, and `included` names only what was presented — a contiguous
    // newest suffix.
    expect(p.text).toContain(`commit ${hashes.at(-1)}`);
    expect(p.text).not.toContain(`commit ${hashes[0]}`);
    expect(p.included.length).toBeLessThan(hashes.length);
    expect(p.included.length).toBeGreaterThan(0);
    for (const hash of p.included) {
      expect(p.text).toContain(`commit ${hash}`);
      expect(p.commits.some((c) => c.hash === hash)).toBe(true);
    }
    const hashesIn = hashes.map((h) => p.included.includes(h));
    expect(hashesIn).toEqual([...hashesIn].sort((a, b) => Number(a) - Number(b)));
    // The omission notice names the dropped count and the oldest omitted hash.
    const dropped = hashes.length - p.included.length;
    expect(p.text).toContain(`\n${omissionLine(dropped, hashes[0] ?? null)}\n`);
  });

  it('seeds the kept budget with the preamble bytes under the same bound', async () => {
    const { world } = fixture();
    const hashes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      hashes.push(await commitAs(world, 'n2', { [`f${i}.txt`]: `${`row ${i} `.repeat(40)}\n` }));
    }
    // The fallback preamble consumes working budget: a renderer that forgot
    // to seed the kept budget with it would emit 548 bytes here.
    const p = await presentWorld(world, 'n1',
      { from: MISSING, to: hashes.at(-1) ?? null }, 512, 4096);
    expect(p.fallback).toBe('unreachable-from');
    expect(p.truncated).toBe(true);
    expect(Buffer.byteLength(p.text, 'utf8')).toBeLessThanOrEqual(512);
    expect(p.text.startsWith('fallback: from unreachable; full history shown\n')).toBe(true);
    expect(p.text).toContain(`commit ${hashes.at(-1)}`);
    expect(p.text).not.toContain(`commit ${hashes[0]}`);
  });

  it('emits the kept commits oldest-to-newest after newest-first budgeting', async () => {
    const { world } = fixture();
    const hashes: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      hashes.push(await commitAs(world, 'n2', { [`f${i}.txt`]: 'y'.repeat(400) }));
    }
    // A budget that fits roughly the newest two commits fully.
    const p = await presentWorld(world, 'n1', { from: null, to: hashes.at(-1) ?? null },
      2048, 4096);
    expect(p.included.length).toBeGreaterThanOrEqual(2);
    // The kept set is a contiguous newest suffix, ordered oldest→newest.
    expect(p.included).toEqual(hashes.slice(-p.included.length));
    expect(p.truncated).toBe(true);
    const at = (hash: string): number => p.text.indexOf(`commit ${hash}`);
    for (let i = 1; i < p.included.length; i += 1) {
      const older = p.included[i - 1]!;
      const newer = p.included[i]!;
      expect(at(older)).toBeGreaterThanOrEqual(0);
      expect(at(older)).toBeLessThan(at(newer));
    }
    expect(at(p.included.at(-1)!)).toBeLessThan(p.text.indexOf('rendering truncated'));
  });
});

describe('presentWorld hermetic rendering policy', () => {
  it('ignores a working-tree .gitattributes marking the file -diff (GIT_ATTR_SOURCE pins to `to`)', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    // Uncommitted working-tree attribute: the to-tree has no attributes, so the
    // render must show text rather than "Binary files ... differ".
    await writeWorldFile(world, '.gitattributes', '*.txt -diff\n');
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 8192, 4096);
    expect(p.text).toContain('+one');
    expect(p.text).not.toContain('Binary files');
    expect(p.text).not.toContain('differ');
  });

  it('ignores .git/info/attributes and a repo-local diff driver config', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    // Repo metadata that outranks tree attributes and a driver that would break
    // rendering: both live outside the isolated bare view.
    await writeFile(join(world.gitDir, 'info', 'attributes'), '*.txt -diff\n');
    // Written into the trusted git dir after `open`, deliberately: the scan is
    // an open-time gate and the hermetic view is what neutralizes these.
    await gitIn(world, ['config', 'diff.evil.xfuncname', '^evil-func']);
    await gitIn(world, ['config', 'diff.evil.command', 'false']);
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 8192, 4096);
    expect(p.text).toContain('+one');
    expect(p.text).not.toContain('Binary files');
  });

  it('cancels a host diff.orderFile so the default order is kept (-O/dev/null)', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'aaa\n', 'z.txt': 'zzz\n' });
    const orderFile = join(world.path, 'order.txt');
    // Request z before a; the default git order is alphabetical, so a must stay first.
    await writeFile(orderFile, 'z.txt\na.txt\n');
    await gitIn(world, ['config', 'diff.orderFile', orderFile]);
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 8192, 4096);
    const ai = p.text.indexOf('a/a.txt');
    const zi = p.text.indexOf('b/z.txt');
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(zi).toBeGreaterThan(ai);
  });

  it('fails closed when the world object database the view points at is absent', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    await rm(join(world.gitDir, 'objects'), { recursive: true, force: true });
    await expect(world.diff({ from: null, to: c1 }, 4096)).rejects.toThrow();
  });
});

describe('presentWorld list truncation', () => {
  it('reports list truncation for a 4097-commit history at maxCommits 4096', { timeout: 120_000 }, async () => {
    const { world } = fixture();
    await fastImportCommits(world, 4097);
    const head = (await gitIn(world, ['rev-parse', 'HEAD'])).trim();

    const range = await world.commitsIn({ from: null, to: head }, 4096);
    expect(range.listTruncated).toBe(true);
    expect(range.commits).toHaveLength(4096);
    // The dropped commit is the oldest; the newest is retained.
    expect(range.commits.at(-1)?.hash).toBe(head);

    const p = await presentWorld(world, 'n1', { from: null, to: head }, 512, 4096);
    expect(p.listTruncated).toBe(true);
    expect(p.commits).toHaveLength(4096);
    expect(p.text).toContain('commit-list truncated; oldest history omitted');
  });
});

/** Builds `count` commits through one `git fast-import` stream, cheaply. */
async function fastImportCommits(world: WorldRepo, count: number): Promise<void> {
  const chunks: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const content = `line ${i}`;
    const message = `c${i}`;
    chunks.push(
      'commit refs/heads/main\n' +
      'author n2 <n2@world.local> 1700000000 +0000\n' +
      'committer n2 <n2@world.local> 1700000000 +0000\n' +
      `data ${Buffer.byteLength(message)}\n${message}\n` +
      `M 100644 inline f${i}.txt\n` +
      `data ${Buffer.byteLength(content)}\n${content}\n`,
    );
  }
  chunks.push('done\n');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', [...world.gitBaseArgs(), 'fast-import', '--quiet'], {
      cwd: world.path, env: gitEnv(),
    });
    child.on('error', reject);
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(stderr)); });
    child.stdin.end(chunks.join(''));
  });
}

describe('presentWorld notice byte grammar', () => {
  it('precedes a truncated-patch notice with an LF so it starts its own line', async () => {
    const { world } = fixture();
    // A single unterminated line guarantees the bounded patch is cut mid-line.
    const c1 = await commitAs(world, 'n2', { 'big.txt': 'x'.repeat(100_000) });
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 4096, 4096);
    expect(p.truncated).toBe(true);
    // The patch is cut mid-line; the notice must begin with a deterministic LF
    // and end with one, never gluing onto the cut patch tail — and it follows
    // the truncated commit's block, not the front of the text.
    expect(p.text).toMatch(/\npatch truncated after \d+ bytes\n/);
    const noticeAt = p.text.indexOf('patch truncated after');
    expect(p.text[noticeAt - 1]).toBe('\n');
    expect(noticeAt).toBeGreaterThan(p.text.indexOf(`commit ${c1}`));
  });

  it('precedes the aggregate omission notice with an LF', async () => {
    const { world } = fixture();
    const hashes: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      hashes.push(await commitAs(world, 'n2', { [`f${i}.txt`]: 'y'.repeat(400) }));
    }
    const p = await presentWorld(world, 'n1', { from: null, to: hashes.at(-1) ?? null }, 512, 4096);
    const line = omissionLine(hashes.length - p.included.length, hashes[0] ?? null);
    expect(p.text).toContain(line);
    expect(p.text).toMatch(new RegExp(`\\n${line.replace(/[()]/g, '\\$&')}\\n`));
    const at = p.text.indexOf('rendering truncated');
    expect(p.text[at - 1]).toBe('\n');
  });

  it('records the renderer policy identity', () => {
    // v2 is the newest-first budgeting policy; v1 journals stay replayable
    // through the registry's accepted-policy set.
    expect(RENDER_POLICY).toBe('commit-patches-v2');
  });

  it('the registry accepts both policies and refuses a third', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const p = await presentWorld(world, 'n1', { from: null, to: c1 }, 4096, 4096);
    const registry = createBoundaryRegistry();
    const scope: GateScope = {
      phase: 'turn', turn: 0, signal: new AbortController().signal, lookup: () => null,
    };
    const wrap = (policy: string) => registry['world/perception'](
      {
        turn: 0, range: p.range,
        value: { kind: 'inline', value: { ...p, renderer: { ...p.renderer, policy } } },
      }, scope,
    ) as unknown as { value: { value: WorldPerception } };
    expect(wrap('commit-patches-v1').value.value.renderer.policy).toBe('commit-patches-v1');
    expect(wrap('commit-patches-v2').value.value.renderer.policy).toBe('commit-patches-v2');
    expect(() => wrap('commit-patches-v3')).toThrow(/unknown policy/);
  });

  it('places each preamble notice on its own LF-terminated line', async () => {
    const { world } = fixture();
    const c1 = await commitAs(world, 'n2', { 'a.txt': 'one\n' });
    const p = await presentWorld(world, 'n1', { from: MISSING, to: c1 }, 4096, 4096);
    expect(p.text.startsWith('fallback: from unreachable; full history shown\n')).toBe(true);
    expect(p.text).toContain('\ncommit ');
  });
});
