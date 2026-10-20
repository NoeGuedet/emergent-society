import { describe, expect, it, vi } from 'vitest';
import {
  BlobStore, JournalWriter, SessionAlreadyOwnedError, isCorruption, isRetryable,
  readVerifiedBlob, sha256HexOf, type JsonValue,
} from '../../journal/index.js';
import { injectBlobPut } from '../../journal/__tests__/helpers.js';
import {
  FRONTIER_MAX_BODY_BYTES, FrontierValidationError,
  type FrontierOutcome, type FrontierRequestInput, type HttpRequest, type HttpResponse,
} from '../events.js';
import { FrontierCorruptionError, FrontierUnknownCallError } from '../journal.js';
import {
  appendFrontierEvent, countBlobs, openTestFrontier, readFrontier, tearFrontierTail,
  useFrontierHome,
} from './helpers.js';

/**
 * The frontier gate is the truth record's write path: a request is durable and
 * provably readable before the caller sends, its terminal is durable before the
 * caller proceeds, and every refusal leaves the in-process integrity maps as
 * they were. Boot reconciles an orphan with one durable fact, never a guess.
 */

const home = useFrontierHome('cell-frontier-');

const URL = 'https://api.example.com/v1/messages';
const BODY = new TextEncoder().encode('{"model":"m","input":"hello"}');
const EMPTY = new Uint8Array(0);

function beginInput(overrides: Partial<FrontierRequestInput> = {}): FrontierRequestInput {
  return {
    method: 'POST',
    url: URL,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: [{ id: 'llm', where: 'authorization' }],
    body: BODY,
    encoding: 'utf8',
    ...overrides,
  };
}

function outcome(overrides: Partial<FrontierOutcome> = {}): FrontierOutcome {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
    body: new TextEncoder().encode('{"ok":true}'),
    encoding: 'utf8',
    complete: true,
    ...overrides,
  };
}

function requestOf(event: { data: unknown }): HttpRequest {
  return event.data as unknown as HttpRequest;
}

function responseOf(event: { data: unknown }): HttpResponse {
  return event.data as unknown as HttpResponse;
}

async function openFailure(at: string): Promise<unknown> {
  try {
    await openTestFrontier(at);
  } catch (err) {
    return err;
  }
  throw new Error('expected the frontier journal to refuse to open');
}

/** A coherent terminal payload for a call, used to forge damage shapes. */
function responseData(call: string): JsonValue {
  return {
    call,
    status: 200,
    headers: {},
    body: { encoding: 'binary', sha256: 'd'.repeat(64), bytes: 0, complete: true },
    timing: { durationMs: 1 },
    error: null,
  };
}

