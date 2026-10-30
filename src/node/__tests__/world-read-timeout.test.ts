import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasForeignCommit } from '../world-history.js';
import { renderDiff } from '../world-diff.js';
import { runGit, runGitWithStdin, type WorldIo } from '../world-git.js';
import { WorldRepo } from '../world.js';
import { commitAs, useWorld } from './helpers.js';

/**
 * The streaming reads (`git log`, the hermetic diff) bound their own git child:
 * a slow render is a typed `timeout` within the deadline, never a hung boot or
 * a hung perception. `spawnGit` starts git in its own process group, so the
 * kill also reaches a helper that inherited the pipes; otherwise `close` would
 * never fire and the deadline would not be a bound.
 */

const REAL_GIT = '/usr/bin/git';
const fixture = useWorld('node-world-read-timeout-');
let root = '';
let originalPath: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'es-read-timeout-'));
  originalPath = process.env['PATH'];
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  await rm(root, { recursive: true, force: true });
  root = '';
});

/** Installs a fake git first on PATH that sleeps for `diff`/`log` while the marker exists. */
async function slowReadGit(): Promise<string> {
  const marker = join(root, 'sleep');
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(marker, '');
  const script = `#!/bin/sh
for a in "$@"; do
  case "$a" in
    diff|log) if [ -e "${marker}" ]; then sleep 30; fi ;;
  esac
done
exec ${REAL_GIT} "$@"
`;
  const path = join(bin, 'git');
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  process.env['PATH'] = `${bin}:${originalPath ?? '/usr/bin:/bin'}`;
  return marker;
}

/** The open repository's io surface, exactly as the repository binds it. */
function ioOf(world: WorldRepo): WorldIo {
  const io: WorldIo = {
    path: world.path,
    gitDir: world.gitDir,
    baseArgs: () => world.gitBaseArgs(),
    head: () => world.headHash(),
    nothingStaged: async () => true,
    git: (args, env) => runGit(world.path, [...world.gitBaseArgs(), ...args], env),
    gitWithStdin: (args, input) =>
      runGitWithStdin(world.path, [...world.gitBaseArgs(), ...args], input),
    format: async () => 'sha1',
  };
  return io;
}

describe('the streaming reads are bounded', () => {
  it('a slow hermetic diff rejects typed timeout within the deadline', async () => {
    const { world } = fixture();
    const first = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    const second = await commitAs(world, 'n2', { 'b.txt': 'two\n' });
    const marker = await slowReadGit();
    const io = ioOf(world);
    const started = Date.now();
    await expect(renderDiff(io, { from: first, to: second }, 4096, 250))
      .rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(8_000);

    await unlink(marker);
    const capture = await renderDiff(io, { from: first, to: second }, 4096, 8_000);
    expect(capture.text).toContain('b.txt');
  });

  it('a slow wake scan rejects typed timeout instead of retrying the whole history', async () => {
    const { world } = fixture();
    const first = await commitAs(world, 'n1', { 'a.txt': 'one\n' });
    await commitAs(world, 'n2', { 'b.txt': 'two\n' });
    const marker = await slowReadGit();
    const io = ioOf(world);
    const started = Date.now();
    await expect(hasForeignCommit(io, first, 'n1', 250))
      .rejects.toMatchObject({ kind: 'timeout' });
    // One deadline, not two: the timeout arm does not fall back to the whole
    // history (that would double the bound).
    expect(Date.now() - started).toBeLessThan(1_500);

    await unlink(marker);
    expect(await hasForeignCommit(io, first, 'n1', 8_000)).toBe(true);
  });
});
