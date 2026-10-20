import type { JsonValue } from '../journal/index.js';
import { NODE_EVENT_TYPES } from '../node/events.js';
import type { GateScope, BoundaryRegistry } from '../node/gate.js';
import type { CallId } from '../frontier/index.js';
import type { WorldRange } from '../node/world.js';
import { toJson } from './artifacts.js';
import { validateAgentConfig } from './config.js';
import { GATE_DIALECT, createValidator } from './validate.js';
import type {
  AgentConfig, ArtifactChunk, ArtifactManifest, ArtifactRef, AssistantProjection,
  ChatMessage, CompactionAbort, CompactionEnd, CompactionStart, CompactionSummary, ErrorCode,
  FunctionCall, RequestId, SafeFailure, Source, Stored, WorldPerception,
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
  'request/refused': { id: RequestId; bytes: number; limit: number; phase: 'plan' };
  'assistant/message': { id: RequestId; value: Stored<AssistantProjection> };
  'tool/call': { turn: number; request: RequestId; call: FunctionCall };
  'tool/result': {
    turn: number; request: RequestId; callId: string;
    message: Extract<ChatMessage, { role: 'tool' }>; isError: boolean;
    raw: ArtifactRef | null; failure: SafeFailure | null; synthetic: boolean;
    /** The frontier call that produced this result, when one did; never for execute/wait. */
    frontierCall: CallId | null;
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
  'request/refused': true, 'assistant/message': true, 'tool/call': true, 'tool/result': true,
  'compaction/start': true, 'compaction/summary': true, 'compaction/end': true,
  'compaction/abort': true,
};

/** Every event type a C1.3 reader/replay must know: the node lifecycle union the context types. */
export const C13_EVENT_TYPES: ReadonlySet<string> =
  new Set([...NODE_EVENT_TYPES, ...Object.keys(REGISTERED)]);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Every error code the vocabulary admits. `satisfies Record<ErrorCode, true>`
 * ties the table to the union: adding a code to either side alone fails
 * typecheck, so the validator and `SafeFailure` can never silently drift.
 */
const ERROR_CODES = {
  http: true, network: true, timeout: true, cancelled: true, malformed: true,
  'body-limit': true, 'invalid-tool': true, 'unknown-tool': true, denied: true,
  spawn: true, signal: true, 'output-limit': true, 'request-limit': true,
} satisfies Record<ErrorCode, true>;

function fail(where: string, message: string): never {
  throw new Error(`invalid ${where}: ${message}`);
}

/** The shared primitives, bound to the gate's original error vocabulary. */
const v = createValidator(fail, GATE_DIALECT);
const {
  record, onlyKeys, text, bool, safeInt, array, source, requestId, worldRange,
  functionCall, chatMessage,
} = v;

function nullableHash(value: unknown, where: string): string | null {
  if (value === null) return null;
  return text(value, where);
}

function hash(value: unknown, where: string): string {
  return v.hash(value, where);
}

function encoding(value: unknown, where: string): 'utf8' | 'binary' {
  if (value !== 'utf8' && value !== 'binary') fail(where, "expected 'utf8' or 'binary'");
  return value;
}

function base64(value: unknown, where: string): string {
  const s = text(value, where, false);
  if (s.length % 4 !== 0 || !BASE64_RE.test(s)
    || Buffer.from(s, 'base64').toString('base64') !== s) {
    fail(where, 'expected canonical base64');
  }
  return s;
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

function safeFailure(value: unknown, where: string): SafeFailure {
  const o = record(value, where);
  onlyKeys(o, ['code', 'status'], where);
  const code = text(o['code'], `${where}.code`);
  if (!Object.hasOwn(ERROR_CODES, code)) {
    fail(`${where}.code`, `unknown error code ${JSON.stringify(code)}`);
  }
  const status = o['status'] === null ? null : safeInt(o['status'], `${where}.status`, 0);
  return { code: code as ErrorCode, status };
}

/** A frontier call reference: a nonempty string, structurally a `CallId`. */
function frontierCall(value: unknown, where: string): CallId {
  const call = text(value, where);
  if (call.length === 0) fail(where, 'must be a nonempty string');
  return call;
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
 * Validates a resolved `AssistantProjection` (the stored payload the fold
 * parses) and requires the frontier call that produced it: the raw artifact
 * back-pointer is gone — the frontier journal holds the exchange.
 */
function assistantProjection(value: unknown, where: string): AssistantProjection {
  const o = record(value, where);
  onlyKeys(o, ['message', 'contentTruncated', 'frontierCall'], where);
  const message = chatMessage(o['message'], `${where}.message`);
  if (message.role !== 'assistant') fail(`${where}.message`, 'must be assistant');
  return {
    message,
    contentTruncated: bool(o['contentTruncated'], `${where}.contentTruncated`),
    frontierCall: frontierCall(o['frontierCall'], `${where}.frontierCall`),
  };
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

/**
 * The preamble every request-scoped payload shares: a turn scope, an exact key
 * set, a request id and the id/scope turn agreement. Payload-specific checks
 * follow; this is the one place the agreement is spelled.
 */
function requestScoped(
  data: unknown, scope: GateScope, where: string, allowed: readonly string[],
): { readonly turn: number; readonly o: Record<string, unknown>; readonly id: RequestId } {
  const turn = turnScope(scope, where);
  const o = record(data, where);
  onlyKeys(o, allowed, where);
  const id = requestId(o['id'], `${where}.id`);
  if (id.turn !== turn) fail(where, "id.turn does not match the scope's turn");
  return { turn, o, id };
}

/**
 * The one `Stored<T>` branch: inline values are decoded by the caller, artifact
 * references must resolve to a real `artifact/end` manifest. Every stored
 * payload in the vocabulary shares this shape, so the branch lives here once.
 */
function storedValue<T>(
  scope: GateScope, value: unknown, where: string,
  decodeInline: (value: unknown) => T,
): Stored<T> {
  const o = record(value, where);
  if (o['kind'] === 'inline') {
    onlyKeys(o, ['kind', 'value'], where);
    return { kind: 'inline', value: decodeInline(o['value']) };
  }
  if (o['kind'] === 'artifact-json') {
    onlyKeys(o, ['kind', 'ref'], where);
    const ref = artifactRef(o['ref'], `${where}.ref`);
    receipt(scope, ref.manifest, where, 'artifact/end');
    return { kind: 'artifact-json', ref };
  }
  return fail(where, "kind must be 'inline' or 'artifact-json'");
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
      // Inline configs are version-bound here; an artifact's version lives inside
      // the captured blob, which the fold re-validates during replay.
      const value = storedValue<AgentConfig>(scope, o['value'], 'system/message.value', (raw) => {
        const config = validateAgentConfig(raw);
        if (config.version !== version) {
          fail('system/message', `version ${version} does not equal resolved version ${config.version}`);
        }
        return config;
      });
      return toJson({ version, value });
    },

    'world/perception': (data: unknown, scope: GateScope): JsonValue => {
      const turn = turnScope(scope, 'world/perception');
      const o = record(data, 'world/perception');
      onlyKeys(o, ['turn', 'range', 'value'], 'world/perception');
      if (safeInt(o['turn'], 'world/perception.turn', 0) !== turn) {
        fail('world/perception', "turn does not match the scope's turn");
      }
      const range = worldRange(o['range'], 'world/perception.range');
      const value = storedValue<WorldPerception>(
        scope, o['value'], 'world/perception.value', (raw) => {
          const perception = worldPerception(raw, 'world/perception.value');
          if (perception.range.from !== range.from || perception.range.to !== range.to) {
            fail('world/perception', 'resolved value.range does not equal the wrapper range');
          }
          return perception;
        },
      );
      return toJson({ turn, range, value });
    },

    'request/refused': (data: unknown, scope: GateScope): JsonValue => {
      const { o, id } = requestScoped(
        data, scope, 'request/refused', ['id', 'bytes', 'limit', 'phase']);
      if (o['phase'] !== 'plan') fail('request/refused.phase', "must be 'plan'");
      return toJson({
        id, bytes: safeInt(o['bytes'], 'request/refused.bytes', 0),
        limit: safeInt(o['limit'], 'request/refused.limit', 0), phase: 'plan',
      });
    },

    'assistant/message': (data: unknown, scope: GateScope): JsonValue => {
      const { o, id } = requestScoped(data, scope, 'assistant/message', ['id', 'value']);
      const value = storedValue<AssistantProjection>(
        scope, o['value'], 'assistant/message.value', (raw) =>
          assistantProjection(raw, 'assistant/message.value.value'),
      );
      return toJson({ id, value });
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
        'frontierCall',
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
        frontierCall: o['frontierCall'] === null
          ? null : frontierCall(o['frontierCall'], 'tool/result.frontierCall'),
      });
    },

    'compaction/start': (data: unknown, scope: GateScope): JsonValue => {
      turnScope(scope, 'compaction/start');
      const start = v.compactionStart(data, 'compaction/start');
      receipts(scope, start.groupIds, 'compaction/start.groupIds');
      receipts(scope, start.sources, 'compaction/start.sources');
      return toJson(start);
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
        id: hash(o['id'], 'compaction/summary.id'), message, sources,
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
