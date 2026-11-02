import type { JsonValue } from '../journal/index.js';
import { NODE_EVENT_TYPES } from '../node/events.js';
import type { GateScope, BoundaryRegistry } from '../node/gate.js';
import {
  MAX_ERROR_DETAIL_BYTES, MAX_PACKAGE_NAME_CHARS, MAX_PACKAGE_PURPOSE_CHARS,
} from '../node/packages/constants.js';
import type { CallId } from '../frontier/index.js';
import type { WorldRange } from '../node/world.js';
import { toJson } from './artifacts.js';
import { validateAgentConfig } from './config.js';
import { RENDER_POLICIES } from './contracts.js';
import type { RenderPolicy } from './contracts.js';
import { MAX_MODEL_CONTEXT_TOKENS } from './meter.js';
import { GATE_DIALECT, createValidator } from './validate.js';
import type {
  AgentConfig, ArtifactChunk, ArtifactManifest, ArtifactRef, AssistantAccounting,
  AssistantProjection, ChatMessage, CompactionAbort, CompactionEnd, CompactionReplacement,
  CompactionStart, CompactionSummary, ErrorCode, FunctionCall, MeterRecord, MeterUsage, RequestId,
  SafeFailure, Source, Stored, WorldPerception,
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
  /**
   * The assistant projection plus, when the provider reported an adoptable
   * usage, the anchor's sample — {headerDigest, surfacePriceAtSample, usage} —
   * journaled TOGETHER (A7). The optional field is additive: an old event
   * (absent field) replays untouched and reads as absent, and no `request/usage`
   * event returns (that local type stays retired).
   */
  'assistant/message': {
    id: RequestId; value: Stored<AssistantProjection>; accounting?: AssistantAccounting;
  };
  'tool/call': { turn: number; request: RequestId; call: FunctionCall };
  'tool/result': {
    turn: number; request: RequestId; callId: string;
    message: Extract<ChatMessage, { role: 'tool' }>; isError: boolean;
    raw: ArtifactRef | null; failure: SafeFailure | null; synthetic: boolean;
    /** The frontier call that produced this result, when one did; never for execute/wait. */
    frontierCall: CallId | null;
  };
  /**
   * The candidate plus, for a token-triggered transaction, the kernel-owned
   * decision numbers as an optional `meter` payload (A7). The candidate's own
   * shape and id never move; the reader skips the companion field.
   */
  'compaction/start': CompactionStart & { meter?: MeterRecord };
  'compaction/summary': CompactionSummary;
  'compaction/end': CompactionEnd;
  'compaction/abort': CompactionAbort;
  /**
   * The C1.5 package vocabulary (kernel.md, the local-log sections): each type
   * records one kernel-mediated package fact. Scope-free (appendable at ready
   * and turn scope), all ignorable (an older reader skips them), and none ever
   * carries package source bytes or a credential — identities, declared names,
   * digests and bounded sanitized detail only.
   */
  'package/define': { id: string; name: string; purpose: string; sourceBytes: number };
  'package/run': { id: string; runId: string; sandbox: 'landlock' | 'off' };
  'package/stop': { id: string; runId: string; reason: 'verb' | 'host-stop' };
  'package/undefine': { id: string };
  'package/effect': { id: string; runId: string; kind: 'tool-registered'; tool: string };
  'package/error': {
    id: string; runId: string | null;
    code: 'corrupt' | 'crashed' | 'timeout' | 'protocol'; detail: string;
  };
  'package/service': {
    id: string; runId: string;
    service: 'execute' | 'web_search' | 'web_fetch';
    subjectHash: string; ok: boolean; status: string;
  };
}

// The declared shape of the config payload is AgentConfig; the runtime validator
// is validateAgentConfig, so the map names the same shape the fold resolves.

declare module '../journal/envelope.js' {
  interface EventDataMap extends ContextEventDataMap {}
}

declare module '../node/gate.js' {
  interface BoundaryDataMap extends ContextEventDataMap {}
}

/**
 * One row per event type; the row's boolean is the type's ignorable default —
 * the envelope flag's one home. `false` (all pre-C1.5 types): an older reader
 * must refuse an unknown event of that type. `true` (the package family): an
 * older reader skips it — none is load-bearing for the fold's sequencing
 * proofs, so none may block a rebuild.
 */
const REGISTERED: Record<keyof ContextEventDataMap, boolean> = {
  'artifact/chunk': false, 'artifact/end': false, 'system/message': false,
  'world/perception': false, 'request/refused': false, 'assistant/message': false,
  'tool/call': false, 'tool/result': false,
  'compaction/start': false, 'compaction/summary': false, 'compaction/end': false,
  'compaction/abort': false,
  'package/define': true, 'package/run': true, 'package/stop': true,
  'package/undefine': true, 'package/effect': true, 'package/error': true,
  'package/service': true,
};

