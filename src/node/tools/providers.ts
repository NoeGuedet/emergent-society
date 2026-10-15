import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toJson } from '../../context/artifacts.js';

/**
 * The kernel-side credential store (kernel.md §7, C1.4a subset).
 *
 * `<home>/providers.json` holds named credential bundles outside the world and
 * outside the project checkout; a missing file is an empty registry, never an
 * error, and a malformed file is refused loudly. Validation errors name fields
 * and never quote values, so a credential cannot leak through an exception.
 * Honesty bound: until Landlock containment (C1.4c) the unconfined raw shell
 * runs as the same OS user with `cwd = <home>/world`, so this file IS readable
 * by an agent (`cat ../providers.json`) — the guarantee bought here is that the
 * kernel interpolates the key into no event, artifact, world write or model
 * request, not that the key is unreadable; and a provider response body is
 * captured verbatim, so a hostile provider could still reflect the key into the
 * journal. Library-only composition (no host exists yet): load the store, build
 * the port, and pass it as the optional `webTools` field — under
 * `exactOptionalPropertyTypes` that property is spread conditionally, never
 * assigned `undefined`:
 * `const webTools = webToolsFromProviders(await loadProviders(home));`
 * `createAgentRuntime({ ...options, ...(webTools !== undefined ? { webTools } : {}) });`
 */

const PROVIDERS_BASENAME = 'providers.json';

export type ProviderEntry = {
  readonly key: string; readonly baseUrl: string;
  readonly timeoutMs: number; readonly maxResults: number; readonly maxResponseBytes: number;
};

export type ProviderRegistry = { readonly tavily?: ProviderEntry };

const DEFAULT_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_CEILING_MS = 120000;
const MAX_RESULTS_CEILING = 20;
const MAX_RESPONSE_BYTES_CEILING = 8 * 1024 * 1024;
const ENTRY_FIELDS = ['key', 'baseUrl', 'timeoutMs', 'maxResults', 'maxResponseBytes'];

function fail(message: string): never {
  throw new Error(`invalid ${PROVIDERS_BASENAME}: ${message}`);
}

function boundedInt(
  value: unknown, fallback: number, min: number, max: number, where: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${where}: expected a safe integer in [${min}, ${max}]`);
  }
  return value;
}

function entry(value: unknown, where: string): ProviderEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where}: expected an object`);
  }
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!ENTRY_FIELDS.includes(key)) fail(`${where}: unexpected field ${JSON.stringify(key)}`);
  }
  if (typeof o['key'] !== 'string' || o['key'].length === 0) {
    fail(`${where}.key: expected a nonempty string`);
  }
  let baseUrl = DEFAULT_BASE_URL;
  if (o['baseUrl'] !== undefined) {
    if (typeof o['baseUrl'] !== 'string') fail(`${where}.baseUrl: expected a string`);
    baseUrl = o['baseUrl'].replace(/\/+$/, '');
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { fail(`${where}.baseUrl: not a URL`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      fail(`${where}.baseUrl: must be http or https`);
    }
    if (parsed.username !== '' || parsed.password !== '') {
      fail(`${where}.baseUrl: must not embed credentials`);
    }
  }
  return {
    key: o['key'],
    baseUrl,
    timeoutMs: boundedInt(o['timeoutMs'], DEFAULT_TIMEOUT_MS, 1, TIMEOUT_CEILING_MS,
      `${where}.timeoutMs`),
    maxResults: boundedInt(o['maxResults'], DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CEILING,
      `${where}.maxResults`),
    maxResponseBytes: boundedInt(o['maxResponseBytes'], DEFAULT_MAX_RESPONSE_BYTES, 1024,
      MAX_RESPONSE_BYTES_CEILING, `${where}.maxResponseBytes`),
  };
}

/**
 * Deep-freezes a validated registry. `toJson` throws on a value it cannot
 * canonicalize; that impossibility is reported as `invalid providers.json: ...`
 * and never quotes the offending value, so no credential can leak here either.
 */
function freezeRegistry(value: unknown): ProviderRegistry {
  try {
    return toJson(value) as unknown as ProviderRegistry;
  } catch {
    fail('not representable as JSON');
  }
}

export async function loadProviders(home: string): Promise<ProviderRegistry> {
  let text: string;
  try {
    text = await readFile(join(home, PROVIDERS_BASENAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return freezeRegistry({});
    }
    throw err;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('not valid JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('expected an object');
  }
  const root = value as Record<string, unknown>;
  for (const name of Object.keys(root)) {
    if (name !== 'tavily') fail(`unknown provider ${JSON.stringify(name)}`);
  }
  const registry: { tavily?: ProviderEntry } = {};
  if ('tavily' in root) registry.tavily = entry(root['tavily'], 'tavily');
  return freezeRegistry(registry);
}
