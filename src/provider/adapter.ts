import { Buffer } from 'node:buffer';
import { toJson } from '../context/artifacts.js';
import { truncationNotice, utf8Prefix } from '../text.js';
import { isRecord } from '../util.js';
import { filterHeaders } from '../frontier/index.js';
import { serializeWire } from './wire.js';
import type { Frontier, FrontierErrorCode, FrontierOutcome } from '../frontier/index.js';
import type { BoundaryGate } from '../node/gate.js';
import type {
  AssistantProjection, ChatMessage, FunctionCall, RequestPlan, SafeFailure,
} from '../context/contracts.js';
import type { SerializedTransport, TransportResult } from './transport.js';

/**
 * The provider adapter (T6, kernel.md §4).
 *
 * It owns the exact, bounded request path: serialize the single wire, then
 * cross the frontier — `begin` is durable and verified before the transport
 * sends, and the terminal `complete` is durable before the caller proceeds or
 * a retry is decided. Classification (`classifyNoStatus`/`classifyIncomplete`/
 * the status branch) computes that terminal at the exchange; a stop arriving
 * later rewrites only the returned `SafeFailure` and the local turn, never the
 * frontier record.
 *
 * The local log keeps only the semantic success fact: the assistant
 * `projection` (carrying the frontier `call` id) is stored and journaled as
 * `assistant/message`, flushed before the caller proceeds. Nothing else is
 * journaled locally: the plan is never journaled anywhere (its serialized bytes
 * are the request body), and the wire, raw response, usage and attempt facts
 * belong to the frontier. A terminal failure records nothing local — the
 * driver's `turn/end` carries the error. A flush/invariant failure raised while
 * journaling the projection is rethrown fatally and is never converted into a
 * `SendResult.failure`; a frontier `begin`/`complete` failure propagates the
 * same way (nothing crossed the frontier, or the send's terminal is pending).
 *
 * Retries are bounded by the plan's persisted policy and cover only network/
 * timeout or HTTP 408/429/500/502/503/504; a retry re-begins with the same
 * group and an incremented attempt, and reuses the same body bytes without
 * reserializing. The timeout is armed with the injected `schedule` and cleared
 * in `finally`; a machinery failure while arming is a pre-send marker (the
 * frontier terminal is `local`, nothing was handed to the transport). An
 * already-aborted signal prevents any send, and a stop during the body or the
 * delay yields a terminal cancellation with no later send. A status-known but
 * incomplete body keeps the transport's own `body-limit` (non-retryable), lets
 * a gate abort win as a non-retryable `cancelled` with the status preserved,
 * and turns the adapter's own timer into a retryable `timeout` rather than a
 * cancellation.
 *
 * Not to be confused with `src/node/tools/providers.ts`: this module is the LLM
 * request path; that one is the web-tool credential store.
 */

export type ProviderPolicy = {
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly schedule: (ms: number, callback: () => void) => () => void;
};

export type SendResult = { readonly kind: 'response'; readonly projection: AssistantProjection }
  | { readonly kind: 'failure'; readonly failure: SafeFailure };

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

/** A nonempty string, or `null` when the value is not one. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Thrown by the pure projection step; the adapter classifies it as `malformed`. */
class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedResponseError';
  }
}

type Projected = { readonly message: AssistantMessage };

/**
 * Decode (fatal UTF-8), parse and project only the fields that enter the
 * assistant projection. `toJson` runs on exactly those fields, so a UTF-8-valid
 * JSON body carrying an escaped lone surrogate parses but cannot be projected,
 * and throws `MalformedResponseError` — a safe terminal failure, never fatal.
 */
