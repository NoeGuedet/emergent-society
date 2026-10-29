/**
 * The Run bootstrap — the child side of the Run facade (kernel.md, the sandbox
 * and local-log sections).
 *
 * This is a script, not a library: no exports and no project imports — only a
 * Node built-in dynamic load (`node:fs`), resolvable from any location. It is
 * compiled to `dist/node/packages/run-bootstrap.js`, copied into a Run leaf and
 * executed by the confined interpreter. Every path it touches comes from argv —
 * it never depends on a working directory. A copied single file cannot import
 * `packages/protocol.js`, so the whole facade codec is inlined here and kept in
 * lockstep with `protocol.ts` by the bootstrap tests. SHA-256 is inlined too:
 * the child must verify its own `package.js` before evaluating it, and no import
 * may sit between the read and the verify (the bootstrap tests prove the inline
 * digest against `node:crypto`, which is never loaded at runtime).
 *
 * The leaf copy must keep this file's name: the entry point runs only when
 * argv[1]'s basename is the location-independent `run-bootstrap.mjs` (or
 * `.mts` under the tests' native type stripping), so evaluating the file as a
 * library body never spawns a Run. A handler that returns a value too large
 * for the frame cap answers the fixed `result-too-large` error (the
 * `unserializable-result` sibling, plan-coined).
 *
 * argv contract (the leaf layout is fixed: run-bootstrap.js, package.js,
 * output.log):
 * - argv[2] — the Package id (diagnostics only; never trusted, never parsed)
 * - argv[3] — the expected lowercase hex sha256 of package.js
 * - argv[4] — the absolute path of package.js in the Run leaf
 * - argv[5] — the absolute path of output.log in the Run leaf
 *
 * Startup order, every step before a single guest byte is evaluated:
 * read `package.js` → sha256 it → compare with argv[3] → install the print
 * capture → snapshot the built-ins (already done at module scope) → evaluate the
 * source → validate the registration → send `run/ready`. A digest mismatch
 * writes nothing to stdout and exits 1. A bad declaration (a malformed shape,
 * an evaluation failure, an unencodable declaration) writes one diagnostic line
 * on stderr and exits 3. Every other fatal path (a protocol desync, an
 * over-long line, an unreadable package.js) is exit 1 with a diagnostic. These
 * codes are the child half of a contract mirrored in `supervisor.ts`.
 *
 * Invariants this file owns:
 * - **Verify-then-use** — a digest mismatch evaluates nothing.
 * - **Built-in snapshot** — `JSON.parse`, `JSON.stringify` and `Object.keys`
 *   are captured at module scope before guest evaluation, and the frame codec
 *   uses the snapshots; guest-side prototype pollution cannot bend later
 *   parsing or encoding. (The channel boundary is still the kernel's frame
 *   validation, never this file's good behavior.)
 * - **Stdout discipline** — fd 1 is the protocol channel; `console` and
 *   `process.stdout`/`process.stderr` writes are appended to a bounded
 *   `output.log`, so an ordinary print is never an accidental protocol desync.
 *   A guest can still forge frames with a raw fd write — the kernel's frame
 *   validation is the boundary (design §5.3 states this honestly).
 * - **Bounded lines** — incoming lines are byte-accounted at the 1 MiB cap; an
 *   over-long line is fatal, never buffered unboundedly.
 * - **Single in flight** — handlers run one at a time (they are chained), and
 *   one `svc-<n>` request is outstanding at a time (a mismatched `svc/result`
 *   is fatal).
 *
 * What this file never does: import a project module, read the world or the
 * package store, journal anything, spawn anything, or time itself (the kernel
 * owns every deadline).
 */

/** One protocol line's byte cap — duplicated from `packages/constants.ts`. */
const MAX_FRAME_BYTES = 1_048_576;

/** The bootstrap's bounded capture of non-protocol writes (`output.log`). */
const MAX_OUTPUT_LOG_BYTES = 65_536;

/** The declared tool-name bound (the protocol's `MAX_PACKAGE_NAME_CHARS`). */
const MAX_NAME_CHARS = 64;

/** The declared description bound (`MAX_PACKAGE_PURPOSE_CHARS`). */
const MAX_DESCRIPTION_CHARS = 512;

/** The protocol's `svc/web_search` bound. */
const WEB_SEARCH_MAX_RESULTS = 20;

/** The digest form argv[3] must carry. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * The child half of the supervisor's exit-code contract: 1 is a digest
 * mismatch or a fatal protocol/I/O failure, 3 is a bad declaration the kernel
 * reports as `run/invalid-registration`. Mirrored in `supervisor.ts`.
 */
const EXIT_FATAL = 1;
const EXIT_BAD_DECLARATION = 3;

