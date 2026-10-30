import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { JournalWriter } from '../index.js';
import {
  StorageError, type StorageConfig, type StorageFree, type StoragePolicy,
} from '../../storage.js';
import {
  collectEvents, logPath, useTempHome, withFailingWrite,
} from './helpers.js';

/**
 * The writer's storage home: the circuit breaker at the top of `flushOnce`,
 * before the batch is captured.
 *
 * The property under test is the one the poison machinery must keep: a storage
 * refusal is NOT a write failure. It bumps no failure streak, poisons nothing,
 * rolls nothing back, and leaves the batch pending for the next flush, when the
 * probe answers high again. The write-behind timer's refusal travels the
 * existing `pendingFailure` channel without poisoning either.
 */

const home = useTempHome('writer-storage-');

const policy: StoragePolicy = {
  minFreeBytes: 100, minFreeInodes: 10, reserveBytes: 0, reserveInodes: 0,
};

const HIGH: StorageFree = { bytes: 1_000, inodes: 1_000 };
const LOW: StorageFree = { bytes: 99, inodes: 1_000 };

/** The mutable probe state; a test flips `free` between calls. */
type State = { free: StorageFree | null };
const guard = (state: State): StorageConfig => ({ policy, probe: async () => state.free });

/** The raw log bytes, an empty buffer when the writer has landed nothing. */
async function logBytes(at: string): Promise<number> {
  try {
    return (await readFile(logPath(at))).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

describe('JournalWriter storage home', () => {
  it('refuses a flush with a typed StorageError and keeps the batch pending', async () => {
    const state: State = { free: LOW };
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000, storage: guard(state) });
    try {
      w.append('test/ping', { n: 1 });
      await expect(w.flush()).rejects.toBeInstanceOf(StorageError);
      // The refusal happened before the batch was captured: nothing durable,
      // and the same batch is still pending.
      expect(await logBytes(home())).toBe(0);
      // The probe answers high: the same batch flushes, whole.
      state.free = HIGH;
      await w.flush();
      const events = await collectEvents(home());
      expect(events.map((event) => event.seq)).toEqual([0]);
    } finally {
      await w.close();
    }
  });

  it('does not touch the poison streak or the rollback on a storage refusal', async () => {
    const state: State = { free: LOW };
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000, storage: guard(state) });
    try {
      w.append('test/ping', { n: 1 });
      await expect(w.flush()).rejects.toBeInstanceOf(StorageError);
      // One REAL write failure after the refusal: a streak bumped by the
      // storage refusal would make this the second failure and poison the
      // writer, so a later successful flush proves the streak never moved.
      state.free = HIGH;
      await expect(withFailingWrite(home(), () => w.flush())).rejects.toThrow('injected EIO');
      await w.flush();
      expect((await collectEvents(home())).map((event) => event.seq)).toEqual([0]);
    } finally {
      await w.close();
    }
  });

  it('surfaces a timer flush refusal without poisoning, and a later high probe flushes', async () => {
    const state: State = { free: LOW };
    const failures: Error[] = [];
    const w = await JournalWriter.open(home(), 'n1', {
      batchWindowMs: 5,
      storage: guard(state),
      onError: (err) => { failures.push(err); },
    });
    try {
      w.append('test/ping', { n: 1 });
      await vi.waitFor(() => expect(failures).toHaveLength(1));
      expect(failures[0]).toBeInstanceOf(StorageError);
      // The recorded write-behind failure surfaces to the next caller, exactly
      // as a recorded fs failure does, while the writer stays unpoisoned.
      expect(() => w.append('test/ping', { n: 2 })).toThrow(StorageError);
      state.free = HIGH;
      await w.flush();
      const events = await collectEvents(home());
      expect(events.map((event) => event.seq)).toEqual([0]);
    } finally {
      await w.close();
    }
  });

  it('refuses a second pending event as one batch after the retry', async () => {
    const state: State = { free: LOW };
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000, storage: guard(state) });
    try {
      w.append('test/ping', { n: 1 });
      await expect(w.flush()).rejects.toBeInstanceOf(StorageError);
      w.append('test/ping', { n: 2 });
      state.free = HIGH;
      await w.flush();
      expect((await collectEvents(home())).map((event) => event.seq)).toEqual([0, 1]);
    } finally {
      await w.close();
    }
  });

  it('leaves an empty flush successful on a low probe (the boot barrier)', async () => {
    const state: State = { free: LOW };
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000, storage: guard(state) });
    try {
      // With nothing pending the flush promise holds trivially; refusing it
      // would refuse an effect that does not exist — and would fail the boot
      // replay, whose delivery barrier flushes a writer holding no new event.
      await expect(w.flush()).resolves.toBeUndefined();
      w.append('test/ping', { n: 1 });
      await expect(w.flush()).rejects.toBeInstanceOf(StorageError);
    } finally {
      state.free = HIGH;
      await w.close();
    }
  });

  it('degrades on a null probe: the batch flushes', async () => {
    const state: State = { free: null };
    const w = await JournalWriter.open(home(), 'n1', { batchWindowMs: 60_000, storage: guard(state) });
    try {
      w.append('test/ping', { n: 1 });
      await expect(w.flush()).resolves.toBeUndefined();
      expect((await collectEvents(home())).map((event) => event.seq)).toEqual([0]);
    } finally {
      await w.close();
    }
  });
});
