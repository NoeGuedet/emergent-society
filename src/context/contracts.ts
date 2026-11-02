import type { JsonValue } from '../journal/index.js';
import type { CallId, FrontierErrorCode } from '../frontier/index.js';
import type { RecordedCommit, WorldRange } from '../node/world.js';

/**
 * The shared JSON contracts of the C1.3 context assembler (kernel.md §4).
 *
 * These are `type` aliases, not interfaces: every payload that is journaled must
 * satisfy the envelope's `EventEnvelope<T extends JsonValue>` constraint, and
 * only the alias form is assignable to `JsonValue`'s index signature. `Readonly`
 * here describes ownership, not serialization — `toJson` performs the validated
 * deep copy and freeze; the arrays stay ordinary (mutable) array types because
 * `JsonValue` admits mutable arrays.
 *
 * Numbers used as counts, seqs, versions, indexes or byte lengths are nonnegative
 * safe integers; that rule is enforced by the runtime validators, not the types.
 */

/** A verified receipt identity: the journal identity of a recorded event. */
export type Source = { readonly seq: number; readonly hash: string };

/** The logical identity of one model request within a turn. */
export type RequestId = { readonly turn: number; readonly ordinal: number };

export type FunctionCall = {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
};

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant'; readonly content: string | null;
      readonly tool_calls: FunctionCall[];
    }
  | { readonly role: 'tool'; readonly content: string; readonly tool_call_id: string };

export type ToolSchema = {
  readonly name: string; readonly description: string; readonly parameters: JsonValue;
};

/**
 * One declared model of the operator's catalog (`providers.json`'s `llm.models`).
 * TWO shapes are accepted at load (A3):
 *
 * - the old ids-only form, `"id"` — an id with NO window declared: the
 *   transition form, accepted at load and usable where a window is not needed
 *   (the substrate block, `inspect`, spawn/`update_self` validation). A fresh
 *   START on such an entry is refused (the bounded window refusal) and a cell
 *   that reaches one keeps the byte trigger with a bounded host diagnostic.
 * - the new object form, `{id, contextTokens, maxOutputTokens}` — BOTH fields
 *   required, together or not at all (no family-default table exists anywhere;
 *   DSH's 256k is DeepSeek-specific). The window is a HOST fact: it selects the
 *   token trigger's threshold and never rides the wire (the substrate block
 *   stays ids-only, so the cached prefix does not grow).
 *
 * The type spells the window fields optional because the two shapes normalize
 * into one entry; the store's loader enforces both-or-neither and the
 * declaration's domain (positive safe integers at or below the context cap,
 * `maxOutputTokens < contextTokens`, no degenerate window).
 */
export type LlmModel = {
  readonly id: string;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
};

/** A declared entry's window, present only when the entry declares one. */
export type LlmModelWindow = {
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
};

/** A durable artifact reference: canonical journal data, never a journal `BlobRef`. */
export type ArtifactRef = {
  readonly kind: 'c13-artifact'; readonly manifest: Source;
  readonly sha256: string; readonly bytes: number;
  readonly encoding: 'utf8' | 'binary'; readonly complete: boolean;
};

/** A value that is either inline JSON or captured as an artifact. */
export type Stored<T> = { readonly kind: 'inline'; readonly value: T }
  | { readonly kind: 'artifact-json'; readonly ref: ArtifactRef };

export type ArtifactChunk = {
  readonly artifact: string; readonly index: number; readonly base64: string;
};

export type ArtifactManifest = {
  readonly artifact: string; readonly sha256: string; readonly bytes: number;
  readonly encoding: 'utf8' | 'binary'; readonly complete: boolean;
  readonly parts: Source[];
};

export type ErrorCode = 'http' | 'network' | 'timeout' | 'cancelled'
  | 'malformed' | 'body-limit' | 'invalid-tool' | 'unknown-tool' | 'denied'
  | 'spawn' | 'signal' | 'output-limit' | 'request-limit' | 'context-exceeded';

export type SafeFailure = { readonly code: ErrorCode; readonly status: number | null };

/**
 * Maps a `SafeFailure` to the frontier terminal's error code. Only the wire
 * codes can describe an exchange: `malformed` (a 200 whose projection fails) and
 * `request-limit` (the kernel refuses the request before any send) never reach a
 * terminal, so mapping one is a programmer error and throws instead of
 * inventing a code. `context-exceeded` is the provider's own window refusal: the
 * frontier's vocabularies are frozen with v0 and admit no new code, so the
 * exchange is recorded as the HTTP exchange it was — the typed local code rides
 * the local turn only.
 *
 * The two producers that cross the frontier — the provider adapter
 * (`src/provider/adapter.ts`) and the web tools (`src/node/tools/web.ts`) —
 * share this one narrowing rather than each keeping its own: a failure the
 * frontier vocabulary cannot name is a programmer error for both, and one table
 * means neither can invent a code the other would refuse.
 */
