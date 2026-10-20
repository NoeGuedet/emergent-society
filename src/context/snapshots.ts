import { readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  atomicWriteFile, ensureDurableDirectory, nodeDir, readFileOrNull, syncPath,
} from '../journal/index.js';
import { toJson } from './artifacts.js';
import { validateAgentConfig } from './config.js';
import { surfaceHeading, surfaceRevision } from './groups.js';
import { SNAPSHOT_DIALECT, createValidator } from './validate.js';
import type {
  AgentConfig, OpenTurn, ProjectionState, RecoveryGroup, Source, SurfaceGroup, SurfaceSnapshot,
} from './contracts.js';
import type { VerifiedEvents } from './loader.js';

/**
 * Disposable projection checkpoints (kernel.md §3, §4).
 *
 * A checkpoint is a typed, defensively frozen `ProjectionState` written beside a
 * node's local log at `nodes/<uid>/snapshots/<seq>.json`, where `<seq>` is the
 * verified `(seq, hash)` the state was folded at. It is an accelerator hint and
 * nothing more: C1.3 never uses a checkpoint to skip chain verification or the
 * full fold, so a missing, stale, malformed or forged file is a `null` — never a
 * fatal error and never a substitute for the local log. Snapshot acceleration with
 * a complete fold inventory is C1.6.
 *
 * Writing is best effort (any exception is `false`). A snapshot is validated
 * through the *same* full parser the reader uses — envelope, schema and the
 * state watermark naming its own `(seq, hash)` — before any filesystem work, so
 * only a row the reader would accept is ever written. After a durable write the
 * directory is pruned to that row plus the newest structurally valid prior row
 * as a fallback (retention 2, a fixed kernel-side bound); pruning is itself best
 * effort and never turns a durable write into a failure. Reading fully validates
 * the file and cross-checks it against the verified events, returning the newest
 * row that still agrees with them, or `null`.
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

/**
 * The shared schema primitives, bound to the snapshot parser's own prefix. Its
 * dialect differs from the gate's rather than being stricter: empty text is
 * accepted everywhere here (the snapshot's original text rule), while the gate
 * forbids it where its dialect says so; function/role errors point at `.type` /
 * `.role` here and at the enclosing field there. See `ShapeDialect` in
 * `validate.ts`.
 */
const v = createValidator((where, message): never => {
  throw new Error(`invalid snapshot at ${where}: ${message}`);
}, SNAPSHOT_DIALECT);
const {
  fail, record, onlyKeys, text, bool, safeInt, hash, array, source, requestId, worldRange,
  functionCall, chatMessage, assistantMessage, toolMessage, compactionStart,
} = v;

function surfaceGroup(value: unknown, where: string): SurfaceGroup {
  const o = record(value, where);
  onlyKeys(o, ['id', 'kind', 'turn', 'messages', 'sources'], where);
  const kind = o['kind'];
  if (kind !== 'heading' && kind !== 'perception' && kind !== 'dialogue' && kind !== 'summary') {
    return fail(`${where}.kind`, 'unknown group kind');
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

function sameSource(a: Source, b: Source): boolean {
  return a.seq === b.seq && a.hash === b.hash;
}

function surfaceSnapshot(value: unknown, where: string): SurfaceSnapshot {
  const o = record(value, where);
  onlyKeys(o, ['heading', 'nodes', 'revision'], where);
  const rawHeading = record(o['heading'], `${where}.heading`);
  onlyKeys(rawHeading, ['text', 'source'], `${where}.heading`);
  const heading = {
    text: text(rawHeading['text'], `${where}.heading.text`),
    source: source(rawHeading['source'], `${where}.heading.source`),
  };
  const nodes = array(o['nodes'], `${where}.nodes`).map((node, i) => {
    const at = `${where}.nodes[${i}]`;
    const n = record(node, at);
    onlyKeys(n, ['position', 'group'], at);
    return {
      position: safeInt(n['position'], `${at}.position`, 0),
      group: surfaceGroup(n['group'], `${at}.group`),
    };
  });
  // The emitted shape has one invariant surface structure: node 0 is the heading
  // pin, positions are the array indexes, and the revision is a pure function of
  // those two. A checkpoint that omits the pin, leaves a gap or carries a
  // revision unrelated to its nodes is not a state this module ever wrote.
  if (nodes.length === 0) fail(`${where}.nodes`, 'must contain the heading pin');
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i]!.position !== i) fail(`${where}.nodes[${i}].position`, `expected ${i}`);
  }
  const head = nodes[0]!;
  if (head.group.kind !== 'heading') fail(`${where}.nodes[0].group.kind`, "expected 'heading'");
  if (!sameSource(head.group.id, heading.source)) {
    fail(`${where}.nodes[0].group.id`, 'does not equal the heading source');
  }
  if (!head.group.sources.some((entry) => sameSource(entry, heading.source))) {
    fail(`${where}.nodes[0].group.sources`, 'does not contain the heading source');
  }
  const first = head.group.messages[0];
  if (first === undefined || first.role !== 'system' || first.content !== heading.text) {
    fail(`${where}.nodes[0].group.messages`, 'does not encode the heading text');
  }
  const revision = hash(o['revision'], `${where}.revision`);
  const groups = nodes.map((node) => node.group);
  const derivedHeading = surfaceHeading(groups);
  if (derivedHeading.text !== heading.text
    || !sameSource(derivedHeading.source, heading.source)) {
    fail(`${where}.heading`, 'does not match the heading pin');
  }
  // The revision is the shared groups.ts formula, not a local copy: the writer
  // and the checkpoint reader must never drift from the surface it describes.
  if (revision !== surfaceRevision(groups)) {
    fail(`${where}.revision`, 'does not match the heading and nodes');
  }
  return { heading, nodes, revision };
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