describe('begin', () => {
  it('writes the body blob, appends a verified http/request, and is readable before returning', async () => {
    const journal = await openTestFrontier(home());
    const call = await journal.gate.begin(beginInput());

    const events = await readFrontier(home());
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('http/request');
    const data = requestOf(events[0]!);
    expect(data.call).toBe(call.call);
    expect(data.group).toBe(call.group);
    expect(data.attempt).toBe(0);
    expect(data.method).toBe('POST');
    expect(data.url).toBe(URL);
    expect(data.headers).toEqual({
      'content-type': 'application/json', accept: 'application/json',
    });
    expect(data.credentials).toEqual([{ id: 'llm', where: 'authorization' }]);
    expect(data.body).toEqual({
      encoding: 'utf8',
      sha256: sha256HexOf(Buffer.from(BODY)),
      bytes: BODY.byteLength,
      complete: true,
    });
    expect(data.world_head).toBeNull();

    // The blob the event names is the exact body and verifies through the
    // journal's one trusted read — not merely present on disk.
    const stored = await readVerifiedBlob(
      { blob: data.body.sha256, size: data.body.bytes },
      (hash) => new BlobStore(home()).get(hash),
    );
    expect(Buffer.from(stored).equals(Buffer.from(BODY))).toBe(true);
    await journal.close();
  });

  it('writes neither a blob nor an event when the input is refused', async () => {
    const journal = await openTestFrontier(home());
    await expect(journal.gate.begin(beginInput({ url: `${URL}?key=secret` })))
      .rejects.toThrow(FrontierValidationError);
    expect(await readFrontier(home())).toHaveLength(0);
    expect(await countBlobs(home())).toBe(0);
    await journal.close();
  });

  it('classifies a validation refusal as a journal refusal, not corruption or retryable', async () => {
    const journal = await openTestFrontier(home());
    const err = await journal.gate.begin(beginInput({ url: `${URL}?key=secret` }))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FrontierValidationError);
    expect(isCorruption(err)).toBe(false);
    expect(isRetryable(err)).toBe(false);
    await journal.close();
  });

  it('refuses an input that carries world_head: the gate stamps it', async () => {
    const journal = await openTestFrontier(home());
    const input = { ...beginInput(), world_head: 'a'.repeat(40) };
    await expect(journal.gate.begin(input as unknown as FrontierRequestInput))
      .rejects.toThrow(FrontierValidationError);
    expect(await readFrontier(home())).toHaveLength(0);
    expect(await countBlobs(home())).toBe(0);
    await journal.close();
  });

  it('stamps world_head from the callback, normalizing a bad stamp to null', async () => {
    const cases: [() => Promise<string | null>, string | null][] = [
      [async () => 'a'.repeat(40), 'a'.repeat(40)],
      [async () => 'b'.repeat(64), 'b'.repeat(64)],
      [async () => { throw new Error('git failed'); }, null],
      [async () => 'f'.repeat(41), null],
      [async () => 'A'.repeat(40), null],
      [async () => null, null],
    ];
    for (const [worldHead, expected] of cases) {
      const journal = await openTestFrontier(home(), worldHead);
      await journal.gate.begin(beginInput());
      await journal.close();
      // Reopening reconciles the previous orphan; the request appended by this
      // iteration's begin is the last request event.
      const requests = (await readFrontier(home()))
        .filter((event) => event.type === 'http/request');
      expect(requestOf(requests[requests.length - 1]!).world_head).toBe(expected);
    }
  });

  it('stores one blob for two begins carrying the same body', async () => {
    const journal = await openTestFrontier(home());
    const first = await journal.gate.begin(beginInput());
    const second = await journal.gate.begin(beginInput());
    expect(second.call).not.toBe(first.call);
    expect(second.group).not.toBe(first.group);

    const events = await readFrontier(home());
    expect(events).toHaveLength(2);
    const one = requestOf(events[0]!).body;
    const two = requestOf(events[1]!).body;
    expect(two.sha256).toBe(one.sha256);
    expect(await countBlobs(home())).toBe(1);
    await journal.close();
  });

  it('accepts exactly FRONTIER_MAX_BODY_BYTES', { timeout: 60_000 }, async () => {
    const journal = await openTestFrontier(home());
    const body = new Uint8Array(FRONTIER_MAX_BODY_BYTES);
    await journal.gate.begin(beginInput({ body, encoding: 'binary' }));

    const data = requestOf((await readFrontier(home()))[0]!);
    expect(data.body.bytes).toBe(FRONTIER_MAX_BODY_BYTES);
    expect(await countBlobs(home())).toBe(1);
    await journal.close();
  });

  it('refuses one byte over the ceiling with no event and no blob', { timeout: 60_000 }, async () => {
    const journal = await openTestFrontier(home());
    const body = new Uint8Array(FRONTIER_MAX_BODY_BYTES + 1);
    await expect(journal.gate.begin(beginInput({ body, encoding: 'binary' })))
      .rejects.toThrow(FrontierValidationError);
    expect(await readFrontier(home())).toHaveLength(0);
    expect(await countBlobs(home())).toBe(0);
    await journal.close();
  });
});

