import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import {
  lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  BlobStore, JournalReader, SessionAlreadyOwnedError, canonicalizeJson, frontierLayout,
  sha256HexOf,
} from '../../journal/index.js';
import {
  failFrontierFlushes, openTestFrontier, readFrontier,
} from '../../frontier/__tests__/helpers.js';
import {
  FRONTIER_EVENT_TYPES, FRONTIER_MAX_BODY_BYTES, WORLD_HEAD_RE, openFrontierJournal,
  validateFrontierEvent, FrontierValidationError,
  type Frontier, type FrontierJournal, type FrontierRequestInput,
  type HttpRequest, type HttpResponse,
} from '../../frontier/index.js';
import { ProviderAdapter } from '../../provider/adapter.js';
import {
  OpenAITransport,
  type SerializedTransport, type TransportFacts, type TransportResult,
} from '../../provider/transport.js';
import { C13_EVENT_TYPES } from '../../context/events.js';
import { loadVerifiedEvents, type VerifiedEvents } from '../../context/loader.js';
import type { AgentConfig } from '../../context/contracts.js';
import { MAX_CAPTURE_BYTES } from '../gate.js';
import { NodeDriver } from '../driver.js';
import { HeadWatcher } from '../watcher.js';
import { createAgentRuntime, defaultAgentConfig } from '../loop.js';
import { buildSandboxSpec } from '../tools/sandbox.js';
import { loadProviders } from '../tools/providers.js';
import { DEFAULT_TERMINAL_ENV, PtyTerminalRuntime } from '../tools/terminal.js';
import type { WebTools } from '../tools/web.js';
import { webToolsFromProviders } from '../tools/web.js';
import { WorldRepo } from '../world.js';
import {
  closeServer, commitAs, providerPolicy, serveJson, useWorld, type LoopServer,
} from './helpers.js';

/**
 * The C1.4d acceptance harness: frontier completeness, proven (plan §8, T8).
 *
 * The brick's contract in one place. Proofs 1, 9 and 12 are static/module-level;
 * proofs 2-6, 8, 10 and 11 run the real runtime (driver, fold, loop, world,
 * shell) against loopback servers or scripted transports; proof 7 is a
 * confinement probe with no HTTP exchange. Every proof is written to fail
 * without the machinery it names.
 *
 *  1. one mediated path (static scan, stated as a regression guard);
 *  2. no send without a durable request (both call sites, positive and,
 *     through T4's flush seam, negative);
 *  3. no visibility without a durable terminal (a `Frontier` whose `complete`
 *     rejects propagates fatally and no projection happens);
 *  4. a crash between the two halves leaves one honest, idempotent orphan;
 *  5. retries share a group, increment attempts, and store one body blob;
 *  6. no credential lands through the request path (the reflection residual is
 *     pinned separately, visible);
 *  7. `<home>/frontier/` is unreadable and unwritable from the confined shell;
 *  8. every request carries the world HEAD the kernel observed, or `null`;
 *  9. the frontier is agnostic of the agentic system's structure;
 * 10. the local → frontier join (in `src/context/__tests__/replay-offline.test.ts`);
 * 11. cold start works off the slimmed local log;
 * 12. `FRONTIER_MAX_BODY_BYTES === MAX_CAPTURE_BYTES`.
 */

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const launcherBinary = join(projectRoot, 'native', 'es-landlock', 'es-landlock');
const launcherPresent = existsSync(launcherBinary);
if (!launcherPresent) {
  console.warn(
    '[c14d-frontier] native/es-landlock/es-landlock is absent: proof 7 (confinement) '
      + 'is skipped. Run `npm run build:native` (npm test builds it in globalSetup).',
  );
}

const fixture = useWorld('c14d-frontier-');

const LLM_KEY = 'llm-key-never-logged';
const TAVILY_KEY = 'tvly-acceptance-never-logged';
/** Unique enough that no journal byte can contain it by accident. */
const STORE_CANARY = 'ES_C14D_STORE_CANARY_4a7d1c9e';

const TEST_FACTS: TransportFacts = {
  url: 'https://test.invalid/v1/chat/completions',
  headers: { 'content-type': 'application/json' },
  credentialId: 'test',
};

const SEARCH_PAYLOAD = JSON.stringify({
  request_id: 'req-accept',
  results: [{
    title: 'Emergence', url: 'https://example.com/emergence',
    content: 'complex systems arising from simple rules',
  }],
});

const NO_CALLS = assistantReply('done');
const SEARCH_CALL = assistantReply(null, [{
  id: 'w1', name: 'web_search', arguments: { query: 'emergent societies' },
}]);

type ToolCallSpec = {
  readonly id: string; readonly name: string; readonly arguments: unknown;
};

