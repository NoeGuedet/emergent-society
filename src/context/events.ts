import type { JsonValue } from '../journal/index.js';
import { NODE_EVENT_TYPES } from '../node/events.js';
import type { GateScope, BoundaryRegistry } from '../node/gate.js';
import type { WorldRange } from '../node/world.js';
import { toJson } from './artifacts.js';
import { validateAgentConfig, validateSeedPolicy, validateToolSchema } from './config.js';
import type {
  AgentConfig, ArtifactChunk, ArtifactManifest, ArtifactRef, AssistantProjection, CanonicalUsage,
  ChatMessage, CompactionAbort, CompactionEnd, CompactionStart, CompactionSummary, ErrorCode,
  FunctionCall, PlanSection, RequestId, RequestPlan, SafeFailure, SeedPolicy, Source, Stored,
  ToolSchema, WorldPerception,
} from './contracts.js';

/**
 * The C1.3 event vocabulary (kernel.md §3, §4). Each type records either a raw
 * boundary fact or a decision of a replaceable policy — never a redundant
 * intermediate computation. The payload map is merged into the journal's
 * `EventDataMap` (typed write/read) and the gate's `BoundaryDataMap` (validation),
 * using the same declarations so there is one shape.
 */

export interface ContextEventDataMap {
  'artifact/chunk': ArtifactChunk;
  'artifact/end': ArtifactManifest;
  'system/message': { version: number; value: Stored<AgentConfig> };
  /** `value.range` must equal `range`; the fold also ties `range` to the open turn's opening range. */
  'world/perception': { turn: number; range: WorldRange; value: Stored<WorldPerception> };
  'request/plan': { id: RequestId; value: Stored<RequestPlan> };
  'request/refused': { id: RequestId; bytes: number; limit: number; phase: 'plan' };
  'request/wire': { id: RequestId; attempt: number; body: ArtifactRef };
  'response/raw': {
    id: RequestId; attempt: number; status: number; body: ArtifactRef; complete: boolean;
  };
  'request/usage': { id: RequestId; attempt: number; value: CanonicalUsage };
  'assistant/message': { id: RequestId; value: Stored<AssistantProjection> };
  'assistant/attempt': { id: RequestId; attempt: number; failure: SafeFailure; terminal: boolean };
  'tool/call': { turn: number; request: RequestId; call: FunctionCall };
  'tool/result': {
    turn: number; request: RequestId; callId: string;
    message: Extract<ChatMessage, { role: 'tool' }>; isError: boolean;
    raw: ArtifactRef | null; failure: SafeFailure | null; synthetic: boolean;
  };
  'compaction/start': CompactionStart;
  'compaction/summary': CompactionSummary;
  'compaction/end': CompactionEnd;
  'compaction/abort': CompactionAbort;
}

// The declared shape of the config payload is AgentConfig; the runtime validator
// is validateAgentConfig, so the map names the same shape the fold resolves.

declare module '../journal/envelope.js' {
  interface EventDataMap extends ContextEventDataMap {}
}

declare module '../node/gate.js' {
  interface BoundaryDataMap extends ContextEventDataMap {}
}

const REGISTERED: Record<keyof ContextEventDataMap, true> = {
  'artifact/chunk': true, 'artifact/end': true, 'system/message': true, 'world/perception': true,
  'request/plan': true, 'request/refused': true, 'request/wire': true, 'response/raw': true,
  'request/usage': true, 'assistant/message': true, 'assistant/attempt': true, 'tool/call': true,
  'tool/result': true, 'compaction/start': true, 'compaction/summary': true, 'compaction/end': true,
  'compaction/abort': true,
};

/** Every event type a C1.3 reader/replay must know: the node lifecycle union the context types. */
export const C13_EVENT_TYPES: ReadonlySet<string> =
  new Set([...NODE_EVENT_TYPES, ...Object.keys(REGISTERED)]);

const HASH_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'http', 'network', 'timeout', 'cancelled', 'malformed', 'body-limit', 'invalid-tool',
  'unknown-tool', 'denied', 'spawn', 'signal', 'output-limit', 'request-limit',
]);

