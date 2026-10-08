import { canonicalizeJson } from '../journal/index.js';
import type { JsonValue } from '../journal/index.js';
import { toJson } from '../context/artifacts.js';
import { validateProviderParameters } from '../context/parameters.js';
import type { ChatMessage, RequestPlan, ToolSchema } from '../context/contracts.js';

/**
 * The sole owner of wire serialization (kernel.md §4).
 *
 * `serializeWire` turns a plan into the one canonical UTF-8 byte string the
 * adapter sends: a generic non-streaming OpenAI request with `stream: false`
 * and `n: 1`. It emits only valid OpenAI message keys — an assistant's
 * `tool_calls` is omitted entirely when empty and emitted in full otherwise,
 * while `content: null` and `tool_call_id` are preserved. It never mutates the
 * plan. Permitted parameters are the shared `validateProviderParameters`
 * contract (`temperature`, `top_p`, `max_tokens`, `stop` and their exact
 * bounds); every other key, in particular any
 * `model`/`messages`/`tools`/`stream`/`n`/HTTP/auth/header/endpoint override, is
 * refused by that same validator, so a configuration that was accepted can
 * always be sent.
 *
 * `canonicalMessagesBytes` is the shared message encoder: it produces the
 * canonical bytes of a message array *exactly* as `serializeWire` encodes the
 * messages it embeds, so T8 (compaction) compares message arrays without ever
 * re-implementing the encoder.
 */

function refuse(message: string): never {
  throw new Error(`serializeWire: refusing ${message}`);
}

function encodeParameters(
  parameters: { readonly [key: string]: JsonValue },
): Record<string, JsonValue> {
  try {
    return { ...validateProviderParameters(parameters) };
  } catch (err) {
    return refuse(err instanceof Error ? err.message : 'invalid parameters');
  }
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
