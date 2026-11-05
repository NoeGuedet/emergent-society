import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { serveJson } from '../../node/__tests__/helpers.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';
import { readOwner } from '../owner.js';
import { startHost } from '../host.js';
import { NodeTokenCounter, readNodeTokenSnapshot } from '../token-counter.js';

const homes: string[] = [];
const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

it('resumes the gateway-only observer with an exhausted counter and no node boot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'es-observer-'));
  homes.push(home);
  await initHome(home);
  const server = await serveJson(() => ({
    body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'observer idle' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  }));
  servers.push(server);
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: {
      key: 'test-key', endpoint: `${server.url}/v1/chat/completions`,
      models: [{ id: 'gateway-model', contextTokens: 100_000, maxOutputTokens: 8_000 }],
    },
  }), { mode: 0o600 });
  await writeFile(join(home, 'gateway.charter.md'), 'You are the gateway.\n', { mode: 0o600 });
  await writeFile(join(home, 'gateway.json'), JSON.stringify({
    v: 0, model: 'gateway-model',
  }), { mode: 0o600 });
  const counter = await NodeTokenCounter.open(home, { createLimit: 1 });
  await counter!.record(1, 0);
  expect((await readNodeTokenSnapshot(home))?.state).toBe('exhausted');
  const lines: string[] = [];
  const log = createHostLog((line) => lines.push(line));

  for (let round = 0; round < 2; round += 1) {
    const handle = startHost({
      home, uid: 'node-0', command: 'resume', observer: true,
      sandbox: false, pollMs: 25, log,
    }, { installSignals: false, keepAlive: false });
    try {
      await vi.waitFor(async () => {
        expect((await readOwner(home)).kind).toBe('live');
      }, { timeout: 10_000 });
      await vi.waitFor(async () => {
        expect(server.requests.length).toBeGreaterThan(0);
      }, { timeout: 10_000 });
    } finally {
      handle.stop();
      expect(await handle.done).toBe(0);
    }
    await expect(lstat(join(home, 'nodes', 'node-0'))).rejects.toThrow();
    expect(await readNodeTokenSnapshot(home)).toMatchObject({
      limitTokens: 1, usedTokens: 1, state: 'exhausted',
    });
  }
  for (const request of server.requests) {
    const body = JSON.parse(request.body.toString('utf8')) as { model?: string };
    expect(body.model).toBe('gateway-model');
  }
  expect(lines.some((line) => line.includes('"event":"host/boot"'))).toBe(false);
}, 40_000);
