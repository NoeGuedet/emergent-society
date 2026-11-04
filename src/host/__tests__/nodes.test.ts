import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readCharterFile } from '../charter-file.js';
import { HostConfigError } from '../errors.js';
import { initHome } from '../layout.js';
import { MAX_NODES, MAX_NODES_FILE_BYTES, readNodesFile } from '../nodes.js';

/**
 * The nodes-file gate: a strict JSON declaration of a multi-node boot. Unknown
 * keys, unsafe or repeated uids, a missing model/heading on a start, a resume
 * entry that claims a config, and a non-absolute charter path are all
 * configuration refusals (exit 2), never a silently booted wrong node.
 */

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'es-nodes-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fileOf(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  return writeFile(path, content, 'utf8').then(() => path);
}

async function refusal(path: string, command: 'start' | 'resume'): Promise<HostConfigError> {
  try {
    await readNodesFile(dir, path, command);
  } catch (err) {
    expect(err).toBeInstanceOf(HostConfigError);
    return err as HostConfigError;
  }
  throw new Error('expected the nodes file to be refused');
}

it('reads a start declaration, with an optional absolute charter file', async () => {
  const path = await fileOf('nodes.json', JSON.stringify([
    { uid: 'node-0', model: 'deepseek-flash', heading: 'Lead.' },
    { uid: 'node-1', model: 'deepseek-flash', heading: 'Worker.', charterFile: '/tmp/c.txt' },
  ]));
  expect(await readNodesFile(dir, path, 'start')).toEqual([
    { uid: 'node-0', model: 'deepseek-flash', heading: 'Lead.' },
    { uid: 'node-1', model: 'deepseek-flash', heading: 'Worker.', charterFile: '/tmp/c.txt' },
  ]);
});

it('reads the declared spawn grant on a start and on a resume', async () => {
  const start = await fileOf('start.json', JSON.stringify([
    { uid: 'node-0', model: 'm', heading: 'h', spawn: true },
    { uid: 'node-1', model: 'm', heading: 'h' },
  ]));
  expect(await readNodesFile(dir, start, 'start')).toEqual([
    { uid: 'node-0', model: 'm', heading: 'h', spawn: true },
    { uid: 'node-1', model: 'm', heading: 'h' },
  ]);
  const resume = await fileOf('resume.json', JSON.stringify([
    { uid: 'node-0', spawn: true }, { uid: 'node-1' },
  ]));
  expect(await readNodesFile(dir, resume, 'resume')).toEqual([
    { uid: 'node-0', spawn: true }, { uid: 'node-1' },
  ]);
});

it('refuses a spawn grant that is not a boolean, on a start and on a resume', async () => {
  expect((await refusal(await fileOf('spawn-string.json', JSON.stringify([
    { uid: 'node-0', model: 'm', heading: 'h', spawn: 'yes' },
  ])), 'start')).message).toMatch(/spawn that is not a boolean/);
  expect((await refusal(await fileOf('spawn-number.json', JSON.stringify([
    { uid: 'node-0', spawn: 1 },
  ])), 'resume')).message).toMatch(/spawn that is not a boolean/);
});

it('reads a resume declaration: uids and the spawn grant, the journaled config wins', async () => {
  const path = await fileOf('nodes.json', JSON.stringify([{ uid: 'node-0' }, { uid: 'node-1' }]));
  expect(await readNodesFile(dir, path, 'resume')).toEqual([
    { uid: 'node-0' }, { uid: 'node-1' },
  ]);
});

it('refuses a resume entry that claims a config', async () => {
  const path = await fileOf('nodes.json', JSON.stringify([
    { uid: 'node-0', model: 'm' },
  ]));
  expect((await refusal(path, 'resume')).message).toMatch(/journaled config wins/);
});

it('refuses a missing file, a directory and a non-absolute charter', async () => {
  await expect(readNodesFile(dir, join(dir, 'absent.json'), 'start')).rejects.toBeInstanceOf(HostConfigError);
  const asDir = join(dir, 'nodes-dir');
  await mkdir(asDir);
  await expect(readNodesFile(dir, asDir, 'start')).rejects.toBeInstanceOf(HostConfigError);
  const relative = await fileOf('rel.json', JSON.stringify([
    { uid: 'node-0', model: 'm', heading: 'h', charterFile: 'charter.txt' },
  ]));
  expect((await refusal(relative, 'start')).message).toMatch(/absolute/);
});

