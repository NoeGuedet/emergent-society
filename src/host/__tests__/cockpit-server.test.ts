import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { serveJson } from '../../node/__tests__/helpers.js';
import { startCockpit, type CockpitHandle } from '../cockpit/server.js';
import { ConversationLog } from '../../node/conversation.js';

const roots: string[] = [];
const handles: CockpitHandle[] = [];
const servers: { close(): Promise<void> }[] = [];

function statusWithHost(url: string, host: string, authorization: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host, authorization } }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
    req.end();
  });
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('serves the authenticated local API, saves chat and lists a no-follow world tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'es-cockpit-'));
  roots.push(root);
  const runsRoot = join(root, 'runs');
  const providerHome = join(root, 'provider');
  await mkdir(runsRoot, { mode: 0o700 });
  await mkdir(providerHome, { mode: 0o700 });
  const provider = await serveJson(() => ({
    body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'unused' } }] }),
  }));
  servers.push(provider);
  await writeFile(join(providerHome, 'providers.json'), JSON.stringify({
    llm: {
      key: 'test-key', endpoint: `${provider.url}/v1/chat/completions`,
      models: [
        { id: 'm-node', contextTokens: 100_000, maxOutputTokens: 8_000 },
        { id: 'm-gate', contextTokens: 100_000, maxOutputTokens: 8_000 },
        { id: 'm-ids' },
      ],
    },
  }), { mode: 0o600 });
  const charter = join(root, 'gateway.md');
  await writeFile(charter, 'You are the gateway.\n', { mode: 0o600 });
  const handle = await startCockpit({
    runsRoot, providerHome, gatewayCharter: charter,
    tokenFile: join(root, 'token'), autoLaunch: false,
  });
  handles.push(handle);
  const token = (await readFile(handle.tokenPath, 'utf8')).trim();
  const auth = { authorization: `Bearer ${token}` };
  const url = handle.url;

  expect((await fetch(`${url}/api/runs`)).status).toBe(401);
  expect((await fetch(`${url}/api/runs`, {
    headers: { authorization: 'Bearer wrong-token' },
  })).status).toBe(401);
  expect((await fetch(`${url}/api/runs`, {
    headers: { ...auth, origin: 'http://127.0.0.1:1' },
  })).status).toBe(403);
  expect(await statusWithHost(`${url}/api/runs`, 'evil.example', auth.authorization))
    .toBe(403);
  expect(await statusWithHost(`${url}/api/runs`, 'evil.example', ''))
    .toBe(401);
  expect(await statusWithHost(`${url}/api/runs`, 'evil.example', 'Bearer wrong-token'))
    .toBe(401);

  const page = await (await fetch(`${url}/`)).text();
  expect(page).not.toContain(token);
  const catalog = await (await fetch(`${url}/api/catalog`, { headers: auth })).json() as {
    models: readonly { id: string }[];
  };
  expect(catalog.models.map((model) => model.id)).toEqual(['m-node', 'm-gate', 'm-ids']);

  const windowless = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'bad', heading: 'Bad.', nodeModel: 'm-ids', gatewayModel: 'm-gate',
      nodeCount: 1, nodeLimit: 10, spawn: false,
    }),
  });
  expect(windowless.status).toBe(400);
  const outsideGateway = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'bad', heading: 'Bad.', nodeModel: 'm-node', gatewayModel: 'missing',
      nodeCount: 1, nodeLimit: 10, spawn: false,
    }),
  });
  expect(outsideGateway.status).toBe(400);

  const createdResponse = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'first', heading: 'First light.', nodeModel: 'm-node', gatewayModel: 'm-gate',
      nodeCount: 1, nodeLimit: 10, spawn: false,
    }),
  });
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json() as { run: { id: string; nodeCount: number } };
  expect(created.run.nodeCount).toBe(1);
  const id = created.run.id;

  const list = await (await fetch(`${url}/api/runs`, { headers: auth })).text();
  expect(list).toContain(id);
  expect(list).not.toContain(token);

  const equal = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      label: 'same model', heading: 'Same.', nodeModel: 'm-node', gatewayModel: 'm-node',
      nodeCount: 1, nodeLimit: 10, spawn: false,
    }),
  });
  expect(equal.status).toBe(201);

  const home = join(runsRoot, id, 'home');
  await writeFile(join(home, 'world', 'note.txt'), 'uncommitted\n');
  await symlink('/etc/passwd', join(home, 'world', 'outside-link'));
  const tree = await (await fetch(`${url}/api/runs/${id}/tree`, { headers: auth })).json() as {
    entries: readonly { path: string; type: string }[];
  };
  expect(tree.entries).toContainEqual({ path: 'note.txt', type: 'file', size: 12 });
  expect(tree.entries).toContainEqual({ path: 'outside-link', type: 'symlink' });

  const saved = await fetch(`${url}/api/runs/${id}/chat`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'unique operator message' }),
  });
  expect(saved.status).toBe(202);
  const chat = await (await fetch(`${url}/api/runs/${id}/chat`, { headers: auth })).json() as {
    records: readonly { text: string; uid: string }[];
  };
  expect(chat.records).toContainEqual(expect.objectContaining({
    uid: 'human', text: 'unique operator message',
  }));
  await ConversationLog.for(home).append('gateway', 'node-0', 'mailbox hello');
  const mailbox = await (await fetch(`${url}/api/runs/${id}/mailbox`, {
    headers: auth,
  })).json() as { records: readonly { from: string; to: string; text: string }[] };
  expect(mailbox.records).toContainEqual(expect.objectContaining({
    from: 'gateway', to: 'node-0', text: 'mailbox hello',
  }));
  expect(provider.requests).toHaveLength(0);
}, 30_000);
