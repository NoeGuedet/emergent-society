import type { JsonValue } from '../journal/index.js';
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
  | 'spawn' | 'signal' | 'output-limit' | 'request-limit';

export type SafeFailure = { readonly code: ErrorCode; readonly status: number | null };

/** The recorded runtime policy; every numeric limit is the effective one, expanded before journaling. */
export type SeedPolicy = {
  readonly stepsPerTurn: number; readonly compactAfterBytes: number;
  readonly keepRecentGroups: number; readonly maxAttempts: number;
  readonly retryDelayMs: number; readonly requestTimeoutMs: number;
  readonly shellTimeoutMs: number; readonly killGraceMs: number;
  readonly maxCaptureBytes: number; readonly maxRequestBytes: number;
  readonly maxShellCaptureBytes: number; readonly shellDrainMs: number;
  readonly maxDiffBytes: number; readonly maxCommits: number;
  readonly maxAssistantBytes: number;
  readonly maxToolResultBytes: number; readonly maxToolArgumentBytes: number;
  readonly maxCallsPerResponse: number;
};

export type AgentConfig = {
  readonly version: number; readonly charter: string; readonly heading: string;
  readonly tools: ToolSchema[]; readonly allowedTools: string[];
  readonly model: string; readonly parameters: { readonly [key: string]: JsonValue };
  readonly policy: SeedPolicy;
};

export type SurfaceGroup = {
  readonly id: Source; readonly kind: 'heading' | 'perception' | 'dialogue' | 'summary';
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
  readonly name: 'tools' | 'charter' | 'heading' | 'history' | 'queue';
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
};

export type CanonicalUsage = {
  readonly inputTotal: number | null; readonly inputUncached: number | null;
  readonly output: number | null; readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
};

export type AssistantProjection = {
  readonly message: Extract<ChatMessage, { role: 'assistant' }>;
  readonly contentTruncated: boolean; readonly raw: ArtifactRef;
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
 * One opening world perception (T4): the bounded commit list and rendered diff
 * a turn presents, plus the renderer identity that makes a re-render byte-exact
 * for the recorded Git version. Imported by the fold and the runtime.
 */
export type WorldPerception = {
  readonly uid: string; readonly range: WorldRange;
  readonly effectiveFrom: string | null;
  readonly fallback: 'none' | 'unreachable-from';
  readonly renderer: {
    readonly policy: 'commit-patches-v1';
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
