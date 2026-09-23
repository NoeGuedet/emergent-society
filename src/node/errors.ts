/** The node module's typed errors, mirroring src/journal/errors.ts. */
export abstract class NodeError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The node's state contract was violated (a second `run()`, a commit while stopping). */
export class NodeStateError extends NodeError {}

/** The configured world directory is `$HOME` or a broad root (kernel.md §7). */
export class UnsafeWorldPathError extends NodeError {
  constructor(public readonly path: string) {
    super(`refusing ${path} as the world repo: the world is a dedicated directory`);
  }
}

/** The configured world directory is not the root of a git repository. */
export class WorldNotARepoError extends NodeError {
  constructor(public readonly path: string) {
    super(`${path} is not the root of a git repository`);
  }
}

/** A git invocation against the world failed. */
export class GitCommandError extends NodeError {
  constructor(
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    const exit = exitCode !== null ? ` (exit ${exitCode})` : '';
    super(`git ${args.join(' ')} failed${exit}: ${stderr.trim()}`);
  }
}
