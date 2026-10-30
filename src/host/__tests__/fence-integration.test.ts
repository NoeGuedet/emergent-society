import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  mkdir, mkdtemp, readFile, rm, rmdir, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import { WorldRepo } from '../../node/world.js';
import { readWorldState } from '../../node/world-state.js';
import { HeadWatcher } from '../../node/watcher.js';
import { commitAs, serveJson, type LoopServer } from '../../node/__tests__/helpers.js';
import {
  killLeaves, nodeLeaf, resolveAnchor, thawSet,
} from '../cgroups.js';
import { createFencePort } from '../fence.js';
import { composeCell, type CellOptions } from '../host.js';
import { createHostLog, type HostLog } from '../observe.js';
import type { FenceOutcome, FencePort } from '../../node/index.js';

/**
 * The C2 acceptance at the composition root: the REAL cgroup fence against a
 * writer injected into the node leaf, and its negative control.
 *
 * The control is the injected no-op port the plan defines: the same cell, the
 * same writer, no freeze. Sampling the writer's file counter across the port's
 * acquire window is the oracle — a real fence freezes the counter, the fence-off
 * control lets it advance, so the control FAILS as intended. The real cgroup is
 * required; on a host without cgroup v2/freeze the case skips, never passes.
 *
 * The second case is the thaw-on-failure shell answer: an injected port that
 * refuses the first commit as `freeze-timeout` (a fake cgroupfs failure) and
 * succeeds afterwards, with a real shell turn on each side. The refused turn's
 * write stays in the tree, the next turn's shell runs and commits both.
 */

const anchor = resolveAnchor();

