import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProviders } from '../tools/providers.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'c14a-providers-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function write(value: unknown): Promise<void> {
  await writeFile(join(home, 'providers.json'),
    typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

describe('loadProviders', () => {
  it('a missing file yields an empty frozen registry', async () => {
    const registry = await loadProviders(home);
    expect(registry).toEqual({});
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('a minimal tavily entry gets its defaults expanded', async () => {
    await write({ tavily: { key: 'tvly-test' } });
    await expect(loadProviders(home)).resolves.toEqual({
      tavily: {
        key: 'tvly-test', baseUrl: 'https://api.tavily.com',
        timeoutMs: 20000, maxResults: 8, maxResponseBytes: 1048576,
      },
    });
  });

  it('explicit values are respected and a trailing slash is stripped', async () => {
    await write({ tavily: {
      key: 'k', baseUrl: 'http://127.0.0.1:8080/', timeoutMs: 500, maxResults: 3,
      maxResponseBytes: 4096,
    } });
    await expect(loadProviders(home)).resolves.toEqual({
      tavily: {
        key: 'k', baseUrl: 'http://127.0.0.1:8080',
        timeoutMs: 500, maxResults: 3, maxResponseBytes: 4096,
      },
    });
  });

  it('a malformed file is refused loudly', async () => {
    await write('{not json');
    await expect(loadProviders(home)).rejects.toThrow(/invalid providers\.json/);
    await write({ tavily: null });
    await expect(loadProviders(home)).rejects.toThrow(/invalid providers\.json/);
  });

  it('unknown providers and unknown fields are refused', async () => {
    await write({ brave: { key: 'x' } });
    await expect(loadProviders(home)).rejects.toThrow(/unknown provider/);
    await write({ tavily: { key: 'x', secret: 1 } });
    await expect(loadProviders(home)).rejects.toThrow(/unexpected field/);
  });

  it('bounds are enforced', async () => {
    for (const bad of [
      { key: 'k', timeoutMs: 0 }, { key: 'k', timeoutMs: 120001 },
      { key: 'k', maxResults: 0 }, { key: 'k', maxResults: 21 },
      { key: 'k', maxResponseBytes: 100 }, { key: 'k', maxResponseBytes: 8388609 },
      { key: 'k', baseUrl: 'ftp://example.com' }, { key: 'k', baseUrl: 'not a url' },
      { key: 'k', baseUrl: 'https://user:pass@example.com' },
      { key: 'k', baseUrl: 'https://example.com/?x=1' },
      { key: '' },
    ]) {
      await write({ tavily: bad });
      await expect(loadProviders(home)).rejects.toThrow(/invalid providers\.json/);
    }
  });

  it('wrong types are refused and never echo a value', async () => {
    for (const bad of [
      { tavily: 'tvly-string' }, { tavily: ['tvly-array'] }, { tavily: { key: 7 } },
      { tavily: { key: 'k', timeoutMs: '500' } }, { tavily: { key: 'k', maxResults: null } },
      { tavily: { key: 'k', maxResponseBytes: [] } },
    ]) {
      await write(bad);
      const error = await loadProviders(home).catch((err: unknown) => err);
      expect(String(error)).toMatch(/invalid providers\.json/);
      expect(String(error)).not.toContain('tvly-string');
      expect(String(error)).not.toContain('tvly-array');
    }
  });

  it('no error message ever contains the key value', async () => {
    await write({ tavily: { key: 'tvly-SECRET-VALUE', timeoutMs: -3 } });
    const error = await loadProviders(home).catch((err: unknown) => err);
    expect(String(error)).not.toContain('tvly-SECRET-VALUE');
  });

  it('the registry is deep-frozen', async () => {
    await write({ tavily: { key: 'k' } });
    const registry = await loadProviders(home);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.tavily)).toBe(true);
  });
});