function project(body: Uint8Array, plan: RequestPlan): Projected {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new MalformedResponseError('invalid utf-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedResponseError('invalid json');
  }
  if (!isRecord(parsed)) throw new MalformedResponseError('body is not a json object');
  const choices = parsed['choices'];
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw new MalformedResponseError('choices must be an array of length 1');
  }
  const choice = choices[0];
  if (!isRecord(choice)) throw new MalformedResponseError('choice is not an object');
  const message = choice['message'];
  if (!isRecord(message) || message['role'] !== 'assistant') {
    throw new MalformedResponseError('message must be an assistant message');
  }
  const content = message['content'];
  if (content !== null && typeof content !== 'string') {
    throw new MalformedResponseError('content must be a string or null');
  }
  try {
    toJson(content);
  } catch {
    throw new MalformedResponseError('content cannot be projected');
  }

  const rawCalls = message['tool_calls'];
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) {
    throw new MalformedResponseError('tool_calls must be an array');
  }
  const list = rawCalls ?? [];
  if (list.length > plan.policy.maxCallsPerResponse) {
    throw new MalformedResponseError('too many tool calls');
  }
  const calls: FunctionCall[] = [];
  const ids = new Set<string>();
  for (const rawCall of list) {
    if (!isRecord(rawCall)) throw new MalformedResponseError('tool call is not an object');
    const id = nonEmptyString(rawCall['id']);
    if (id === null) throw new MalformedResponseError('tool call id must be nonempty');
    if (ids.has(id)) throw new MalformedResponseError('duplicate tool call id');
    ids.add(id);
    const type = rawCall['type'];
    if (type !== undefined && type !== 'function') {
      throw new MalformedResponseError('tool call type must be function');
    }
    const fn = rawCall['function'];
    if (!isRecord(fn)) throw new MalformedResponseError('tool call function is not an object');
    const name = nonEmptyString(fn['name']);
    if (name === null) throw new MalformedResponseError('tool call name must be nonempty');
    const args = fn['arguments'];
    if (typeof args !== 'string') throw new MalformedResponseError('tool call arguments must be a string');
    if (Buffer.byteLength(args, 'utf8') > plan.policy.maxToolArgumentBytes) {
      throw new MalformedResponseError('tool call arguments exceed the configured bound');
    }
    try {
      toJson({ id, name, arguments: args });
    } catch {
      throw new MalformedResponseError('tool call cannot be projected');
    }
    calls.push({ id, type: 'function', function: { name, arguments: args } });
  }

  return {
    message: { role: 'assistant', content: content as string | null, tool_calls: calls },
  };
}

/**
 * Bounds the model-visible assistant content to `policy.maxAssistantBytes` UTF-8
 * bytes (artifact algorithm 7) with the neutral code-point-safe cut. The raw
 * record is never altered; only the projection changes. The notice reports the
 * model-text cap separately from the frontier capture's byte count and
 * completeness, never conflating the two.
 */
function boundAssistant(
  message: AssistantMessage, maxBytes: number,
  capture: { readonly call: string; readonly bytes: number; readonly complete: boolean },
): { readonly message: AssistantMessage; readonly contentTruncated: boolean } {
  const content = message.content;
  if (content === null) return { message, contentTruncated: false };
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return { message, contentTruncated: false };
  const retained = utf8Prefix(content, maxBytes).text;
  return {
    message: {
      ...message,
      content: retained + truncationNotice('content', maxBytes, { kind: 'frontier', ...capture }),
    },
    contentTruncated: true,
  };
}

/**
 * Maps a `SafeFailure` to the frontier terminal's error code. Only the wire
 * codes can describe an exchange: `malformed` (a 200 whose projection fails)
 * and `request-limit` never reach a terminal, so mapping one is a programmer
 * error and throws instead of inventing a code.
 */
function toFrontierCode(failure: SafeFailure): FrontierErrorCode {
  switch (failure.code) {
    case 'http':
    case 'network':
    case 'timeout':
    case 'cancelled':
    case 'body-limit':
      return failure.code;
    default:
      throw new Error(`no frontier code for failure ${JSON.stringify(failure.code)}`);
  }
}

/** One `post` outcome: an exchange result, or the pre-send machinery marker. */
type Posted =
  | { readonly kind: 'result'; readonly result: TransportResult; readonly timedOut: boolean }
  | { readonly kind: 'pre-send'; readonly error: unknown };

export class ProviderAdapter {
  constructor(
    private readonly transport: SerializedTransport,
    private readonly policy: ProviderPolicy,
    private readonly frontier: Frontier,
  ) {}

