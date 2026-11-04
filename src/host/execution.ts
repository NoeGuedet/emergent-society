import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  chmod, link, lstat, mkdir, open, readdir, readFile, realpath, statfs, unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { C13_EVENT_TYPES } from '../context/events.js';
import { ContextFold } from '../context/fold.js';
import { loadVerifiedEvents } from '../context/loader.js';
import {
  HASH_RE, NODE_UID_RE, canonicalizeJson, copyJsonValue, nodeLayout,
} from '../journal/index.js';
import { isRecord } from '../util.js';
import { HostConfigError } from './errors.js';

/**
 * The execution backend: the immutable host-owned marker, its strict read and
 * write, the VM evidence a lost marker leaves behind, and the fail-closed
 * selection the host runs before it opens a world, a journal or a runtime.
 *
 * B1 records a backend; it does not activate one. A fresh home is Landlock. A
 * `vm-qemu` marker is a valid schema the engine recognizes and then refuses as
 * unavailable until the VM bricks activate it; a marker-less home with actual
 * VM evidence is refused rather than silently run as host Landlock. A
 * marker-less pair that the existing `WorldRepo.open` accepts stays the
 * ordinary legacy Landlock home, unchanged.
 *
 * The marker lives at `<home>/.es/execution.json`: a regular 0600 same-uid file
 * opened with `O_NOFOLLOW`, read exactly to its fstat size under 4 KiB, and
 * parsed as one strict JSON document with an exact, backend-discriminated key
 * set. Creation is atomic and non-overwriting (`O_CREAT|O_EXCL` temp, fsync,
 * hard link, directory fsync). Nothing here repairs or rewrites a marker.
 */

/** The immutable marker's basename inside `<home>/.es`. */
export const EXECUTION_MARKER_FILE = 'execution.json';
/** The strict host-owned network record's basename inside `<home>/.es`. */
export const VM_NETWORK_FILE = 'vm-network.json';
/** The exact first sentence of the VM execute offering (B5's detection token). */
export const VM_OFFERING_MARKER =
  "Run commands as root inside this home's Linux guest.";

const ES_DIR = '.es';
const WORLD_DIR = 'world';
const VM_DIR = 'vm';
const MARKER_MAX_BYTES = 4096;
const NETWORK_MAX_BYTES = 4096;
const EXT4_SUPER_MAGIC = 0xef53;
const IMAGE_MAX_BYTES = 64 * 1024 ** 3;

/** The pinned base-image identity a `vm-qemu` marker carries. */
export type ExecutionImage = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
};

/** The marker's exact schema, discriminated by `backend`. */
export type ExecutionMarker =
  | { readonly v: 1; readonly backend: 'landlock'; readonly createdAt: number }
  | {
      readonly v: 1; readonly backend: 'vm-qemu';
      readonly image: ExecutionImage; readonly createdAt: number;
    };

/** What an internal init call asks for. The CLI never exposes `vm-qemu` in B1. */
export type InitRequest =
  | { readonly backend: 'landlock' }
  | { readonly backend: 'vm-qemu'; readonly imagePath: string };

/** The stable refusal labels this module emits. */
export type ExecutionRefusalCode =
  | 'execution/marker-invalid'
  | 'execution/marker-conflict'
  | 'execution/marker-absent'
  | 'execution/marker-absent-vm-evidence'
  | 'execution/layout-damaged'
  | 'execution/vm-not-activated'
  | 'execution/vm-no-sandbox'
  | 'execution/network-record-absent'
  | 'execution/network-record-invalid'
  | 'execution/image-invalid';

/** A typed execution refusal: a `HostConfigError` (exit 2) with a stable code. */
export class ExecutionRefusalError extends HostConfigError {
  constructor(readonly code: ExecutionRefusalCode, detail: string) {
    super(`${code}: ${detail}`);
  }
}

/** The one network-record shape (`<home>/.es/vm-network.json`). */
export type VmNetworkRecord = {
  readonly v: 1;
  readonly home: string;
  readonly id: string;
  readonly n: number;
  readonly interface: string;
  readonly bridge: string;
  readonly guest: {
    readonly addr: string; readonly prefix: 30; readonly gateway: string;
  };
  readonly dns: string;
  readonly mac: string;
};

export function executionMarkerPath(home: string): string {
  return join(home, ES_DIR, EXECUTION_MARKER_FILE);
}

