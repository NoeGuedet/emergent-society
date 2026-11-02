import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_MODEL_ID_CHARS, MAX_MODEL_IDS, MODEL_REFUSAL_CODE_POINTS, loadProviders, modelIds,
  modelRefusal, windowForModel, windowOf, windowRefusal,
} from '../tools/providers.js';
import { singleLine } from '../../text.js';

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

describe('the declared model catalog (llm.models)', () => {
  const ENDPOINT = 'https://api.example.test/v1/chat/completions';

  it('carries the entries through in declaration order, deep-frozen', async () => {
    await write({ llm: { key: 'k', endpoint: ENDPOINT, models: ['vendor/model-a', 'model-b:free'] } });
    const registry = await loadProviders(home);
    // The old ids-only form normalizes into the one entry shape, with no window.
    expect(registry.llm?.models).toEqual([{ id: 'vendor/model-a' }, { id: 'model-b:free' }]);
    expect(Object.isFrozen(registry.llm?.models)).toBe(true);
    // The endpoint and key still load exactly as before the manifest existed.
    expect(registry.llm?.key).toBe('k');
  });

  it('accepts an empty catalog as a declaration of no served models', async () => {
    await write({ llm: { key: 'k', endpoint: ENDPOINT, models: [] } });
    await expect(loadProviders(home)).resolves.toMatchObject({ llm: { models: [] } });
  });

  it('accepts the exact caps: 64 ids of 256 printable characters', async () => {
    expect(MAX_MODEL_ID_CHARS).toBe(256);
    const ids = Array.from({ length: MAX_MODEL_IDS }, (_, index) =>
      `${index}-${'m'.repeat(MAX_MODEL_ID_CHARS - String(index).length - 1)}`);
    expect(ids.every((id) => [...id].length === MAX_MODEL_ID_CHARS)).toBe(true);
    await write({ llm: { key: 'k', endpoint: ENDPOINT, models: ids } });
    const registry = await loadProviders(home);
    expect(registry.llm?.models).toHaveLength(MAX_MODEL_IDS);
    for (const id of ids) expect(registry.llm?.models).toContainEqual({ id });
  });

  it('accepts printable ASCII and refuses every other class, by position and value-free', async () => {
    for (const value of ['a b', 'A-Z0-9._:/@-', 'x!y']) {
      await write({ llm: { key: 'k', endpoint: ENDPOINT, models: [value] } });
      await expect(loadProviders(home)).resolves.toMatchObject({ llm: { models: [{ id: value }] } });
    }
    const refused = ['a\nb', 'a\tb', 'a\u0000b', 'a\u001fb', 'a\u007fb', 'a€b', 'a\u0085b'];
    for (const value of refused) {
      await write({ llm: { key: 'k', endpoint: ENDPOINT, models: ['ok-id', value] } });
      const err = await loadProviders(home).catch((e: unknown) => e);
      expect(String(err)).toMatch(/llm\.models\[1\]: expected a one-line printable ASCII model id/);
      expect(String(err)).not.toContain('a\tb');
      expect(String(err)).not.toContain('\u0000');
    }
    for (const bad of [null, 'models', {}, [7], [''], ['a'.repeat(MAX_MODEL_ID_CHARS + 1)]]) {
      await write({ llm: { key: 'k', endpoint: ENDPOINT, models: bad } });
      const err = await loadProviders(home).catch((e: unknown) => e);
      expect(String(err)).toMatch(/invalid providers\.json: llm\.models/);
    }
    await write({ llm: { key: 'k', endpoint: ENDPOINT, models: Array.from({ length: 65 }, (_, index) => `m${index}`) } });
    const tooMany = await loadProviders(home).catch((e: unknown) => e);
    expect(String(tooMany)).toMatch(/llm\.models: expected at most 64 entries/);
  });

  it('refuses a duplicate by position without echoing the repeated id', async () => {
    await write({ llm: { key: 'k', endpoint: ENDPOINT, models: ['dup-SECRET-id', 'other', 'dup-SECRET-id'] } });
    const err = await loadProviders(home).catch((e: unknown) => e);
    expect(String(err)).toMatch(/llm\.models\[2\]: repeats an earlier model id/);
    expect(String(err)).not.toContain('dup-SECRET-id');
  });
});

