import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import type { AgentConfig } from '../../context/contracts.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { ContextFold } from '../../context/fold.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { commitAs, serveJson } from '../../node/__tests__/helpers.js';
import { HeadWatcher } from '../../node/watcher.js';
import { WorldRepo } from '../../node/world.js';
import { identityBudget, identityBytes } from '../../node/identity-budget.js';
import { startHost, type HostDeps, type HostHandle, type HostOptions } from '../host.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';

/**
 * The host side of `update_self` (plan §0.5/§0.7): the spawn-side admission
 * seam, the live-identity inheritance of a child, and restart durability
 * through the node-local journal.
 *
 * One home, one world, one frontier; the only network is the loopback fake
 * provider. The spawn-side budget case injects the requester's near-boundary
 * identity (exactly ten canonical bytes below the derived budget) through the
 * test-only config seam. That identity is UNDER the START budget, so the START
 * seam admits it; the seam pins the exact canonical size so the spawn-side
 * refusal — the longer composer sentence crossing the budget — is exercised at
 * the boundary without composing a real boot.
 */

const dirs: string[] = [];
const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const deps: HostDeps = {
  installSignals: false, keepAlive: false,
  attachToCell: async () => ({ ok: false as const, reason: 'test-stub' }),
  freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
};

type Reply = { readonly content?: string; readonly tool?: { readonly name: string; readonly args: unknown } };

function respond(reply: Reply): { body: string } {
  if (reply.tool === undefined) {
    return { body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.content ?? 'idle' } }] }) };
  }
  return {
    body: JSON.stringify({
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'e0', type: 'function',
            function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
          }],
        },
      }],
    }),
  };
}

async function initFixture(): Promise<{ home: string; world: WorldRepo }> {
  const home = await mkdtemp(join(tmpdir(), 'es-self-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  return { home, world };
}

async function providers(home: string, url: string): Promise<void> {
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: { key: 'k', endpoint: `${url}/v1/chat/completions` },
  }), { encoding: 'utf8', mode: 0o600 });
}

async function writeNodes(home: string, entries: readonly Record<string, unknown>[]): Promise<string> {
  const path = join(home, 'nodes.json');
  await writeFile(path, JSON.stringify(entries), 'utf8');
  return path;
}

type HostEvent = {
  readonly event: string;
  readonly uid?: string; readonly requester?: string; readonly model?: string;
};

function hostEvents(lines: readonly string[]): HostEvent[] {
  return lines.map((line) => JSON.parse(line) as HostEvent);
}

function boot(
  home: string, command: 'start' | 'resume', nodesFile: string,
  lines: string[], more: Partial<HostDeps> = {},
): HostHandle {
  const options: HostOptions = {
    home, uid: 'node-0', command, sandbox: false, nodesFile,
    log: createHostLog((line) => lines.push(line)),
  };
  return startHost(options, { ...deps, ...more });
}

async function localEvents(home: string, uid: string) {
  return loadVerifiedEvents(home, uid, C13_EVENT_TYPES);
}

async function foldedConfig(home: string, uid: string): Promise<AgentConfig | null> {
  const fold = new ContextFold();
  await fold.observe(await localEvents(home, uid));
  return fold.snapshot().config?.value ?? null;
}

async function resultTexts(home: string, uid: string): Promise<string[]> {
  return (await localEvents(home, uid))
    .filter((event) => event.type === 'tool/result')
    .map((event) => (event.data as { message?: { content?: string } }).message?.content ?? '');
}

