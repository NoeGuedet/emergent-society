/** The node module's typed errors, mirroring src/journal/errors.ts. */
export abstract class NodeError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A message was sent to a uid no live node owns. */
export class UnknownNodeError extends NodeError {
  constructor(public readonly uid: string) {
    super(`unknown node: ${uid}`);
  }
}

/** A node was booted twice on the same hub. */
export class NodeAlreadyBootedError extends NodeError {
  constructor(public readonly uid: string) {
    super(`node already booted: ${uid}`);
  }
}

/** The node's state contract was violated (deliver/run at the wrong time). */
export class NodeStateError extends NodeError {}

/** A message body cannot be journaled losslessly (claim-check truncation bound). */
export class MessageTooLargeError extends NodeError {
  constructor(public readonly bytes: number, public readonly limit: number) {
    super(`message body of ${bytes} bytes meets or exceeds the ${limit}-byte lossless bound`);
  }
}

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
