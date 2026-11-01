import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { toJson } from '../../context/artifacts.js';
import { validateFrontierUrl } from '../../frontier/index.js';
import { singleLine } from '../../text.js';
import { isLoopback } from '../../util.js';

/**
 * The kernel-side credential store (kernel.md §7, C1.4a subset plus the host's
 * `llm` entry).
 *
 * `<home>/providers.json` holds named credential bundles outside the world and
 * outside the project checkout; a missing file is an empty registry, never an
 * error, and a malformed file is refused loudly. It carries one `llm` entry —
 * `{ key, endpoint, models? }`, the model endpoint the host's provider
 * transport posts to plus the operator's optional declaration of the model ids
 * it serves — and an optional `tavily` entry for the web tools. The host
 * enforces the
 * two properties this library can only document: `init`/`start`/`resume` refuse
 * a home inside the project checkout and an existing home that is not a
 * same-uid 0700 directory, before anything reads a key; only the home-inside-
 * world case remains deferred to the first `execute`, where the shell sandbox
 * is built (C1.4c). Validation errors name positions (never file-controlled
 * text) and never quote values, so a credential mistakenly written as a field
 * or provider name cannot leak through an exception.
 *
 * Confinement (C1.4c): the file stays plaintext at rest, but with confinement
 * on its content is unreadable and unwritable from the confined `execute`
 * shell — the shell is granted its world and its per-node scratch leaf
 * writable, the explicit system read set read-only (the merged-usr dirs, a
 * narrow `/etc` file list plus `/etc/ssl/certs`, `/proc`), and five device
 * files individually (`/dev/null` and `/dev/tty` writable, `/dev/zero`,
 * `/dev/random`, `/dev/urandom` read-only). A host-supplied escape hatch
 * (`terminal.sandbox: false`) is the explicit exception: it hands the shell
 * back its ambient authority, the credential file included. The guarantee is
 * scoped to filesystem content — pathname UNIX sockets, metadata mutations and
 * `/proc` stat surfaces remain unmediated (the residual list is kernel.md §7).
 * The guarantee bought here is precise: the kernel interpolates a key into no
 * event, artifact, world write or model request — each key is only ever
 * interpolated into the `Authorization` header its own client writes — and a
 * provider response body is journaled verbatim, so a hostile provider can
 * still reflect the key into the frontier journal.
 *
 * The registry key is also the credential id the frontier journals:
 * `webToolsFromProviders` passes the literal `'tavily'` into every `http/request`
 * — `ProviderEntry` carries no `name` field, so this registry key is the one
 * home for the id — and never the entry's `key`, which is the secret. The `llm`
 * entry journals the literal id `'llm'` the same way; the frontier records ids
 * and placements, never values. The factory validates the two URLs it will
 * journal (`<baseUrl>/search`, `<baseUrl>/extract`) with the frontier's own URL
 * predicate at construction, so a misconfigured base URL fails once, loudly,
 * there; `llm.endpoint` is validated against that same predicate at load, so
 * the transport can never be handed a URL the frontier would refuse to journal.
 *
 * The host composes this store: it loads the registry once through
 * `loadProviderStore`, builds the web tools against the cell's frontier gate,
 * and hands the `llm` entry to the provider transport under the `'llm'`
 * credential. The library composition is the same registry without the host —
 * load the store, build the port against the cell's frontier gate, and pass it
 * as the optional `webTools` field — under `exactOptionalPropertyTypes` that
 * property is spread conditionally, never assigned `undefined`:
 * `const webTools = webToolsFromProviders(await loadProviders(home), journal.gate);`
 * `createAgentRuntime({ ...options, ...(webTools !== undefined ? { webTools } : {}) });`
 *
 * Not to be confused with `src/provider/adapter.ts`: this module stores web-tool
 * and model credentials; that one is the LLM request path.
 */

const PROVIDERS_BASENAME = 'providers.json';

export type ProviderEntry = {
  readonly key: string; readonly baseUrl: string;
  readonly timeoutMs: number; readonly maxResults: number; readonly maxResponseBytes: number;
};

/**
 * The model endpoint the host's provider transport posts to. No defaults: an
 * absent `endpoint` is a refusal, because a guessed endpoint could send the key
 * somewhere the operator never chose, and the endpoint is validated with the
 * frontier's own URL predicate so `begin` can never refuse what the store
 * accepted.
 *
 * `models` is the operator's declaration of the model ids the endpoint serves:
 * **operator-declared, unverified, not a routing table**. The kernel does not
 * probe the endpoint; a declared id selects nothing but the `model` field of a
 * request, and every id is a non-secret by declaration — ids only, never keys.
 * Absent means no catalog: no substrate block, no validation, and a node's
 * model stays the free string it was. When present, the kernel projects the
 * ids into every request as a kernel-owned substrate block, lists them in
 * `inspect`, and validates every start and every spawn that names a model
 * against them.
 */