function assistantReply(
  content: string | null, calls: readonly ToolCallSpec[] = [],
): string {
  return JSON.stringify({ choices: [{ message: {
    role: 'assistant',
    content,
    ...(calls.length === 0 ? {} : {
      tool_calls: calls.map((call) => ({
        id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }),
  } }] });
}

/** The default configuration with retry/timeout knobs a test can settle fast. */
function testConfig(over: Partial<AgentConfig['policy']> = {}): AgentConfig {
  const base = defaultAgentConfig();
  return {
    ...base,
    policy: { ...base.policy, retryDelayMs: 1, requestTimeoutMs: 5000, ...over },
  };
}

type Running = {
  readonly runtime: ReturnType<typeof createAgentRuntime>;
  readonly driver: NodeDriver;
  readonly run: Promise<void>;
};

type OpenOptions = {
  readonly home: string; readonly world: WorldRepo;
  readonly adapter: ProviderAdapter;
  readonly config?: AgentConfig;
  readonly webTools?: WebTools;
};

async function openRuntime(opts: OpenOptions): Promise<Running> {
  const runtime = createAgentRuntime({
    home: opts.home, uid: 'n1', world: opts.world,
    initialConfig: opts.config ?? testConfig(),
    terminal: { env: DEFAULT_TERMINAL_ENV },
    adapter: opts.adapter,
    ...(opts.webTools !== undefined ? { webTools: opts.webTools } : {}),
  });
  const driver = await NodeDriver.open(opts.home, 'n1', runtime.handler, opts.world, {
    knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0, batchWindowMs: 10000,
  });
  return { runtime, driver, run: driver.run() };
}

async function park(running: Running): Promise<void> {
  await vi.waitFor(() => expect(running.driver.state).toBe('waiting'), { timeout: 10000 });
}

/** Stops a runtime and settles it; an expected rejection was already consumed. */
async function settle(running: Running | null): Promise<void> {
  if (running === null) return;
  running.driver.stop();
  await running.run.catch(() => { /* the test's assertions stand */ });
}

function nodeEvents(home: string): Promise<VerifiedEvents> {
  return loadVerifiedEvents(home, 'n1', C13_EVENT_TYPES);
}

function requestsOf(events: readonly { type: string; data: unknown }[]): HttpRequest[] {
  return events.filter((event) => event.type === 'http/request')
    .map((event) => event.data as unknown as HttpRequest);
}

function responsesOf(events: readonly { type: string; data: unknown }[]): HttpResponse[] {
  return events.filter((event) => event.type === 'http/response')
    .map((event) => event.data as unknown as HttpResponse);
}

/** Reads the frontier through its verifying reader. */
async function frontierOf(home: string): Promise<Awaited<ReturnType<typeof readFrontier>>> {
  return readFrontier(home);
}

/** Every object key anywhere in a JSON value. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      keysOf(child, out);
    }
  }
  return out;
}

// --- proof 1: the static scan ------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every `.ts` kernel source under `src/`, tests excluded. */
async function kernelSources(): Promise<{ readonly rel: string; readonly text: string }[]> {
  const out: { rel: string; text: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        await walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      out.push({
        rel: relative(SRC_ROOT, path).split(sep).join('/'),
        text: await readFile(path, 'utf8'),
      });
    }
  };
  await walk(SRC_ROOT);
  return out;
}

function containing(
  sources: readonly { readonly rel: string; readonly text: string }[], needle: string,
): string[] {
  return sources.filter((source) => source.text.includes(needle))
    .map((source) => source.rel).sort();
}

// --- the composition proof (T7) ----------------------------------------------------

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
          res.end(JSON.stringify(SEARCH_PAYLOAD));
          return;
        }
        const count = (llmCalls.get(path) ?? 0) + 1;
        llmCalls.set(path, count);
        // n1 asks for the web tool on its first logical request; every later
        // request is a plain wait, so both nodes park after one tool group.
        const body = path === '/n1/chat/completions' && count === 1 ? SEARCH_CALL : NO_CALLS;
        res.end(body);
      });
    });
    let journal: FrontierJournal | null = null;
    let reopened: FrontierJournal | null = null;
    try {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing TCP address');
      const base = `http://127.0.0.1:${address.port}`;

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
            providerPolicy,
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
      // One unbroken sequence from 0 makes the single-chain claim visible;
      // `readFrontier` itself reads through the journal's verifying reader.
      expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(events.map((event) => event.type)).toEqual([
        'http/request', 'http/response',
        'http/request', 'http/response',
        'http/request', 'http/response',
        'http/request', 'http/response',
      ]);
      const requests = requestsOf(events);
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
      // Teardown closes any open frontier before removing the home; a close
      // failure is ignored so cleanup still runs.
      if (reopened !== null) await reopened.close().catch(() => {});
      if (journal !== null) await journal.close().catch(() => {});
      await closeServer(server);
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});

// --- proof 1 -----------------------------------------------------------------------

