import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '../../journal/index.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import type { VerifiedEvents } from '../../context/loader.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { resolveArtifact } from '../../context/artifacts.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import { OpenAITransport } from '../../provider/transport.js';
import { NodeDriver } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import type { AgentRuntime } from '../loop.js';
import { DEFAULT_TERMINAL_ENV } from '../tools/terminal.js';
import { WorldRepo } from '../world.js';
import type { ArtifactRef } from '../../context/contracts.js';
import {
  commitAs, committedContent, committedPaths, gitIn, gitRaw, useWorld,
} from './helpers.js';
import { openTestDriver } from './helpers.js';

/**
 * The C1.4c acceptance harness: the whole credential guarantee end to end and
 * through the real components — a real `NodeDriver`, the real agent runtime
 * with its default confined terminal (no factory injection anywhere in the
 * proof), a fixture world whose git dir lives outside it, and the fake
 * OpenAI-compatible provider every c13/c14a/c14b suite scripts. The only
 * network is that loopback server.
 *
 * Five faces, each a journaled, non-vacuous assertion:
 *
 * 1. the guarantee: raw bash cannot read the canary credential store, and the
 *    denial — not a transport failure — reaches the journal with none of the
 *    store's bytes anywhere in the journal's payloads or artifacts;
 * 2. the world keeps working: the confined shell writes, and the turn-end
 *    commit lands in the external git dir the kernel owns;
 * 3. the git escape stays closed: a planted clean filter in an in-world
 *    `.git/config`, selected by a root `.gitattributes`, never runs, and the
 *    commit neither carries `.git/**` nor a gitlink;
 * 4. the kernel stays unconfined: after the confined executes, the next turn's
 *    provider request succeeds and carries the key the kernel holds in memory;
 * 5. the reported status and the restart: `sandboxStatus()` is landlock/full
 *    after the first execute and survives the stop, and a fresh open/restart
 *    over a manually planted stray `<world>/.git` stays confined and un-wedged.
 *
 * Every test asserts statuses and bytes, never wall-clock timings; command
 * timeouts stay ≥ 300 ms and every test carries an explicit vitest timeout.
 * The vitest globalSetup builds the launcher, so a full run always has it; a
 * direct run without it skips loudly instead of failing.
 */

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const launcherBinary = join(projectRoot, 'native', 'es-landlock', 'es-landlock');
const launcherPresent = existsSync(launcherBinary);
/** Unique enough that no journal byte can contain it by accident. */
const CANARY = 'ES_C14C_ACCEPTANCE_CANARY_7b3e91d4';
const PROVIDER_KEY = 'test-key-never-log';

if (!launcherPresent) {
  console.warn(
    '[c14c-landlock] native/es-landlock/es-landlock is absent: skipping the acceptance '
      + 'harness. Run `npm run build:native` (npm test builds it in globalSetup).',
  );
}

const fixture = useWorld('c14c-landlock-');

/** The scripted model: one fake OpenAI-compatible server answering from a request counter. */
type ScriptEntry =
  | { readonly calls: ReadonlyArray<{ id: string; cmd: string }> }
  | { readonly content: string };

type ModelServer = {
  readonly url: string;
  /** Every request the kernel sent, in order: its authorization and its body. */
  readonly authorizations: () => readonly (string | undefined)[];
  readonly bodies: () => readonly Buffer[];
  readonly close: () => Promise<void>;
};

async function serveModel(script: ScriptEntry[]): Promise<ModelServer> {
  let index = 0;
  const authorizations: (string | undefined)[] = [];
  const bodies: Buffer[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      authorizations.push(req.headers.authorization);
      bodies.push(Buffer.concat(chunks));
      const entry = script[index] ?? { content: 'done' };
      index += 1;
      const message = 'calls' in entry
        ? {
            role: 'assistant', content: null,
            tool_calls: entry.calls.map((call) => ({
              id: call.id, type: 'function',
              function: { name: 'execute', arguments: JSON.stringify({ cmd: call.cmd }) },
            })),
          }
        : { role: 'assistant', content: entry.content };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing TCP address');
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    authorizations: () => authorizations,
    bodies: () => bodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    },
  };
}

