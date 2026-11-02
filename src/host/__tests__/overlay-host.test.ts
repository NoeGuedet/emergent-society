import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GATEWAY_ADDRESSEE, HUMAN_AUTHOR } from '../../journal/index.js';
import { readAttribution } from '../../frontier/index.js';
import { ChatLog, readChat } from '../chat.js';
import { startHost, type HostHandle, type HostOptions } from '../host.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';
import { formatStatus, readStatus } from '../status.js';
import { ConversationLog } from '../../node/conversation.js';
import { HeadWatcher } from '../../node/watcher.js';
import { WorldRepo } from '../../node/world.js';
import { commitAs, serveJson } from '../../node/__tests__/helpers.js';
import { readFrontier } from '../../frontier/__tests__/helpers.js';
import {
  GATEWAY_CHARTER_FILE, GATEWAY_CONFIG_FILE, persistOverlayConfig, readOverlaySidecars,
} from '../../overlay/charter.js';
import { OVERLAY_FRAMING } from '../../overlay/cycle.js';

/**
 * The gateway overlay at the host level: a host-side, single-tenant service —
 * never a pool member — whose one boot cycle digests the backlog of both
 * windows, whose model exchange crosses the frontier attributed to `gateway`,
 * whose prose lands natively in the chat log, and whose configuration is the
 * persisted sidecar pair. The optionality: without the flag the host runs
 * nodes-only and the stream accumulates under the absent-recipient rule.
 */

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const handles: HostHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.stop();
    await handle.done;
  }
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const nodes = () => JSON.stringify([
  { uid: 'node-0', model: 'node-model', heading: 'Root.' },
]);

function idle(): { body: string } {
  return { body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'idle' } }] }) };
}

type Wire = {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: string | null }[];
  readonly tools: readonly { readonly function: { readonly name: string } }[];
};

async function fixture(options: {
  readonly withCharter: boolean; readonly charterText?: string;
} = { withCharter: false }): Promise<{
  home: string; nodesFile: string; charterPath: string; lines: string[];
  world: WorldRepo;
  overlayBodies: string[]; nodeBodies: string[];
}> {
  const home = await mkdtemp(join(tmpdir(), 'es-overlay-host-'));
  dirs.push(home);
  await initHome(home);
  const world = await WorldRepo.open(join(home, 'world'), { gitDir: join(home, 'world.git') });
  HeadWatcher.for(world, 0);
  await commitAs(world, 'human', { 'seed.txt': 'seed\n' }, 'seed');
  const overlayBodies: string[] = [];
  const nodeBodies: string[] = [];
  const server = await serveJson((request) => {
    const body = request.body.toString('utf8');
    if (body.includes('You are the gateway overlay')) {
      overlayBodies.push(body);
      return { body: JSON.stringify({ choices: [{ message: {
        role: 'assistant', content: 'Backlog digested: one node needs a direction.',
      } }] }) };
    }
    nodeBodies.push(body);
    return idle();
  });
  servers.push(server);
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: {
      key: 'k', endpoint: `${server.url}/v1/chat/completions`,
      models: ['gateway-default', 'node-model', 'gateway-resume-model'],
    },
  }), { encoding: 'utf8', mode: 0o600 });
  const nodesFile = join(home, 'nodes.json');
  await writeFile(nodesFile, nodes(), 'utf8');
  const charterPath = join(home, 'operator-gateway.md');
  if (options.withCharter) {
    await writeFile(charterPath, options.charterText ?? 'You are the gateway overlay.\n',
      { encoding: 'utf8', mode: 0o600 });
  }
  return { home, nodesFile, charterPath, lines: [], world, overlayBodies, nodeBodies };
}

function start(fx: Awaited<ReturnType<typeof fixture>>, extra: Partial<HostOptions>): HostHandle {
  const handle = startHost({
    home: fx.home, uid: 'node-0', command: 'start', nodesFile: fx.nodesFile,
    sandbox: false, pollMs: 0,
    log: createHostLog((line) => { fx.lines.push(line); }),
    ...extra,
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  });
  handles.push(handle);
  return handle;
}

