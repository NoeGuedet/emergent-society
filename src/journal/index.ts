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
export {
  SessionAlreadyOwnedError,
  JournalLockBusyError,
  JournalLockUnavailableError,
} from './lock.js';

// Reading and repair.
export { JournalReader, repair, repairIn, type JournalReaderOptions } from './reader.js';
export type { Head, JournalLayout } from './layout.js';

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
// same bytes the writer will, not the raw input. `HASH_RE`, `copyJsonValue` and
// `sha256HexOf` are the canonical hash shape, the validated copy and the digest
// every other layer must share; `HASH_RE` is the one hash-pattern home.
export {
  HASH_RE, NonCanonicalizableError, canonicalizeJson, copyJsonValue, sha256HexOf, type JsonValue,
} from './canon.js';

// Verification, framing damage and the frozen decompressed frame bound.
export { ChainBreakError } from './verify.js';
export {
  CorruptFrameError,
  MAX_DECOMPRESSED_BATCH_BYTES,
  OversizedBatchError,
  OversizedEventError,
} from './framing.js';

// Claim-check blobs and the one verified read of their bytes.
export {
  BlobStore,
  CLAIM_CHECK_THRESHOLD,
  MAX_BLOB_BYTES,
  BlobIntegrityError,
  InvalidBlobHashError,
  ReservedBlobRefError,
  TruncatedBlobError,
  isBlobRef,
  readVerifiedBlob,
  resolveBlobRef,
  type BlobRef,
} from './blobs.js';

// Layout, for callers that need to address a journal directly.
export {
  HEAD_FILE, LOG_FILE, LOCK_FILE, NODE_UID_RE, OWNER_FILE,
  assertLayoutNames, assertNodeUid, frontierLayout, nodeDir, nodeLayout,
} from './layout.js';

// The typed error family.
export {
  CorruptionError, InvalidJournalLayoutError, InvalidNodeUidError, JournalError,
  isCorruption, isRetryable,
} from './errors.js';
// The durable-write primitives are part of the contract for callers that keep
// derived state beside a journal (the context snapshots): they must use the same
// fsync/rename discipline, not their own.
export {
  JournalWriteStalledError, atomicWriteFile, ensureDurableDirectory, readFileOrNull, syncPath,
} from './fsutil.js';
