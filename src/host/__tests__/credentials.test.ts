import {
  chmod, mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostConfigError } from '../errors.js';
import { assertCredentialStore, loadProviderStore, llmCredentialFrom } from '../credentials.js';
import { assertHomePermissions } from '../layout.js';

/** Every home this file creates, removed after each case. */
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'es-cred-'));
  homes.push(home);
  return home;
}

async function writeStore(home: string, mode: number = 0o600): Promise<void> {
  const path = join(home, 'providers.json');
  await rm(path, { force: true });
  await writeFile(path, JSON.stringify({
    llm: { key: 'sentinel-llm-key', endpoint: 'http://127.0.0.1:9/v1/chat/completions' },
  }), { mode });
  await chmod(path, mode);
}

it('accepts a same-uid 0600 regular file with an llm entry', async () => {
  const home = await freshHome();
  await assertHomePermissions(home);
  await writeStore(home, 0o600);
  expect((await stat(join(home, 'providers.json'))).mode & 0o777).toBe(0o600);
  const cred = llmCredentialFrom(await loadProviderStore(home));
  expect(cred).toEqual({
    endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    key: 'sentinel-llm-key', credentialId: 'llm',
  });
});

it('accepts 0400 and 0600; refuses 0640, 0660 and 0644', async () => {
  const home = await freshHome();
  for (const mode of [0o400, 0o600]) {
    await writeStore(home, mode);
    await expect(loadProviderStore(home)).resolves.toBeDefined();
  }
  for (const mode of [0o640, 0o660, 0o644]) {
    await writeStore(home, mode);
    const err = await assertCredentialStore(home).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostConfigError);
    expect(String(err)).toMatch(/chmod 600/);
    expect(String(err)).not.toContain('sentinel-llm-key');
  }
});

it('refuses a symlink, a directory, a missing file, an owner-unreadable file and a store without llm',
  async () => {
    const home = await freshHome();
    await symlink('/etc/hosts', join(home, 'providers.json'));
    await expect(assertCredentialStore(home)).rejects.toThrow(/regular file/);
    expect(await readlink(join(home, 'providers.json'))).toBe('/etc/hosts');
    await rm(join(home, 'providers.json'));
    await mkdir(join(home, 'providers.json'));
    await expect(assertCredentialStore(home)).rejects.toThrow(/regular file/);
    await rm(join(home, 'providers.json'), { recursive: true });
    await expect(assertCredentialStore(home)).rejects.toThrow(/missing .*providers\.json/);
    await expect(assertCredentialStore(home)).rejects.toThrow(/0600/);
    await writeStore(home, 0o600);
    await chmod(join(home, 'providers.json'), 0o200);
    await expect(assertCredentialStore(home)).rejects.toThrow(/owner-read|chmod 600/);
    await rm(join(home, 'providers.json'));
    await writeFile(join(home, 'providers.json'), JSON.stringify({ tavily: { key: 't' } }),
      { mode: 0o600 });
    await chmod(join(home, 'providers.json'), 0o600);
    expect(() => llmCredentialFrom({
      tavily: {
        key: 't', baseUrl: 'https://api.tavily.com',
        timeoutMs: 20000, maxResults: 8, maxResponseBytes: 1048576,
      },
    })).toThrow(/no "llm" entry/);
  });

it('wraps malformed loader errors as HostConfigError without values', async () => {
  const home = await freshHome();
  await writeFile(join(home, 'providers.json'), '{not json', { mode: 0o600 });
  await chmod(join(home, 'providers.json'), 0o600);
  const err = await loadProviderStore(home).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HostConfigError);
  expect(String(err)).toMatch(/invalid providers\.json/);
});

it('refuses a foreign-uid file (spy on getuid)', async () => {
  const home = await freshHome();
  await writeStore(home, 0o600);
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
  try { await expect(assertCredentialStore(home)).rejects.toThrow(/owned by uid/); }
  finally { spy.mockRestore(); }
});
