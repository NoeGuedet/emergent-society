import { Buffer } from 'node:buffer';
import type { SafeFailure } from '../context/contracts.js';

/**
 * The one HTTP transport (T6, kernel.md §4).
 *
 * `OpenAITransport` sends the exact retained wire bytes to `fetch`; it never
 * parses, reshapes or canonicalizes the body, and it sets only the content-type
 * and authorization headers, which are never logged. Endpoint and key are
 * injected via `TransportConfig`, never read from the environment or config
 * facts. Network and abort errors become a safe `TransportResult` — no arbitrary
 * Error, cause, stack, URL, header or key enters any journal event.
 *
 * Before headers a failure yields `status: null`, an empty body and a safe
 * failure. At a known status the response is streamed bounded by `maxBytes`:
 * a complete body is `complete: true` with no failure, an over-cap or interrupted
 * body preserves the captured prefix with `complete: false` and a safe failure.
 * Invalid UTF-8 bytes are preserved verbatim; decoding is the adapter's job.
 */

export type TransportResult = {
  readonly status: number | null; readonly body: Uint8Array;
  readonly complete: boolean; readonly failure: SafeFailure | null;
};

export interface SerializedTransport {
  post(body: Uint8Array, signal: AbortSignal, maxBytes: number): Promise<TransportResult>;
}

export type TransportConfig = { readonly endpoint: string; readonly key: string };

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export class OpenAITransport implements SerializedTransport {
  constructor(private readonly config: TransportConfig) {}

  async post(body: Uint8Array, signal: AbortSignal, maxBytes: number): Promise<TransportResult> {
    let response: Response;
    try {
      response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.key}`,
        },
        body,
        signal,
      });
    } catch {
      return {
        status: null, body: new Uint8Array(), complete: false,
        failure: aborted(signal)
          ? { code: 'cancelled', status: null }
          : { code: 'network', status: null },
      };
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
          if (total + chunk.length > maxBytes) {
            const remaining = maxBytes - total;
            if (remaining > 0) collected.push(chunk.subarray(0, remaining));
            total = maxBytes;
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
        failure = aborted(signal)
          ? { code: 'cancelled', status }
          : { code: 'network', status };
      }
    }

    return { status, body: Buffer.concat(collected), complete, failure };
  }
}
