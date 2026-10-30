import { describe, expect, it } from 'vitest';
import { GitCommandError, WorldHeadError } from '../errors.js';
import {
  MAX_COMMIT_REFUSAL_DETAIL, boundedRefusalDetail, classifyCommitFailure, commitAllRefused,
  isCommitRefusal, renderCommitRefusal,
} from '../world-commit.js';
import type { WorldCommitInfo } from '../world-types.js';

/**
 * The boundary classifier: every failure the commit path can name becomes one
 * bounded `CommitRefusal`, and nothing else is swallowed. A `GitCommandError`
 * is classified by its process-layer kind, a `WorldHeadError` as a world
 * refusal, the walk's raw EACCES is classified without a git child ever
 * existing, and a later stage's typed refusal passes through.
 */
describe('classifyCommitFailure: the commit boundary names every refusal', () => {
  it('classifies each git process failure by kind', () => {
    const exit = new GitCommandError(['add'], 128, 'fatal: adding files failed', { kind: 'exit' });
    expect(classifyCommitFailure(exit)).toEqual({
      reason: 'git-exit',
      detail: 'git add exited 128: fatal: adding files failed',
    });
    expect(classifyCommitFailure(new GitCommandError(['add'], null, 'ENOENT', { kind: 'spawn' })))
      .toEqual({ reason: 'git-spawn', detail: 'git add could not be spawned: ENOENT' });
    expect(classifyCommitFailure(new GitCommandError(['add'], null, '', { kind: 'timeout' })))
      .toEqual({ reason: 'git-timeout', detail: 'git add timed out' });
    expect(classifyCommitFailure(new GitCommandError(['add'], null, '', { kind: 'abort' })))
      .toEqual({ reason: 'git-abort', detail: 'git add was aborted' });
  });

  it('classifies the output bound apart from an ordinary exit', () => {
    const capped = new GitCommandError(['log'], null, '', {
      kind: 'exit', outputCapped: true,
    });
    expect(classifyCommitFailure(capped)).toEqual({
      reason: 'output-cap', detail: `git log output exceeded ${64 * 1024 * 1024} bytes`,
    });
  });

  it('classifies a world HEAD the kernel cannot publish to', async () => {
    // Detached, outside refs/heads/, or switched mid-commit: the commit path's
    // own refusal, not an error that may kill the driver.
    const detached = new WorldHeadError('HEAD is detached, not a branch');
    expect(classifyCommitFailure(detached)).toEqual({
      reason: 'world-head', detail: 'HEAD is detached, not a branch',
    });
    expect(isCommitRefusal({ reason: 'world-head', detail: 'x' })).toBe(true);
    await expect(commitAllRefused(async () => { throw detached; }))
      .resolves.toMatchObject({ commit: null, refusal: { reason: 'world-head' } });
  });

  it('classifies the nested-repository walk\'s raw EACCES', () => {
    const err = Object.assign(new Error('EACCES: permission denied, scandir \'/w/locked\''), {
      code: 'EACCES',
    });
    expect(classifyCommitFailure(err)).toEqual({
      reason: 'walk-eacces',
      detail: 'EACCES: permission denied, scandir \'/w/locked\'',
    });
    const eperm = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    expect(classifyCommitFailure(eperm)?.reason).toBe('walk-eacces');
  });

  it('passes through a later stage\'s typed refusal', () => {
    const refusal = { reason: 'budget' as const, detail: 'staged paths over the budget' };
    expect(classifyCommitFailure(refusal)).toEqual(refusal);
    expect(isCommitRefusal(refusal)).toBe(true);
    expect(isCommitRefusal({ reason: 'not-a-reason', detail: 'x' })).toBe(false);
    expect(isCommitRefusal({ reason: 'budget' })).toBe(false);
  });

  it('returns null for a failure the boundary cannot name', () => {
    // A programming error or a malformed uid is not a world refusal: the caller
    // keeps its own fatal policy rather than having the class silently widened.
    expect(classifyCommitFailure(new Error('handler bug'))).toBeNull();
    expect(classifyCommitFailure(Object.assign(new Error('EIO'), { code: 'EIO' }))).toBeNull();
    expect(classifyCommitFailure(undefined)).toBeNull();
  });

  it('bounds and single-lines the detail and the rendered carrier', () => {
    const detail = `x\ny\t${'z'.repeat(MAX_COMMIT_REFUSAL_DETAIL * 4)}`;
    const bounded = boundedRefusalDetail(detail);
    expect(bounded.length).toBeLessThanOrEqual(MAX_COMMIT_REFUSAL_DETAIL);
    expect(bounded).not.toMatch(/[\n\t]/);
    const line = renderCommitRefusal({ reason: 'git-exit', detail });
    expect(line.startsWith('commit refused (git-exit): x ')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(MAX_COMMIT_REFUSAL_DETAIL + 40);
    expect(line).not.toContain('\n');
  });
});

describe('commitAllRefused: a discriminated attempt, never a swallowed failure', () => {
  const info: WorldCommitInfo = { hash: 'a'.repeat(64), author: 'n1' };

  it('returns the commit on success, including the no-op null', async () => {
    await expect(commitAllRefused(async () => info)).resolves.toEqual({
      commit: info, refusal: null,
    });
    await expect(commitAllRefused(async () => null)).resolves.toEqual({
      commit: null, refusal: null,
    });
  });

  it('returns the typed refusal when the attempt fails in class', async () => {
    await expect(commitAllRefused(async () => {
      throw new GitCommandError(['add'], 128, 'Permission denied', { kind: 'exit' });
    })).resolves.toMatchObject({
      commit: null, refusal: { reason: 'git-exit' },
    });
  });

  it('rethrows a failure outside the class', async () => {
    const bug = new Error('handler bug');
    await expect(commitAllRefused(async () => { throw bug; })).rejects.toBe(bug);
  });
});
