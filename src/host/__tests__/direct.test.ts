import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import {
  chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantProjection } from '../../context/contracts.js';
import { GATEWAY_ADDRESSEE, HUMAN_AUTHOR } from '../../journal/index.js';
import { ChatLog, CHAT_FILE, readChat } from '../chat.js';
import { ChatWatcher } from '../chat-watcher.js';
import { runCli } from '../cli.js';
import { DIRECT_UNCHANGED_NOTICE, runDirect } from '../direct.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';
import { ConversationLog } from '../../node/conversation.js';
import { readRatifiedDirection } from '../../node/direction.js';
import { WorldRepo, gitEnv } from '../../node/world.js';
import { commitAs, gitIn } from '../../node/__tests__/helpers.js';
import { GATEWAY_CHARTER_FILE } from '../../overlay/charter.js';
import { OverlayService } from '../../overlay/service.js';
import type { SendPlan, SendResult } from '../../provider/adapter.js';
import { delay } from '../../util.js';

/**
 * The `direct` operator command (G3): the human's two write acts.
 *
 * THE CHAT REPLY (the default): one `{v:0, at, uid:human, text}` record through
 * the existing ChatWriter under `<home>/.es/chat.lock`, the host's ChatWatcher
 * trigger cross-process, the absent-overlay wording, the 8192-byte/non-blank
 * cap, the batch twin's `--file` form — and NO world commit.
 *
 * THE RATIFICATION (`--path`): one commit authored the reserved `human`, built
 * from a fresh private index seeded at the current HEAD, the bytes hashed
 * through git stdin, the mode rule with the non-regular refusal, the treeOf
 * compare, the both-pairs identity (a hostile GIT_AUTHOR_NAME overridden), the
 * compare-and-swap with the whole-attempt re-seed, the materialize-first
 * ordering (the scar and the self-healing restore), the unchanged path that
 * materializes, the unborn-HEAD root commit, the post-CAS warning precedence —
 * plus the operator surface: the providers.json refusal by path AND inode, the
 * path escapes, the gates, the contended world lock, and the different-uid
 * bounded EACCES refusal.
 */

type Cell = { readonly root: string; readonly home: string; readonly world: WorldRepo };
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

/** One fresh initialized cell home (0700, world + world.git) under its temp root. */
async function cell(): Promise<Cell> {
  const root = await mkdtemp(join(tmpdir(), 'es-direct-'));
  const home = join(root, 'home');
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  roots.push(root);
  return { root, home, world };
}

type Sinks = { readonly out: string; readonly err: string; readonly code: number };

/** Runs one CLI line with the test's sinks. */
async function run(argv: readonly string[]): Promise<Sinks> {
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
  });
  return { code, out, err };
}

/** A real POSIX FIFO, no root required (util-linux `mkfifo`). */
function makeFifo(path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('mkfifo', [path], (err) => { if (err !== null) reject(err); else resolvePromise(); });
  });
}

/** Kills the flock helper AND the sleep it forked (they share the lock fd). */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** Writes one operator file outside the cell home and returns its absolute path. */
async function file(cell: Cell, name: string, content: string | Uint8Array): Promise<string> {
  const path = join(cell.root, name);
  await writeFile(path, content);
  return path;
}

/** `git ls-files --stage` as a map (the shared index's one snapshot). */
async function sharedIndex(cell: Cell): Promise<Map<string, string>> {
  const raw = await gitIn(cell.world, ['ls-files', '--stage', '-z']);
  const entries = new Map<string, string>();
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    entries.set(record.slice(tab + 1), record.slice(0, tab));
  }
  return entries;
}

/** The `ls-tree` mode of one committed path (the mode rule's proof). */
function treeMode(listing: string): string {
  return listing.trim().split(' ')[0] ?? '';
}