it('boots the overlay: one boot cycle over both window backlogs, the gateway-attributed exchange, the native chat delivery, and status', async () => {
  const fx = await fixture({ withCharter: true });
  // The backlog written while the host was down.
  const chat = await ChatLog.open(fx.home);
  await chat.append(HUMAN_AUTHOR, 'digest the backlog, gateway', 1_000);
  await chat.close();
  await ConversationLog.for(fx.home).append('node-0', undefined, 'node-0 needs a direction');

  start(fx, { gatewayCharter: fx.charterPath });
  await vi.waitFor(() => { expect(fx.overlayBodies).toHaveLength(1); }, { timeout: 30_000 });
  await vi.waitFor(async () => {
    expect((await readChat(fx.home)).some((message) => message.uid === GATEWAY_ADDRESSEE))
      .toBe(true);
  }, { timeout: 30_000 });

  // The request: the charter, the fixed framing line, BOTH bounded windows and
  // nothing but the overlay's three tools.
  const wire = JSON.parse(fx.overlayBodies[0]!) as Wire;
  expect(wire.model).toBe('gateway-default');
  expect(wire.messages[0]).toEqual({ role: 'system', content: 'You are the gateway overlay.\n' });
  expect(wire.messages[1]).toEqual({ role: 'system', content: OVERLAY_FRAMING });
  const windows = wire.messages.slice(2).map((message) => message.content ?? '');
  expect(windows.join('\n')).toContain('digest the backlog, gateway');
  expect(windows.join('\n')).toContain('node-0 needs a direction');
  expect(wire.tools.map((tool) => tool.function.name))
    .toEqual(['send_message', 'read_world', 'world_log']);

  // The native delivery: exactly ONE response record, appended by the cycle.
  const delivered = await readChat(fx.home);
  expect(delivered.map((message) => [message.uid, message.text])).toEqual([
    ['human', 'digest the backlog, gateway'],
    ['gateway', 'Backlog digested: one node needs a direction.'],
  ]);

  // The identity: the overlay's exchange is attributed to the reserved actor in
  // the frontier's sidecar; the frontier's own kinds are the frozen set.
  const attribution = await readAttribution(fx.home);
  expect(attribution.some((record) => record.uid === GATEWAY_ADDRESSEE)).toBe(true);
  const events = await readFrontier(fx.home);
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(['http/request', 'http/response', 'http/incomplete']).toContain(event.type);
  }

  // The config home: the operator's charter persisted, the model beside it,
  // both owner-only.
  expect(await readFile(join(fx.home, GATEWAY_CHARTER_FILE), 'utf8'))
    .toBe('You are the gateway overlay.\n');
  expect((await lstat(join(fx.home, GATEWAY_CHARTER_FILE))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(fx.home, GATEWAY_CONFIG_FILE))).mode & 0o777).toBe(0o600);
  const report = await readStatus(fx.home);
  expect(report.overlay).toEqual({ state: 'configured', model: 'gateway-default' });
  expect(formatStatus(report)).toContain('overlay: configured (gateway-default)');

  // The workers are untouched: the node's own request keeps the node offering
  // (no overlay tool is advertised to it), and the overlay is not a pool
  // member — one host/boot line, no node directory, no gateway uid.
  await vi.waitFor(() => { expect(fx.nodeBodies.length).toBeGreaterThanOrEqual(1); });
  const nodeWire = JSON.parse(fx.nodeBodies[0]!) as Wire;
  const nodeTools = nodeWire.tools.map((tool) => tool.function.name).sort();
  expect(nodeTools).toEqual(['execute', 'extend', 'wait', 'web_fetch', 'web_search']);
  expect(nodeTools).not.toContain('read_world');
  expect(nodeTools).not.toContain('world_log');
  const boots = fx.lines.filter((line) => line.includes('"event":"host/boot"'));
  expect(boots).toHaveLength(1);
  expect(boots[0]).toContain('"uid":"node-0"');
  expect(fx.lines.some((line) => line.includes('"uid":"gateway"'))).toBe(false);
  await expect(lstat(join(fx.home, 'nodes', GATEWAY_ADDRESSEE))).rejects.toBeTruthy();

  // Exactly one boot cycle: no further overlay exchange happened.
  const handle = handles[handles.length - 1]!;
  handle.stop();
  await handle.done;
  handles.length = 0;
  expect(fx.overlayBodies).toHaveLength(1);
});

