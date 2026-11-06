import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { FunctionCall } from '../../context/contracts.js';
import { GATEWAY_ADDRESSEE, HUMAN_AUTHOR } from '../../journal/index.js';
import { initHome } from '../../host/layout.js';
import { ConversationLog } from '../../node/conversation.js';
import { WorldRepo } from '../../node/world.js';
import { commitAs } from '../../node/__tests__/helpers.js';
import { runGit } from '../../node/world-git.js';
import { OVERLAY_POLICY, OVERLAY_TOOL_RESULT_BYTES, OVERLAY_WORLD_READ_MAX_BYTES } from '../policy.js';
import { dispatchOverlayTool } from '../tools.js';
import {
  WORLD_READ_FRAMING, readWorldLog, validateTreePath,
} from '../world-read.js';

/**
 * The overlay's three tools: `send_message` through the kernel-owned
 * conversation stream, and `read_world` / `world_log` as bounded, framed,
 * kernel-mediated reads of the COMMITTED world. Nothing here can write the
 * world — the overlay holds no tool that does.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(): Promise<{ home: string; world: WorldRepo }> {
  const home = await mkdtemp(join(tmpdir(), 'es-overlay-tools-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  return { home, world };
}

function call(name: string, args: unknown): FunctionCall {
  return {
    id: 'call-1', type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

async function dispatch(
  home: string, world: WorldRepo, name: string, args: unknown,
): Promise<string> {
  return await dispatchOverlayTool(call(name, args), {
    conversation: ConversationLog.for(home), world,
  });
}

it('send_message appends through the conversation log with the gateway actor and confirms the addressee', async () => {
  const { home, world } = await fixture();
  const result = await dispatch(home, world, 'send_message', { to: 'node-1', text: 'the answer' });
  expect(result).toContain('sent to node-1');
  const thread = await ConversationLog.for(home).thread('node-1');
  expect(thread.records).toEqual([
    { v: 0, at: expect.any(Number), from: 'gateway', to: 'node-1', text: 'the answer' },
  ]);
});

it('send_message refuses a missing, self, human or blank addressee, and an oversize text, without writing', async () => {
  const { home, world } = await fixture();
  for (const args of [
    { text: 'no addressee' },
    { to: '', text: 'no addressee' },
    { to: GATEWAY_ADDRESSEE, text: 'to myself' },
    { to: HUMAN_AUTHOR, text: 'to the human' },
    { to: 'not a uid', text: 'bad uid' },
    { to: 'node-1', text: '   ' },
    { to: 'node-1', text: 'x'.repeat(8_193) },
  ]) {
    const result = await dispatch(home, world, 'send_message', args);
    expect(result).toContain('error:');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(OVERLAY_TOOL_RESULT_BYTES);
  }
  expect((await ConversationLog.for(home).thread('node-1')).records).toEqual([]);
});

it('read_world reads the COMMITTED blob at HEAD, never the shared worktree, and frames it', async () => {
  const { home, world } = await fixture();
  await commitAs(world, 'node-0', {
    'DIRECTION.md': 'the first direction\n', 'notes/deep.txt': 'nested\n',
  }, 'seed');
  // The worktree diverges from HEAD: the overlay must still see HEAD.
  await writeFile(join(world.path, 'DIRECTION.md'), 'UNCOMMITTED bytes\n');

  const result = await dispatch(home, world, 'read_world', { path: 'DIRECTION.md' });
  expect(result.startsWith(WORLD_READ_FRAMING)).toBe(true);
  expect(result).toContain('the first direction');
  expect(result).not.toContain('UNCOMMITTED');
  const nested = await dispatch(home, world, 'read_world', { path: 'notes/deep.txt' });
  expect(nested).toContain('nested');

  // A later commit is its own snapshot: the next call sees the new HEAD.
  await commitAs(world, 'human', { 'DIRECTION.md': 'the second direction\n' }, 'ratify');
  const after = await dispatch(home, world, 'read_world', { path: 'DIRECTION.md' });
  expect(after).toContain('the second direction');
});

it('read_world refuses a missing path, an unborn HEAD, a symlink, a committed directory, a gitlink and every escape', async () => {
  const { home, world } = await fixture();
  // Unborn HEAD first: the world exists, no commit does.
  const unborn = await dispatch(home, world, 'read_world', { path: 'anything.txt' });
  expect(unborn).toContain(WORLD_READ_FRAMING);
  expect(unborn).toContain('no commits');

  await commitAs(world, 'node-0', { 'real.txt': 'real\n', 'notes/deep.txt': 'nested\n' }, 'seed');
  const missing = await dispatch(home, world, 'read_world', { path: 'nope.txt' });
  expect(missing).toContain('no committed file');

  const file = await dispatch(home, world, 'read_world', { path: 'real.txt' });
  expect(file).toContain('real');

  // A COMMITTED DIRECTORY: `ls-tree` yields a tree entry (mode 040000), which
  // the read refuses — not a file.
  const directory = await dispatch(home, world, 'read_world', { path: 'notes' });
  expect(directory.startsWith(WORLD_READ_FRAMING)).toBe(true);
  expect(directory).toContain('is a directory in the committed tree');
  expect(directory).not.toContain('nested');

  // A symlink is a TREE MODE, not a filesystem read: the committed entry is
  // mode 120000 and is refused with a teaching line.
  await symlink('real.txt', join(world.path, 'link.txt'));
  await commitAs(world, 'node-0', {}, 'add a symlink');
  const linked = await dispatch(home, world, 'read_world', { path: 'link.txt' });
  expect(linked).toContain('symlink');

  // A gitlink/submodule entry (mode 160000) is a commit, not a blob: refused.
  await commitGitlink(world, 'vendor/module');
  const gitlinked = await dispatch(home, world, 'read_world', { path: 'vendor/module' });
  expect(gitlinked.startsWith(WORLD_READ_FRAMING)).toBe(true);
  expect(gitlinked).toContain('is a submodule entry in the committed tree');

  for (const path of ['/etc/passwd', '../escape', 'a/../b', 'a//b', './a', 'a/', 'a\\b', '']) {
    const refused = await dispatch(home, world, 'read_world', { path });
    expect(refused.startsWith(WORLD_READ_FRAMING)).toBe(true);
    expect(refused).toContain('refused');
  }
  expect(() => validateTreePath('a\x01b')).toThrow();
});

/**
 * Commits a submodule-shaped entry (mode 160000, type commit) via the index:
 * a gitlink need not resolve to an object in this repository. The entry is how
 * a real submodule appears in a tree, and it is what the read must refuse.
 */
