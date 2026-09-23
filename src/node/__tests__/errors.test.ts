import { describe, expect, it } from 'vitest';
import {
  GitCommandError, NodeError, NodeStateError, UnsafeWorldPathError, WorldNotARepoError,
} from '../errors.js';

describe('the node error family', () => {
  it('names itself off new.target', () => {
    expect(new NodeStateError('bad state').name).toBe('NodeStateError');
    expect(new UnsafeWorldPathError('/').name).toBe('UnsafeWorldPathError');
    expect(new WorldNotARepoError('/x').name).toBe('WorldNotARepoError');
    expect(new GitCommandError(['status'], 128, 'boom').name).toBe('GitCommandError');
  });

  it('is one catchable family', () => {
    expect(new NodeStateError()).toBeInstanceOf(NodeError);
    expect(new UnsafeWorldPathError('/')).toBeInstanceOf(NodeError);
    expect(new GitCommandError(['a'], null, '')).toBeInstanceOf(Error);
  });

  it('carries the offending value', () => {
    expect(new UnsafeWorldPathError('/home/someone').path).toBe('/home/someone');
    expect(new WorldNotARepoError('/tmp/x').path).toBe('/tmp/x');
    // The exit code is what tells a policy failure (an unborn branch) from a
    // fault, and stderr is what an operator reads.
    expect(new GitCommandError(['log'], 1, 'no such ref')).toMatchObject({
      exitCode: 1, stderr: 'no such ref',
    });
    expect(new GitCommandError(['log'], 1, 'no such ref').message)
      .toBe('git log failed (exit 1): no such ref');
  });
});