describe('proof 1: one mediated path (a regression guard on kernel sources)', () => {
  it('sees fetch only at the two frontier call sites and no network module anywhere', async () => {
    const sources = await kernelSources();
    // Needles are composed at runtime so this test never matches itself.
    const FETCH = 'fet' + 'ch(';
    expect(containing(sources, FETCH)).toEqual([
      'node/tools/web.ts', 'provider/transport.ts',
    ]);

    for (const banned of [
      'node:' + 'http', 'node:' + 'https', 'node:' + 'net', 'node:' + 'tls',
      'node:' + 'http2', 'node:' + 'dgram', 'undici', 'WebSocket',
    ]) {
      expect({ needle: banned, files: containing(sources, banned) })
        .toEqual({ needle: banned, files: [] });
    }

    // Bare specifiers too: `from 'http'` and `require('net')` are the same
    // module as `node:http`/`node:net`, and a regression must not slip through
    // by omitting the prefix.
    for (const bare of ['http', 'https', 'net', 'tls', 'http2', 'dgram']) {
      for (const needle of [
        `from '${bare}'`, `from "${bare}"`,
        `require('${bare}')`, `require("${bare}")`,
        `import('${bare}')`, `import("${bare}")`,
      ]) {
        expect({ needle, files: containing(sources, needle) })
          .toEqual({ needle, files: [] });
      }
    }

    // Exactly three legitimate kernel sites; a fourth fails the proof.
    expect(containing(sources, 'child' + '_process')).toEqual([
      'journal/lock.ts', 'node/tools/sandbox.ts', 'node/world-git.ts',
    ]);
  });

  it('sees each frontier consumer only at its definition and documented home', async () => {
    const sources = await kernelSources();
    expect(containing(sources, 'OpenAI' + 'Transport')).toEqual([
      'provider/transport.ts',
    ]);
    expect(containing(sources, 'webToolsFrom' + 'Providers')).toEqual([
      'node/tools/providers.ts', 'node/tools/web.ts',
    ]);
    expect(containing(sources, 'openFrontier' + 'Journal')).toEqual([
      'frontier/index.ts', 'frontier/journal.ts',
    ]);
  });
});

// --- proof 2 -----------------------------------------------------------------------

describe('proof 2: no send without a durable request', () => {
  it('the LLM transport finds the exact posted bytes already durable', async () => {
    const { home, world } = fixture();
    const seeded = await commitAs(world, 'human', { 'direction.txt': 'durable first\n' });
    const checks: string[] = [];
    const url = TEST_FACTS.url;
    class DurableTransport implements SerializedTransport {
      readonly facts: TransportFacts = TEST_FACTS;
      readonly sends: Uint8Array[] = [];
      async post(body: Uint8Array): Promise<TransportResult> {
        // At entry: `begin` already returned, so the request record and its
        // blob must be durable and readable while the writer still lives.
        const reader = await JournalReader.openIn(frontierLayout(home), {
          knownTypes: FRONTIER_EVENT_TYPES,
        });
        const requests: HttpRequest[] = [];
        for await (const event of reader.events()) {
          if (event.type === 'http/request') {
            requests.push(event.data as unknown as HttpRequest);
          }
        }
        const digest = sha256HexOf(Buffer.from(body));
        const match = requests.find((request) =>
          request.url === url && request.body.sha256 === digest);
        if (match === undefined) {
          checks.push('no durable http/request for the posted bytes');
        } else {
          if (match.body.bytes !== body.length) checks.push('durable byte count differs');
          const durable = await new BlobStore(home).get(match.body.sha256);
          if (!Buffer.from(durable).equals(Buffer.from(body))) {
            checks.push('durable body bytes differ from the posted bytes');
          }
        }
        this.sends.push(body);
        return {
          status: 200, headers: {}, complete: true, failure: null,
          body: Buffer.from(assistantReply('done')),
        };
      }
    }
    const transport = new DurableTransport();
    let running: Running | null = null;
    try {
      running = await openRuntime({
        home, world,
        adapter: new ProviderAdapter(transport, providerPolicy, (await fixture().frontier()).gate),
      });
      await park(running);
      await settle(running);
      running = null;

      expect(checks).toEqual([]);
      expect(transport.sends).toHaveLength(1);
      const requests = requestsOf(await frontierOf(home));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(url);
      expect(requests[0]!.world_head).toBe(seeded);
    } finally {
      await settle(running);
    }
  }, 20000);

  it('the Tavily handler finds the request durable at receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c14d-proof2-web-'));
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    const checks: string[] = [];
    let tavily: LoopServer | null = null;
    let journal: FrontierJournal | null = null;
    try {
      tavily = await serveJson(async (request) => {
        // Receipt-time read: the request must already be durable, with the exact
        // bytes the provider just received.
        const reader = await JournalReader.openIn(frontierLayout(home), {
          knownTypes: FRONTIER_EVENT_TYPES,
        });
        const requests: HttpRequest[] = [];
        for await (const event of reader.events()) {
          if (event.type === 'http/request') {
            requests.push(event.data as unknown as HttpRequest);
          }
        }
        const match = requests.find((candidate) =>
          candidate.url === `${tavily!.url}/search`);
        if (match === undefined) {
          checks.push('no durable http/request at receipt');
        } else {
          if (match.body.bytes !== request.body.length) checks.push('durable byte count differs');
          const durable = await new BlobStore(home).get(match.body.sha256);
          if (!Buffer.from(durable).equals(request.body)) {
            checks.push('durable request bytes differ from the receipt');
          }
        }
        return { body: SEARCH_PAYLOAD };
      });
      await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: {
        key: TAVILY_KEY, baseUrl: tavily.url, timeoutMs: 5000,
      } }), 'utf8');

      journal = await openTestFrontier(home);
      const webTools = webToolsFromProviders(await loadProviders(home), journal.gate);
      if (webTools === undefined) throw new Error('tavily registry entry missing');

      const outcome = await webTools.search(
        'emergent societies', undefined, new AbortController().signal);
      expect(outcome.ok).toBe(true);
      expect(checks).toEqual([]);
      expect(tavily.failures).toEqual([]);
      expect(tavily.requests).toHaveLength(1);
      const requests = requestsOf(await frontierOf(home));
      expect(requests.map((request) => request.url)).toEqual([`${tavily.url}/search`]);
      expect(requests[0]!.credentials).toEqual([{ id: 'tavily', where: 'authorization' }]);
    } finally {
      if (journal !== null) await journal.close().catch(() => {});
      if (tavily !== null) await tavily.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  it('a frontier flush failure stops the LLM send (the negative at the LLM site)', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'never send\n' });
    const model = await serveJson(() => ({ body: NO_CALLS }));
    const restore = failFrontierFlushes(home);
    let running: Running | null = null;
    try {
      running = await openRuntime({
        home, world,
        adapter: new ProviderAdapter(
          new OpenAITransport({ endpoint: `${model.url}/v1/chat/completions`, key: LLM_KEY }),
          providerPolicy,
          (await fixture().frontier()).gate,
        ),
      });
      await expect(running.run).rejects.toThrow('injected frontier flush failure');
      await settle(running);
      running = null;

      expect(model.requests).toHaveLength(0);
      expect(model.failures).toEqual([]);
      expect(requestsOf(await frontierOf(home))).toHaveLength(0);
    } finally {
      restore();
      await settle(running);
      await model.close();
    }
  }, 20000);

  it('a frontier flush failure stops the web send (the negative at the web site)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c14d-proof2-web-negative-'));
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    const tavily = await serveJson(() => ({ body: SEARCH_PAYLOAD }));
    let journal: FrontierJournal | null = null;
    const restore = failFrontierFlushes(home);
    try {
      await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: {
        key: TAVILY_KEY, baseUrl: tavily.url, timeoutMs: 5000,
      } }), 'utf8');
      journal = await openTestFrontier(home);
      const webTools = webToolsFromProviders(await loadProviders(home), journal.gate);
      if (webTools === undefined) throw new Error('tavily registry entry missing');

      await expect(webTools.search('emergent societies', undefined, new AbortController().signal))
        .rejects.toThrow('injected frontier flush failure');
      expect(tavily.requests).toHaveLength(0);
      expect(requestsOf(await frontierOf(home))).toHaveLength(0);
    } finally {
      restore();
      if (journal !== null) await journal.close().catch(() => {});
      await tavily.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});

