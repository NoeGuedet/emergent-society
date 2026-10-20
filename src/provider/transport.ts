import type { SafeFailure } from '../context/contracts.js';
import {
  FRONTIER_MAX_CREDENTIAL_ID, FrontierValidationError, validateFrontierUrl,
} from '../frontier/events.js';
import { readBoundedBody } from '../net/bounded-body.js';
import { isLoopback } from '../util.js';

/**
 * The one HTTP transport (T6, kernel.md §4).
 *
 * `OpenAITransport` sends the exact retained wire bytes to `fetch`; it never
 * parses, reshapes or canonicalizes the body, and it sets only the content-type
 * and authorization headers, whose values are never journaled. Endpoint and key
 * are injected via `TransportConfig`, never read from the environment or config
 * facts. Network and abort errors become a safe `TransportResult` — no arbitrary
 * Error, cause, stack, URL, header or key enters any journal event.
 *
 * The port carries the wire facts the adapter cannot otherwise see: the exact
 * endpoint URL, the non-secret request headers and the credential id (never the
 * value). The endpoint and the credential id are validated once, at
 * construction — the endpoint by the frontier's own URL predicate plus the
 * https-except-loopback rule, the id against the gate's own bound — so `begin`
 * can never discover a problem the constructor missed.
 *
 * Before headers a failure yields `status: null`, an empty body and a safe
 * failure. At a known status the response is streamed bounded by `maxBytes`:
 * a complete body is `complete: true` with no failure, an over-cap or interrupted
 * body preserves the captured prefix with `complete: false` and a safe failure.
 * Invalid UTF-8 bytes are preserved verbatim; decoding is the adapter's job.
 * A redirect is never followed (`redirect: 'manual'`): a 3xx arrives as the
 * response it is.
 */

/** The wire facts a transport declares for the frontier journal. */
export type TransportFacts = {
  readonly url: string;                                   // the exact endpoint URL
  readonly headers: Readonly<Record<string, string>>;     // non-secret; 'content-type' today
  readonly credentialId: string;                          // an id, never the value
};

export type TransportResult = {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;     // the raw response headers
  readonly body: Uint8Array;
  readonly complete: boolean;
  readonly failure: SafeFailure | null;
};

export interface SerializedTransport {
  /** The wire facts of the next send; journaled before it. */
  readonly facts: TransportFacts;
  /**
   * Sends the exact bytes and settles only on a response or a signal abort:
   * this method has no timeout of its own. Callers MUST supply a timing signal
   * (the adapter arms `requestTimeoutMs` on an internal controller and aborts
   * it); passing an unsignalled or never-aborted signal can hang the caller.
   */
  post(body: Uint8Array, signal: AbortSignal, maxBytes: number): Promise<TransportResult>;
}

export type TransportConfig = {
  readonly endpoint: string;
  readonly key: string;
  /** The credential id the frontier journals; defaults to the LLM registry key. */
  readonly credentialId?: string;
};

/** The one request header the transport sets besides the authorization value. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json' };

/**
 * Validates the endpoint once: the frontier URL predicate plus the https rule
 * (the shared `isLoopback` predicate `providers.ts` applies to a base URL).
 */
function validateEndpoint(endpoint: string): string {
  const url = validateFrontierUrl(endpoint);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FrontierValidationError('invalid transport endpoint: not a URL');
  }
  if (parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
    throw new FrontierValidationError(
      'invalid transport endpoint: must be https unless it is a loopback host',
    );
  }
  return url;
}

/**
 * Validates the journaled credential id once, at construction, against the same
 * bound the gate applies at `begin` (code points, not UTF-16 units). A bad id
 * must fail loudly here rather than refuse every send it touches.
 */
function validateCredentialId(id: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new FrontierValidationError(
      'invalid transport credential id: expected a nonempty string',
    );
  }
  if (Array.from(id).length > FRONTIER_MAX_CREDENTIAL_ID) {
    throw new FrontierValidationError(
      `invalid transport credential id: expected at most ${FRONTIER_MAX_CREDENTIAL_ID} characters`,
    );
  }
  return id;
}

export class OpenAITransport implements SerializedTransport {
  readonly facts: TransportFacts;

  constructor(private readonly config: TransportConfig) {
    this.facts = {
      url: validateEndpoint(config.endpoint),
      headers: REQUEST_HEADERS,
      credentialId: validateCredentialId(config.credentialId ?? 'llm'),
    };
  }

  async post(body: Uint8Array, signal: AbortSignal, maxBytes: number): Promise<TransportResult> {
    let response: Response;
    try {
      response = await fetch(this.facts.url, {
        method: 'POST',
        headers: { ...REQUEST_HEADERS, authorization: `Bearer ${this.config.key}` },
        body,
        signal,
        redirect: 'manual',
      });
    } catch {
      return {
        status: null, headers: {}, body: new Uint8Array(), complete: false,
        failure: signal.aborted
          ? { code: 'cancelled', status: null }
          : { code: 'network', status: null },
      };
    }

    const status = response.status;
    const headers = Object.fromEntries(response.headers);
    const { body: captured, complete, outcome } = await readBoundedBody(
      response.body, maxBytes, () => signal.aborted);
    // The transport's own vocabulary: a cap and an interrupted read are safe
    // failures; a caller abort wins over the read error it caused.
    const failure: SafeFailure | null = outcome === 'body-limit'
      ? { code: 'body-limit', status }
      : outcome === 'cancelled-by-caller' ? { code: 'cancelled', status }
      : outcome === 'read-error' ? { code: 'network', status }
      : null;
    return { status, headers, body: captured, complete, failure };
  }
}
