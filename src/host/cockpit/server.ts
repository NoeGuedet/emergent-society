import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProviderStore } from '../credentials.js';
import { ChatWriter } from '../chat.js';
import { loadOrCreateBearer, bearerMatches } from './auth.js';
import { CockpitManager } from './manager.js';
import { RunsStore, type CreateRunInput } from './runs.js';
import {
  readChatTail, readMailbox, readNodes, readRunView, readTree,
} from './projections.js';

export type CockpitOptions = {
  readonly runsRoot: string;
  readonly providerHome: string;
  readonly gatewayCharter: string;
  readonly port?: number;
  /** Test seam; production defaults outside every guest root. */
  readonly tokenFile?: string;
  /** Test seam: create without spawning the production wrapper. */
  readonly autoLaunch?: boolean;
  readonly log?: { emit(event: string, data?: unknown): void };
};

export type CockpitHandle = {
  readonly url: string;
  readonly tokenPath: string;
  close(): Promise<void>;
};

const MAX_BODY = 16 * 1024;
const MAX_CHAT = 8192;

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(bytes);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} is invalid`);
  }
  return value as number;
}

/**
 * The local cockpit: one Node builtin HTTP process, loopback only, bearer on
 * every `/api` route, no CORS, and no model call on any GET.
 */
export async function startCockpit(options: CockpitOptions): Promise<CockpitHandle> {
  const runs = await RunsStore.open(options.runsRoot);
  const tokenPath = options.tokenFile
    ?? join(homedir(), '.config', 'emergent-society', 'cockpit-token');
  const token = await loadOrCreateBearer(tokenPath);
  const provider = await loadProviderStore(options.providerHome);
  const manager = new CockpitManager(runs, options.log ?? { emit: () => {} });
  await manager.reconcile();
  const assetDir = fileURLToPath(new URL('./frontend/', import.meta.url));
  let port = options.port ?? 0;
  const server = createServer((req, res) => {
    void dispatch(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'request failed' });
      else res.end();
    });
  });

  const hostAllowed = (): string[] => [
    `127.0.0.1:${port}`, `localhost:${port}`,
  ];

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const api = url.pathname.startsWith('/api');
    // Auth decides before headers: missing/wrong credentials are ALWAYS 401,
    // even when the same request carries a spoofed Host/Origin.
    if (api) {
      const supplied = req.headers.authorization;
      if (supplied === undefined || !supplied.startsWith('Bearer ')
        || !bearerMatches(token, supplied.slice(7))) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
    }
    const host = req.headers.host;
    if (host !== undefined && !hostAllowed().includes(host)) {
      json(res, 403, { error: 'host refused' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined
      && !hostAllowed().some((value) => origin === `http://${value}`)) {
      json(res, 403, { error: 'origin refused' });
      return;
    }
    if (!api) {
      await serveAsset(url.pathname, res);
      return;
    }
    try {
      await route(req, res, url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'request failed';
      json(res, 400, { error: message.slice(0, 200) });
    }
  }

  async function serveAsset(pathname: string, res: ServerResponse): Promise<void> {
    const file = pathname === '/' ? 'index.html'
      : pathname === '/app.js' ? 'app.js'
        : pathname === '/style.css' ? 'style.css' : null;
    if (file === null) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      const bytes = await readFile(join(assetDir, file));
      res.statusCode = 200;
      res.setHeader('content-type',
        file.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css') ? 'text/css; charset=utf-8'
            : 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(bytes);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const segments = url.pathname.split('/').filter((part) => part !== '');
    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      json(res, 200, {
        models: (provider.llm?.models ?? []).map((model) => ({
          id: model.id,
          ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
          ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
        })),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const active = manager.active();
      const list = await runs.list();
      const views = [];
      for (const run of list) {
        views.push(await readRunView(run, await runs.home(run.id), active?.id ?? null));
      }
      json(res, 200, { active: active?.id ?? null, runs: views });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      if (manager.active() !== null) {
        json(res, 409, { error: 'one active run is allowed' });
        return;
      }
      const input = await bodyOf(req) as Partial<CreateRunInput>;
      const catalog = provider.llm?.models;
      const nodeModel = text(input.nodeModel, 'nodeModel', 256);
      const gatewayModel = text(input.gatewayModel, 'gatewayModel', 256);
      if (catalog !== undefined) {
        const node = catalog.find((model) => model.id === nodeModel);
        if (node === undefined) throw new Error('node model is not in the declared catalog');
        if (node.contextTokens === undefined || node.maxOutputTokens === undefined) {
          throw new Error('the node model must declare both context windows');
        }
        if (!catalog.some((model) => model.id === gatewayModel)) {
          throw new Error('gateway model is not in the declared catalog');
        }
      }
      const nodeLimit = integer(input.nodeLimit, 'nodeLimit', 1, Number.MAX_SAFE_INTEGER);
      const nodeCount = integer(input.nodeCount, 'nodeCount', 1, 16);
      const created = await runs.create({
        label: text(input.label, 'label', 200),
        heading: text(input.heading, 'heading', 4096),
        nodeModel, gatewayModel, nodeCount, nodeLimit,
        spawn: input.spawn === true,
      }, options.providerHome, options.gatewayCharter);
      if (options.autoLaunch !== false) {
        try {
          await manager.launch(created, nodeLimit);
        } catch (err) {
          if (err instanceof Error && err.message.includes('one active run')) {
            json(res, 409, { error: 'one active run is allowed' });
            return;
          }
          throw err;
        }
      }
      json(res, 201, { run: created });
      return;
    }
    if (segments[0] === 'api' && segments[1] === 'runs' && segments[2] !== undefined) {
      const id = segments[2];
      const manifest = await runs.read(id).catch(() => null);
      if (manifest === null) {
        json(res, 404, { error: 'run not found' });
        return;
      }
      const home = await runs.home(id);
      const action = segments[3];
      if (req.method === 'GET' && action === undefined) {
        json(res, 200, {
          view: await readRunView(manifest, home, manager.active()?.id ?? null),
          diagnostics: manager.active()?.id === id
            ? manager.active()!.diagnostics.slice(-20) : [],
        });
        return;
      }
      if (req.method === 'GET' && action === 'chat') {
        json(res, 200, await readChatTail(home));
        return;
      }
      if (req.method === 'GET' && action === 'mailbox') {
        json(res, 200, { records: await readMailbox(home) });
        return;
      }
      if (req.method === 'GET' && action === 'tree') {
        json(res, 200, await readTree(home));
        return;
      }
      if (req.method === 'GET' && action === 'nodes') {
        json(res, 200, { nodes: await readNodes(home) });
        return;
      }
      if (req.method === 'POST' && action === 'chat') {
        const input = await bodyOf(req) as { text?: unknown };
        const message = text(input.text, 'text', MAX_CHAT);
        await ChatWriter.for(home).append(message, Date.now());
        json(res, 202, { ok: true });
        return;
      }
      if (req.method === 'POST' && action === 'observe') {
        try {
          await manager.observe(manifest);
        } catch (err) {
          if (err instanceof Error && err.message.includes('one active run')) {
            json(res, 409, { error: 'one active run is allowed' });
            return;
          }
          throw err;
        }
        json(res, 202, { ok: true });
        return;
      }
      if (req.method === 'POST' && action === 'pause') {
        await manager.pause(id);
        json(res, 200, { ok: true });
        return;
      }
    }
    json(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) port = address.port;
      resolve();
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    tokenPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await manager.shutdown();
    },
  };
}