export function vmNetworkPath(home: string): string {
  return join(home, ES_DIR, VM_NETWORK_FILE);
}

function refuse(code: ExecutionRefusalCode, detail: string): never {
  throw new ExecutionRefusalError(code, detail);
}

/** A strict-JSON scanner failure; never escapes as a raw `SyntaxError`. */
class StrictJsonError extends Error {}

/**
 * Parses exactly one JSON document with duplicate object keys refused and no
 * trailing content. `JSON.parse` silently keeps the last duplicate and accepts
 * trailing whitespace, which is too permissive for the two host-owned records.
 */
function parseStrictJson(text: string): unknown {
  let index = 0;
  const length = text.length;
  const fail = (): never => { throw new StrictJsonError('not one strict JSON document'); };
  const skipWhitespace = (): void => {
    for (;;) {
      const char = text.charAt(index);
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') return;
      index += 1;
    }
  };
  const expect = (word: string): void => {
    if (text.slice(index, index + word.length) !== word) fail();
    index += word.length;
  };
  const parseString = (): string => {
    if (text.charAt(index) !== '"') fail();
    index += 1;
    let out = '';
    for (;;) {
      if (index >= length) fail();
      const char = text.charAt(index);
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === '\\') {
        index += 1;
        if (index >= length) fail();
        const escape = text.charAt(index);
        index += 1;
        switch (escape) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
            out += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            break;
          }
          default: fail();
        }
        continue;
      }
      if (char.charCodeAt(0) < 0x20) fail();
      out += char;
      index += 1;
    }
  };
  const parseNumber = (): number => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(index),
    );
    if (match === null) return fail();
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail();
    return value;
  };
  const parseArray = (): unknown[] => {
    index += 1;
    const out: unknown[] = [];
    skipWhitespace();
    if (text.charAt(index) === ']') {
      index += 1;
      return out;
    }
    for (;;) {
      out.push(parseValue());
      skipWhitespace();
      const char = text.charAt(index);
      if (char === ',') {
        index += 1;
        continue;
      }
      if (char === ']') {
        index += 1;
        return out;
      }
      fail();
    }
  };
  const parseObject = (): Record<string, unknown> => {
    index += 1;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    skipWhitespace();
    if (text.charAt(index) === '}') {
      index += 1;
      return out;
    }
    for (;;) {
      skipWhitespace();
      const key = parseString();
      if (Object.hasOwn(out, key)) fail();
      skipWhitespace();
      if (text.charAt(index) !== ':') fail();
      index += 1;
      const value = parseValue();
      Object.defineProperty(out, key, {
        value, enumerable: true, writable: true, configurable: true,
      });
      skipWhitespace();
      const char = text.charAt(index);
      if (char === ',') {
        index += 1;
        continue;
      }
      if (char === '}') {
        index += 1;
        return out;
      }
      fail();
    }
  };
  const parseValue = (): unknown => {
    skipWhitespace();
    if (index >= length) fail();
    const char = text.charAt(index);
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === 't') { expect('true'); return true; }
    if (char === 'f') { expect('false'); return false; }
    if (char === 'n') { expect('null'); return null; }
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    return fail();
  };
  const value = parseValue();
  if (index !== length) fail();
  return value;
}

function parseJsonOrRefuse(
  text: string, code: ExecutionRefusalCode, label: string,
): unknown {
  try {
    return parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) refuse(code, `${label} is not one strict JSON document`);
    throw error;
  }
}

