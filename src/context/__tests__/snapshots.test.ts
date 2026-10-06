import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BlobStore, ChainBreakError, JournalWriter, nodeDir } from '../../journal/index.js';
import type { EventEnvelope, JsonValue } from '../../journal/index.js';
import { logPath, rewriteLog, useTempHome } from '../../journal/__tests__/helpers.js';
import { createBoundaryGate } from '../../node/gate.js';
import type { BoundaryGate, GateCallbacks } from '../../node/gate.js';
import { defaultAgentConfig } from '../config.js';
import type {
  ArtifactRef, AssistantProjection, FunctionCall, ProjectionState, RequestId, RequestPlan, Source,
} from '../contracts.js';
import { C13_EVENT_TYPES, createBoundaryRegistry } from '../events.js';
import { ContextFold } from '../fold.js';
import { loadVerifiedEvents } from '../loader.js';
import type { VerifiedEvents } from '../loader.js';
import { readSnapshot, writeSnapshot } from '../snapshots.js';
import type { Snapshot } from '../snapshots.js';

const home = useTempHome('c13-snapshots-');

/** `nodes/<uid>/snapshots/` — the layout kernel.md §3 fixes for disposable projection checkpoints. */
function snapshotsDir(path: string): string {
  return join(nodeDir(path, 'n1'), 'snapshots');
}

function minimalPlan(id: RequestId, config: Source): RequestPlan {
  return {
    id, config, stateHash: 'a'.repeat(64), model: 'mock-model', parameters: {},
    policy: defaultAgentConfig().policy, tools: [], toolsHash: 'b'.repeat(64),
    sections: [
      { name: 'tools', cache: 'stable', sources: [] },
      { name: 'charter', cache: 'stable', sources: [] },
      { name: 'heading', cache: 'stable', sources: [] },
      { name: 'history', cache: 'advance', sources: [] },
      { name: 'queue', cache: 'volatile', sources: [] },
    ],
    history: [], queue: [], charter: '', heading: '',
  };
}

function projection(calls: FunctionCall[], raw: ArtifactRef): AssistantProjection {
  return {
    message: { role: 'assistant', content: calls.length === 0 ? 'final text' : null, tool_calls: calls },
    contentTruncated: false, raw,
  };
}

/**
 * Seeds a real journal: a config event plus one committed turn (dialogue) — the
 * nonempty history a restart must reconstruct. `closeTurn` false leaves the turn
 * open, which is the checkpoint state that exercises `OpenTurn` validation.
 */
async function seedJournal(path: string, closeTurn = true): Promise<VerifiedEvents> {
  const writer = await JournalWriter.open(path, 'n1', { batchWindowMs: 60000 });
  const controller = new AbortController();
  const receipts = new Map<string, EventEnvelope>();
  const record = (envelope: EventEnvelope): EventEnvelope => {
    receipts.set(`${envelope.seq}:${envelope.hash}`, envelope);
    return envelope;
  };
  const lookup = (source: Source): EventEnvelope | null =>
    receipts.get(`${source.seq}:${source.hash}`) ?? null;
  const callbacks: GateCallbacks = {
    append: (type, data) => record(writer.append(type, data as never)),
    flush: () => writer.flush(),
    lookup,
    readBlob: (hash) => new BlobStore(path).get(hash),
    now: () => 1,
  };
  const gate = (phase: 'ready' | 'turn', turn: number | null): BoundaryGate =>
    createBoundaryGate(
      createBoundaryRegistry(), { phase, turn, signal: controller.signal, lookup }, callbacks,
    ).gate;
  const lifecycle = (type: string, data: JsonValue, opts?: { ignorable?: boolean }): EventEnvelope =>
    record((writer.append as unknown as (
      t: string, d: JsonValue, o?: { ignorable?: boolean },
    ) => EventEnvelope)(type, data, opts));

  const ready = gate('ready', null);
  const config = ready.append('system/message', {
    version: 1, value: { kind: 'inline', value: defaultAgentConfig() },
  });
  await ready.flush();
  const cfg: Source = { seq: config.seq, hash: config.hash };

  lifecycle('turn/start', { turn: 0, trigger: 'boot', world: { from: null, to: null } });
  const turn = gate('turn', 0);
  const id: RequestId = { turn: 0, ordinal: 0 };
  turn.append('request/plan', { id, value: await turn.store(minimalPlan(id, cfg)) });
  const wire = await turn.capture(Buffer.from('{}'), 'utf8');
  turn.append('request/wire', { id, attempt: 0, body: wire });
  const raw = await turn.capture(Buffer.from('raw'), 'utf8');
  turn.append('response/raw', { id, attempt: 0, status: 200, body: raw, complete: true });
  turn.append('assistant/message', { id, value: await turn.store(projection([], raw)) });
  await turn.flush();
  if (closeTurn) {
    lifecycle('turn/end', { turn: 0, outcome: 'waiting' });
    await writer.flush();
  }
  await writer.close();
  return loadVerifiedEvents(path, 'n1', C13_EVENT_TYPES);
}

