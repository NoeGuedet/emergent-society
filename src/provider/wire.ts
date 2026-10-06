import { canonicalizeJson } from '../journal/index.js';
import type { JsonValue } from '../journal/index.js';
import { toJson } from '../context/artifacts.js';
import type { ChatMessage, RequestPlan, ToolSchema } from '../context/contracts.js';

/**
 * The sole owner of wire serialization (kernel.md §4).
 *
 * `serializeWire` turns a plan into the one canonical UTF-8 byte string the
 * adapter sends: a generic non-streaming OpenAI request with `stream: false`
 * and `n: 1`. It emits only valid OpenAI message keys — an assistant's
 * `tool_calls` is omitted entirely when empty and emitted in full otherwise,
 * while `content: null` and `tool_call_id` are preserved. It never mutates the
 * plan. Permitted parameters are `temperature` (finite 0..2), `top_p` (finite
 * 0..1), `max_tokens` (positive safe integer) and `stop` (a string or one to
 * four strings); every other key, in particular any `model`/`messages`/`tools`/
 * `stream`/`n`/HTTP/auth/header/endpoint override, is refused.
 *
 * `canonicalMessagesBytes` is the shared message encoder: it produces the
 * canonical bytes of a message array *exactly* as `serializeWire` encodes the
 * messages it embeds, so T8 (compaction) compares message arrays without ever
 * re-implementing the encoder.
 */

const PERMITTED_PARAMETERS: ReadonlySet<string> =
  new Set(['temperature', 'top_p', 'max_tokens', 'stop']);

function refuse(message: string): never {
  throw new Error(`serializeWire: refusing ${message}`);
}

function finiteRange(value: JsonValue, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    refuse(`${key}: expected a finite number in [${min}, ${max}]`);
  }
  return value;
}

function positiveSafeInt(value: JsonValue, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    refuse(`${key}: expected a positive safe integer`);
  }
  return value;
}

function stopValue(value: JsonValue, key: string): JsonValue {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length >= 1 && value.length <= 4
    && value.every((item): item is string => typeof item === 'string')) {
    return value;
  }
  refuse(`${key}: expected a string or one to four strings`);
}

function encodeParameters(
  parameters: { readonly [key: string]: JsonValue },
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (!PERMITTED_PARAMETERS.has(key)) {
      refuse(`unsupported parameter ${JSON.stringify(key)}`);
    }
    switch (key) {
      case 'temperature': out[key] = finiteRange(value, key, 0, 2); break;
      case 'top_p': out[key] = finiteRange(value, key, 0, 1); break;
      case 'max_tokens': out[key] = positiveSafeInt(value, key); break;
      case 'stop': out[key] = stopValue(value, key); break;
      default: refuse(`unsupported parameter ${JSON.stringify(key)}`);
    }
  }
  return out;
}

/** The one message encoder: valid OpenAI keys only, `tool_calls` omitted when empty. */
function encodeMessage(message: ChatMessage): Record<string, JsonValue> {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'tool':
      return { role: 'tool', content: message.content, tool_call_id: message.tool_call_id };
    case 'assistant': {
      const encoded: Record<string, JsonValue> = { role: 'assistant', content: message.content };
      if (message.tool_calls.length > 0) {
        encoded['tool_calls'] = message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments },
        }));
      }
      return encoded;
    }
  }
}

function encodeTool(tool: ToolSchema): JsonValue {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

/** The canonical UTF-8 bytes of a message array, identical to the wire's own encoding. */
export function canonicalMessagesBytes(messages: readonly ChatMessage[]): Uint8Array {
  return Buffer.from(canonicalizeJson(toJson(messages.map(encodeMessage))), 'utf8');
}

/** The canonical UTF-8 wire bytes of a plan. Pure: it never mutates the plan. */
export function serializeWire(plan: RequestPlan): Uint8Array {
  const messages: JsonValue[] = [
    { role: 'system', content: plan.charter },
    { role: 'system', content: plan.heading },
    ...plan.history.map(encodeMessage),
    ...plan.queue.map(encodeMessage),
  ];
  const wire: Record<string, JsonValue> = {
    model: plan.model,
    ...encodeParameters(plan.parameters),
    tools: plan.tools.map(encodeTool),
    messages,
    stream: false,
    n: 1,
  };
  return Buffer.from(canonicalizeJson(toJson(wire)), 'utf8');
}
