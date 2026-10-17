import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadVerifiedEvents } from '../../context/loader.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { resolveArtifact } from '../../context/artifacts.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import { OpenAITransport } from '../../provider/transport.js';
import { NodeDriver } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import { DEFAULT_TERMINAL_ENV } from '../tools/terminal.js';
import { commitAs, useWorld } from './helpers.js';
import type { WorldRepo } from '../world.js';
import type { ArtifactRef } from '../../context/contracts.js';

const fixture = useWorld('c14b-terminal-');

/**
 * The scripted model: one fake OpenAI-compatible server answering from a
 * request counter. Each script entry is one assistant message.
 */
type ScriptEntry =
  | { readonly calls: ReadonlyArray<{ id: string; cmd: string }> }
  | { readonly content: string };

async function serveModel(script: ScriptEntry[]): Promise<{ url: string; close: () => Promise<void> }> {
  let index = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    },
  };
}

function runtimeOptions(home: string, world: WorldRepo, endpoint: string) {
  const defaults = defaultAgentConfig();
  const config = { ...defaults, policy: { ...defaults.policy,
    shellTimeoutMs: 5000, killGraceMs: 50, retryDelayMs: 1, requestTimeoutMs: 5000 } };
  return {
    home, uid: 'n1', world, initialConfig: config,
    terminal: { env: DEFAULT_TERMINAL_ENV },
    adapter: new ProviderAdapter(
      new OpenAITransport({ endpoint, key: 'test-key-never-log' }),
      { delay: (ms, signal) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener('abort', () => {
            clearTimeout(timer); reject(new Error('cancelled'));
          }, { once: true });
        }),
        schedule: (ms, callback) => {
          const timer = setTimeout(callback, ms);
          return () => { clearTimeout(timer); };
        } }),
  };
}

type ResultData = {
  readonly turn: number;
  readonly isError: boolean; readonly failure: unknown; readonly raw: ArtifactRef | null;
  readonly message: { readonly content: string };
};

describe('C1.4b persistent terminal end to end', () => {
  it('keeps shell state across calls AND turns, journaled with raw artifacts', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'work in the bench\n' });
    // The two calls land in DIFFERENT turns: turn 0 runs e1 and parks on the
    // no-call answer; a foreign commit wakes turn 1, which runs e2.
    const model = await serveModel([
      { calls: [{ id: 'e1', cmd: "mkdir -p bench && cd bench && printf 'c14b-persisted' > marker.txt && pwd" }] },
      { content: 'parked' },
      { calls: [{ id: 'e2', cmd: 'pwd && cat marker.txt' }] },
      { content: 'done' },
    ]);
    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      const runtime = createAgentRuntime(runtimeOptions(home, world, model.url));
      driver = await NodeDriver.open(home, 'n1', runtime.handler, world, {
        knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
        onCheckpoint: (mark) => runtime.checkpoint(mark),
      });
      running = driver.run();
      await vi.waitFor(() => {
        expect(driver!.state).toBe('waiting');
        expect(HeadWatcher.for(world).subscriberCount).toBe(1);
      }, { timeout: 10000 });

      // Wake turn 1 as a foreign writer would: a commit, then an explicit
      // check (the watcher's interval is off at worldPollMs 0).
      await commitAs(world, 'human', { 'wake.txt': 'go\n' });
      await HeadWatcher.for(world).check();
      await vi.waitFor(async () => {
        const soFar = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
        expect(soFar.filter((event) => event.type === 'tool/result')).toHaveLength(2);
      }, { timeout: 10000 });
      await vi.waitFor(() => expect(driver!.state).toBe('waiting'), { timeout: 10000 });
      driver.stop();
      await running;
      running = null;

      const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
      const results = events.filter((event) => event.type === 'tool/result')
        .map((event) => event.data as unknown as ResultData);
      expect(results).toHaveLength(2);
      // The headline property: the calls landed in different turns, and the
      // second still saw the first one's `cd` — the session crossed the
      // turn boundary.
      expect(results[1]!.turn).toBeGreaterThan(results[0]!.turn);
      expect(results[0]!.isError).toBe(false);
      expect(results[0]!.message.content).toContain('exit: 0');
      expect(results[0]!.message.content).toContain('/bench');
      expect(results[1]!.message.content).toContain('/bench');
      expect(results[1]!.message.content).toContain('c14b-persisted');
      // The raw artifacts carry the verbatim spans: the PTY's own CRLF line
      // endings survive, and the bytes are not the sanitized render.
      for (const result of results) {
        expect(result.raw).not.toBeNull();
        const raw = Buffer.from(resolveArtifact(events, result.raw!)).toString('utf8');
        expect(raw).toContain('\r\n');
        expect(raw).toContain('/bench');
      }
      // The session's write persists in the world.
      expect(await readFile(join(world.path, 'bench/marker.txt'), 'utf8'))
        .toBe('c14b-persisted');
    } finally {
      if (running !== null) { driver!.stop(); await running; }
      await model.close();
    }
  }, 30000);

  it('a kernel restart starts the session fresh, journaled as such', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'move around\n' });
    const model = await serveModel([
      { calls: [{ id: 'e1', cmd: 'mkdir -p subdir && cd subdir && pwd' }] },
      { content: 'parked' },
      { calls: [{ id: 'e2', cmd: 'pwd' }] },
      { content: 'done' },
    ]);
    try {
      // First boot: cd into subdir, park, stop (the stop disposes the session).
      const first = createAgentRuntime(runtimeOptions(home, world, model.url));
      let driver = await NodeDriver.open(home, 'n1', first.handler, world, {
        knownTypes: C13_EVENT_TYPES, hooks: first.hooks, worldPollMs: 0, batchWindowMs: 10000,
        onCheckpoint: (mark) => first.checkpoint(mark),
      });
      let running = driver.run();
      await vi.waitFor(() => { expect(driver.state).toBe('waiting'); }, { timeout: 10000 });
      driver.stop();
      await running;

      // Second boot on the same home: the session is gone with the process.
      const second = createAgentRuntime(runtimeOptions(home, world, model.url));
      driver = await NodeDriver.open(home, 'n1', second.handler, world, {
        knownTypes: C13_EVENT_TYPES, hooks: second.hooks, worldPollMs: 0, batchWindowMs: 10000,
        onCheckpoint: (mark) => second.checkpoint(mark),
      });
      running = driver.run();
      await vi.waitFor(() => { expect(driver.state).toBe('waiting'); }, { timeout: 10000 });
      driver.stop();
      await running;

      const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
      const results = events.filter((event) => event.type === 'tool/result')
        .map((event) => event.data as unknown as ResultData);
      expect(results).toHaveLength(2);
      expect(results[0]!.message.content).toContain('/subdir');
      // After the restart the session forgot the cd: pwd is the world root.
      expect(results[1]!.message.content).toContain('exit: 0');
      expect(results[1]!.message.content).toContain(world.path);
      expect(results[1]!.message.content).not.toContain('/subdir');
      // Both boots — and both clean stops — are journaled. (This proves the
      // dispose path of arbitration 7: the session dies with the driver. The
      // stronger crash-freshness property is structural — a new kernel process
      // cannot inherit a PTY it does not own — and is not simulated here.)
      expect(events.filter((event) => event.type === 'node/boot').length).toBe(2);
      expect(events.filter((event) => event.type === 'node/shutdown').length).toBe(2);
    } finally {
      await model.close();
    }
  }, 30000);
});