describe('the chat reply (the default act)', () => {
  it('appends one {v:0, at, uid: human, text} record through the ChatWriter', async () => {
    const fx = await cell();
    const code = await runDirect({
      home: fx.home, text: 'the direction is west', now: () => 424242,
      stdout: () => {}, stderr: () => {},
    });
    expect(code).toBe(0);
    expect(await readChat(fx.home)).toEqual([
      { v: 0, at: 424242, uid: HUMAN_AUTHOR, text: 'the direction is west' },
    ]);
    // 0600 under the chat lock; the world is untouched (no commit).
    expect((await stat(join(fx.home, CHAT_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(join(fx.home, '.es', 'chat.lock'))).isFile()).toBe(true);
    expect(await fx.world.headHash()).toBeNull();
    expect(await stat(join(fx.home, 'world', 'DIRECTION.md')).catch(() => null)).toBeNull();
  });

  it('prints the absent-overlay wording when no charter sidecar exists (the session\'s words)', async () => {
    const fx = await cell();
    const result = await run(['direct', '--home', fx.home, '--text', 'saved for later']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('saved: 1 uid: human chat record');
    expect(result.out).toContain('the chat log only, no world commit');
    expect(result.out).toContain(
      'saved; no overlay is running — the message will be digested when the overlay is configured');
    expect(result.err).toBe('');
  });

  it('says the overlay will digest it when the charter sidecar is present', async () => {
    const fx = await cell();
    await writeFile(join(fx.home, GATEWAY_CHARTER_FILE), 'You are the gateway overlay.\n',
      { mode: 0o600 });
    const result = await run(['direct', '--home', fx.home, '--text', 'hello']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('the overlay will digest it on its next cycle');
    expect(result.out).not.toContain('no overlay is running');
  });

  it('is the batch twin of typing: a --file message, one trailing terminator stripped', async () => {
    const fx = await cell();
    const message = await file(fx, 'msg.txt', 'from a file\n');
    const result = await run(['direct', '--home', fx.home, '--file', message]);
    expect(result.code).toBe(0);
    expect((await readChat(fx.home)).map((record) => [record.uid, record.text]))
      .toEqual([[HUMAN_AUTHOR, 'from a file']]);
  });

  it('is append-only and never truncates what is already there', async () => {
    const fx = await cell();
    expect((await run(['direct', '--home', fx.home, '--text', 'first'])).code).toBe(0);
    expect((await run(['direct', '--home', fx.home, '--text', 'second'])).code).toBe(0);
    expect((await readChat(fx.home)).map((record) => record.text)).toEqual(['first', 'second']);
  });

  it('caps the reply at 8192 bytes and refuses a blank one (exit 2, nothing written)', async () => {
    const fx = await cell();
    expect((await run(['direct', '--home', fx.home, '--text', 'x'.repeat(8192)])).code).toBe(0);
    const oversize = await run(['direct', '--home', fx.home, '--text', 'x'.repeat(8193)]);
    expect(oversize.code).toBe(2);
    expect(oversize.err).toContain('cannot exceed 8192 bytes');
    const blank = await run(['direct', '--home', fx.home, '--text', '   ']);
    expect(blank.code).toBe(2);
    expect(blank.err).toContain('cannot be blank');
    expect((await readChat(fx.home)).map((record) => record.text)).toEqual(['x'.repeat(8192)]);
  });

  it('triggers the host ChatWatcher cross-process (the size poll sees the human record)', async () => {
    const fx = await cell();
    const watcher = ChatWatcher.for(fx.home, 0);
    let notifications = 0;
    const off = watcher.subscribe(() => { notifications += 1; });
    try {
      await watcher.check();
      expect(notifications).toBe(0);
      expect((await run(['direct', '--home', fx.home, '--text', 'wake up'])).code).toBe(0);
      await watcher.check();
      expect(notifications).toBe(1);
      // The overlay's own record growth is not a human arrival.
      const chat = await ChatLog.open(fx.home);
      try {
        await chat.append(GATEWAY_ADDRESSEE, 'a delivery', 2);
        await watcher.check();
        expect(notifications).toBe(1);
      } finally {
        await chat.close();
      }
    } finally {
      off();
    }
  });

  it('a parked home: the saved reply is digested by the overlay\'s next boot cycle', async () => {
    const fx = await cell();
    await writeFile(join(fx.home, GATEWAY_CHARTER_FILE), 'You are the gateway overlay.\n',
      { mode: 0o600 });
    const sent = await run(['direct', '--home', fx.home, '--text', 'the direction is west']);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain('the overlay will digest it');
    // No host ran; the overlay's boot cycle digests the backlog (its windows)
    // and delivers its own record natively.
    const chat = await ChatLog.open(fx.home);
    const plans: SendPlan[] = [];
    const service = new OverlayService({
      home: fx.home,
      config: { model: 'test-model', charter: 'You are the gateway overlay.' },
      chat,
      conversation: ConversationLog.for(fx.home),
      world: { path: join(fx.home, 'world'), gitBaseArgs: () => [] },
      send: async (plan: SendPlan): Promise<SendResult> => {
        plans.push(plan);
        const message: AssistantProjection['message'] = {
          role: 'assistant', content: 'noted.', tool_calls: [],
        };
        return {
          kind: 'response',
          projection: { message, contentTruncated: false, frontierCall: 'call-1' },
        };
      },
      log: createHostLog(() => {}),
      pollMs: 0,
    });
    try {
      service.start();
      await service.idle();
      expect(plans).toHaveLength(1);
      expect(JSON.stringify(plans[0]!.history)).toContain('the direction is west');
      expect((await readChat(fx.home)).map((record) => [record.uid, record.text])).toEqual([
        [HUMAN_AUTHOR, 'the direction is west'],
        [GATEWAY_ADDRESSEE, 'noted.'],
      ]);
    } finally {
      await service.stop();
      await chat.close();
    }
  });
});

describe('the flag combinations (A6, strict)', () => {
  it('refuses --text with --file, neither, and --path with --text (exit 2, USAGE once)', async () => {
    const fx = await cell();
    const message = await file(fx, 'msg.txt', 'x');
    for (const argv of [
      ['direct', '--home', fx.home, '--text', 'a', '--file', message],
      ['direct', '--home', fx.home],
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--text', 'a'],
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md'],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.err).toContain('Usage:');
      expect(result.err.split('Usage:').length - 1).toBe(1);
    }
    // The ratification's --path never takes inline text: the file is required.
    const pathWithText = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--text', 'a']);
    expect(pathWithText.err).toContain('--path requires --file');
  });

  it('refuses path escapes in tree-path form before any world is opened', async () => {
    const fx = await cell();
    const message = await file(fx, 'msg.txt', 'x');
    for (const path of ['/etc/passwd', '../x', 'a/../b', './x', 'a//b', '', 'a\\b', 'x\u0001']) {
      const result = await run(
        ['direct', '--home', fx.home, '--path', path, '--file', message]);
      expect(result.code).toBe(2);
      expect(result.err).toContain('Usage:');
    }
    expect(await fx.world.headHash()).toBeNull();
  });

  it('refuses a missing home for both acts (exit 2)', async () => {
    const fx = await cell();
    const missing = join(fx.root, 'nope');
    const reply = await run(['direct', '--home', missing, '--text', 'a']);
    expect(reply.code).toBe(2);
    expect(reply.err).toContain('home does not exist');
    const message = await file(fx, 'msg.txt', 'x');
    const ratify = await run(
      ['direct', '--home', missing, '--path', 'DIRECTION.md', '--file', message]);
    expect(ratify.code).toBe(2);
    expect(ratify.err).toContain('home does not exist');
  });
});

describe('the ratification: the commit', () => {
  it('first ratify on an unborn HEAD: a ROOT commit authored human, not a parented one', async () => {
    const fx = await cell();
    const bytes = 'the direction is west\n';
    const message = await file(fx, 'DIRECTION.md', bytes);
    const result = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
    expect(result.code).toBe(0);
    const head = (await fx.world.headHash()) ?? '';
    expect(head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(result.out).toContain(`committed ${head} (author: human) DIRECTION.md`);
    // The root commit: exactly one parent line holding only the hash.
    const parents = (await gitIn(fx.world, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim();
    expect(parents).toBe(head);
    expect((await gitIn(fx.world, ['rev-list', '--count', 'HEAD'])).trim()).toBe('1');
    expect(await gitIn(fx.world, ['show', 'HEAD:DIRECTION.md'])).toBe(bytes);
    // The worktree copy is materialized with the exact validated bytes.
    expect(await readFile(join(fx.home, 'world', 'DIRECTION.md'), 'utf8')).toBe(bytes);
  });

  it('carries the author string and BOTH identity pairs, a hostile env overridden', async () => {
    const fx = await cell();
    const message = await file(fx, 'DIRECTION.md', 'v1\n');
    const saved = {
      author: process.env['GIT_AUTHOR_NAME'],
      authorEmail: process.env['GIT_AUTHOR_EMAIL'],
      committer: process.env['GIT_COMMITTER_NAME'],
      committerEmail: process.env['GIT_COMMITTER_EMAIL'],
    };
    process.env['GIT_AUTHOR_NAME'] = 'Mallory';
    process.env['GIT_AUTHOR_EMAIL'] = 'mallory@evil.test';
    process.env['GIT_COMMITTER_NAME'] = 'Mallory';
    process.env['GIT_COMMITTER_EMAIL'] = 'mallory@evil.test';
    try {
      const result = await run(
        ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
      expect(result.code).toBe(0);
    } finally {
      for (const [key, value] of [
        ['GIT_AUTHOR_NAME', saved.author], ['GIT_AUTHOR_EMAIL', saved.authorEmail],
        ['GIT_COMMITTER_NAME', saved.committer], ['GIT_COMMITTER_EMAIL', saved.committerEmail],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const identity = (await gitIn(fx.world, ['log', '-1', '--format=%an|%ae|%cn|%ce'])).trim();
    expect(identity).toBe('human|human@world.local|human|human@world.local');
    // The uid reservation is intact: the ratification is the one named bypass.
    const log = (await gitIn(fx.world, ['log', '-1', '--format=%an'])).trim();
    expect(log).toBe(HUMAN_AUTHOR);
  });

  it('NEVER lets node-dirty bytes ride the commit: only the ratified path is in its tree', async () => {
    const fx = await cell();
    await commitAs(fx.world, 'node-1', { 'a.txt': 'a\n' });
    await writeFile(join(fx.home, 'world', 'dirty.txt'), 'a node is still writing\n');
    const message = await file(fx, 'DIRECTION.md', 'v1\n');
    const result = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
    expect(result.code).toBe(0);
    const touched = (await gitIn(fx.world, ['show', '--pretty=format:', '--name-only', 'HEAD']))
      .split('\n').filter((line) => line !== '');
    expect(touched).toEqual(['DIRECTION.md']);
    // The untracked node file is untouched and still outside the history.
    expect(await readFile(join(fx.home, 'world', 'dirty.txt'), 'utf8'))
      .toBe('a node is still writing\n');
    await expect(gitIn(fx.world, ['show', 'HEAD:dirty.txt'])).rejects.toThrow();
  });

  it('stages exactly one shared-index entry (the shared index is unchanged except one)', async () => {
    const fx = await cell();
    await commitAs(fx.world, 'node-1', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const before = await sharedIndex(fx);
    const message = await file(fx, 'DIRECTION.md', 'v1\n');
    const result = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
    expect(result.code).toBe(0);
    const after = await sharedIndex(fx);
    const added = [...after.keys()].filter((path) => !before.has(path));
    expect(added).toEqual(['DIRECTION.md']);
    expect(after.get('DIRECTION.md')).toMatch(/^100644 [0-9a-f]{40,64} 0$/);
    for (const path of before.keys()) expect(after.get(path)).toBe(before.get(path));
    expect([...before.keys()].sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('re-seeds the whole attempt on CAS contention: a peer landing becomes the parent', async () => {
    const fx = await cell();
    await commitAs(fx.world, 'node-1', { 'base.txt': 'base\n' });
    const message = await file(fx, 'DIRECTION.md', 'v1\n');
    let peer = '';
    let interleaves = 0;
    const code = await runDirect({
      home: fx.home,
      path: 'DIRECTION.md',
      file: message,
      stdout: () => {},
      stderr: () => {},
      beforePublish: async (parent) => {
        if (interleaves > 0) return;
        interleaves += 1;
        // A live turn lands between THIS attempt's HEAD read and its update-ref.
        peer = await commitAs(fx.world, 'node-2', { 'peer.txt': 'peer\n' });
        expect(parent).not.toBeNull();
      },
    });
    expect(code).toBe(0);
    expect(interleaves).toBe(1);
    const head = (await fx.world.headHash()) ?? '';
    // The peer commit is the ratification's PARENT: never overwritten.
    expect((await gitIn(fx.world, ['rev-parse', `${head}^`])).trim()).toBe(peer);
    expect(await gitIn(fx.world, ['show', 'HEAD:peer.txt'])).toBe('peer\n');
    expect(await gitIn(fx.world, ['show', 'HEAD:DIRECTION.md'])).toBe('v1\n');
    expect((await gitIn(fx.world, ['log', '--format=%s'])).trim().split('\n'))
      .toEqual(['ratify DIRECTION.md', 'foreign turn', 'foreign turn']);
  });

  it('materialize-first: a peer add --all inside the window writes the scar; the next one heals it', async () => {
    const fx = await cell();
    await commitAs(fx.world, 'node-1', { 'base.txt': 'base\n' });
    const message = await file(fx, 'DIRECTION.md', 'ratified\n');
    let scar = '';
    const code = await runDirect({
      home: fx.home,
      path: 'DIRECTION.md',
      file: message,
      stdout: () => {},
      stderr: () => {},
      afterPublish: async () => {
        // The CAS has landed; the worktree copy has NOT been renamed yet. A
        // concurrent node's add --all builds its tree from the shared index,
        // which has never known the human's new path, so its commit's tree
        // lacks it: the scar. (The NEXT add --all stages the worktree file.)
        scar = await commitAs(fx.world, 'node-2', {});
      },
    });
    expect(code).toBe(0);
    expect(scar).not.toBe('');
    // The scar commit's tree dropped the human's path.
    await expect(gitIn(fx.world, ['cat-file', '-e', `${scar}:DIRECTION.md`]))
      .rejects.toThrow();
    // The worktree keeps the file (the rename happened immediately after).
    expect(await readFile(join(fx.home, 'world', 'DIRECTION.md'), 'utf8')).toBe('ratified\n');
    // SELF-HEALING: the next add --all stages the worktree file again and the
    // restored tree carries the human's bytes.
    const healed = await commitAs(fx.world, 'node-3', {});
    expect(await gitIn(fx.world, ['show', `${healed}:DIRECTION.md`])).toBe('ratified\n');
  });

  it('post-CAS precedence: a failed materialization warns and still exits 0, staging skipped', async () => {
    const fx = await cell();
    const message = await file(fx, 'd.md', 'v1\n');
    let commit = '';
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDirect({
      home: fx.home,
      path: 'nested/x.md',
      file: message,
      stdout: (text) => { out.push(text); },
      stderr: (text) => { err.push(text); },
      afterPublish: async (hash) => {
        commit = hash;
        // The target becomes a directory after the CAS: the rename cannot land.
        await mkdir(join(fx.home, 'world', 'nested', 'x.md'), { recursive: true });
      },
    });
    expect(code).toBe(0);
    expect(out.join('')).toContain(`committed ${commit}`);
    expect(err.join('')).toContain('the worktree copy was not materialized');
    expect(err.join('')).toContain('index staging skipped when the rename failed');
    // The commit landed; the shared index was NOT staged for the failed target.
    expect(await gitIn(fx.world, ['show', `HEAD:nested/x.md`])).toBe('v1\n');
    expect((await sharedIndex(fx)).has('nested/x.md')).toBe(false);
  });

  it('the UNCHANGED path materializes a diverged worktree, then says the pin did not move', async () => {
    const fx = await cell();
    const message = await file(fx, 'DIRECTION.md', 'v1\n');
    expect((await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message])).code).toBe(0);
    const first = await fx.world.headHash();
    // The worktree copy is gone (a deletion would be left to the next node
    // commit): ratifying the SAME bytes restores it and commits nothing.
    await rm(join(fx.home, 'world', 'DIRECTION.md'));
    const again = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
    expect(again.code).toBe(0);
    expect(again.out).toContain(DIRECT_UNCHANGED_NOTICE);
    expect(again.out).toContain('the worktree copy was restored');
    expect(await fx.world.headHash()).toBe(first);
    expect(await readFile(join(fx.home, 'world', 'DIRECTION.md'), 'utf8')).toBe('v1\n');
    // And the plain unchanged case: no worktree movement, the same sentence.
    const plain = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain(DIRECT_UNCHANGED_NOTICE);
    expect(plain.out).not.toContain('worktree copy was restored');
  });

  it('the unchanged branch warns honestly: no commit landed, the pin is unchanged', async () => {
    const fx = await cell();
    const message = await file(fx, 'DIRECTION.md', 'v1\n');
    expect((await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message])).code).toBe(0);
    const head = await fx.world.headHash();
    // The worktree path becomes a directory: the unchanged path cannot repair
    // it, and its warning must not claim a commit landed (there is no commit).
    await rm(join(fx.home, 'world', 'DIRECTION.md'));
    await mkdir(join(fx.home, 'world', 'DIRECTION.md'));
    const again = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
    expect(again.code).toBe(0);
    expect(again.out).toContain(DIRECT_UNCHANGED_NOTICE);
    expect(again.err).toContain('the worktree copy was not materialized');
    expect(again.err).toContain('the pin is unchanged');
    expect(again.err).not.toContain('commit landed');
    expect(again.err).not.toContain('index staging skipped');
    expect(await fx.world.headHash()).toBe(head);
  });

  it('preserves a 100755 entry: the materialized copy is executable, no mode flip staged', async () => {
    const fx = await cell();
    const script = join(fx.home, 'world', 'run.sh');
    await writeFile(script, '#!/bin/sh\necho draft\n');
    await chmod(script, 0o755);
    await commitAs(fx.world, 'node-1', {});
    expect(treeMode(await gitIn(fx.world, ['ls-tree', 'HEAD', '--', 'run.sh']))).toBe('100755');
    const bytes = '#!/bin/sh\necho ratified\n';
    const message = await file(fx, 'run.sh', bytes);
    const result = await run(
      ['direct', '--home', fx.home, '--path', 'run.sh', '--file', message]);
    expect(result.code).toBe(0);
    expect((await stat(script)).mode & 0o111).not.toBe(0);
    expect(treeMode(await gitIn(fx.world, ['ls-tree', 'HEAD', '--', 'run.sh']))).toBe('100755');
    expect(await gitIn(fx.world, ['show', 'HEAD:run.sh'])).toBe(bytes);
    // The next node add --all stages NOTHING: the worktree's exec bit matches
    // the ratified mode, so no `mode change 100755 => 100644` is invented.
    await gitIn(fx.world, ['add', '--all']);
    expect((await gitIn(fx.world, ['diff', '--cached', '--raw', '-z'])).trim()).toBe('');
    const staged = await sharedIndex(fx);
    expect(staged.get('run.sh')).toMatch(/^100755 /);
  });

  it('refuses a committed NON-REGULAR entry (symlink 120000 and gitlink 160000)', async () => {
    const fx = await cell();
    await commitAs(fx.world, 'node-1', { 'a.txt': 'a\n' });
    await symlink('a.txt', join(fx.home, 'world', 'link.md'));
    await commitAs(fx.world, 'node-1', {});
    expect(treeMode(await gitIn(fx.world, ['ls-tree', 'HEAD', '--', 'link.md']))).toBe('120000');
    const message = await file(fx, 'd.md', 'v1\n');
    const before = await fx.world.headHash();
    const symlinkRefusal = await run(
      ['direct', '--home', fx.home, '--path', 'link.md', '--file', message]);
    expect(symlinkRefusal.code).toBe(2);
    expect(symlinkRefusal.err).toContain('symlink in the committed tree (mode 120000)');
    expect(await fx.world.headHash()).toBe(before);

    // A gitlink, seeded through the plumbing (the same teaching refusal).
    const base = before ?? '';
    await gitIn(fx.world, [
      'update-index', '--add', '--cacheinfo', '160000', base, 'sub']);
    const tree = (await gitIn(fx.world, ['write-tree'])).trim();
    const env = gitEnv({
      GIT_AUTHOR_NAME: 'node-1', GIT_AUTHOR_EMAIL: 'node-1@world.local',
      GIT_COMMITTER_NAME: 'node-1', GIT_COMMITTER_EMAIL: 'node-1@world.local',
    });
    const gitlinkCommit = (await gitIn(
      fx.world, ['commit-tree', tree, '-p', base, '-m', 'gitlink'], env)).trim();
    await gitIn(fx.world, ['update-ref', 'refs/heads/main', gitlinkCommit, base]);
    expect(treeMode(await gitIn(fx.world, ['ls-tree', 'HEAD', '--', 'sub']))).toBe('160000');
    const gitlinkRefusal = await run(
      ['direct', '--home', fx.home, '--path', 'sub', '--file', message]);
    expect(gitlinkRefusal.code).toBe(2);
    expect(gitlinkRefusal.err).toContain('submodule entry in the committed tree (mode 160000)');
    expect(await fx.world.headHash()).toBe(gitlinkCommit);
  });

  it('honors the pin: readRatifiedDirection reads the ratification commit', async () => {
    const fx = await cell();
    const message = await file(fx, 'DIRECTION.md', 'the ratified heading\n');
    const result = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
    expect(result.code).toBe(0);
    const head = (await fx.world.headHash()) ?? '';
    const pin = await readRatifiedDirection(fx.world);
    expect(pin).toEqual({ commit: head, text: 'the ratified heading\n' });
  });

  it('materializes a nested tree path, creating its parent chain (no-follow)', async () => {
    const fx = await cell();
    const message = await file(fx, 'plan.md', 'a nested plan\n');
    const result = await run(
      ['direct', '--home', fx.home, '--path', 'notes/2026/plan.md', '--file', message]);
    expect(result.code).toBe(0);
    expect(await readFile(join(fx.home, 'world', 'notes/2026/plan.md'), 'utf8'))
      .toBe('a nested plan\n');
    expect(await gitIn(fx.world, ['show', 'HEAD:notes/2026/plan.md'])).toBe('a nested plan\n');
  });
});

describe('the pinned operator source read', () => {
  it('pins the source parent: a post-pin swap cannot redirect the committed bytes', async () => {
    const fx = await cell();
    const outside = join(fx.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'msg.md'), 'canary bytes\n');
    await mkdir(join(fx.home, 'world', 'sub', 'deep'), { recursive: true });
    await writeFile(join(fx.home, 'world', 'sub', 'deep', 'msg.md'), 'world bytes\n');
    let pins = 0;
    const code = await runDirect({
      home: fx.home,
      path: 'notes/msg.md',
      file: join(fx.home, 'world', 'sub', 'deep', 'msg.md'),
      stdout: () => {},
      stderr: () => {},
      afterPinned: async ({ fd }) => {
        pins += 1;
        // The seam receives the FINAL parent fd, not the intermediate `sub`.
        expect(await realpath(`/proc/self/fd/${String(fd)}`))
          .toBe(join(fx.home, 'world', 'sub', 'deep'));
        // After the final parent pin: the fd authority must survive the swap.
        await rename(
          join(fx.home, 'world', 'sub', 'deep'), join(fx.home, 'world', 'sub', 'deep.pinned'));
        await symlink(outside, join(fx.home, 'world', 'sub', 'deep'));
      },
    });
    expect(code).toBe(0);
    expect(pins).toBe(1);
    expect(await gitIn(fx.world, ['show', 'HEAD:notes/msg.md'])).toBe('world bytes\n');
    expect(await readFile(join(outside, 'msg.md'), 'utf8')).toBe('canary bytes\n');
  });

  it('refuses a PRE-pin symlink parent; a post-pin swap saves the pinned world bytes', async () => {
    const fx = await cell();
    const outside = join(fx.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'msg.txt'), 'canary reply\n');
    // PRE-pin: the attacker's parent is already a symlink when the walk starts.
    await symlink(outside, join(fx.home, 'world', 'bad'));
    let preErr = '';
    const refused = await runDirect({
      home: fx.home,
      file: join(fx.home, 'world', 'bad', 'msg.txt'),
      stdout: () => {},
      stderr: (text) => { preErr += text; },
    });
    expect(refused).toBe(2);
    expect(preErr).toContain('unsafe parent component');
    expect(await stat(join(fx.home, CHAT_FILE)).catch(() => null)).toBeNull();

    // POST-pin: the reply saves the pinned world bytes, never the canary.
    await mkdir(join(fx.home, 'world', 'good'));
    await writeFile(join(fx.home, 'world', 'good', 'msg.md'), 'pinned reply\n');
    let pins = 0;
    const code = await runDirect({
      home: fx.home,
      file: join(fx.home, 'world', 'good', 'msg.md'),
      stdout: () => {},
      stderr: () => {},
      afterPinned: async () => {
        pins += 1;
        await rename(join(fx.home, 'world', 'good'), join(fx.home, 'world', 'good.pinned'));
        await symlink(outside, join(fx.home, 'world', 'good'));
      },
    });
    expect(code).toBe(0);
    expect(pins).toBe(1);
    expect((await readChat(fx.home)).map((record) => record.text)).toEqual(['pinned reply']);
    expect(await readFile(join(outside, 'msg.txt'), 'utf8')).toBe('canary reply\n');
  });

  it('refuses a real FIFO source promptly, never opening it (no hang)', { timeout: 5000 }, async () => {
    const fx = await cell();
    const fifo = join(fx.home, 'world', 'pipe.fifo');
    await makeFifo(fifo);
    let err = '';
    const code = await runDirect({
      home: fx.home,
      file: fifo,
      stdout: () => {},
      stderr: (text) => { err += text; },
    });
    expect(code).toBe(2);
    expect(err).toContain('is not a regular file');
    expect(await stat(join(fx.home, CHAT_FILE)).catch(() => null)).toBeNull();
  });

  it('refuses an external alias that enters the world then leaves it (exit 2)', async () => {
    const fx = await cell();
    const outside = join(fx.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'msg.txt'), 'canary bytes\n');
    // The input is lexically external; the alias points back into the world.
    const alias = join(fx.root, 'alias');
    await symlink(join(fx.home, 'world'), alias);
    await symlink(outside, join(fx.home, 'world', 'esc'));
    let err = '';
    const code = await runDirect({
      home: fx.home,
      file: join(alias, 'esc', 'msg.txt'),
      stdout: () => {},
      stderr: (text) => { err += text; },
    });
    expect(code).toBe(2);
    expect(err).toContain('unsafe parent component');
    expect(await stat(join(fx.home, CHAT_FILE)).catch(() => null)).toBeNull();
    expect(await readFile(join(outside, 'msg.txt'), 'utf8')).toBe('canary bytes\n');
  });

  it('the reply still saves an EXTERNAL source on a home with no healthy world', async () => {
    const root = await mkdtemp(join(tmpdir(), 'es-direct-bare-'));
    roots.push(root);
    const home = join(root, 'home');
    await mkdir(home, { mode: 0o700 });
    await chmod(home, 0o700);
    const message = join(root, 'msg.md');
    await writeFile(message, 'still saved\n');
    const code = await runDirect({
      home, file: message, stdout: () => {}, stderr: () => {},
    });
    expect(code).toBe(0);
    expect((await readChat(home)).map((record) => record.text)).toEqual(['still saved']);
  });

  it('a /proc-unavailable source read refuses the reply before the chat write (exit 2)', async () => {
    const fx = await cell();
    const message = await file(fx, 'msg.md', 'hello\n');
    let err = '';
    const code = await runDirect({
      home: fx.home,
      file: message,
      procRoot: join(fx.root, 'no-proc'),
      stdout: () => {},
      stderr: (text) => { err += text; },
    });
    expect(code).toBe(2);
    expect(err).toContain('pinned read is unavailable');
    expect(await stat(join(fx.home, CHAT_FILE)).catch(() => null)).toBeNull();
  });

  it('the ratification gives procRoot only to the post-CAS materialize (exit 0, named warning)', async () => {
    const fx = await cell();
    const bytes = 'landed without a proc root\n';
    const message = await file(fx, 'DIRECTION.md', bytes);
    let out = '';
    let err = '';
    const code = await runDirect({
      home: fx.home,
      path: 'DIRECTION.md',
      file: message,
      procRoot: join(fx.root, 'no-proc'),
      stdout: (text) => { out += text; },
      stderr: (text) => { err += text; },
    });
    expect(code).toBe(0);
    const head = (await fx.world.headHash()) ?? '';
    expect(head).toMatch(/^[0-9a-f]{40,64}$/);
    // The source read ran on the real /proc, so the CAS landed. Only the pinned
    // worktree materialization saw the fake root and degraded to a warning.
    expect(out).toContain(`committed ${head} (author: human) DIRECTION.md`);
    expect(err).toContain('the worktree copy was not materialized');
    expect(err).toContain('proc-unavailable');
    expect(await gitIn(fx.world, ['show', 'HEAD:DIRECTION.md'])).toBe(bytes);
    expect(await stat(join(fx.home, 'world', 'DIRECTION.md')).catch(() => null)).toBeNull();
  });

  it('the legacy symlinked world root still ratifies through the pinned canonical root', async () => {
    const fx = await cell();
    const real = join(fx.home, 'real-world');
    await rename(join(fx.home, 'world'), real);
    await symlink(real, join(fx.home, 'world'));
    await writeFile(join(real, 'msg.md'), 'alias bytes\n');
    const code = await runDirect({
      home: fx.home,
      path: 'DIRECTION.md',
      file: join(fx.home, 'world', 'msg.md'),
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(await gitIn(fx.world, ['show', 'HEAD:DIRECTION.md'])).toBe('alias bytes\n');
    expect(await readFile(join(real, 'DIRECTION.md'), 'utf8')).toBe('alias bytes\n');
  });
});

describe('the operator surface: guards and gates', () => {
  it('refuses the providers store by PATH and by INODE (both acts)', async () => {
    const fx = await cell();
    const providers = join(fx.home, 'providers.json');
    await writeFile(providers, '{"llm":{"key":"SECRET"}}\n', { mode: 0o600 });
    const byPath = await run(['direct', '--home', fx.home, '--file', providers]);
    expect(byPath.code).toBe(2);
    expect(byPath.err).toContain('refusing the providers store');
    const hardlink = join(fx.root, 'innocent.txt');
    await link(providers, hardlink);
    const byInode = await run(['direct', '--home', fx.home, '--file', hardlink]);
    expect(byInode.code).toBe(2);
    expect(byInode.err).toContain('refusing the providers store');
    const ratify = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', providers]);
    expect(ratify.code).toBe(2);
    expect(ratify.err).toContain('refusing the providers store');
    // The SAME inode refusal through the ratification's own read (a hardlink
    // has a different path and the store's (dev, ino)).
    const ratifyInode = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', hardlink]);
    expect(ratifyInode.code).toBe(2);
    expect(ratifyInode.err).toContain('refusing the providers store');
    expect(await fx.world.headHash()).toBeNull();
    expect(await stat(join(fx.home, CHAT_FILE)).catch(() => null)).toBeNull();
    expect(await stat(join(fx.home, 'world', 'DIRECTION.md')).catch(() => null)).toBeNull();
  });

  it('refuses a non-regular or symlinked --file (the read discipline)', async () => {
    const fx = await cell();
    const real = await file(fx, 'real.txt', 'hello\n');
    const linked = join(fx.root, 'linked.txt');
    await symlink(real, linked);
    const symlinked = await run(['direct', '--home', fx.home, '--file', linked]);
    expect(symlinked.code).toBe(2);
    expect(symlinked.err).toContain('is not a regular file');
    const missing = await run(['direct', '--home', fx.home, '--file', join(fx.root, 'nope.txt')]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('could not read the message file');
    // A non-UTF-8 file is refused, never rewritten into replacement characters.
    const invalid = await file(fx, 'invalid.md', Buffer.from([0xff, 0xfe, 0x00]));
    const badEncoding = await run(
      ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', invalid]);
    expect(badEncoding.code).toBe(2);
    expect(badEncoding.err).toContain('is not valid UTF-8');
    expect(await fx.world.headHash()).toBeNull();
  });

  it('refuses the legacy in-world .git layout with the migration recipe (exit 2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'es-direct-legacy-'));
    const home = join(root, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    await mkdir(join(home, 'world'));
    await mkdir(join(home, 'world', '.git'));
    roots.push(root);
    const message = join(root, 'd.md');
    await writeFile(message, 'v1\n');
    const result = await run(
      ['direct', '--home', home, '--path', 'DIRECTION.md', '--file', message]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('a legacy world whose .git lives inside the world must be migrated');
    expect(await stat(join(home, 'world', 'DIRECTION.md')).catch(() => null)).toBeNull();
  });

  it('the refused-turn cost: a held world lock refuses typed, and the retry lands once released', async () => {
    const fx = await cell();
    await mkdir(join(fx.home, '.es'), { recursive: true, mode: 0o700 });
    const lock = join(fx.home, '.es', 'world.lock');
    // Its own process group: flock forks the sleep that inherits the lock fd,
    // so the group is the unit that must die (the kernel's own rule).
    const holder = spawn('flock', [lock, 'sleep', '5'], { stdio: 'ignore', detached: true });
    try {
      // Give flock its acquisition, then hold it across direct's four attempts.
      await delay(200);
      const message = await file(fx, 'd.md', 'v1\n');
      const refused = await run(
        ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('the world is busy');
      expect(await fx.world.headHash()).toBeNull();
      killGroup(holder.pid);
      await delay(200);
      // The contention is transient: the same act lands once the peer releases.
      const landed = await run(
        ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
      expect(landed.code).toBe(0);
      expect(landed.out).toContain('committed');
    } finally {
      killGroup(holder.pid);
    }
  });

  it('the --path gates refuse a permissive home (exit 2) while the reply still saves', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const fx = await cell();
    await chmod(fx.home, 0o755);
    try {
      // The reply act does not run the world gates: its surface is the chat log.
      const reply = await run(['direct', '--home', fx.home, '--text', 'still saved']);
      expect(reply.code).toBe(0);
      expect((await readChat(fx.home)).map((record) => record.text)).toEqual(['still saved']);
      // The ratification does: assertHomePermissions refuses BEFORE any read or
      // write, and a foreign-owned home takes the same branch (uid mismatch).
      const message = await file(fx, 'd.md', 'v1\n');
      const ratify = await run(
        ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
      expect(ratify.code).toBe(2);
      expect(ratify.err).toContain('home must be owned by the host uid with mode 0700');
      expect(await fx.world.headHash()).toBeNull();
      expect(await stat(join(fx.home, 'world', 'DIRECTION.md')).catch(() => null)).toBeNull();
    } finally {
      await chmod(fx.home, 0o700);
    }
  });

  it('the --path gates refuse a foreign-owned home (the uid branch, exit 2)', async () => {
    const fx = await cell();
    const real = process.getuid?.() ?? 1000;
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(real + 424242);
    try {
      const message = await file(fx, 'd.md', 'v1\n');
      const result = await run(
        ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
      expect(result.code).toBe(2);
      expect(result.err).toContain('home must be owned by the host uid with mode 0700');
      expect(await fx.world.headHash()).toBeNull();
      expect(await stat(join(fx.home, 'world', 'DIRECTION.md')).catch(() => null)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('an unwritable same-uid home: bounded refusals (exit 1), never a raw errno', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const fx = await cell();
    await chmod(fx.home, 0o500);
    try {
      const reply = await run(['direct', '--home', fx.home, '--text', 'hi']);
      expect(reply.code).toBe(1);
      expect(reply.err).toContain('kernel-owned lock sidecar');
      expect(reply.err).not.toContain(fx.home);
      const message = await file(fx, 'd.md', 'v1\n');
      const ratify = await run(
        ['direct', '--home', fx.home, '--path', 'DIRECTION.md', '--file', message]);
      expect(ratify.code).toBe(1);
      expect(ratify.err).toContain('a home owned by the running uid');
      expect(ratify.err).not.toContain(fx.home);
    } finally {
      await chmod(fx.home, 0o700);
    }
  });
});