/** A writable user-owned child with freeze/events, probed once. */
async function freezeAvailable(): Promise<boolean> {
  if (anchor === null) return false;
  const probe = join(anchor, `.es-fence-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    await mkdir(probe);
    await writeFile(join(probe, 'cgroup.freeze'), '0');
    await readFile(join(probe, 'cgroup.events'), 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    await rmdir(probe).catch(() => {});
  }
}

const realCgroup = await freezeAvailable();

const config = validateAgentConfig({
  ...defaultAgentConfig(), model: 'first-light-test', heading: 'Fence.',
});

/** One line count in the counter file; a missing file is zero lines. */
async function counterLines(path: string): Promise<number> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '').length;
  } catch {
    return 0;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/** A writer process appending one line per 2 ms; joined into `leaf`. */
async function startWriter(leaf: string, counter: string): Promise<ChildProcess> {
  await writeFile(join(leaf, 'cgroup.procs'), '');
  const script = [
    "const fs=require('node:fs');",
    `const p=${JSON.stringify(counter)};`,
    "setInterval(()=>{try{fs.appendFileSync(p,'x\\n')}catch{}},2);",
  ].join('');
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('writer did not spawn');
  await writeFile(join(leaf, 'cgroup.procs'), String(pid));
  const deadline = Date.now() + 5000;
  for (;;) {
    const own = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => '');
    if (own.trim().endsWith(`/${leaf.split('/').pop() as string}`)) return child;
    if (Date.now() >= deadline) throw new Error('writer did not join the node leaf');
    await sleep(10);
  }
}

/**
 * A writer that leaves a torn file: it writes `BEGIN`, sleeps long enough for
 * the fence to catch it mid-write, then appends `END`. The fence freezes the
 * process at the acquire, so the commit stages the prefix; after the release
 * the writer finishes in the worktree. This is the BEGIN/middle/END harness for
 * the declared torn-write residual.
 */
async function startTornWriter(leaf: string, target: string): Promise<ChildProcess> {
  await mkdir(leaf, { recursive: true });
  const script = [
    "const fs=require('node:fs');",
    `const p=${JSON.stringify(target)};`,
    "fs.writeFileSync(p,'BEGIN\\n');",
    "setTimeout(()=>{try{fs.appendFileSync(p,'END\\n')}catch{}},2000);",
  ].join('');
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('torn writer did not spawn');
  await writeFile(join(leaf, 'cgroup.procs'), String(pid));
  const deadline = Date.now() + 5000;
  for (;;) {
    const own = await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => '');
    const content = await readFile(target, 'utf8').catch(() => '');
    if (own.trim().endsWith(`/${leaf.split('/').pop() as string}`) && content === 'BEGIN\n') {
      return child;
    }
    if (Date.now() >= deadline) throw new Error('torn writer did not reach its middle');
    await sleep(20);
  }
}

/** Samples the counter before and after the acquire window. */
function samplingPort(
  counter: string, inner: FencePort | null, samples: { before: number; after: number }[],
): FencePort {
  return {
    async acquire(): Promise<FenceOutcome> {
      const outcome: FenceOutcome = inner === null
        ? { fenced: true, leaves: 1 }
        : await inner.acquire();
      if (outcome.fenced) {
        const before = await counterLines(counter);
        await sleep(150);
        const after = await counterLines(counter);
        samples.push({ before, after });
      }
      return outcome;
    },
    async release(): Promise<void> {
      await inner?.release();
    },
  };
}

/** A composed cell on its own home, with one parked-turn run. */
async function runOneTurn(
  sandbox: CellOptions['sandbox'], fence: FencePort, log: HostLog,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'es-fence-cell-'));
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  const server: LoopServer = await serveJson(() => ({
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'idle' } }] }),
  }));
  try {
    const cell = await composeCell({
      home, uid: 'node-0', config,
      credential: {
        endpoint: `${server.url}/v1/chat/completions`, key: 'sentinel-llm-key',
        credentialId: 'llm',
      },
      providers: {}, sandbox, pollMs: 0, log, fence,
    });
    const running = cell.driver.run();
    await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
    cell.driver.stop('stop-requested');
    await running;
    await cell.close();
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
}

/** A fresh cell root under the anchor plus a writer inside its node leaf. */
async function fenceRoot(): Promise<{
  root: string; leaf: string; counter: string; writer: ChildProcess;
}> {
  const root = join(anchor as string, `.test-fence-${process.pid}-${Date.now().toString(36)}`);
  const leaf = nodeLeaf(root, 'node-0');
  await mkdir(leaf, { recursive: true });
  const counter = join(await mkdtemp(join(tmpdir(), 'es-fence-counter-')), 'counter.log');
  const writer = await startWriter(leaf, counter);
  return { root, leaf, counter, writer };
}

async function teardownFenceRoot(
  root: string, writer: ChildProcess, counter: string,
): Promise<void> {
  await thawSet([nodeLeaf(root, 'node-0')]);
  await killLeaves([nodeLeaf(root, 'node-0')]);
  writer.kill('SIGKILL');
  await rm(dirname(counter), { recursive: true, force: true });
  await rmdir(nodeLeaf(root, 'node-0')).catch(() => {});
  await rmdir(root).catch(() => {});
}

it.skipIf(!realCgroup)(
  'freezes a writer inside the node leaf during the commit (the fence-off control fails)', async () => {
    const log = createHostLog(() => {});

    // The control first: the same cell shape with an injected no-op port. The
    // writer must advance while the port pretends to hold it — the oracle is
    // sensitive, so the real run below is not a vacuous assertion.
    const control = await fenceRoot();
    const controlSamples: { before: number; after: number }[] = [];
    try {
      await runOneTurn(
        { cgroupRoot: control.root },
        samplingPort(control.counter, null, controlSamples),
        log,
      );
      expect(controlSamples).toHaveLength(1);
      expect(controlSamples[0]!.after).toBeGreaterThan(controlSamples[0]!.before);
    } finally {
      await teardownFenceRoot(control.root, control.writer, control.counter);
    }

    // The real port: the same writer is frozen by the cgroup, so the counter
    // does not advance inside the acquired window.
    const real = await fenceRoot();
    const realSamples: { before: number; after: number }[] = [];
    try {
      const realLog: string[] = [];
      const realHostLog = createHostLog((line) => realLog.push(line));
      await runOneTurn(
        { cgroupRoot: real.root },
        samplingPort(real.counter, createFencePort({
          root: real.root, uid: 'node-0', log: realHostLog,
        }), realSamples),
        realHostLog,
      );
      expect(realSamples).toHaveLength(1);
      expect(realSamples[0]!.after).toBe(realSamples[0]!.before);
      const fenceEvents = realLog
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry['event'] === 'host/fence');
      expect(fenceEvents).toEqual([
        expect.objectContaining({ state: 'fenced', leaves: 1 }),
      ]);
      expect(fenceEvents[0]!['ms']).toEqual(expect.any(Number));
      // The leaf is thawed after the port's release: the writer can move again.
      expect((await readFile(join(real.leaf, 'cgroup.freeze'), 'utf8')).trim()).toBe('0');
    } finally {
      await teardownFenceRoot(real.root, real.writer, real.counter);
    }
  }, 30_000);

it.skipIf(!realCgroup)(
  'commits the torn prefix a writer left before the freeze (the declared residual)', async () => {
    // The fence prevents mutation during staging, not a torn content produced
    // before the freeze. This harness exhibits exactly that: a writer is frozen
    // between BEGIN and END, the commit stages BEGIN, and HEAD keeps it after
    // the writer finishes in the worktree.
    const root = join(anchor as string, `.test-torn-${process.pid}-${Date.now().toString(36)}`);
    const leaf = nodeLeaf(root, 'node-0');
    await mkdir(leaf, { recursive: true });
    const home = await mkdtemp(join(tmpdir(), 'es-torn-'));
    let writer: ChildProcess | null = null;
    let server: LoopServer | null = null;
    try {
      const world = await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
      const target = join(home, 'world', 'torn.txt');
      writer = await startTornWriter(leaf, target);
      const heard: string[] = [];
      const real = createFencePort({ root, uid: 'node-0', log: createHostLog(() => {}) });
      const port: FencePort = {
        async acquire(): Promise<FenceOutcome> {
          const outcome = await real.acquire();
          if (outcome.fenced) heard.push(await readFile(target, 'utf8'));
          return outcome;
        },
        async release(): Promise<void> {
          await real.release();
        },
      };
      server = await serveJson(() => ({
        body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'idle' } }] }),
      }));
      const cell = await composeCell({
        home, uid: 'node-0', config,
        credential: {
          endpoint: `${server.url}/v1/chat/completions`, key: 'sentinel-llm-key',
          credentialId: 'llm',
        },
        providers: {}, sandbox: { cgroupRoot: root }, pollMs: 0,
        log: createHostLog(() => {}), fence: port,
      });
      const running = cell.driver.run();
      await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
      cell.driver.stop('stop-requested');
      await running;
      await cell.close();
      const show = (): string => execFileSync('git', [
        '--git-dir', join(home, 'world.git'), '--work-tree', join(home, 'world'),
        'show', 'HEAD:torn.txt',
      ], { encoding: 'utf8' });
      expect(heard).toEqual(['BEGIN\n']);
      expect(show()).toBe('BEGIN\n');
      const head = await world.headHash();
      expect(head).not.toBeNull();
      // The writer was frozen; on release it finishes the file in the worktree,
      // but HEAD keeps the torn prefix: the residual is declared, not repaired.
      await sleep(2200);
      expect(await readFile(target, 'utf8')).toBe('BEGIN\nEND\n');
      expect(show()).toBe('BEGIN\n');
    } finally {
      if (writer !== null) writer.kill('SIGKILL');
      await thawSet([leaf]).catch(() => {});
      await killLeaves([leaf]).catch(() => {});
      await rmdir(leaf).catch(() => {});
      await rmdir(root).catch(() => {});
      if (server !== null) await server.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

it('refuses a freeze failure, thaws, and the shell answers on the next turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'es-fence-thaw-'));
  await WorldRepo.init(join(home, 'world'), { gitDir: join(home, 'world.git') });
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  const seed = await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  const log = createHostLog(() => {});
  const attempts: { acquire: number; release: number } = { acquire: 0, release: 0 };
  const port: FencePort = {
    async acquire(): Promise<FenceOutcome> {
      attempts.acquire += 1;
      if (attempts.acquire === 1) {
        return { fenced: false, reason: 'freeze-failed', detail: 'freeze-timeout (fake cgroupfs)' };
      }
      return { fenced: true, leaves: 1 };
    },
    async release(): Promise<void> {
      attempts.release += 1;
    },
  };
  const server = await serveJson((_request, index) => {
    const replies = [
      { cmd: "printf 'one' > one.txt" },
      { content: 'idle' },
      { cmd: "printf 'two' > two.txt" },
      { content: 'idle' },
    ] as const;
    const reply = replies[index];
    const message = reply === undefined || 'content' in reply
      ? { role: 'assistant', content: 'idle' }
      : {
        role: 'assistant', content: null,
        tool_calls: [{ id: `e${index}`, type: 'function',
          function: { name: 'execute', arguments: JSON.stringify({ cmd: reply.cmd }) } }],
      };
    return { body: JSON.stringify({ choices: [{ message }] }) };
  });
  try {
    const cell = await composeCell({
      home, uid: 'node-0', config,
      credential: {
        endpoint: `${server.url}/v1/chat/completions`, key: 'sentinel-llm-key',
        credentialId: 'llm',
      },
      providers: {}, sandbox: false, pollMs: 0, log, fence: port,
    });
    const running = cell.driver.run();
    await vi.waitFor(() => expect(cell.driver.state).toBe('waiting'), { timeout: 10_000 });
    // First turn: the shell ran (its write is in the worktree), the commit was
    // refused as freeze-timeout, and no commit exists beyond the human seed.
    expect(await readFile(join(world.path, 'one.txt'), 'utf8')).toBe('one');
    expect(await world.headHash()).toBe(seed);
    expect((await readWorldState(home)).degraded).toBe(true);
    // Wake the node with a foreign commit; its next shell answers and commits.
    await commitAs(world, 'human', { 'human.txt': 'h' }, 'foreign');
    await HeadWatcher.for(world).check();
    await vi.waitFor(async () => {
      const logLines = await world.commitsForTurn(seed, 'node-0', 1);
      expect(logLines.length).toBe(1);
    }, { timeout: 10_000 });
    cell.driver.stop('stop-requested');
    await running;
    await cell.close();
    // The second commit carries both the refused turn's write and the new one:
    // the shell answered after the refusal, and the refusal was not a death.
    expect(await world.commitsForTurn(seed, 'node-0', 1)).toHaveLength(1);
    expect(await readFile(join(world.path, 'one.txt'), 'utf8')).toBe('one');
    expect(await readFile(join(world.path, 'two.txt'), 'utf8')).toBe('two');
    expect((await readWorldState(home)).degraded).toBe(false);
    expect(attempts.acquire).toBe(2);
    expect(attempts.release).toBe(2);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
