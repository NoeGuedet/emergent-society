import { Buffer } from 'node:buffer';
import { toFrontierCode } from '../../context/contracts.js';
import type { SafeFailure } from '../../context/contracts.js';
import {
  FrontierValidationError, filterHeaders, validateFrontierUrl,
} from '../../frontier/index.js';
import type {
  CallId, Frontier, FrontierOutcome,
} from '../../frontier/index.js';
import { readBoundedBody } from '../../net/bounded-body.js';
import { isLoopback, isRecord } from '../../util.js';
import { decodeToolText } from './text.js';
import type { ProviderEntry, ProviderRegistry } from './providers.js';

/**
 * Kernel-mediated web tools (kernel.md §7, C1.4a / C1.4d): `web_search` and
 * `web_fetch` are executed by the kernel itself against the configured provider
 * (Tavily), so every request crosses the frontier — `begin` is durable and
 * read-back verified before the fetch is sent, `complete` is durable before the
 * caller proceeds — and the raw provider body is a frontier fact. The local
 * `tool/call`/`tool/result` pair carries only the call reference. The credential
 * only ever travels in an `Authorization` header this module writes: it is never
 * a journaled header, URL, body or id (the journaled credential id is the
 * registry key, never the value). One residual is accepted for the experiment
 * phase and stated plainly: a provider response body is journaled verbatim, so
 * a hostile provider could reflect the credential back into the frontier — and,
 * as before, into the model-visible local result text.
 *
 * No streaming to the model and no retry: a failure is an agent-visible
 * classified outcome. `WebOutcome` never carries request URLs, error objects or
 * the key — only a status, bounded body bytes, a `SafeFailure` and the frontier
 * `frontierCall` (null exactly on the already-aborted path, where no call was
 * ever begun). The bounded streamed read is the neutral
 * `src/net/bounded-body.ts` helper, shared with the transport: node must not
 * import provider code (that would invert the layering), so the loop itself
 * lives below both.
 */

export type WebOutcome =
  | { readonly ok: true; readonly status: number; readonly body: Uint8Array;
      readonly frontierCall: CallId | null }
  | { readonly ok: false; readonly failure: SafeFailure; readonly status: number | null;
      readonly body: Uint8Array; readonly complete: boolean;
      readonly frontierCall: CallId | null };

export interface WebTools {
  search(query: string, maxResults: number | undefined, signal: AbortSignal): Promise<WebOutcome>;
  extract(url: string, signal: AbortSignal): Promise<WebOutcome>;
}

/** The credential id the frontier journals: the registry key, never its value. */
const CREDENTIAL_ID = 'tavily';
/** The one request header this client sets besides the authorization value. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json' };

/** The argument shape both the port and the request-body helper share. */
type WebArgs =
  | { readonly kind: 'web_search'; readonly query: string;
      readonly maxResults: number | undefined }
  | { readonly kind: 'web_fetch'; readonly url: string };

/**
 * The one place a Tavily request body is built, shared with the acceptance
 * harness (which recomputes the expected body from the recorded `tool/call`
 * arguments). The `maxResults` clamp lives here; the object form is not a
 * second public surface — the `WebTools` port keeps its positional signatures.
 */
export function webRequestBody(args: WebArgs, entry: ProviderEntry): Uint8Array {
  const payload = args.kind === 'web_search'
    ? { query: args.query,
        max_results: Math.min(args.maxResults ?? entry.maxResults, entry.maxResults),
        search_depth: 'basic' }
    : { urls: [args.url], extract_depth: 'basic' };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export function webToolsFromProviders(
  registry: ProviderRegistry, frontier: Frontier,
): WebTools | undefined {
  return registry.tavily === undefined
    ? undefined : new TavilyWebTools(registry.tavily, frontier);
}

function failureOutcome(
  failure: SafeFailure, status: number | null, body: Uint8Array, complete: boolean,
  frontierCall: CallId | null,
): WebOutcome {
  return { ok: false, failure, status, body, complete, frontierCall };
}

/** The exchange's pure outcome, before the frontier reference is attached. */
export type Exchange =
  | { readonly ok: true; readonly status: number; readonly body: Uint8Array;
      readonly headers: Record<string, string> }
  | { readonly ok: false; readonly failure: SafeFailure; readonly status: number | null;
      readonly body: Uint8Array; readonly complete: boolean;
      readonly headers: Record<string, string> };

function failureExchange(
  failure: SafeFailure, status: number | null, body: Uint8Array, complete: boolean,
  headers: Record<string, string>,
): Exchange {
  return { ok: false, failure, status, body, complete, headers };
}

/**
 * Maps a captured exchange to the frontier's terminal vocabulary. A stop
 * observed after a whole-body read records the exchange's own completed outcome
 * (the adapter's rule: the terminal is the outcome classified at the exchange) —
 * only the caller-visible failure is the cancellation. An incomplete capture can
 * never claim completeness, so it keeps its code.
 */
export function frontierOutcome(exchange: Exchange): FrontierOutcome {
  const headers = filterHeaders(exchange.headers, 'response');
  if (exchange.ok) {
    return { status: exchange.status, headers, body: exchange.body,
      encoding: 'binary', complete: true };
  }
  const code = toFrontierCode(exchange.failure);
  if (exchange.status !== null && exchange.complete && code !== 'http' && code !== 'body-limit') {
    return exchange.status === 200
      ? { status: exchange.status, headers, body: exchange.body,
          encoding: 'binary', complete: true }
      : { status: exchange.status, headers, body: exchange.body,
          encoding: 'binary', complete: true, error: 'http' };
  }
  return { status: exchange.status, headers, body: exchange.body,
    encoding: 'binary', complete: exchange.complete, error: code };
}

/**
 * The provenance rule both credential-bearing clients apply: `https:` unless the
 * host is loopback, so a direct construction cannot put the key on the wire in
 * cleartext. `loadProviders` applies the same rule to a configured base URL.
 */
function validateBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new FrontierValidationError('invalid web tools base URL: not a URL');
  }
  if (parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    throw new FrontierValidationError(
      'invalid web tools base URL: must be https unless it is a loopback host',
    );
  }
}