export function toFrontierCode(failure: SafeFailure): FrontierErrorCode {
  switch (failure.code) {
    case 'http':
    case 'network':
    case 'timeout':
    case 'cancelled':
    case 'body-limit':
      return failure.code;
    case 'context-exceeded':
      return 'http';
    default:
      throw new Error(`no frontier code for failure ${JSON.stringify(failure.code)}`);
  }
}

/**
 * The token trigger's journaled rule (A4): the window fraction the trigger
 * fires at and the headroom clamp. All integers, in the policy's own dialect —
 * permille fractions never carry a float into the journal. The window itself is
 * NOT here: it is a host fact (the operator's catalog), re-resolved at each
 * request, never journaled in a config.
 */
export type TokenTriggerPolicy = {
  /** The window fraction in permille: the ratio term is `floor(W · ratioPermille / 1000)`. */
  readonly ratioPermille: number;
  /** The headroom clamp: `clamp(floor(W · ratioPermille / 1000), minTokens, maxTokens)`. */
  readonly headroom: {
    readonly ratioPermille: number;
    readonly minTokens: number;
    readonly maxTokens: number;
  };
};

/** The recorded runtime policy; every numeric limit is the effective one, expanded before journaling. */
export type SeedPolicy = {
  readonly stepsPerTurn: number; readonly compactAfterBytes: number;
  readonly keepRecentGroups: number; readonly maxAttempts: number;
  readonly retryDelayMs: number; readonly requestTimeoutMs: number;
  readonly shellTimeoutMs: number; readonly killGraceMs: number;
  readonly maxCaptureBytes: number; readonly maxRequestBytes: number;
  readonly maxShellCaptureBytes: number;
  readonly maxDiffBytes: number; readonly maxCommits: number;
  readonly maxAssistantBytes: number;
  readonly maxToolResultBytes: number; readonly maxToolArgumentBytes: number;
  readonly maxCallsPerResponse: number;
  /**
   * The timer-wake budget: at most this many proactive wakes in a sliding hour.
   * Optional because a config journaled before the timer existed has no such
   * key; absent reads as the factory default (`12`), never as a rewrite.
   */
  readonly wakeBudgetPerHour?: number;
  /**
   * The token trigger (A4). Optional: a config journaled before the token wave
   * has no such key and keeps the byte trigger forever, while a factory config
   * carries it. The token branch runs only when this key AND a resolved window
   * exist; a key-present/windowless cell stays on the byte trigger.
   */
  readonly compactAfterTokens?: TokenTriggerPolicy;
};

export type AgentConfig = {
  readonly version: number; readonly charter: string; readonly heading: string;
  readonly tools: ToolSchema[]; readonly allowedTools: string[];
  readonly model: string; readonly parameters: { readonly [key: string]: JsonValue };
  readonly policy: SeedPolicy;
};

export type SurfaceGroup = {
  readonly id: Source;
  readonly kind: 'heading' | 'perception' | 'dialogue' | 'summary' | 'package' | 'refusal';
  readonly turn: number; readonly messages: ChatMessage[];
  readonly sources: Source[];
};

export type SurfaceNode = {
  readonly position: number; readonly group: SurfaceGroup;
};

export type SurfaceSnapshot = {
  readonly heading: { readonly text: string; readonly source: Source };
  readonly nodes: SurfaceNode[];
  readonly revision: string;
};

export type OpenTurn = {
  readonly start: Source; readonly turn: number; readonly world: WorldRange;
  readonly perception: SurfaceGroup | null; readonly perceptionConsumed: boolean;
  readonly messages: ChatMessage[]; readonly sources: Source[];
};

export type RecoveryGroup = {
  readonly turn: number; readonly request: RequestId;
  readonly assistant: Extract<ChatMessage, { role: 'assistant' }>;
  readonly sources: Source[];
  readonly results: Extract<ChatMessage, { role: 'tool' }>[];
  readonly missing: FunctionCall[];
};

export type ProjectionState = {
  readonly config: { readonly value: AgentConfig; readonly source: Source } | null;
  readonly surface: SurfaceSnapshot | null;
  readonly open: OpenTurn | null;
  readonly recovery: RecoveryGroup[];
  readonly watermark: Source | null;
  readonly pendingCompactions: CompactionStart[];
};

export type PlanSection = {
  readonly name: 'tools' | 'charter' | 'heading' | 'substrate' | 'history' | 'queue';
  readonly cache: 'stable' | 'advance' | 'volatile';
  readonly sources: Source[];
};