export type LlmEntry = {
  readonly key: string; readonly endpoint: string; readonly models?: readonly string[];
};

export type ProviderRegistry = {
  readonly tavily?: ProviderEntry; readonly llm?: LlmEntry;
};

const DEFAULT_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_CEILING_MS = 120000;
const MAX_RESULTS_CEILING = 20;
const MAX_RESPONSE_BYTES_CEILING = 8 * 1024 * 1024;
const ENTRY_FIELDS = ['key', 'baseUrl', 'timeoutMs', 'maxResults', 'maxResponseBytes'];
const LLM_FIELDS = ['key', 'endpoint', 'models'];
/** The provider store's ceiling: an oversize file is refused before parsing. */
const MAX_PROVIDERS_BYTES = 1024 * 1024;

/**
 * The manifest's own caps: a declaration, not a payload. The ids are the
 * operator's, so their count and length are bounded here rather than trusted:
 * sixty-four ids of at most 256 visible characters each still fit the
 * substrate block and the inspect catalogue comfortably.
 */
export const MAX_MODEL_IDS = 64;
export const MAX_MODEL_ID_CHARS = 256;

/**
 * The one model-id character class: one line of printable ASCII (0x20–0x7E).
 * Control characters, newlines, DEL and every non-ASCII code point are refused
 * — an id that could forge a second line, reorder a listing or smuggle an
 * escape sequence is not an id.
 */
const MODEL_ID_RE = /^[\x20-\x7E]+$/;

/**
 * The renderer's denial dimension: `extend` renders a bounded refusal as
 * `denied: ${singleLine(err.message, 200)}`, so a teaching message budgeted to
 * this many code points renders whole — the tail pointer survives by
 * construction instead of being silently cut. The clamp itself stays at the
 * renderer (`src/node/tools/extend.ts`, the one `denied:` shape); this constant
 * is the budget the refusal builder below sizes itself against, and the tests
 * pin the two together.
 */
export const MODEL_REFUSAL_CODE_POINTS = 200;

/** The requested id is an unbounded tool argument: echo at most this many code points of it. */
const MODEL_ECHO_CODE_POINTS = 32;

/** ...and at most this many once JSON-quoted (an escaped code point can cost six). */
const MODEL_ECHO_RENDER_CODE_POINTS = 64;

/** The honest marker for a listing cut to fit the budget; the pointer names the rest. */
const LISTING_CUT = '…';

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
 * The one endpoint grammar, guarded as a whole: the frontier's own predicate
 * (a bounded `https`-or-`http` URL with no query, fragment or userinfo) and
 * `new URL` (authority and port syntax) both run here, so their refusals — a
 * `FrontierValidationError`, a `TypeError`, a port overflow — become one
 * position-named message that never quotes the value. The scheme decision sits
 * outside the catch: it is this store's policy, not a parse failure, and it must
 * not be swallowed into the generic text.
 */
function llmEndpoint(value: unknown): string {
  if (typeof value !== 'string') fail('llm.endpoint: expected a string');
  const endpoint = value;
  let parsed: URL;
  try {
    validateFrontierUrl(endpoint);
    parsed = new URL(endpoint);
  } catch {
    fail('llm.endpoint: must be an https URL with no query, fragment or userinfo');
  }
  if (parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    fail('llm.endpoint: must be https unless it is a loopback host');
  }
  return endpoint;
}

/**
 * The declared model ids: a JSON array of unique one-line printable ASCII ids
 * (the class is `MODEL_ID_RE`, 0x20–0x7E), at most `MAX_MODEL_IDS` entries of
 * at most `MAX_MODEL_ID_CHARS` characters each. Refusals name a position and
 * never quote a value — a mistyped entry cannot leak through an exception any
 * more than a key could. An empty array is a declaration of no served models
 * (every start is then refused with the honest zero-catalog message), never
 * "today's behavior": only an ABSENT `models` key is the pre-manifest store.
 */
function modelIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) fail('llm.models: expected an array of model ids');
  if (value.length > MAX_MODEL_IDS) {
    fail(`llm.models: expected at most ${MAX_MODEL_IDS} entries`);
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const [index, raw] of value.entries()) {
    const at = `llm.models[${index}]`;
    if (typeof raw !== 'string') fail(`${at}: expected a string`);
    if (raw.length === 0) fail(`${at}: expected a nonempty model id`);
    if ([...raw].length > MAX_MODEL_ID_CHARS) {
      fail(`${at}: expected at most ${MAX_MODEL_ID_CHARS} characters`);
    }
    if (!MODEL_ID_RE.test(raw)) {
      fail(`${at}: expected a one-line printable ASCII model id`);
    }
    if (seen.has(raw)) fail(`${at}: repeats an earlier model id`);
    seen.add(raw);
    ids.push(raw);
  }
  return ids;
}

