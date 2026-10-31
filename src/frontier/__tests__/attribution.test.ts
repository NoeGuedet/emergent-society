import { appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidNodeUidError, JournalClosedError, frontierLayout } from '../../journal/index.js';
import {
  FRONTIER_MAX_BODY_BYTES, FrontierValidationError, type FrontierRequestInput,
} from '../events.js';
import {
  ATTRIBUTION_FILE, AttributionLog, attributeFrontier, readAttribution,
  type AttributionSink,
} from '../attribution.js';
import { openTestFrontier, readFrontier, useFrontierHome } from './helpers.js';

/**
 * The attribution sidecar: the actor the frozen, node-blind frontier cannot
 * hold. One line per begun exchange, written after the request is durable and
 * before the send; a refused begin leaves no line, a failed append refuses the
 * exchange, and a torn tail is dropped at open rather than concatenated.
 */

const home = useFrontierHome('cell-attribution-');

const BODY = new TextEncoder().encode('{"model":"m","input":"hello"}');

function beginInput(overrides: Partial<FrontierRequestInput> = {}): FrontierRequestInput {
  return {
    method: 'POST',
    url: 'https://api.example.com/v1/messages',
    headers: { 'content-type': 'application/json' },
    credentials: [{ id: 'llm', where: 'authorization' }],
    body: BODY,
    encoding: 'utf8',
    ...overrides,
  };
}

type RequestData = { readonly call: string };

async function requestCalls(at: string): Promise<string[]> {
  const events = await readFrontier(at);
  return events
    .filter((event) => event.type === 'http/request')
    .map((event) => (event.data as unknown as RequestData).call);
}

function attributionPath(at: string): string {
  return join(frontierLayout(at).dir, ATTRIBUTION_FILE);
}

describe('attribution sidecar', () => {
  it('records one line per begun exchange, in the frontier call order', async () => {
    const journal = await openTestFrontier(home());
    const n1 = journal.attribute('n1');
    const first = await n1.begin(beginInput());
    const second = await n1.begin(beginInput());
    await journal.close();

    const records = await readAttribution(home());
    expect(records).toEqual([
      { v: 0, call: first.call, uid: 'n1' },
      { v: 0, call: second.call, uid: 'n1' },
    ]);
    // The ids are the frontier's own request call ids, in the same order: the
    // sidecar joins the chain, it does not invent a second timeline.
    expect(records.map((record) => record.call)).toEqual(await requestCalls(home()));
  });

  it('attributes each node’s own view over the one shared gate', async () => {
    const journal = await openTestFrontier(home());
    const n1 = journal.attribute('n1');
    const n2 = journal.attribute('n2');
    const a = await n1.begin(beginInput());
    const b = await n2.begin(beginInput());
    const c = await n1.begin(beginInput());
    await journal.close();

    expect(await readAttribution(home())).toEqual([
      { v: 0, call: a.call, uid: 'n1' },
      { v: 0, call: b.call, uid: 'n2' },
      { v: 0, call: c.call, uid: 'n1' },
    ]);
  });

  it('keeps every line of concurrent exchanges whole', async () => {
    const journal = await openTestFrontier(home());
    const view = journal.attribute('n1');
    const calls = await Promise.all([
      view.begin(beginInput()), view.begin(beginInput()), view.begin(beginInput()),
    ]);
    await journal.close();

    const records = await readAttribution(home());
    expect(records).toHaveLength(3);
    expect(new Set(records.map((record) => record.call)))
      .toEqual(new Set(calls.map((call) => call.call)));
    expect(records.every((record) => record.v === 0 && record.uid === 'n1')).toBe(true);
  });

  it('refuses an append after close', async () => {
    const log = await AttributionLog.open(home());
    await log.close();
    await expect(log.append('call', 'n1')).rejects.toBeInstanceOf(JournalClosedError);
  });

  it('refuses an invalid uid at the view, before any exchange', async () => {
    const journal = await openTestFrontier(home());
    expect(() => journal.attribute('bad uid')).toThrow(InvalidNodeUidError);
    await journal.close();
  });

  it('appends nothing when the frontier begin refuses', async () => {
    const journal = await openTestFrontier(home());
    const n1 = journal.attribute('n1');
    const oversized = new Uint8Array(FRONTIER_MAX_BODY_BYTES + 1);
    await expect(n1.begin(beginInput({ body: oversized })))
      .rejects.toBeInstanceOf(FrontierValidationError);
    await journal.close();
    expect(await readAttribution(home())).toEqual([]);
  });

  it('refuses the exchange before the send when the append fails', async () => {
    const journal = await openTestFrontier(home());
    const failing: AttributionSink = {
      append: async () => { throw new Error('injected attribution failure'); },
    };
    const view = attributeFrontier(journal.gate, 'n1', failing);
    await expect(view.begin(beginInput())).rejects.toThrow('injected attribution failure');
    await journal.close();
    // The request half was already durable: the exchange is recorded, its actor
    // is not — an honest gap, never an effect after a refused attribution.
    expect(await requestCalls(home())).toHaveLength(1);
    expect(await readAttribution(home())).toEqual([]);
  });

  it('drops a torn tail at open and keeps the complete records', async () => {
    const journal = await openTestFrontier(home());
    await journal.attribute('n1').begin(beginInput());
    await journal.close();
    await appendFile(attributionPath(home()), '{"v":0,"call":"torn');

    const reopened = await openTestFrontier(home());
    await reopened.attribute('n2').begin(beginInput());
    await reopened.close();

    const records = await readAttribution(home());
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.uid)).toEqual(['n1', 'n2']);
  });

  it('creates the sidecar owner-only on the first append', async () => {
    const journal = await openTestFrontier(home());
    await journal.attribute('n1').begin(beginInput());
    const mode = (await stat(attributionPath(home()))).mode & 0o777;
    await journal.close();
    expect(mode).toBe(0o600);
  });

  it('reads an absent sidecar as an empty list', async () => {
    expect(await readAttribution(home())).toEqual([]);
  });
});