/** Every event type a C1.5 reader/replay must know: the node lifecycle union the context types. */
export const C13_EVENT_TYPES: ReadonlySet<string> =
  new Set([...NODE_EVENT_TYPES, ...Object.keys(REGISTERED)]);

/** The per-type ignorable default of the one home; an unknown type is non-ignorable. */
export function eventIgnorableDefault(type: string): boolean {
  const known = (REGISTERED as Record<string, boolean | undefined>)[type];
  return known === true;
}

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
  'context-exceeded': true,
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

// --- package vocabulary helpers ---------------------------------------------

const RUN_ID_RE = /^[0-9a-f]{32}$/;

/** A run identity: 32 lowercase hex characters, the fresh id of one Run leaf. */
function runIdOf(value: unknown, where: string): string {
  const s = text(value, where);
  if (!RUN_ID_RE.test(s)) fail(where, 'expected 32 lowercase hex characters');
  return s;
}

/** A declared string with the vocabulary's own length bound (name, purpose, tool). */
function declaredText(value: unknown, where: string, maxChars: number): string {
  const s = text(value, where);
  if (s.length > maxChars) fail(where, `expected at most ${maxChars} characters`);
  return s;
}

/**
 * Guest-produced bounded detail (the `package/error` detail, the
 * `package/service` status): at most `MAX_ERROR_DETAIL_BYTES` UTF-8 bytes and
 * no control characters other than newline and tab — sanitized before it can
 * be journaled, never a raw capture.
 */
function boundedDetail(value: unknown, where: string): string {
  const s = text(value, where, false);
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && ch !== '\n' && ch !== '\t') || code === 0x7f) {
      fail(where, 'control characters are not journalable detail');
    }
  }
  if (Buffer.byteLength(s, 'utf8') > MAX_ERROR_DETAIL_BYTES) {
    fail(where, `detail exceeds ${MAX_ERROR_DETAIL_BYTES} bytes`);
  }
  return s;
}

/** A frozen vocabulary value; the `where` names the refusing field. */
function enumOf<T extends string>(
  value: unknown, where: string, allowed: readonly T[],
): T {
  const s = text(value, where);
  if (!(allowed as readonly string[]).includes(s)) {
    fail(where, `expected one of ${allowed.join(' | ')}`);
  }
  return s as T;
}

