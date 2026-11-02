import { Buffer } from 'node:buffer';
import { sha256HexOf } from '../journal/index.js';
import type { JsonValue } from '../journal/index.js';
import { encodeWireTools } from '../provider/wire.js';
import type { WirePlan } from '../provider/wire.js';
import { canonicalBytes } from './artifacts.js';
import type {
  AssistantAccounting, ChatMessage, MeterUsage, TokenTriggerPolicy, ToolSchema,
} from './contracts.js';

/**
 * The token meter (A1/A2/A4): the estimator's exact arithmetic, priced over THE
 * WIRE'S OWN COMPOSITION, plus the request-header identity the anchor is gated
 * on and the threshold formula the trigger publishes.
 *
 * THE ESTIMATOR (A2(i)) is the DSH rule, arithmetic for arithmetic:
 * `ceil(chars/4)` of the visible text, `+4` per role, `+4` per non-system block,
 * the system prompt `ceil(chars/4)+4` WITHOUT the block overhead (DSH serializes
 * it as a plain string), and the tools `ceil(JSON.stringify(wireTools).length/4)
 * +4` where `wireTools` is the wire's WRAPPED array (`{type:'function', …}` —
 * pricing the raw schemas undercounts). The arithmetic is taken from
 * `@deepseek-ai/dsh-token-meter`'s `estimate.ts` (CHARS_PER_TOKEN = 4,
 * BLOCK_OVERHEAD = 4, the +4s inline), translated to this wire's message
 * shapes: a tool call prices `ceil(name/4) + ceil(arguments/4) + 4` as DSH's
 * tool-call content block does (the call id is wire structure DSH does not
 * price either).
 *
 * THE INPUT IS THE WIRE (the negative pin): every price here is a function of
 * the plan's `charter`/`heading`/`substrate`/`history`/`queue`/`tools` — never
 * of `canonicalBytes(plan)`, which carries sections, receipts and the state hash
 * the wire does not send. Pricing the canonical plan would break the anchor's
 * adoption condition and falsify the published percent.
 *
 * THE ANCHOR (A2(ii)): the identity is the request HEADER (`model` +
 * `parameters` + `toolsHash`) — never the envelope, so a growing history still
 * matches. `meterTotal` adopts the provider's usage iff the header matches AND
 * the usage covers the estimate of the sampled call, and adds the surface delta;
 * otherwise the estimate stands wholesale. The sample point is defined by the
 * caller (`1` + `2` below): `surfacePriceAtSample` is the full wire price AFTER
 * the sampled completion is appended, so the delta never counts it twice.
 *
 * THE THRESHOLD (A4): `floor(min(ratio·W, W − O − headroom))`, `headroom =
 * clamp(headroomRatio·W, min, max)`, `O = parameters.max_tokens ??
 * catalog.maxOutputTokens ?? 0`. The EFFECTIVE percent is a published,
 * operator-side number, never a node-visible one.
 *
 * Residuals, stated: chars/4 underprices CJK and dense JSON (DSH's own
 * admission; the headroom absorbs it, the overflow slice mitigates the
 * livelock); the provider's usage is untrusted (range-checked where it is
 * parsed); the non-OpenAI dialect is unreachable on this wire (A2(v)).
 */

/** The fixed text density: one token per four characters (DSH's CHARS_PER_TOKEN). */
export const METER_CHARS_PER_TOKEN = 4;

/** The structural overhead per role and per non-system block (DSH's inline +4). */
export const METER_BLOCK_OVERHEAD = 4;

/**
 * The structural ceiling on a declared window: the estimator's own operational
 * domain. A declaration above it is refused, and a usage above it can only be a
 * misreport (it flattens to absent).
 */
export const MAX_MODEL_CONTEXT_TOKENS = 4_194_304;

/**
 * The factory's token trigger (the deviation from DSH's flat 64,000-token
 * headroom, named): 80% of the window and `clamp(5%·W, 16,000, 64,000)`. In
 * policy dialect — permille fractions, integer tokens — so no float enters a
 * journal. The published table follows: 1M/256k → 694,000 (69.4%),
 * 200k/32k → 152,000 (76%).
 */
export const DEFAULT_TOKEN_TRIGGER: TokenTriggerPolicy = {
  ratioPermille: 800,
  headroom: { ratioPermille: 50, minTokens: 16_000, maxTokens: 64_000 },
};

/** The declared headroom for a window, in the rule's own permille clamp. */
export function meterHeadroom(window: number, rule: TokenTriggerPolicy): number {
  const scaled = Math.floor((window * rule.headroom.ratioPermille) / 1000);
  return Math.min(Math.max(scaled, rule.headroom.minTokens), rule.headroom.maxTokens);
}

/**
 * The window fraction the trigger fires at: `floor(min(ratio·W, W − O −
 * headroom))`. Both ratio terms are floors of integers, so the outer floor is
 * the ratio term's alone. A non-positive result is a degenerate reservation the
 * caller refuses before any decision (the declaration refuses the equivalent
 * declared band).
 */
export function meterThreshold(
  window: number, output: number, rule: TokenTriggerPolicy,
): number {
  const ratio = Math.floor((window * rule.ratioPermille) / 1000);
  return Math.min(ratio, window - output - meterHeadroom(window, rule));
}

