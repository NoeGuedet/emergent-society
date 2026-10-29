import type { Writable } from 'node:stream';
import type { JsonValue } from '../../journal/index.js';
import { canonicalizeJson } from '../../journal/index.js';
import {
  MAX_FRAME_BYTES,
  MAX_PACKAGE_NAME_CHARS,
  MAX_PACKAGE_PURPOSE_CHARS,
} from './constants.js';

/**
 * The Run facade protocol codec (kernel.md, the sandbox and local-log
 * sections): JSON-lines over the child's stdio, one frame per line, both
 * directions through the same vocabulary.
 *
 * Invariants this module owns:
 * - **One frame per line, one line per frame** — every encoded frame is one
 *   canonical JSON line; the decoder re-derives frames from byte chunks and
 *   never buffers an unterminated line past `MAX_FRAME_BYTES` (a noise stream
 *   without a newline is one growing line, killed at the cap — never unbounded
 *   memory, never a desync).
 * - **Kernel-side frame validation is the boundary** — a decoded line must be
 *   JSON, a known frame type, and a valid shape of that type; anything else is
 *   a teardown verdict, not a frame. Interception in the child is UX; this
 *   validation is what a forged frame meets.
 * - **One request in flight per direction** — `InFlightGuard` mints the
 *   single outstanding callId and tears down a mismatch or replay. The two
 *   directions (kernel→child invokes, child→kernel service calls) each keep
 *   their own guard; the namespaces are independent.
 *
 * What this module never does: I/O beyond the `Writable` it is handed,
 * deadlines or teardown actions (the supervisor's), registration validation
 * (the registry's), or a single secret — the frames carry call identities,
 * tool names and bounded payloads only.
 */

/** A tool the child declares at `run/ready`: the wire's serializable subset. */
export type DeclaredTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
};

/** The whole frame vocabulary — both directions, one table (design §5.3). */
export type ProtocolFrame =
  | { readonly type: 'run/ready'; readonly tools: readonly DeclaredTool[] }
  | {
    readonly type: 'tool/invoke'; readonly callId: string;
    readonly name: string; readonly args: JsonValue;
  }
  | {
    readonly type: 'tool/result'; readonly callId: string; ok: true;
    readonly result: JsonValue;
  }
  | {
    readonly type: 'tool/result'; readonly callId: string; ok: false;
    readonly error: string;
  }
  | { readonly type: 'svc/execute'; readonly callId: string; readonly cmd: string }
  | {
    readonly type: 'svc/web_search'; readonly callId: string; readonly query: string;
    readonly maxResults?: number;
  }
  | { readonly type: 'svc/web_fetch'; readonly callId: string; readonly url: string }
  | {
    readonly type: 'svc/result'; readonly callId: string; ok: true;
    readonly result: JsonValue;
  }
  | { readonly type: 'svc/result'; readonly callId: string; ok: false; readonly error: string }
  | { readonly type: 'run/dispose' };

const FRAME_TYPES: ReadonlySet<string> = new Set([
  'run/ready', 'tool/invoke', 'tool/result', 'svc/execute', 'svc/web_search',
  'svc/web_fetch', 'svc/result', 'run/dispose',
]);

const WEB_SEARCH_MAX_RESULTS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(o: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(o)) {
    if (!keys.includes(key)) throw new Error(`${where}: unexpected key ${JSON.stringify(key)}`);
  }
}

