import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostConfigError } from '../../host/errors.js';
import {
  GATEWAY_CHARTER_FILE, GATEWAY_CONFIG_FILE, gatewayCharterPath, gatewayConfigPath,
  persistOverlayConfig, readOverlaySidecars, resolvePersistedOverlay,
} from '../charter.js';

/**
 * The overlay's config home: `<home>/gateway.charter.md` and
 * `<home>/gateway.json`, written atomically owner-only, read back as the
 * persisted pair, and classified — absent (nodes-only), present, or damaged
 * (a bounded refusal for the host and `unknown` for status).
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'es-overlay-charter-'));
  dirs.push(dir);
  return dir;
}

it('persists the pair atomically, owner-only, and reads it back', async () => {
  const dir = await home();
  await persistOverlayConfig(dir, { model: 'test-model', charter: 'You are the gateway.\n' });
  expect((await lstat(gatewayCharterPath(dir))).mode & 0o777).toBe(0o600);
  expect((await lstat(gatewayConfigPath(dir))).mode & 0o777).toBe(0o600);
  expect(gatewayCharterPath(dir).endsWith(GATEWAY_CHARTER_FILE)).toBe(true);
  expect(gatewayConfigPath(dir).endsWith(GATEWAY_CONFIG_FILE)).toBe(true);
  expect(await readOverlaySidecars(dir)).toEqual({
    kind: 'present',
    config: { model: 'test-model', charter: 'You are the gateway.\n' },
  });
  expect(await resolvePersistedOverlay(dir)).toEqual({
    model: 'test-model', charter: 'You are the gateway.\n',
  });
});

it('reads an absent pair as nodes-only, not a refusal', async () => {
  const dir = await home();
  expect(await readOverlaySidecars(dir)).toEqual({ kind: 'absent' });
  expect(await resolvePersistedOverlay(dir)).toBeNull();
});

it('classifies a partial or damaged pair as damaged and refuses a resume', async () => {
  for (const damage of [
    async (dir: string): Promise<void> => {
      await writeFile(gatewayCharterPath(dir), 'charter\n', { mode: 0o600 });
    },
    async (dir: string): Promise<void> => {
      await writeFile(gatewayConfigPath(dir), '{"v":0,"model":"m"}', { mode: 0o600 });
    },
    async (dir: string): Promise<void> => {
      await writeFile(gatewayCharterPath(dir), 'charter\n', { mode: 0o600 });
      await writeFile(gatewayConfigPath(dir), 'not json', { mode: 0o600 });
    },
    async (dir: string): Promise<void> => {
      await writeFile(gatewayCharterPath(dir), 'charter\n', { mode: 0o600 });
      await writeFile(gatewayConfigPath(dir), '{"v":1,"model":"m"}', { mode: 0o600 });
    },
    async (dir: string): Promise<void> => {
      await writeFile(gatewayCharterPath(dir), 'charter\n', { mode: 0o600 });
      await writeFile(gatewayConfigPath(dir), '{"v":0,"model":"  "}', { mode: 0o600 });
    },
    async (dir: string): Promise<void> => {
      await writeFile(gatewayCharterPath(dir), '   \n', { mode: 0o600 });
      await writeFile(gatewayConfigPath(dir), '{"v":0,"model":"m"}', { mode: 0o600 });
    },
  ]) {
    const dir = await home();
    await damage(dir);
    expect((await readOverlaySidecars(dir)).kind).toBe('damaged');
    await expect(resolvePersistedOverlay(dir)).rejects.toBeInstanceOf(HostConfigError);
  }
});

it('refuses a symlinked sidecar (never follows it) and an oversize config', async () => {
  const dir = await home();
  await writeFile(join(dir, 'secret.json'), '{"key":"sk-live"}', { mode: 0o600 });
  await symlink(join(dir, 'secret.json'), gatewayConfigPath(dir));
  await writeFile(gatewayCharterPath(dir), 'charter\n', { mode: 0o600 });
  expect((await readOverlaySidecars(dir)).kind).toBe('damaged');

  const other = await home();
  await writeFile(gatewayCharterPath(other), 'charter\n', { mode: 0o600 });
  await writeFile(gatewayConfigPath(other), JSON.stringify({
    v: 0, model: 'm', padding: 'x'.repeat(8 * 1024),
  }), { mode: 0o600 });
  expect((await readOverlaySidecars(other)).kind).toBe('damaged');
});

it('refuses to persist a blank model or an empty charter', async () => {
  const dir = await home();
  await expect(persistOverlayConfig(dir, { model: ' ', charter: 'x' }))
    .rejects.toBeInstanceOf(HostConfigError);
  await expect(persistOverlayConfig(dir, { model: 'm', charter: '  ' }))
    .rejects.toBeInstanceOf(HostConfigError);
  expect(await readOverlaySidecars(dir)).toEqual({ kind: 'absent' });
});