/** Exact key set: no extra key, no missing key. */
function exactKeys(
  object: Record<string, unknown>, keys: readonly string[],
  code: ExecutionRefusalCode, label: string,
): void {
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) refuse(code, `${label} has unexpected key ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) refuse(code, `${label} is missing key ${JSON.stringify(key)}`);
  }
}

function safeInteger(
  value: unknown, label: string, min: number, code: ExecutionRefusalCode,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    refuse(code, `${label} must be a safe integer in [${min}, ${max}]`);
  }
  return value;
}

function outsideHome(path: string, home: string, code: ExecutionRefusalCode, label: string): void {
  const root = resolve(home);
  const target = resolve(path);
  if (target === root || target.startsWith(root + sep)) {
    refuse(code, `${label} must be outside the cell home`);
  }
}

/**
 * Creates the owner-only `.es` directory, or returns the existing entry when a
 * concurrent init won the mkdir. `EEXIST` is never surfaced raw: the winner's
 * directory is validated by the caller (real directory, same uid, mode 0700),
 * and the non-overwriting marker link below still decides the one init winner.
 */
async function createEsDirectory(dir: string) {
  try {
    await mkdir(dir, { mode: 0o700 });
    // The explicit chmod defeats a restrictive umask (a 0700 mask would
    // otherwise create the directory 0000 and make its own marker unreadable).
    await chmod(dir, 0o700);
    return await lstat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await lstat(dir);
  }
}

/**
 * The `.es` directory the marker and network record live in. A symlink or a
 * non-directory is a layout refusal; writes additionally require owner-only
 * permissions (exactly 0700 — an existing 0500 directory, readable but not
 * writable, would otherwise fail its first temp creation with a raw EACCES).
 * Reads do not re-mode an existing directory.
 */
async function esDirectory(home: string, create: boolean): Promise<string | null> {
  const dir = join(home, ES_DIR);
  let entry;
  try {
    entry = await lstat(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    if (!create) return null;
    entry = await createEsDirectory(dir);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    refuse('execution/layout-damaged', `the ${ES_DIR} path is not a real directory`);
  }
  const uid = process.getuid?.();
  if (create && uid !== undefined && entry.uid !== uid) {
    refuse('execution/layout-damaged', `the ${ES_DIR} directory is not owned by the host uid`);
  }
  if (create && (entry.mode & 0o777) !== 0o700) {
    refuse('execution/layout-damaged', `the ${ES_DIR} directory must have mode 0700`);
  }
  return dir;
}

/**
 * Ensures and validates the owner-only `.es` directory for an init or a write,
 * returning its path. This is the one idempotent lock-metadata effect an `init`
 * may leave on a home it otherwise changes nothing on: the caller takes its
 * `init.lock` inside this directory before classifying anything.
 */
export async function ensureExecutionDirectory(home: string): Promise<string> {
  const dir = await esDirectory(home, true);
  if (dir === null) refuse('execution/layout-damaged', `the ${ES_DIR} directory is absent`);
  return dir;
}

/**
 * Reads one host-owned small file: lstat proves a regular non-symlink before
 * the `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` open (a FIFO can never block the open),
 * fstat re-proves regular 0600 same-uid, size 1..4096, exactly that size with
 * no trailing byte, strict UTF-8. `null` is ENOENT.
 */
async function readBoundedOwnedFile(
  path: string, code: ExecutionRefusalCode, label: string, maxBytes: number,
): Promise<string | null> {
  // The no-follow precheck is what keeps a FIFO, socket or device unopened: an
  // `open` on a FIFO can otherwise block before the fstat below proves it is not
  // a regular file. The non-blocking flag and the fstat stay as the race guard.
  try {
    const pre = await lstat(path);
    if (!pre.isFile() || pre.isSymbolicLink()) {
      return refuse(code, `${label} must be a regular file`);
    }
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT' || errno === 'ENOTDIR') return null;
    return refuse(code, `${label} cannot be read`);
  }
  let handle: FileHandle;
  try {
    handle = await open(
      path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT' || errno === 'ENOTDIR') return null;
    return refuse(code, `${label} cannot be read`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) refuse(code, `${label} must be a regular file`);
    if ((info.mode & 0o777) !== 0o600) refuse(code, `${label} must have mode 0600`);
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      refuse(code, `${label} must be owned by the host uid`);
    }
    if (info.nlink < 1) refuse(code, `${label} must have a live directory entry`);
    if (info.size < 1 || info.size > maxBytes) refuse(code, `${label} has an invalid size`);
    const bytes = Buffer.alloc(info.size);
    const read = await handle.read(bytes, 0, info.size, 0);
    if (read.bytesRead !== info.size) refuse(code, `${label} changed while it was read`);
    const extra = Buffer.alloc(1);
    const trailing = await handle.read(extra, 0, 1, info.size);
    if (trailing.bytesRead !== 0) refuse(code, `${label} carries trailing bytes`);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return refuse(code, `${label} is not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

function syncDirectory(dir: string): Promise<void> {
  return open(dir, 'r').then(async (handle) => {
    try { await handle.sync(); } finally { await handle.close(); }
  });
}

/** Parses one marker value. `home` bounds the image path. */
export function parseExecutionMarker(value: unknown, home: string): ExecutionMarker {
  const code = 'execution/marker-invalid' as const;
  if (!isRecord(value)) return refuse(code, 'the execution marker must be an object');
  if (value['v'] !== 1) return refuse(code, 'the execution marker v must be 1');
  const backend = value['backend'];
  if (backend === 'landlock') {
    exactKeys(value, ['v', 'backend', 'createdAt'], code, 'the execution marker');
    const createdAt = safeInteger(value['createdAt'], 'createdAt', 0, code);
    return { v: 1, backend: 'landlock', createdAt };
  }
  if (backend === 'vm-qemu') {
    exactKeys(value, ['v', 'backend', 'image', 'createdAt'], code, 'the execution marker');
    const image = value['image'];
    if (!isRecord(image)) return refuse(code, 'the execution marker image must be an object');
    exactKeys(image, ['path', 'sha256', 'bytes'], code, 'the execution marker image');
    const path = image['path'];
    if (typeof path !== 'string' || !isAbsolute(path)) {
      refuse(code, 'image.path must be an absolute path');
    }
    outsideHome(path, home, code, 'image.path');
    const sha256 = image['sha256'];
    if (typeof sha256 !== 'string' || !HASH_RE.test(sha256)) {
      refuse(code, 'image.sha256 must be 64 lowercase hex characters');
    }
    const bytes = safeInteger(image['bytes'], 'image.bytes', 1, code);
    const createdAt = safeInteger(value['createdAt'], 'createdAt', 0, code);
    return { v: 1, backend: 'vm-qemu', image: { path, sha256, bytes }, createdAt };
  }
  return refuse(code, 'the execution marker backend must be landlock or vm-qemu');
}

/** Reads the marker; `null` means it is absent. Never repairs or writes. */
export async function readExecutionMarker(home: string): Promise<ExecutionMarker | null> {
  const dir = await esDirectory(home, false);
  if (dir === null) return null;
  const text = await readBoundedOwnedFile(
    join(dir, EXECUTION_MARKER_FILE), 'execution/marker-invalid',
    'the execution marker', MARKER_MAX_BYTES,
  );
  if (text === null) return null;
  return parseExecutionMarker(
    parseJsonOrRefuse(text, 'execution/marker-invalid', 'the execution marker'),
    home,
  );
}

/**
 * Creates the marker atomically and never overwrites: the temp file is created
 * `O_CREAT|O_EXCL` 0600, fsynced, then hard-linked to the final name (a link
 * fails EEXIST rather than replacing an existing marker), and the `.es`
 * directory is fsynced. A concurrent creation is a typed conflict.
 */
export async function writeExecutionMarker(
  home: string, marker: ExecutionMarker,
): Promise<void> {
  const dir = await esDirectory(home, true);
  if (dir === null) return refuse('execution/layout-damaged', 'the marker directory is absent');
  const target = join(dir, EXECUTION_MARKER_FILE);
  const bytes = Buffer.from(canonicalizeJson(copyJsonValue(marker)), 'utf8');
  const temp = join(
    dir, `.${EXECUTION_MARKER_FILE}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`,
  );
  let handle: FileHandle | null = null;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.chmod(0o600);
    const written = await handle.write(bytes, 0, bytes.length, 0);
    if (written.bytesWritten !== bytes.length) {
      refuse('execution/layout-damaged', 'the execution marker could not be written');
    }
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        refuse('execution/marker-conflict', 'an execution marker already exists');
      }
      refuse('execution/layout-damaged', 'the execution marker could not be created');
    }
    try {
      await syncDirectory(dir);
    } catch {
      refuse('execution/layout-damaged', 'the execution marker directory could not be fsynced');
    }
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}