/**
 * The built-ins later parsing and encoding depend on, snapshotted at module
 * scope — before any guest evaluation — so guest-side prototype pollution cannot
 * bend them (design §5.2.7).
 */
const SNAPSHOT_JSON_PARSE = JSON.parse;
const SNAPSHOT_JSON_STRINGIFY = JSON.stringify;
const SNAPSHOT_OBJECT_KEYS = Object.keys;
const SNAPSHOT_ARRAY_IS_ARRAY = Array.isArray;
const SNAPSHOT_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const SNAPSHOT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const SNAPSHOT_GET_OWN_PROPERTY_SYMBOLS = Object.getOwnPropertySymbols;

/** Type-only signature of the fs built-in; erased by type stripping. */
type FsModule = typeof import('node:fs');

/** A guest tool handler: the frozen authoring contract (design §5.3). */
type GuestHandler = (args: unknown, svc: ServiceSurface) => unknown;

/** The only kernel channel a handler receives — exactly these three methods. */
type ServiceSurface = {
  readonly execute: (cmd: unknown) => Promise<unknown>;
  readonly web_search: (query: unknown, maxResults?: unknown) => Promise<unknown>;
  readonly web_fetch: (url: unknown) => Promise<unknown>;
};

/** A tool declaration as it travels on the wire (the serializable subset). */
type DeclaredWireTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
};

/** The validated registration: wire tools plus the in-realm handler table. */
type ValidatedRegistration = {
  readonly tools: readonly DeclaredWireTool[];
  readonly handlers: ReadonlyMap<string, GuestHandler>;
};

/** A service call before its callId is minted. */
type ServiceRequest =
  | { readonly type: 'svc/execute'; readonly cmd: string }
  | { readonly type: 'svc/web_search'; readonly query: string; readonly maxResults?: number }
  | { readonly type: 'svc/web_fetch'; readonly url: string };

/** The frames this child sends (the kernel side mirrors these in protocol.ts). */
type SentFrame =
  | { readonly type: 'run/ready'; readonly tools: readonly DeclaredWireTool[] }
  | { readonly type: 'tool/result'; readonly callId: string; readonly ok: true; readonly result: unknown }
  | { readonly type: 'tool/result'; readonly callId: string; readonly ok: false; readonly error: string }
  | { readonly type: 'svc/execute'; readonly callId: string; readonly cmd: string }
  | { readonly type: 'svc/web_search'; readonly callId: string; readonly query: string; readonly maxResults?: number }
  | { readonly type: 'svc/web_fetch'; readonly callId: string; readonly url: string };

/** The `tool/invoke` frame the child receives. */
type ToolInvokeFrame = {
  readonly type: 'tool/invoke';
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
};

/** The `svc/result` frame the child receives. */
type SvcResultFrame =
  | { readonly type: 'svc/result'; readonly callId: string; readonly ok: true; readonly result: unknown }
  | { readonly type: 'svc/result'; readonly callId: string; readonly ok: false; readonly error: string };

/** The frames the child accepts from the kernel. */
type IncomingFrame = ToolInvokeFrame | SvcResultFrame | { readonly type: 'run/dispose' };

/** A malformed frame, a bad declaration or a protocol desync: fatal. */
class BootstrapFault extends Error {}

/** A guest value with no canonical JSON form (refused as a result). */
class UnserializableValue extends Error {}

/** A frame whose canonical JSON exceeds the line cap. */
class FrameTooLarge extends Error {}

/** The single outstanding service call, settled by one `svc/result`. */
type PendingService = {
  readonly callId: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
};

/** The module-scoped state the startup path installs. */
let fsModule: FsModule | null = null;
let captureFd: number | null = null;
let capturedBytes = 0;
let runPackageId = '';
let handlers: ReadonlyMap<string, GuestHandler> = new Map<string, GuestHandler>();
let toolChain: Promise<void> = Promise.resolve();
let pendingService: PendingService | null = null;
let serviceCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `Array.isArray` as a type guard over `readonly unknown[]`: the built-in
 * predicate narrows to `any[]`, and the bootstrap never introduces `any`.
 */
function isArrayValue(value: unknown): value is readonly unknown[] {
  return SNAPSHOT_ARRAY_IS_ARRAY(value);
}

function isGuestHandler(value: unknown): value is GuestHandler {
  return typeof value === 'function';
}

/** True when `text` contains a UTF-16 lone surrogate (no canonical JSON form). */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Replaces lone surrogates with U+FFFD so guest text always encodes. */
function toWellFormedText(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.charAt(index);
        out += text.charAt(index + 1);
        index += 1;
      } else {
        out += '\ufffd';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\ufffd';
    } else {
      out += text.charAt(index);
    }
  }
  return out;
}

