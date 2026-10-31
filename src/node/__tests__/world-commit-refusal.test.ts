import { describe, expect, it } from 'vitest';
import { GitCommandError, WorldHeadError } from '../errors.js';
import {
  MAX_COMMIT_REFUSAL_DETAIL, WorldWalkError, boundedRefusalDetail, classifyCommitFailure,
  commitAllRefused, isCommitRefusal, renderCommitRefusal,
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

  it('classifies every raw walk errno as a refusal, never a kernel path', () => {
    // The walk is the only raw filesystem read in the commit path. It runs
    // before any git child, so its failure has no `GitCommandError` class: a
    // permission denial keeps the historical `walk-eacces`, a child past the
    // path budget is `walk-too-deep`, and every other errno (ENAMETOOLONG from
    // a vanishing path, EIO, EMFILE) is `walk-failure`. The detail carries the
    // relative path, never the absolute one.
    expect(classifyCommitFailure(new WorldWalkError('readdir', 'EACCES', 'locked'))).toEqual({
      reason: 'walk-eacces',
      detail: 'world walk readdir failed (EACCES): locked',
    });
    expect(classifyCommitFailure(new WorldWalkError('readdir', 'EPERM', 'x'))?.reason)
      .toBe('walk-eacces');
    for (const code of ['ENAMETOOLONG', 'EIO', 'EMFILE']) {
      const walk = new WorldWalkError('readdir', code, 'deep/rel');
      expect(classifyCommitFailure(walk)).toMatchObject({
        reason: 'walk-failure',
        detail: `world walk readdir failed (${code}): deep/rel`,
      });
      // A raw errno that escapes the walk is the same class, not a death.
      const raw = Object.assign(new Error(`${code}: scandir`), { code });
      expect(classifyCommitFailure(raw)).toMatchObject({ reason: 'walk-failure' });
    }
    const rawEacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(classifyCommitFailure(rawEacces)?.reason).toBe('walk-eacces');
    // A subtree past the walk's path budget is its own reason: the commit is
    // refused, never silently partial, so the model knows what to move.
    expect(classifyCommitFailure(new WorldWalkError('walk', 'ETOODEEP', 'deep/rel'))).toEqual({
      reason: 'walk-too-deep',
      detail: 'world walk walk failed (ETOODEEP): deep/rel',
    });
    // The walk's wall-clock budget (it runs inside the commit fence) is its own
    // typed reason, never `walk-failure` and never a kernel death.
    expect(classifyCommitFailure(new WorldWalkError('walk', 'ETIMEDOUT', 'slow/rel'))).toEqual({
      reason: 'walk-timeout',
      detail: 'world walk walk failed (ETIMEDOUT): slow/rel',
    });
  });

  it('passes through a later stage\'s typed refusal', () => {
    const refusal = { reason: 'budget' as const, detail: 'staged paths over the budget' };
    expect(classifyCommitFailure(refusal)).toEqual(refusal);
    expect(isCommitRefusal(refusal)).toBe(true);
    expect(isCommitRefusal({ reason: 'walk-failure', detail: 'deep path' })).toBe(true);
    expect(isCommitRefusal({ reason: 'walk-too-deep', detail: 'deep path' })).toBe(true);
    expect(isCommitRefusal({ reason: 'not-a-reason', detail: 'x' })).toBe(false);
    expect(isCommitRefusal({ reason: 'budget' })).toBe(false);
  });

  it('returns null for a failure the boundary cannot name', () => {
    // A programming error or a malformed uid is not a world refusal: the caller
    // keeps its own fatal policy rather than having the class silently widened.
    // A raw errno is not in this class: it is a walk refusal (see above).
    expect(classifyCommitFailure(new Error('handler bug'))).toBeNull();
    // Node's ERR_* codes are programming errors, not errnos: they must stay
    // loud even though they start with E.
    expect(classifyCommitFailure(
      Object.assign(new Error('bad argument'), { code: 'ERR_INVALID_ARG_TYPE' }),
    )).toBeNull();
    expect(classifyCommitFailure(undefined)).toBeNull();
  });

  it('names the git subcommand under the repository prefix', () => {
    // Every production git child carries the explicit pair first; naming
    // `args[0]` would render "git --git-dir exited 128" on every refusal.
    const prefixed = new GitCommandError(
      ['--git-dir', '/w.git', '--work-tree', '/w', 'add', '--all'],
      128, 'fatal: adding files failed', { kind: 'exit' },
    );
    expect(classifyCommitFailure(prefixed)).toEqual({
      reason: 'git-exit',
      detail: 'git add exited 128: fatal: adding files failed',
    });
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

  it('strips the full control/format class and caps by code points', () => {
    // The model-visible line must not carry a C1 control, a bidi override, a
    // zero-width joiner, a BOM or a line separator: any of them can forge a
    // second line or reorder the text visually.
    const hostile = `a\u0085b\u202ec\u200bd\ufeffe\u001b[31m${'x'.repeat(1000)}`;
    const bounded = boundedRefusalDetail(hostile);
    expect(bounded).not.toMatch(
      /[\p{Cc}\p{Cf}\u2028\u2029\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u,
    );
    expect(bounded).toContain('a b c d e');
    expect(bounded.length).toBeLessThanOrEqual(MAX_COMMIT_REFUSAL_DETAIL);
    expect(boundedRefusalDetail('z'.repeat(5000)))
      .toBe('z'.repeat(MAX_COMMIT_REFUSAL_DETAIL));
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