async function stateOf(events: VerifiedEvents): Promise<ProjectionState> {
  const fold = new ContextFold();
  await fold.observe(events);
  return fold.snapshot();
}

/** Reconstructs from disk exactly as a restart would: full verification, then full fold. */
async function reload(path: string): Promise<ProjectionState> {
  return stateOf(await loadVerifiedEvents(path, 'n1', C13_EVENT_TYPES));
}

function checkpoint(state: ProjectionState): Snapshot {
  const mark = state.watermark;
  if (mark === null) throw new Error('expected the folded state to carry a watermark');
  return { ver: 1, seq: mark.seq, hash: mark.hash, val: state };
}

function clone(state: ProjectionState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

function withWatermark(state: ProjectionState, seq: number, hash: string): ProjectionState {
  const copy = clone(state);
  copy['watermark'] = { seq, hash };
  return copy as unknown as ProjectionState;
}

function withHeading(state: ProjectionState, text: string): ProjectionState {
  const copy = clone(state);
  const config = copy['config'] as { value: Record<string, unknown> } | null;
  if (config === null) throw new Error('expected the folded state to carry a config');
  config.value['heading'] = text;
  return copy as unknown as ProjectionState;
}

/** Writes a snapshot file verbatim, bypassing `writeSnapshot` — the on-disk tampering path. */
async function putValue(path: string, name: string, value: unknown): Promise<void> {
  await mkdir(snapshotsDir(path), { recursive: true });
  await writeFile(join(snapshotsDir(path), name), JSON.stringify(value));
}

describe('snapshots: round-trip', () => {
  it('round-trips a checkpoint at a real verified seq/hash', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const snap = checkpoint(state);

    await expect(writeSnapshot(path, 'n1', snap)).resolves.toBe(true);

    const onDisk: unknown = JSON.parse(await readFile(join(snapshotsDir(path), `${snap.seq}.json`), 'utf8'));
    expect(onDisk).toEqual(snap);

    const read = await readSnapshot(path, 'n1', events);
    expect(read).toEqual(snap);
    expect(read?.val.surface?.nodes.map((node) => node.group.kind)).toEqual(['heading', 'dialogue']);
  });

  it('round-trips a checkpoint of an open turn', async () => {
    const path = home();
    const events = await seedJournal(path, false);
    const state = await stateOf(events);
    expect(state.open).not.toBeNull();
    const snap = checkpoint(state);

    await expect(writeSnapshot(path, 'n1', snap)).resolves.toBe(true);
    await expect(readSnapshot(path, 'n1', events)).resolves.toEqual(snap);
  });

  it('round-trips non-ASCII state through an explicit utf8 decode', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const snap = checkpoint(withHeading(state, 'Émission ✓ — naïve'));

    await expect(writeSnapshot(path, 'n1', snap)).resolves.toBe(true);
    const read = await readSnapshot(path, 'n1', events);
    expect(read?.val.config?.value.heading).toBe('Émission ✓ — naïve');
  });

  it('round-trips a state carrying recovery, perception and pending compactions', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    const call: FunctionCall = {
      id: 'c1', type: 'function', function: { name: 'execute', arguments: '{}' },
    };
    const fake = 'c'.repeat(64);
    const enriched = {
      ...clone(state),
      surface: {
        heading: { text: 'heading', source: { seq: mark.seq, hash: mark.hash } },
        nodes: [{
          position: 1,
          group: {
            id: { seq: mark.seq, hash: mark.hash }, kind: 'perception', turn: 0,
            messages: [{ role: 'user', content: 'evidence' }],
            sources: [{ seq: mark.seq, hash: mark.hash }],
          },
        }],
        revision: fake,
      },
      recovery: [{
        turn: 0, request: { turn: 0, ordinal: 0 },
        assistant: { role: 'assistant', content: null, tool_calls: [call] },
        sources: [{ seq: mark.seq, hash: mark.hash }],
        results: [{ role: 'tool', content: 'ok', tool_call_id: 'c1' }],
        missing: [call],
      }],
      pendingCompactions: [{
        id: fake, revision: fake, groupIds: [{ seq: mark.seq, hash: mark.hash }],
        sources: [{ seq: mark.seq, hash: mark.hash }], shadowHash: fake, shadowBytes: 8,
      }],
    } as unknown as ProjectionState;
    const snap: Snapshot = { ver: 1, seq: mark.seq, hash: mark.hash, val: enriched };

    await expect(writeSnapshot(path, 'n1', snap)).resolves.toBe(true);
    const read = await readSnapshot(path, 'n1', events);
    expect(read).toEqual(snap);
    expect(read?.val.recovery[0]?.missing[0]?.id).toBe('c1');
    expect(read?.val.surface?.nodes[0]?.group.kind).toBe('perception');
    expect(read?.val.pendingCompactions[0]?.shadowBytes).toBe(8);
  });
});