// --- proof 3 -----------------------------------------------------------------------

describe('proof 3: no visibility without a durable response', () => {
  it('a rejected terminal propagates fatally and no projection happens', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'never visible\n' });
    const model = await serveJson(() => ({ body: NO_CALLS }));
    const real = await fixture().frontier();
    // The seam is exactly at the `Frontier` boundary the adapter takes: a stub
    // whose `complete` rejects (the flush spy would fail `begin` and prove the
    // wrong half).
    const stub: Frontier = {
      begin: (input) => real.gate.begin(input),
      complete: () => Promise.reject(new Error('injected complete failure')),
    };
    let running: Running | null = null;
    try {
      running = await openRuntime({
        home, world,
        adapter: new ProviderAdapter(
          new OpenAITransport({ endpoint: `${model.url}/v1/chat/completions`, key: LLM_KEY }),
          providerPolicy,
          stub,
        ),
      });
      await expect(running.run).rejects.toThrow('injected complete failure');
      await settle(running);
      running = null;

      // The exchange reached the provider, so this is not a vacuous refusal.
      expect(model.requests).toHaveLength(1);
      const frontier = await frontierOf(home);
      expect(frontier.filter((event) => event.type === 'http/request')).toHaveLength(1);
      expect(frontier.filter((event) => event.type === 'http/response')).toHaveLength(0);

      // No projection: the local log has no assistant message and no tool call.
      const events = await nodeEvents(home);
      expect(events.some((event) => event.type === 'assistant/message')).toBe(false);
      expect(events.some((event) => event.type === 'tool/call')).toBe(false);
      expect(events.find((event) => event.type === 'turn/end')?.data)
        .toMatchObject({ outcome: 'error' });
    } finally {
      await settle(running);
      await model.close();
    }
  }, 20000);
});

// --- proof 4 -----------------------------------------------------------------------