/** The canonical `<seq>.json` seq numbers in `names`, in directory order. */
function canonicalSeqs(names: readonly string[]): number[] {
  const seqs: number[] = [];
  for (const name of names) {
    const match = NAME_RE.exec(name);
    if (match === null) continue;
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq)) continue;
    seqs.push(seq);
  }
  return seqs;
}

/**
 * Reads and fully validates one canonical row, requiring its filename seq to
 * match its content. This is the one per-row check the reader and the pruner's
 * fallback search share, so the two can never disagree about what "valid"
 * means. A missing, unreadable, non-JSON or invalid row is `null`.
 */
async function readValidRow(dir: string, seq: number): Promise<Snapshot | null> {
  const bytes = await readFileOrNull(join(dir, `${seq}.json`)).catch(() => null);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const snap = parseSnapshot(parsed);
  if (snap === null || snap.seq !== seq) return null;
  return snap;
}

/**
 * Per-directory write serialization. `writeSnapshot` is a public API, not only
 * the runtime's hook, so two concurrent calls for one node could otherwise race:
 * one writes a newer row while the other treats it as an older row to prune. The
 * queue makes each write+prune pair atomic with respect to other calls in this
 * process. It is keyed by the directory's *canonical physical* path (see
 * `writeSnapshot`), so every spelling of the same directory — relative,
 * absolute, or a symlink alias — shares one queue. The map holds at most one
 * promise per live directory: the tail entry is deleted as soon as it settles,
 * so an idle directory leaves nothing behind.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const prior = writeQueues.get(dir) ?? Promise.resolve();
  const run = prior.then(task);
  const tail: Promise<void> = run.then(() => undefined, () => undefined);
  writeQueues.set(dir, tail);
  void tail.then(() => {
    if (writeQueues.get(dir) === tail) writeQueues.delete(dir);
  });
  return run;
}

/**
 * Bounded retention after a durable write: keep the new row and the newest
 * *prior* structurally valid canonical row as its fallback, and delete the other
 * canonical rows strictly older than the new one. A candidate is only a fallback
 * when the shared parser accepts it *and* its filename seq matches its content,
 * so a malformed higher name can never chase a valid older row out. Rows newer
 * than `newSeq` (a checkpoint another call wrote) and every non-canonical name
 * (`notes.txt`, `.tmp`, …) are left entirely untouched.
 *
 * Pruning is best effort throughout: an unlink failure here never turns the
 * durable write that preceded it into a failure.
 */
async function pruneSnapshots(dir: string, newSeq: number): Promise<void> {
  const names = await readdir(dir);
  const older = canonicalSeqs(names).filter((seq) => seq < newSeq).sort((a, b) => b - a);

  let keptFallback = false;
  for (const seq of older) {
    if (!keptFallback) {
      const snap = await readValidRow(dir, seq);
      if (snap !== null) {
        keptFallback = true;
        continue;
      }
    }
    await rm(join(dir, `${seq}.json`), { force: true }).catch(() => {});
  }
}

/**
 * Writes a checkpoint to `nodes/<uid>/snapshots/<seq>.json`. The snapshot is
 * validated through the same `parseSnapshot` the reader uses — envelope shape,
 * `ver`, a canonical `(seq, hash)` and a frozen state whose watermark names that
 * same identity — and only the canonical result is written; an invalid snapshot
 * is `false` with no filesystem effect. The directory is created through the
 * shared durable-directory helper, then its *physical* path is resolved with
 * `realpath` before the write and prune are queued, so two spellings of one
 * directory (relative, absolute, symlink alias) never race in two queues — the
 * durable-directory proof is idempotent, so it runs per call, before the queue.
 * The row is written atomically and the directory synced, all best effort: any
 * exception is `false`, never a throw. A uid the path builder rejects is refused
 * the same way. After the row is durable the directory is pruned to retention 2;
 * a pruning failure still returns `true`, because the write itself succeeded.
 */
export async function writeSnapshot(home: string, uid: string, snap: Snapshot): Promise<boolean> {
  try {
    const checked = parseSnapshot(snap);
    if (checked === null) return false;
    const body = JSON.stringify(checked);
    const dir = snapshotsDir(home, uid);
    await ensureDurableDirectory(dir, home);
    const canonicalDir = await realpath(dir);
    return await enqueueWrite(canonicalDir, async () => {
      try {
        await atomicWriteFile(join(canonicalDir, `${checked.seq}.json`), body);
        await syncPath(canonicalDir);
      } catch {
        return false;
      }
      await pruneSnapshots(canonicalDir, checked.seq).catch(() => {});
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Reads the newest checkpoint that still agrees with the verified chain, or
 * `null`. Rows are scanned in descending seq; a row that is missing, malformed,
 * the wrong version, path-inconsistent, hash-mismatched or ahead of the chain is
 * skipped in favour of an earlier valid one. Nothing here is fatal: a missing
 * directory, an unreadable file, a `readdir` failure, or a uid the path builder
 * rejects all return `null` (symmetric with `writeSnapshot`'s `false`).
 *
 * `events` is the already chain-verified journal; the snapshot is never trusted
 * over it, so this never skips verification or the fold.
 */
export async function readSnapshot(
  home: string, uid: string, events: VerifiedEvents,
): Promise<Snapshot | null> {
  const verified = new Map<number, string>();
  for (const event of events) verified.set(event.raw.seq, event.raw.hash);

  let dir: string;
  try {
    dir = snapshotsDir(home, uid);
  } catch {
    return null;
  }
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const rows = canonicalSeqs(names).sort((a, b) => b - a);
  for (const seq of rows) {
    const snap = await readValidRow(dir, seq);
    if (snap === null) continue;
    if (verified.get(seq) !== snap.hash) continue;
    return snap;
  }
  return null;
}