describe('snapshots: write is best-effort and never throws', () => {
  it.each([Number.NaN, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'refuses a snapshot with an invalid seq (%s) and writes nothing',
    async (seq) => {
      const path = home();
      const events = await seedJournal(path);
      const state = await stateOf(events);
      const mark = state.watermark!;

      await expect(
        writeSnapshot(path, 'n1', { ver: 1, seq, hash: mark.hash, val: state }),
      ).resolves.toBe(false);
      await expect(readdir(snapshotsDir(path))).rejects.toThrow();
    },
  );

  it('refuses an unsupported version', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;

    await expect(
      writeSnapshot(path, 'n1', { ver: 2, seq: mark.seq, hash: mark.hash, val: state } as unknown as Snapshot),
    ).resolves.toBe(false);
    await expect(readdir(snapshotsDir(path))).rejects.toThrow();
  });

  it('refuses a hash that is not 64 lowercase hex characters', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;

    await expect(
      writeSnapshot(path, 'n1', { ver: 1, seq: mark.seq, hash: 'XYZ', val: state }),
    ).resolves.toBe(false);
    await expect(readdir(snapshotsDir(path))).rejects.toThrow();
  });

  it('returns false rather than throwing when the directory cannot be created', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    // A regular file where the `snapshots` directory must be: `mkdir` fails.
    await writeFile(snapshotsDir(path), 'not a directory');

    await expect(writeSnapshot(path, 'n1', checkpoint(state))).resolves.toBe(false);
  });
});