describe('proof 4: the honest orphan', () => {
  it('a crash between request and terminal leaves one idempotent marker, chain verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c14d-proof4-'));
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    try {
      const journal = await openTestFrontier(home);
      const input: FrontierRequestInput = {
        method: 'POST',
        url: 'https://api.example.test/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        credentials: [{ id: 'llm', where: 'authorization' }],
        body: Buffer.from('{"model":"mock-model","messages":[]}', 'utf8'),
        encoding: 'utf8',
      };
      const call = await journal.gate.begin(input);
      // The crash: an in-process close after `begin`, with no `complete`. It
      // leaves exactly the durable content a real crash would.
      await journal.close();

      const reopened = await openTestFrontier(home);
      await reopened.close();
      // `readFrontier` reads through the verifying reader: the chain verifies.
      const first = await frontierOf(home);
      expect(first.map((event) => event.type)).toEqual(['http/request', 'http/incomplete']);
      expect(first[1]!.data).toEqual({ call: call.call });

      // Idempotent: a second boot appends nothing.
      const second = await openTestFrontier(home);
      await second.close();
      const again = await frontierOf(home);
      expect(again).toHaveLength(2);
      expect(again.filter((event) => event.type === 'http/incomplete')).toHaveLength(1);
      expect(again[1]!.data).toEqual({ call: call.call });
      // The body blob is still the exact bytes, despite the missing terminal.
      const request = again[0]!.data as unknown as HttpRequest;
      expect((await new BlobStore(home).get(request.body.sha256)).toString('utf8'))
        .toBe('{"model":"mock-model","messages":[]}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});

// --- proof 5 -----------------------------------------------------------------------

describe('proof 5: retry correlation and body dedup', () => {
  it('shares one group, increments attempts, and stores one body blob', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'retry once\n' });
    const model = await serveJson((_request, index) => index === 0
      ? { status: 500, body: '{}' }
      : { body: assistantReply('recovered') });
    let running: Running | null = null;
    try {
      running = await openRuntime({
        home, world,
        config: testConfig({ maxAttempts: 2 }),
        adapter: new ProviderAdapter(
          new OpenAITransport({ endpoint: `${model.url}/v1/chat/completions`, key: LLM_KEY }),
          providerPolicy,
          (await fixture().frontier()).gate,
        ),
      });
      await park(running);
      await settle(running);
      running = null;

      expect(model.requests).toHaveLength(2);
      const frontier = await frontierOf(home);
      const requests = requestsOf(frontier);
      const terminals = responsesOf(frontier);
      expect(requests).toHaveLength(2);
      expect(terminals).toHaveLength(2);
      // One logical operation: one group, contiguous attempts, distinct calls.
      expect(requests[1]!.group).toBe(requests[0]!.group);
      expect(requests[0]!.call).not.toBe(requests[1]!.call);
      expect(requests.map((request) => request.attempt)).toEqual([0, 1]);
      // Durable per attempt: every attempt has its own terminal.
      expect(new Set(terminals.map((terminal) => terminal.call)))
        .toEqual(new Set(requests.map((request) => request.call)));
      expect(terminals.map((terminal) => terminal.status)).toEqual([500, 200]);
      // Same body bytes; one content-addressed blob holds them.
      const digest = requests[0]!.body.sha256;
      expect(requests[1]!.body.sha256).toBe(digest);
      expect(requests[1]!.body.bytes).toBe(requests[0]!.body.bytes);
      expect((await new BlobStore(home).get(digest)).equals(model.requests[0]!.body)).toBe(true);
      const files = await readdir(join(home, 'blobs'), {
        recursive: true, withFileTypes: true,
      });
      expect(files.filter((entry) => entry.isFile() && entry.name === digest)).toHaveLength(1);
      expect(new Set(requests.map((request) => request.body.sha256)).size).toBe(1);
    } finally {
      await settle(running);
      await model.close();
    }
  }, 20000);
});

// --- proof 6 -----------------------------------------------------------------------

describe('proof 6: the credential never lands through the request path', () => {
  it('no frontier payload, header, URL or request blob carries a key value', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'mixed run\n' });
    const model = await serveJson((_request, index) => index === 0
      ? { body: SEARCH_CALL }
      : { body: assistantReply('done') });
    const tavily = await serveJson(() => ({ body: SEARCH_PAYLOAD }));
    let running: Running | null = null;
    try {
      await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: {
        key: TAVILY_KEY, baseUrl: tavily.url, timeoutMs: 5000,
      } }), 'utf8');
      const journal = await fixture().frontier();
      const webTools = webToolsFromProviders(await loadProviders(home), journal.gate);
      if (webTools === undefined) throw new Error('tavily registry entry missing');
      running = await openRuntime({
        home, world, webTools,
        adapter: new ProviderAdapter(
          new OpenAITransport({ endpoint: `${model.url}/v1/chat/completions`, key: LLM_KEY }),
          providerPolicy, journal.gate,
        ),
      });
      await park(running);
      await settle(running);
      running = null;

      const frontier = await frontierOf(home);
      const requests = requestsOf(frontier);
      expect(requests).toHaveLength(3);
      const keys = [LLM_KEY, TAVILY_KEY];
      for (const event of frontier) {
        const payload = canonicalizeJson(event.data);
        for (const key of keys) expect(payload).not.toContain(key);
      }
      const blobs = new BlobStore(home);
      for (const request of requests) {
        for (const key of keys) {
          expect(request.url).not.toContain(key);
          for (const value of Object.values(request.headers)) expect(value).not.toContain(key);
        }
        const body = Buffer.from(await blobs.get(request.body.sha256));
        for (const key of keys) expect(body.includes(key)).toBe(false);
      }
      // Credentials are ids and placements, never values: the LLM calls name the
      // transport's id, the web call the registry key.
      const llmRequests = requests.filter((request) => request.url.endsWith('/chat/completions'));
      const webRequests = requests.filter((request) => request.url.endsWith('/search'));
      expect(llmRequests).toHaveLength(2);
      expect(llmRequests.every((request) =>
        request.credentials.length === 1
        && request.credentials[0]!.id === 'llm'
        && request.credentials[0]!.where === 'authorization')).toBe(true);
      expect(webRequests).toHaveLength(1);
      expect(webRequests[0]!.credentials).toEqual([{ id: 'tavily', where: 'authorization' }]);
      // No request URL carries query, fragment or userinfo by construction.
      for (const request of requests) {
        expect(request.url).not.toContain('?');
        expect(request.url).not.toContain('#');
        expect(request.url).not.toContain('@');
      }
    } finally {
      await settle(running);
      await model.close();
      await tavily.close();
    }
  }, 20000);

  it('pins the accepted residual: a reflected key in a response body is journaled verbatim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c14d-proof6-reflect-'));
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    // The hostile provider reflects the authorization value it received.
    const tavily = await serveJson((request) => ({
      body: JSON.stringify({
        request_id: 'req-reflect', echoed: request.authorization, results: [],
      }),
    }));
    let journal: FrontierJournal | null = null;
    try {
      await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: {
        key: TAVILY_KEY, baseUrl: tavily.url, timeoutMs: 5000,
      } }), 'utf8');
      journal = await openTestFrontier(home);
      const webTools = webToolsFromProviders(await loadProviders(home), journal.gate);
      if (webTools === undefined) throw new Error('tavily registry entry missing');

      const outcome = await webTools.search('x', undefined, new AbortController().signal);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('unreachable');
      const response = responsesOf(await frontierOf(home))
        .find((candidate) => candidate.call === outcome.frontierCall);
      expect(response).toBeDefined();
      // The request path never carried it; the response body did, verbatim.
      const body = Buffer.from(await new BlobStore(home).get(response!.body.sha256));
      expect(body.toString('utf8')).toContain(`Bearer ${TAVILY_KEY}`);
    } finally {
      if (journal !== null) await journal.close().catch(() => {});
      await tavily.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});

