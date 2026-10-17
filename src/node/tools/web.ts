import { Buffer } from 'node:buffer';
import type { SafeFailure } from '../../context/contracts.js';
import { decodeToolText } from './text.js';
import type { ProviderEntry, ProviderRegistry } from './providers.js';

/**
 * Kernel-mediated web tools (kernel.md §7, C1.4a): `web_search` and `web_fetch`
 * are executed by the kernel itself against the configured provider (Tavily),
 * so every request crosses the gate and is journaled by `tool/call`/`tool/result`,
 * and the credential only ever travels in an `Authorization` header this module
 * writes. No streaming to the model and no retry: a failure is an agent-visible
 * classified outcome. `WebOutcome` never carries request URLs, error objects, or the key —
 * only a status, bounded body bytes and a `SafeFailure`. That is one half of the
 * bound: a provider response body is captured and journaled verbatim, so a
 * hostile provider could reflect the credential back into the journal —
 * unfiltered, accepted for the experiment phase. The bounded streamed
 * read deliberately mirrors `src/provider/transport.ts` instead of importing it:
 * importing provider code from node would invert the layering.
 */

export type WebOutcome =
  | { readonly ok: true; readonly status: number; readonly body: Uint8Array }
  | { readonly ok: false; readonly failure: SafeFailure; readonly status: number | null;
      readonly body: Uint8Array; readonly complete: boolean };

export interface WebTools {
  search(query: string, maxResults: number | undefined, signal: AbortSignal): Promise<WebOutcome>;
  extract(url: string, signal: AbortSignal): Promise<WebOutcome>;
}

export function webToolsFromProviders(registry: ProviderRegistry): WebTools | undefined {
  return registry.tavily === undefined ? undefined : new TavilyWebTools(registry.tavily);
}

function failureOutcome(
  failure: SafeFailure, status: number | null, body: Uint8Array, complete: boolean,
): WebOutcome {
  return { ok: false, failure, status, body, complete };
}

export class TavilyWebTools implements WebTools {
  constructor(private readonly entry: ProviderEntry) {}

  search(query: string, maxResults: number | undefined, signal: AbortSignal): Promise<WebOutcome> {
    const payload = Buffer.from(JSON.stringify({
      query, max_results: Math.min(maxResults ?? this.entry.maxResults, this.entry.maxResults),
      search_depth: 'basic',
    }), 'utf8');
    return this.post('/search', payload, signal);
  }

  extract(url: string, signal: AbortSignal): Promise<WebOutcome> {
    const payload = Buffer.from(
      JSON.stringify({ urls: [url], extract_depth: 'basic' }), 'utf8');
    return this.post('/extract', payload, signal);
  }

  private async post(path: string, payload: Uint8Array, signal: AbortSignal): Promise<WebOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.entry.timeoutMs);
    const onGate = (): void => { controller.abort(); };
    if (signal.aborted) {
      clearTimeout(timer);
      return failureOutcome({ code: 'cancelled', status: null }, null, new Uint8Array(), false);
    }
    signal.addEventListener('abort', onGate, { once: true });
    try {
      let response: Response;
      try {
        response = await fetch(`${this.entry.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.entry.key}`,
          },
          body: payload, signal: controller.signal,
        });
      } catch {
        return failureOutcome(
          signal.aborted ? { code: 'cancelled', status: null }
            : timedOut ? { code: 'timeout', status: null }
            : { code: 'network', status: null },
          null, new Uint8Array(), false);
      }
      const status = response.status;
      const collected: Buffer[] = [];
      let total = 0;
      let complete = true;
      let failure: SafeFailure | null = null;
      const stream = response.body;
      if (stream !== null) {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            const chunk = Buffer.from(value);
            if (total + chunk.length > this.entry.maxResponseBytes) {
              const remaining = this.entry.maxResponseBytes - total;
              if (remaining > 0) collected.push(chunk.subarray(0, remaining));
              total = this.entry.maxResponseBytes;
              complete = false;
              failure = { code: 'body-limit', status };
              try { await reader.cancel(); } catch { /* the prefix is still returned */ }
              break;
            }
            collected.push(chunk);
            total += chunk.length;
          }
        } catch {
          complete = false;
          failure = signal.aborted ? { code: 'cancelled', status }
            : timedOut ? { code: 'timeout', status }
            : { code: 'network', status };
        }
      }
      const body = Buffer.concat(collected);
      if (failure !== null) {
        // A gate abort or the timeout that landed during the final reads — including
        // inside `reader.cancel()` — still outranks a recorded body-limit or network.
        if (signal.aborted) {
          return failureOutcome({ code: 'cancelled', status }, status, body, complete);
        }
        if (timedOut) return failureOutcome({ code: 'timeout', status }, status, body, complete);
        return failureOutcome(failure, status, body, complete);
      }
      // A gate abort that landed during the final reads still wins over success.
      if (signal.aborted) {
        return failureOutcome({ code: 'cancelled', status }, status, body, complete);
      }
      if (status !== 200) return failureOutcome({ code: 'http', status }, status, body, true);
      return { ok: true, status, body };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onGate);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
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