async function commitGitlink(world: WorldRepo, path: string): Promise<void> {
  const identity: Record<string, string> = {
    GIT_AUTHOR_NAME: 'node-0', GIT_AUTHOR_EMAIL: 'node-0@world.local',
    GIT_COMMITTER_NAME: 'node-0', GIT_COMMITTER_EMAIL: 'node-0@world.local',
  };
  const oid = 'a'.repeat(40);
  await runGit(world.path, [
    ...world.gitBaseArgs(), 'update-index', '--add', '--cacheinfo', `160000,${oid},${path}`,
  ]);
  await runGit(world.path, [
    ...world.gitBaseArgs(), 'commit', '--quiet', '--message', 'add a submodule entry',
  ], identity);
}

it('read_world bounds the blob size and reports the bound', async () => {
  const { home, world } = await fixture();
  await commitAs(world, 'node-0', {
    'big.txt': 'x'.repeat(OVERLAY_WORLD_READ_MAX_BYTES + 10),
  }, 'seed');
  const result = await dispatch(home, world, 'read_world', { path: 'big.txt' });
  expect(result).toContain('refused');
  expect(result).toContain(String(OVERLAY_WORLD_READ_MAX_BYTES));
  expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(OVERLAY_TOOL_RESULT_BYTES);
});

