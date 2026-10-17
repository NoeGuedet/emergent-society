import { HASH_RE } from '../journal/index.js';
import { isRecord } from '../util.js';
import type { WorldRange } from '../node/world.js';
import type {
  ChatMessage, CompactionStart, FunctionCall, RequestId, Source,
} from './contracts.js';

/**
 * The one home for the schema primitives the context layer parses with.
 *
 * Gate payloads (`events.ts`) and projection checkpoints (`snapshots.ts`) parse
 * overlapping shapes — sources, request ids, function calls, chat messages,
 * compaction starts — and each used to carry its own copy. The copies agreed on
 * types but not on wording, so every primitive takes the caller's `fail` style:
 * the gate keeps `invalid <where>: <message>`, the snapshot parser keeps
 * `invalid snapshot at <where>: <message>`, and the config validator keeps
 * `<where>: <message>`. Extracting them must not silently change any message.
 *
 * Empty text is accepted by both old parsers but at different strengths: the
 * gate deliberately folds `""` chat content and arguments (a provider may emit
 * them) while still requiring nonempty strings by default elsewhere, and the
 * snapshot parser's `text` never required one at all. `ShapeDialect` carries
 * both switches (`allowEmptyText` and `textNonEmpty`) instead of flattening
 * them, so neither caller's acceptance set changes.
 */

/** Produces a caller's exact error vocabulary. */
export type Fail = (where: string, message: string) => never;

/**
 * The shape wording a caller already used. `allowEmptyText` controls chat
 * content and function arguments; `textNonEmpty` is the default for generic
 * `text` fields (the gate requires nonempty, the snapshot parser did not).
 * `safeIntMessage` preserves each caller's out-of-range wording, and
 * `functionTypeError`/`unknownRoleAt` preserve the discriminant error location.
 */
export type ShapeDialect = {
  readonly allowEmptyText: boolean;
  readonly textNonEmpty: boolean;
  readonly safeIntMessage: (min: number, max: number) => string;
  readonly functionTypeError: {
    readonly at: (where: string) => string;
    readonly message: string;
  };
  readonly unknownRoleAt: (where: string) => string;
};

/** The gate's original vocabulary: nonempty by default, empty content/args allowed. */
export const GATE_DIALECT: ShapeDialect = {
  allowEmptyText: true,
  textNonEmpty: true,
  safeIntMessage: (min, max) => `expected a safe integer in [${min}, ${max}]`,
  functionTypeError: { at: (where) => where, message: "type must be 'function'" },
  unknownRoleAt: (where) => where,
};

/**
 * The snapshot parser's original vocabulary: empty strings are accepted
 * everywhere (its old `text` never required one), and errors point at `.type`
 * / `.role`.
 */
export const SNAPSHOT_DIALECT: ShapeDialect = {
  allowEmptyText: true,
  textNonEmpty: false,
  safeIntMessage: (min) => `expected a safe integer >= ${min}`,
  functionTypeError: { at: (where) => `${where}.type`, message: 'expected "function"' },
  unknownRoleAt: (where) => `${where}.role`,
};

/** Re-exported from `src/util.ts`, the one definition shared by every parser. */
export { isRecord };

