import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { canonicalizeJson, type JsonValue } from '../../journal/canon.js';
import {
  FORMAT_VERSION, GENESIS_HASH, computeHash, type EventEnvelope,
} from '../../journal/envelope.js';
import { encodeBatch, scanBatches } from '../../journal/framing.js';
import { frontierLayout, type JournalLayout } from '../../journal/layout.js';
import { JournalReader } from '../../journal/reader.js';
import { JournalWriter } from '../../journal/writer.js';
import { DEFAULT_STORAGE_POLICY, type StorageConfig } from '../../storage.js';
import { statfsProbe } from '../../node/storage-probe.js';
import { FRONTIER_EVENT_TYPES } from '../events.js';
import { openFrontierJournal, type FrontierJournal } from '../journal.js';

/**
 * Scaffolding shared by the frontier suites: a temp cell home per test, the
 * one-option-surface opener the task promises to later tasks, and the raw-log
 * helpers a reconciliation test needs to plant a damage shape the gate itself
 * would never write.
 *
 * `openTestFrontier` forwards every knob the journal takes — the clock, the
 * write-behind window and the retry map's bound — so a test never waits on a
 * timer, sleeps for a duration, or spends 4097 begins on an eviction.
 */

export const TEST_EPOCH = 1789000000000;

/**
 * Installs a temp cell home for the enclosing suite and removes it afterwards.
 * The returned getter reads the current path, so the value is fresh per test.
 */
export function useFrontierHome(prefix: string): () => string {
  let home = '';
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), prefix));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });
  return () => home;
}

/**
 * The real storage seam for suites that do not exercise a refusal: the
 * production enforcement policy over the real `statfs` probe, so every
 * frontier/node test runs the same circuit breaker production does (a test
 * home under `/tmp` passes the 2 GiB + 512 MiB / 100k + 10k floors).
 */
export const TEST_STORAGE: StorageConfig = {
  policy: DEFAULT_STORAGE_POLICY, probe: statfsProbe,
};

/** The knobs `openTestFrontier` exposes on top of the journal's own options. */
export type TestFrontierOptions = {
  readonly now?: () => number;
  readonly batchWindowMs?: number;
  readonly maxGroups?: number;
  readonly storage?: StorageConfig;
};

/**
 * Opens a frontier journal for a test. The world-head callback defaults to
 * `null` (no world repo is needed by the gate suite); the write-behind window
 * defaults high because the gate flushes explicitly and a test must never race
 * a timer. The storage seam defaults to the real probe; a refusal case injects
 * a low one.
 */
export function openTestFrontier(
  home: string,
  worldHead: () => Promise<string | null> = async () => null,
  opts: TestFrontierOptions = {},
): Promise<FrontierJournal> {
  return openFrontierJournal(home, {
    worldHead,
    now: opts.now ?? (() => Date.now()),
    batchWindowMs: opts.batchWindowMs ?? 60_000,
    ...(opts.maxGroups === undefined ? {} : { maxGroups: opts.maxGroups }),
    storage: opts.storage ?? TEST_STORAGE,
  });
}

/** Every event the frontier journal serves, in order. */
export async function readFrontier(home: string, fromSeq = 0): Promise<EventEnvelope[]> {
  const reader = await JournalReader.openIn(frontierLayout(home), {
    knownTypes: FRONTIER_EVENT_TYPES,
  });
  const events: EventEnvelope[] = [];
  for await (const event of reader.events(fromSeq)) events.push(event);
  return events;
}

/** How many content-addressed blobs the cell home holds. */
export async function countBlobs(home: string): Promise<number> {
  try {
    const entries = await readdir(join(home, 'blobs'), {
      recursive: true, withFileTypes: true,
    });
    return entries.filter((entry) => entry.isFile()).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Appends one chain-consistent event to the frontier log. This stands in for
 * direct tampering: the chain verifies exactly (correct `prev_hash` and
 * `hash`), so only reconciliation's payload rules can catch the shape the test
 * plants. The journal must be closed first.
 */
export async function appendFrontierEvent(
  home: string, type: string, data: JsonValue,
): Promise<EventEnvelope> {
  const layout = frontierLayout(home);
  const path = join(layout.dir, layout.logFile);
  const { batches } = scanBatches(await readFile(path));
  const lines = batches.flatMap((batch) => batch.lines);
  const lastLine = lines[lines.length - 1];
  const last = lastLine === undefined ? null : JSON.parse(lastLine) as EventEnvelope;
  const unsigned = {
    v: FORMAT_VERSION,
    type,
    seq: last === null ? 0 : last.seq + 1,
    time: TEST_EPOCH,
    prev_hash: last === null ? GENESIS_HASH : last.hash,
    data,
  };
  const line = canonicalizeJson({ ...unsigned, hash: computeHash(unsigned) });
  await writeFile(path, encodeBatch([...lines, line]));
  return JSON.parse(line) as EventEnvelope;
}

/**
 * Injects one frontier-flush fault: every flush of the writer bound to this
 * home's frontier layout rejects while the injection lives. The filter is the
 * writer's own layout directory, so the local log's writer and every blob write
 * are untouched — a global `FileHandle.write` patch would hit both.
 *
 * Returns the restore function (the suite's `vi.restoreAllMocks()` also
 * restores it). The shared seam the acceptance harness (T8.2) reuses.
 */
export function failFrontierFlushes(home: string): () => void {
  const dir = frontierLayout(home).dir;
  const real = JournalWriter.prototype.flush;
  const spy = vi.spyOn(JournalWriter.prototype, 'flush').mockImplementation(
    async function (this: JournalWriter): Promise<void> {
      const layout = (this as unknown as { readonly layout: JournalLayout }).layout;
      if (layout.dir === dir) throw new Error('injected frontier flush failure');
      return real.call(this);
    },
  );
  return () => { spy.mockRestore(); };
}

/** Appends a physically torn trailing fragment to the frontier log. */
export async function tearFrontierTail(home: string, bytes = 9): Promise<void> {
  const layout = frontierLayout(home);
  await appendFile(
    join(layout.dir, layout.logFile),
    encodeBatch(['{"torn":true}']).subarray(0, bytes),
  );
}