function fail(where: string, message: string): never {
  throw new Error(`invalid ${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(where, `unexpected key ${JSON.stringify(key)}`);
  }
}

function text(value: unknown, where: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    fail(where, nonEmpty ? 'expected a nonempty string' : 'expected a string');
  }
  return value as string;
}

function nullableHash(value: unknown, where: string): string | null {
  if (value === null) return null;
  return text(value, where);
}

function hash(value: unknown, where: string): string {
  const s = text(value, where);
  if (!HASH_RE.test(s)) fail(where, 'expected 64 lowercase hex characters');
  return s;
}

function encoding(value: unknown, where: string): 'utf8' | 'binary' {
  if (value !== 'utf8' && value !== 'binary') fail(where, "expected 'utf8' or 'binary'");
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(where, 'expected a boolean');
  return value as boolean;
}

function safeInt(value: unknown, where: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(where, `expected a safe integer in [${min}, ${max}]`);
  }
  return value as number;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, 'expected an array');
  return value as unknown[];
}

function base64(value: unknown, where: string): string {
  const s = text(value, where, false);
  if (s.length % 4 !== 0 || !BASE64_RE.test(s)
    || Buffer.from(s, 'base64').toString('base64') !== s) {
    fail(where, 'expected canonical base64');
  }
  return s;
}

function source(value: unknown, where: string): Source {
  const o = record(value, where);
  onlyKeys(o, ['seq', 'hash'], where);
  return { seq: safeInt(o['seq'], `${where}.seq`, 0), hash: hash(o['hash'], `${where}.hash`) };
}

function requestId(value: unknown, where: string): RequestId {
  const o = record(value, where);
  onlyKeys(o, ['turn', 'ordinal'], where);
  return {
    turn: safeInt(o['turn'], `${where}.turn`, 0),
    ordinal: safeInt(o['ordinal'], `${where}.ordinal`, 0),
  };
}

function worldRange(value: unknown, where: string): WorldRange {
  const o = record(value, where);
  onlyKeys(o, ['from', 'to'], where);
  return {
    from: nullableHash(o['from'], `${where}.from`),
    to: nullableHash(o['to'], `${where}.to`),
  };
}

function artifactRef(value: unknown, where: string): ArtifactRef {
  const o = record(value, where);
  onlyKeys(o, ['kind', 'manifest', 'sha256', 'bytes', 'encoding', 'complete'], where);
  if (o['kind'] !== 'c13-artifact') fail(where, "kind must be 'c13-artifact'");
  return {
    kind: 'c13-artifact',
    manifest: source(o['manifest'], `${where}.manifest`),
    sha256: hash(o['sha256'], `${where}.sha256`),
    bytes: safeInt(o['bytes'], `${where}.bytes`, 0),
    encoding: encoding(o['encoding'], `${where}.encoding`),
    complete: bool(o['complete'], `${where}.complete`),
  };
}

function functionCall(value: unknown, where: string): FunctionCall {
  const o = record(value, where);
  onlyKeys(o, ['id', 'type', 'function'], where);
  if (o['type'] !== 'function') fail(where, "type must be 'function'");
  const fn = record(o['function'], `${where}.function`);
  onlyKeys(fn, ['name', 'arguments'], `${where}.function`);
  return {
    id: text(o['id'], `${where}.id`),
    type: 'function',
    function: {
      name: text(fn['name'], `${where}.function.name`),
      arguments: text(fn['arguments'], `${where}.function.arguments`, false),
    },
  };
}

function chatMessage(value: unknown, where: string): ChatMessage {
  const o = record(value, where);
  const role = o['role'];
  if (role === 'system') {
    onlyKeys(o, ['role', 'content'], where);
    return { role: 'system', content: text(o['content'], `${where}.content`, false) };
  }
  if (role === 'user') {
    onlyKeys(o, ['role', 'content'], where);
    return { role: 'user', content: text(o['content'], `${where}.content`, false) };
  }
  if (role === 'assistant') {
    onlyKeys(o, ['role', 'content', 'tool_calls'], where);
    const content = o['content'] === null ? null : text(o['content'], `${where}.content`, false);
    const calls = array(o['tool_calls'], `${where}.tool_calls`).map((call, i) =>
      functionCall(call, `${where}.tool_calls[${i}]`));
    return { role: 'assistant', content, tool_calls: calls };
  }
  if (role === 'tool') {
    onlyKeys(o, ['role', 'content', 'tool_call_id'], where);
    return {
      role: 'tool',
      content: text(o['content'], `${where}.content`, false),
      tool_call_id: text(o['tool_call_id'], `${where}.tool_call_id`),
    };
  }
  return fail(where, 'unknown chat role');
}

function usage(value: unknown, where: string): CanonicalUsage {
  const o = record(value, where);
  onlyKeys(o, ['inputTotal', 'inputUncached', 'output', 'cacheRead', 'cacheWrite'], where);
  const counter = (key: string): number | null =>
    o[key] === null ? null : safeInt(o[key], `${where}.${key}`, 0);
  return {
    inputTotal: counter('inputTotal'),
    inputUncached: counter('inputUncached'),
    output: counter('output'),
    cacheRead: counter('cacheRead'),
    cacheWrite: counter('cacheWrite'),
  };
}

function safeFailure(value: unknown, where: string): SafeFailure {
  const o = record(value, where);
  onlyKeys(o, ['code', 'status'], where);
  const code = text(o['code'], `${where}.code`);
  if (!ERROR_CODES.has(code)) fail(`${where}.code`, `unknown error code ${JSON.stringify(code)}`);
  const status = o['status'] === null ? null : safeInt(o['status'], `${where}.status`, 0);
  return { code: code as ErrorCode, status };
}

function planSection(value: unknown, where: string): PlanSection {
  const o = record(value, where);
  onlyKeys(o, ['name', 'cache', 'sources'], where);
  const name = o['name'];
  if (name !== 'tools' && name !== 'charter' && name !== 'heading'
    && name !== 'history' && name !== 'queue') {
    fail(`${where}.name`, 'unknown section');
  }
  const cache = o['cache'];
  if (cache !== 'stable' && cache !== 'advance' && cache !== 'volatile') {
    fail(`${where}.cache`, 'unknown cache class');
  }
  return {
    name,
    cache,
    sources: array(o['sources'], `${where}.sources`).map((s, i) => source(s, `${where}.sources[${i}]`)),
  };
}

function toolSchema(value: unknown, where: string): ToolSchema {
  return validateToolSchema(value, where);
}

function policy(value: unknown, where: string): SeedPolicy {
  return validateSeedPolicy(value, where);
}

/** Rejects extras and validates the seed policy through the single config validator. */
function parameters(value: unknown, where: string): { readonly [key: string]: JsonValue } {
  const json = toJson(value);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    fail(where, 'expected a JSON object');
  }
  return json as { readonly [key: string]: JsonValue };
}

function worldPerception(value: unknown, where: string): WorldPerception {
  const o = record(value, where);
  onlyKeys(o, [
    'uid', 'range', 'effectiveFrom', 'fallback', 'renderer', 'maxBytes', 'maxCommits',
    'listTruncated', 'commits', 'included', 'omittedOwn', 'text', 'truncated',
  ], where);
  const renderer = record(o['renderer'], `${where}.renderer`);
  onlyKeys(renderer, ['policy', 'gitVersion', 'attrSource'], `${where}.renderer`);
  if (renderer['policy'] !== 'commit-patches-v1') fail(`${where}.renderer.policy`, 'unknown policy');
  if (renderer['attrSource'] !== 'to') fail(`${where}.renderer.attrSource`, "must be 'to'");
  const fallback = o['fallback'];
  if (fallback !== 'none' && fallback !== 'unreachable-from') fail(`${where}.fallback`, 'unknown');
  const commits = array(o['commits'], `${where}.commits`).map((commit, i) => {
    const c = record(commit, `${where}.commits[${i}]`);
    onlyKeys(c, ['hash', 'author'], `${where}.commits[${i}]`);
    return {
      hash: text(c['hash'], `${where}.commits[${i}].hash`),
      author: text(c['author'], `${where}.commits[${i}].author`),
    };
  });
  const stringList = (key: string): string[] =>
    array(o[key], `${where}.${key}`).map((s, i) => text(s, `${where}.${key}[${i}]`));
  return {
    uid: text(o['uid'], `${where}.uid`),
    range: worldRange(o['range'], `${where}.range`),
    effectiveFrom: nullableHash(o['effectiveFrom'], `${where}.effectiveFrom`),
    fallback,
    renderer: { policy: 'commit-patches-v1', gitVersion: text(renderer['gitVersion'], `${where}.renderer.gitVersion`), attrSource: 'to' },
    maxBytes: safeInt(o['maxBytes'], `${where}.maxBytes`, 0),
    maxCommits: safeInt(o['maxCommits'], `${where}.maxCommits`, 0),
    listTruncated: bool(o['listTruncated'], `${where}.listTruncated`),
    commits,
    included: stringList('included'),
    omittedOwn: stringList('omittedOwn'),
    text: text(o['text'], `${where}.text`, false),
    truncated: bool(o['truncated'], `${where}.truncated`),
  };
}

/**
 * Validates an untrusted `RequestPlan` (the persisted plan consumers parse) and
 * returns a frozen JSON copy. Semantic re-derivation lives in the assembler; this
 * is the shape/type boundary used by `resolveStored`.
 */
export function validateRequestPlan(value: unknown): RequestPlan {
  const o = record(value, 'request/plan');
  onlyKeys(o, [
    'id', 'config', 'stateHash', 'model', 'parameters', 'policy', 'tools', 'toolsHash',
    'sections', 'history', 'queue', 'charter', 'heading',
  ], 'request/plan');
  const plan = {
    id: requestId(o['id'], 'request/plan.id'),
    config: source(o['config'], 'request/plan.config'),
    stateHash: text(o['stateHash'], 'request/plan.stateHash'),
    model: text(o['model'], 'request/plan.model'),
    parameters: parameters(o['parameters'], 'request/plan.parameters'),
    policy: policy(o['policy'], 'request/plan.policy'),
    tools: array(o['tools'], 'request/plan.tools').map((t, i) => toolSchema(t, `request/plan.tools[${i}]`)),
    toolsHash: text(o['toolsHash'], 'request/plan.toolsHash'),
    sections: array(o['sections'], 'request/plan.sections').map((s, i) =>
      planSection(s, `request/plan.sections[${i}]`)),
    history: array(o['history'], 'request/plan.history').map((m, i) =>
      chatMessage(m, `request/plan.history[${i}]`)),
    queue: array(o['queue'], 'request/plan.queue').map((m, i) =>
      chatMessage(m, `request/plan.queue[${i}]`)),
    charter: text(o['charter'], 'request/plan.charter', false),
    heading: text(o['heading'], 'request/plan.heading', false),
  };
  return toJson(plan) as unknown as RequestPlan;
}

// --- scope and provenance helpers -------------------------------------------------

function turnScope(scope: GateScope, where: string): number {
  if (scope.phase !== 'turn' || scope.turn === null) fail(where, 'requires turn scope');
  return scope.turn as number;
}

function receipt(scope: GateScope, src: Source, where: string, type?: string): void {
  const envelope = scope.lookup(src);
  if (!envelope) fail(where, `missing receipt ${src.seq}:${src.hash}`);
  if (type !== undefined && envelope.type !== type) {
    fail(where, `receipt ${src.seq}:${src.hash} is ${envelope.type}, expected ${type}`);
  }
}

/** Requires each claimed source to resolve to a verified/pending receipt. */
function receipts(scope: GateScope, list: Source[], where: string, type?: string): void {
  for (const src of list) receipt(scope, src, where, type);
}

export function createBoundaryRegistry(): BoundaryRegistry {
  const registry: BoundaryRegistry = {
    'artifact/chunk': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'artifact/chunk');
      onlyKeys(o, ['artifact', 'index', 'base64'], 'artifact/chunk');
      return toJson({
        artifact: hash(o['artifact'], 'artifact/chunk.artifact'),
        index: safeInt(o['index'], 'artifact/chunk.index', 0),
        base64: base64(o['base64'], 'artifact/chunk.base64'),
      });
    },

    'artifact/end': (data: unknown, scope: GateScope): JsonValue => {
      const o = record(data, 'artifact/end');
      onlyKeys(o, ['artifact', 'sha256', 'bytes', 'encoding', 'complete', 'parts'], 'artifact/end');
      const artifact = hash(o['artifact'], 'artifact/end.artifact');
      const sha256 = hash(o['sha256'], 'artifact/end.sha256');
      if (artifact !== sha256) fail('artifact/end', 'artifact must equal sha256');
      const parts = array(o['parts'], 'artifact/end.parts').map((p, i) =>
        source(p, `artifact/end.parts[${i}]`));
      receipts(scope, parts, 'artifact/end.parts', 'artifact/chunk');
      return toJson({
        artifact, sha256, bytes: safeInt(o['bytes'], 'artifact/end.bytes', 0),
        encoding: encoding(o['encoding'], 'artifact/end.encoding'),
        complete: bool(o['complete'], 'artifact/end.complete'), parts,
      });
    },

    'system/message': (data: unknown, scope: GateScope): JsonValue => {
      const o = record(data, 'system/message');
      onlyKeys(o, ['version', 'value'], 'system/message');
      const version = safeInt(o['version'], 'system/message.version', 1);
      const value = record(o['value'], 'system/message.value');
      if (value['kind'] === 'inline') {
        onlyKeys(value, ['kind', 'value'], 'system/message.value');
        const config = validateAgentConfig(value['value']);
        if (config.version !== version) {
          fail('system/message', `version ${version} does not equal resolved version ${config.version}`);
        }
        return toJson({ version, value: { kind: 'inline', value: config } });
      }
      if (value['kind'] === 'artifact-json') {
        onlyKeys(value, ['kind', 'ref'], 'system/message.value');
        const ref = artifactRef(value['ref'], 'system/message.value.ref');
        // The inner version lives inside the captured blob; the fold re-validates
        // it during replay. Here the reference must resolve to a real manifest.
        receipt(scope, ref.manifest, 'system/message.value', 'artifact/end');
        return toJson({ version, value: { kind: 'artifact-json', ref } });
      }
      return fail('system/message.value', "kind must be 'inline' or 'artifact-json'");
    },

    'world/perception': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'world/perception');
      const o = record(data, 'world/perception');
      onlyKeys(o, ['turn', 'range', 'value'], 'world/perception');
      if (safeInt(o['turn'], 'world/perception.turn', 0) !== turn) {
        fail('world/perception', "turn does not match the scope's turn");
      }
      const range = worldRange(o['range'], 'world/perception.range');
      const value = record(o['value'], 'world/perception.value');
      if (value['kind'] === 'inline') {
        onlyKeys(value, ['kind', 'value'], 'world/perception.value');
        const perception = worldPerception(value['value'], 'world/perception.value');
        if (perception.range.from !== range.from || perception.range.to !== range.to) {
          fail('world/perception', 'resolved value.range does not equal the wrapper range');
        }
        return toJson({ turn, range, value: { kind: 'inline', value: perception } });
      }
      if (value['kind'] === 'artifact-json') {
        onlyKeys(value, ['kind', 'ref'], 'world/perception.value');
        const ref = artifactRef(value['ref'], 'world/perception.value.ref');
        receipt(scope, ref.manifest, 'world/perception.value', 'artifact/end');
        return toJson({ turn, range, value: { kind: 'artifact-json', ref } });
      }
      return fail('world/perception.value', "kind must be 'inline' or 'artifact-json'");
    },

    'request/plan': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'request/plan');
      const o = record(data, 'request/plan');
      onlyKeys(o, ['id', 'value'], 'request/plan');
      const id = requestId(o['id'], 'request/plan.id');
      if (id.turn !== turn) fail('request/plan', "id.turn does not match the scope's turn");
      const value = record(o['value'], 'request/plan.value');
      if (value['kind'] === 'inline') {
        onlyKeys(value, ['kind', 'value'], 'request/plan.value');
        return toJson({ id, value: { kind: 'inline', value: validateRequestPlan(value['value']) } });
      }
      if (value['kind'] === 'artifact-json') {
        onlyKeys(value, ['kind', 'ref'], 'request/plan.value');
        const ref = artifactRef(value['ref'], 'request/plan.value.ref');
        receipt(scope, ref.manifest, 'request/plan.value', 'artifact/end');
        return toJson({ id, value: { kind: 'artifact-json', ref } });
      }
      return fail('request/plan.value', "kind must be 'inline' or 'artifact-json'");
    },

    'request/refused': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'request/refused');
      const o = record(data, 'request/refused');
      onlyKeys(o, ['id', 'bytes', 'limit', 'phase'], 'request/refused');
      const id = requestId(o['id'], 'request/refused.id');
      if (id.turn !== turn) fail('request/refused', "id.turn does not match the scope's turn");
      if (o['phase'] !== 'plan') fail('request/refused.phase', "must be 'plan'");
      return toJson({
        id, bytes: safeInt(o['bytes'], 'request/refused.bytes', 0),
        limit: safeInt(o['limit'], 'request/refused.limit', 0), phase: 'plan',
      });
    },

    'request/wire': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'request/wire');
      const o = record(data, 'request/wire');
      onlyKeys(o, ['id', 'attempt', 'body'], 'request/wire');
      const id = requestId(o['id'], 'request/wire.id');
      if (id.turn !== turn) fail('request/wire', "id.turn does not match the scope's turn");
      const body = artifactRef(o['body'], 'request/wire.body');
      receipt(scope, body.manifest, 'request/wire.body', 'artifact/end');
      return toJson({ id, attempt: safeInt(o['attempt'], 'request/wire.attempt', 0), body });
    },

    'response/raw': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'response/raw');
      const o = record(data, 'response/raw');
      onlyKeys(o, ['id', 'attempt', 'status', 'body', 'complete'], 'response/raw');
      const id = requestId(o['id'], 'response/raw.id');
      if (id.turn !== turn) fail('response/raw', "id.turn does not match the scope's turn");
      const body = artifactRef(o['body'], 'response/raw.body');
      receipt(scope, body.manifest, 'response/raw.body', 'artifact/end');
      return toJson({
        id, attempt: safeInt(o['attempt'], 'response/raw.attempt', 0),
        status: safeInt(o['status'], 'response/raw.status', 0),
        body, complete: bool(o['complete'], 'response/raw.complete'),
      });
    },

    'request/usage': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'request/usage');
      const o = record(data, 'request/usage');
      onlyKeys(o, ['id', 'attempt', 'value'], 'request/usage');
      const id = requestId(o['id'], 'request/usage.id');
      if (id.turn !== turn) fail('request/usage', "id.turn does not match the scope's turn");
      return toJson({
        id, attempt: safeInt(o['attempt'], 'request/usage.attempt', 0),
        value: usage(o['value'], 'request/usage.value'),
      });
    },

    'assistant/message': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'assistant/message');
      const o = record(data, 'assistant/message');
      onlyKeys(o, ['id', 'value'], 'assistant/message');
      const id = requestId(o['id'], 'assistant/message.id');
      if (id.turn !== turn) fail('assistant/message', "id.turn does not match the scope's turn");
      const value = record(o['value'], 'assistant/message.value');
      if (value['kind'] === 'inline') {
        onlyKeys(value, ['kind', 'value'], 'assistant/message.value');
        const projection = record(value['value'], 'assistant/message.value.value');
        onlyKeys(projection, ['message', 'contentTruncated', 'raw'], 'assistant/message.value.value');
        const message = chatMessage(projection['message'], 'assistant/message.value.value.message');
        if (message.role !== 'assistant') fail('assistant/message.value.value.message', 'must be assistant');
        const raw = artifactRef(projection['raw'], 'assistant/message.value.value.raw');
        receipt(scope, raw.manifest, 'assistant/message.value.value.raw', 'artifact/end');
        return toJson({
          id,
          value: {
            kind: 'inline',
            value: {
              message, raw,
              contentTruncated: bool(projection['contentTruncated'], 'assistant/message.value.value.contentTruncated'),
            } satisfies AssistantProjection,
          },
        });
      }
      if (value['kind'] === 'artifact-json') {
        onlyKeys(value, ['kind', 'ref'], 'assistant/message.value');
        const ref = artifactRef(value['ref'], 'assistant/message.value.ref');
        receipt(scope, ref.manifest, 'assistant/message.value', 'artifact/end');
        return toJson({ id, value: { kind: 'artifact-json', ref } });
      }
      return fail('assistant/message.value', "kind must be 'inline' or 'artifact-json'");
    },

    'assistant/attempt': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'assistant/attempt');
      const o = record(data, 'assistant/attempt');
      onlyKeys(o, ['id', 'attempt', 'failure', 'terminal'], 'assistant/attempt');
      const id = requestId(o['id'], 'assistant/attempt.id');
      if (id.turn !== turn) fail('assistant/attempt', "id.turn does not match the scope's turn");
      return toJson({
        id, attempt: safeInt(o['attempt'], 'assistant/attempt.attempt', 0),
        failure: safeFailure(o['failure'], 'assistant/attempt.failure'),
        terminal: bool(o['terminal'], 'assistant/attempt.terminal'),
      });
    },

    'tool/call': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'tool/call');
      const o = record(data, 'tool/call');
      onlyKeys(o, ['turn', 'request', 'call'], 'tool/call');
      if (safeInt(o['turn'], 'tool/call.turn', 0) !== turn) {
        fail('tool/call', "turn does not match the scope's turn");
      }
      const request = requestId(o['request'], 'tool/call.request');
      if (request.turn !== turn) fail('tool/call', "request.turn does not match the scope's turn");
      return toJson({ turn, request, call: functionCall(o['call'], 'tool/call.call') });
    },

    'tool/result': (data: unknown, scope: GateScope): JsonValue => {
      const o = record(data, 'tool/result');
      onlyKeys(o, [
        'turn', 'request', 'callId', 'message', 'isError', 'raw', 'failure', 'synthetic',
      ], 'tool/result');
      const synthetic = bool(o['synthetic'], 'tool/result.synthetic');
      const turn = safeInt(o['turn'], 'tool/result.turn', 0);
      const request = requestId(o['request'], 'tool/result.request');
      if (scope.phase === 'turn') {
        if (turn !== scope.turn) fail('tool/result', "turn does not match the scope's turn");
        if (request.turn !== scope.turn) {
          fail('tool/result', "request.turn does not match the scope's turn");
        }
      } else if (!synthetic) {
        fail('tool/result', 'a ready-scope tool/result must be synthetic');
      }
      const message = chatMessage(o['message'], 'tool/result.message');
      if (message.role !== 'tool') fail('tool/result.message', 'must be a tool message');
      const raw = o['raw'] === null ? null : artifactRef(o['raw'], 'tool/result.raw');
      if (raw !== null) receipt(scope, raw.manifest, 'tool/result.raw', 'artifact/end');
      const failure = o['failure'] === null ? null : safeFailure(o['failure'], 'tool/result.failure');
      return toJson({
        turn, request, callId: text(o['callId'], 'tool/result.callId'), message,
        isError: bool(o['isError'], 'tool/result.isError'),
        raw, failure, synthetic,
      });
    },

    'compaction/start': (data: unknown, scope: GateScope): JsonValue => {
      turnScope(scope, 'compaction/start');
      const o = record(data, 'compaction/start');
      onlyKeys(o, ['id', 'revision', 'groupIds', 'sources', 'shadowHash', 'shadowBytes'], 'compaction/start');
      const groupIds = array(o['groupIds'], 'compaction/start.groupIds').map((s, i) =>
        source(s, `compaction/start.groupIds[${i}]`));
      const sources = array(o['sources'], 'compaction/start.sources').map((s, i) =>
        source(s, `compaction/start.sources[${i}]`));
      receipts(scope, groupIds, 'compaction/start.groupIds');
      receipts(scope, sources, 'compaction/start.sources');
      return toJson({
        id: text(o['id'], 'compaction/start.id'),
        revision: text(o['revision'], 'compaction/start.revision'),
        groupIds, sources,
        shadowHash: hash(o['shadowHash'], 'compaction/start.shadowHash'),
        shadowBytes: safeInt(o['shadowBytes'], 'compaction/start.shadowBytes', 0),
      });
    },

    'compaction/summary': (data: unknown, scope: GateScope): JsonValue => {
      turnScope(scope, 'compaction/summary');
      const o = record(data, 'compaction/summary');
      onlyKeys(o, ['id', 'message', 'sources', 'replacementBytes'], 'compaction/summary');
      const message = chatMessage(o['message'], 'compaction/summary.message');
      if (message.role !== 'user') fail('compaction/summary.message', 'must be a user message');
      const sources = array(o['sources'], 'compaction/summary.sources').map((s, i) =>
        source(s, `compaction/summary.sources[${i}]`));
      receipts(scope, sources, 'compaction/summary.sources');
      return toJson({
        id: text(o['id'], 'compaction/summary.id'), message, sources,
        replacementBytes: safeInt(o['replacementBytes'], 'compaction/summary.replacementBytes', 0),
      });
    },

    'compaction/end': (data: unknown, scope: GateScope): JsonValue => {
      turnScope(scope, 'compaction/end');
      const o = record(data, 'compaction/end');
      onlyKeys(o, ['id', 'summary'], 'compaction/end');
      const summary = source(o['summary'], 'compaction/end.summary');
      receipt(scope, summary, 'compaction/end.summary', 'compaction/summary');
      return toJson({ id: text(o['id'], 'compaction/end.id'), summary });
    },

    'compaction/abort': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'compaction/abort');
      onlyKeys(o, ['id', 'reason'], 'compaction/abort');
      if (o['reason'] !== 'stale' && o['reason'] !== 'orphan') {
        fail('compaction/abort.reason', "must be 'stale' or 'orphan'");
      }
      return toJson({ id: text(o['id'], 'compaction/abort.id'), reason: o['reason'] });
    },
  };
  return registry;
}
