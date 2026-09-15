import { describe, it, expect } from 'vitest';
import { JournalError, isCorruption, isRetryable } from '../errors.js';
import { CorruptFrameError } from '../framing.js';
import { ChainBreakError } from '../verify.js';
import { TornTailError, JournalClosedError, JournalPoisonedError } from '../writer.js';
import { SessionAlreadyOwnedError } from '../lock.js';
import { UnknownEventTypeError } from '../envelope.js';
import { NonCanonicalizableError } from '../canon.js';
import { InvalidBlobHashError } from '../blobs.js';
import { JournalWriteStalledError } from '../fsutil.js';

describe('the error family', () => {
  it('reports each subclass under its own name without repeating it', () => {
    expect(new CorruptFrameError(0, 'x').name).toBe('CorruptFrameError');
    expect(new ChainBreakError(0, 'x').name).toBe('ChainBreakError');
    expect(new TornTailError('/d', 1).name).toBe('TornTailError');
    expect(new JournalClosedError().name).toBe('JournalClosedError');
    expect(new JournalPoisonedError('/d', 'x').name).toBe('JournalPoisonedError');
    expect(new SessionAlreadyOwnedError('n').name).toBe('SessionAlreadyOwnedError');
    expect(new UnknownEventTypeError('t').name).toBe('UnknownEventTypeError');
    expect(new NonCanonicalizableError('x').name).toBe('NonCanonicalizableError');
    expect(new InvalidBlobHashError('h').name).toBe('InvalidBlobHashError');
    expect(new JournalWriteStalledError().name).toBe('JournalWriteStalledError');
  });

  it('makes every journal error catchable as one base', () => {
    for (const e of [new CorruptFrameError(0, 'x'), new ChainBreakError(0, 'x'), new JournalClosedError()]) {
      expect(e).toBeInstanceOf(JournalError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('classifies corruption as inspect-before-retry', () => {
    expect(isCorruption(new CorruptFrameError(0, 'x'))).toBe(true);
    expect(isCorruption(new ChainBreakError(0, 'x'))).toBe(true);
    expect(isCorruption(new TornTailError('/d', 1))).toBe(true);
    expect(isCorruption(new JournalClosedError())).toBe(false);
    expect(isCorruption(new Error('EIO'))).toBe(false);
    expect(isCorruption('not an error')).toBe(false);
  });

  it('classifies a non-journal failure as retryable', () => {
    const eio = new Error('EIO');
    expect(isRetryable(eio)).toBe(true);
    expect(isRetryable(new JournalPoisonedError('/d', 'x'))).toBe(false);
    expect(isRetryable(new SessionAlreadyOwnedError('n'))).toBe(false);
    expect(isRetryable(undefined)).toBe(true);
  });

  it('carries a cause through the base constructor', () => {
    const cause = new Error('inner');
    const e = new NonCanonicalizableError('outer', { cause });
    expect(e.cause).toBe(cause);
  });
});
