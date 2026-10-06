import { Buffer } from 'node:buffer';
import { toJson } from '../context/artifacts.js';
import { serializeWire } from './wire.js';
import { normalizeUsage } from './usage.js';
import type { BoundaryGate } from '../node/gate.js';
import type {
  ArtifactRef, AssistantProjection, ChatMessage, FunctionCall, RequestId, RequestPlan,
  SafeFailure,
} from '../context/contracts.js';
import type { SerializedTransport, TransportResult } from './transport.js';

/**
 * The provider adapter (T6, kernel.md §4).
 *
 * It owns the exact, bounded request path: store the immutable plan and record
 * `request/plan` once, serialize the single wire, capture and journal the wire,
 * then POST those exact bytes. The raw provider body is captured and journaled
 * (and flushed) *before* any UTF-8 validation, decoding, parsing, usage, assistant
 * or tool work, so a malformed or unprojectable body is a safe terminal failure
 * after the raw fact is durable — never a fatal kernel error. A flush/invariant
 * failure raised while journaling the raw response, an attempt or the projection
 * is rethrown fatally and is never converted into a `SendResult.failure`.
 *
 * Retries are bounded by the plan's persisted policy and cover only network/
 * timeout or HTTP 408/429/500/502/503/504; a retry reuses the same body artifact
 * and bytes with an incremented attempt — it never reserializes. The timeout is
 * armed with the injected `schedule` and cleared in `finally`; an already-aborted
 * signal prevents any send, and a stop during the body or the delay yields a
 * terminal cancellation with no later send.
 */

export type ProviderPolicy = {
  readonly now: () => number;
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly schedule: (ms: number, callback: () => void) => () => void;
};

export type SendResult = { readonly kind: 'response'; readonly projection: AssistantProjection }
  | { readonly kind: 'failure'; readonly failure: SafeFailure };

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

type Projected = { readonly message: AssistantMessage; readonly usageRaw: unknown };

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
    usageRaw: parsed['usage'],
  };
}

export class ProviderAdapter {
  constructor(
    private readonly transport: SerializedTransport,
    private readonly policy: ProviderPolicy,
  ) {}

  async send(plan: RequestPlan, gate: BoundaryGate): Promise<SendResult> {
    const id = plan.id;
    const policy = plan.policy;

    // 1. Store the immutable plan, record `request/plan` once, serialize once.
    //    The runtime owns the 32 MiB capture-ceiling refusal before `gate.store`;
    //    here a wire above the persisted `maxRequestBytes` is refused terminally
    //    with a durable attempt and no send.
    const storedPlan = await gate.store(plan);
    gate.append('request/plan', { id, value: storedPlan });
    const body = serializeWire(plan);
    if (body.length > policy.maxRequestBytes) {
      return this.fail(gate, id, 0, { code: 'request-limit', status: null });
    }

    const bodyRef = await gate.capture(body, 'utf8');
    gate.append('request/wire', { id, attempt: 0, body: bodyRef });
    await gate.flush();

    let attempt = 0;
    for (;;) {
      // An already-aborted signal prevents any send (a stop/park never sends).
      if (gate.signal.aborted) {
        return this.fail(gate, id, attempt, { code: 'cancelled', status: null });
      }

      const posted = await this.post(body, policy, gate);
      const result = posted.result;

      if (result.status === null) {
        // No status: journal the attempt only (no raw body was received).
        const failure = this.classifyNoStatus(result, posted.timedOut, gate);
        const retryable = failure.code === 'network' || failure.code === 'timeout';
        const next = await this.maybeRetry(gate, id, attempt, failure, retryable, policy, bodyRef);
        if (next === 'continue') { attempt += 1; continue; }
        if (gate.signal.aborted) return this.fail(gate, id, attempt, { code: 'cancelled', status: null });
        return this.fail(gate, id, attempt, failure);
      }

      // Status known: capture the complete raw body or the partial prefix, append
      // `response/raw` and flush BEFORE any decode/parse/usage/assistant work.
      const rawRef = await gate.capture(result.body, 'binary', result.complete);
      gate.append('response/raw', {
        id, attempt, status: result.status, body: rawRef, complete: result.complete,
      });
      await gate.flush();

      let failure: SafeFailure;
      let retryable: boolean;
      if (!result.complete) {
        failure = result.failure ?? { code: 'network', status: result.status };
        retryable = failure.code === 'network' || failure.code === 'timeout';
      } else if (result.status !== 200) {
        failure = { code: 'http', status: result.status };
        retryable = RETRYABLE_STATUS.has(result.status);
      } else {
        let projected: Projected;
        try {
          projected = project(result.body, plan);
        } catch {
          // A body that parses but cannot be projected is a safe terminal
          // failure after the raw fact is durable — never a fatal kernel error.
          return this.fail(gate, id, attempt, { code: 'malformed', status: result.status });
        }
        const projection: AssistantProjection = {
          message: projected.message, contentTruncated: false, raw: rawRef,
        };
        gate.append('request/usage', { id, attempt, value: normalizeUsage(projected.usageRaw) });
        gate.append('assistant/message', { id, value: await gate.store(projection) });
        await gate.flush();
        return { kind: 'response', projection };
      }

      const next = await this.maybeRetry(gate, id, attempt, failure, retryable, policy, bodyRef);
      if (next === 'continue') { attempt += 1; continue; }
      if (gate.signal.aborted) return this.fail(gate, id, attempt, { code: 'cancelled', status: null });
      return this.fail(gate, id, attempt, failure);
    }
  }

