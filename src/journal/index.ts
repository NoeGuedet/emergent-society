/**
 * The journal's public surface — what C1.2 and later checkpoints may build on.
 *
 * Everything not re-exported here is an implementation detail of the C1.1
 * modules and may change; this file is the compatibility contract.
 */

// Writing.
export {
  JournalWriter,
  JournalClosedError,
  JournalPoisonedError,
  TornTailError,
  type JournalWriterOptions,
} from './writer.js';
export { SessionAlreadyOwnedError } from './lock.js';

// Reading and repair.
export { JournalReader, repair, type JournalReaderOptions } from './reader.js';
export type { Head } from './layout.js';

// The envelope and its event union.
export {
  FORMAT_VERSION,
  GENESIS_HASH,
  UnknownEventTypeError,
  type EventEnvelope,
  type EventDataMap,
  type EventDataFor,
  type AnyEvent,
} from './envelope.js';

// Canonicalization. `canonicalizeJson` is exported because it is the exact
// measure the writer applies before claim-checking: a caller that must stay
// under a size bound (the node's lossless-message limit) has to measure the
// same bytes the writer will, not the raw input.
export { NonCanonicalizableError, canonicalizeJson, type JsonValue } from './canon.js';

// Verification and framing damage.
export { ChainBreakError } from './verify.js';
export { CorruptFrameError } from './framing.js';

// Claim-check blobs.
export {
  BlobStore,
  CLAIM_CHECK_THRESHOLD,
  MAX_BLOB_BYTES,
  InvalidBlobHashError,
  TruncatedBlobError,
  isBlobRef,
  type BlobRef,
} from './blobs.js';

// Layout, for callers that need to address a journal directly.
export { LOG_FILE, LOCK_FILE, journalPath, headPath, nodeDir } from './layout.js';

// The typed error family.
export { JournalError, isCorruption, isRetryable } from './errors.js';
export { JournalWriteStalledError } from './fsutil.js';