function present(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  });
}

/**
 * A pre-provisioned `vm` root is pristine only when it is exactly empty, or
 * exactly one real root:root 0700 `lost+found` directory on the same device.
 * Anything else — an artifact, a symlink, a file, a wrongly-owned child — is
 * VM evidence. The default Landlock path never cleans or removes it.
 */
async function vmRootIsNonPristine(root: string): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    return true;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) return true;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return true;
  }
  if (entries.length === 0) return false;
  if (entries.length !== 1 || entries[0] !== 'lost+found') return true;
  return (await classifyFreshVolumeRoot(root)) !== 'lost+found';
}

/**
 * Presence for the VM-evidence scan. `ENOENT`/`ENOTDIR` is absence; any other
 * `lstat` failure is an unreadable home, not "no evidence": a local fallback to
 * Landlock on `EACCES`/`EIO` would silently downgrade a VM home.
 */
async function evidencePresent(path: string): Promise<boolean> {
  try {
    return await present(path);
  } catch {
    return refuse('execution/layout-damaged', 'the VM evidence cannot be read');
  }
}

/**
 * The bounded journal evidence: every node's folded latest configuration, and
 * whether its `execute` description carries the exact VM offering first
 * sentence. A log the config gate will judge is not evidence here.
 */
async function journalHasVmOffering(home: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(join(home, 'nodes'), { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    return refuse('execution/layout-damaged', 'the VM evidence cannot be read');
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !NODE_UID_RE.test(entry.name)) continue;
    const layout = nodeLayout(home, entry.name);
    if (!(await evidencePresent(join(layout.dir, layout.logFile)))) continue;
    try {
      const events = await loadVerifiedEvents(home, entry.name, C13_EVENT_TYPES);
      const fold = new ContextFold();
      await fold.observe(events);
      const config = fold.snapshot().config?.value;
      if (config !== undefined && config.tools.some(
        (tool) => tool.name === 'execute' && tool.description.includes(VM_OFFERING_MARKER),
      )) return true;
    } catch {
      // A journal the config gate will judge is not evidence for this scan.
    }
  }
  return false;
}