/**
 * The trigger's own comparison (A4): the priced request EXCEEDS the threshold —
 * strictly. The threshold is a floor, so "at the threshold" is still inside the
 * window's room and does not fire.
 */
export function meterFires(total: number, threshold: number): boolean {
  return total > threshold;
}

/** The EFFECTIVE percent the decision publishes operator-side, to one decimal. */
export function meterPercent(window: number, threshold: number): number {
  if (window <= 0) return 0;
  return Math.round((threshold / window) * 1000) / 10;
}

function tokensFor(chars: number): number {
  return Math.ceil(chars / METER_CHARS_PER_TOKEN);
}

/**
 * The rendered system prompt: text density plus role framing, no per-block
 * overhead (DSH prices a system message exactly so). An empty block is 0, the
 * "no system prompt" case.
 */
export function priceSystemText(text: string): number {
  return text.length === 0 ? 0 : tokensFor(text.length) + METER_BLOCK_OVERHEAD;
}

/** One model-visible message, in the wire's own shapes. */
export function priceMessage(message: ChatMessage): number {
  switch (message.role) {
    case 'system':
      return priceSystemText(message.content);
    case 'user':
    case 'tool':
      // One text block (+4) plus role framing (+4).
      return tokensFor(message.content.length) + METER_BLOCK_OVERHEAD + METER_BLOCK_OVERHEAD;
    case 'assistant': {
      let tokens = METER_BLOCK_OVERHEAD;
      if (message.content !== null) tokens += tokensFor(message.content.length) + METER_BLOCK_OVERHEAD;
      for (const call of message.tool_calls) {
        tokens += tokensFor(call.function.name.length)
          + tokensFor(call.function.arguments.length) + METER_BLOCK_OVERHEAD;
      }
      return tokens;
    }
  }
}

/** A message array's price. */
export function priceMessages(messages: readonly ChatMessage[]): number {
  let tokens = 0;
  for (const message of messages) tokens += priceMessage(message);
  return tokens;
}

/** The tools' price: the WIRE'S WRAPPED array, never the raw schemas. */
export function priceTools(tools: readonly ToolSchema[]): number {
  if (tools.length === 0) return 0;
  return tokensFor(JSON.stringify(encodeWireTools(tools)).length) + METER_BLOCK_OVERHEAD;
}

/** The parts of a plan the meter prices — exactly what the wire serializes. */
export type WirePriceInput =
  Pick<WirePlan, 'charter' | 'heading' | 'substrate' | 'history' | 'queue' | 'tools'>;

/** The full wire price of the composition: the three system blocks, the messages, the tools. */
export function priceWire(plan: WirePriceInput): number {
  let tokens = priceSystemText(plan.charter) + priceSystemText(plan.heading);
  if (plan.substrate !== undefined) tokens += priceSystemText(plan.substrate);
  return tokens + priceMessages(plan.history) + priceMessages(plan.queue)
    + priceTools(plan.tools);
}

/** The request fields the anchor's identity covers — the header, never the envelope. */
export type MeterHeaderInput = Pick<WirePlan, 'model' | 'parameters' | 'tools'>;

/**
 * The request-header digest: `model` + `parameters` + the tools hash, the exact
 * triple DSH's canonical header equality covers. It is recomputable at the plan
 * site and at the journal point from the same plan, and it deliberately ignores
 * the history: a growing conversation must still match its own anchor.
 */
export function headerDigest(header: MeterHeaderInput): string {
  const toolsHash = sha256HexOf(Buffer.from(canonicalBytes(header.tools)));
  const value: JsonValue = {
    model: header.model,
    parameters: header.parameters,
    toolsHash,
  };
  return sha256HexOf(Buffer.from(canonicalBytes(value)));
}

/** The plan's sample price: the full wire price with the completion appended at the sample point. */
export function surfacePriceAtSample(
  plan: WirePriceInput, assistant: ChatMessage,
): number {
  return priceWire(plan) + priceMessage(assistant);
}

/** The anchor's answer for one request. */
export type MeterTotal = {
  readonly total: number;
  readonly kind: 'usage' | 'estimate';
};

/**
 * The anchor's adoption rule (A2(ii)), pure: with a header-equal anchor whose
 * usage covers the sampled estimate, `total = usage + (current surface − sampled
 * surface)`; otherwise the estimate stands wholesale (the current request's own
 * full wire price — the under-report branch reduces to exactly that when the
 * header matched, which is why the rule is one comparison plus one delta).
 */
export function meterTotal(input: {
  readonly headerDigest: string;
  readonly surfacePrice: number;
  readonly anchor: AssistantAccounting | null;
}): MeterTotal {
  const anchor = input.anchor;
  if (anchor !== null && anchor.headerDigest === input.headerDigest
    && anchor.usage.totalTokens >= anchor.surfacePriceAtSample) {
    const total = anchor.usage.totalTokens
      + (input.surfacePrice - anchor.surfacePriceAtSample);
    return { total: Math.max(0, total), kind: 'usage' };
  }
  return { total: Math.max(0, input.surfacePrice), kind: 'estimate' };
}

/** A usage above the declared window is a misreport: it flattens to absent (A2(iii)). */
export function usageWithinWindow(
  usage: MeterUsage | null, window: number | undefined,
): MeterUsage | null {
  if (usage === null) return null;
  if (usage.totalTokens > (window ?? MAX_MODEL_CONTEXT_TOKENS)) return null;
  return usage;
}