// --- proof 7 -----------------------------------------------------------------------

describe('proof 7: the frontier is unreadable from the confined shell', () => {
  it.skipIf(!launcherPresent)(
    'denies reading and writing <home>/frontier, like the credential store',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'c14d-proof7-'));
      const home = join(root, 'home');
      const world = join(root, 'world');
      await mkdir(home, { recursive: true });
      await mkdir(world, { recursive: true });
      await writeFile(join(home, 'providers.json'), `${STORE_CANARY}\n`, { mode: 0o644 });
      // A populated frontier: one complete exchange, then closed and durable.
      const journal = await openTestFrontier(home);
      const call = await journal.gate.begin({
        method: 'POST',
        url: 'https://api.example.test/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"probe":true}', 'utf8'),
        encoding: 'utf8',
      });
      await journal.gate.complete(call, {
        status: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"ok":true}', 'utf8'), encoding: 'utf8', complete: true,
      });
      await journal.close();
      const layout = frontierLayout(home);
      const logFile = join(layout.dir, layout.logFile);
      const before = await readFile(logFile);
      const probePath = join(layout.dir, 'probe');
      const limits = { timeoutMs: 5000, killGraceMs: 100, maxCaptureBytes: 1024 * 1024 };

      let runtime: PtyTerminalRuntime | null = null;
      try {
        const spec = await buildSandboxSpec({ world, home, uid: 'n1' });
        runtime = new PtyTerminalRuntime(world, DEFAULT_TERMINAL_ENV, spec);
        // Each probe is its own command, so the denial is asserted per command
        // rather than as a count over one concatenated script.
        const probes: readonly { readonly name: string; readonly command: string }[] = [
          { name: 'read', command: `cat '${logFile}'` },
          { name: 'relative-read', command: `cat ../home/frontier/${layout.logFile}` },
          { name: 'append', command: `printf x >> '${logFile}'` },
          { name: 'create', command: `touch '${probePath}'` },
          { name: 'store', command: 'cat ../home/providers.json' },
        ];
        for (const probe of probes) {
          const outcome = await runtime.run(
            probe.command, limits, new AbortController().signal);
          const out = Buffer.from(outcome.output).toString('utf8');
          expect({ probe: probe.name, status: outcome.status })
            .toEqual({ probe: probe.name, status: 'completed' });
          expect({ probe: probe.name, denied: /Permission denied/.test(out) })
            .toEqual({ probe: probe.name, denied: true });
          expect({ probe: probe.name, failed: outcome.exitCode !== 0 })
            .toEqual({ probe: probe.name, failed: true });
          // The plaintext store's bytes never reach the shell (the frontier log
          // is zstd-framed, so its bytes are not a plaintext canary).
          if (probe.name === 'store') expect(out).not.toContain(STORE_CANARY);
        }
        // The shell itself is alive: a world write succeeds.
        const control = await runtime.run(
          'printf ok > ./world-probe.txt', limits, new AbortController().signal);
        expect(control).toMatchObject({ status: 'completed', exitCode: 0 });
        expect(await readFile(join(world, 'world-probe.txt'), 'utf8')).toBe('ok');
        // Nothing landed: the log is byte-identical and no probe file exists.
        expect((await readFile(logFile)).equals(before)).toBe(true);
        await expect(lstat(probePath)).rejects.toMatchObject({ code: 'ENOENT' });
        // The unconfined kernel still reads its own frontier and store.
        expect((await readFile(logFile)).equals(before)).toBe(true);
        expect(await readFile(join(home, 'providers.json'), 'utf8'))
          .toBe(`${STORE_CANARY}\n`);
      } finally {
        if (runtime !== null) await runtime.dispose(100);
        await journal.close().catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});

// --- proof 8 -----------------------------------------------------------------------