describe('retry integrity', () => {
  it('refuses attempt 0 on a known group, a repeated attempt and a skipped attempt', async () => {
    const journal = await openTestFrontier(home());
    await journal.gate.begin(beginInput({ group: 'g1', attempt: 0 }));

    await expect(journal.gate.begin(beginInput({ group: 'g1', attempt: 0 })))
      .rejects.toThrow(FrontierValidationError);
    await journal.gate.begin(beginInput({ group: 'g1', attempt: 1 }));
    await expect(journal.gate.begin(beginInput({ group: 'g1', attempt: 1 })))
      .rejects.toThrow(FrontierValidationError);
    await expect(journal.gate.begin(beginInput({ group: 'g1', attempt: 3 })))
      .rejects.toThrow(FrontierValidationError);
    await journal.close();
  });

  it('accepts a supplied group with no entry at attempt > 0 (fail-open eviction)', async () => {
    const journal = await openTestFrontier(home());
    const call = await journal.gate.begin(beginInput({ group: 'never-seen', attempt: 4 }));
    expect(call.group).toBe('never-seen');
    await journal.close();
  });

  it('refuses an omitted group at attempt > 0', async () => {
    const journal = await openTestFrontier(home());
    await expect(journal.gate.begin(beginInput({ attempt: 1 })))
      .rejects.toThrow(FrontierValidationError);
    await journal.close();
  });

  it('evicts beyond maxGroups without ever refusing a supplied group', async () => {
    const journal = await openTestFrontier(home(), undefined, { maxGroups: 2 });
    await journal.gate.begin(beginInput({ group: 'g1', attempt: 0 }));
    await journal.gate.begin(beginInput({ group: 'g2', attempt: 0 }));
    await journal.gate.begin(beginInput({ group: 'g3', attempt: 0 }));

    // g1 was evicted, so its retry is accepted and reinserted.
    const retry = await journal.gate.begin(beginInput({ group: 'g1', attempt: 1 }));
    expect(retry.group).toBe('g1');
    // Reinserted at attempt 1, so a repeated attempt is refused again.
    await expect(journal.gate.begin(beginInput({ group: 'g1', attempt: 1 })))
      .rejects.toThrow(FrontierValidationError);
    await journal.close();
  });
});