export class TavilyWebTools implements WebTools {
  private readonly urls: { readonly search: string; readonly extract: string };

  constructor(private readonly entry: ProviderEntry, private readonly frontier: Frontier) {
    // The base URL and the two URLs this client will journal are validated once,
    // at construction: the https rule, then the same frontier predicate `begin`
    // applies — so a misconfigured base URL fails loudly here and never becomes
    // a per-call begin failure.
    validateBaseUrl(entry.baseUrl);
    this.urls = {
      search: validateFrontierUrl(`${entry.baseUrl}/search`),
      extract: validateFrontierUrl(`${entry.baseUrl}/extract`),
    };
  }

  search(query: string, maxResults: number | undefined, signal: AbortSignal): Promise<WebOutcome> {
    return this.call({ kind: 'web_search', query, maxResults }, this.urls.search, signal);
  }

  extract(url: string, signal: AbortSignal): Promise<WebOutcome> {
    return this.call({ kind: 'web_fetch', url }, this.urls.extract, signal);
  }

  private async call(args: WebArgs, url: string, signal: AbortSignal): Promise<WebOutcome> {
    const body = webRequestBody(args, this.entry);
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onGate = (): void => { controller.abort(); };
    try {
      // No call exists for an already-stopped caller: no begin, no event.
      if (signal.aborted) {
        return failureOutcome(
          { code: 'cancelled', status: null }, null, new Uint8Array(), false, null);
      }

      // Durable and read-back verified before the send; a failure here throws
      // and the fetch never happens.
      const call = await this.frontier.begin({
        method: 'POST',
        url,
        headers: filterHeaders(REQUEST_HEADERS, 'request'),
        credentials: [{ id: CREDENTIAL_ID, where: 'authorization' }],
        body,
        encoding: 'utf8',
      });
      // A stop that landed during `begin` closes the durable request as the
      // cancellation it is, and no POST is sent.
      if (signal.aborted) {
        await this.frontier.complete(call, {
          status: null, error: 'cancelled', body: new Uint8Array(),
          encoding: 'binary', complete: false,
        });
        return failureOutcome(
          { code: 'cancelled', status: null }, null, new Uint8Array(), false, call.call);
      }

      // The caller's timeout bounds the exchange, not the durable journaling.
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.entry.timeoutMs);
      signal.addEventListener('abort', onGate, { once: true });
      // Close the narrow window between the check above and the listener.
      if (signal.aborted) controller.abort();

      const exchange = await this.exchange(
        url, body, controller.signal, () => signal.aborted, () => timedOut);
      // The terminal is durable before the caller proceeds; a failure here
      // propagates as a fatal environment error, never as a WebOutcome.
      await this.frontier.complete(call, frontierOutcome(exchange));
      return exchange.ok
        ? { ok: true, status: exchange.status, body: exchange.body, frontierCall: call.call }
        : { ok: false, failure: exchange.failure, status: exchange.status,
            body: exchange.body, complete: exchange.complete, frontierCall: call.call };
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener('abort', onGate);
    }
  }

  /**
   * The HTTP exchange itself, computed purely on every path — transport throw,
   * bounded capture, capture failure, abort mid-read, non-200, success. It never
   * touches the frontier; `call` records its outcome.
   */
  private async exchange(
    url: string, body: Uint8Array, fetchSignal: AbortSignal,
    gateAborted: () => boolean, timedOut: () => boolean,
  ): Promise<Exchange> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { ...REQUEST_HEADERS, authorization: `Bearer ${this.entry.key}` },
        body, signal: fetchSignal,
        // A redirect would re-send the request to a URL the journal never
        // recorded; it arrives as the non-200 response it is.
        redirect: 'manual',
      });
    } catch {
      return failureExchange(
        gateAborted() ? { code: 'cancelled', status: null }
          : timedOut() ? { code: 'timeout', status: null }
          : { code: 'network', status: null },
        null, new Uint8Array(), false, {});
    }
    const status = response.status;
    const headers = Object.fromEntries(response.headers);
    const { body: captured, complete, outcome } = await readBoundedBody(
      response.body, this.entry.maxResponseBytes, gateAborted);
    // Web's vocabulary: an in-stream timeout has no transport analogue; every
    // other neutral outcome maps to the same safe code the old inline loop used.
    const failure: SafeFailure | null = outcome === 'body-limit'
      ? { code: 'body-limit', status }
      : outcome === 'cancelled-by-caller' ? { code: 'cancelled', status }
      : outcome === 'read-error' ? (timedOut() ? { code: 'timeout', status } : { code: 'network', status })
      : null;
    if (failure !== null) {
      // A gate abort or the timeout that landed during the final reads — including
      // inside `reader.cancel()` — still outranks a recorded body-limit or network.
      if (gateAborted()) {
        return failureExchange({ code: 'cancelled', status }, status, captured, complete, headers);
      }
      if (timedOut()) {
        return failureExchange({ code: 'timeout', status }, status, captured, complete, headers);
      }
      return failureExchange(failure, status, captured, complete, headers);
    }
    // A gate abort that landed during the final reads still wins over success.
    if (gateAborted()) {
      return failureExchange({ code: 'cancelled', status }, status, captured, complete, headers);
    }
    if (status !== 200) {
      return failureExchange({ code: 'http', status }, status, captured, true, headers);
    }
    return { ok: true, status, body: captured, headers };
  }
}