/** The runtime options of the real, default-confined kernel: no factory, no opt-out. */
async function runtimeOptions(home: string, world: WorldRepo, endpoint: string) {
  const defaults = defaultAgentConfig();
  const config = { ...defaults, policy: { ...defaults.policy,
    shellTimeoutMs: 5000, killGraceMs: 50, retryDelayMs: 1, requestTimeoutMs: 5000 } };
  return {
    home, uid: 'n1', world, initialConfig: config,
    terminal: { env: DEFAULT_TERMINAL_ENV },
    adapter: new ProviderAdapter(
      new OpenAITransport({ endpoint, key: PROVIDER_KEY }),
      { delay: (ms, signal) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => {
            clearTimeout(timer); reject(new Error('cancelled'));
          }, { once: true });
        }),
        schedule: (ms, callback) => {
          const timer = setTimeout(callback, ms);
          return () => { clearTimeout(timer); };
        } },
      (await fixture().frontier()).gate,
    ),
  };
}

type Boot = {
  readonly runtime: AgentRuntime;
  readonly driver: NodeDriver;
  readonly done: Promise<void>;
};

async function bootRuntime(home: string, world: WorldRepo, endpoint: string): Promise<Boot> {
  const runtime = createAgentRuntime(await runtimeOptions(home, world, endpoint));
  const driver = await openTestDriver(home, 'n1', runtime.handler, world, {
    knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
    onCheckpoint: (mark) => runtime.checkpoint(mark),
  });
  const done = driver.run();
  return { runtime, driver, done };
}

async function stopRuntime(boot: Boot): Promise<void> {
  boot.driver.stop();
  await boot.done;
}

type ResultData = {
  readonly turn: number;
  readonly isError: boolean; readonly failure: unknown; readonly raw: ArtifactRef | null;
  readonly message: { readonly content: string };
};

type TurnEndData = { readonly turn: number; readonly outcome: string };

function resultsOf(events: VerifiedEvents): ResultData[] {
  return events.filter((event) => event.type === 'tool/result')
    .map((event) => event.data as unknown as ResultData);
}

async function waitForResults(home: string, count: number): Promise<void> {
  await vi.waitFor(async () => {
    const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
    expect(resultsOf(events)).toHaveLength(count);
  }, { timeout: 20000 });
}

async function waitForTurnEnds(home: string, count: number): Promise<void> {
  await vi.waitFor(async () => {
    const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(count);
  }, { timeout: 20000 });
}

async function waitForWaiting(driver: NodeDriver): Promise<void> {
  await vi.waitFor(() => { expect(driver.state).toBe('waiting'); }, { timeout: 20000 });
}

/** Every ArtifactRef reachable from an event payload, at any nesting depth. */
function artifactRefs(value: unknown, out: ArtifactRef[] = []): ArtifactRef[] {
  if (Array.isArray(value)) {
    for (const item of value) artifactRefs(item, out);
  } else if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    if (o['kind'] === 'c13-artifact') out.push(o as unknown as ArtifactRef);
    else for (const item of Object.values(o)) artifactRefs(item, out);
  }
  return out;
}

/**
 * The canary appears in no decoded event payload, in no referenced artifact's
 * raw bytes, and in no request body the kernel sent to the provider. The
 * request bodies matter: they carry every prior tool result into the model, so
 * a leak would reach the network even when the shell's own output looked clean.
 */
function assertNoCanary(events: VerifiedEvents, model: ModelServer): void {
  for (const event of events) {
    expect(canonicalizeJson(event.data)).not.toContain(CANARY);
    for (const ref of artifactRefs(event.data)) {
      expect(Buffer.from(resolveArtifact(events, ref)).includes(CANARY)).toBe(false);
    }
  }
  for (const body of model.bodies()) expect(body.includes(CANARY)).toBe(false);
}

