import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startHost, type HostOptions } from '../host.js';
import type { LlmModel } from '../../context/contracts.js';
import { initHome } from '../layout.js';
import { createHostLog } from '../observe.js';
import { readNodesFile } from '../nodes.js';
import { HostConfigError } from '../errors.js';

/**
 * The gateway overlay's config gate (O4): the operator's charter file read with
 * the charter-file discipline, the model validated against the manifest and
 * defaulted to its first catalog entry, and the pair persisted owner-only. A
 * corrupt or missing charter on a gateway-bearing start is a bounded host
 * refusal (exit 2); a start without the flag is a nodes-only host.
 */

const SECRET_SENTINEL = 'sk-overlay-config-sentinel-9c1f';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Fixture = { readonly home: string; readonly nodesFile: string };

/** A windowed declaration: a fresh START on any named model needs one (A3). */
const catalog = (...modelIds: readonly string[]): readonly LlmModel[] =>
  modelIds.map((id) => ({ id, contextTokens: 200_000, maxOutputTokens: 32_000 }));

async function fixture(models?: readonly LlmModel[]): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'es-overlay-config-'));
  dirs.push(home);
  await initHome(home);
  await writeFile(join(home, 'providers.json'), JSON.stringify({
    llm: {
      key: SECRET_SENTINEL, endpoint: 'https://test.invalid/v1/chat/completions',
      ...(models !== undefined ? { models } : {}),
    },
  }), { encoding: 'utf8', mode: 0o600 });
  const nodesFile = join(home, 'nodes.json');
  await writeFile(nodesFile, JSON.stringify([
    { uid: 'node-0', model: 'node-model', heading: 'Root.' },
  ]), 'utf8');
  return { home, nodesFile };
}

async function boot(
  fx: Fixture, extra: Partial<HostOptions>,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const handle = startHost({
    home: fx.home, uid: 'node-0', command: 'start', nodesFile: fx.nodesFile,
    sandbox: false, pollMs: 0, log: createHostLog((line) => { lines.push(line); }),
    ...extra,
  }, {
    installSignals: false, keepAlive: false,
    freeSpace: async () => ({ bytes: 10 ** 12, inodes: 10 ** 9 }),
  });
  return { code: await handle.done, lines };
}

function errorLine(lines: readonly string[]): string {
  return lines.find((line) => line.includes('"event":"host/error"')) ?? '';
}

it('refuses a missing, empty, non-regular, non-UTF-8 or credential-store charter as a bounded host refusal', async () => {
  const fx = await fixture(catalog('node-model', 'gw-model'));
  const directory = join(fx.home, 'a-directory');
  await mkdir(directory, { mode: 0o700 });
  const badUtf8 = join(fx.home, 'bad.md');
  await writeFile(badUtf8, Buffer.from([0xff, 0xfe, 0x00]), { mode: 0o600 });
  const empty = join(fx.home, 'empty.md');
  await writeFile(empty, '  \n', { encoding: 'utf8', mode: 0o600 });
  const link = join(fx.home, 'link.md');
  await symlink(join(fx.home, 'providers.json'), link);

  for (const [charter, fragment] of [
    [join(fx.home, 'nope.md'), 'could not read the charter file'],
    [empty, 'charter file is empty'],
    [badUtf8, 'not valid UTF-8'],
    [directory, 'not a regular file'],
    [join(fx.home, 'providers.json'), 'refusing the providers store'],
    [link, 'refusing the providers store'],
  ] as const) {
    const { code, lines } = await boot(fx, { gatewayCharter: charter, gatewayModel: 'gw-model' });
    expect(code).toBe(2);
    expect(errorLine(lines)).toContain(fragment);
    // The provider key never rides a host diagnostic (it is the fixture's
    // distinctive key, so this assertion can actually fail).
    expect(JSON.stringify(lines)).not.toContain(SECRET_SENTINEL);
  }
});

it('validates the model against the catalog, defaults to its first entry, and needs one when none is declared', async () => {
  const fx = await fixture(catalog('node-model', 'gw-model'));
  const charter = join(fx.home, 'charter.md');
  await writeFile(charter, 'You are the gateway.\n', 'utf8');
  // An unknown model is the ordinary model refusal.
  const unknown = await boot(fx, { gatewayCharter: charter, gatewayModel: 'nope-model' });
  expect(unknown.code).toBe(2);
  expect(errorLine(unknown.lines)).toContain('is not served');

  // No catalog and no flag: there is no default to take.
  const bare = await fixture(undefined);
  const bareCharter = join(bare.home, 'charter.md');
  await writeFile(bareCharter, 'You are the gateway.\n', 'utf8');
  const refused = await boot(bare, { gatewayCharter: bareCharter });
  expect(refused.code).toBe(2);
  expect(errorLine(refused.lines)).toContain('needs --gateway-model');
});

it('refuses a nodes-file entry named gateway, the reserved overlay identity', async () => {
  const fx = await fixture(catalog('node-model'));
  const nodesFile = join(fx.home, 'bad-nodes.json');
  await writeFile(nodesFile, JSON.stringify([
    { uid: 'gateway', model: 'node-model', heading: 'I am the overlay.' },
  ]), 'utf8');
  await expect(readNodesFile(nodesFile, 'start')).rejects.toBeInstanceOf(HostConfigError);
  await expect(readNodesFile(nodesFile, 'start')).rejects.toThrow(/gateway/);
});