function worldPerception(value: unknown, where: string): WorldPerception {
  const o = record(value, where);
  onlyKeys(o, [
    'uid', 'range', 'effectiveFrom', 'fallback', 'renderer', 'maxBytes', 'maxCommits',
    'listTruncated', 'commits', 'included', 'omittedOwn', 'text', 'truncated',
  ], where);
  const renderer = record(o['renderer'], `${where}.renderer`);
  onlyKeys(renderer, ['policy', 'gitVersion', 'attrSource'], `${where}.renderer`);
  // The accepted policy set (RENDER_POLICIES, spelled once in contracts): v1 is
  // the oldest-first budgeting (journals recorded before the friction pass 2
  // replay unchanged), v2 is the newest-first budgeting. A policy outside the
  // set is a refusal, never a silent byte-mismatch across renderer versions.
  const policy = text(renderer['policy'], `${where}.renderer.policy`);
  if (!(RENDER_POLICIES as readonly string[]).includes(policy)) {
    fail(`${where}.renderer.policy`, 'unknown policy');
  }
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
    renderer: {
      policy: policy as RenderPolicy,
      gitVersion: text(renderer['gitVersion'], `${where}.renderer.gitVersion`),
      attrSource: 'to',
    },
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
 * One normalized usage (A2(iii)): non-negative safe integers, the exact
 * `total = prompt + completion` identity, and the cached subset (which is
 * already INSIDE the prompt, so it is never added) bounded by it. The adapter
 * flattens a malformed body before this shape can be appended; a chain-valid
 * event that still disagrees is a forged payload and fails here.
 */
function meterUsage(value: unknown, where: string): MeterUsage {
  const o = record(value, where);
  onlyKeys(o, ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens'], where);
  const promptTokens = safeInt(o['promptTokens'], `${where}.promptTokens`, 0);
  const completionTokens = safeInt(o['completionTokens'], `${where}.completionTokens`, 0);
  const totalTokens = safeInt(o['totalTokens'], `${where}.totalTokens`, 0);
  if (totalTokens !== promptTokens + completionTokens) {
    fail(`${where}.totalTokens`, 'must equal promptTokens + completionTokens');
  }
  if (totalTokens > MAX_MODEL_CONTEXT_TOKENS) {
    fail(`${where}.totalTokens`, 'exceeds the declared-window ceiling');
  }
  let cachedTokens: number | null = null;
  if (o['cachedTokens'] !== null) {
    cachedTokens = safeInt(o['cachedTokens'], `${where}.cachedTokens`, 0);
    if (cachedTokens > promptTokens) {
      fail(`${where}.cachedTokens`, 'must not exceed promptTokens');
    }
  }
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

/**
 * The typed replacement outcome of one applied compaction (A5): exactly the
 * three journaled literals. The field is optional for pre-wave records (an
 * absent field reads as the notice); a present but unknown value is refused.
 */
function compactionReplacement(value: unknown): CompactionReplacement {
  if (value !== 'authored-applied' && value !== 'authored-too-large-fallback-notice'
    && value !== 'no-pending-notice') {
    fail('compaction/summary.replacement', "expected 'authored-applied',"
      + " 'authored-too-large-fallback-notice' or 'no-pending-notice'");
  }
  return value;
}

/** The anchor's journaled sample (A2(ii)/A7): header identity, sample surface price, usage. */
function assistantAccounting(value: unknown, where: string): AssistantAccounting {
  const o = record(value, where);
  onlyKeys(o, ['headerDigest', 'surfacePriceAtSample', 'usage'], where);
  return {
    headerDigest: hash(o['headerDigest'], `${where}.headerDigest`),
    surfacePriceAtSample: safeInt(
      o['surfacePriceAtSample'], `${where}.surfacePriceAtSample`, 0),
    usage: meterUsage(o['usage'], `${where}.usage`),
  };
}

/** One published percent: a finite number in [0, 100], one decimal at the producer. */
function percentValue(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    fail(where, 'expected a finite number in [0, 100]');
  }
  return value;
}

/**
 * The kernel-owned decision numbers of a token-triggered compaction (A7). The
 * window and the output reservation are HOST facts copied into the record (a
 * store edit between boots never rewrites a decision); `threshold` is positive
 * because a degenerate reservation is refused before any transaction.
 */
function meterRecord(value: unknown, where: string): MeterRecord {
  const o = record(value, where);
  onlyKeys(o, [
    'window', 'output', 'headroom', 'threshold', 'percent', 'estimate', 'anchor', 'outcome',
  ], where);
  const anchor = o['anchor'];
  if (anchor !== 'usage' && anchor !== 'estimate') {
    fail(`${where}.anchor`, "expected 'usage' or 'estimate'");
  }
  if (o['outcome'] !== 'compact') fail(`${where}.outcome`, "must be 'compact'");
  return {
    window: safeInt(o['window'], `${where}.window`, 1, MAX_MODEL_CONTEXT_TOKENS),
    output: safeInt(o['output'], `${where}.output`, 0),
    headroom: safeInt(o['headroom'], `${where}.headroom`, 0),
    threshold: safeInt(o['threshold'], `${where}.threshold`, 1),
    percent: percentValue(o['percent'], `${where}.percent`),
    estimate: safeInt(o['estimate'], `${where}.estimate`, 0),
    anchor,
    outcome: 'compact',
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
      const { o, id } = requestScoped(
        data, scope, 'assistant/message', ['id', 'value', 'accounting']);
      const value = storedValue<AssistantProjection>(
        scope, o['value'], 'assistant/message.value', (raw) =>
          assistantProjection(raw, 'assistant/message.value.value'),
      );
      // The anchor's sample is optional and additive: absent stays absent (an
      // old event replays untouched), present is validated whole. It is the one
      // key this request-scoped payload grew (A7), and it brings no event type.
      const accounting = o['accounting'] === undefined
        ? undefined
        : assistantAccounting(o['accounting'], 'assistant/message.accounting');
      return toJson({ id, value, ...(accounting !== undefined ? { accounting } : {}) });
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
      const raw = record(data, 'compaction/start');
      const meter = raw['meter'] === undefined
        ? undefined
        : meterRecord(raw['meter'], 'compaction/start.meter');
      const start = v.compactionStart(data, 'compaction/start', ['meter']);
      receipts(scope, start.groupIds, 'compaction/start.groupIds');
      receipts(scope, start.sources, 'compaction/start.sources');
      return toJson({ ...start, ...(meter !== undefined ? { meter } : {}) });
    },

    'compaction/summary': (data: unknown, scope: GateScope): JsonValue => {
      turnScope(scope, 'compaction/summary');
      const o = record(data, 'compaction/summary');
      onlyKeys(o, [
        'id', 'message', 'sources', 'replacementBytes', 'replacement',
      ], 'compaction/summary');
      const message = chatMessage(o['message'], 'compaction/summary.message');
      if (message.role !== 'user') fail('compaction/summary.message', 'must be a user message');
      const sources = array(o['sources'], 'compaction/summary.sources').map((s, i) =>
        source(s, `compaction/summary.sources[${i}]`));
      receipts(scope, sources, 'compaction/summary.sources');
      const replacement = o['replacement'] === undefined
        ? undefined : compactionReplacement(o['replacement']);
      return toJson({
        id: hash(o['id'], 'compaction/summary.id'), message, sources,
        replacementBytes: safeInt(o['replacementBytes'], 'compaction/summary.replacementBytes', 0),
        ...(replacement !== undefined
          ? { replacement: replacement as CompactionReplacement } : {}),
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

    // --- the C1.5 package vocabulary: scope-free, digest-and-identity only ---

    'package/define': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'package/define');
      onlyKeys(o, ['id', 'name', 'purpose', 'sourceBytes'], 'package/define');
      return toJson({
        id: hash(o['id'], 'package/define.id'),
        name: declaredText(o['name'], 'package/define.name', MAX_PACKAGE_NAME_CHARS),
        purpose: declaredText(o['purpose'], 'package/define.purpose', MAX_PACKAGE_PURPOSE_CHARS),
        sourceBytes: safeInt(o['sourceBytes'], 'package/define.sourceBytes', 0),
      });
    },

    'package/run': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'package/run');
      onlyKeys(o, ['id', 'runId', 'sandbox'], 'package/run');
      return toJson({
        id: hash(o['id'], 'package/run.id'),
        runId: runIdOf(o['runId'], 'package/run.runId'),
        sandbox: enumOf(o['sandbox'], 'package/run.sandbox', ['landlock', 'off']),
      });
    },

    'package/stop': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'package/stop');
      onlyKeys(o, ['id', 'runId', 'reason'], 'package/stop');
      return toJson({
        id: hash(o['id'], 'package/stop.id'),
        runId: runIdOf(o['runId'], 'package/stop.runId'),
        reason: enumOf(o['reason'], 'package/stop.reason', ['verb', 'host-stop']),
      });
    },

    'package/undefine': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'package/undefine');
      onlyKeys(o, ['id'], 'package/undefine');
      return toJson({ id: hash(o['id'], 'package/undefine.id') });
    },

    'package/effect': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'package/effect');
      onlyKeys(o, ['id', 'runId', 'kind', 'tool'], 'package/effect');
      return toJson({
        id: hash(o['id'], 'package/effect.id'),
        runId: runIdOf(o['runId'], 'package/effect.runId'),
        kind: enumOf(o['kind'], 'package/effect.kind', ['tool-registered']),
        tool: declaredText(o['tool'], 'package/effect.tool', MAX_PACKAGE_NAME_CHARS),
      });
    },

    'package/error': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'package/error');
      onlyKeys(o, ['id', 'runId', 'code', 'detail'], 'package/error');
      return toJson({
        id: hash(o['id'], 'package/error.id'),
        // `runId` is optional in the design: a boot-time corrupt error has no
        // Run. An omitted key and an explicit null normalize to the one
        // canonical journal form (runId: null).
        runId: o['runId'] === undefined || o['runId'] === null
          ? null
          : runIdOf(o['runId'], 'package/error.runId'),
        code: enumOf(o['code'], 'package/error.code', [
          'corrupt', 'crashed', 'timeout', 'protocol',
        ]),
        detail: boundedDetail(o['detail'], 'package/error.detail'),
      });
    },

    'package/service': (data: unknown, _scope: GateScope): JsonValue => {
      const o = record(data, 'package/service');
      onlyKeys(o, ['id', 'runId', 'service', 'subjectHash', 'ok', 'status'], 'package/service');
      return toJson({
        id: hash(o['id'], 'package/service.id'),
        runId: runIdOf(o['runId'], 'package/service.runId'),
        service: enumOf(o['service'], 'package/service.service', [
          'execute', 'web_search', 'web_fetch',
        ]),
        subjectHash: hash(o['subjectHash'], 'package/service.subjectHash'),
        ok: bool(o['ok'], 'package/service.ok'),
        status: boundedDetail(o['status'], 'package/service.status'),
      });
    },
  };
  return registry;
}
