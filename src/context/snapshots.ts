import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HASH_RE } from '../journal/canon.js';
import { atomicWriteFile, readFileOrNull, syncPath } from '../journal/fsutil.js';
import { nodeDir } from '../journal/index.js';
import { toJson } from './artifacts.js';
import { validateAgentConfig } from './config.js';
import type {
  AgentConfig, ChatMessage, CompactionStart, FunctionCall, OpenTurn, ProjectionState, RecoveryGroup,
  RequestId, Source, SurfaceGroup, SurfaceSnapshot,
} from './contracts.js';
import type { VerifiedEvents } from './loader.js';

/**
 * Disposable projection checkpoints (kernel.md §3, §4).
 *
 * A checkpoint is a typed, defensively frozen `ProjectionState` written beside a
 * node's journal at `nodes/<uid>/snapshots/<seq>.json`, where `<seq>` is the
 * verified `(seq, hash)` the state was folded at. It is an accelerator hint and
 * nothing more: C1.3 never uses a checkpoint to skip chain verification or the
 * full fold, so a missing, stale, malformed or forged file is a `null` — never a
 * fatal error and never a substitute for the journal. Snapshot acceleration with
 * a complete fold inventory is C1.6.
 *
 * Writing is best effort (any exception is `false`); reading fully validates the
 * file and cross-checks it against the verified events, returning the newest row
 * that still agrees with them, or `null`.
 */

/** A projection checkpoint: the state and the verified identity it was folded at. */
export type Snapshot = {
  readonly ver: 1; readonly seq: number; readonly hash: string; readonly val: ProjectionState;
};

/** `nodes/<uid>/snapshots/` — the one place this module spells the layout literal. */
function snapshotsDir(home: string, uid: string): string {
  return join(nodeDir(home, uid), 'snapshots');
}

/** `<nonnegative-safe-int>.json`, canonical: no sign, no leading zeros, no fraction. */
const NAME_RE = /^(0|[1-9][0-9]*)\.json$/;

const STATE_KEYS = ['config', 'surface', 'open', 'recovery', 'watermark', 'pendingCompactions'] as const;

