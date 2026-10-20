import type { EventEnvelope } from '../journal/index.js';
import type { GateScope, WorldAcknowledgement } from '../node/gate.js';
import type { WorldRange } from '../node/world.js';
import {
  eventKey, parseArtifactJson, requireCompleteArtifact, resolveArtifact, resolveStored, toJson,
} from './artifacts.js';
import { validateAgentConfig } from './config.js';
import { createBoundaryRegistry } from './events.js';
import { SAME, sortUnique } from './groups.js';
import type {
  AgentConfig, ArtifactRef, AssistantProjection, ChatMessage, CompactionStart, CompactionSummary,
  FunctionCall, OpenTurn, ProjectionState, RecoveryGroup, RequestId, Source, Stored,
  SurfaceGroup, WorldPerception,
} from './contracts.js';
import type { VerifiedEvent, VerifiedEvents } from './loader.js';
import { ArtifactMismatchError, sourceOf } from './loader.js';
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

const SAME_ID = (a: RequestId, b: RequestId): boolean =>
  a.turn === b.turn && a.ordinal === b.ordinal;
const rangeEquals = (a: WorldRange, b: WorldRange): boolean => a.from === b.from && a.to === b.to;

function invariant(message: string): never {
  throw new Error(`context fold invariant failure: ${message}`);
}

/**
 * Replay-boundary field validators. A chain-verified event proves the journal
 * bytes, not that a raw lifecycle/compaction payload has the shape its producer
 * promised; a forged but chain-valid event must fail as a fold invariant, never
 * as a `TypeError` from dereferencing a null field.
 */
function dataRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invariant(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function dataInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invariant(`${where} is not a nonnegative safe integer`);
  }
  return value as number;
}

function dataString(value: unknown, where: string): string {
  if (typeof value !== 'string') invariant(`${where} is not a string`);
  return value as string;
}

function dataArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) invariant(`${where} is not an array`);
  return value as unknown[];
}

function dataRequestId(value: unknown, where: string): RequestId {
  const o = dataRecord(value, where);
  return {
    turn: dataInt(o['turn'], `${where}.turn`),
    ordinal: dataInt(o['ordinal'], `${where}.ordinal`),
  };
}

function dataStored<T>(value: unknown, where: string): Stored<T> {
  const o = dataRecord(value, where);
  if (o['kind'] !== 'inline' && o['kind'] !== 'artifact-json') {
    invariant(`${where} has an unknown kind`);
  }
  return o as unknown as Stored<T>;
}

function dataFunctionCall(value: unknown, where: string): FunctionCall {
  const o = dataRecord(value, where);
  if (o['type'] !== 'function') invariant(`${where}.type is not 'function'`);
  const fn = dataRecord(o['function'], `${where}.function`);
  return {
    id: dataString(o['id'], `${where}.id`),
    type: 'function',
    function: {
      name: dataString(fn['name'], `${where}.function.name`),
      arguments: dataString(fn['arguments'], `${where}.function.arguments`),
    },
  };
}

function dataSource(value: unknown, where: string): Source {
  const o = dataRecord(value, where);
  return {
    seq: dataInt(o['seq'], `${where}.seq`),
    hash: dataString(o['hash'], `${where}.hash`),
  };
}

function dataWorldRange(value: unknown, where: string): WorldRange {
  const o = dataRecord(value, where);
  const edge = (v: unknown, at: string): string | null =>
    (v === null ? null : dataString(v, at));
  return {
    from: edge(o['from'], `${where}.from`),
    to: edge(o['to'], `${where}.to`),
  };
}

interface ResultEntry {
  readonly message: ToolMessage;
  readonly source: Source;
  readonly synthetic: boolean;
}

interface DialogueBuffer {
  readonly request: RequestId;
  refused: boolean;
  assistantSource: Source | null;
  assistant: AssistantMessage | null;
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
  readonly advertised: FunctionCall[];
  readonly callReceipts: Map<string, Source>;
  readonly results: Map<string, ResultEntry>;
}

function emptyBuffer(request: RequestId): DialogueBuffer {
  return {
    request, refused: false, assistantSource: null, assistant: null,
    advertised: [], callReceipts: new Map(), results: new Map(),
  };
}