describe('the window shapes and the declaration\'s domain (A3)', () => {
  const ENDPOINT = 'https://api.example.test/v1/chat/completions';
  const withModels = (models: unknown): unknown => ({ llm: { key: 'k', endpoint: ENDPOINT, models } });

  it('accepts BOTH shapes at load: the old ids-only form and the new windowed object', async () => {
    await write(withModels([
      'vendor/legacy-model',
      { id: 'windowed-model', contextTokens: 200_000, maxOutputTokens: 32_000 },
    ]));
    const registry = await loadProviders(home);
    expect(registry.llm?.models).toEqual([
      { id: 'vendor/legacy-model' },
      { id: 'windowed-model', contextTokens: 200_000, maxOutputTokens: 32_000 },
    ]);
    expect(modelIds(registry.llm!.models!)).toEqual(['vendor/legacy-model', 'windowed-model']);
    // The transition (ids-only) entry declares no window; the object one does.
    expect(windowForModel(registry.llm!.models!, 'vendor/legacy-model')).toBeNull();
    expect(windowForModel(registry.llm!.models!, 'windowed-model')).toEqual({
      contextTokens: 200_000, maxOutputTokens: 32_000,
    });
    expect(windowForModel(undefined, 'windowed-model')).toBeNull();
    expect(windowOf({ id: 'x' })).toBeNull();
  });

  it('requires the window fields together, by position and value-free', async () => {
    for (const [entry, pattern] of [
      [{ id: 'SECRET-half-context', contextTokens: 200_000 },
        /llm\.models\[0\]: contextTokens and maxOutputTokens must be declared together/],
      [{ id: 'SECRET-half-output', maxOutputTokens: 1_000 },
        /llm\.models\[0\]: contextTokens and maxOutputTokens must be declared together/],
    ] as const) {
      await write(withModels([entry]));
      const err = await loadProviders(home).catch((error: unknown) => error);
      expect(String(err)).toMatch(pattern);
      expect(String(err)).not.toContain('SECRET-half');
    }
  });

  it.each<readonly [string, unknown, RegExp]>([
    ['a non-integer window', { id: 'm', contextTokens: 1.5, maxOutputTokens: 1 },
      /llm\.models\[0\]\.contextTokens: expected a safe integer in \[1, \d+\]/],
    ['a zero window', { id: 'm', contextTokens: 0, maxOutputTokens: 1 },
      /llm\.models\[0\]\.contextTokens: expected a safe integer in \[1, \d+\]/],
    ['an oversize window', { id: 'm', contextTokens: 4_194_305, maxOutputTokens: 1 },
      /llm\.models\[0\]\.contextTokens: expected a safe integer in \[1, \d+\]/],
    ['an oversize output', { id: 'm', contextTokens: 200_000, maxOutputTokens: 4_194_305 },
      /llm\.models\[0\]\.maxOutputTokens: expected a safe integer in \[1, \d+\]/],
    ['an output at the window', { id: 'm', contextTokens: 200_000, maxOutputTokens: 200_000 },
      /llm\.models\[0\]\.maxOutputTokens: expected a value below contextTokens/],
    ['a degenerate window', { id: 'm', contextTokens: 32_000, maxOutputTokens: 20_000 },
      /llm\.models\[0\]\.contextTokens: too small for the output reservation and the headroom/],
    ['a missing id', { contextTokens: 200_000, maxOutputTokens: 32_000 },
      /llm\.models\[0\]\.id: expected a string/],
    ['an unknown field', { id: 'm', contextTokens: 200_000, maxOutputTokens: 32_000, window: 1 },
      /llm\.models\[0\]: unexpected field at position 4/],
    ['a non-entry value', 7, /llm\.models\[0\]: expected a model id or an \{id, contextTokens, maxOutputTokens\} object/],
  ])('refuses %s', async (_name, entry, pattern) => {
    await write(withModels([entry]));
    const err = await loadProviders(home).catch((error: unknown) => error);
    expect(String(err)).toMatch(pattern);
    expect(String(err)).not.toContain(JSON.stringify(entry));
  });

  it('refuses a duplicate id across the two shapes', async () => {
    await write(withModels(['dup-model', { id: 'dup-model', contextTokens: 200_000, maxOutputTokens: 32_000 }]));
    const err = await loadProviders(home).catch((error: unknown) => error);
    expect(String(err)).toMatch(/llm\.models\[1\]: repeats an earlier model id/);
    expect(String(err)).not.toContain('dup-model');
  });

  it('windowRefusal is bounded and names the declaration to add', () => {
    const message = windowRefusal('some-model');
    expect(message).toContain('has no declared context window');
    expect(message).toContain('{id, contextTokens, maxOutputTokens}');
    expect([...message].length).toBeLessThanOrEqual(MODEL_REFUSAL_CODE_POINTS);
    // The echoed id is clamped like every refusal's: an unbounded tool argument
    // cannot inflate the message.
    expect([...windowRefusal('x'.repeat(10_000))].length)
      .toBeLessThanOrEqual(MODEL_REFUSAL_CODE_POINTS);
  });
});