  async send(plan: RequestPlan, gate: BoundaryGate): Promise<SendResult> {
    const id = plan.id;
    const policy = plan.policy;

    // Serialize once. The runtime owns the `MAX_CAPTURE_BYTES` capture-ceiling
    // refusal before this call; here a wire above the persisted
    // `maxRequestBytes` is refused terminally before any begin, with no send and
    // no local event — the driver's turn/end carries the error.
    const body = serializeWire(plan);
    if (body.length > policy.maxRequestBytes) {
      return { kind: 'failure', failure: { code: 'request-limit', status: null } };
    }

    let attempt = 0;
    /** The first begin mints the group; every retry reuses it. */
    let group: string | undefined;
    for (;;) {
      // An already-aborted signal prevents any send (a stop/park never sends).
      if (gate.signal.aborted) {
        return { kind: 'failure', failure: { code: 'cancelled', status: null } };
      }

      // Cross the frontier: the request record (and its body blob) is durable
      // and read-back verified before the transport sends.
      const facts = this.transport.facts;
      const call = await this.frontier.begin({
        method: 'POST',
        url: facts.url,
        headers: filterHeaders(facts.headers, 'request'),
        credentials: [{ id: facts.credentialId, where: 'authorization' }],
        body,
        encoding: 'utf8',
        ...(group !== undefined ? { group } : {}),
        attempt,
      });
      group = call.group;
      // A stop that landed during `begin`: the request is closed as the
      // cancellation it is, and no POST is sent (the durable request with no
      // POST, now with the frontier terminal it needs).
      if (gate.signal.aborted) {
        await this.frontier.complete(call, {
          status: null, error: 'cancelled', body: new Uint8Array(),
          encoding: 'binary', complete: false,
        });
        return { kind: 'failure', failure: { code: 'cancelled', status: null } };
      }

      const posted = await this.post(body, policy, gate);
      if (posted.kind === 'pre-send') {
        // The kernel's own machinery failed before anything was handed to the
        // transport: close the call as `local` (or as the stop it became), then
        // propagate the error.
        await this.frontier.complete(call, {
          status: null, body: new Uint8Array(), encoding: 'binary', complete: false,
          error: gate.signal.aborted ? 'cancelled' : 'local',
        });
        throw posted.error;
      }
      const result = posted.result;

      if (result.status === null) {
        // No status: the empty capture is the exchange's terminal.
        const failure = this.classifyNoStatus(result, posted.timedOut, gate);
        await this.frontier.complete(call, {
          status: null, body: new Uint8Array(), encoding: 'binary', complete: false,
          error: toFrontierCode(failure),
        });
        const retryable = failure.code === 'network' || failure.code === 'timeout';
        const next = await this.maybeRetry(gate, attempt, retryable, policy);
        if (next === 'continue') { attempt += 1; continue; }
        if (gate.signal.aborted) {
          return { kind: 'failure', failure: { code: 'cancelled', status: null } };
        }
        return { kind: 'failure', failure };
      }

      if (result.complete && result.status === 200) {
        // The exchange's outcome is the 200 itself; the projection (and a
        // malformed failure) is a local fact recorded after this terminal.
        await this.frontier.complete(call, {
          status: result.status,
          headers: filterHeaders(result.headers, 'response'),
          body: result.body,
          encoding: 'binary',
          complete: true,
        });
        let projected: Projected;
        try {
          projected = project(result.body, plan);
        } catch {
          // A body that parses but cannot be projected is a safe terminal
          // failure after the frontier terminal is durable — never a fatal
          // kernel error, and no local event.
          return { kind: 'failure', failure: { code: 'malformed', status: result.status } };
        }
        const bounded = boundAssistant(projected.message, policy.maxAssistantBytes, {
          call: call.call, bytes: result.body.length, complete: result.complete,
        });
        const projection: AssistantProjection = {
          message: bounded.message,
          contentTruncated: bounded.contentTruncated,
          frontierCall: call.call,
        };
        gate.append('assistant/message', { id, value: await gate.store(projection) });
        await gate.flush();
        return { kind: 'response', projection };
      }

      const classified: { readonly failure: SafeFailure; readonly retryable: boolean } =
        result.complete
          ? { failure: { code: 'http', status: result.status },
              retryable: RETRYABLE_STATUS.has(result.status) }
          : this.classifyIncomplete(result, posted.timedOut, gate);
      const failure = classified.failure;
      // The terminal is the outcome classified at the exchange. A stop that
      // arrives later (during the retry delay, say) rewrites only the adapter's
      // returned failure and the local turn/end — never this record.
      const outcome: FrontierOutcome = {
        status: result.status,
        headers: filterHeaders(result.headers, 'response'),
        body: result.body,
        encoding: 'binary',
        complete: result.complete,
        error: toFrontierCode(failure),
      };
      await this.frontier.complete(call, outcome);

      const next = await this.maybeRetry(gate, attempt, classified.retryable, policy);
      if (next === 'continue') { attempt += 1; continue; }
      // A stop observed before headers or during the retry delay is a boundary
      // cancellation; a stop already classified from a status-known body keeps
      // its own status (non-null in this branch), so recording never depends on
      // whether the stop landed during capture or afterwards.
      if (gate.signal.aborted && failure.code !== 'cancelled') {
        return { kind: 'failure', failure: { code: 'cancelled', status: failure.status } };
      }
      return { kind: 'failure', failure };
    }
  }