function fail(where: string, message: string): never {
  throw new Error(`invalid snapshot at ${where}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) fail(where, 'expected an object');
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(where, `unexpected key ${JSON.stringify(key)}`);
  }
}

function safeInt(value: unknown, where: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(where, `expected a safe integer >= ${min}`);
  }
  return value as number;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(where, 'expected a string');
  return value as string;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(where, 'expected a boolean');
  return value as boolean;
}

function hash(value: unknown, where: string): string {
  const hex = text(value, where);
  if (!HASH_RE.test(hex)) fail(where, 'expected 64 lowercase hex characters');
  return hex;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, 'expected an array');
  return value;
}

function source(value: unknown, where: string): Source {
  const o = record(value, where);
  onlyKeys(o, ['seq', 'hash'], where);
  return { seq: safeInt(o['seq'], `${where}.seq`, 0), hash: hash(o['hash'], `${where}.hash`) };
}

function worldRange(value: unknown, where: string): { from: string | null; to: string | null } {
  const o = record(value, where);
  onlyKeys(o, ['from', 'to'], where);
  const edge = (key: string): string | null =>
    o[key] === null ? null : text(o[key], `${where}.${key}`);
  return { from: edge('from'), to: edge('to') };
}

function requestId(value: unknown, where: string): RequestId {
  const o = record(value, where);
  onlyKeys(o, ['turn', 'ordinal'], where);
  return {
    turn: safeInt(o['turn'], `${where}.turn`, 0),
    ordinal: safeInt(o['ordinal'], `${where}.ordinal`, 0),
  };
}

function functionCall(value: unknown, where: string): FunctionCall {
  const o = record(value, where);
  onlyKeys(o, ['id', 'type', 'function'], where);
  if (o['type'] !== 'function') fail(`${where}.type`, 'expected "function"');
  const fn = record(o['function'], `${where}.function`);
  onlyKeys(fn, ['name', 'arguments'], `${where}.function`);
  return {
    id: text(o['id'], `${where}.id`),
    type: 'function',
    function: {
      name: text(fn['name'], `${where}.function.name`),
      arguments: text(fn['arguments'], `${where}.function.arguments`),
    },
  };
}

function chatMessage(value: unknown, where: string): ChatMessage {
  const o = record(value, where);
  const role = o['role'];
  if (role === 'system') {
    onlyKeys(o, ['role', 'content'], where);
    return { role: 'system', content: text(o['content'], `${where}.content`) };
  }
  if (role === 'user') {
    onlyKeys(o, ['role', 'content'], where);
    return { role: 'user', content: text(o['content'], `${where}.content`) };
  }
  if (role === 'assistant') {
    onlyKeys(o, ['role', 'content', 'tool_calls'], where);
    const content = o['content'] === null ? null : text(o['content'], `${where}.content`);
    const calls = array(o['tool_calls'], `${where}.tool_calls`)
      .map((call, i) => functionCall(call, `${where}.tool_calls[${i}]`));
    return { role: 'assistant', content, tool_calls: calls };
  }
  if (role === 'tool') {
    onlyKeys(o, ['role', 'content', 'tool_call_id'], where);
    return {
      role: 'tool',
      content: text(o['content'], `${where}.content`),
      tool_call_id: text(o['tool_call_id'], `${where}.tool_call_id`),
    };
  }
  return fail(`${where}.role`, 'unknown chat role');
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

function surfaceGroup(value: unknown, where: string): SurfaceGroup {
  const o = record(value, where);
  onlyKeys(o, ['id', 'kind', 'turn', 'messages', 'sources'], where);
  const kind = o['kind'];
  if (kind !== 'heading' && kind !== 'perception' && kind !== 'dialogue' && kind !== 'summary') {
    fail(`${where}.kind`, 'unknown group kind');
  }
  return {
    id: source(o['id'], `${where}.id`),
    kind,
    turn: safeInt(o['turn'], `${where}.turn`, 0),
    messages: array(o['messages'], `${where}.messages`)
      .map((message, i) => chatMessage(message, `${where}.messages[${i}]`)),
    sources: array(o['sources'], `${where}.sources`)
      .map((entry, i) => source(entry, `${where}.sources[${i}]`)),
  };
}

function surfaceSnapshot(value: unknown, where: string): SurfaceSnapshot {
  const o = record(value, where);
  onlyKeys(o, ['heading', 'nodes', 'revision'], where);
  const heading = record(o['heading'], `${where}.heading`);
  onlyKeys(heading, ['text', 'source'], `${where}.heading`);
  return {
    heading: {
      text: text(heading['text'], `${where}.heading.text`),
      source: source(heading['source'], `${where}.heading.source`),
    },
    nodes: array(o['nodes'], `${where}.nodes`).map((node, i) => {
      const at = `${where}.nodes[${i}]`;
      const n = record(node, at);
      onlyKeys(n, ['position', 'group'], at);
      return {
        position: safeInt(n['position'], `${at}.position`, 0),
        group: surfaceGroup(n['group'], `${at}.group`),
      };
    }),
    revision: hash(o['revision'], `${where}.revision`),
  };
}

function openTurn(value: unknown, where: string): OpenTurn {
  const o = record(value, where);
  onlyKeys(
    o, ['start', 'turn', 'world', 'perception', 'perceptionConsumed', 'messages', 'sources'], where,
  );
  return {
    start: source(o['start'], `${where}.start`),
    turn: safeInt(o['turn'], `${where}.turn`, 0),
    world: worldRange(o['world'], `${where}.world`),
    perception: o['perception'] === null ? null : surfaceGroup(o['perception'], `${where}.perception`),
    perceptionConsumed: bool(o['perceptionConsumed'], `${where}.perceptionConsumed`),
    messages: array(o['messages'], `${where}.messages`)
      .map((message, i) => chatMessage(message, `${where}.messages[${i}]`)),
    sources: array(o['sources'], `${where}.sources`)
      .map((entry, i) => source(entry, `${where}.sources[${i}]`)),
  };
}

function recoveryGroup(value: unknown, where: string): RecoveryGroup {
  const o = record(value, where);
  onlyKeys(o, ['turn', 'request', 'assistant', 'sources', 'results', 'missing'], where);
  return {
    turn: safeInt(o['turn'], `${where}.turn`, 0),
    request: requestId(o['request'], `${where}.request`),
    assistant: assistantMessage(o['assistant'], `${where}.assistant`),
    sources: array(o['sources'], `${where}.sources`)
      .map((entry, i) => source(entry, `${where}.sources[${i}]`)),
    results: array(o['results'], `${where}.results`)
      .map((message, i) => toolMessage(message, `${where}.results[${i}]`)),
    missing: array(o['missing'], `${where}.missing`)
      .map((call, i) => functionCall(call, `${where}.missing[${i}]`)),
  };
}

function compactionStart(value: unknown, where: string): CompactionStart {
  const o = record(value, where);
  onlyKeys(o, ['id', 'revision', 'groupIds', 'sources', 'shadowHash', 'shadowBytes'], where);
  return {
    id: text(o['id'], `${where}.id`),
    revision: hash(o['revision'], `${where}.revision`),
    groupIds: array(o['groupIds'], `${where}.groupIds`)
      .map((entry, i) => source(entry, `${where}.groupIds[${i}]`)),
    sources: array(o['sources'], `${where}.sources`)
      .map((entry, i) => source(entry, `${where}.sources[${i}]`)),
    shadowHash: hash(o['shadowHash'], `${where}.shadowHash`),
    shadowBytes: safeInt(o['shadowBytes'], `${where}.shadowBytes`, 0),
  };
}

function configSlot(value: unknown, where: string): { value: AgentConfig; source: Source } {
  const o = record(value, where);
  onlyKeys(o, ['value', 'source'], where);
  return { value: validateAgentConfig(o['value']), source: source(o['source'], `${where}.source`) };
}

/** Validates the frozen `ProjectionState` shape, reusing the T1 config validator for `config.value`. */
function projectionState(value: unknown, where: string): ProjectionState {
  const o = record(value, where);
  onlyKeys(o, STATE_KEYS, where);
  for (const key of STATE_KEYS) if (!(key in o)) fail(where, `missing key ${JSON.stringify(key)}`);
  return {
    config: o['config'] === null ? null : configSlot(o['config'], `${where}.config`),
    surface: o['surface'] === null ? null : surfaceSnapshot(o['surface'], `${where}.surface`),
    open: o['open'] === null ? null : openTurn(o['open'], `${where}.open`),
    recovery: array(o['recovery'], `${where}.recovery`)
      .map((group, i) => recoveryGroup(group, `${where}.recovery[${i}]`)),
    watermark: o['watermark'] === null ? null : source(o['watermark'], `${where}.watermark`),
    pendingCompactions: array(o['pendingCompactions'], `${where}.pendingCompactions`)
      .map((entry, i) => compactionStart(entry, `${where}.pendingCompactions[${i}]`)),
  };
}

/**
 * Fully validates a parsed snapshot file and returns a frozen copy, or `null`.
 * The state watermark must name the snapshot's own `(seq, hash)`; the caller
 * additionally requires that identity to match a verified event.
 */
function parseSnapshot(value: unknown): Snapshot | null {
  try {
    const o = record(value, 'snapshot');
    onlyKeys(o, ['ver', 'seq', 'hash', 'val'], 'snapshot');
    if (o['ver'] !== 1) fail('ver', 'expected version 1');
    const seq = safeInt(o['seq'], 'seq', 0);
    const hashHex = hash(o['hash'], 'hash');
    const val = projectionState(o['val'], 'val');
    const mark = val.watermark;
    if (mark === null || mark.seq !== seq || mark.hash !== hashHex) {
      fail('val.watermark', 'does not match the snapshot seq/hash');
    }
    return toJson({ ver: 1, seq, hash: hashHex, val }) as unknown as Snapshot;
  } catch {
    return null;
  }
}

/**
 * Writes a checkpoint to `nodes/<uid>/snapshots/<seq>.json`. The envelope is
 * checked (a canonical filename needs a safe nonnegative seq) and the value is
 * passed through `toJson` so an unserializable snapshot is refused rather than
 * written lossily. Directory creation, the atomic write and the directory sync
 * are one best-effort attempt: any exception is `false`, never a throw.
 */
export async function writeSnapshot(home: string, uid: string, snap: Snapshot): Promise<boolean> {
  try {
    if (snap.ver !== 1) fail('ver', 'expected version 1');
    const seq = safeInt(snap.seq, 'seq', 0);
    hash(snap.hash, 'hash');
    const body = JSON.stringify(toJson({ ver: 1, seq, hash: snap.hash, val: snap.val }));
    const dir = snapshotsDir(home, uid);
    await mkdir(dir, { recursive: true });
    await atomicWriteFile(join(dir, `${seq}.json`), body);
    await syncPath(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the newest checkpoint that still agrees with the verified chain, or
 * `null`. Rows are scanned in descending seq; a row that is missing, malformed,
 * the wrong version, path-inconsistent, hash-mismatched or ahead of the chain is
 * skipped in favour of an earlier valid one. Nothing here is fatal: a missing
 * directory, an unreadable file or a `readdir` failure all return `null`.
 *
 * `events` is the already chain-verified journal; the snapshot is never trusted
 * over it, so this never skips verification or the fold.
 */
export async function readSnapshot(
  home: string, uid: string, events: VerifiedEvents,
): Promise<Snapshot | null> {
  const verified = new Map<number, string>();
  for (const event of events) verified.set(event.raw.seq, event.raw.hash);

  const dir = snapshotsDir(home, uid);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const rows: number[] = [];
  for (const name of names) {
    const match = NAME_RE.exec(name);
    if (match === null) continue;
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq)) continue;
    rows.push(seq);
  }
  rows.sort((a, b) => b - a);

  for (const seq of rows) {
    const bytes = await readFileOrNull(join(dir, `${seq}.json`)).catch(() => null);
    if (bytes === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    const snap = parseSnapshot(parsed);
    if (snap === null || snap.seq !== seq) continue;
    if (verified.get(seq) !== snap.hash) continue;
    return snap;
  }
  return null;
}