export type RequestPlan = {
  readonly id: RequestId; readonly config: Source; readonly stateHash: string;
  readonly model: string; readonly parameters: { readonly [key: string]: JsonValue };
  readonly policy: SeedPolicy;
  readonly tools: ToolSchema[]; readonly toolsHash: string;
  readonly sections: PlanSection[];
  readonly history: ChatMessage[]; readonly queue: ChatMessage[];
  readonly charter: string; readonly heading: string;
  /**
   * The kernel-owned substrate block: the operator-declared served models,
   * rendered as its own system message immediately after the heading block.
   * Present only when the store declares a catalog — absent means no block and
   * today's plan. It is a host fact, not a projection of the journal: its
   * section carries `sources: []` and no receipt, and it never rides inside
   * the charter or heading text.
   */
  readonly substrate?: string;
};

export type AssistantProjection = {
  readonly message: Extract<ChatMessage, { role: 'assistant' }>;
  readonly contentTruncated: boolean;
  /** The successful frontier call that produced this message; never null here. */
  readonly frontierCall: CallId;
};

export type CompactionStart = {
  readonly id: string; readonly revision: string;
  readonly groupIds: Source[]; readonly sources: Source[];
  readonly shadowHash: string; readonly shadowBytes: number;
};

export type CompactionSummary = {
  readonly id: string;
  readonly message: Extract<ChatMessage, { role: 'user' }>;
  readonly sources: Source[]; readonly replacementBytes: number;
};

export type CompactionEnd = { readonly id: string; readonly summary: Source };

export type CompactionAbort = { readonly id: string; readonly reason: 'stale' | 'orphan' };

/**
 * One provider-reported usage, normalized from the OpenAI-compatible body
 * (A2(iii)): `total = prompt + completion`, and `promptTokens` ALREADY includes
 * the cached subset — `cachedTokens` is informational and is never added (a
 * prompt+cache+completion sum would double-count). Every number is a
 * non-negative safe integer; a usage that cannot be normalized is absent, never
 * a broken turn.
 */
export type MeterUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** The cached subset of `promptTokens`, informational only; null when not reported. */
  readonly cachedTokens: number | null;
};

/**
 * The anchor's sample (A2(ii), A7): the identity the adoption test is gated on
 * (the request header: model + parameters + toolsHash), the surface price AFTER
 * the sampled completion is appended (so the delta never counts the completion
 * twice), and the usage that answers it. The three journal TOGETHER as the
 * optional field on `assistant/message`, so the anchor re-forms exactly after a
 * restart from the fold. Not a price, not a cost: tokens only.
 */
export type AssistantAccounting = {
  readonly headerDigest: string;
  readonly surfacePriceAtSample: number;
  readonly usage: MeterUsage;
};

/**
 * The kernel-owned decision numbers of one token-triggered compaction, journaled
 * as the optional `meter` payload on `compaction/start` (A7). The window and the
 * output reservation are host facts copied into the record — a store edit
 * between boots changes the next decision, never this one — and `outcome` is
 * the PLANNED outcome; the transaction's own summary/end records the actual one.
 */
export type MeterRecord = {
  /** The declared context window the decision used. */
  readonly window: number;
  /** The output reservation `O` (the parameters' `max_tokens`, else the declared output). */
  readonly output: number;
  /** The headroom the threshold subtracted. */
  readonly headroom: number;
  /** `floor(min(ratio · W, W − O − headroom))`. */
  readonly threshold: number;
  /** The EFFECTIVE percent (operator-side): `threshold / W`, one decimal. */
  readonly percent: number;
  /** The priced request's total the trigger read. */
  readonly estimate: number;
  /** Which baseline the total's anchor supplied. */
  readonly anchor: 'usage' | 'estimate';
  /** The planned outcome of this decision; the actual one is the transaction's end. */
  readonly outcome: 'compact';
};

/**
 * One opening world perception (T4): the bounded commit list and rendered diff
 * a turn presents, plus the renderer identity that makes a re-render byte-exact
 * for the recorded Git version. Imported by the fold and the runtime.
 */
/** The accepted perception renderer policies, spelled once; v1 is the pre-friction-pass-2 oldest-first budgeting. */
export const RENDER_POLICIES = ['commit-patches-v1', 'commit-patches-v2'] as const;

/** One accepted renderer policy. */
export type RenderPolicy = typeof RENDER_POLICIES[number];

export type WorldPerception = {
  readonly uid: string; readonly range: WorldRange;
  readonly effectiveFrom: string | null;
  readonly fallback: 'none' | 'unreachable-from';
  readonly renderer: {
    readonly policy: RenderPolicy;
    /** Exact trimmed stdout of `git --version`; replay fails on any difference. */
    readonly gitVersion: string;
    readonly attrSource: 'to';
  };
  readonly maxBytes: number; readonly maxCommits: number;
  readonly listTruncated: boolean;
  /** Selected bounded commit list (metadata), independent of what text was rendered. */
  readonly commits: RecordedCommit[];
  /** Commits whose header+patch, or a patch prefix, appears in `text`. */
  readonly included: string[];
  /** All own selected commits, even when only the aggregate notice covers them. */
  readonly omittedOwn: string[];
  readonly text: string; readonly truncated: boolean;
};