  /**
   * One bounded POST. The timeout timer and the gate-abort listener are always
   * removed in `finally`; a transport throw becomes a safe network result and the
   * arbitrary Error is never stringified into any event. `timedOut` reports only
   * whether the adapter's own timer fired, so it can be told apart from a stop.
   */
  private async post(
    body: Uint8Array, policy: RequestPlan['policy'], gate: BoundaryGate,
  ): Promise<{ readonly result: TransportResult; readonly timedOut: boolean }> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => { controller.abort(); };
    gate.signal.addEventListener('abort', onAbort, { once: true });
    const clearTimer = this.policy.schedule(policy.requestTimeoutMs, () => {
      timedOut = true;
      controller.abort();
    });
    try {
      const result = await this.transport.post(body, controller.signal, policy.maxCaptureBytes);
      return { result, timedOut };
    } catch {
      return {
        result: {
          status: null, body: new Uint8Array(), complete: false,
          failure: { code: 'network', status: null },
        },
        timedOut,
      };
    } finally {
      clearTimer();
      gate.signal.removeEventListener('abort', onAbort);
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
   * Journals a non-terminal attempt, waits the fixed cancellable delay, and
   * appends the next wire (the same retained body artifact and bytes). Returns
   * 'continue' to retry or 'stop' when no retry is allowed. A cancelled delay
   * returns 'stop' without a later send; the caller journals the terminal result.
   */
  private async maybeRetry(
    gate: BoundaryGate, id: RequestId, attempt: number, failure: SafeFailure,
    retryable: boolean, policy: RequestPlan['policy'], bodyRef: ArtifactRef,
  ): Promise<'continue' | 'stop'> {
    if (!retryable || attempt + 1 >= policy.maxAttempts) return 'stop';
    gate.append('assistant/attempt', { id, attempt, failure, terminal: false });
    await gate.flush();
    try {
      await this.policy.delay(policy.retryDelayMs, gate.signal);
    } catch {
      return 'stop';
    }
    if (gate.signal.aborted) return 'stop';
    gate.append('request/wire', { id, attempt: attempt + 1, body: bodyRef });
    await gate.flush();
    return 'continue';
  }

  /** Journals the terminal attempt and flush, then returns a failure result. */
  private async fail(
    gate: BoundaryGate, id: RequestId, attempt: number, failure: SafeFailure,
  ): Promise<SendResult> {
    gate.append('assistant/attempt', { id, attempt, failure, terminal: true });
    await gate.flush();
    return { kind: 'failure', failure };
  }
}