function requireString(
  o: Record<string, unknown>, key: string, where: string, maxChars?: number,
): string {
  const value = o[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${where}: ${key} must be a nonempty string`);
  }
  if (maxChars !== undefined && value.length > maxChars) {
    throw new Error(`${where}: ${key} exceeds ${maxChars} characters`);
  }
  return value;
}

/** The one shape validator every decoded frame and every encode passes. */
export function validateFrame(value: unknown): ProtocolFrame {
  if (!isRecord(value)) throw new Error('frame must be a JSON object');
  const type = value['type'];
  if (typeof type !== 'string') throw new Error('frame type must be a string');
  if (!FRAME_TYPES.has(type)) throw new Error(`unknown frame type ${JSON.stringify(type)}`);

  if (type === 'run/ready') {
    hasOnlyKeys(value, ['type', 'tools'], 'run/ready');
    const tools = value['tools'];
    if (!Array.isArray(tools)) throw new Error('run/ready: tools must be an array');
    const declared: DeclaredTool[] = tools.map((tool) => {
      if (!isRecord(tool)) throw new Error('run/ready: a tool must be a JSON object');
      hasOnlyKeys(tool, ['name', 'description', 'parameters'], 'run/ready tool');
      return {
        name: requireString(tool, 'name', 'run/ready tool', MAX_PACKAGE_NAME_CHARS),
        description: requireString(tool, 'description', 'run/ready tool', MAX_PACKAGE_PURPOSE_CHARS),
        parameters: isRecord(tool['parameters']) ? tool['parameters'] as JsonValue
          : ((): never => {
            throw new Error('run/ready tool: parameters must be a JSON object');
          })(),
      };
    });
    return { type: 'run/ready', tools: declared };
  }

  if (type === 'tool/invoke') {
    hasOnlyKeys(value, ['type', 'callId', 'name', 'args'], 'tool/invoke');
    const args = value['args'];
    if (args === undefined) throw new Error('tool/invoke: args must be present');
    return {
      type,
      callId: requireString(value, 'callId', 'tool/invoke'),
      name: requireString(value, 'name', 'tool/invoke', MAX_PACKAGE_NAME_CHARS),
      args: args as JsonValue,
    };
  }

  if (type === 'tool/result' || type === 'svc/result') {
    hasOnlyKeys(value, ['type', 'callId', 'ok', 'result', 'error'], type);
    const frame = { type, callId: requireString(value, 'callId', type) };
    if (value['ok'] === true) {
      if (!('result' in value)) throw new Error(`${type}: ok requires a result`);
      if ('error' in value) throw new Error(`${type}: ok must not carry an error`);
      return { ...frame, ok: true, result: value['result'] as JsonValue } as ProtocolFrame;
    }
    if (value['ok'] === false) {
      if (!('error' in value)) throw new Error(`${type}: a failed result requires an error`);
      if ('result' in value) throw new Error(`${type}: a failed result must not carry a result`);
      return {
        ...frame, ok: false,
        error: requireString(value, 'error', type),
      } as ProtocolFrame;
    }
    throw new Error(`${type}: ok must be a boolean`);
  }

  if (type === 'svc/execute') {
    hasOnlyKeys(value, ['type', 'callId', 'cmd'], 'svc/execute');
    return {
      type,
      callId: requireString(value, 'callId', 'svc/execute'),
      cmd: requireString(value, 'cmd', 'svc/execute'),
    };
  }

  if (type === 'svc/web_search') {
    hasOnlyKeys(value, ['type', 'callId', 'query', 'maxResults'], 'svc/web_search');
    const max = value['maxResults'];
    if (max !== undefined
      && (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1
        || max > WEB_SEARCH_MAX_RESULTS)) {
      throw new Error('svc/web_search: maxResults must be an integer in 1..20');
    }
    return {
      type,
      callId: requireString(value, 'callId', 'svc/web_search'),
      query: requireString(value, 'query', 'svc/web_search'),
      ...(max === undefined ? {} : { maxResults: max }),
    };
  }

  if (type === 'svc/web_fetch') {
    hasOnlyKeys(value, ['type', 'callId', 'url'], 'svc/web_fetch');
    return {
      type,
      callId: requireString(value, 'callId', 'svc/web_fetch'),
      url: requireString(value, 'url', 'svc/web_fetch'),
    };
  }

  // run/dispose: the frame is the whole payload.
  hasOnlyKeys(value, ['type'], 'run/dispose');
  return { type: 'run/dispose' };
}

/**
 * Encodes one frame as one canonical JSON line, refusing oversize content.
 * The newline is the terminator, not part of the line: the cap counts the
 * same bytes the decoder's per-line accounting counts, so a frame that
 * encodes always decodes.
 */
export function encodeFrame(frame: ProtocolFrame): string {
  const validated = validateFrame(frame);
  const body = canonicalizeJson(validated as unknown as JsonValue);
  if (Buffer.byteLength(body, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(
      `the frame exceeds the ${MAX_FRAME_BYTES}-byte line cap: nothing is written`,
    );
  }
  return `${body}\n`;
}

/** A decoder outcome: one frame, or one fatal teardown verdict. */
export type DecodeOutcome =
  | { readonly status: 'frame'; readonly frame: ProtocolFrame }
  | { readonly status: 'teardown'; readonly reason: TeardownReason };

/** The frozen teardown vocabulary (design §8's `protocol` error code kin). */
export type TeardownReason =
  | 'frame-cap'
  | 'malformed'
  | 'unknown-type'
  | 'invalid-shape'
  | 'poisoned';

/**
 * The incremental line decoder with per-line byte accounting. A verdict of
 * `teardown` is fatal: the decoder is poisoned and every later push yields
 * the `poisoned` verdict — the supervisor tears the Run down, never skips.
 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private poisoned = false;

  push(chunk: string | Uint8Array): DecodeOutcome[] {
    if (this.poisoned) return [{ status: 'teardown', reason: 'poisoned' }];
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    const outcomes: DecodeOutcome[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      // Per-line byte accounting: the moment the growing line crosses the cap
      // — before any newline is consumed — the line is killed. A completed
      // over-cap line never reaches JSON parsing.
      if (this.pending.length + (i - start) > MAX_FRAME_BYTES) {
        this.poisoned = true;
        this.pending = Buffer.alloc(0);
        outcomes.push({ status: 'teardown', reason: 'frame-cap' });
        return outcomes;
      }
      if (bytes[i] !== 0x0a) continue;
      const line = Buffer.concat([
        this.pending, bytes.subarray(start, i),
      ]).toString('utf8');
      this.pending = Buffer.alloc(0);
      const outcome = this.decodeLine(line);
      if (outcome !== undefined) outcomes.push(outcome);
      if (this.poisoned) return outcomes;
      start = i + 1;
    }
    const rest = bytes.subarray(start);
    this.pending = Buffer.concat([this.pending, rest]);
    if (this.pending.length > MAX_FRAME_BYTES) {
      this.poisoned = true;
      this.pending = Buffer.alloc(0);
      outcomes.push({ status: 'teardown', reason: 'frame-cap' });
    }
    return outcomes;
  }

  private decodeLine(line: string): DecodeOutcome | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.poisoned = true;
      return { status: 'teardown', reason: 'malformed' };
    }
    if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
      this.poisoned = true;
      return { status: 'teardown', reason: 'malformed' };
    }
    if (!FRAME_TYPES.has(parsed['type'])) {
      this.poisoned = true;
      return { status: 'teardown', reason: 'unknown-type' };
    }
    try {
      const frame = validateFrame(parsed);
      return { status: 'frame', frame };
    } catch (err) {
      this.poisoned = true;
      return {
        status: 'teardown',
        reason: 'invalid-shape',
      };
    }
  }
}

/** A desync verdict of one direction's single in-flight rule. */
export type Desync = { readonly reason: 'callId-mismatch' | 'not-in-flight' | 'busy' | 'poisoned' };

/**
 * The one-in-flight guard of one direction: at most one outstanding callId,
 * settled exactly once. A mismatch, a replay, a double begin or a settle with
 * nothing in flight poisons the guard — every later call is a desync, and the
 * supervisor tears the Run down (design §5.3).
 */
export class InFlightGuard {
  private pending: string | null = null;
  private poisoned = false;

  /** Marks `callId` as the single in-flight request; a busy guard desyncs. */
  begin(callId: string): Desync | null {
    if (this.poisoned) return { reason: 'poisoned' };
    if (this.pending !== null) {
      this.poisoned = true;
      return { reason: 'busy' };
    }
    this.pending = callId;
    return null;
  }

  /** Settles the in-flight request; a mismatched or replayed id desyncs. */
  settle(callId: string): Desync | null {
    if (this.poisoned) return { reason: 'poisoned' };
    if (this.pending === null) {
      this.poisoned = true;
      return { reason: 'not-in-flight' };
    }
    if (this.pending !== callId) {
      this.poisoned = true;
      return { reason: 'callId-mismatch' };
    }
    this.pending = null;
    return null;
  }
}

/**
 * Writes one frame drain-aware: the promise resolves only after the stream
 * has accepted every byte (immediately, or on `drain`), and rejects on the
 * stream's own error. The frame is validated and cap-checked before a single
 * byte is written. A caller that fires and forgets (the dispose frame) must
 * attach its own catch — an unawaited rejection is the caller's to own.
 */
export function writeFrame(stream: Writable, frame: ProtocolFrame): Promise<void> {
  let line: string;
  try {
    line = encodeFrame(frame);
  } catch (err) {
    // A rejected promise, never a synchronous throw: the write contract is
    // async for every caller, including fire-and-forget dispose writers.
    return Promise.reject(err);
  }
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      stream.removeListener('drain', onDrain);
      reject(err);
    };
    const onDrain = (): void => {
      stream.removeListener('error', onError);
      resolve();
    };
    stream.once('error', onError);
    if (stream.write(line)) {
      stream.removeListener('error', onError);
      resolve();
      return;
    }
    stream.once('drain', onDrain);
  });
}