function requireStringField(
  record: Record<string, unknown>,
  key: string,
  where: string,
  maxChars?: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BootstrapFault(`${where}: ${key} must be a nonempty string`);
  }
  if (maxChars !== undefined && value.length > maxChars) {
    throw new BootstrapFault(`${where}: ${key} exceeds ${maxChars} characters`);
  }
  return value;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of SNAPSHOT_OBJECT_KEYS(record)) {
    if (!allowed.includes(key)) {
      throw new BootstrapFault(`${where}: unexpected key ${SNAPSHOT_JSON_STRINGIFY(key) ?? key}`);
    }
  }
}

/**
 * SHA-256 over raw bytes, inline: no import may sit between the read of
 * `package.js` and the verify, so the one hash the bootstrap needs is here. The
 * bootstrap tests prove it against `node:crypto` on empty, short, long and
 * multi-block inputs.
 */
const SHA256_ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, count: number): number {
  return ((value >>> count) | (value << (32 - count))) >>> 0;
}

function sha256HexOfBytes(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // The 64-bit big-endian bit length, written byte by byte (no DataView).
  const highBits = Math.floor(bitLength / 0x1_0000_0000);
  const lowBits = bitLength >>> 0;
  padded[paddedLength - 8] = (highBits >>> 24) & 0xff;
  padded[paddedLength - 7] = (highBits >>> 16) & 0xff;
  padded[paddedLength - 6] = (highBits >>> 8) & 0xff;
  padded[paddedLength - 5] = highBits & 0xff;
  padded[paddedLength - 4] = (lowBits >>> 24) & 0xff;
  padded[paddedLength - 3] = (lowBits >>> 16) & 0xff;
  padded[paddedLength - 2] = (lowBits >>> 8) & 0xff;
  padded[paddedLength - 1] = lowBits & 0xff;
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      schedule[index] = (
        ((padded[wordOffset] ?? 0) << 24)
        | ((padded[wordOffset + 1] ?? 0) << 16)
        | ((padded[wordOffset + 2] ?? 0) << 8)
        | (padded[wordOffset + 3] ?? 0)
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = schedule[index - 15] ?? 0;
      const w2 = schedule[index - 2] ?? 0;
      const s0 = (rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10)) >>> 0;
      schedule[index] = ((schedule[index - 16] ?? 0) + s0 + (schedule[index - 7] ?? 0) + s1) >>> 0;
    }
    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) >>> 0;
      const s0 = (rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0;
    state[1] = ((state[1] ?? 0) + b) >>> 0;
    state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0;
    state[4] = ((state[4] ?? 0) + e) >>> 0;
    state[5] = ((state[5] ?? 0) + f) >>> 0;
    state[6] = ((state[6] ?? 0) + g) >>> 0;
    state[7] = ((state[7] ?? 0) + h) >>> 0;
  }
  let hex = '';
  for (let index = 0; index < 8; index += 1) {
    hex += (state[index] ?? 0).toString(16).padStart(8, '0');
  }
  return hex;
}

/**
 * RFC 8785 canonical JSON for the value kinds a frame may carry: object keys
 * sorted by UTF-16 code unit, no whitespace, standard JSON string escaping. The
 * kernel's `canonicalizeJson` is the lockstep reference (the bootstrap tests
 * compare the two byte for byte); anything with no canonical JSON form is
 * refused with `UnserializableValue` rather than silently lossy.
 */
function canonicalStringify(value: unknown): string {
  return stringifyValue(value, new Set<object>());
}

function stringifyValue(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new UnserializableValue('non-finite number');
      const text = SNAPSHOT_JSON_STRINGIFY(value);
      if (text === undefined) throw new UnserializableValue('number has no JSON form');
      return text;
    }
    case 'string': {
      if (hasLoneSurrogate(value)) throw new UnserializableValue('lone surrogate in a string');
      const text = SNAPSHOT_JSON_STRINGIFY(value);
      if (text === undefined) throw new UnserializableValue('string has no JSON form');
      return text;
    }
    case 'object':
      return stringifyContainer(value, seen);
    case 'undefined':
      throw new UnserializableValue('undefined has no JSON form');
    case 'function':
      throw new UnserializableValue('a function has no JSON form');
    case 'symbol':
      throw new UnserializableValue('a symbol has no JSON form');
    case 'bigint':
      throw new UnserializableValue('a bigint has no JSON form');
    default:
      throw new UnserializableValue('unsupported value');
  }
}

function stringifyContainer(value: object, seen: Set<object>): string {
  if (seen.has(value)) throw new UnserializableValue('circular reference');
  seen.add(value);
  try {
    return isArrayValue(value) ? stringifyArray(value, seen) : stringifyObject(value, seen);
  } finally {
    seen.delete(value);
  }
}

