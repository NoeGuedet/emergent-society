import type { EventEnvelope } from '../journal/index.js';
import type { GateScope, WorldAcknowledgement } from '../node/gate.js';
import type { WorldRange } from '../node/world.js';
import { resolveArtifact, resolveStored, toJson } from './artifacts.js';
import { validateAgentConfig } from './config.js';
import { createBoundaryRegistry, validateRequestPlan } from './events.js';
import type {
  AgentConfig, ArtifactRef, AssistantProjection, ChatMessage, CompactionStart, CompactionSummary,
  FunctionCall, OpenTurn, ProjectionState, RecoveryGroup, RequestId, RequestPlan, Source, Stored,
  SurfaceGroup, WorldPerception,
} from './contracts.js';
import type { VerifiedEvent, VerifiedEvents } from './loader.js';
import { sourceOf } from './loader.js';
import { Surface } from './surface.js';

/**
 * The incremental fold of the C1.3 context assembler (kernel.md §4).
 *
 * It consumes chain-verified events (`VerifiedEvents`, already digest/size
 * checked by the T1 loader) and rebuilds configuration, the committed surface,
 * the open turn and the interrupted-dialogue recovery set. It performs no I/O,
 * no network and no effect; re-observing an identical `(seq,hash)` is idempotent,
 * a changed hash or a gap is a kernel invariant failure.
 *
 * The boundary gate enforces shape and scope; request sequencing (a plan before
 * a wire, a wire before a response, a call before a result) and the artifact-json
 * inner-value equalities the gate cannot see are the fold's responsibility.
 */

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>;
type ToolMessage = Extract<ChatMessage, { role: 'tool' }>;

const REGISTRY = createBoundaryRegistry();
const SIGNAL = new AbortController().signal;

const SAME = (a: Source, b: Source): boolean => a.seq === b.seq && a.hash === b.hash;
const SAME_ID = (a: RequestId, b: RequestId): boolean =>
  a.turn === b.turn && a.ordinal === b.ordinal;
const rangeEquals = (a: WorldRange, b: WorldRange): boolean => a.from === b.from && a.to === b.to;

