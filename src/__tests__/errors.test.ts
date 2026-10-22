import { describe, expect, it } from 'vitest';
import { KernelError, isKernelError } from '../errors.js';
import { JournalError, CorruptionError, isCorruption, isRetryable } from '../journal/errors.js';
import { NodeError, GitCommandError } from '../node/errors.js';
import { GateClosedError } from '../node/gate.js';
import { SandboxUnavailableError } from '../node/tools/sandbox.js';
import { ArtifactMismatchError } from '../context/loader.js';
import { SurfacePolicyError } from '../context/surface.js';
import { ParameterError } from '../context/parameters.js';

describe('the kernel error root', () => {
  it('parents every typed family without changing names', () => {
    expect(new GitCommandError(['log'], 1, 'no such ref')).toBeInstanceOf(KernelError);
    // NodeError subclasses must keep their intermediate parent, not jump to the root.
    expect(new GateClosedError()).toBeInstanceOf(NodeError);
    expect(new SandboxUnavailableError('x')).toBeInstanceOf(NodeError);
    expect(new ArtifactMismatchError('json')).toBeInstanceOf(KernelError);
    expect(new ParameterError('k', 'bad')).toBeInstanceOf(KernelError);
    expect(new SurfacePolicyError('bad')).toBeInstanceOf(KernelError);
    // No existing test pins these five names (the journal/node families are
    // pinned elsewhere): without these the base's new.target.name could regress
    // silently. MalformedResponseError is private and cannot be asserted; it is
    // deliberately NOT exported just for this test.
    expect(new GateClosedError().name).toBe('GateClosedError');
    expect(new SandboxUnavailableError('x').name).toBe('SandboxUnavailableError');
    expect(new ArtifactMismatchError('json').name).toBe('ArtifactMismatchError');
    expect(new ParameterError('k', 'bad').name).toBe('ParameterError');
    expect(new SurfacePolicyError('bad').name).toBe('SurfacePolicyError');
  });
  it('keeps the journal classification predicates exact', () => {
    class Probe extends JournalError {}
    class CorruptProbe extends CorruptionError {}
    expect(isRetryable(new Probe('x'))).toBe(false);
    expect(isRetryable(new GitCommandError(['log'], 1, ''))).toBe(true);
    expect(isCorruption(new CorruptProbe('x'))).toBe(true);
    expect(isCorruption(new ArtifactMismatchError('json'))).toBe(false);
  });
  it('threads cause through the NodeError subclass constructor', () => {
    const cause = new Error('root');
    const err = new GitCommandError(['log'], 1, 'x', { cause });
    expect(err.cause).toBe(cause);
  });
  it('isKernelError rejects plain and foreign values', () => {
    expect(isKernelError(new Error())).toBe(false);
    expect(isKernelError(undefined)).toBe(false);
    expect(isKernelError(new GitCommandError(['log'], 1, ''))).toBe(true);
  });
});