function bufferSources(buffer: DialogueBuffer): Source[] {
  const sources: Source[] = [];
  if (buffer.assistantSource !== null) sources.push(buffer.assistantSource);
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
  /**
   * The incremental `(seq, hash)` index of observed verified events, so artifact
   * resolution is an O(1) lookup instead of a per-call rebuild over the history.
   * It holds exactly the observed prefix — a receipt that has not been folded yet
   * cannot resolve through it — and stores the *resolved* envelope, so provenance
   * lookups (the surface's receipts, the boundary validators' `scope.lookup`) see
   * the real payload even when a raw v0 envelope carried a claim-check reference.
   */
  private readonly verifiedIndex = new Map<string, VerifiedEvent>();
  private readonly lookup = (source: Source): EventEnvelope | null => {
    try {
      return this.verifiedIndex.get(eventKey(source)) ?? null;
    } catch (err) {
      // A malformed receipt is an unknown citation, not an artifact mismatch:
      // `eventKey`'s typed mismatch classifies a forged artifact manifest, and
      // the fold's callers own the citation vocabulary ("cites an unknown
      // receipt"/"missing receipt"). Let the actual artifact paths keep it.
      if (err instanceof ArtifactMismatchError) return null;
      throw err;
    }
  };
  /**
   * A fatal invariant is fail-stop: once `observe` throws, the fold may hold a
   * partially-mutated cache (index registered before `process`, handlers partway),
   * so it refuses every later observation. A fresh `ContextFold` re-folds the
   * durable history from scratch — the crash/restart path — instead of continuing
   * on suspect state.
   */
  private poisoned: string | null = null;

  /**
   * Folds verified events in order. A suffix must continue the observed chain;
   * an already-observed `(seq,hash)` is skipped, a changed hash or a gap rejects.
   * Any failure is fail-stop: the fold is poisoned and refuses later observation
   * (a fresh fold re-folds the durable history) rather than risking a re-delivery
   * on top of a partially-mutated cache.
   */
  async observe(events: VerifiedEvents): Promise<void> {
    if (this.poisoned !== null) {
      throw new Error(
        `context fold invariant failure: fold is poisoned after a prior failure: ${this.poisoned}`);
    }
    try {
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
        // Register the resolution index before processing so a group appended by
        // this event can resolve its own source (a synthetic recovery result) and
        // every resolution is an O(1) lookup of the resolved envelope.
        this.verifiedIndex.set(eventKey(event.raw), event);
        this.process(event);
        this.seen.push(event);
        this.watermark = sourceOf(event);
      }
    } catch (err) {
      this.poisoned = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private process(event: VerifiedEvent): void {
    switch (event.type) {
      case 'node/boot':
      case 'node/shutdown':
      case 'artifact/chunk':
      case 'artifact/end':
        return;
      case 'system/message': this.onConfig(event); return;
      case 'turn/start': this.onTurnStart(event); return;
      case 'turn/end': this.onTurnEnd(event); return;
      case 'world/perception': this.onPerception(event); return;
      case 'request/refused': this.onRefused(event); return;
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
    const data = dataRecord(event.data, 'system/message data');
    const version = dataInt(data['version'], 'system/message.version');
    const value = dataStored<AgentConfig>(data['value'], 'system/message.value');
    const source = sourceOf(event);
    const config = resolveStored(this.verifiedIndex, value, validateAgentConfig);
    if (config.version !== version) {
      invariant('system/message version does not equal the resolved config version');
    }
    if (this.config === null) {
      // Fail-closed defense for a future refactor: validateAgentConfig already
      // requires version >= 1, so this is unreachable today — but a first config
      // must never create a surface at an unversioned epoch.
      if (config.version < 1) invariant('the first config version must be at least 1');
      this.surface = new Surface({ text: config.heading, source }, this.lookup);
    } else {
      if (config.version <= this.config.value.version) {
        invariant('config version must strictly increase');
      }
      // Fail-closed defense for a future refactor: the first config creates the
      // heading surface and it is never nulled, so this guard is unreachable
      // today — but a rewrite must never proceed without a heading pin.
      if (this.surface === null) invariant('config rewrite without a heading surface');
      this.surface.replaceHeading(config.heading, source);
    }
    this.config = { value: config, source };
  }

  // --- turn lifecycle ---------------------------------------------------------

  private onTurnStart(event: VerifiedEvent): void {
    if (this.open !== null) invariant('turn/start while a turn is already open');
    const data = dataRecord(event.data, 'turn/start data');
    const turn = dataInt(data['turn'], 'turn/start.turn');
    const world = dataWorldRange(data['world'], 'turn/start.world');
    this.open = {
      start: sourceOf(event), turn, world,
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
    const bytes = resolveArtifact(this.verifiedIndex, data.value.ref);
    requireCompleteArtifact(data.value.ref);
    const parsed = parseArtifactJson(bytes);
    const out = validator(
      { turn: data.turn, range: data.range, value: { kind: 'inline', value: parsed } }, scope,
    ) as unknown as { value: { value: WorldPerception } };
    return out.value.value;
  }

  private onPerception(event: VerifiedEvent): void {
    const open = this.requireOpen('world/perception');
    const raw = dataRecord(event.data, 'world/perception data');
    const data = {
      turn: dataInt(raw['turn'], 'world/perception.turn'),
      range: dataWorldRange(raw['range'], 'world/perception.range'),
      value: dataStored<WorldPerception>(raw['value'], 'world/perception.value'),
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

  private onRefused(event: VerifiedEvent): void {
    const open = this.requireOpen('request/refused');
    const raw = dataRecord(event.data, 'request/refused data');
    const data = { id: dataRequestId(raw['id'], 'request/refused.id') };
    if (data.id.turn !== open.turn) invariant('request/refused id.turn mismatch');
    const buffer = this.buffer(open, data.id);
    if (buffer.refused) invariant('duplicate request/refused for a request');
    if (buffer.assistant !== null) {
      invariant('request/refused after an assistant message');
    }
    buffer.refused = true;
  }

  private resolveAssistant(id: RequestId, value: Stored<AssistantProjection>): AssistantProjection {
    const scope = this.perceptionScope(id.turn);
    const validator = REGISTRY['assistant/message'];
    if (value.kind === 'inline') {
      const out = validator({ id, value }, scope) as unknown as { value: { value: AssistantProjection } };
      return out.value.value;
    }
    const bytes = resolveArtifact(this.verifiedIndex, value.ref);
    requireCompleteArtifact(value.ref);
    const parsed = parseArtifactJson(bytes);
    const out = validator(
      { id, value: { kind: 'inline', value: parsed } }, scope,
    ) as unknown as { value: { value: AssistantProjection } };
    return out.value.value;
  }

  private onAssistant(event: VerifiedEvent): void {
    const open = this.requireOpen('assistant/message');
    const raw = dataRecord(event.data, 'assistant/message data');
    const data = {
      id: dataRequestId(raw['id'], 'assistant/message.id'),
      value: dataStored<AssistantProjection>(raw['value'], 'assistant/message.value'),
    };
    if (data.id.turn !== open.turn) invariant('assistant/message id.turn mismatch');
    const buffer = this.buffer(open, data.id);
    if (buffer.refused) invariant('assistant/message after request/refused');
    if (buffer.assistant !== null) invariant('duplicate assistant/message for a request');
    const projection = this.resolveAssistant(data.id, data.value);
    const ids = new Set<string>();
    for (const call of projection.message.tool_calls) {
      if (ids.has(call.id)) invariant(`duplicate call id ${call.id} within a response`);
      ids.add(call.id);
    }
    buffer.assistant = projection.message;
    buffer.assistantSource = sourceOf(event);
    buffer.advertised = [...projection.message.tool_calls];
    // The queue entry is consumed by the turn's first assistant message: an
    // intra-turn assembly hint for history-vs-queue rendering. A turn whose
    // requests all failed at the transport, or whose only response failed
    // projection, records no assistant message and leaves this unset.
    if (open.perceptionGroup !== null && !open.perceptionConsumed) {
      open.perceptionConsumed = true;
    }
  }

  private onToolCall(event: VerifiedEvent): void {
    const open = this.requireOpen('tool/call');
    const raw = dataRecord(event.data, 'tool/call data');
    const data = {
      turn: dataInt(raw['turn'], 'tool/call.turn'),
      request: dataRequestId(raw['request'], 'tool/call.request'),
      call: dataFunctionCall(raw['call'], 'tool/call.call'),
    };
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
    const data = dataRecord(event.data, 'tool/result data');
    const turn = dataInt(data['turn'], 'tool/result.turn');
    const requestData = dataRecord(data['request'], 'tool/result.request');
    const request: RequestId = {
      turn: dataInt(requestData['turn'], 'tool/result.request.turn'),
      ordinal: dataInt(requestData['ordinal'], 'tool/result.request.ordinal'),
    };
    const callId = dataString(data['callId'], 'tool/result.callId');
    const messageData = dataRecord(data['message'], 'tool/result.message');
    if (messageData['role'] !== 'tool') invariant('tool/result.message is not a tool message');
    dataString(messageData['content'], 'tool/result.message.content');
    if (messageData['tool_call_id'] !== callId) {
      invariant('tool/result message.tool_call_id does not match its callId');
    }
    const message = messageData as unknown as ToolMessage;
    const syntheticValue = data['synthetic'];
    if (typeof syntheticValue !== 'boolean') invariant('tool/result.synthetic is not a boolean');
    const synthetic = syntheticValue;
    const rawValue = data['raw'];
    if (rawValue !== null && (typeof rawValue !== 'object' || Array.isArray(rawValue))) {
      invariant('tool/result.raw is neither null nor an artifact reference');
    }
    const raw = rawValue as ArtifactRef | null;
    if (raw !== null) resolveArtifact(this.verifiedIndex, raw);

    if (this.open !== null && this.open.turn === turn && request.turn === this.open.turn) {
      const open = this.open;
      const buffer = this.buffer(open, request);
      if (buffer.assistant === null) invariant('tool/result before its assistant message');
      if (!buffer.advertised.some((call) => call.id === callId)) {
        invariant(`tool/result ${callId} is not an advertised call`);
      }
      if (!synthetic && !buffer.callReceipts.has(callId)) {
        invariant('tool/result without a preceding tool/call');
      }
      if (buffer.results.has(callId)) invariant(`duplicate tool/result for ${callId}`);
      buffer.results.set(callId, { message, source: sourceOf(event), synthetic });
      return;
    }

    // Outside its turn, only a synthetic ready-scope result may complete an
    // advertised call left unresolved by an interrupted/error closer.
    if (!synthetic) invariant('non-synthetic tool/result outside its turn');
    if (raw !== null) invariant('a synthetic recovery result must carry no raw ref');
    const entry = this.recovery.find(
      (candidate) => candidate.turn === turn && SAME_ID(candidate.request, request),
    );
    if (entry === undefined) {
      invariant(`tool/result ${callId} does not match an unresolved recovery call`);
    }
    if (!entry.advertised.some((call) => call.id === callId)) {
      invariant(`tool/result ${callId} is not an advertised recovery call`);
    }
    if (entry.results.has(callId)) invariant(`duplicate recovery result for ${callId}`);
    entry.results.set(callId, { message, source: sourceOf(event), synthetic: true });
    if (entry.advertised.every((call) => entry.results.has(call.id))) {
      this.promoteRecovered(entry);
    }
  }

  // --- closers ----------------------------------------------------------------

  private onTurnEnd(event: VerifiedEvent): void {
    const open = this.requireOpen('turn/end');
    const data = dataRecord(event.data, 'turn/end data');
    const turn = dataInt(data['turn'], 'turn/end.turn');
    if (turn !== open.turn) invariant('turn/end turn mismatch');
    const outcome = data['outcome'];
    // The closer outcome is a typed fact: an unknown value is a forged/invalid
    // payload, not a recoverable failure. Silently mapping it to the failure
    // branch would promote or recover the wrong groups.
    if (outcome !== 'chained' && outcome !== 'waiting'
      && outcome !== 'error' && outcome !== 'interrupted') {
      invariant(`turn/end outcome ${JSON.stringify(outcome)} is not a known outcome`);
    }
    const ignorable = event.raw.ignorable === true;
    const success = outcome === 'chained' || outcome === 'waiting';

    // Validate the whole turn before mutating anything: a fatal invariant must not
    // leave the cached surface half-applied (perception appended, dialogue not).
    const promote: DialogueBuffer[] = [];
    const recover: DialogueBuffer[] = [];
    for (const buffer of open.dialogues.values()) {
      if (buffer.assistant === null) continue;
      const balanced = buffer.advertised.every((call) => buffer.results.has(call.id));
      if (success) {
        if (!balanced) invariant('unbalanced dialogue under a successful closer');
        if (!ignorable) promote.push(buffer);
      } else if (balanced) {
        promote.push(buffer);
      } else {
        recover.push(buffer);
      }
    }
    // The external perception is promoted first, so it precedes this turn's
    // dialogues in committed history, even when the turn did nothing else.
    if (open.perceptionGroup !== null && this.surface !== null) {
      this.surface.append(open.perceptionGroup);
    }
    for (const buffer of promote) this.promoteDialogue(buffer, open.turn);
    for (const buffer of recover) this.moveToRecovery(buffer, open.turn);
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
      assistantSource: buffer.assistantSource!,
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
    const raw = dataRecord(event.data, 'compaction/start data');
    const data: CompactionStart = {
      id: dataString(raw['id'], 'compaction/start.id'),
      revision: dataString(raw['revision'], 'compaction/start.revision'),
      groupIds: dataArray(raw['groupIds'], 'compaction/start.groupIds')
        .map((entry, i) => dataSource(entry, `compaction/start.groupIds[${i}]`)),
      sources: dataArray(raw['sources'], 'compaction/start.sources')
        .map((entry, i) => dataSource(entry, `compaction/start.sources[${i}]`)),
      shadowHash: dataString(raw['shadowHash'], 'compaction/start.shadowHash'),
      shadowBytes: dataInt(raw['shadowBytes'], 'compaction/start.shadowBytes'),
    };
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
    const raw = dataRecord(event.data, 'compaction/summary data');
    const id = dataString(raw['id'], 'compaction/summary.id');
    const messageData = dataRecord(raw['message'], 'compaction/summary.message');
    if (messageData['role'] !== 'user') {
      invariant('compaction/summary.message is not a user message');
    }
    // The summary is exactly one user message; a bare cast here would let a
    // chain-valid null/non-string content reach the surface and fail far away.
    for (const key of Object.keys(messageData)) {
      if (key !== 'role' && key !== 'content') {
        invariant(`compaction/summary.message has an unknown field ${JSON.stringify(key)}`);
      }
    }
    const content = messageData['content'];
    if (typeof content !== 'string') {
      invariant('compaction/summary.message.content is not a string');
    }
    const message: CompactionSummary['message'] = { role: 'user', content };
    const data: CompactionSummary = {
      id,
      message,
      sources: dataArray(raw['sources'], 'compaction/summary.sources')
        .map((entry, i) => dataSource(entry, `compaction/summary.sources[${i}]`)),
      replacementBytes: dataInt(raw['replacementBytes'], 'compaction/summary.replacementBytes'),
    };
    const source = sourceOf(event);
    // A summary completes exactly one open start and is recorded once: validate
    // everything before mutating, so a refusal never leaves a half-set map.
    if (!this.pendingCompactions.some((pending) => pending.id === data.id)) {
      invariant(`compaction/summary without a matching start ${data.id}`);
    }
    if (this.pendingSummaries.has(data.id)) {
      invariant(`duplicate compaction/summary ${data.id}`);
    }
    for (const cited of data.sources) {
      if (this.lookup(cited) === null) invariant('compaction/summary cites an unknown receipt');
    }
    this.pendingSummaries.set(data.id, { summary: toJson(data) as unknown as CompactionSummary, source });
  }

  private onCompactionEnd(event: VerifiedEvent): void {
    const raw = dataRecord(event.data, 'compaction/end data');
    const id = dataString(raw['id'], 'compaction/end.id');
    const summary = dataSource(raw['summary'], 'compaction/end.summary');
    const index = this.pendingCompactions.findIndex((pending) => pending.id === id);
    if (index < 0) invariant('compaction/end without a matching start');
    const offered = this.pendingSummaries.get(id);
    if (offered === undefined) invariant('compaction/end without a matching summary');
    if (!SAME(offered.source, summary)) {
      invariant('compaction/end summary source does not match the recorded summary');
    }
    // Fail-closed defense for a future refactor: compaction/start already
    // requires a surface and it is never nulled, so this is unreachable today —
    // but an end must never replace committed state without a heading pin.
    if (this.surface === null) invariant('compaction/end without a heading surface');
    const start = this.pendingCompactions[index]!;
    this.surface.replaceCommitted(start, offered.summary, offered.source);
    this.pendingCompactions.splice(index, 1);
    this.pendingSummaries.delete(id);
  }

  private onCompactionAbort(event: VerifiedEvent): void {
    const raw = dataRecord(event.data, 'compaction/abort data');
    const id = dataString(raw['id'], 'compaction/abort.id');
    // The producer aborts once, and only a recorded transaction can be aborted;
    // an unknown id is an invalid sequence, not a no-op.
    const index = this.pendingCompactions.findIndex((pending) => pending.id === id);
    if (index < 0) invariant(`compaction/abort without a matching start ${id}`);
    this.pendingCompactions.splice(index, 1);
    this.pendingSummaries.delete(id);
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
   * `turn/start` or a closer, and never from a cache or snapshot.
   *
   * The live path passes the turn it is acknowledging: a proof from another turn
   * means the handler recorded no perception for this one, so this returns null
   * rather than a stale proof the driver would reject. The resume path omits the
   * turn and gets the unfiltered latest proof — including when a replayed
   * `turn/start` is open after a crash before its perception, because the prior
   * turn's proof is exactly what rebuilds the watermark. The returned object is a
   * fresh copy, so no caller can mutate fold state through it.
   */
  acknowledgedWorld(turn?: number): WorldAcknowledgement | null {
    const proof = this.perceptionProof;
    if (proof === null) return null;
    if (turn !== undefined && proof.turn !== turn) return null;
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
