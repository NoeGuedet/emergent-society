import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostConfigError } from '../errors.js';
import {
  NODE_TOKEN_LIMIT_FILE, NodeTokenCounter, readNodeTokenSnapshot,
} from '../token-counter.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'es-token-counter-'));
  roots.push(root);
  await mkdir(join(root, '.es'), { recursive: true, mode: 0o700 });
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('the node token counter', () => {
  it('creates a 0600 sidecar, records once, and reloads the same state', async () => {
    const dir = await home();
    const counter = await NodeTokenCounter.open(dir, { createLimit: 100 });
    expect(counter).not.toBeNull();
    expect(counter!.snapshot()).toEqual({
      v: 0, limitTokens: 100, usedTokens: 0, state: 'active',
    });
    await counter!.record(3, 4);
    expect(counter!.snapshot().usedTokens).toBe(7);
    const reloaded = await NodeTokenCounter.open(dir);
    expect(reloaded!.snapshot().usedTokens).toBe(7);
    expect((await readFile(join(dir, '.es', NODE_TOKEN_LIMIT_FILE))).toString('utf8'))
      .toContain('"usedTokens":7');
  });

  it('is authoritative: same limit preserves state, a different limit refuses', async () => {
    const dir = await home();
    const counter = await NodeTokenCounter.open(dir, { createLimit: 20 });
    await counter!.record(5, 5);
    const same = await NodeTokenCounter.open(dir, { createLimit: 20 });
    expect(same!.snapshot().usedTokens).toBe(10);
    await expect(NodeTokenCounter.open(dir, { createLimit: 21 }))
      .rejects.toBeInstanceOf(HostConfigError);
  });

  it('serializes concurrent updates without lost counts', async () => {
    const dir = await home();
    const counter = await NodeTokenCounter.open(dir, { createLimit: 1000 });
    await Promise.all(Array.from({ length: 20 }, () => counter!.record(1, 2)));
    expect(counter!.snapshot().usedTokens).toBe(60);
    expect((await readNodeTokenSnapshot(dir))!.usedTokens).toBe(60);
  });

  it('closes admission synchronously at the cap and counts late admitted usage', async () => {
    const dir = await home();
    const counter = await NodeTokenCounter.open(dir, { createLimit: 5 });
    const crossing = counter!.record(3, 2);
    expect(counter!.admit()).toBe('exhausted');
    await crossing;
    await counter!.record(2, 1);
    expect(counter!.snapshot()).toMatchObject({ usedTokens: 8, state: 'exhausted' });
    expect(await readNodeTokenSnapshot(dir)).toMatchObject({
      usedTokens: 8, state: 'exhausted',
    });
    const unknownDir = await home();
    const unknown = await NodeTokenCounter.open(unknownDir, { createLimit: 10 });
    await unknown!.markUnknown();
    expect(unknown!.admit()).toBe('unknown');
    await unknown!.record(1, 1);
    expect(unknown!.snapshot()).toMatchObject({ usedTokens: 2, state: 'unknown' });
    expect((await readNodeTokenSnapshot(unknownDir))).toMatchObject({
      usedTokens: 2, state: 'unknown',
    });
  });

  it('serializes concurrent terminal crossings without losing usage', async () => {
    const dir = await home();
    const counter = await NodeTokenCounter.open(dir, { createLimit: 5 });
    await Promise.all([counter!.record(3, 0), counter!.record(4, 0)]);
    expect(counter!.snapshot()).toMatchObject({ usedTokens: 7, state: 'exhausted' });
    expect((await readNodeTokenSnapshot(dir))!.usedTokens).toBe(7);
  });

  it('counts a valid usage even when the counter update cannot be persisted', async () => {
    const dir = await home();
    let notified = 0;
    const counter = await NodeTokenCounter.open(dir, {
      createLimit: 10, onTerminal: () => { notified += 1; },
    });
    await rm(join(dir, '.es', NODE_TOKEN_LIMIT_FILE));
    await mkdir(join(dir, '.es', NODE_TOKEN_LIMIT_FILE));
    await counter!.record(2, 2);
    expect(counter!.snapshot().state).toBe('unknown');
    expect(counter!.admit()).toBe('unknown');
    expect(notified).toBe(1);
  });

  it('refuses malformed, permissive and symlinked sidecars', async () => {
    const bad = await home();
    await writeFile(join(bad, '.es', NODE_TOKEN_LIMIT_FILE), '{"v":0}', { mode: 0o600 });
    await expect(NodeTokenCounter.open(bad)).rejects.toBeInstanceOf(HostConfigError);

    const permissive = await home();
    await writeFile(
      join(permissive, '.es', NODE_TOKEN_LIMIT_FILE),
      '{"v":0,"limitTokens":10,"usedTokens":0,"state":"active"}',
      { mode: 0o644 },
    );
    await chmod(join(permissive, '.es', NODE_TOKEN_LIMIT_FILE), 0o644);
    await expect(NodeTokenCounter.open(permissive)).rejects.toBeInstanceOf(HostConfigError);

    const linked = await home();
    await writeFile(join(linked, 'target.json'), '{}', { mode: 0o600 });
    await symlink(join(linked, 'target.json'), join(linked, '.es', NODE_TOKEN_LIMIT_FILE));
    await expect(NodeTokenCounter.open(linked)).rejects.toBeInstanceOf(HostConfigError);
  });
});