/**
 * The `llm` entry: exactly a nonempty `key` and an `endpoint`, no defaults and
 * no extra fields; `models` is the optional manifest. Like every other refusal
 * here, the message names a position and never a value.
 */
function llmEntry(value: unknown): LlmEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('llm: expected an object');
  }
  const o = value as Record<string, unknown>;
  for (const [index, key] of Object.keys(o).entries()) {
    if (!LLM_FIELDS.includes(key)) fail(`llm: unexpected field at position ${index + 1}`);
  }
  if (typeof o['key'] !== 'string' || o['key'].length === 0) {
    fail('llm.key: expected a nonempty string');
  }
  const models = o['models'] === undefined ? undefined : modelIds(o['models']);
  return {
    key: o['key'], endpoint: llmEndpoint(o['endpoint']),
    ...(models !== undefined ? { models } : {}),
  };
}

/** The code points of a string — the unit `singleLine`'s clamp counts. */
function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * The requested id as a bounded, quoted display token. It is an unbounded tool
 * argument, so `singleLine` strips anything that could forge a line and cuts
 * to `MODEL_ECHO_CODE_POINTS`; JSON quoting then doubles or escapes up to six
 * code points per character, so the quoted form is capped again. A cut token
 * ends inside its closing quote with an honest ellipsis.
 */
function echoedModel(model: string): string {
  const quoted = JSON.stringify(singleLine(model, MODEL_ECHO_CODE_POINTS));
  const points = [...quoted];
  if (points.length <= MODEL_ECHO_RENDER_CODE_POINTS) return quoted;
  return `${points.slice(0, MODEL_ECHO_RENDER_CODE_POINTS - 2).join('')}${LISTING_CUT}"`;
}

/**
 * The served ids as a listing that fits `budget` code points, honest about a
 * cut: a whole list ends with the last id, a cut one with `, …` after as many
 * ids as fit, and a list with no room for even one id at all shows the marker
 * alone. The pointer that follows the listing names the count.
 */
function servedListing(served: readonly string[], budget: number): string {
  let listing = '';
  let complete = true;
  for (const [index, id] of served.entries()) {
    const next = listing === '' ? id : `${listing}, ${id}`;
    const rest = served.length - index - 1;
    const fits = rest === 0
      ? codePoints(next) <= budget
      : codePoints(`${next}, ${LISTING_CUT}`) <= budget;
    if (!fits) {
      complete = false;
      break;
    }
    listing = next;
  }
  if (listing === '') {
    return served.length > 0 && codePoints(LISTING_CUT) <= budget ? LISTING_CUT : '';
  }
  return complete ? listing : `${listing}, ${LISTING_CUT}`;
}

/**
 * The teaching refusal for a model the declaration does not serve — shared by
 * every seam that validates one (a start's resolved configs and a spawn's
 * requested model). It enumerates the catalog, but budgeted as a whole for the
 * renderer's `MODEL_REFUSAL_CODE_POINTS` clamp: the echoed id, the fixed
 * prefix and the `(N models total — inspect lists them)` pointer are the fixed
 * costs, and the id listing is sized to what remains, so the whole denial
 * renders un-truncated by construction and the pointer (the teaching) always
 * survives. The requested id is a non-secret tool argument by declaration;
 * the catalog itself is non-secret too — this is the one refusal that echoes
 * an id, and both are clamped.
 */
export function modelRefusal(model: string, served: readonly string[]): string {
  const head = `model ${echoedModel(model)} is not served; this kernel serves:`;
  if (served.length === 0) {
    return `${head} no models (providers.json declares llm.models empty)`;
  }
  const noun = served.length === 1 ? 'model' : 'models';
  const pointer = ` (${served.length} ${noun} total — inspect lists them)`;
  const budget = MODEL_REFUSAL_CODE_POINTS - codePoints(head) - codePoints(pointer) - 1;
  const listing = servedListing(served, budget);
  return `${head}${listing === '' ? '' : ` ${listing}`}${pointer}`;
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
    if (name !== 'tavily' && name !== 'llm') fail(`unknown provider at position ${index + 1}`);
  }
  const registry: { tavily?: ProviderEntry; llm?: LlmEntry } = {};
  if ('tavily' in root) registry.tavily = entry(root['tavily'], 'tavily');
  if ('llm' in root) registry.llm = llmEntry(root['llm']);
  return freezeRegistry(registry);
}