  /**
   * Classifies a status-known but incomplete body. A gate abort is checked
   * first: a stop is the terminal boundary decision, non-retryable, with the
   * known status preserved — the explicit priority the brief pins. The
   * transport's own `body-limit` is next and non-retryable (a body cut off at
   * the capture cap is never reclassified as a timeout), then the adapter's own
   * timer yields a retryable `timeout` with the status preserved, and anything
   * else is the transport's own failure (`network` when it reports none).
   *
   * This compares against the live gate signal, not a snapshot taken when the
   * POST returned, so an abort raised while the body was being read also wins.
   * Both `cancelled` and `body-limit` are terminal and non-retryable, so the
   * ordering is fixed by contract and pinned by test rather than left to chance.
   */
  private classifyIncomplete(
    result: TransportResult, timedOut: boolean, gate: BoundaryGate,
  ): { readonly failure: SafeFailure; readonly retryable: boolean } {
    const status = result.status;
    const base = result.failure;
    if (gate.signal.aborted) {
      return { failure: { code: 'cancelled', status }, retryable: false };
    }
    if (base !== null && base.code === 'body-limit') {
      return { failure: base, retryable: false };
    }
    if (timedOut) {
      return { failure: { code: 'timeout', status }, retryable: true };
    }
    const failure = base ?? { code: 'network', status };
    return { failure, retryable: failure.code === 'network' || failure.code === 'timeout' };
  }

  /**
   * One bounded POST. The timeout timer and the gate-abort listener are always
   * removed in `finally`; a transport throw becomes a safe network result and the
   * arbitrary Error is never stringified into any event. `timedOut` reports only
   * whether the adapter's own timer fired, so it can be told apart from a stop.
   *
   * A failure while arming (`addEventListener` or the injected `schedule`) is a
   * discriminated pre-send marker, not a throw: nothing was handed to the
   * transport, so the caller can close the frontier call as `local` before
   * propagating. The timer clear is made non-throwing — a failure after the
   * transport returned must never be classified as that pre-send fault.
   */
  private async post(
    body: Uint8Array, policy: RequestPlan['policy'], gate: BoundaryGate,
  ): Promise<Posted> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => { controller.abort(); };
    let clearTimer: (() => void) | null = null;
    // Register the listener and arm the timer as one guarded step: a throwing
    // injected `schedule` would otherwise leak the listener on the gate signal.
    try {
      gate.signal.addEventListener('abort', onAbort, { once: true });
      clearTimer = this.policy.schedule(policy.requestTimeoutMs, () => {
        timedOut = true;
        controller.abort();
      });
    } catch (error) {
      gate.signal.removeEventListener('abort', onAbort);
      return { kind: 'pre-send', error };
    }
    try {
      const result = await this.transport.post(body, controller.signal, policy.maxCaptureBytes);
      return { kind: 'result', result, timedOut };
    } catch {
      return {
        kind: 'result',
        result: {
          status: null, headers: {}, body: new Uint8Array(), complete: false,
          failure: { code: 'network', status: null },
        },
        timedOut,
      };
    } finally {
      // Remove the listener first: a throwing timer-clear must not leak it.
      gate.signal.removeEventListener('abort', onAbort);
      try { clearTimer?.(); } catch { /* the exchange outcome stands */ }
    }
  }

  /** Distinguishes the adapter's own timeout from gate cancellation (and network). */
  private classifyNoStatus(
    result: TransportResult, timedOut: boolean, gate: BoundaryGate,
  ): SafeFailure {
    const base = result.failure ?? { code: 'network', status: null };
    if (base.code !== 'cancelled') return base;
    if (gate.signal.aborted) return { code: 'cancelled', status: null };
    if (timedOut) return { code: 'timeout', status: null };
    return { code: 'cancelled', status: null };
  }

  /**
   * Waits the fixed cancellable delay and returns 'continue' to retry or
   * 'stop' when no retry is allowed. A cancelled delay returns 'stop' without
   * a later send. Nothing is journaled here: the terminal record belongs to the
   * frontier, and a local attempt fact no longer exists.
   */
  private async maybeRetry(
    gate: BoundaryGate, attempt: number, retryable: boolean, policy: RequestPlan['policy'],
  ): Promise<'continue' | 'stop'> {
    if (!retryable || attempt + 1 >= policy.maxAttempts) return 'stop';
    if (gate.signal.aborted) return 'stop';
    try {
      await this.policy.delay(policy.retryDelayMs, gate.signal);
    } catch {
      return 'stop';
    }
    return 'continue';
  }
}