it('composes the next child from the requester\'s live rewritten identity', async () => {
  const { home, world } = await initFixture();
  await commitAs(world, 'human', { 'new-charter.md': 'the rewritten charter' }, 'world charter');
  let rootRequests = 0;
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    if (body.includes('You are node-1, composed by node-0.')) return respond({ content: 'child idle' });
    rootRequests += 1;
    if (rootRequests === 1) {
      return respond({
        tool: {
          name: 'extend',
          args: { verb: 'update_self', heading: 'Rewritten lead.', path: 'new-charter.md' },
        },
      });
    }
    if (rootRequests === 2) return respond({ tool: { name: 'extend', args: { verb: 'spawn' } } });
    return respond({ content: 'root idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, 'start', nodesFile, lines);
  await vi.waitFor(() => {
    expect(hostEvents(lines).filter((event) => event.event === 'host/spawned')).toHaveLength(1);
  }, { timeout: 30_000 });
  await vi.waitFor(async () => {
    expect((await foldedConfig(home, 'node-1')) !== null).toBe(true);
    expect((await resultTexts(home, 'node-0')).some((text) => text.startsWith('spawned node-1')))
      .toBe(true);
  }, { timeout: 30_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  // The requester's journaled identity is the rewritten one.
  const root = await foldedConfig(home, 'node-0');
  expect(root?.heading).toBe('Rewritten lead.');
  expect(root?.charter).toBe('the rewritten charter You are node-0.');
  // The child was composed from that LIVE identity, not the boot snapshot: it
  // inherits the rewritten heading and charter and gets the composer sentence.
  const child = await foldedConfig(home, 'node-1');
  expect(child?.heading).toBe('Rewritten lead.');
  expect(child?.charter).toBe('the rewritten charter You are node-1, composed by node-0.');
  expect(hostEvents(lines).find((event) => event.event === 'host/spawned'))
    .toMatchObject({ requester: 'node-0', uid: 'node-1' });
}, 90_000);

it('refuses an over-budget child at the spawn seam before any composition side effect', async () => {
  const { home } = await initFixture();
  // The requester sits ten canonical bytes below the derived budget; the
  // composer suffix (a longer sentence than the boot one) would cross it.
  const base = validateAgentConfig({
    ...defaultAgentConfig(), model: 'first-light-test', heading: 'Lead.', charter: '',
  });
  const budget = identityBudget(base);
  const overhead = identityBytes(base);
  const sentence = ' You are node-0.';
  const charter = 'c'.repeat(budget - 10 - overhead - sentence.length) + sentence;
  const injected = validateAgentConfig({ ...base, charter });
  expect(identityBytes(injected)).toBe(budget - 10);

  let requests = 0;
  const server = await serveJson(() => {
    requests += 1;
    return requests === 1
      ? respond({ tool: { name: 'extend', args: { verb: 'spawn' } } })
      : respond({ content: 'idle' });
  });
  servers.push(server);
  await providers(home, server.url);
  const nodesFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.', spawn: true },
  ]);
  const lines: string[] = [];
  const handle = boot(home, 'start', nodesFile, lines, {
    readInitialConfig: async () => injected,
  });
  await vi.waitFor(async () => {
    expect((await resultTexts(home, 'node-0')).some(
      (text) => text.includes('sendability budget'))).toBe(true);
  }, { timeout: 30_000 });
  handle.stop();
  expect(await handle.done).toBe(0);

  const denied = (await resultTexts(home, 'node-0')).find(
    (text) => text.includes('sendability budget'))!;
  expect(denied.startsWith('denied: ')).toBe(true);
  // Bounded for the renderer's 200-code-point clamp.
  expect(denied.length).toBeLessThanOrEqual(200 + 'denied: '.length);
  // No composition side effect: no child local log, no host birth line.
  expect(existsSync(join(home, 'nodes', 'node-1'))).toBe(false);
  expect(hostEvents(lines).some((event) => event.event === 'host/spawned')).toBe(false);
  // The identity history holds exactly the boot config: nothing was journaled.
  expect((await localEvents(home, 'node-0'))
    .filter((event) => event.type === 'system/message')).toHaveLength(1);
}, 90_000);

it('survives a restart: the resume folds the rewritten identity and never resurrects the old one', async () => {
  const { home, world } = await initFixture();
  await commitAs(world, 'human', { 'new-charter.md': 'the rewritten charter' }, 'world charter');
  const lines: string[] = [];
  let rootRequests = 0;
  const first = await serveJson(() => {
    rootRequests += 1;
    if (rootRequests === 1) {
      return respond({
        tool: {
          name: 'extend',
          args: {
            verb: 'update_self', heading: 'Rewritten lead.',
            path: 'new-charter.md', model: 'second-model',
          },
        },
      });
    }
    return respond({ content: 'idle' });
  });
  servers.push(first);
  await providers(home, first.url);
  const startFile = await writeNodes(home, [
    { uid: 'node-0', model: 'first-light-test', heading: 'Lead.' },
  ]);
  const started = boot(home, 'start', startFile, lines);
  await vi.waitFor(async () => {
    expect((await foldedConfig(home, 'node-0'))?.model).toBe('second-model');
  }, { timeout: 30_000 });
  started.stop();
  expect(await started.done).toBe(0);
  await first.close();
  servers.splice(servers.indexOf(first), 1);

  const resumedLines: string[] = [];
  const second = await serveJson(() => respond({ content: 'idle' }));
  servers.push(second);
  await providers(home, second.url);
  const resumeFile = await writeNodes(home, [{ uid: 'node-0' }]);
  const resumed = boot(home, 'resume', resumeFile, resumedLines);
  await vi.waitFor(() => {
    expect(hostEvents(resumedLines).filter((event) => event.event === 'host/parked')).toHaveLength(1);
  }, { timeout: 30_000 });
  resumed.stop();
  expect(await resumed.done).toBe(0);

  // The resumed node's first request carries the journaled rewrite — the old
  // identity is nowhere to resurrect.
  const body = JSON.parse(second.requests[0]!.body.toString('utf8')) as {
    model: string; messages: Array<{ role: string; content: string | null }>;
  };
  expect(body.model).toBe('second-model');
  expect(body.messages[0]!.content).toBe('the rewritten charter You are node-0.');
  expect(body.messages[1]!.content).toBe('Rewritten lead.');
  // host/boot reports the folded (live) config, not the boot flags.
  const booted = hostEvents(resumedLines).find((event) => event.event === 'host/boot');
  expect(booted).toMatchObject({ model: 'second-model' });
  // Resume journals no second configuration: the local log is the history.
  expect((await localEvents(home, 'node-0'))
    .filter((event) => event.type === 'system/message')).toHaveLength(2);
  const config = await foldedConfig(home, 'node-0');
  expect(config?.version).toBe(2);
}, 90_000);