describe('proof 8: the world join', () => {
  it('stamps every request with the world HEAD the kernel observed', async () => {
    const { home, world } = fixture();
    const seeded = await commitAs(world, 'human', { 'direction.txt': 'world join\n' });
    const model = await serveJson((_request, index) => index === 0
      ? { body: SEARCH_CALL }
      : { body: assistantReply('done') });
    const tavily = await serveJson(() => ({ body: SEARCH_PAYLOAD }));
    let running: Running | null = null;
    try {
      await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: {
        key: TAVILY_KEY, baseUrl: tavily.url, timeoutMs: 5000,
      } }), 'utf8');
      const journal = await fixture().frontier();
      const webTools = webToolsFromProviders(await loadProviders(home), journal.gate);
      if (webTools === undefined) throw new Error('tavily registry entry missing');
      running = await openRuntime({
        home, world, webTools,
        adapter: new ProviderAdapter(
          new OpenAITransport({ endpoint: `${model.url}/v1/chat/completions`, key: LLM_KEY }),
          providerPolicy, journal.gate,
        ),
      });
      await park(running);
      await settle(running);
      running = null;

      // The world never moved during the run, so every stamp is that HEAD.
      expect(await world.headHash()).toBe(seeded);
      const requests = requestsOf(await frontierOf(home));
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests.every((request) => request.world_head === seeded)).toBe(true);
      expect(requests.every((request) =>
        request.world_head !== null && WORLD_HEAD_RE.test(request.world_head))).toBe(true);
    } finally {
      await settle(running);
      await model.close();
      await tavily.close();
    }
  }, 20000);

  it('stamps null when the callback throws or returns a non-hex value, never failing the send', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c14d-proof8-null-'));
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    const begin = async (journal: FrontierJournal): Promise<void> => {
      const call = await journal.gate.begin({
        method: 'POST',
        url: 'https://api.example.test/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{"probe":true}', 'utf8'),
        encoding: 'utf8',
      });
      await journal.gate.complete(call, {
        status: 200, body: new Uint8Array(), encoding: 'binary', complete: true,
      });
      await journal.close();
    };
    try {
      const throwing = await openFrontierJournal(home, {
        worldHead: () => Promise.reject(new Error('world unreadable')),
        now: Date.now, batchWindowMs: 60000,
      });
      await begin(throwing);
      const nonHex = await openFrontierJournal(home, {
        worldHead: async () => 'not-a-head',
        now: Date.now, batchWindowMs: 60000,
      });
      await begin(nonHex);

      const requests = requestsOf(await frontierOf(home));
      expect(requests).toHaveLength(2);
      expect(requests.map((request) => request.world_head)).toEqual([null, null]);
      expect(responsesOf(await frontierOf(home))).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
});

// --- proof 9 -----------------------------------------------------------------------

describe('proof 9: agnosticism', () => {
  const BANNED = ['node', 'turn', 'uid', 'session', 'tool', 'provider', 'model',
    'tokens', 'cost'] as const;

  it('no resolved frontier event carries a structural field', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'agnostic\n' });
    const model = await serveJson((_request, index) => index === 0
      ? { body: SEARCH_CALL }
      : { body: assistantReply('done') });
    const tavily = await serveJson(() => ({ body: SEARCH_PAYLOAD }));
    let running: Running | null = null;
    try {
      await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: {
        key: TAVILY_KEY, baseUrl: tavily.url, timeoutMs: 5000,
      } }), 'utf8');
      const journal = await fixture().frontier();
      const webTools = webToolsFromProviders(await loadProviders(home), journal.gate);
      if (webTools === undefined) throw new Error('tavily registry entry missing');
      running = await openRuntime({
        home, world, webTools,
        adapter: new ProviderAdapter(
          new OpenAITransport({ endpoint: `${model.url}/v1/chat/completions`, key: LLM_KEY }),
          providerPolicy, journal.gate,
        ),
      });
      await park(running);
      await settle(running);
      running = null;

      const frontier = await frontierOf(home);
      expect(frontier.length).toBeGreaterThan(0);
      for (const event of frontier) {
        const keys = keysOf(event.data);
        const found = BANNED.filter((key) => keys.has(key));
        expect({ seq: event.seq, found }).toEqual({ seq: event.seq, found: [] });
      }
    } finally {
      await settle(running);
      await model.close();
      await tavily.close();
    }
  }, 20000);

  it('the validators refuse node, turn and uid keys on an otherwise valid payload', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'refused keys\n' });
    const model = await serveJson(() => ({ body: NO_CALLS }));
    let running: Running | null = null;
    try {
      running = await openRuntime({
        home, world,
        adapter: new ProviderAdapter(
          new OpenAITransport({ endpoint: `${model.url}/v1/chat/completions`, key: LLM_KEY }),
          providerPolicy, (await fixture().frontier()).gate,
        ),
      });
      await park(running);
      await settle(running);
      running = null;

      const request = requestsOf(await frontierOf(home))[0]!;
      const payload = request as unknown as Record<string, unknown>;
      // The unmodified payload validates; each structural key makes it refuse.
      expect(() => validateFrontierEvent('http/request', payload)).not.toThrow();
      for (const key of ['node', 'turn', 'uid']) {
        expect(() => validateFrontierEvent('http/request', { ...payload, [key]: 'n1' }))
          .toThrow(FrontierValidationError);
      }
    } finally {
      await settle(running);
      await model.close();
    }
  }, 20000);
});

// --- proof 11 ----------------------------------------------------------------------