/**
 * Whether a marker-less home carries actual VM evidence: the network record in
 * ANY form (valid, invalid, wrong mode/uid/path, symlink), a non-pristine `vm`
 * entry, or a journaled VM offering. Presence alone is evidence; validity is
 * deliberately not required, so a damaged record can never downgrade a home to
 * host Landlock. An unreadable root record or node directory refuses typed
 * instead of being read as absence.
 */
export async function hasVmEvidence(home: string): Promise<boolean> {
  if (await evidencePresent(join(home, ES_DIR, VM_NETWORK_FILE))) return true;
  if (await vmRootIsNonPristine(join(home, VM_DIR))) return true;
  return await journalHasVmOffering(home);
}

/**
 * The start/resume selector: the one guard the host runs before opening the
 * world, the frontier, the chat log or any runtime. A `landlock` marker and a
 * marker-less legacy home both return `landlock` (the runtime `--no-sandbox`
 * opt-out stays a separate fact); a VM marker is refused until activation; a
 * marker-less home with VM evidence never falls back to host execution.
 */
export async function assertExecutionStartable(
  home: string, options: { readonly noSandbox: boolean },
): Promise<'landlock'> {
  const marker = await readExecutionMarker(home);
  if (marker !== null) {
    if (marker.backend === 'vm-qemu') {
      const path = executionMarkerPath(home);
      if (options.noSandbox) {
        refuse('execution/vm-no-sandbox',
          `--no-sandbox cannot select host execution: the marker ${path} selects vm-qemu`);
      }
      refuse('execution/vm-not-activated',
        `the marker ${path} selects vm-qemu, which is not activated in this host`);
    }
    return 'landlock';
  }
  if (await hasVmEvidence(home)) {
    refuse('execution/marker-absent-vm-evidence',
      'the execution marker is missing but actual VM evidence exists; the home is not run as host Landlock');
  }
  return 'landlock';
}

function isCanonicalIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

/** A canonical, public, unicast IPv4 resolver address (bogon ranges refused). */
function isPublicIpv4(value: string): boolean {
  if (!isCanonicalIpv4(value)) return false;
  const octets = value.split('.').map((part) => Number(part));
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;
  return true;
}

function isCanonicalUnicastMac(value: string): boolean {
  if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(value)) return false;
  const octets = value.split(':').map((part) => Number.parseInt(part, 16));
  if (octets.every((octet) => octet === 0)) return false;
  if (octets.every((octet) => octet === 0xff)) return false;
  return (octets[0]! & 1) === 0;
}

function failNetwork(detail: string): never {
  return refuse('execution/network-record-invalid', detail);
}

