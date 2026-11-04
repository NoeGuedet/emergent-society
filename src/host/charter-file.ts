import { Buffer } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MAX_CAPTURE_BYTES } from '../node/gate.js';
import {
  lstatAt,
  openLeafAt,
  openPinnedParent,
  openPinnedRoot,
  WorldFsError,
  WorldFsInvalidPathError,
  WorldFsMissingError,
  WorldFsProcUnavailableError,
  WorldFsUnsafeParentError,
} from '../node/world-fs.js';
import { HostConfigError } from './errors.js';
import { providersFileOf, worldPairOf } from './layout.js';

/**
 * One operator file's validated bytes and text.
 *
 * Two commands read an operator-owned file into the kernel: the node's
 * `--charter-file` (and the gateway overlay's `--gateway-charter`, every
 * `--nodes-file` entry charter) and `direct`'s `--file` (the chat reply's batch
 * twin and the ratification's bytes). They share ONE read discipline, written
 * here.
 *
 * THE PINNED CHAIN. The operator's explicit path is the only authority, and the
 * whole ancestor chain is opened no-follow before the leaf is read. The single
 * exception is the historical legacy world-root alias (`worldPairOf(home).world`
 * may be a symlink): its canonical target is resolved ONCE and is the only
 * trusted symlink prefix. A world-addressed input is walked below that pinned
 * canonical root; an EXTERNAL input is walked from `/` with `O_NOFOLLOW`
 * including its prefix and leaf, so an external alias that enters the world and
 * leaves it again is refused (there is no lexical-prefix-only classifier and no
 * `realpath(dirname(input))`). Interior symlinks are refused, never followed.
 *
 * The leaf is opened through the pinned parent with `O_NOFOLLOW|O_NONBLOCK`
 * (a FIFO can never block the open), proved regular, identity-compared to the
 * lstat'ed entry, read under the cap and decoded as fatal UTF-8. At most
 * `maxBytes + 1` raw bytes are ever loaded, so an oversize file is refused by
 * its byte count, never buffered whole; the bytes must be valid UTF-8 — an
 * invalid encoding is refused, not silently rewritten into replacement
 * characters — and nothing about the file is ever echoed back except its path,
 * never its content.
 *
 * THE PROVIDERS STORE IS REFUSED BY PATH AND BY IDENTITY: the store's path is
 * compared, and the opened handle's `(dev, ino)` is compared to the store's
 * before a single byte is returned — a hardlink to it carries the same inode, so
 * a rename trick cannot reach the key. A leaf symlink is never opened or read;
 * its one identity-only `stat`, taken through the pinned parent (never on the
 * original path), decides only whether the providers sentence or the existing
 * non-regular sentence applies. The credential store must never enter the
 * journal (a node's charter is journaled as configuration; the overlay's
 * charter rides every assembled request body, which the frontier captures) and
 * must never enter the world (a ratification commits its bytes).
 *
 * The old path-based `readOperatorFile` is deliberately gone, not kept as a
 * fallback, and `refuseSymlinks` is removed: no-follow is implicit for every
 * caller. The old charter convenience of following an operator symlink is
 * declined in the same B2a commit (no existing test asserted a positive
 * operator-file symlink ancestor).
 *
 * `allowEmpty` is the ratification's: an empty world file is a legitimate
 * ratification (an empty direction is the pin's own fallback), while an empty
 * charter is not a charter.
 */

/** One operator file, validated: the exact bytes and their UTF-8 decoding. */
export type OperatorFile = {
  readonly bytes: Buffer;
  readonly text: string;
};

/** The later-pin test seam: the pinned parent fd and its bounded location. */
export type PinnedOperatorPin = {
  readonly fd: number;
  readonly root: string;
  /** The input path relative to the pinned root (the pinned parent's own form). */
  readonly rel: string;
};

/** The pinned read's variations; the shared rules are never optional. */
export type PinnedOperatorFileOptions = {
  /** The cell's configured world root (`worldPairOf(home).world`). */
  readonly worldRoot: string;
  /**
   * The `--nodes-file` DECLARATION's production-only rule: host configuration
   * must be external, so a world-addressed input is refused before any parse.
   * Entry charters never set it (the operator explicitly named them).
   */
  readonly requireExternal?: boolean;
  /** Accept a zero-byte (or whitespace-only) file; the charter read refuses it. */
  readonly allowEmpty?: boolean;
  /** The per-call read cap (default `MAX_CAPTURE_BYTES`). */
  readonly maxBytes?: number;
  /** The refusal sentence for the providers store (the caller's own wording). */
  readonly providersRefusal?: string;
  /** Test-only: fires exactly once, after the final parent pin, before the leaf lstat/open. */
  readonly afterPinned?: (pin: PinnedOperatorPin) => Promise<void>;
  /** Test-only: the proc-filesystem root (never CLI/env/guest). */
  readonly procRoot?: string;
};

