import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bearerMatches, loadOrCreateBearer } from '../cockpit/auth.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('creates or reuses a private bearer and compares it in constant time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'es-cockpit-auth-'));
  roots.push(root);
  const path = join(root, 'nested', 'token');
  const first = await loadOrCreateBearer(path);
  const second = await loadOrCreateBearer(path);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(second).toBe(first);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, 'utf8')).toContain(first);
  expect(bearerMatches(first, first)).toBe(true);
  expect(bearerMatches(first, `${first.slice(0, -1)}0`)).toBe(false);
  expect(bearerMatches(first, 'short')).toBe(false);
  await chmod(path, 0o644);
  await expect(loadOrCreateBearer(path)).rejects.toThrow(/0600/);
});