export function createValidator(fail: Fail, dialect: ShapeDialect = GATE_DIALECT) {
  function record(value: unknown, where: string): Record<string, unknown> {
    if (!isRecord(value)) fail(where, 'expected an object');
    return value;
  }

  function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) fail(where, `unexpected key ${JSON.stringify(key)}`);
    }
  }

  function text(value: unknown, where: string, nonEmpty = dialect.textNonEmpty): string {
    if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
      fail(where, nonEmpty ? 'expected a nonempty string' : 'expected a string');
    }
    return value as string;
  }

  function bool(value: unknown, where: string): boolean {
    if (typeof value !== 'boolean') fail(where, 'expected a boolean');
    return value as boolean;
  }

  function safeInt(
    value: unknown, where: string, min: number, max = Number.MAX_SAFE_INTEGER,
  ): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      fail(where, dialect.safeIntMessage(min, max));
    }
    return value as number;
  }

  function hash(value: unknown, where: string): string {
    const hex = text(value, where);
    if (!HASH_RE.test(hex)) fail(where, 'expected 64 lowercase hex characters');
    return hex;
  }

  function array(value: unknown, where: string): unknown[] {
    if (!Array.isArray(value)) fail(where, 'expected an array');
    return value as unknown[];
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
    const edge = (key: string): string | null =>
      o[key] === null ? null : text(o[key], `${where}.${key}`);
    return { from: edge('from'), to: edge('to') };
  }

  function functionCall(value: unknown, where: string): FunctionCall {
    const o = record(value, where);
    onlyKeys(o, ['id', 'type', 'function'], where);
    if (o['type'] !== 'function') {
      fail(dialect.functionTypeError.at(where), dialect.functionTypeError.message);
    }
    const fn = record(o['function'], `${where}.function`);
    onlyKeys(fn, ['name', 'arguments'], `${where}.function`);
    return {
      id: text(o['id'], `${where}.id`),
      type: 'function',
      function: {
        name: text(fn['name'], `${where}.function.name`),
        arguments: text(fn['arguments'], `${where}.function.arguments`, !dialect.allowEmptyText),
      },
    };
  }

  function chatMessage(value: unknown, where: string): ChatMessage {
    const o = record(value, where);
    const nonEmpty = !dialect.allowEmptyText;
    const role = o['role'];
    if (role === 'system') {
      onlyKeys(o, ['role', 'content'], where);
      return { role: 'system', content: text(o['content'], `${where}.content`, nonEmpty) };
    }
    if (role === 'user') {
      onlyKeys(o, ['role', 'content'], where);
      return { role: 'user', content: text(o['content'], `${where}.content`, nonEmpty) };
    }
    if (role === 'assistant') {
      onlyKeys(o, ['role', 'content', 'tool_calls'], where);
      const content = o['content'] === null ? null : text(o['content'], `${where}.content`, nonEmpty);
      const calls = array(o['tool_calls'], `${where}.tool_calls`).map((call, i) =>
        functionCall(call, `${where}.tool_calls[${i}]`));
      return { role: 'assistant', content, tool_calls: calls };
    }
    if (role === 'tool') {
      onlyKeys(o, ['role', 'content', 'tool_call_id'], where);
      return {
        role: 'tool',
        content: text(o['content'], `${where}.content`, nonEmpty),
        tool_call_id: text(o['tool_call_id'], `${where}.tool_call_id`),
      };
    }
    return fail(dialect.unknownRoleAt(where), 'unknown chat role');
  }

  function assistantMessage(
    value: unknown, where: string,
  ): Extract<ChatMessage, { role: 'assistant' }> {
    const message = chatMessage(value, where);
    if (message.role !== 'assistant') fail(where, 'expected an assistant message');
    return message;
  }

  function toolMessage(value: unknown, where: string): Extract<ChatMessage, { role: 'tool' }> {
    const message = chatMessage(value, where);
    if (message.role !== 'tool') fail(where, 'expected a tool message');
    return message;
  }

  function compactionStart(value: unknown, where: string): CompactionStart {
    const o = record(value, where);
    onlyKeys(o, ['id', 'revision', 'groupIds', 'sources', 'shadowHash', 'shadowBytes'], where);
    return {
      id: hash(o['id'], `${where}.id`),
      revision: hash(o['revision'], `${where}.revision`),
      groupIds: array(o['groupIds'], `${where}.groupIds`)
        .map((entry, i) => source(entry, `${where}.groupIds[${i}]`)),
      sources: array(o['sources'], `${where}.sources`)
        .map((entry, i) => source(entry, `${where}.sources[${i}]`)),
      shadowHash: hash(o['shadowHash'], `${where}.shadowHash`),
      shadowBytes: safeInt(o['shadowBytes'], `${where}.shadowBytes`, 0),
    };
  }

  return {
    fail, record, onlyKeys, text, bool, safeInt, hash, array, source, requestId, worldRange,
    functionCall, chatMessage, assistantMessage, toolMessage, compactionStart,
  };
}