describe('complete', () => {
  it('appends a verified http/response with a gate-measured duration', async () => {
    let now = 1000;
    const journal = await openTestFrontier(home(), undefined, { now: () => now });
    const call = await journal.gate.begin(beginInput());
    const received = new Uint8Array([0, 255, 128, 0xc3, 0x28]);
    now = 1042;
    await journal.gate.complete(call, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'x-request-id': 'req_1' },
      body: received,
      encoding: 'binary',
      complete: true,
    });

    const events = await readFrontier(home());
    expect(events.map((event) => event.type)).toEqual(['http/request', 'http/response']);
    const data = responseOf(events[1]!);
    expect(data.call).toBe(call.call);
    expect(data.status).toBe(200);
    expect(data.headers).toEqual({
      'content-type': 'application/octet-stream', 'x-request-id': 'req_1',
    });
    expect(data.body).toEqual({
      encoding: 'binary',
      sha256: sha256HexOf(Buffer.from(received)),
      bytes: received.byteLength,
      complete: true,
    });
    expect(data.timing).toEqual({ durationMs: 42 });
    expect(data.error).toBeNull();

    const stored = await readVerifiedBlob(
      { blob: data.body.sha256, size: data.body.bytes },
      (hash) => new BlobStore(home()).get(hash),
    );
    expect(Buffer.from(stored).equals(Buffer.from(received))).toBe(true);
    await journal.close();
  });

  it('refuses an incoherent outcome before any terminal or response blob exists', async () => {
    const journal = await openTestFrontier(home());
    const call = await journal.gate.begin(beginInput());
    await expect(journal.gate.complete(call, {
      status: null, body: EMPTY, encoding: 'binary', complete: false,
    })).rejects.toThrow(FrontierValidationError);
    expect((await readFrontier(home())).map((event) => event.type)).toEqual(['http/request']);
    expect(await countBlobs(home())).toBe(1);

    // The call is still open: a coherent terminal after the refusal succeeds.
    await journal.gate.complete(call, outcome());
    expect((await readFrontier(home())).map((event) => event.type))
      .toEqual(['http/request', 'http/response']);
    await journal.close();
  });

  it('refuses a complete for an unknown call without fabricating a duration', async () => {
    const journal = await openTestFrontier(home());
    await expect(journal.gate.complete({ call: 'never-begun', group: 'g' }, outcome()))
      .rejects.toBeInstanceOf(FrontierUnknownCallError);
    expect(await readFrontier(home())).toHaveLength(0);
    expect(await countBlobs(home())).toBe(0);
    await journal.close();
  });

  it('refuses a complete for a call whose terminal is already durable', async () => {
    const journal = await openTestFrontier(home());
    const call = await journal.gate.begin(beginInput());
    await journal.gate.complete(call, outcome());
    // The call is retired as soon as its terminal is durable, so a retry is an
    // unknown call rather than a duplicate terminal in the log.
    await expect(journal.gate.complete(call, outcome()))
      .rejects.toBeInstanceOf(FrontierUnknownCallError);
    expect((await readFrontier(home())).map((event) => event.type))
      .toEqual(['http/request', 'http/response']);
    await journal.close();
  });

  it('refuses a complete for a call that began in a previous process', async () => {
    const first = await openTestFrontier(home());
    const call = await first.gate.begin(beginInput());
    await first.close();

    const second = await openTestFrontier(home());
    // Reconciliation has already recorded the terminal fact for this orphan.
    expect((await readFrontier(home())).map((event) => event.type))
      .toEqual(['http/request', 'http/incomplete']);
    await expect(second.gate.complete(call, outcome()))
      .rejects.toBeInstanceOf(FrontierUnknownCallError);
    await second.close();
  });
});

describe('body fidelity', () => {
  it('round-trips a producer-declared binary body exactly', async () => {
    const journal = await openTestFrontier(home());
    const body = new Uint8Array([0, 1, 2, 0x7f, 0x80, 0xff, 0xc3, 0x28]);
    await journal.gate.begin(beginInput({ body, encoding: 'binary' }));
    const ref = requestOf((await readFrontier(home()))[0]!).body;
    expect(ref.encoding).toBe('binary');
    expect(ref.sha256).toBe(sha256HexOf(Buffer.from(body)));
    expect(ref.bytes).toBe(body.byteLength);
    const stored = await new BlobStore(home()).get(ref.sha256);
    expect(Buffer.from(stored).equals(Buffer.from(body))).toBe(true);
    await journal.close();
  });

  it('round-trips a producer-declared utf8 body exactly', async () => {
    const journal = await openTestFrontier(home());
    const body = new TextEncoder().encode('héllo € — 世界');
    await journal.gate.begin(beginInput({ body, encoding: 'utf8' }));
    const ref = requestOf((await readFrontier(home()))[0]!).body;
    expect(ref.encoding).toBe('utf8');
    expect(ref.sha256).toBe(sha256HexOf(Buffer.from(body)));
    expect(ref.bytes).toBe(body.byteLength);
    const stored = await new BlobStore(home()).get(ref.sha256);
    expect(Buffer.from(stored).equals(Buffer.from(body))).toBe(true);
    await journal.close();
  });

  it('resolves an empty body as the content-addressed empty blob', async () => {
    const journal = await openTestFrontier(home());
    await journal.gate.begin(beginInput({ body: EMPTY, encoding: 'binary' }));
    const ref = requestOf((await readFrontier(home()))[0]!).body;
    expect(ref.bytes).toBe(0);
    expect(ref.sha256).toBe(sha256HexOf(Buffer.alloc(0)));
    const stored = await readVerifiedBlob(
      { blob: ref.sha256, size: 0 },
      (hash) => new BlobStore(home()).get(hash),
    );
    expect(stored).toHaveLength(0);
    await journal.close();
  });
});

