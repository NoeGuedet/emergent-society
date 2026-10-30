import { describe, expect, it } from 'vitest';
import { classifyGitFailure } from '../world-git.js';

/**
 * The process-layer discriminator the commit boundary classifies on. The
 * shapes here are the ones `execFile`/`spawn` actually produce (measured):
 * a RangeError with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` for the output bound,
 * an AbortError with `ABORT_ERR` for a caller abort, a string errno code for a
 * failed spawn, `killed`/`signal` for a timeout kill, and a numeric code for
 * git's own non-zero exit.
 */
describe('classifyGitFailure: one process-layer reading of a failed child', () => {
  it('names the output-bound kill apart from an exit', () => {
    expect(classifyGitFailure({
      name: 'RangeError', code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      message: 'stdout maxBuffer length exceeded',
    })).toEqual({ kind: 'exit', outputCapped: true });
  });

  it('names an abort by the caller signal', () => {
    expect(classifyGitFailure({ name: 'AbortError', code: 'ABORT_ERR' }))
      .toEqual({ kind: 'abort', outputCapped: false });
  });

  it('names a spawn failure by its string errno', () => {
    expect(classifyGitFailure({ name: 'Error', code: 'ENOENT' }))
      .toEqual({ kind: 'spawn', outputCapped: false });
    expect(classifyGitFailure({ name: 'Error', code: 'EACCES' }))
      .toEqual({ kind: 'spawn', outputCapped: false });
  });

  it('names a timeout kill by killed or by its signal', () => {
    expect(classifyGitFailure({ code: null, killed: true, signal: 'SIGTERM' }))
      .toEqual({ kind: 'timeout', outputCapped: false });
    expect(classifyGitFailure({ code: null, killed: false, signal: 'SIGKILL' }))
      .toEqual({ kind: 'timeout', outputCapped: false });
  });

  it('ranks a kill above a string errno so a future timeout is not a spawn', () => {
    // `execFile`'s timeout carries both `killed` and a string code. The kill is
    // the stronger fact: treating ETIMEDOUT as a spawn would mislabel a
    // deadline as a missing binary.
    expect(classifyGitFailure({ code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' }))
      .toEqual({ kind: 'timeout', outputCapped: false });
    expect(classifyGitFailure({ code: 'ETIMEDOUT', killed: false, signal: 'SIGTERM' }))
      .toEqual({ kind: 'timeout', outputCapped: false });
  });

  it('leaves a plain non-zero exit as an exit', () => {
    expect(classifyGitFailure({ code: 128, killed: false, signal: null }))
      .toEqual({ kind: 'exit', outputCapped: false });
    expect(classifyGitFailure(new Error('plain'))).toEqual({ kind: 'exit', outputCapped: false });
    expect(classifyGitFailure(undefined)).toEqual({ kind: 'exit', outputCapped: false });
  });
});
