/**
 * The single root of every typed kernel error.
 *
 * Each module keeps its own family base — `JournalError` for the log,
 * `NodeError` for the node's state and git contracts — so a caller still catches
 * the family it means, but all of them root here: one `instanceof` answers "did
 * the kernel refuse this on purpose, or did something else break?", and a
 * failure that crosses a layer edge stays recognisable without importing every
 * family. `name` is read from `new.target` once here, so no subclass repeats it.
 *
 * This module is a leaf: it imports nothing from `src/`, so the journal, the
 * node and the context layers can all extend it without an import cycle or a
 * layering inversion.
 */
export abstract class KernelError extends Error {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** True for a kernel refusal; a foreign or plain `Error` is not one. */
export function isKernelError(e: unknown): e is KernelError {
  return e instanceof KernelError;
}