/** The default providers-store refusal: the key must never leave the home. */
const PROVIDERS_REFUSAL = 'refusing the providers store: its content must never be journaled'
  + ' or committed to the world';

/** One absolute path's validated components; `.`/`..`/empty/NUL are refused. */
function pathSegments(path: string): string[] {
  if (!isAbsolute(path)) {
    throw new HostConfigError(`the operator file path must be absolute: ${path}`);
  }
  const parts = path.slice(1).split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.includes('\0')) {
      throw new HostConfigError(
        `the operator file path has an unsafe component: ${path}`);
    }
  }
  return parts;
}

/** Whether `path` is `prefix` itself or one of its descendants (path-component aware). */
function beneath(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (prefix === '/') return path.startsWith('/');
  return path.startsWith(prefix) && path[prefix.length] === '/';
}

/** The relative segments of one path under an exact prefix. */
function relativeSegments(path: string, prefix: string): string[] {
  if (path === prefix) return [];
  const relative = path.slice(prefix.length + 1);
  return relative === '' ? [] : relative.split('/');
}

/** One failure mapped onto the caller's bounded `HostConfigError`. */
function readRefusal(err: unknown, label: string, path: string): HostConfigError {
  if (err instanceof HostConfigError) return err;
  const where = `${label} ${path}`;
  if (err instanceof WorldFsInvalidPathError) {
    return new HostConfigError(`${where} is not a valid absolute path`);
  }
  if (err instanceof WorldFsMissingError) {
    return new HostConfigError(`could not read ${where}: no such entry`);
  }
  if (err instanceof WorldFsProcUnavailableError) {
    return new HostConfigError(`could not read ${where}: the pinned read is unavailable`
      + ' (/proc is missing)');
  }
  if (err instanceof WorldFsUnsafeParentError) {
    return new HostConfigError(`${where} has an unsafe parent component`
      + ' (a symlink or a non-directory); refusing to follow it');
  }
  if (err instanceof WorldFsError) {
    return new HostConfigError(`could not read ${where}: ${err.errno ?? 'an I/O failure'}`);
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return new HostConfigError(`could not read ${where}: ${code ?? 'an unknown failure'}`);
}

/** The providers store's inode, or null when a fresh home has no store yet. */
async function providersInfoOf(providersFile: string): Promise<Stats | null> {
  try {
    return await stat(providersFile);
  } catch {
    return null;
  }
}

/**
 * Reads one operator file through the pinned chain.
 *
 * @throws HostConfigError for a missing, non-regular, symlinked, exterior
 * symlink or unsafe-parent path, a world-addressed `--nodes-file` declaration,
 * an oversize or non-UTF-8 file, an empty charter, and the providers store by
 * path or inode.
 */
export async function readPinnedOperatorFile(
  home: string, path: string, label: string, options: PinnedOperatorFileOptions,
): Promise<OperatorFile> {
  const refusal = options.providersRefusal ?? PROVIDERS_REFUSAL;
  const maxBytes = options.maxBytes ?? MAX_CAPTURE_BYTES;
  const procRoot = options.procRoot;
  const segments = pathSegments(path);
  const providersFile = providersFileOf(home);
  if (path === providersFile) throw new HostConfigError(refusal);
  const providersInfo = await providersInfoOf(providersFile);

  // ONE realpath attempt of the trusted world root. On success it is both the
  // compared canonical prefix and the root opened below (never resolved again);
  // on failure only the configured-prefix compare applies, and an external
  // source is never refused (a reply on a damaged home still works).
  let canonicalWorld: string | null = null;
  try {
    canonicalWorld = await realpath(options.worldRoot);
  } catch {
    canonicalWorld = null;
  }
  const underConfigured = beneath(path, options.worldRoot);
  const underCanonical = canonicalWorld !== null && beneath(path, canonicalWorld);
  if (underConfigured || underCanonical) {
    if (options.requireExternal === true) {
      throw new HostConfigError(
        `${label} must be external to the world: a world-addressed declaration is`
        + ' guest-writable host configuration and is refused');
    }
    const prefix = underCanonical ? canonicalWorld! : options.worldRoot;
    const rel = relativeSegments(path, prefix);
    const base = rel.pop();
    if (base === undefined) {
      throw new HostConfigError(`${label} ${path} is not a regular file`);
    }
    const rootPath = underCanonical ? canonicalWorld! : (canonicalWorld ?? options.worldRoot);
    const resolvedRoot = canonicalWorld !== null && rootPath === canonicalWorld;
    const root = await openPinnedRoot(rootPath, {
      ...(procRoot !== undefined ? { procRoot } : {}),
      ...(resolvedRoot ? { resolved: true } : {}),
    }).catch((err: unknown) => { throw readRefusal(err, label, path); });
    try {
      const parent = await openPinnedParent(root.fd, rel, {
        ...(procRoot !== undefined ? { procRoot } : {}),
      }).catch((err: unknown) => { throw readRefusal(err, label, path); });
      try {
        if (options.afterPinned !== undefined) {
          await options.afterPinned({ fd: parent.fd, root: rootPath, rel: [...rel, base].join('/') });
        }
        return await readLeaf(
          parent.fd, base, label, path, maxBytes, options.allowEmpty === true,
          providersInfo, refusal, procRoot,
        );
      } finally {
        await parent.close().catch(() => {});
      }
    } finally {
      await root.close().catch(() => {});
    }
  }

  // The external arm: `/` is the pinned root and every component (including the
  // prefix and the leaf) is walked no-follow — an alias into the world that
  // leaves it again is refused, never lexically classified.
  const base = segments.pop();
  if (base === undefined) {
    throw new HostConfigError(`${label} ${path} is not a regular file`);
  }
  const root = await openPinnedRoot('/', {
    ...(procRoot !== undefined ? { procRoot } : {}),
  }).catch((err: unknown) => { throw readRefusal(err, label, path); });
  try {
    const parent = await openPinnedParent(root.fd, segments, {
      ...(procRoot !== undefined ? { procRoot } : {}),
    }).catch((err: unknown) => { throw readRefusal(err, label, path); });
    try {
      if (options.afterPinned !== undefined) {
        await options.afterPinned({ fd: parent.fd, root: '/', rel: [...segments, base].join('/') });
      }
      return await readLeaf(
        parent.fd, base, label, path, maxBytes, options.allowEmpty === true,
        providersInfo, refusal, procRoot,
      );
    } finally {
      await parent.close().catch(() => {});
    }
  } finally {
    await root.close().catch(() => {});
  }
}

/** The leaf read through the pinned parent: identity, providers, cap, fatal UTF-8. */
async function readLeaf(
  parentFd: number, base: string, label: string, path: string, maxBytes: number,
  allowEmpty: boolean, providersInfo: Stats | null, refusal: string,
  procRoot: string | undefined,
): Promise<OperatorFile> {
  const pinOptions = procRoot !== undefined ? { procRoot } : {};
  let entry: Stats;
  try {
    entry = await lstatAt(parentFd, base, pinOptions);
  } catch (err) {
    throw readRefusal(err, label, path);
  }
  if (entry.isSymbolicLink()) {
    // Never opened or read. One identity-only stat, through the pinned parent,
    // decides only which existing sentence applies.
    if (providersInfo !== null) {
      const procBase = procRoot ?? '/proc';
      try {
        const target = await stat(join(procBase, 'self', 'fd', String(parentFd), base));
        if (target.dev === providersInfo.dev && target.ino === providersInfo.ino) {
          throw new HostConfigError(refusal);
        }
      } catch (err) {
        if (err instanceof HostConfigError) throw err;
        // The target is unreadable: the non-regular refusal below is the truth.
      }
    }
    throw new HostConfigError(`${label} ${path} is not a regular file`);
  }
  if (!entry.isFile()) {
    throw new HostConfigError(`${label} ${path} is not a regular file`);
  }
  let handle: FileHandle;
  try {
    handle = await openLeafAt(parentFd, base, fsConstants.O_RDONLY, pinOptions);
  } catch (err) {
    throw readRefusal(err, label, path);
  }
  try {
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
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const { bytesRead: chunk } = await handle.read(
        buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk === 0) break;
      bytesRead += chunk;
    }
    if (bytesRead > maxBytes) {
      throw new HostConfigError(
        `${label} is over ${maxBytes} bytes; the limit is ${maxBytes}`);
    }
    const bytes = Buffer.from(buffer.subarray(0, bytesRead));
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HostConfigError(`${label} ${path} is not valid UTF-8`);
    }
    if (!allowEmpty && text.trim() === '') {
      throw new HostConfigError(`${label} is empty`);
    }
    return { bytes, text };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The operator charter file's one read path, shared by the node's
 * `--charter-file`, the gateway overlay's `--gateway-charter` and every
 * `--nodes-file` entry charter: the pinned discipline above, with the charter's
 * own providers sentence and an empty charter refused. Entry charters may stay
 * world-addressed (the operator explicitly named them); the declaration itself
 * is read elsewhere with `requireExternal`.
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
  const { text } = await readPinnedOperatorFile(home, path, 'the charter file', {
    worldRoot: worldPairOf(home).world,
    providersRefusal: 'refusing the providers store as a charter file;'
      + ' its content would be journaled',
  });
  return text;
}