function sortUnique(sources: Iterable<Source>): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    const key = `${source.seq}:${source.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  out.sort((a, b) => (a.seq - b.seq) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return out;
}

function invariant(message: string): never {
  throw new Error(`context fold invariant failure: ${message}`);
}

interface ResultEntry {
  readonly message: ToolMessage;
  readonly source: Source;
  readonly synthetic: boolean;
}

interface DialogueBuffer {
  readonly request: RequestId;
  planSource: Source | null;
  refused: boolean;
  wireSeen: boolean;
  firstBodySha: string | null;
  readonly attempts: Set<number>;
  readonly responses: Set<number>;
  assistantSource: Source | null;
  assistant: AssistantMessage | null;
  rawSource: Source | null;
  advertised: FunctionCall[];
  readonly callReceipts: Map<string, Source>;
  readonly results: Map<string, ResultEntry>;
}

interface MutableOpen {
  readonly start: Source;
  readonly turn: number;
  readonly world: WorldRange;
  perceptionGroup: SurfaceGroup | null;
  perceptionSeen: boolean;
  perceptionConsumed: boolean;
  readonly dialogues: Map<string, DialogueBuffer>;
}

interface RecoveryEntry {
  readonly turn: number;
  readonly request: RequestId;
  readonly assistant: AssistantMessage;
  readonly assistantSource: Source;
  readonly rawSource: Source | null;
  readonly advertised: FunctionCall[];
  readonly callReceipts: Map<string, Source>;
  readonly results: Map<string, ResultEntry>;
}

function emptyBuffer(request: RequestId): DialogueBuffer {
  return {
    request, planSource: null, refused: false, wireSeen: false, firstBodySha: null,
    attempts: new Set(), responses: new Set(), assistantSource: null, assistant: null,
    rawSource: null, advertised: [], callReceipts: new Map(), results: new Map(),
  };
}

function bufferSources(buffer: DialogueBuffer): Source[] {
  const sources: Source[] = [];
  if (buffer.assistantSource !== null) sources.push(buffer.assistantSource);
  if (buffer.rawSource !== null) sources.push(buffer.rawSource);
  for (const source of buffer.callReceipts.values()) sources.push(source);
  for (const entry of buffer.results.values()) sources.push(entry.source);
  return sortUnique(sources);
}

export class ContextFold {
  private config: { readonly value: AgentConfig; readonly source: Source } | null = null;
  private surface: Surface | null = null;
  private open: MutableOpen | null = null;
  private readonly recovery: RecoveryEntry[] = [];
  private watermark: Source | null = null;
  /**
   * The latest durable `world/perception` the fold observed, as the proof a
   * driver verifies before advancing its world watermark. It is set from the
   * resolved, validated perception itself — even when its text is empty — and
   * never from `turn/start` or a closer.
   */
  private perceptionProof: WorldAcknowledgement | null = null;
  private readonly pendingCompactions: CompactionStart[] = [];
  private readonly pendingSummaries = new Map<string, { summary: CompactionSummary; source: Source }>();
  private readonly seen: VerifiedEvent[] = [];
  private readonly receipts = new Map<string, EventEnvelope>();
  private readonly lookup = (source: Source): EventEnvelope | null =>
    this.receipts.get(`${source.seq}:${source.hash}`) ?? null;

  /**
   * Folds verified events in order. A suffix must continue the observed chain;
   * an already-observed `(seq,hash)` is skipped, a changed hash or a gap rejects.
   */
  async observe(events: VerifiedEvents): Promise<void> {
    for (const event of events) {
      const seq = event.raw.seq;
      if (seq < this.seen.length) {
        const prior = this.seen[seq]!;
        if (prior.raw.hash !== event.raw.hash) {
          invariant(`changed hash at seq ${seq}: ${prior.raw.hash} -> ${event.raw.hash}`);
        }
        continue;
      }
      if (seq !== this.seen.length) {
        invariant(`gap in observation: expected seq ${this.seen.length}, received ${seq}`);
      }
      // Record the receipt before processing so a group appended by this event
      // can resolve its own source (a synthetic recovery result).
      this.receipts.set(`${seq}:${event.raw.hash}`, event.raw);
      this.process(event);
      this.seen.push(event);
      this.watermark = sourceOf(event);
    }
  }

  private process(event: VerifiedEvent): void {
    switch (event.type) {
      case 'node/boot':
      case 'node/shutdown':
      case 'artifact/chunk':
      case 'artifact/end':
      case 'request/usage':
      case 'assistant/attempt':
        return;
      case 'system/message': this.onConfig(event); return;
      case 'turn/start': this.onTurnStart(event); return;
      case 'turn/end': this.onTurnEnd(event); return;
      case 'world/perception': this.onPerception(event); return;
      case 'request/plan': this.onPlan(event); return;
      case 'request/refused': this.onRefused(event); return;
      case 'request/wire': this.onWire(event); return;
      case 'response/raw': this.onResponse(event); return;
      case 'assistant/message': this.onAssistant(event); return;
      case 'tool/call': this.onToolCall(event); return;
      case 'tool/result': this.onToolResult(event); return;
      case 'compaction/start': this.onCompactionStart(event); return;
      case 'compaction/summary': this.onCompactionSummary(event); return;
      case 'compaction/end': this.onCompactionEnd(event); return;
      case 'compaction/abort': this.onCompactionAbort(event); return;
      default: return;
    }
  }

  // --- config -----------------------------------------------------------------

  private onConfig(event: VerifiedEvent): void {
    const data = event.data as unknown as { version: number; value: Stored<AgentConfig> };
    const source = sourceOf(event);
    const config = resolveStored(this.seen, data.value, validateAgentConfig);
    if (config.version !== data.version) {
      invariant('system/message version does not equal the resolved config version');
    }
    if (this.config === null) {
      if (config.version < 1) invariant('the first config version must be at least 1');
      this.surface = new Surface({ text: config.heading, source }, this.lookup);
    } else {
      if (config.version <= this.config.value.version) {
        invariant('config version must strictly increase');
      }
      if (this.surface === null) invariant('config rewrite without a heading surface');
      this.surface.replaceHeading(config.heading, source);
    }
    this.config = { value: config, source };
  }

  // --- turn lifecycle ---------------------------------------------------------

  private onTurnStart(event: VerifiedEvent): void {
    if (this.open !== null) invariant('turn/start while a turn is already open');
    const data = event.data as unknown as { turn: number; world: WorldRange };
    this.open = {
      start: sourceOf(event), turn: data.turn,
      world: { from: data.world.from, to: data.world.to },
      perceptionGroup: null, perceptionSeen: false, perceptionConsumed: false,
      dialogues: new Map(),
    };
  }

  private requireOpen(where: string): MutableOpen {
    if (this.open === null) invariant(`${where} outside an open turn`);
    return this.open;
  }

  private buffer(open: MutableOpen, id: RequestId): DialogueBuffer {
    const key = `${id.turn}:${id.ordinal}`;
    let buffer = open.dialogues.get(key);
    if (buffer === undefined) {
      buffer = emptyBuffer(id);
      open.dialogues.set(key, buffer);
    }
    return buffer;
  }

  // --- perception -------------------------------------------------------------

  private perceptionScope(turn: number): GateScope {
    return { phase: 'turn', turn, signal: SIGNAL, lookup: this.lookup };
  }

  /**
   * Resolves a `Stored<WorldPerception>` (inline or artifact-json) and validates
   * its shape through the T1 registry, which also enforces the resolved value's
   * range equal to the wrapper range. The fold owns that check for artifact-json,
   * which the gate cannot see.
   */
  private resolvePerception(data: {
    turn: number; range: WorldRange; value: Stored<WorldPerception>;
  }): WorldPerception {
    const scope = this.perceptionScope(data.turn);
    const validator = REGISTRY['world/perception'];
    if (data.value.kind === 'inline') {
      const out = validator(data, scope) as unknown as { value: { value: WorldPerception } };
      return out.value.value;
    }
    const bytes = resolveArtifact(this.seen, data.value.ref);
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const out = validator(
      { turn: data.turn, range: data.range, value: { kind: 'inline', value: parsed } }, scope,
    ) as unknown as { value: { value: WorldPerception } };
    return out.value.value;
  }

  private onPerception(event: VerifiedEvent): void {
    const open = this.requireOpen('world/perception');
    const data = event.data as unknown as {
      turn: number; range: WorldRange; value: Stored<WorldPerception>;
    };
    if (data.turn !== open.turn) invariant('world/perception turn mismatch');
    if (open.perceptionSeen) invariant('duplicate world/perception for the turn');
    if (!rangeEquals(data.range, open.world)) {
      invariant('world/perception wrapper range does not equal the turn opening range');
    }
    const perception = this.resolvePerception(data);
    if (!rangeEquals(perception.range, data.range)) {
      invariant('resolved perception range does not equal the wrapper range');
    }
    open.perceptionSeen = true;
    this.perceptionProof = {
      turn: open.turn,
      range: { from: data.range.from, to: data.range.to },
      source: sourceOf(event),
    };
    if (perception.text.length > 0) {
      open.perceptionGroup = toJson({
        id: sourceOf(event), kind: 'perception', turn: open.turn,
        messages: [{ role: 'user', content: perception.text }], sources: [sourceOf(event)],
      }) as unknown as SurfaceGroup;
    }
  }

  // --- request pipeline -------------------------------------------------------

  private onPlan(event: VerifiedEvent): void {
    const open = this.requireOpen('request/plan');
    const data = event.data as unknown as { id: RequestId; value: Stored<RequestPlan> };
    if (data.id.turn !== open.turn) invariant('request/plan id.turn mismatch');
    const buffer = this.buffer(open, data.id);
    if (buffer.refused) invariant('request/plan after request/refused');
    if (buffer.planSource !== null) invariant('duplicate request/plan');
    const plan = resolveStored(this.seen, data.value, validateRequestPlan);
    if (!SAME_ID(plan.id, data.id)) invariant('request/plan id does not match its payload');
    if (this.config === null || !SAME(plan.config, this.config.source)) {
      invariant('request/plan config does not equal the active config');
    }
    buffer.planSource = sourceOf(event);
  }

  private onRefused(event: VerifiedEvent): void {
    const open = this.requireOpen('request/refused');
    const data = event.data as unknown as { id: RequestId };
    if (data.id.turn !== open.turn) invariant('request/refused id.turn mismatch');
    const buffer = this.buffer(open, data.id);
    if (buffer.planSource !== null || buffer.wireSeen || buffer.assistant !== null) {
      invariant('request/refused after a plan, wire or assistant');
    }
    buffer.refused = true;
  }

  private onWire(event: VerifiedEvent): void {
    const open = this.requireOpen('request/wire');
    const data = event.data as unknown as { id: RequestId; attempt: number; body: ArtifactRef };
    if (data.id.turn !== open.turn) invariant('request/wire id.turn mismatch');
    const buffer = this.buffer(open, data.id);
    if (buffer.refused) invariant('request/wire after request/refused');
    if (buffer.planSource === null) invariant('request/wire without a recorded plan');
    resolveArtifact(this.seen, data.body);
    if (data.attempt === 0) {
      if (buffer.wireSeen) invariant('duplicate first request/wire');
      buffer.wireSeen = true;
      buffer.firstBodySha = data.body.sha256;
      // The queue entry is consumed only by the first durable wire; a retry
      // reuses the same serialized body and must not duplicate the perception.
      if (open.perceptionGroup !== null && !open.perceptionConsumed) {
        open.perceptionConsumed = true;
      }
    } else {
      if (!buffer.wireSeen) invariant('retry request/wire before the first wire');
      if (data.body.sha256 !== buffer.firstBodySha) {
        invariant('retry request/wire does not reuse the first body');
      }
      if (buffer.attempts.has(data.attempt)) invariant('duplicate request/wire attempt');
    }
    buffer.attempts.add(data.attempt);
  }

  private onResponse(event: VerifiedEvent): void {
    const open = this.requireOpen('response/raw');
    const data = event.data as unknown as {
      id: RequestId; attempt: number; body: ArtifactRef;
    };
    if (data.id.turn !== open.turn) invariant('response/raw id.turn mismatch');
    const buffer = this.buffer(open, data.id);
    if (!buffer.attempts.has(data.attempt)) invariant('response/raw without a preceding wire');
    if (buffer.responses.has(data.attempt)) invariant('duplicate response/raw for an attempt');
    resolveArtifact(this.seen, data.body);
    buffer.responses.add(data.attempt);
  }

  private resolveAssistant(id: RequestId, value: Stored<AssistantProjection>): AssistantProjection {
    const scope = this.perceptionScope(id.turn);
    const validator = REGISTRY['assistant/message'];
    if (value.kind === 'inline') {
      const out = validator({ id, value }, scope) as unknown as { value: { value: AssistantProjection } };
      return out.value.value;
    }
    const bytes = resolveArtifact(this.seen, value.ref);
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const out = validator(
      { id, value: { kind: 'inline', value: parsed } }, scope,
    ) as unknown as { value: { value: AssistantProjection } };
    return out.value.value;
  }

  private onAssistant(event: VerifiedEvent): void {
    const open = this.requireOpen('assistant/message');
    const data = event.data as unknown as { id: RequestId; value: Stored<AssistantProjection> };
    if (data.id.turn !== open.turn) invariant('assistant/message id.turn mismatch');
    const buffer = this.buffer(open, data.id);
    if (buffer.refused) invariant('assistant/message after request/refused');
    if (buffer.planSource === null) invariant('assistant/message without a recorded plan');
    if (!buffer.wireSeen) invariant('assistant/message without a preceding wire');
    if (buffer.assistant !== null) invariant('duplicate assistant/message for a request');
    const projection = this.resolveAssistant(data.id, data.value);
    const ids = new Set<string>();
    for (const call of projection.message.tool_calls) {
      if (ids.has(call.id)) invariant(`duplicate call id ${call.id} within a response`);
      ids.add(call.id);
    }
    buffer.assistant = projection.message;
    buffer.assistantSource = sourceOf(event);
    buffer.rawSource = projection.raw.manifest;
    buffer.advertised = [...projection.message.tool_calls];
  }

  private onToolCall(event: VerifiedEvent): void {
    const open = this.requireOpen('tool/call');
    const data = event.data as unknown as { turn: number; request: RequestId; call: FunctionCall };
    if (data.turn !== open.turn || data.request.turn !== open.turn) {
      invariant('tool/call turn mismatch');
    }
    const buffer = this.buffer(open, data.request);
    if (buffer.assistant === null) invariant('tool/call before its assistant message');
    const advertised = buffer.advertised.find((call) => call.id === data.call.id);
    if (advertised === undefined) invariant(`tool/call ${data.call.id} was not advertised`);
    if (advertised.function.name !== data.call.function.name
      || advertised.function.arguments !== data.call.function.arguments) {
      invariant(`tool/call ${data.call.id} disagrees with the advertised call`);
    }
    if (buffer.callReceipts.has(data.call.id)) invariant(`duplicate tool/call ${data.call.id}`);
    buffer.callReceipts.set(data.call.id, sourceOf(event));
  }

  private onToolResult(event: VerifiedEvent): void {
    const data = event.data as unknown as {
      turn: number; request: RequestId; callId: string; message: ToolMessage;
      raw: ArtifactRef | null; synthetic: boolean;
    };
    if (data.message.tool_call_id !== data.callId) {
      invariant('tool/result message.tool_call_id does not match its callId');
    }
    if (data.raw !== null) resolveArtifact(this.seen, data.raw);

    if (this.open !== null && this.open.turn === data.turn && data.request.turn === this.open.turn) {
      const open = this.open;
      const buffer = this.buffer(open, data.request);
      if (buffer.assistant === null) invariant('tool/result before its assistant message');
      if (!buffer.advertised.some((call) => call.id === data.callId)) {
        invariant(`tool/result ${data.callId} is not an advertised call`);
      }
      if (!data.synthetic && !buffer.callReceipts.has(data.callId)) {
        invariant('tool/result without a preceding tool/call');
      }
      if (buffer.results.has(data.callId)) invariant(`duplicate tool/result for ${data.callId}`);
      buffer.results.set(data.callId, {
        message: data.message, source: sourceOf(event), synthetic: data.synthetic,
      });
      return;
    }

    // Outside its turn, only a synthetic ready-scope result may complete an
    // advertised call left unresolved by an interrupted/error closer.
    if (!data.synthetic) invariant('non-synthetic tool/result outside its turn');
    if (data.raw !== null) invariant('a synthetic recovery result must carry no raw ref');
    const entry = this.recovery.find(
      (candidate) => candidate.turn === data.turn && SAME_ID(candidate.request, data.request),
    );
    if (entry === undefined) {
      invariant(`tool/result ${data.callId} does not match an unresolved recovery call`);
    }
    if (!entry.advertised.some((call) => call.id === data.callId)) {
      invariant(`tool/result ${data.callId} is not an advertised recovery call`);
    }
    if (entry.results.has(data.callId)) invariant(`duplicate recovery result for ${data.callId}`);
    entry.results.set(data.callId, {
      message: data.message, source: sourceOf(event), synthetic: true,
    });
    if (entry.advertised.every((call) => entry.results.has(call.id))) {
      this.promoteRecovered(entry);
    }
  }

  // --- closers ----------------------------------------------------------------

  private onTurnEnd(event: VerifiedEvent): void {
    const open = this.requireOpen('turn/end');
    const data = event.data as unknown as { turn: number; outcome: string };
    if (data.turn !== open.turn) invariant('turn/end turn mismatch');
    const ignorable = event.raw.ignorable === true;
    const success = data.outcome === 'chained' || data.outcome === 'waiting';

    // The external perception is promoted first, so it precedes this turn's
    // dialogues in committed history, even when the turn did nothing else.
    if (open.perceptionGroup !== null && this.surface !== null) {
      this.surface.append(open.perceptionGroup);
    }

    for (const buffer of open.dialogues.values()) {
      if (buffer.assistant === null) continue;
      const balanced = buffer.advertised.every((call) => buffer.results.has(call.id));
      if (success) {
        if (!balanced) invariant('unbalanced dialogue under a successful closer');
        if (!ignorable) this.promoteDialogue(buffer, open.turn);
      } else if (balanced) {
        this.promoteDialogue(buffer, open.turn);
      } else {
        this.moveToRecovery(buffer, open.turn);
      }
    }
    this.open = null;
  }

  private promoteDialogue(buffer: DialogueBuffer, turn: number): void {
    if (this.surface === null) invariant('no heading surface to append a dialogue to');
    const messages: ChatMessage[] = [
      buffer.assistant!,
      ...buffer.advertised.map((call) => buffer.results.get(call.id)!.message),
    ];
    this.surface.append({
      id: buffer.assistantSource!, kind: 'dialogue', turn, messages,
      sources: bufferSources(buffer),
    });
  }

  private moveToRecovery(buffer: DialogueBuffer, turn: number): void {
    const results = new Map<string, ResultEntry>();
    for (const [callId, entry] of buffer.results) {
      results.set(callId, {
        message: entry.message, source: entry.source, synthetic: entry.synthetic,
      });
    }
    this.recovery.push({
      turn, request: buffer.request, assistant: buffer.assistant!,
      assistantSource: buffer.assistantSource!, rawSource: buffer.rawSource,
      advertised: [...buffer.advertised], callReceipts: new Map(buffer.callReceipts), results,
    });
  }

  private promoteRecovered(entry: RecoveryEntry): void {
    if (this.surface === null) invariant('no heading surface to append a recovered dialogue to');
    const messages: ChatMessage[] = [
      entry.assistant,
      ...entry.advertised.map((call) => entry.results.get(call.id)!.message),
    ];
    const sources: Source[] = [];
    sources.push(entry.assistantSource);
    if (entry.rawSource !== null) sources.push(entry.rawSource);
    for (const source of entry.callReceipts.values()) sources.push(source);
    for (const result of entry.results.values()) sources.push(result.source);
    this.surface.append({
      id: entry.assistantSource, kind: 'dialogue', turn: entry.turn, messages,
      sources: sortUnique(sources),
    });
    const index = this.recovery.indexOf(entry);
    if (index >= 0) this.recovery.splice(index, 1);
  }

  // --- compaction -------------------------------------------------------------

  private onCompactionStart(event: VerifiedEvent): void {
    const data = event.data as unknown as CompactionStart;
    if (this.surface === null) invariant('compaction/start before any config');
    if (this.pendingCompactions.some((pending) => pending.id === data.id)) {
      invariant(`duplicate compaction/start ${data.id}`);
    }
    for (const source of [...data.groupIds, ...data.sources]) {
      if (this.lookup(source) === null) invariant('compaction/start cites an unknown receipt');
    }
    this.pendingCompactions.push(toJson(data) as unknown as CompactionStart);
  }

  private onCompactionSummary(event: VerifiedEvent): void {
    const data = event.data as unknown as CompactionSummary;
    const source = sourceOf(event);
    for (const cited of data.sources) {
      if (this.lookup(cited) === null) invariant('compaction/summary cites an unknown receipt');
    }
    this.pendingSummaries.set(data.id, { summary: toJson(data) as unknown as CompactionSummary, source });
  }

  private onCompactionEnd(event: VerifiedEvent): void {
    const data = event.data as unknown as { id: string; summary: Source };
    const index = this.pendingCompactions.findIndex((pending) => pending.id === data.id);
    if (index < 0) invariant('compaction/end without a matching start');
    const offered = this.pendingSummaries.get(data.id);
    if (offered === undefined) invariant('compaction/end without a matching summary');
    if (!SAME(offered.source, data.summary)) {
      invariant('compaction/end summary source does not match the recorded summary');
    }
    if (this.surface === null) invariant('compaction/end without a heading surface');
    const start = this.pendingCompactions[index]!;
    this.surface.replaceCommitted(start, offered.summary, offered.source);
    this.pendingCompactions.splice(index, 1);
    this.pendingSummaries.delete(data.id);
  }

  private onCompactionAbort(event: VerifiedEvent): void {
    const data = event.data as unknown as { id: string };
    const index = this.pendingCompactions.findIndex((pending) => pending.id === data.id);
    if (index >= 0) this.pendingCompactions.splice(index, 1);
    this.pendingSummaries.delete(data.id);
  }

  // --- queries ----------------------------------------------------------------

  private completeBuffer(buffer: DialogueBuffer): boolean {
    return buffer.assistant !== null && buffer.advertised.every((call) => buffer.results.has(call.id));
  }

  private openMessages(open: MutableOpen): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const buffer of open.dialogues.values()) {
      if (!this.completeBuffer(buffer)) continue;
      messages.push(buffer.assistant!);
      for (const call of buffer.advertised) messages.push(buffer.results.get(call.id)!.message);
    }
    return messages;
  }

  private buildOpen(open: MutableOpen): OpenTurn {
    const sources: Source[] = [];
    if (open.perceptionGroup !== null && open.perceptionConsumed) {
      for (const source of open.perceptionGroup.sources) sources.push(source);
    }
    for (const buffer of open.dialogues.values()) {
      if (this.completeBuffer(buffer)) for (const source of bufferSources(buffer)) sources.push(source);
    }
    return {
      start: open.start, turn: open.turn, world: open.world,
      perception: open.perceptionGroup, perceptionConsumed: open.perceptionConsumed,
      messages: this.openMessages(open), sources: sortUnique(sources),
    };
  }

  private buildRecovery(entry: RecoveryEntry): RecoveryGroup {
    const results = entry.advertised
      .filter((call) => entry.results.has(call.id))
      .map((call) => entry.results.get(call.id)!.message);
    const missing = entry.advertised.filter((call) => !entry.results.has(call.id));
    const sources: Source[] = [entry.assistantSource];
    if (entry.rawSource !== null) sources.push(entry.rawSource);
    for (const source of entry.callReceipts.values()) sources.push(source);
    for (const result of entry.results.values()) sources.push(result.source);
    return {
      turn: entry.turn, request: entry.request, assistant: entry.assistant,
      sources: sortUnique(sources), results, missing,
    };
  }

  snapshot(): ProjectionState {
    const state = {
      config: this.config === null ? null : { value: this.config.value, source: this.config.source },
      surface: this.surface === null ? null : this.surface.snapshot(),
      open: this.open === null ? null : this.buildOpen(this.open),
      recovery: this.recovery.map((entry) => this.buildRecovery(entry)),
      watermark: this.watermark,
      pendingCompactions: this.pendingCompactions,
    };
    return toJson(state) as unknown as ProjectionState;
  }

  verifiedEvents(): VerifiedEvents {
    return this.seen.slice();
  }

  /**
   * The proof a driver verifies before advancing its watermark: the latest
   * durable world perception this fold folded, derived from the full observed
   * history and only from events delivered as durable — never from a
   * `turn/start` or a closer, and never from a cache or snapshot. The returned
   * object is a fresh copy, so no caller can mutate fold state through it.
   */
  acknowledgedWorld(): WorldAcknowledgement | null {
    const proof = this.perceptionProof;
    if (proof === null) return null;
    return {
      turn: proof.turn,
      range: { from: proof.range.from, to: proof.range.to },
      source: { seq: proof.source.seq, hash: proof.source.hash },
    };
  }

  unresolvedCalls(): readonly {
    readonly turn: number; readonly request: RequestId; readonly call: FunctionCall;
  }[] {
    const out: { turn: number; request: RequestId; call: FunctionCall }[] = [];
    if (this.open !== null) {
      for (const buffer of this.open.dialogues.values()) {
        if (buffer.assistant === null) continue;
        for (const call of buffer.advertised) {
          if (!buffer.results.has(call.id)) {
            out.push({ turn: this.open.turn, request: buffer.request, call });
          }
        }
      }
    }
    for (const entry of this.recovery) {
      for (const call of entry.advertised) {
        if (!entry.results.has(call.id)) {
          out.push({ turn: entry.turn, request: entry.request, call });
        }
      }
    }
    return out;
  }

  orphanCompactions(): readonly CompactionStart[] {
    return this.pendingCompactions.slice();
  }
}
