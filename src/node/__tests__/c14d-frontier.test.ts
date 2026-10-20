import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readFrontier } from '../../frontier/__tests__/helpers.js';
import {
  WORLD_HEAD_RE, openFrontierJournal,
  type FrontierJournal, type HttpRequest,
} from '../../frontier/index.js';
import { SessionAlreadyOwnedError } from '../../journal/index.js';
import { ProviderAdapter, type ProviderPolicy } from '../../provider/adapter.js';
import { OpenAITransport } from '../../provider/transport.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { NodeDriver } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import { loadProviders } from '../tools/providers.js';
import { DEFAULT_TERMINAL_ENV } from '../tools/terminal.js';
import { webToolsFromProviders } from '../tools/web.js';
import { WorldRepo } from '../world.js';
import { commitAs } from './helpers.js';

/**
 * The composition proof (T7): the production shape is one frontier journal per
 * cell home, its gate injected into every mediator (the provider adapter and the
 * web tools), and its lock held until the host closes it at shutdown. Two
 * runtimes with different uids can share the home — the local writer's lock is
 * per `(home, uid)` — and therefore share the one frontier chain, whose total
 * order is the append order. The host, not the runtime, owns the lifecycle:
 * closing releases the writer lock so a new process can take the frontier.
 */

const LLM_KEY = 'llm-key-never-logged';
const TAVILY_KEY = 'tvly-composition-never-logged';

const NO_CALLS = {
  choices: [{ message: { role: 'assistant', content: 'done' } }],
};

const SEARCH_CALL = {
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
    id: 'w1', type: 'function',
    function: { name: 'web_search', arguments: JSON.stringify({ query: 'emergence' }) },
  }] } }],
};

const SEARCH_RESPONSE = {
  request_id: 'req-compose',
  results: [{
    title: 'Emergence', url: 'https://example.com/emergence',
    content: 'complex systems arising from simple rules',
  }],
};

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
}

/** The adapter's timing port: real timers, no sleeps in the happy path. */
const policy: ProviderPolicy = {
  delay: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  }),
  schedule: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => { clearTimeout(timer); };
  },
};

describe('the composition root', () => {
  it('shares one frontier per home across two uids, in append order, and releases it on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c14d-frontier-'));
    const world = await WorldRepo.init(join(root, 'world'), {
      gitDir: join(root, 'world.git'),
    });
    HeadWatcher.for(world, 0);
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    // A real HEAD must exist so the kernel's best-effort stamp has something to
    // observe; the nodes themselves change nothing, so it never moves.
    const seeded = await commitAs(world, 'human', { 'README.md': '# shared world\n' }, 'seed');

    const llmCalls = new Map<string, number>();
    const server = createServer((req, res) => {
      const path = req.url ?? '';
      // Consume the request body before answering: the client is non-streaming
      // and waits for the complete response.
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (path === '/search') {
          res.end(JSON.stringify(SEARCH_RESPONSE));
          return;
        }
        const count = (llmCalls.get(path) ?? 0) + 1;
        llmCalls.set(path, count);
        // n1 asks for the web tool on its first logical request; every later
        // request is a plain wait, so both nodes park after one tool group.
        const body = path === '/n1/chat/completions' && count === 1 ? SEARCH_CALL : NO_CALLS;
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing TCP address');
    const base = `http://127.0.0.1:${address.port}`;

    let journal: FrontierJournal | null = null;
    let reopened: FrontierJournal | null = null;
    try {
      // The host's composition: the credential store, one frontier per home,
      // the gate handed to every mediator.
      await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: {
        key: TAVILY_KEY, baseUrl: base, timeoutMs: 5000,
      } }), 'utf8');

      const frontier = await openFrontierJournal(home, {
        worldHead: () => world.headHash(),
        now: Date.now,
      });
      journal = frontier;

      // One frontier per home: while the host holds it, a second opener is
      // refused by the writer's single-writer lock.
      await expect(openFrontierJournal(home, {
        worldHead: () => world.headHash(), now: Date.now,
      })).rejects.toBeInstanceOf(SessionAlreadyOwnedError);

      const webTools = webToolsFromProviders(await loadProviders(home), frontier.gate);
      if (webTools === undefined) throw new Error('tavily registry entry missing');

      const openNode = async (uid: string): Promise<NodeDriver> => {
        const runtime = createAgentRuntime({
          home, uid, world, initialConfig: defaultAgentConfig(),
          terminal: { env: DEFAULT_TERMINAL_ENV },
          adapter: new ProviderAdapter(
            new OpenAITransport({
              endpoint: `${base}/${uid}/chat/completions`, key: LLM_KEY,
            }),
            policy,
            frontier.gate,
          ),
          webTools,
        });
        return NodeDriver.open(home, uid, runtime.handler, world, {
          knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks,
          worldPollMs: 0, batchWindowMs: 10000,
        });
      };

      const drive = async (driver: NodeDriver): Promise<void> => {
        const running = driver.run();
        try {
          await vi.waitFor(() => expect(driver.state).toBe('waiting'), { timeout: 5000 });
        } finally {
          driver.stop();
          await running;
        }
      };

      // Both nodes' local writers are live at once: the local lock is per
      // `(home, uid)`, so the two runtimes coexist and share the one gate.
      const opened = new Map<string, NodeDriver>();
      const started = new Set<NodeDriver>();
      try {
        const n1 = await openNode('n1');
        opened.set('n1', n1);
        const n2 = await openNode('n2');
        opened.set('n2', n2);
        started.add(n1);
        await drive(n1);
        started.add(n2);
        await drive(n2);
      } finally {
        // A driver that was opened but never run still holds its local writer;
        // stop-then-run closes it without opening a turn.
        for (const driver of opened.values()) {
          if (started.has(driver)) continue;
          driver.stop();
          await driver.run().catch(() => {});
        }
      }

      const events = await readFrontier(home);
      // Every call opened and closed before the next one: the shared chain's
      // total order is the append order, and it carries both nodes' exchanges.
      expect(events.map((event) => event.type)).toEqual([
        'http/request', 'http/response',
        'http/request', 'http/response',
        'http/request', 'http/response',
        'http/request', 'http/response',
      ]);
      const requests = events
        .filter((event) => event.type === 'http/request')
        .map((event) => event.data as unknown as HttpRequest);
      expect(requests.map((request) => request.url)).toEqual([
        `${base}/n1/chat/completions`,   // n1's first LLM plan
        `${base}/search`,                // n1's dispatched web_search
        `${base}/n1/chat/completions`,   // n1's follow-up plan
        `${base}/n2/chat/completions`,   // n2's plan, same journal
      ]);

      // The kernel stamped every call from the world repo's HEAD, best-effort.
      expect(await world.headHash()).toBe(seeded);
      expect(requests.every((request) => request.world_head === seeded)).toBe(true);
      expect(requests.every((request) =>
        request.world_head === null || WORLD_HEAD_RE.test(request.world_head))).toBe(true);

      // Closing releases the lock: a new process can take the frontier.
      await frontier.close();
      journal = null;
      reopened = await openFrontierJournal(home, {
        worldHead: () => world.headHash(), now: Date.now,
      });
    } finally {
      // Teardown order is the contract: close the frontier before removing the
      // home (and never remove a home whose writer lock is still held).
      if (reopened !== null) await reopened.close().catch(() => {});
      if (journal !== null) await journal.close().catch(() => {});
      await closeServer(server);
      await rm(root, { recursive: true, force: true });
    }
  });
});
