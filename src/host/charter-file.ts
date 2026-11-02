import { Buffer } from 'node:buffer';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MAX_CAPTURE_BYTES } from '../node/gate.js';
import { HostConfigError } from './errors.js';
import { cellPaths } from './layout.js';

/**
 * The operator charter file's one read path, shared by the node's
 * `--charter-file` and the gateway overlay's `--gateway-charter`.
 *
 * The path is the operator's own (validated absolute by argv parsing) and must
 * resolve to a regular file — a FIFO, a device or a directory is refused rather
 * than read; symlinks are followed. At most `MAX_CAPTURE_BYTES + 1` raw bytes
 * are ever loaded, so an oversize file is refused by its byte count, never
 * buffered whole; the bytes must be valid UTF-8 — an invalid encoding is
 * refused, not silently rewritten into replacement characters — and nothing
 * about the file is ever echoed back except its path, never its content. The
 * providers store is refused by path AND by identity: a symlink or a hardlink
 * to it carries the same inode, so the opened file's `(dev, ino)` is compared
 * to the store's before a single byte is read — the credential store must never
 * enter the journal (a node's charter is journaled as configuration; the
 * overlay's charter rides every assembled request body, which the frontier
 * captures).
 *
 * The bound is the capture ceiling — the boot charter read's DoS guard, not an
 * arbitrary charter size: a file this large could never become a sendable
 * request anyway, and reading more of it would only spend the host's memory on
 * a value no bound admits, so an oversize file is REFUSED (never truncated).
 * The identity budget at the START-composition seam is the one node identity
 * bound; this guard and `validateAgentConfig`'s canonical-config ceiling are
 * separate, file/DOS bounds and are named as such in the docs.
 */
export async function readCharterFile(home: string, uid: string, path: string): Promise<string> {
  const resolved = resolve(path);
  const { providersFile } = cellPaths(home, uid);
  if (resolved === resolve(providersFile)) {
    throw new HostConfigError(
      'refusing the providers store as a charter file; its content would be journaled');
  }
  let providersInfo;
  try {
    providersInfo = await stat(providersFile);
  } catch {
    // The store may not exist yet in a fresh home: no inode to compare then.
    providersInfo = null;
  }
  let info;
  try {
    info = await stat(resolved);
  } catch (err) {
    throw new HostConfigError(
      `could not read the charter file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!info.isFile()) {
    throw new HostConfigError(`the charter file ${path} is not a regular file`);
  }
  let handle: FileHandle;
  try {
    handle = await open(resolved, 'r');
  } catch (err) {
    throw new HostConfigError(
      `could not read the charter file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // The identity check the path check cannot give: a symlink or a hardlink
    // to the providers store has a different path but the same inode, and
    // the opened handle's own stat is the opened bytes' truth — no TOCTOU.
    const opened = await handle.stat();
    if (providersInfo !== null
      && opened.dev === providersInfo.dev && opened.ino === providersInfo.ino) {
      throw new HostConfigError(
        'refusing the providers store as a charter file; its content would be journaled');
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
        `the charter file is over ${MAX_CAPTURE_BYTES} bytes; the limit is ${MAX_CAPTURE_BYTES}`);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new HostConfigError(`the charter file ${path} is not valid UTF-8`);
    }
    if (text.trim() === '') throw new HostConfigError('the charter file is empty');
    return text;
  } finally {
    await handle.close();
  }
}
