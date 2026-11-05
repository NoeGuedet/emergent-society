import { join } from 'node:path';
import {
  lstatAt, openPinnedDirAt, openPinnedRoot, readdirFd,
} from '../../node/world-fs.js';

export type TreeEntry = {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'special';
  readonly size?: number;
};

export type WorldTree = {
  readonly entries: readonly TreeEntry[];
  readonly truncated: boolean;
  readonly error?: string;
};

const MAX_ENTRIES = 2000;
const MAX_DEPTH = 6;

/** A bounded, pinned, no-follow worktree listing; never previews file bytes. */
export async function readWorldTree(home: string): Promise<WorldTree> {
  const entries: TreeEntry[] = [];
  let truncated = false;
  let root;
  try {
    root = await openPinnedRoot(join(home, 'world'));
  } catch {
    return { entries, truncated, error: 'world is unavailable' };
  }
  const add = (name: string, entry: TreeEntry): boolean => {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      return false;
    }
    if (name === '.git') return true;
    entries.push(entry);
    return true;
  };
  const walk = async (
    handle: Awaited<ReturnType<typeof openPinnedRoot>>, prefix: string, depth: number,
  ): Promise<void> => {
    let children;
    try {
      children = await readdirFd(handle);
    } catch {
      return;
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const path = prefix === '' ? child.name : `${prefix}/${child.name}`;
      let info;
      try {
        info = await lstatAt(handle.fd, child.name);
      } catch {
        add(child.name, { path, type: 'special' });
        continue;
      }
      if (info.isSymbolicLink()) {
        add(child.name, { path, type: 'symlink' });
      } else if (info.isDirectory()) {
        if (!add(child.name, { path, type: 'directory' })) return;
        if (depth < MAX_DEPTH) {
          let childHandle;
          try {
            childHandle = await openPinnedDirAt(handle.fd, child.name);
            await walk(childHandle, path, depth + 1);
          } catch {
            // A directory that raced away is listed without descending.
          } finally {
            await childHandle?.close().catch(() => {});
          }
        } else {
          truncated = true;
        }
      } else if (info.isFile()) {
        add(child.name, { path, type: 'file', size: info.size });
      } else {
        add(child.name, { path, type: 'special' });
      }
    }
  };
  try {
    await walk(root, '', 0);
  } finally {
    await root.close().catch(() => {});
  }
  return { entries, truncated };
}