it('world_log lists the last n commits newest-first, framed, and clamps n', async () => {
  const { home, world } = await fixture();
  await commitAs(world, 'node-2', { 'a.txt': 'a' }, 'first subject');
  await commitAs(world, 'human', { 'b.txt': 'b' }, 'second subject');
  await commitAs(world, 'node-3', { 'c.txt': 'c' }, 'third subject');

  const result = await dispatch(home, world, 'world_log', { n: 2 });
  expect(result.startsWith(WORLD_READ_FRAMING)).toBe(true);
  expect(result).toContain('third subject');
  expect(result).toContain('second subject');
  expect(result).not.toContain('first subject');
  expect(result).toContain('node-3');
  expect(result).toContain('human');

  // n is CLAMPED by a small constant: with 20 commits in the world, 999 still
  // reads exactly the newest 16 and never the whole history.
  for (let i = 0; i < 17; i += 1) {
    await commitAs(world, 'node-0', { [`bulk-${i}.txt`]: `${i}` }, `bulk commit ${i}`);
  }
  const clamped = await readWorldLog(world, 999);
  expect(clamped.kind).toBe('ok');
  if (clamped.kind === 'ok') {
    expect(clamped.entries).toHaveLength(16);
    // `git log` is newest-first: the kept window is bulk-16 down to bulk-1.
    expect(clamped.entries[0]!.subject).toBe('bulk commit 16');
    expect(clamped.entries[15]!.subject).toBe('bulk commit 1');
  }
  const clampedTool = await dispatch(home, world, 'world_log', { n: 999 });
  expect(clampedTool).toContain('bulk commit 16');
  expect(clampedTool).not.toContain('first subject');
  expect(Buffer.byteLength(clampedTool, 'utf8')).toBeLessThan(OVERLAY_TOOL_RESULT_BYTES);

  // An invalid n is a teaching error, not a crash.
  expect(await dispatch(home, world, 'world_log', { n: 0 })).toContain('error:');
});

it('world_log refuses an unborn HEAD and never writes the world', async () => {
  const { home, world } = await fixture();
  const unborn = await dispatch(home, world, 'world_log', {});
  expect(unborn).toContain('no commits');

  await commitAs(world, 'node-0', { 'a.txt': 'a' }, 'only commit');
  const head = await world.headHash();
  await dispatch(home, world, 'world_log', {});
  expect(await world.headHash()).toBe(head);
});

it('reads leave the world untouched and an unknown tool is a teaching refusal', async () => {
  const { home, world } = await fixture();
  await commitAs(world, 'node-0', { 'a.txt': 'a' }, 'seed');
  const head = await world.headHash();
  await dispatch(home, world, 'read_world', { path: 'a.txt' });
  await dispatch(home, world, 'world_log', {});
  expect(await world.headHash()).toBe(head);

  const unknown = await dispatch(home, world, 'execute', { cmd: 'rm -rf /' });
  expect(unknown).toContain('no tool named execute');
  expect(unknown).toContain('send_message, read_world and world_log');
  // Malformed arguments never crash the cycle.
  expect(await dispatch(home, world, 'send_message', 'not json')).toContain('error:');
  expect(await dispatch(home, world, 'read_world', '[]')).toContain('error:');
});

it('declares the overlay policy the tools bound under', () => {
  expect(OVERLAY_POLICY.maxToolResultBytes).toBe(OVERLAY_TOOL_RESULT_BYTES);
  expect(OVERLAY_POLICY.maxToolArgumentBytes).toBeGreaterThan(0);
  expect(OVERLAY_POLICY.requestTimeoutMs).toBe(120_000);
  expect(OVERLAY_POLICY.maxAttempts).toBe(2);
  expect(OVERLAY_POLICY.retryDelayMs).toBe(250);
});