/** Quotes one argument for the confined bash, single-quote style. */
function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe('C1.4c acceptance: the credential guarantee end to end', () => {
  it.skipIf(!launcherPresent)(
    'journals the denial: the canary store is unreadable and no byte of it is journaled',
    async () => {
      const { home, world } = fixture();
      const canaryPath = join(home, 'providers.json');
      await writeFile(canaryPath, `${CANARY}\n`, { mode: 0o644 });
      const model = await serveModel([
        { calls: [{ id: 'e1', cmd: 'cat ../home/providers.json' }] },
        { content: 'done' },
      ]);
      let booted: Boot | null = null;
      try {
        booted = await bootRuntime(home, world, model.url);
        await waitForResults(home, 1);
        await waitForWaiting(booted.driver);
        await stopRuntime(booted);
        booted = null;

        // The premise, from the unconfined side: the bytes are there to leak.
        expect(await readFile(canaryPath, 'utf8')).toBe(`${CANARY}\n`);

        const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
        const results = resultsOf(events);
        expect(results).toHaveLength(1);
        const denied = results[0]!;
        // Content, not transport: an ordinary nonzero exit with no SafeFailure.
        expect(denied.isError).toBe(true);
        expect(denied.failure).toBeNull();
        expect(denied.message.content).toContain('exit: 1');
        expect(denied.message.content).toContain('Permission denied');
        // The raw PTY capture is the denial itself — not a missing file, not an
        // empty diagnostic — and carries no credential byte.
        expect(denied.raw).not.toBeNull();
        const raw = Buffer.from(resolveArtifact(events, denied.raw!));
        expect(raw.length).toBeGreaterThan(0);
        expect(raw.toString('utf8')).toContain('Permission denied');
        expect(raw.includes(CANARY)).toBe(false);
        assertNoCanary(events, model);
      } finally {
        if (booted !== null) await stopRuntime(booted).catch(() => {});
        await model.close();
      }
    },
    30_000,
  );

  it.skipIf(!launcherPresent)(
    'keeps the world usable: the shell writes and the external git dir receives the commit',
    async () => {
      const { home, world } = fixture();
      await commitAs(world, 'human', { 'direction.txt': 'work in the bench\n' });
      const model = await serveModel([
        { calls: [{ id: 'e1', cmd: "mkdir bench && cd bench && printf 'hello' > note.txt" }] },
        { content: 'done' },
      ]);
      let booted: Boot | null = null;
      try {
        booted = await bootRuntime(home, world, model.url);
        await waitForResults(home, 1);
        await waitForWaiting(booted.driver);
        await stopRuntime(booted);
        booted = null;

        const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
        const results = resultsOf(events);
        expect(results).toHaveLength(1);
        expect(results[0]!.isError).toBe(false);
        expect(results[0]!.message.content).toContain('exit: 0');
        // The turn-end commit landed through the kernel's external pair.
        expect(await committedContent(world, 'bench/note.txt')).toBe('hello');
        expect(await committedPaths(world)).toContain('bench/note.txt');
        expect(await readFile(join(world.path, 'bench/note.txt'), 'utf8')).toBe('hello');
        // The world holds no git metadata; HEAD lives in the kernel-owned dir.
        await expect(lstat(join(world.path, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(world.gitDir, 'HEAD'), 'utf8')).toMatch(/^ref: refs\/heads\//);
        const gitDirOfWorld = (await gitIn(world, ['rev-parse', '--absolute-git-dir'])).trim();
        expect(await realpath(gitDirOfWorld)).toBe(await realpath(world.gitDir));
        expect((await realpath(world.gitDir)).startsWith(`${await realpath(world.path)}/`))
          .toBe(false);
      } finally {
        if (booted !== null) await stopRuntime(booted).catch(() => {});
        await model.close();
      }
    },
    30_000,
  );

  it.skipIf(!launcherPresent)(
    'keeps the git escape closed: the planted clean filter never runs and no gitlink lands',
    async () => {
      const { home, world } = fixture();
      await commitAs(world, 'human', { 'direction.txt': 'try the escape\n' });
      // The canary command a clean filter would run as the *kernel*: the marker
      // lives outside every Landlock grant, where only an unconfined process can
      // create it. The control below proves the marker path is creatable, so its
      // absence afterwards is about the command not running.
      const marker = join(dirname(home), 'escape-ran');
      await writeFile(marker, 'control');
      await rm(marker);
      const filterConfig = [
        '[filter "canary"]',
        `clean = touch ${shArg(marker)}`,
        'required = true',
      ];
      const cmd = 'git init -q . && '
        + `printf '%s\\n' ${filterConfig.map(shArg).join(' ')} >> .git/config && `
        + `printf '%s\\n' '*.txt filter=canary' > .gitattributes && `
        + "printf 'hello' > note.txt && printf 'notes' > note.md";
      const model = await serveModel([
        { calls: [{ id: 'e1', cmd }] },
        { content: 'done' },
      ]);
      let booted: Boot | null = null;
      try {
        booted = await bootRuntime(home, world, model.url);
        await waitForResults(home, 1);
        await waitForWaiting(booted.driver);
        await stopRuntime(booted);
        booted = null;

        const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
        const results = resultsOf(events);
        expect(results).toHaveLength(1);
        expect(results[0]!.isError).toBe(false);
        expect(results[0]!.message.content).toContain('exit: 0');
        // The attack fixture really is planted: the in-world repository exists,
        // its own config holds the filter, and the root attributes file selects
        // it — so an `add` reading that config WOULD run the canary command.
        const planted = await gitRaw(world.path, ['config', '--get', 'filter.canary.clean']);
        expect(planted.trim()).toBe(`touch ${shArg(marker)}`);
        expect(await readFile(join(world.path, '.gitattributes'), 'utf8'))
          .toBe('*.txt filter=canary\n');
        // The kernel's git never consults the planted config: the filter driver
        // is unknown to it, and every origin it reports is the external git dir.
        await expect(gitIn(world, ['config', '--get', 'filter.canary.clean'])).rejects.toThrow();
        const origins = await gitIn(world, ['config', '--list', '--show-origin']);
        expect(origins).toContain(join(world.gitDir, 'config'));
        expect(origins).not.toContain(join(world.path, '.git'));
        // The canary never ran: the unconfined-only marker does not exist.
        await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        // The commit landed anyway, with the normal file and no escape paths.
        expect(await committedContent(world, 'note.txt')).toBe('hello');
        const paths = await committedPaths(world);
        expect(paths).toContain('note.txt');
        expect(paths.filter((path) => path === '.git' || path.startsWith('.git/'))).toEqual([]);
        // No gitlink: neither in the index nor in the durable tree.
        const staged = await gitIn(world, ['ls-files', '--stage']);
        expect(staged.split('\n').filter((line) => line.startsWith('160000 '))).toEqual([]);
        const tree = await gitIn(world, ['ls-tree', '-r', 'HEAD']);
        expect(tree.split('\n').filter((line) => line.startsWith('160000 '))).toEqual([]);
        expect(tree).toContain('\tnote.txt');
        assertNoCanary(events, model);
      } finally {
        if (booted !== null) await stopRuntime(booted).catch(() => {});
        await model.close();
      }
    },
    30_000,
  );

  it.skipIf(!launcherPresent)(
    'keeps the kernel unconfined: the next turn talks to the provider with its in-memory key',
    async () => {
      const { home, world } = fixture();
      await commitAs(world, 'human', { 'direction.txt': 'then keep going\n' });
      const model = await serveModel([
        { calls: [{ id: 'e1', cmd: 'true' }] },
        { content: 'parked' },
        { content: 'done' },
      ]);
      let booted: Boot | null = null;
      try {
        booted = await bootRuntime(home, world, model.url);
        await waitForResults(home, 1);
        await waitForWaiting(booted.driver);
        expect(model.authorizations()).toHaveLength(2);
        const status = booted.runtime.sandboxStatus();
        expect(status).toMatchObject({ mode: 'landlock', enforcement: 'full' });

        // Wake turn 1 as a foreign writer would: the kernel's own request path
        // must still reach loopback and must carry the key it holds in memory.
        await commitAs(world, 'human', { 'wake.txt': 'go\n' });
        await HeadWatcher.for(world).check();
        await waitForTurnEnds(home, 2);
        await waitForWaiting(booted.driver);
        await stopRuntime(booted);
        booted = null;

        expect(model.authorizations()).toHaveLength(3);
        for (const authorization of model.authorizations()) {
          expect(authorization).toBe(`Bearer ${PROVIDER_KEY}`);
        }
        // The second request's body carries the first turn's confined result.
        expect(model.bodies()[2]!.toString('utf8')).toContain('exit: 0');
        const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
        const ends = events.filter((event) => event.type === 'turn/end')
          .map((event) => event.data as unknown as TurnEndData);
        expect(ends).toHaveLength(2);
        expect(ends.map((end) => end.turn)).toEqual([0, 1]);
        expect(ends.map((end) => end.outcome)).toEqual(['waiting', 'waiting']);
        assertNoCanary(events, model);
      } finally {
        if (booted !== null) await stopRuntime(booted).catch(() => {});
        await model.close();
      }
    },
    40_000,
  );

  it.skipIf(!launcherPresent)(
    'reports landlock/full across the stop, and restarts confined over a stray in-world .git',
    async () => {
      const { home, world } = fixture();
      await writeFile(join(home, 'providers.json'), `${CANARY}\n`, { mode: 0o644 });
      await commitAs(world, 'human', { 'direction.txt': 'stay confined\n' });
      const model = await serveModel([
        { calls: [{ id: 'e1', cmd: 'mkdir bench && cd bench' }] },
        { content: 'parked' },
        { calls: [{ id: 'e2', cmd: 'pwd && cat ../home/providers.json' }] },
        { content: 'done' },
      ]);
      let first: Boot | null = null;
      let second: Boot | null = null;
      try {
        first = await bootRuntime(home, world, model.url);
        await waitForResults(home, 1);
        await waitForWaiting(first.driver);
        const live = first.runtime.sandboxStatus();
        expect(live).toMatchObject({ mode: 'landlock', enforcement: 'full' });
        if (live?.mode === 'landlock') expect(live.abi).toBeGreaterThanOrEqual(3);
        await stopRuntime(first);
        // The live runtime is gone with the stop; the reported status survives it.
        expect(first.runtime.sandboxStatus()).toMatchObject({
          mode: 'landlock', enforcement: 'full',
        });
        first = null;

        // The test plants the stray in-world git dir itself (a compressed form
        // of the planted config above) — arbitration 10: the kernel ignores it.
        await mkdir(join(world.path, '.git'));
        await writeFile(join(world.path, '.git/config'), '[filter "canary"]\n\tclean = true\n');
        const reopened = await WorldRepo.open(world.path, { gitDir: world.gitDir });
        expect(reopened.gitDir).toBe(world.gitDir);

        second = await bootRuntime(home, reopened, model.url);
        await waitForResults(home, 2);
        await waitForWaiting(second.driver);
        await stopRuntime(second);
        second = null;

        // The restarted boot got a fresh confined session: the first boot's
        // `cd bench` is gone (pwd is the world root), and the canary is denied.
        const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
        const results = resultsOf(events);
        expect(results.map((result) => result.isError)).toEqual([false, true]);
        expect(results[1]!.failure).toBeNull();
        expect(results[1]!.message.content).toContain(world.path);
        expect(results[1]!.message.content).not.toContain('/bench');
        expect(results[1]!.message.content).toContain('Permission denied');
        expect(await readFile(join(home, 'providers.json'), 'utf8')).toBe(`${CANARY}\n`);
        // The stray dir was never staged, on either boot.
        const tree = await gitIn(reopened, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(tree.split('\n').filter((line) => line === '.git' || line.startsWith('.git/')))
          .toEqual([]);
        assertNoCanary(events, model);
      } finally {
        if (second !== null) await stopRuntime(second).catch(() => {});
        if (first !== null) await stopRuntime(first).catch(() => {});
        await model.close();
      }
    },
    45_000,
  );
});