it('refuses malformed JSON, a non-array, an empty list and too many nodes', async () => {
  await refusal(await fileOf('bad.json', '{'), 'start');
  await refusal(await fileOf('obj.json', '{"nodes":[]}'), 'start');
  await refusal(await fileOf('empty.json', '[]'), 'start');
  const many = Array.from({ length: MAX_NODES + 1 }, (_v, i) => (
    { uid: `node-${i}`, model: 'm', heading: 'h' }
  ));
  await refusal(await fileOf('many.json', JSON.stringify(many)), 'start');
});

it('refuses an unknown key, an unsafe uid, a repeated uid and a missing model', async () => {
  await refusal(await fileOf('key.json', JSON.stringify([
    { uid: 'node-0', model: 'm', heading: 'h', mood: 'happy' },
  ])), 'start');
  await refusal(await fileOf('uid.json', JSON.stringify([
    { uid: '../node', model: 'm', heading: 'h' },
  ])), 'start');
  await refusal(await fileOf('human.json', JSON.stringify([
    { uid: 'human', model: 'm', heading: 'h' },
  ])), 'start');
  await refusal(await fileOf('dup.json', JSON.stringify([
    { uid: 'node-0', model: 'm', heading: 'h' },
    { uid: 'node-0', model: 'm', heading: 'h' },
  ])), 'start');
  await refusal(await fileOf('nomodel.json', JSON.stringify([
    { uid: 'node-0', heading: 'h' },
  ])), 'start');
  await refusal(await fileOf('noheading.json', JSON.stringify([
    { uid: 'node-0', model: 'm' },
  ])), 'start');
});

it('refuses a world-addressed declaration, including the legacy pair canonical target', async () => {
  const home = join(dir, 'home');
  await initHome(home);
  const entry = JSON.stringify([{ uid: 'node-0', model: 'm', heading: 'h' }]);
  const worldNodes = join(home, 'world', 'nodes.json');
  await writeFile(worldNodes, entry);
  await expect(readNodesFile(home, worldNodes, 'start'))
    .rejects.toThrow(/external to the world/);

  // A legacy symlinked pair: the configured alias AND its canonical target are
  // both refusals, so the declaration-content redirect cannot be smuggled in.
  await rename(join(home, 'world'), join(home, 'real-world'));
  await symlink(join(home, 'real-world'), join(home, 'world'));
  await writeFile(join(home, 'real-world', 'nodes.json'), entry);
  await expect(readNodesFile(home, join(home, 'world', 'nodes.json'), 'start'))
    .rejects.toThrow(/external to the world/);
  await expect(readNodesFile(home, join(home, 'real-world', 'nodes.json'), 'start'))
    .rejects.toThrow(/external to the world/);
});

it('reads an external declaration but refuses a symlinked leaf or parent', async () => {
  const home = join(dir, 'home');
  await initHome(home);
  const ops = join(dir, 'ops');
  await mkdir(ops);
  const external = join(ops, 'nodes.json');
  await writeFile(external, JSON.stringify([{ uid: 'node-0', model: 'm', heading: 'h' }]));
  expect(await readNodesFile(home, external, 'start')).toEqual([
    { uid: 'node-0', model: 'm', heading: 'h' },
  ]);
  const leafLink = join(dir, 'leaf.json');
  await symlink(external, leafLink);
  await expect(readNodesFile(home, leafLink, 'start'))
    .rejects.toThrow(/not a regular file/);
  const alias = join(dir, 'alias');
  await symlink(ops, alias);
  await expect(readNodesFile(home, join(alias, 'nodes.json'), 'start'))
    .rejects.toThrow(/unsafe parent component/);
});

it('refuses an over-64KiB declaration with the shared over-cap suffix', async () => {
  const home = join(dir, 'home');
  await initHome(home);
  const oversize = join(dir, 'huge.json');
  await writeFile(oversize, 'x'.repeat(MAX_NODES_FILE_BYTES + 1));
  await expect(readNodesFile(home, oversize, 'start')).rejects.toThrow(
    new RegExp(`over ${MAX_NODES_FILE_BYTES} bytes; the limit is ${MAX_NODES_FILE_BYTES}`),
  );
});

it('keeps entry charters world-addressed (only the declaration is external-only)', async () => {
  const home = join(dir, 'home');
  await initHome(home);
  const charter = join(home, 'world', 'charter.md');
  await writeFile(charter, 'A world-addressed entry charter.\n');
  expect(await readCharterFile(home, 'node-0', charter))
    .toBe('A world-addressed entry charter.\n');
});

it('refuses a world-parent symlink in the charter read too', async () => {
  const home = join(dir, 'home');
  await initHome(home);
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'charter.md'), 'canary bytes\n');
  await symlink(outside, join(home, 'world', 'sub'));
  await expect(readCharterFile(home, 'node-0', join(home, 'world', 'sub', 'charter.md')))
    .rejects.toThrow(/unsafe parent component/);
});