/**
 * A transport that answers from a queue. `calls` counts invocations at the very
 * top — before the offline guard — so a regression that sends during boot is
 * visible even though the adapter swallows the throw; `throwIfCalled` keeps the
 * old hard failure.
 */
class QueueTransport implements SerializedTransport {
  readonly facts: TransportFacts = TEST_FACTS;
  readonly sends: Uint8Array[] = [];
  calls = 0;
  throwIfCalled = false;

  constructor(private readonly replies: readonly TransportResult[]) {}

  async post(body: Uint8Array): Promise<TransportResult> {
    this.calls += 1;
    if (this.throwIfCalled) throw new Error('offline boot sent a request');
    this.sends.push(body);
    const reply = this.replies[this.sends.length - 1];
    if (reply === undefined) throw new Error('scripted transport exhausted');
    return reply;
  }
}

function okReply(body: string): TransportResult {
  return {
    status: 200, headers: {}, complete: true, failure: null, body: Buffer.from(body),
  };
}

describe('proof 11: cold start off the slimmed log', () => {
  it('a fresh runtime rebuilds an identical state from the local log alone', async () => {
    const { home, world } = fixture();
    await commitAs(world, 'human', { 'direction.txt': 'cold start\n' });
    const script = new QueueTransport([okReply(assistantReply(
      null, [{ id: 'w1', name: 'wait', arguments: {} }],
    ))]);
    let running: Running | null = null;
    let restarted: {
      readonly driver: NodeDriver;
      readonly runtime: ReturnType<typeof createAgentRuntime>;
    } | null = null;
    try {
      running = await openRuntime({
        home, world,
        config: testConfig(),
        adapter: new ProviderAdapter(script, providerPolicy, (await fixture().frontier()).gate),
      });
      await park(running);
      await settle(running);
      const before = running.runtime.snapshot();
      running = null;
      expect(script.sends).toHaveLength(1);

      // The frontier has the exchange facts; the cold start must not need them.
      expect(requestsOf(await frontierOf(home))).toHaveLength(1);

      const offline = new QueueTransport([]);
      offline.throwIfCalled = true;
      const differing = {
        ...defaultAgentConfig(), charter: 'DIFFERENT CHARTER', heading: 'DIFFERENT HEADING',
      };
      const runtime = createAgentRuntime({
        home, uid: 'n1', world, initialConfig: differing,
        terminal: { env: DEFAULT_TERMINAL_ENV },
        adapter: new ProviderAdapter(offline, providerPolicy, (await fixture().frontier()).gate),
      });
      const driver = await NodeDriver.open(home, 'n1', runtime.handler, world, {
        knownTypes: C13_EVENT_TYPES, hooks: runtime.hooks, worldPollMs: 0,
      });
      restarted = { driver, runtime };
      // open() rebuilt offline: no send — counted at entry, before the throw the
      // adapter would swallow — and no frontier crossing either.
      expect(offline.calls).toBe(0);
      expect(offline.sends).toHaveLength(0);
      expect(requestsOf(await frontierOf(home))).toHaveLength(1);
      const rebuilt = runtime.snapshot();
      // The rebuilt fold is the same semantic state; only the watermark moved
      // (the resume appended `node/boot`, which the next fold observed).
      expect(rebuilt.config).toEqual(before.config);
      expect(rebuilt.surface).toEqual(before.surface);
      expect(rebuilt.open).toEqual(before.open);
      expect(rebuilt.pendingCompactions).toEqual(before.pendingCompactions);
      expect(rebuilt.recovery).toEqual([]);
      // The omission is explicit: the watermark is the last observed event (the
      // resume's `node/boot`), strictly past the pre-stop one.
      const after = await nodeEvents(home);
      const last = after[after.length - 1]!;
      expect(rebuilt.watermark).toEqual({ seq: last.raw.seq, hash: last.raw.hash });
      if (before.watermark === null) throw new Error('the first boot left no watermark');
      expect(rebuilt.watermark!.seq).toBeGreaterThan(before.watermark.seq);
      // The journaled charter won: the differing initial config never applied.
      expect(rebuilt.config?.value.charter).toBe(before.config?.value.charter);
      expect(rebuilt.config?.value.charter).not.toBe(differing.charter);
      expect(rebuilt.config?.value.heading).not.toBe(differing.heading);

      // The local log carries the slim vocabulary only: the retired wire facts
      // and the retired attempt fact never appear.
      const types = new Set((await nodeEvents(home)).map((event) => event.type));
      for (const retired of [
        'request/plan', 'request/wire', 'response/raw', 'request/usage', 'assistant/attempt',
      ]) {
        expect(types.has(retired)).toBe(false);
      }
      expect(types.has('assistant/message')).toBe(true);
      expect(types.has('tool/call')).toBe(true);
      expect(types.has('tool/result')).toBe(true);
      expect(types.has('world/perception')).toBe(true);
    } finally {
      await settle(running);
      if (restarted !== null) {
        restarted.driver.stop();
        await restarted.driver.run().catch(() => {});
      }
    }
  }, 20000);
});

// --- proof 12 ----------------------------------------------------------------------

describe('proof 12: the shared ceiling', () => {
  it('FRONTIER_MAX_BODY_BYTES equals the node gate capture ceiling', () => {
    expect(FRONTIER_MAX_BODY_BYTES).toBe(MAX_CAPTURE_BYTES);
  });
});
