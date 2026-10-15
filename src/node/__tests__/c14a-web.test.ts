import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalizeJson } from '../../journal/index.js';
import { loadVerifiedEvents } from '../../context/loader.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { resolveArtifact } from '../../context/artifacts.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import { OpenAITransport } from '../../provider/transport.js';
import { NodeDriver } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import { loadProviders } from '../tools/providers.js';
import { webToolsFromProviders } from '../tools/web.js';
import { commitAs, useWorld } from './helpers.js';
import type { ArtifactRef } from '../../context/contracts.js';

const fixture = useWorld('c14a-web-');
const TAVILY_KEY = 'tvly-acceptance-never-log';

const SEARCH_RESPONSE = JSON.stringify({
  request_id: 'req-accept', query: 'emergent societies',
  results: [{ title: 'Emergence', url: 'https://example.com/emergence',
    content: 'complex systems arising from simple rules' }],
});
const EXTRACT_RESPONSE = JSON.stringify({
  request_id: 'req-extract',
  results: [{ url: 'https://example.com/emergence', raw_content: 'Emergence page body' }],
  failed_results: [],
});

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
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

describe('C1.4a web tools end to end', () => {
  it('journals mediated web calls and never leaks the credential', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'research the web\n' });

    // The fake provider: one search call, one extract call, one final answer.
    const tavilyBodies: Buffer[] = [];
    const tavilyAuth: (string | undefined)[] = [];
    const tavily = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        tavilyBodies.push(Buffer.concat(chunks));
        tavilyAuth.push(req.headers.authorization);
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/search' ? SEARCH_RESPONSE : EXTRACT_RESPONSE);
      });
    });
    await new Promise<void>((resolve) => { tavily.listen(0, '127.0.0.1', resolve); });
    const tavilyAddress = tavily.address();
    if (!tavilyAddress || typeof tavilyAddress === 'string') throw new Error('missing TCP address');

    // The fake model: first answer asks for both web tools, second answer ends.
    const llmBodies: Buffer[] = [];
    let requestIndex = 0;
    const llm = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const index = requestIndex;
        requestIndex += 1;
        llmBodies.push(Buffer.concat(chunks));
        const response = index === 0
          ? { choices: [{ message: { role: 'assistant', content: null,
              tool_calls: [
                { id: 'w1', type: 'function', function: {
                  name: 'web_search', arguments: JSON.stringify({ query: 'emergent societies' }) } },
                { id: 'w2', type: 'function', function: {
                  name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.com/emergence' }) } },
              ] } }] }
          : { choices: [{ message: { role: 'assistant', content: 'done' } }] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(response));
      });
    });
    await new Promise<void>((resolve) => { llm.listen(0, '127.0.0.1', resolve); });
    const llmAddress = llm.address();
    if (!llmAddress || typeof llmAddress === 'string') throw new Error('missing TCP address');

    // The credential store: the only place the key exists besides the kernel process.
    await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: {
      key: TAVILY_KEY, baseUrl: `http://127.0.0.1:${tavilyAddress.port}`,
      timeoutMs: 5000,
    } }), 'utf8');

    const defaults = defaultAgentConfig();
    const config = { ...defaults, policy: { ...defaults.policy,
      shellTimeoutMs: 1000, killGraceMs: 20, retryDelayMs: 1, requestTimeoutMs: 5000 } };
    const webTools = webToolsFromProviders(await loadProviders(home));
    if (webTools === undefined) throw new Error('providers not loaded');

    let driver: NodeDriver | null = null;
    let running: Promise<void> | null = null;
    try {
      const runtime = createAgentRuntime({
        home, uid: 'n1', world, initialConfig: config,
        shellPolicy: {
          timeoutMs: config.policy.shellTimeoutMs, killGraceMs: config.policy.killGraceMs,
          maxCaptureBytes: config.policy.maxShellCaptureBytes,
          drainDeadlineMs: config.policy.shellDrainMs,
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb' },
        },
        adapter: new ProviderAdapter(
          new OpenAITransport({ endpoint: `http://127.0.0.1:${llmAddress.port}/v1/chat/completions`,
            key: 'test-key-never-log' }),
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
        webTools,
      });
      driver = await NodeDriver.open(home, 'n1', runtime.handler, world, {
        knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
        onCheckpoint: (mark) => runtime.checkpoint(mark),
      });
      running = driver.run();
      await vi.waitFor(() => {
        expect(driver!.state).toBe('waiting');
        expect(HeadWatcher.for(world).subscriberCount).toBe(1);
      }, { timeout: 5000 });
      driver.stop();
      await running;
      running = null;

      // Both provider calls went out with the key in the header, exactly once each.
      expect(tavilyBodies).toHaveLength(2);
      expect(tavilyAuth).toEqual([`Bearer ${TAVILY_KEY}`, `Bearer ${TAVILY_KEY}`]);
      expect(JSON.parse(tavilyBodies[0]!.toString('utf8')))
        .toEqual({ query: 'emergent societies', max_results: 8, search_depth: 'basic' });
      expect(JSON.parse(tavilyBodies[1]!.toString('utf8')))
        .toEqual({ urls: ['https://example.com/emergence'], extract_depth: 'basic' });

      // The journal carries the calls, the results and the raw provider bodies.
      const events = await loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
      const results = events.filter((event) => event.type === 'tool/result');
      expect(results).toHaveLength(2);
      for (const [index, body] of [SEARCH_RESPONSE, EXTRACT_RESPONSE].entries()) {
        const data = results[index]!.data as unknown as {
          isError: boolean; failure: unknown; raw: ArtifactRef;
          message: { content: string } };
        expect(data.isError).toBe(false);
        expect(data.failure).toBeNull();
        expect(Buffer.from(resolveArtifact(events, data.raw)).toString('utf8')).toBe(body);
        expect(data.message.content).toContain('provider: tavily');
      }

      // The model visibly received the rendered results (model-visible means logged).
      expect(llmBodies).toHaveLength(2);
      const secondRequest = llmBodies[1]!.toString('utf8');
      expect(secondRequest).toContain('complex systems arising from simple rules');
      expect(secondRequest).toContain('Emergence page body');

      // The credential appears in no decoded event, no referenced artifact, and
      // no model-bound request body.
      const keyNeedle = TAVILY_KEY;
      for (const event of events) {
        expect(canonicalizeJson(event.data)).not.toContain(keyNeedle);
        for (const ref of artifactRefs(event.data)) {
          expect(Buffer.from(resolveArtifact(events, ref)).includes(keyNeedle)).toBe(false);
        }
      }
      for (const body of llmBodies) expect(body.toString('utf8')).not.toContain(keyNeedle);
    } finally {
      if (running !== null) { driver!.stop(); await running; }
      await closeServer(tavily);
      await closeServer(llm);
    }
  }, 20000);
});
