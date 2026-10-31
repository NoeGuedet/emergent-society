import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { openFrontierJournal } from '../journal.js';
import {
  StorageError, type StorageConfig, type StorageFree, type StoragePolicy,
} from '../../storage.js';
import { countBlobs, readFrontier, useFrontierHome } from './helpers.js';

/**
 * The frontier gate's storage home: `begin` probes after validating the input
 * and before the world-head stamp, the body blob and the event.
 *
 * A refusal is therefore a refused effect that never existed — no blob, no
 * event, no retry-map entry — and a later high probe begins normally. `complete`
 * has no gate check: it is post-effect, and the writer's own home still guards
 * the log.
 */

const home = useFrontierHome('frontier-storage-');

const policy: StoragePolicy = {
  minFreeBytes: 100, minFreeInodes: 10, reserveBytes: 0, reserveInodes: 0,
};

const HIGH: StorageFree = { bytes: 1_000, inodes: 1_000 };
const LOW: StorageFree = { bytes: 99, inodes: 1_000 };

type State = { free: StorageFree | null };
const guard = (state: State): StorageConfig => ({ policy, probe: async () => state.free });

const input = {
  method: 'POST' as const,
  url: 'https://h/v1/x',
  headers: {},
  body: Buffer.from('{"a":1}'),
  encoding: 'utf8' as const,
};

describe('frontier Gate.begin storage home', () => {
  it('refuses before any blob, event or world-head read exists, and a later high probe begins', async () => {
    const state: State = { free: LOW };
    let worldHeadReads = 0;
    const journal = await openFrontierJournal(home(), {
      worldHead: async () => { worldHeadReads += 1; return null; },
      now: () => 1, storage: guard(state),
    });
    try {
      await expect(journal.gate.begin(input)).rejects.toBeInstanceOf(StorageError);
      expect(await readFrontier(home())).toEqual([]);
      expect(await countBlobs(home())).toBe(0);
      // The refusal precedes even the best-effort world-head stamp.
      expect(worldHeadReads).toBe(0);

      state.free = HIGH;
      const call = await journal.gate.begin(input);
      expect(typeof call.call).toBe('string');
      expect(await readFrontier(home())).toHaveLength(1);
      expect(await countBlobs(home())).toBe(1);
      await journal.gate.complete(call, {
        status: 200, headers: {}, body: Buffer.from('ok'), encoding: 'utf8', complete: true,
      });
      expect((await readFrontier(home())).map((event) => event.type))
        .toEqual(['http/request', 'http/response']);
    } finally {
      await journal.close();
    }
  });

  it('burns no attempt or group on a refused begin', async () => {
    const state: State = { free: LOW };
    const journal = await openFrontierJournal(home(), {
      worldHead: async () => null, now: () => 1, storage: guard(state),
    });
    try {
      const grouped = { ...input, group: 'g-1', attempt: 0 };
      await expect(journal.gate.begin(grouped)).rejects.toBeInstanceOf(StorageError);
      state.free = HIGH;
      // The same group at the same attempt is still a first attempt: the
      // refusal never reached the retry map.
      await expect(journal.gate.begin(grouped)).resolves.toMatchObject({ group: 'g-1' });
    } finally {
      await journal.close();
    }
  });

  it('guards the frontier writer itself: a probe that falls between begin and flush refuses without poisoning', async () => {
    const state: State = { free: HIGH };
    let first = true;
    const probe = async (): Promise<StorageFree | null> => {
      if (first) { first = false; return HIGH; }
      return state.free;
    };
    const journal = await openFrontierJournal(home(), {
      worldHead: async () => null, now: () => 1, storage: { policy, probe },
    });
    try {
      // The gate's check passes (first probe HIGH); the writer's flush checks
      // again and refuses (LOW): the blob was already durable, no event landed,
      // and the writer is not poisoned (the next flush lands the pending event).
      state.free = LOW;
      await expect(journal.gate.begin(input)).rejects.toBeInstanceOf(StorageError);
      expect(await readFrontier(home())).toEqual([]);
      expect(await countBlobs(home())).toBe(1);

      state.free = HIGH;
      await journal.gate.begin(input);
      expect((await readFrontier(home())).map((event) => event.type))
        .toEqual(['http/request', 'http/request']);
    } finally {
      await journal.close();
    }
  });

  it('tolerates a storage refusal in the boot reconcile: the incomplete markers stay pending', async () => {
    const state: State = { free: HIGH };
    const first = await openFrontierJournal(home(), {
      worldHead: async () => null, now: () => 1, storage: guard(state),
    });
    await first.gate.begin(input);
    await first.close(); // a request with no terminal: an orphan

    state.free = LOW;
    const reopened = await openFrontierJournal(home(), {
      worldHead: async () => null, now: () => 1, storage: guard(state),
    });
    try {
      // The reconcile appended http/incomplete but its flush was refused; the
      // open succeeded (the boot is not refused) and the durable journal still
      // shows only the request.
      expect((await readFrontier(home())).map((event) => event.type)).toEqual(['http/request']);
      state.free = HIGH;
      await reopened.gate.begin(input);
      expect((await readFrontier(home())).map((event) => event.type))
        .toEqual(['http/request', 'http/incomplete', 'http/request']);
    } finally {
      await reopened.close();
    }
  });

  it('refuses `complete` post-effect: the request remains and the next boot marks it incomplete', async () => {
    const state: State = { free: HIGH };
    const journal = await openFrontierJournal(home(), {
      worldHead: async () => null, now: () => 1, storage: guard(state),
    });
    try {
      // Begin under a high probe: the request is durable.
      const call = await journal.gate.begin(input);
      state.free = LOW;
      // `complete` is post-effect and adds no gate check, but its writer's
      // flush is still guarded: the typed refusal propagates, the response
      // event stays pending, and the writer is not poisoned.
      await expect(journal.gate.complete(call, {
        status: 200, headers: {}, body: Buffer.from('ok'), encoding: 'utf8', complete: true,
      })).rejects.toBeInstanceOf(StorageError);
      expect((await readFrontier(home())).map((event) => event.type)).toEqual(['http/request']);
    } finally {
      // The process would die here with the terminal still pending; the close's
      // own flush can only refuse again, so its error is the crash shape.
      await journal.close().catch(() => {});
    }
    // A crash after the refusal: the next boot reconciles the terminal-less
    // request as `http/incomplete` — the documented carrier.
    state.free = HIGH;
    const reopened = await openFrontierJournal(home(), {
      worldHead: async () => null, now: () => 1, storage: guard(state),
    });
    try {
      expect((await readFrontier(home())).map((event) => event.type))
        .toEqual(['http/request', 'http/incomplete']);
    } finally {
      await reopened.close();
    }
  });

  it('degrades on a null probe: begin proceeds', async () => {
    const state: State = { free: null };
    const journal = await openFrontierJournal(home(), {
      worldHead: async () => null, now: () => 1, storage: guard(state),
    });
    try {
      await expect(journal.gate.begin(input)).resolves.toMatchObject({ group: expect.any(String) });
      expect(await readFrontier(home())).toHaveLength(1);
    } finally {
      await journal.close();
    }
  });
});
