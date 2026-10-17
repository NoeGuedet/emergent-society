import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { toJson } from '../../context/artifacts.js';

/**
 * The kernel-side credential store (kernel.md §7, C1.4a subset).
 *
 * `<home>/providers.json` holds named credential bundles outside the world and
 * outside the project checkout; a missing file is an empty registry, never an
 * error, and a malformed file is refused loudly. Keeping `<home>` outside the
 * world and outside the project checkout is a host responsibility — documented,
 * not enforced by a runtime guard. Validation errors name positions (never
 * file-controlled text) and never quote values, so a credential mistakenly
 * written as a field or provider name cannot leak through an exception.
 * Honesty bound: until Landlock containment (C1.4c) the unconfined raw shell
 * runs as the same OS user with `cwd = <home>/world`, so this file IS both
 * readable (`cat ../providers.json`) and writable by an agent — an overwrite
 * (`echo ... > ../providers.json`) can replace `baseUrl`, so the next load
 * would send the key wherever that rewrite points. The guarantee bought here is
 * narrower: the kernel interpolates the key into no event, artifact, world write
 * or model request, not that the key is unreadable or this store is reserved;
 * and a provider response body is captured verbatim, so a hostile provider could
 * still reflect the key into the journal. Library-only composition (no host
 * exists yet): load the store, build the port, and pass it as the optional
 * `webTools` field — under
 * `exactOptionalPropertyTypes` that property is spread conditionally, never
 * assigned `undefined`:
 * `const webTools = webToolsFromProviders(await loadProviders(home));`
 * `createAgentRuntime({ ...options, ...(webTools !== undefined ? { webTools } : {}) });`
 *
 * Not to be confused with `src/provider/adapter.ts`: this module stores web-tool
 * credentials; that one is the LLM request path.
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
/** The provider store's ceiling: an oversize file is refused before parsing. */
const MAX_PROVIDERS_BYTES = 1024 * 1024;

/**
 * A loopback host may use plain `http:`; everything else must be `https:`, so a
 * base-url typo cannot send the Bearer key across the network in cleartext.
 * `URL.hostname` keeps IPv6 brackets, so `[::1]` is unwrapped first.
 */
function isLoopback(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1) : hostname;
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127'
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

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
  for (const [index, key] of Object.keys(o).entries()) {
    if (!ENTRY_FIELDS.includes(key)) fail(`${where}: unexpected field at position ${index + 1}`);
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
    if (parsed.protocol !== 'https:'
      && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
      fail(`${where}.baseUrl: must be https unless it is a loopback host`);
    }
    if (parsed.username !== '' || parsed.password !== '') {
      fail(`${where}.baseUrl: must not embed credentials`);
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      fail(`${where}.baseUrl: must not carry a query or fragment`);
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

/**
 * Reads the store with a hard memory bound instead of trusting metadata: at
 * most `MAX_PROVIDERS_BYTES + 1` bytes are ever fetched, so a file that grows
 * after any pre-flight — or a FIFO/stream with no trustworthy size — cannot
 * force an unbounded read. The extra byte is what makes "over the cap"
 * observable; the read stops there and the caller refuses the store.
 */
async function readStore(path: string): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_PROVIDERS_BYTES) {
      const want = Math.min(64 * 1024, MAX_PROVIDERS_BYTES + 1 - total);
      const chunk = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(chunk, 0, want, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_PROVIDERS_BYTES) fail('too large');
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function loadProviders(home: string): Promise<ProviderRegistry> {
  const bytes = await readStore(join(home, PROVIDERS_BASENAME));
  if (bytes === null) return freezeRegistry({});
  const text = bytes.toString('utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail('not valid JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('expected an object');
  }
  const root = value as Record<string, unknown>;
  for (const [index, name] of Object.keys(root).entries()) {
    if (name !== 'tavily') fail(`unknown provider at position ${index + 1}`);
  }
  const registry: { tavily?: ProviderEntry } = {};
  if ('tavily' in root) registry.tavily = entry(root['tavily'], 'tavily');
  return freezeRegistry(registry);
}
