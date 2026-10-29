import { NodeError } from '../errors.js';

/**
 * The package layer's typed errors. Like the sibling families, this roots at
 * `NodeError` (src/node/errors.ts) and assigns `name` from `new.target`.
 *
 * The codes are a frozen closed vocabulary: a caller switches on `code`,
 * never on a message. Their tool-result spellings (design §3) are the L4
 * handler's mapping, not this module's concern.
 */
export type PackageErrorCode =
  | 'invalid-argument'
  | 'path-refused'
  | 'invalid-source'
  | 'not-found'
  | 'cap-exceeded';

/** One package-layer failure, identified by its code. */
export class PackageError extends NodeError {
  constructor(
    public readonly code: PackageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
