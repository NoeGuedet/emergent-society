import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HostConfigError } from '../errors.js';
import { MAX_NODES, readNodesFile } from '../nodes.js';

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
    await readNodesFile(path, command);
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
  expect(await readNodesFile(path, 'start')).toEqual([
    { uid: 'node-0', model: 'deepseek-flash', heading: 'Lead.' },
    { uid: 'node-1', model: 'deepseek-flash', heading: 'Worker.', charterFile: '/tmp/c.txt' },
  ]);
});

it('reads the declared spawn grant on a start and on a resume', async () => {
  const start = await fileOf('start.json', JSON.stringify([
    { uid: 'node-0', model: 'm', heading: 'h', spawn: true },
    { uid: 'node-1', model: 'm', heading: 'h' },
  ]));
  expect(await readNodesFile(start, 'start')).toEqual([
    { uid: 'node-0', model: 'm', heading: 'h', spawn: true },
    { uid: 'node-1', model: 'm', heading: 'h' },
  ]);
  const resume = await fileOf('resume.json', JSON.stringify([
    { uid: 'node-0', spawn: true }, { uid: 'node-1' },
  ]));
  expect(await readNodesFile(resume, 'resume')).toEqual([
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
  expect(await readNodesFile(path, 'resume')).toEqual([
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
  await expect(readNodesFile(join(dir, 'absent.json'), 'start')).rejects.toBeInstanceOf(HostConfigError);
  const asDir = join(dir, 'nodes-dir');
  await mkdir(asDir);
  await expect(readNodesFile(asDir, 'start')).rejects.toBeInstanceOf(HostConfigError);
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