describe('begin failure paths', () => {
  it('leaves no retry entry after a validator refusal', async () => {
    const journal = await openTestFrontier(home());
    await expect(journal.gate.begin(beginInput({ group: 'g', attempt: 0, url: `${URL}?x=1` })))
      .rejects.toThrow(FrontierValidationError);
    const call = await journal.gate.begin(beginInput({ group: 'g', attempt: 0 }));
    expect(call.group).toBe('g');
    await journal.close();
  });

  it('leaves no retry entry after a blob write failure', async () => {
    const journal = await openTestFrontier(home());
    injectBlobPut({ failAt: 1 });
    const appendSpy = vi.spyOn(JournalWriter.prototype, 'append');
    await expect(journal.gate.begin(beginInput({ group: 'g', attempt: 0 })))
      .rejects.toThrow('injected blob write failure');
    // §5.3 step 3: no event may exist to reference a blob that was never
    // written, so the append is never even reached (it is in-memory, which is
    // why an empty log alone would not prove the ordering).
    expect(appendSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(await readFrontier(home())).toHaveLength(0);
    const call = await journal.gate.begin(beginInput({ group: 'g', attempt: 0 }));
    expect(call.group).toBe('g');
    await journal.close();
  });

  it('leaves no retry entry after a flush failure', async () => {
    const journal = await openTestFrontier(home());
    vi.spyOn(JournalWriter.prototype, 'flush')
      .mockRejectedValueOnce(new Error('injected flush failure'));
    await expect(journal.gate.begin(beginInput({ group: 'g', attempt: 0 })))
      .rejects.toThrow('injected flush failure');
    vi.restoreAllMocks();
    const retry = await journal.gate.begin(beginInput({ group: 'g', attempt: 0 }));
    expect(retry.group).toBe('g');

    // The retry's flush made the failed begin's event durable with it. That
    // event still has no timing entry, so a terminal for it is refused as
    // unknown — proving the failed begin never entered the timing map.
    const requests = (await readFrontier(home()))
      .filter((event) => event.type === 'http/request')
      .map(requestOf);
    expect(requests).toHaveLength(2);
    const failed = requests.find((event) => event.call !== retry.call);
    expect(failed).toBeDefined();
    await expect(journal.gate.complete(
      { call: failed!.call, group: failed!.group }, outcome(),
    )).rejects.toBeInstanceOf(FrontierUnknownCallError);
    await journal.close();
  });

  it('leaves no retry and no timing entry after a failed read-back', async () => {
    const journal = await openTestFrontier(home());
    vi.spyOn(BlobStore.prototype, 'get')
      .mockRejectedValueOnce(new Error('injected read-back failure'));
    await expect(journal.gate.begin(beginInput({ group: 'g', attempt: 0 })))
      .rejects.toThrow('injected read-back failure');
    vi.restoreAllMocks();

    // The event reached the log before the read-back, so its call id is
    // visible; a complete for it must still be refused as unknown, proving the
    // timing map never received the entry.
    const durable = requestOf((await readFrontier(home()))[0]!);
    await expect(journal.gate.complete({ call: durable.call, group: durable.group }, outcome()))
      .rejects.toBeInstanceOf(FrontierUnknownCallError);

    // And the group/attempt is not burned: the retry is accepted.
    const retry = await journal.gate.begin(beginInput({ group: 'g', attempt: 0 }));
    expect(retry.group).toBe('g');
    await journal.close();
  });
});

describe('boot reconciliation', () => {
  it('appends exactly one http/incomplete per orphan and then none', async () => {
    const first = await openTestFrontier(home());
    const call = await first.gate.begin(beginInput());
    await first.close();

    expect((await readFrontier(home())).map((event) => event.type)).toEqual(['http/request']);

    const second = await openTestFrontier(home());
    const reconciled = await readFrontier(home());
    expect(reconciled.map((event) => event.type)).toEqual(['http/request', 'http/incomplete']);
    expect(reconciled[1]!.data).toEqual({ call: call.call });
    await second.close();

    const third = await openTestFrontier(home());
    await third.close();
    expect(await readFrontier(home())).toHaveLength(2);
  });

  it('appends nothing on a boot with no orphan', async () => {
    const journal = await openTestFrontier(home());
    await journal.close();
    expect(await readFrontier(home())).toHaveLength(0);
  });

  it('appends nothing for a request that already has a terminal', async () => {
    const journal = await openTestFrontier(home());
    const call = await journal.gate.begin(beginInput());
    await journal.gate.complete(call, outcome());
    await journal.close();

    const reopened = await openTestFrontier(home());
    await reopened.close();
    expect((await readFrontier(home())).map((event) => event.type))
      .toEqual(['http/request', 'http/response']);
  });

  it('classifies a malformed payload as corruption while the chain verifies', async () => {
    const journal = await openTestFrontier(home());
    await journal.close();
    await appendFrontierEvent(home(), 'http/request', { call: 'no-fields' });

    // The chain itself verifies: the damage is in the payload alone.
    expect(await readFrontier(home())).toHaveLength(1);

    const err = await openFailure(home());
    expect(err).toBeInstanceOf(FrontierCorruptionError);
    expect(isCorruption(err)).toBe(true);
    // The failed open released the writer lock; the refusal is corruption again,
    // never a live-owner error.
    await expect(openTestFrontier(home())).rejects.toBeInstanceOf(FrontierCorruptionError);
  });

  it('classifies a terminal for an unknown call as corruption', async () => {
    const journal = await openTestFrontier(home());
    await journal.close();
    await appendFrontierEvent(home(), 'http/response', responseData('ghost'));

    const err = await openFailure(home());
    expect(err).toBeInstanceOf(FrontierCorruptionError);
    expect(isCorruption(err)).toBe(true);
  });

  it('classifies a duplicate terminal as corruption', async () => {
    const journal = await openTestFrontier(home());
    const call = await journal.gate.begin(beginInput());
    await journal.gate.complete(call, outcome());
    await journal.close();
    await appendFrontierEvent(home(), 'http/response', responseData(call.call));

    const err = await openFailure(home());
    expect(err).toBeInstanceOf(FrontierCorruptionError);
    expect(isCorruption(err)).toBe(true);
  });

  it('closes the writer, swallowing a rejected close, when reconciliation fails', async () => {
    const seeded = await openTestFrontier(home());
    await seeded.close();
    await appendFrontierEvent(home(), 'http/request', { call: 'no-fields' });

    const realClose = JournalWriter.prototype.close;
    const closeSpy = vi.spyOn(JournalWriter.prototype, 'close').mockImplementation(
      async function (this: JournalWriter): Promise<void> {
        await realClose.call(this);
        throw new Error('injected close failure');
      },
    );
    try {
      const err = await openFailure(home());
      expect(err).toBeInstanceOf(FrontierCorruptionError);
      expect((err as Error).message).not.toContain('injected close failure');
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
    // Real close ran before the injected rejection, so the lock is free.
    await expect(openTestFrontier(home())).rejects.toBeInstanceOf(FrontierCorruptionError);
  });

  it('repairs a torn tail planted in the frontier directory', async () => {
    const journal = await openTestFrontier(home());
    const call = await journal.gate.begin(beginInput());
    await journal.gate.complete(call, outcome());
    await journal.close();
    await tearFrontierTail(home());

    const reopened = await openTestFrontier(home());
    await reopened.close();
    expect((await readFrontier(home())).map((event) => event.type))
      .toEqual(['http/request', 'http/response']);
  });

  it('refuses a second live opener and succeeds after close', async () => {
    const journal = await openTestFrontier(home());
    await expect(openTestFrontier(home())).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    await journal.close();
    const reopened = await openTestFrontier(home());
    await reopened.close();
  });
});