/** Parses the exact network-record schema and binds it to `canonicalHome`. */
export function parseVmNetworkRecord(value: unknown, canonicalHome: string): VmNetworkRecord {
  const fail = failNetwork;
  if (!isRecord(value)) return fail('the VM network record must be an object');
  exactKeys(
    value,
    ['v', 'home', 'id', 'n', 'interface', 'bridge', 'guest', 'dns', 'mac'],
    'execution/network-record-invalid', 'the VM network record',
  );
  if (value['v'] !== 1) return fail('the VM network record v must be 1');
  if (value['home'] !== canonicalHome) return fail('the VM network record is not bound to this home');
  const id = value['id'];
  if (typeof id !== 'string' || !/^[0-9a-f]{6}$/.test(id)) {
    return fail('the VM network record id must be six lowercase hex characters');
  }
  const n = safeInteger(value['n'], 'the VM network record n', 1,
    'execution/network-record-invalid', 254);
  if (value['interface'] !== `estap${id}`) return fail('the interface must be exactly estap<id>');
  if (value['bridge'] !== `esbr${id}`) return fail('the bridge must be exactly esbr<id>');
  const guest = value['guest'];
  if (!isRecord(guest)) return fail('the guest must be an object');
  exactKeys(guest, ['addr', 'prefix', 'gateway'],
    'execution/network-record-invalid', 'the VM network record guest');
  if (guest['prefix'] !== 30) return fail('the guest prefix must be exactly 30');
  if (guest['addr'] !== `10.200.${n}.2`) return fail('the guest address is not the n-derived /30');
  if (guest['gateway'] !== `10.200.${n}.1`) {
    return fail('the guest gateway is not the n-derived /30');
  }
  const dns = value['dns'];
  if (typeof dns !== 'string' || !isPublicIpv4(dns)) {
    return fail('dns must be one canonical public IPv4 resolver');
  }
  const mac = value['mac'];
  if (typeof mac !== 'string' || !isCanonicalUnicastMac(mac)) {
    return fail('mac must be one canonical unicast MAC');
  }
  return {
    v: 1, home: canonicalHome, id, n,
    interface: `estap${id}`, bridge: `esbr${id}`,
    guest: { addr: `10.200.${n}.2`, prefix: 30, gateway: `10.200.${n}.1` },
    dns, mac,
  };
}

/** Reads the strict network record; the record is parsed, never written. */
export async function readVmNetworkRecord(home: string): Promise<VmNetworkRecord> {
  const text = await readBoundedOwnedFile(
    vmNetworkPath(home), 'execution/network-record-invalid',
    'the VM network record', NETWORK_MAX_BYTES,
  );
  if (text === null) {
    refuse('execution/network-record-absent', 'the VM network record is missing');
  }
  let canonicalHome: string;
  try {
    canonicalHome = await realpath(home);
  } catch {
    return refuse('execution/layout-damaged', 'the cell home cannot be resolved');
  }
  return parseVmNetworkRecord(
    parseJsonOrRefuse(text, 'execution/network-record-invalid', 'the VM network record'),
    canonicalHome,
  );
}

// --- the image pin ---------------------------------------------------------

/** What the host needs from `qemu-img info`. */
export type ImageInspection = {
  readonly format: string;
  /** A backing file name when one is declared, otherwise null. */
  readonly backing: string | null;
  readonly virtualBytes: number;
};

export type ImageInspector = (path: string) => Promise<ImageInspection>;

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      hash.update(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => resolvePromise());
  });
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Validates and pins a base image before a future VM marker write: absolute,
 * real regular non-symlink outside `<home>`, readable, 0 < bytes <= 64 GiB, a
 * full SHA-256, and an injected `ImageInspector` naming qcow2 with no backing
 * file. The inspector is the seam: the production `qemu-img` probe arrives with
 * the VM image brick, so B1 creates no image and starts no QEMU child.
 */
export async function pinExecutionImage(
  home: string, imagePath: string, inspect: ImageInspector,
): Promise<ExecutionImage> {
  if (!isAbsolute(imagePath)) {
    return refuse('execution/image-invalid', 'the image path must be absolute');
  }
  const target = resolve(imagePath);
  let homeReal: string;
  try {
    homeReal = await realpath(home);
  } catch {
    homeReal = resolve(home);
  }
  if (target === homeReal || target.startsWith(homeReal + sep)) {
    return refuse('execution/image-invalid', 'the image path must be outside the cell home');
  }
  let entry;
  try {
    entry = await lstat(target);
  } catch {
    return refuse('execution/image-invalid', 'the image cannot be read');
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return refuse('execution/image-invalid', 'the image must be a regular, non-symlinked file');
  }
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    return refuse('execution/image-invalid', 'the image cannot be resolved');
  }
  if (resolved !== target) {
    return refuse('execution/image-invalid', 'the image path must be the resolved real path');
  }
  if (entry.size <= 0 || entry.size > IMAGE_MAX_BYTES) {
    return refuse('execution/image-invalid', 'the image size is out of bounds');
  }
  let digest: { sha256: string; bytes: number };
  try {
    digest = await sha256File(target);
  } catch {
    return refuse('execution/image-invalid', 'the image cannot be read');
  }
  if (digest.bytes !== entry.size) {
    return refuse('execution/image-invalid', 'the image changed while it was read');
  }
  const inspection = await inspect(target);
  if (inspection.format !== 'qcow2') {
    return refuse('execution/image-invalid', 'the image format is not qcow2');
  }
  if (inspection.backing !== null) {
    return refuse('execution/image-invalid', 'the image must not have a backing file');
  }
  if (!Number.isSafeInteger(inspection.virtualBytes) || inspection.virtualBytes <= 0) {
    return refuse('execution/image-invalid', 'the image virtual size is invalid');
  }
  return { path: resolved, sha256: digest.sha256, bytes: digest.bytes };
}

