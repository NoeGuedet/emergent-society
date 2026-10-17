import type { SafeFailure } from '../context/contracts.js';
import { readBoundedBody } from '../net/bounded-body.js';

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
  /**
   * Sends the exact bytes and settles only on a response or a signal abort:
   * this method has no timeout of its own. Callers MUST supply a timing signal
   * (the adapter arms `requestTimeoutMs` on an internal controller and aborts
   * it); passing an unsignalled or never-aborted signal can hang the caller.
   */
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
    const { body: captured, complete, outcome } = await readBoundedBody(
      response.body, maxBytes, () => aborted(signal));
    // The transport's own vocabulary: a cap and an interrupted read are safe
    // failures; a caller abort wins over the read error it caused.
    const failure: SafeFailure | null = outcome === 'body-limit'
      ? { code: 'body-limit', status }
      : outcome === 'cancelled-by-caller' ? { code: 'cancelled', status }
      : outcome === 'read-error' ? { code: 'network', status }
      : null;
    return { status, body: captured, complete, failure };
  }
}
