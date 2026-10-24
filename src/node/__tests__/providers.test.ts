import { execFile } from 'node:child_process';
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

  it('unknown providers and fields are refused by position, never echoed', async () => {
    await write({ 'tvly-provider-SECRET': { key: 'x' } });
    const providerError = await loadProviders(home).catch((err: unknown) => err);
    expect(String(providerError)).toMatch(/unknown provider at position 1/);
    expect(String(providerError)).not.toContain('tvly-provider-SECRET');
    await write({ tavily: { key: 'x', 'tvly-field-SECRET': 1 } });
    const fieldError = await loadProviders(home).catch((err: unknown) => err);
    expect(String(fieldError)).toMatch(/unexpected field at position 2/);
    expect(String(fieldError)).not.toContain('tvly-field-SECRET');
  });

  it('numeric bounds and base-url shape are refused', async () => {
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

  it('an oversize store is refused before parsing', async () => {
    await write('x'.repeat(1024 * 1024 + 1));
    await expect(loadProviders(home)).rejects.toThrow(/too large/);
  });

  it('a store that grows past the cap while being read is refused', async () => {
    // A FIFO has no size to pre-flight: this proves the read itself stops at
    // the cap, which also makes a regular file's stat→read race harmless.
    const fifo = join(home, 'providers.json');
    await new Promise<void>((resolve, reject) => {
      execFile('mkfifo', [fifo], (err) => { if (err) reject(err); else resolve(); });
    });
    const pending = loadProviders(home).catch((err: unknown) => err);
    await writeFile(fifo, Buffer.alloc(1024 * 1024 + 1, 0x78));
    expect(String(await pending)).toMatch(/invalid providers\.json: too large/);
  });

  it('plain http is allowed only for a loopback host', async () => {
    for (const baseUrl of ['http://localhost:8080', 'http://127.0.0.1:8080',
      'http://127.8.9.10:8080', 'http://[::1]:8080']) {
      await write({ tavily: { key: 'k', baseUrl } });
      await expect(loadProviders(home)).resolves.toMatchObject({ tavily: { baseUrl } });
    }
    for (const baseUrl of ['http://api.tavily.com', 'http://127.0.0.1.evil.example',
      'http://localhost.evil.example']) {
      await write({ tavily: { key: 'k', baseUrl } });
      await expect(loadProviders(home)).rejects.toThrow(/https/);
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

  it('accepts a valid llm entry beside tavily, frozen and without defaults', async () => {
    await write({
      llm: { key: 'llm-test', endpoint: 'https://api.example.test/v1/chat/completions' },
      tavily: { key: 'tvly-test' },
    });
    const registry = await loadProviders(home);
    expect(registry.llm).toEqual({
      key: 'llm-test', endpoint: 'https://api.example.test/v1/chat/completions',
    });
    expect(Object.isFrozen(registry.llm)).toBe(true);
    expect(registry.tavily).toBeDefined();
  });

  it('accepts an llm-only store with a loopback http endpoint', async () => {
    await write({ llm: { key: 'k', endpoint: 'http://127.0.0.1:1234/v1/chat/completions' } });
    await expect(loadProviders(home)).resolves.toMatchObject({ llm: { key: 'k' } });
  });

  it('refuses llm shape errors by position without echoing values', async () => {
    const tooLong = `https://h/${'a'.repeat(4097)}`;
    for (const llm of [null, 'x', [], {}, { key: 'x' }, { endpoint: 'https://h/v1/x' },
      { key: '', endpoint: 'https://h/v1/x' }, { key: 7, endpoint: 'https://h/v1/x' },
      { key: 'x', endpoint: 7 },
      { key: 'x', endpoint: 'https://h/v1/x?q=1' },
      { key: 'x', endpoint: 'https://u:p@h/v1/x' },
      { key: 'x', endpoint: 'https://SECRET-LLM-KEY@h/v1/x' },
      { key: 'x', endpoint: 'http://example.test/v1/x' },
      { key: 'x', endpoint: 'https://h:99999/v1/x' },
      { key: 'x', endpoint: tooLong },
      { key: 'SECRET-LLM-KEY', endpoint: 'not a url' },
      { key: 'x', endpoint: 'https://h/v1/x', extra: 1 }]) {
      await write({ llm });
      const err = await loadProviders(home).catch((e: unknown) => e);
      expect(String(err)).toMatch(/invalid providers\.json: llm(\.|:)/);
      expect(String(err)).not.toContain('SECRET-LLM-KEY');
      expect(String(err)).not.toContain('99999');
      expect(String(err)).not.toContain('example.test');
      expect(String(err)).not.toContain('not a url');
    }
  });
});