// --- the explicit VM prerequisites (parsed, then refused; no activation) ---

type VolumeSpec = {
  readonly name: 'world' | 'vm';
  readonly capBytes: number;
  readonly capInodes: number;
};

const VOLUME_SPECS: readonly VolumeSpec[] = [
  { name: 'world', capBytes: 4 * 1024 ** 3, capInodes: 262_144 },
  { name: 'vm', capBytes: 24 * 1024 ** 3, capInodes: 65_536 },
];

type MountInfo = {
  readonly mountPoint: string;
  readonly fsType: string;
  readonly source: string;
};

function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

async function readMountInfo(): Promise<readonly MountInfo[]> {
  let text: string;
  try {
    text = await readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    return refuse('execution/layout-damaged', 'the mount table cannot be read');
  }
  const out: MountInfo[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 0) continue;
    const mountPoint = fields[4];
    const fsType = fields[separator + 1];
    const source = fields[separator + 2];
    if (mountPoint === undefined || fsType === undefined || source === undefined) continue;
    out.push({
      mountPoint: decodeMountField(mountPoint),
      fsType,
      source: decodeMountField(source),
    });
  }
  return out;
}

/**
 * The strict VM volume check shared by `init` and (later) start: each root is a
 * canonical real directory owned hostUID:hostGID 0700, a distinct
 * `/proc/self/mountinfo` ext4 loop mount point with a finite statfs within the
 * section-8.2 caps. B1 runs this while refusing a VM init; it creates nothing.
 */
export async function assertVmVolumes(home: string): Promise<void> {
  const code = 'execution/layout-damaged' as const;
  const homeEntry = await lstat(home);
  if (!homeEntry.isDirectory()) refuse(code, 'the cell home is not a directory');
  const mounts = await readMountInfo();
  const devices = new Set<number>([homeEntry.dev]);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  for (const spec of VOLUME_SPECS) {
    const root = join(home, spec.name);
    let entry;
    try {
      entry = await lstat(root);
    } catch {
      return refuse(code, `the ${spec.name} volume root is missing`);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      return refuse(code, `the ${spec.name} volume root must be a real directory`);
    }
    let canonical: string;
    try {
      canonical = await realpath(root);
    } catch {
      return refuse(code, `the ${spec.name} volume root cannot be resolved`);
    }
    if (canonical !== root) {
      return refuse(code, `the ${spec.name} volume root must be the resolved real path`);
    }
    if (uid !== undefined && entry.uid !== uid) {
      return refuse(code, `the ${spec.name} volume root must be owned by the host uid`);
    }
    if (gid !== undefined && entry.gid !== gid) {
      return refuse(code, `the ${spec.name} volume root must be owned by the host gid`);
    }
    if ((entry.mode & 0o777) !== 0o700) {
      return refuse(code, `the ${spec.name} volume root must have mode 0700`);
    }
    if (devices.has(entry.dev)) {
      return refuse(code, `the ${spec.name} volume root needs its own device`);
    }
    devices.add(entry.dev);
    const mount = mounts.find((candidate) => candidate.mountPoint === root);
    if (mount === undefined) {
      return refuse(code, `the ${spec.name} volume root is not a mount point`);
    }
    if (mount.fsType !== 'ext4') {
      return refuse(code, `the ${spec.name} volume root is not an ext4 mount`);
    }
    if (!mount.source.startsWith('/dev/loop')) {
      return refuse(code, `the ${spec.name} volume root is not a loop device mount`);
    }
    let reading;
    try {
      reading = await statfs(root);
    } catch {
      return refuse(code, `the ${spec.name} volume statfs cannot be read`);
    }
    if (reading.type !== EXT4_SUPER_MAGIC) {
      return refuse(code, `the ${spec.name} volume is not ext4`);
    }
    const bytes = reading.bsize * reading.blocks;
    const inodes = reading.files;
    if (!Number.isFinite(bytes) || !Number.isFinite(inodes)) {
      return refuse(code, `the ${spec.name} volume bounds are not finite`);
    }
    if (bytes <= 0 || bytes > spec.capBytes) {
      return refuse(code, `the ${spec.name} volume bytes are out of bounds`);
    }
    if (inodes <= 0 || inodes > spec.capInodes) {
      return refuse(code, `the ${spec.name} volume inodes are out of bounds`);
    }
  }
}