/** The shared predicate, narrowed to the null-on-miss shape this renderer reads. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseBody(body: Uint8Array): Record<string, unknown> | null {
  try { return asRecord(JSON.parse(decodeToolText(body))); } catch { return null; }
}

function requestId(o: Record<string, unknown>): string[] {
  const id = o['request_id'];
  return typeof id === 'string' ? [`request: ${shortField(id)}`] : [];
}

/**
 * Provider-controlled short fields stay on one line: every line or paragraph
 * separator (CR, LF, VT, FF, NEL, U+2028, U+2029) collapses to a space, so a
 * hostile provider cannot forge the structural lines of the model-visible
 * render. Long content (snippets, extracted text) deliberately keeps its
 * newlines.
 */
function shortField(text: string): string {
  return text.replace(/\s*[\r\n\u000b\u000c\u0085\u2028\u2029]\s*/g, ' ').trim();
}

export function renderSearch(body: Uint8Array): string | null {
  const o = parseBody(body);
  if (o === null || !Array.isArray(o['results'])) return null;
  const items: { title: string; url: string; content: string }[] = [];
  for (const raw of o['results'] as unknown[]) {
    const item = asRecord(raw);
    if (item === null || typeof item['url'] !== 'string' || typeof item['content'] !== 'string') {
      return null;
    }
    items.push({
      title: shortField(typeof item['title'] === 'string' ? item['title'] : ''),
      url: shortField(item['url']), content: item['content'],
    });
  }
  // An empty result page is a valid answer: it renders 'results: 0'.
  const lines = ['provider: tavily', ...requestId(o), `results: ${items.length}`];
  items.forEach((item, index) => {
    lines.push('', `[${index + 1}] ${item.title}`, item.url, item.content);
  });
  return lines.join('\n');
}

export function renderExtract(body: Uint8Array): { readonly text: string; readonly failed: boolean } | null {
  const o = parseBody(body);
  if (o === null || !Array.isArray(o['results']) || !Array.isArray(o['failed_results'])) {
    return null;
  }
  const results = o['results'] as unknown[];
  const failed = o['failed_results'] as unknown[];
  if (results.length === 0 && failed.length === 0) return null;
  // One URL in, one URL out: results[0] wins; any failed entries alongside are dropped.
  if (results.length > 0) {
    const item = asRecord(results[0]);
    if (item === null || typeof item['url'] !== 'string' || typeof item['raw_content'] !== 'string') {
      return null;
    }
    return { failed: false, text: [
      'provider: tavily', ...requestId(o), `url: ${shortField(item['url'])}`,
      'content:', item['raw_content'],
    ].join('\n') };
  }
  const item = asRecord(failed[0]);
  if (item === null || typeof item['url'] !== 'string' || typeof item['error'] !== 'string') {
    return null;
  }
  return { failed: true, text: [
    'provider: tavily', ...requestId(o), `url: ${shortField(item['url'])}`,
    `error: ${shortField(item['error'])}`,
  ].join('\n') };
}