it('runs nodes-only without --gateway-charter: no service, no diagnostic, and the stream waits', async () => {
  const fx = await fixture();
  await ConversationLog.for(fx.home).append('node-0', undefined, 'addressed to the absent gateway');
  start(fx, {});
  await vi.waitFor(() => { expect(fx.nodeBodies.length).toBeGreaterThanOrEqual(1); }, {
    timeout: 30_000,
  });
  const handle = handles[handles.length - 1]!;
  handle.stop();
  await handle.done;
  handles.length = 0;

  expect(fx.overlayBodies).toEqual([]);
  expect(await readChat(fx.home)).toEqual([]);
  expect(await readOverlaySidecars(fx.home)).toEqual({ kind: 'absent' });
  expect((await readStatus(fx.home)).overlay).toEqual({ state: 'none' });
  expect(formatStatus(await readStatus(fx.home))).toContain('overlay: none');
  // The record waits: the node's boot request carries no notice for it (the
  // gateway is not a node recipient).
  expect(fx.nodeBodies[0]).not.toContain('consult get_messages');
  // The stream itself is untouched by the absent recipient.
  const thread = await ConversationLog.for(fx.home).thread('node-0');
  expect(thread.records.map((record) => record.text)).toEqual(['addressed to the absent gateway']);
});

it('a flagless start on a home with a persisted pair runs nodes-only — the residual, while status stays configured', async () => {
  const fx = await fixture();
  const charter = 'You are a persisted gateway overlay.\n';
  // The pair exists (as an earlier start or a crash before the node's local log
  // would have written it), the start carries no flags: nodes-only.
  await persistOverlayConfig(fx.home, { model: 'gateway-default', charter });
  expect((await readStatus(fx.home)).overlay)
    .toEqual({ state: 'configured', model: 'gateway-default' });

  start(fx, {});
  await vi.waitFor(() => { expect(fx.nodeBodies).toHaveLength(1); }, { timeout: 30_000 });
  const handle = handles[handles.length - 1]!;
  handle.stop();
  await handle.done;
  handles.length = 0;

  expect(fx.overlayBodies).toEqual([]);
  // The persisted pair is untouched, and status keeps reporting it.
  expect((await readOverlaySidecars(fx.home)).kind).toBe('present');
  expect(formatStatus(await readStatus(fx.home)))
    .toContain('overlay: configured (gateway-default)');
});

it('resumes from the persisted pair (charter AND model), refusing a damaged one', async () => {
  const fx = await fixture({ withCharter: true });
  // The distinct model (NOT the catalog's first entry) pins resume-wins: a
  // re-default to catalog[0] on resume would change the resumed plan's model.
  start(fx, { gatewayCharter: fx.charterPath, gatewayModel: 'gateway-resume-model' });
  await vi.waitFor(() => { expect(fx.overlayBodies).toHaveLength(1); }, { timeout: 30_000 });
  expect((JSON.parse(fx.overlayBodies[0]!) as Wire).model).toBe('gateway-resume-model');
  const first = handles[handles.length - 1]!;
  first.stop();
  await first.done;
  handles.length = 0;

  // A resume nodes file declares only the uids (the journaled config wins).
  const resumeNodes = join(fx.home, 'resume-nodes.json');
  await writeFile(resumeNodes, JSON.stringify([{ uid: 'node-0' }]), 'utf8');
  // The resume takes the persisted configuration — the flag is refused by the
  // parser (covered by the options suite), and the config gate reads the pair.
  const resumed = startHost({
    home: fx.home, uid: 'node-0', command: 'resume', nodesFile: resumeNodes,
    sandbox: false, pollMs: 0,
    log: createHostLog((line) => { fx.lines.push(line); }),
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  });
  handles.push(resumed);
  await vi.waitFor(() => { expect(fx.overlayBodies.length).toBe(2); }, { timeout: 30_000 });
  const wire = JSON.parse(fx.overlayBodies[1]!) as Wire;
  expect(wire.messages[0]).toEqual({ role: 'system', content: 'You are the gateway overlay.\n' });
  expect(wire.model).toBe('gateway-resume-model');
  resumed.stop();
  await resumed.done;
  handles.length = 0;

  // A damaged pair is a bounded host refusal on a gateway-bearing resume.
  await writeFile(join(fx.home, GATEWAY_CONFIG_FILE), 'not json', { encoding: 'utf8', mode: 0o600 });
  const lines: string[] = [];
  const refused = startHost({
    home: fx.home, uid: 'node-0', command: 'resume', nodesFile: resumeNodes,
    sandbox: false, pollMs: 0, log: createHostLog((line) => { lines.push(line); }),
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  });
  const code = await refused.done;
  expect(code).toBe(2);
  expect(lines.join('\n')).toContain('gateway configuration is unreadable');
}, 30_000);