describe('modelRefusal: the teaching enumeration, budgeted whole', () => {
  it('enumerates a short catalog whole, with the count pointer', () => {
    const served = ['first-light-test', 'vendor/model-a', 'vendor/model-b'];
    expect(modelRefusal('unknown-model', served)).toBe(
      'model "unknown-model" is not served; this kernel serves:'
      + ' first-light-test, vendor/model-a, vendor/model-b'
      + ' (3 models total — inspect lists them)');
    expect(modelRefusal('unknown-model', ['only-one'])).toContain(
      ' (1 model total — inspect lists them)');
  });

  it('fits a 64-model catalog with a long requested id inside the 200-code-point clamp', () => {
    const catalog = Array.from({ length: MAX_MODEL_IDS }, (_, index) =>
      `served-vendor/model-${String(index + 1).padStart(2, '0')}-long-suffix`);
    const message = modelRefusal(`not-served-${'x'.repeat(300)}`, catalog);
    // The renderer's clamp (`singleLine(err.message, 200)`) is a no-op: the
    // whole message — the tail pointer included — survives by construction.
    expect(MODEL_REFUSAL_CODE_POINTS).toBe(200);
    expect([...message].length).toBeLessThanOrEqual(MODEL_REFUSAL_CODE_POINTS);
    expect(singleLine(message, 200)).toBe(message);
    expect(message.endsWith(' (64 models total — inspect lists them)')).toBe(true);
    expect(message).toContain('served-vendor/model-01');
    expect(message).toContain(', …');
    // The echoed id is clamped to a bounded token, never the 300 characters.
    expect(message).not.toContain('x'.repeat(300));
  });

  it('keeps the pointer when not even one served id fits', () => {
    const message = modelRefusal('unknown', ['z'.repeat(256)]);
    expect([...message].length).toBeLessThanOrEqual(200);
    expect(singleLine(message, 200)).toBe(message);
    expect(message.endsWith(' (1 model total — inspect lists them)')).toBe(true);
    expect(message).toContain('serves: … (1 model total');
  });

  it('says the declaration is empty rather than rendering a dangling list', () => {
    const message = modelRefusal('unknown', []);
    expect(message).toBe('model "unknown" is not served; this kernel serves:'
      + ' no models (providers.json declares llm.models empty)');
    expect([...message].length).toBeLessThanOrEqual(200);
    expect(singleLine(message, 200)).toBe(message);
  });
});