/** What one fresh VM volume root is: empty, exactly the fresh `lost+found`, or damaged. */
export type FreshVolumeKind = 'empty' | 'lost+found' | 'damaged';

/**
 * The one pristine rule: exactly empty, or exactly one real root:root 0700
 * `lost+found` directory on the same device, itself proven EMPTY. A non-empty
 * or unreadable `lost+found` is `damaged`: the fresh classifier accepts only
 * the empty ext4 root-shape it knows how to remove, never a directory whose
 * contents would be adopted. Nothing is removed here.
 */
export async function classifyFreshVolumeRoot(root: string): Promise<FreshVolumeKind> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 'damaged';
  }
  if (entries.length === 0) return 'empty';
  if (entries.length !== 1 || entries[0] !== 'lost+found') return 'damaged';
  const lostFound = join(root, 'lost+found');
  try {
    const entry = await lstat(lostFound);
    const parent = await lstat(root);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return 'damaged';
    if (entry.uid !== 0 || entry.gid !== 0) return 'damaged';
    if ((entry.mode & 0o777) !== 0o700) return 'damaged';
    if (entry.dev !== parent.dev) return 'damaged';
    if ((await readdir(lostFound)).length !== 0) return 'damaged';
    return 'lost+found';
  } catch {
    return 'damaged';
  }
}

/**
 * The post-init volume-root entry guard for a valid `vm-qemu` marker re-init:
 * the fresh cleanup runs only while a home is being initialized, so a
 * `lost+found` that reappears at either mounted root after the marker exists is
 * a typed `execution/layout-damaged`, never removed and never accepted as a
 * fresh retry. Read-only. The known `vm` artifact allowlist and the normal
 * world-content rule belong to VM activation; B1 refuses the one entry its own
 * fresh classifier could have removed.
 */
export async function assertNoPostInitVolumeEntries(home: string): Promise<void> {
  const code = 'execution/layout-damaged' as const;
  for (const name of [WORLD_DIR, VM_DIR]) {
    let entries: string[];
    try {
      entries = await readdir(join(home, name));
    } catch {
      return refuse(code, `the ${name} volume root cannot be read`);
    }
    if (entries.includes('lost+found')) {
      refuse(code, `the ${name} volume root carries a post-init lost+found`);
    }
  }
}

/**
 * The explicit fresh-VM prerequisite gate. It validates the two mounted roots,
 * the strict network record and both pristine roots, optionally validates the
 * base image through the caller's inspector, then refuses
 * `execution/vm-not-activated`: B1 deliberately does not write a `vm-qemu`
 * marker or create a world/overlay, so no VM home can be produced before the
 * activation brick. The refusal leaves every input untouched.
 */
export async function assertVmInitPrerequisites(
  home: string, imagePath: string, inspect?: ImageInspector,
): Promise<never> {
  await assertVmVolumes(home);
  await readVmNetworkRecord(home);
  const world = await classifyFreshVolumeRoot(join(home, WORLD_DIR));
  const vm = await classifyFreshVolumeRoot(join(home, VM_DIR));
  if (world === 'damaged' || vm === 'damaged') {
    refuse('execution/layout-damaged',
      'the fresh VM volume roots must be empty or carry exactly the root:root 0700 lost+found');
  }
  if (inspect !== undefined) await pinExecutionImage(home, imagePath, inspect);
  return refuse('execution/vm-not-activated',
    'the VM prerequisites are valid but VM execution is not activated in this host');
}