describe('snapshots: read validates and never throws', () => {
  it('returns null when the snapshots directory does not exist', async () => {
    const path = home();
    const events = await seedJournal(path);
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('ignores filenames that are not canonical nonnegative-safe-integer seqs', async () => {
    const path = home();
    const events = await seedJournal(path);
    const snap = checkpoint(await stateOf(events));
    for (const name of ['NaN.json', '-1.json', '1.5.json', '1e2.json', '007.json', 'x.json', '0.json.bak']) {
      await putValue(path, name, snap);
    }
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a snapshot with an unsupported version', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    await putValue(path, `${mark.seq}.json`, { ver: 2, seq: mark.seq, hash: mark.hash, val: state });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a hash that does not match the verified event at that seq', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    const wrong = 'a'.repeat(64);
    await putValue(path, `${mark.seq}.json`, {
      ver: 1, seq: mark.seq, hash: wrong, val: withWatermark(state, mark.seq, wrong),
    });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a malformed hash', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    await putValue(path, `${mark.seq}.json`, {
      ver: 1, seq: mark.seq, hash: 'xyz', val: withWatermark(state, mark.seq, 'xyz'),
    });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a snapshot whose filename seq does not match its content seq', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    const content = mark.seq - 1;
    await putValue(path, `${mark.seq}.json`, {
      ver: 1, seq: content, hash: mark.hash, val: withWatermark(state, content, mark.hash),
    });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a snapshot at a seq beyond the verified chain', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    const future = events.length;
    await putValue(path, `${future}.json`, {
      ver: 1, seq: future, hash: mark.hash, val: withWatermark(state, future, mark.hash),
    });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a state watermark ahead of the snapshot identity', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    await putValue(path, `${mark.seq}.json`, {
      ver: 1, seq: mark.seq, hash: mark.hash,
      val: withWatermark(state, mark.seq + 1, mark.hash),
    });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a state with no watermark', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    const noWatermark = clone(state);
    noWatermark['watermark'] = null;
    await putValue(path, `${mark.seq}.json`, { ver: 1, seq: mark.seq, hash: mark.hash, val: noWatermark });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a state that fails the schema', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    await putValue(path, `${mark.seq}.json`, {
      ver: 1, seq: mark.seq, hash: mark.hash,
      val: {
        config: null, surface: 'nope', open: null, recovery: [],
        watermark: { seq: mark.seq, hash: mark.hash }, pendingCompactions: [],
      },
    });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('rejects a state missing a required key', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    await putValue(path, `${mark.seq}.json`, {
      ver: 1, seq: mark.seq, hash: mark.hash,
      val: {
        config: null, surface: null, open: null, recovery: [],
        watermark: { seq: mark.seq, hash: mark.hash },
      },
    });
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('ignores a file that is not JSON', async () => {
    const path = home();
    const events = await seedJournal(path);
    const mark = (await stateOf(events)).watermark!;
    await mkdir(snapshotsDir(path), { recursive: true });
    await writeFile(join(snapshotsDir(path), `${mark.seq}.json`), '{ not json');
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('falls through a malformed newer row to an earlier valid one', async () => {
    const path = home();
    const events = await seedJournal(path);
    const state = await stateOf(events);
    const mark = state.watermark!;
    const earlier = events[0]!;
    await writeSnapshot(path, 'n1', {
      ver: 1, seq: earlier.raw.seq, hash: earlier.raw.hash,
      val: withWatermark(state, earlier.raw.seq, earlier.raw.hash),
    });
    await putValue(path, `${mark.seq}.json`, {
      ver: 1, seq: mark.seq, hash: mark.hash, val: { nonsense: true },
    });

    const read = await readSnapshot(path, 'n1', events);
    expect(read?.seq).toBe(earlier.raw.seq);
    expect(read?.hash).toBe(earlier.raw.hash);
  });
});

describe('snapshots: disposable, never a substitute for verification', () => {
  it('reconstructs identical nonempty history with a valid, stale, malformed or missing snapshot', async () => {
    const path = home();
    const events = await seedJournal(path);
    const baseline = await stateOf(events);
    expect(baseline.surface?.nodes.map((node) => node.group.kind)).toEqual(['heading', 'dialogue']);
    const mark = baseline.watermark!;

    await writeSnapshot(path, 'n1', checkpoint(baseline));
    expect(await reload(path)).toEqual(baseline);
    expect(await readSnapshot(path, 'n1', events)).toEqual(checkpoint(baseline));

    // Stale: same seq, a hash the chain never produced.
    await putValue(path, `${mark.seq}.json`, {
      ver: 1, seq: mark.seq, hash: 'b'.repeat(64), val: baseline,
    });
    expect(await reload(path)).toEqual(baseline);
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();

    // Malformed on disk.
    await writeFile(join(snapshotsDir(path), `${mark.seq}.json`), 'not json at all');
    expect(await reload(path)).toEqual(baseline);
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();

    // Missing.
    await rm(snapshotsDir(path), { recursive: true, force: true });
    expect(await reload(path)).toEqual(baseline);
    await expect(readSnapshot(path, 'n1', events)).resolves.toBeNull();
  });

  it('still rejects a corrupt early journal hash with a valid snapshot present', async () => {
    const path = home();
    const events = await seedJournal(path);
    const baseline = await stateOf(events);
    await writeSnapshot(path, 'n1', checkpoint(baseline));
    // The snapshot is readable against the pre-corruption chain...
    await expect(readSnapshot(path, 'n1', events)).resolves.toEqual(checkpoint(baseline));

    // ...but tampering with the first line's hash must still break verification.
    await rewriteLog(logPath(path), (lines) => {
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      first['hash'] = 'a'.repeat(64);
      lines[0] = JSON.stringify(first);
      return lines;
    });
    await expect(loadVerifiedEvents(path, 'n1', C13_EVENT_TYPES)).rejects.toThrow(ChainBreakError);
  });
});
