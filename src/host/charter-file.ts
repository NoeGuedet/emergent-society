import { Buffer } from 'node:buffer';
import { lstat, open, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MAX_CAPTURE_BYTES } from '../node/gate.js';
import { HostConfigError } from './errors.js';
import { providersFileOf } from './layout.js';

/**
 * One operator file's validated bytes and text.
 *
 * Two commands read an operator-owned file into the kernel: the node's
 * `--charter-file` (and the gateway overlay's `--gateway-charter`) and
 * `direct`'s `--file` (the chat reply's batch twin and the ratification's
 * bytes). They share ONE read discipline, written here.
 *
 * The path is the operator's own (validated absolute by argv parsing) and must
 * be a regular file — a FIFO, a device or a directory is refused rather than
 * read (the `stat`/`lstat` before `open` is what keeps a FIFO from blocking the
 * open). At most `MAX_CAPTURE_BYTES + 1` raw bytes are ever loaded, so an
 * oversize file is refused by its byte count, never buffered whole; the bytes
 * must be valid UTF-8 — an invalid encoding is refused, not silently rewritten
 * into replacement characters — and nothing about the file is ever echoed back
 * except its path, never its content.
 *
 * THE PROVIDERS STORE IS REFUSED BY PATH AND BY IDENTITY: the store's path is
 * compared, and the opened handle's `(dev, ino)` is compared to the store's
 * before a single byte is returned — a symlink or a hardlink to it carries the
 * same inode, so a rename trick cannot reach the key. The credential store must
 * never enter the journal (a node's charter is journaled as configuration; the
 * overlay's charter rides every assembled request body, which the frontier
 * captures) and must never enter the world (a ratification commits its bytes).
 *
 * `refuseSymlinks` is the ratification read's stronger rule: the path itself is
 * `lstat`ed, a symlink is refused, and the opened handle's identity must equal
 * the validated lstat's — the bytes read are the inode that was checked, with no
 * TOCTOU window. The charter read follows symlinks (the operator's own
 * convenience, unchanged). `allowEmpty` is the ratification's: an empty world
 * file is a legitimate ratification (an empty direction is the pin's own
 * fallback), while an empty charter is not a charter.
 */

/** One operator file, validated: the exact bytes and their UTF-8 decoding. */
export type OperatorFile = {
  readonly bytes: Buffer;
  readonly text: string;
};

/** The per-read variations; the shared rules are never optional. */
export type OperatorFileOptions = {
  /** Refuse a symlink at the path and prove the opened inode is the checked one. */
  readonly refuseSymlinks?: boolean;
  /** Accept a zero-byte (or whitespace-only) file; the charter read refuses it. */
  readonly allowEmpty?: boolean;
  /** The refusal sentence for the providers store (the caller's own wording). */
  readonly providersRefusal?: string;
};

/** The default providers-store refusal: the key must never leave the home. */
const PROVIDERS_REFUSAL = 'refusing the providers store: its content must never be journaled'
  + ' or committed to the world';

/**
 * Reads one operator file under the shared discipline.
 *
 * @throws HostConfigError for a missing, non-regular, symlinked (when refused),
 * oversize or non-UTF-8 file, for an empty charter, and for the providers
 * store by path or inode.
 */
export async function readOperatorFile(
  home: string, path: string, label: string, options: OperatorFileOptions = {},
): Promise<OperatorFile> {
  const refusal = options.providersRefusal ?? PROVIDERS_REFUSAL;
  const resolved = resolve(path);
  const providersFile = providersFileOf(home);
  if (resolved === resolve(providersFile)) throw new HostConfigError(refusal);
  let providersInfo;
  try {
    providersInfo = await stat(providersFile);
  } catch {
    // The store may not exist yet in a fresh home: no inode to compare then.
    providersInfo = null;
  }
  let entry;
  try {
    entry = options.refuseSymlinks === true ? await lstat(resolved) : await stat(resolved);
  } catch (err) {
    throw new HostConfigError(
      `could not read ${label} ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!entry.isFile()) {
    throw new HostConfigError(`${label} ${path} is not a regular file`);
  }
  let handle: FileHandle;
  try {
    handle = await open(resolved, 'r');
  } catch (err) {
    throw new HostConfigError(
      `could not read ${label} ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // The identity check the path check cannot give: a symlink or a hardlink
    // to the providers store has a different path but the same inode, and the
    // opened handle's own stat is the opened bytes' truth — no TOCTOU.
    const opened = await handle.stat();
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new HostConfigError(`${label} ${path} changed while it was being read; retry`);
    }
    if (!opened.isFile()) {
      throw new HostConfigError(`${label} ${path} is not a regular file`);
    }
    if (providersInfo !== null
      && opened.dev === providersInfo.dev && opened.ino === providersInfo.ino) {
      throw new HostConfigError(refusal);
    }
    const buffer = Buffer.alloc(MAX_CAPTURE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const { bytesRead: chunk } = await handle.read(
        buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > MAX_CAPTURE_BYTES) {
      throw new HostConfigError(
        `${label} is over ${MAX_CAPTURE_BYTES} bytes; the limit is ${MAX_CAPTURE_BYTES}`);
    }
    const bytes = Buffer.from(buffer.subarray(0, bytesRead));
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HostConfigError(`${label} ${path} is not valid UTF-8`);
    }
    if (options.allowEmpty !== true && text.trim() === '') {
      throw new HostConfigError(`${label} is empty`);
    }
    return { bytes, text };
  } finally {
    await handle.close();
  }
}

/**
 * The operator charter file's one read path, shared by the node's
 * `--charter-file` and the gateway overlay's `--gateway-charter`: the shared
 * discipline above, with the charter's own providers sentence, no symlink
 * refusal, and an empty charter refused.
 *
 * The bound is the capture ceiling — the boot charter read's DoS guard, not an
 * arbitrary charter size: a file this large could never become a sendable
 * request anyway, and reading more of it would only spend the host's memory on
 * a value no bound admits, so an oversize file is REFUSED (never truncated).
 * The identity budget at the START-composition seam is the one node identity
 * bound; this guard and `validateAgentConfig`'s canonical-config ceiling are
 * separate, file/DOS bounds and are named as such in the docs.
 */
export async function readCharterFile(
  home: string, _uid: string, path: string,
): Promise<string> {
  const { text } = await readOperatorFile(home, path, 'the charter file', {
    providersRefusal: 'refusing the providers store as a charter file;'
      + ' its content would be journaled',
  });
  return text;
}