function stringifyArray(items: readonly unknown[], seen: Set<object>): string {
  const parts: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const desc = SNAPSHOT_GET_OWN_PROPERTY_DESCRIPTOR(items, String(index));
    if (desc === undefined || desc.get !== undefined || desc.set !== undefined) {
      // A sparse hole or an accessor element: refused, never silently lost —
      // the kernel's canonicalizer refuses both.
      throw new UnserializableValue(`array element ${index} is a hole or accessor`);
    }
    const item = desc.value;
    if (item === undefined) throw new UnserializableValue(`undefined array member at ${index}`);
    parts.push(stringifyValue(item, seen));
  }
  // Any other own enumerable key on an array would be dropped by a JSON round
  // trip, so it is refused rather than silently lost.
  for (const key of SNAPSHOT_OBJECT_KEYS(items)) {
    const index = Number(key);
    if (SNAPSHOT_NUMBER_IS_SAFE_INTEGER(index) && String(index) === key && index >= 0
      && index < items.length) continue;
    throw new UnserializableValue(`array has the extra own property ${key}`);
  }
  return `[${parts.join(',')}]`;
}

function stringifyObject(value: object, seen: Set<object>): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnserializableValue('a non-plain object has no canonical JSON form');
  }
  const record: Record<string, unknown> = value as Record<string, unknown>;
  for (const symbol of SNAPSHOT_GET_OWN_PROPERTY_SYMBOLS(record)) {
    if (SNAPSHOT_GET_OWN_PROPERTY_DESCRIPTOR(record, symbol)?.enumerable) {
      // An enumerable symbol key would be dropped by a JSON round trip: the
      // kernel's canonicalizer refuses it, and so does the wire.
      throw new UnserializableValue('an enumerable symbol key has no JSON form');
    }
  }
  const parts: string[] = [];
  for (const key of SNAPSHOT_OBJECT_KEYS(record).sort()) {
    const descriptor = SNAPSHOT_GET_OWN_PROPERTY_DESCRIPTOR(record, key);
    if (descriptor === undefined || descriptor.get !== undefined
      || descriptor.set !== undefined) {
      throw new UnserializableValue(`accessor property ${key}`);
    }
    if (hasLoneSurrogate(key)) throw new UnserializableValue('lone surrogate in a member name');
    const member = descriptor.value;
    if (member === undefined) throw new UnserializableValue(`undefined member ${key}`);
    const encodedKey = SNAPSHOT_JSON_STRINGIFY(key);
    if (encodedKey === undefined) throw new UnserializableValue('a member name has no JSON form');
    parts.push(`${encodedKey}:${stringifyValue(member, seen)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Refuses a frame shape the kernel's validator would reject, before sending. */
function validateSentFrame(frame: SentFrame): void {
  switch (frame.type) {
    case 'run/ready': {
      for (let index = 0; index < frame.tools.length; index += 1) {
        const tool = frame.tools[index];
        if (tool === undefined) throw new BootstrapFault(`run/ready: tools[${index}] is missing`);
        const where = `run/ready tools[${index}]`;
        if (tool.name.length === 0 || tool.name.length > MAX_NAME_CHARS) {
          throw new BootstrapFault(`${where}: name must be 1-${MAX_NAME_CHARS} characters`);
        }
        if (tool.description.length === 0 || tool.description.length > MAX_DESCRIPTION_CHARS) {
          throw new BootstrapFault(`${where}: description must be 1-${MAX_DESCRIPTION_CHARS} characters`);
        }
        if (!isRecord(tool.parameters)) {
          throw new BootstrapFault(`${where}: parameters must be a JSON object`);
        }
      }
      return;
    }
    case 'tool/result': {
      if (frame.callId.length === 0) throw new BootstrapFault('tool/result: callId must be nonempty');
      if (!frame.ok && frame.error.length === 0) throw new BootstrapFault('tool/result: error must be nonempty');
      return;
    }
    case 'svc/execute': {
      if (frame.callId.length === 0 || frame.cmd.length === 0) {
        throw new BootstrapFault('svc/execute: callId and cmd must be nonempty');
      }
      return;
    }
    case 'svc/web_search': {
      if (frame.callId.length === 0 || frame.query.length === 0) {
        throw new BootstrapFault('svc/web_search: callId and query must be nonempty');
      }
      if (frame.maxResults !== undefined
        && (!Number.isSafeInteger(frame.maxResults) || frame.maxResults < 1
          || frame.maxResults > WEB_SEARCH_MAX_RESULTS)) {
        throw new BootstrapFault(`svc/web_search: maxResults must be an integer in 1..${WEB_SEARCH_MAX_RESULTS}`);
      }
      return;
    }
    case 'svc/web_fetch': {
      if (frame.callId.length === 0 || frame.url.length === 0) {
        throw new BootstrapFault('svc/web_fetch: callId and url must be nonempty');
      }
      return;
    }
  }
}

/** Encodes one frame as one canonical JSON body, refusing oversize content. */
function encodeFrame(frame: SentFrame): string {
  validateSentFrame(frame);
  const body = canonicalStringify(frame);
  if (Buffer.byteLength(body, 'utf8') > MAX_FRAME_BYTES) {
    throw new FrameTooLarge(`the frame exceeds the ${MAX_FRAME_BYTES}-byte line cap`);
  }
  return body;
}

/**
 * Writes one complete protocol line to fd 1 (the frame channel). The write is
 * synchronous on purpose: a frame is fully emitted before the handler returns,
 * and `run/dispose` can exit without a flushed buffer. A full pipe (`EAGAIN`)
 * retries — the kernel drains continuously and its deadline bounds the wait.
 */
function writeProtocolLine(line: string): void {
  const fs = fsModule;
  if (fs === null) throw new BootstrapFault('the fs built-in is not loaded');
  const bytes = Buffer.from(line, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    let written = 0;
    try {
      written = fs.writeSync(1, bytes, offset, bytes.length - offset);
    } catch (err) {
      if (errorCode(err) === 'EAGAIN') continue;
      throw err;
    }
    if (written <= 0) continue;
    offset += written;
  }
}

function errorCode(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as Record<string, unknown>)['code'];
}

/** Appends non-protocol output to the bounded capture, dropping the excess. */
function appendCapture(text: string): void {
  const fs = fsModule;
  if (fs === null || captureFd === null) return;
  const remaining = MAX_OUTPUT_LOG_BYTES - capturedBytes;
  if (remaining <= 0) return;
  let bytes = Buffer.from(text, 'utf8');
  if (bytes.length > remaining) bytes = bytes.subarray(0, remaining);
  capturedBytes += bytes.length;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(captureFd, bytes, offset, bytes.length - offset);
      if (written <= 0) return;
      offset += written;
    }
  } catch {
    // The capture is a UX channel; a failed write never kills the Run.
  }
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    if (typeof value === 'object' || typeof value === 'function') {
      const text = SNAPSHOT_JSON_STRINGIFY(value);
      return text === undefined ? '<unprintable>' : text;
    }
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

function formatConsoleArgs(data: readonly unknown[]): string {
  const parts: string[] = [];
  for (const part of data) parts.push(formatConsoleArg(part));
  return parts.join(' ');
}

/**
 * Redirects every print channel a guest can reach without a raw fd write:
 * `console.*` and the stdout/stderr stream methods append to `output.log`.
 * fd 1 stays the protocol channel.
 */
function installCapture(): void {
  const captureWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    appendCapture(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (done !== undefined) done();
    return true;
  };
  process.stdout.write = captureWrite as typeof process.stdout.write;
  process.stderr.write = captureWrite as typeof process.stderr.write;
  const writeConsoleLine = (...data: unknown[]): void => {
    appendCapture(`${formatConsoleArgs(data)}\n`);
  };
  console.log = writeConsoleLine;
  console.info = writeConsoleLine;
  console.warn = writeConsoleLine;
  console.error = writeConsoleLine;
  console.debug = writeConsoleLine;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message.length > 0 ? err.message : err.name;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/** A thrown handler value becomes error text: an Error's message, else String. */
function describeThrown(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === 'string') return err;
  try {
    return String(err);
  } catch {
    return 'handler-failed';
  }
}

/**
 * The real stderr writer: fd 2 directly, so a diagnostic never vanishes into
 * `output.log` after the print capture is installed.
 */
function rawStderrWrite(text: string): void {
  const fs = fsModule;
  if (fs === null) return;
  try {
    fs.writeSync(2, Buffer.from(text, 'utf8'));
  } catch {
    // Nothing left to report to.
  }
}

/** Writes one diagnostic to real stderr and exits (startup and fatal paths). */
function fail(message: string, exitCode: number = EXIT_FATAL): never {
  rawStderrWrite(`run-bootstrap: ${message}\n`);
  process.exit(exitCode);
}

/** Next completed stdin line, or null once stdin closed. */
const lineQueue: string[] = [];
let lineWaiter: ((line: string | null) => void) | null = null;
let linesClosed = false;

function pushLine(line: string): void {
  const waiter = lineWaiter;
  if (waiter !== null) {
    lineWaiter = null;
    waiter(line);
    return;
  }
  lineQueue.push(line);
}

function nextLine(): Promise<string | null> {
  const queued = lineQueue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (linesClosed) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    lineWaiter = resolve;
  });
}

function closeLines(): void {
  linesClosed = true;
  const waiter = lineWaiter;
  if (waiter !== null) {
    lineWaiter = null;
    waiter(null);
  }
}

let pendingLineBytes: Buffer = Buffer.alloc(0);

/** Per-line byte accounting: the growing line is killed at the cap. */
function onStdinChunk(chunk: Buffer): void {
  let start = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    if (pendingLineBytes.length + (index - start) > MAX_FRAME_BYTES) {
      fail(`package ${runPackageId}: an incoming line exceeded ${MAX_FRAME_BYTES} bytes`);
    }
    if (chunk[index] !== 0x0a) continue;
    const line = Buffer.concat([pendingLineBytes, chunk.subarray(start, index)]).toString('utf8');
    pendingLineBytes = Buffer.alloc(0);
    start = index + 1;
    pushLine(line);
  }
  pendingLineBytes = Buffer.concat([pendingLineBytes, chunk.subarray(start)]);
  if (pendingLineBytes.length > MAX_FRAME_BYTES) {
    fail(`package ${runPackageId}: an incoming line exceeded ${MAX_FRAME_BYTES} bytes`);
  }
}

/** Parses one incoming line, mirroring the kernel codec's shape validators. */
function parseIncoming(line: string): IncomingFrame {
  let parsed: unknown = undefined;
  try {
    parsed = SNAPSHOT_JSON_PARSE(line);
  } catch {
    throw new BootstrapFault('an incoming line is not JSON');
  }
  if (!isRecord(parsed)) throw new BootstrapFault('an incoming frame must be a JSON object');
  const type = parsed['type'];
  if (typeof type !== 'string') throw new BootstrapFault('an incoming frame type must be a string');
  if (type === 'tool/invoke') {
    hasOnlyKeys(parsed, ['type', 'callId', 'name', 'args'], 'tool/invoke');
    const callId = requireStringField(parsed, 'callId', 'tool/invoke');
    const name = requireStringField(parsed, 'name', 'tool/invoke', MAX_NAME_CHARS);
    if (!('args' in parsed)) throw new BootstrapFault('tool/invoke: args must be present');
    return { type: 'tool/invoke', callId, name, args: parsed['args'] };
  }
  if (type === 'svc/result') {
    hasOnlyKeys(parsed, ['type', 'callId', 'ok', 'result', 'error'], 'svc/result');
    const callId = requireStringField(parsed, 'callId', 'svc/result');
    const ok = parsed['ok'];
    if (ok === true) {
      if (!('result' in parsed)) throw new BootstrapFault('svc/result: ok requires a result');
      if ('error' in parsed) throw new BootstrapFault('svc/result: ok must not carry an error');
      return { type: 'svc/result', callId, ok: true, result: parsed['result'] };
    }
    if (ok === false) {
      if (!('error' in parsed)) throw new BootstrapFault('svc/result: a failed result requires an error');
      if ('result' in parsed) throw new BootstrapFault('svc/result: a failed result must not carry a result');
      return { type: 'svc/result', callId, ok: false, error: requireStringField(parsed, 'error', 'svc/result') };
    }
    throw new BootstrapFault('svc/result: ok must be a boolean');
  }
  if (type === 'run/dispose') {
    hasOnlyKeys(parsed, ['type'], 'run/dispose');
    return { type: 'run/dispose' };
  }
  throw new BootstrapFault(`unknown incoming frame type ${SNAPSHOT_JSON_STRINGIFY(type) ?? type}`);
}

/** The single in-flight service request; a mismatched result is fatal. */
function settleService(frame: SvcResultFrame): void {
  const pending = pendingService;
  if (pending === null) throw new BootstrapFault('svc/result arrived with no request in flight');
  if (pending.callId !== frame.callId) {
    throw new BootstrapFault(
      `svc/result callId ${frame.callId} does not match the in-flight ${pending.callId}`,
    );
  }
  pendingService = null;
  if (frame.ok) pending.resolve(frame.result);
  else pending.reject(new Error(frame.error));
}

/** Sends one service request and resolves when its `svc/result` arrives. */
function requestService(request: ServiceRequest): Promise<unknown> {
  if (pendingService !== null) {
    throw new BootstrapFault('two service requests in flight (the facade allows one)');
  }
  serviceCounter += 1;
  const callId = `svc-${serviceCounter}`;
  const frame: SentFrame = request.type === 'svc/execute'
    ? { type: 'svc/execute', callId, cmd: request.cmd }
    : request.type === 'svc/web_search'
      ? (request.maxResults === undefined
        ? { type: 'svc/web_search', callId, query: request.query }
        : { type: 'svc/web_search', callId, query: request.query, maxResults: request.maxResults })
      : { type: 'svc/web_fetch', callId, url: request.url };
  const line = encodeFrame(frame);
  return new Promise<unknown>((resolve, reject) => {
    pendingService = { callId, resolve, reject };
    try {
      writeProtocolLine(`${line}\n`);
    } catch (err) {
      pendingService = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** The one kernel channel a handler receives: `execute` plus the web pair. */
function createServiceSurface(): ServiceSurface {
  return {
    execute: async (cmd: unknown): Promise<unknown> => {
      if (typeof cmd !== 'string' || cmd.length === 0) {
        throw new TypeError('svc.execute: cmd must be a nonempty string');
      }
      return requestService({ type: 'svc/execute', cmd });
    },
    web_search: async (query: unknown, maxResults?: unknown): Promise<unknown> => {
      if (typeof query !== 'string' || query.length === 0) {
        throw new TypeError('svc.web_search: query must be a nonempty string');
      }
      if (maxResults === undefined) return requestService({ type: 'svc/web_search', query });
      if (typeof maxResults !== 'number' || !Number.isSafeInteger(maxResults)
        || maxResults < 1 || maxResults > WEB_SEARCH_MAX_RESULTS) {
        throw new TypeError(`svc.web_search: maxResults must be an integer in 1..${WEB_SEARCH_MAX_RESULTS}`);
      }
      return requestService({ type: 'svc/web_search', query, maxResults });
    },
    web_fetch: async (url: unknown): Promise<unknown> => {
      if (typeof url !== 'string' || url.length === 0) {
        throw new TypeError('svc.web_fetch: url must be a nonempty string');
      }
      return requestService({ type: 'svc/web_fetch', url });
    },
  };
}

/** Bounds handler error text so the error frame itself fits the line cap. */
function sendToolError(callId: string, text: string): void {
  let bounded = toWellFormedText(text);
  if (bounded.length === 0) bounded = 'handler-failed';
  for (;;) {
    try {
      const frame: SentFrame = { type: 'tool/result', callId, ok: false, error: bounded };
      writeProtocolLine(`${encodeFrame(frame)}\n`);
      return;
    } catch (err) {
      if (!(err instanceof FrameTooLarge) || bounded.length <= 1) throw err;
      const points = Array.from(bounded);
      bounded = points.slice(0, Math.max(1, Math.floor(points.length / 2))).join('');
    }
  }
}

/** Runs one `tool/invoke` serially: handler, canonical result, bounded error. */
async function executeInvoke(invoke: ToolInvokeFrame): Promise<void> {
  const handler = handlers.get(invoke.name);
  if (handler === undefined) {
    sendToolError(invoke.callId, 'tool-not-found');
    return;
  }
  let result: unknown;
  try {
    result = await handler(invoke.args, createServiceSurface());
  } catch (err) {
    sendToolError(invoke.callId, describeThrown(err));
    return;
  }
  try {
    const frame: SentFrame = { type: 'tool/result', callId: invoke.callId, ok: true, result };
    writeProtocolLine(`${encodeFrame(frame)}\n`);
  } catch (err) {
    if (err instanceof UnserializableValue) {
      sendToolError(invoke.callId, 'unserializable-result');
      return;
    }
    if (err instanceof FrameTooLarge) {
      sendToolError(invoke.callId, 'result-too-large');
      return;
    }
    throw err;
  }
}

/** The dispatch loop: one reader, a serial handler chain, no self-timing. */
async function dispatchLoop(): Promise<void> {
  for (;;) {
    const line = await nextLine();
    if (line === null) {
      process.exit(0);
    }
    const frame = parseIncoming(line);
    if (frame.type === 'tool/invoke') {
      const invoke: ToolInvokeFrame = frame;
      toolChain = toolChain
        .then(() => executeInvoke(invoke))
        .catch((err: unknown) => {
          fail(`package ${runPackageId}: ${describe(err)}`);
        });
      continue;
    }
    if (frame.type === 'svc/result') {
      settleService(frame);
      continue;
    }
    // run/dispose: the kernel already unregistered and is done with the child.
    process.exit(0);
  }
}

function startProtocolLoop(): void {
  process.stdin.on('data', (chunk: Buffer) => {
    onStdinChunk(chunk);
  });
  process.stdin.on('end', () => {
    closeLines();
  });
  process.stdin.on('error', (err: unknown) => {
    fail(`package ${runPackageId}: stdin error: ${describe(err)}`);
  });
  void dispatchLoop().catch((err: unknown) => {
    fail(`package ${runPackageId}: ${describe(err)}`);
  });
}

/**
 * Validates the registered object shape (not the kernel's name/schema policy):
 * exactly `{tools: [...]}`, each tool exactly `{name, description, parameters,
 * handler}`, a handler function, and JSON parameters.
 */
function validateRegistration(value: unknown): ValidatedRegistration {
  if (!isRecord(value)) throw new BootstrapFault('the registration must be a JSON object');
  hasOnlyKeys(value, ['tools'], 'registration');
  const toolsValue = value['tools'];
  if (!isArrayValue(toolsValue)) throw new BootstrapFault('registration.tools must be an array');
  const tools: DeclaredWireTool[] = [];
  const handlerTable = new Map<string, GuestHandler>();
  for (let index = 0; index < toolsValue.length; index += 1) {
    const tool = toolsValue[index];
    const where = `tools[${index}]`;
    if (!isRecord(tool)) throw new BootstrapFault(`${where} must be a JSON object`);
    hasOnlyKeys(tool, ['name', 'description', 'parameters', 'handler'], where);
    const name = requireStringField(tool, 'name', where, MAX_NAME_CHARS);
    const description = requireStringField(tool, 'description', where, MAX_DESCRIPTION_CHARS);
    const parametersValue = tool['parameters'];
    if (!isRecord(parametersValue)) throw new BootstrapFault(`${where}.parameters must be a JSON object`);
    const handlerValue = tool['handler'];
    if (!isGuestHandler(handlerValue)) throw new BootstrapFault(`${where}.handler must be a function`);
    try {
      canonicalStringify(parametersValue);
    } catch (err) {
      throw new BootstrapFault(`${where}.parameters must be JSON data (${describe(err)})`);
    }
    tools.push({ name, description, parameters: parametersValue });
    handlerTable.set(name, handlerValue);
  }
  return { tools, handlers: handlerTable };
}

function readPackageBytes(fs: FsModule, packagePath: string): Buffer {
  try {
    return fs.readFileSync(packagePath);
  } catch (err) {
    fail(`package ${runPackageId}: cannot read package.js: ${describe(err)}`);
  }
}

function validateRegistrationOrFail(value: unknown, packageId: string): ValidatedRegistration {
  try {
    return validateRegistration(value);
  } catch (err) {
    fail(`package ${packageId}: invalid registration: ${describe(err)}`, EXIT_BAD_DECLARATION);
  }
}

function encodeReady(tools: readonly DeclaredWireTool[]): string {
  try {
    return encodeFrame({ type: 'run/ready', tools });
  } catch (err) {
    fail(`package ${runPackageId}: invalid registration: ${describe(err)}`, EXIT_BAD_DECLARATION);
  }
}

/**
 * The entry point: the shell over the whole life of the child. Every exit path
 * is explicit — a digest mismatch is silent (exit 1), a diagnostic path writes
 * one stderr line, and `run/dispose` exits 0.
 */
async function main(): Promise<void> {
  const fs: FsModule = await import('node:fs');
  fsModule = fs;
  const argv = process.argv;
  const packageId = argv[2] ?? '';
  const expectedSha = argv[3] ?? '';
  const packagePath = argv[4] ?? '';
  const outputPath = argv[5] ?? '';
  runPackageId = packageId;
  if (packagePath.length === 0 || !SHA256_HEX_RE.test(expectedSha)) {
    fail(`package ${packageId.length > 0 ? packageId : '<unnamed>'}: argv must supply `
      + 'package.js (argv[4]) and its lowercase hex sha256 (argv[3])');
  }
  const bytes = readPackageBytes(fs, packagePath);
  if (sha256HexOfBytes(bytes) !== expectedSha) {
    // The design's verify-then-use: not one guest byte evaluates, and nothing
    // reaches stdout (the kernel reports the digest mismatch from the exit).
    process.exit(EXIT_FATAL);
  }
  if (outputPath.length > 0) {
    try {
      captureFd = fs.openSync(outputPath, 'a');
    } catch {
      captureFd = null;
    }
  }
  installCapture();
  const source = bytes.toString('utf8');
  let registration: unknown = undefined;
  try {
    const factory: () => unknown = new Function(
      `return (async () => {\n${source}\n})()`,
    ) as () => unknown;
    registration = await factory();
  } catch (err) {
    fail(`package ${packageId}: the source could not be evaluated: ${describe(err)}`, EXIT_BAD_DECLARATION);
  }
  const declared = validateRegistrationOrFail(registration, packageId);
  handlers = declared.handlers;
  const readyLine = encodeReady(declared.tools);
  startProtocolLoop();
  writeProtocolLine(`${readyLine}\n`);
}

/**
 * The file runs its lifecycle only when it is the process entry point — the
 * kernel delivers the leaf copy under a location-independent name
 * (`run-bootstrap.mjs` compiled, or `run-bootstrap.mts` when the tests copy
 * the type-stripped source into a leaf), so Node's nearest-package.json
 * resolution can never reach an ancestor the Run cannot read. A test that
 * evaluates the file as a library body (the codec lockstep) therefore reaches
 * the inlined functions without spawning a Run.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1] ?? '';
  return /(^|[\\/])run-bootstrap\.(?:mjs|mts|js|ts)$/.test(entry);
}

if (isEntryPoint()) {
  void main().catch((err: unknown) => {
    fail(`package ${runPackageId.length > 0 ? runPackageId : '<unnamed>'}: bootstrap failure: ${describe(err)}`);
  });
}
