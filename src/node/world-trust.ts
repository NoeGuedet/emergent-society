import type { Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { UnsafeWorldPathError, WorldNotARepoError } from './errors.js';
import { runGit } from './world-git.js';

/**
 * The trust inputs of the world's external git dir: the path safeguards that
 * decide *where* the pair may live, and the three verification layers that
 * decide whether the git dir is still the one the kernel created.
 *
 * Layer 1 reads the git dir's own `config` and refuses every entry that does
 * not come from that file (includes, `config.worktree` and `commondir` are the
 * redirects) or that names an execution channel. Layer 2 walks the metadata
 * tree and refuses symlinks, multi-linked files and the metadata files git
 * would consult instead of the ones written here. Layer 3 asks git itself to
 * confirm the pair: `core.worktree` must be absolute and name the world root,
 * and `rev-parse --absolute-git-dir` must resolve back to this git dir.
 *
 * The layers run on `runGit` alone, on every `open`, before any repository
 * object exists: an in-world git dir is writable by the confined shell, so a
 * writable configuration, hook set or ref store would let the agent execute
 * code as the kernel through the kernel's own git calls.
 */

/**
 * `realpath`, or the input unchanged when the path does not exist. Only `ENOENT`
 * is a fallback — "the path is not there" is a fact this guard can work with. Any
 * other failure (EACCES, EIO) is an environment fact and propagates: silently
 * comparing raw strings would weaken a safeguard rather than report it.
 */
export async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw err;
  }
}

/** The sanitizing migration recipe for a legacy world whose git dir is in the world. */
export function migrationNote(root: string, gitDir: string): string {
  const legacy = join(root, '.git');
  return [
    'a legacy world whose .git lives inside the world must be migrated:',
    'stop the host;',
    `record the pre-migration HEAD (git --git-dir=${legacy} rev-parse HEAD);`,
    `mv ${legacy} ${gitDir};`,
    `sanitize the moved git dir: rm -f ${gitDir}/config.worktree ${gitDir}/info/grafts `
      + `${gitDir}/shallow ${gitDir}/objects/info/alternates ${gitDir}/commondir; `
      + `rm -rf ${gitDir}/hooks;`,
    `materialize every symlink under ${gitDir} (replace each link with a copy of its target, `
      + `repeating until 'find ${gitDir} -type l' is empty — or cp -aL) and replace every `
      + `multi-linked file with a fresh copy ('find ${gitDir} -type f -links +1');`,
    `rewrite ${gitDir}/config to the allowlisted keys only: repositoryformatversion (keep 1 for a `
      + 'sha-256 repo), filemode, bare=false, logallrefupdates, untrackedCache, '
      + 'extensions.objectFormat when sha-256;',
    `re-seed the hooks with 'git --git-dir=${gitDir} --work-tree=${root} init' (keeps bare=false `
      + 'and the 14 .sample files);',
    `record the pairing with 'git --git-dir=${gitDir} config core.worktree ${root}';`,
    `postcondition: 'git --git-dir=${gitDir} rev-parse HEAD' equals the recorded HEAD`,
  ].join(' ');
}

/** Component-wise containment: `child` is `parent` or lives under it. */
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * Refuses a git dir that overlaps the world. The external location is the
 * guarantee: a world-contained git dir is writable (and, under confinement,
 * writable *by the confined shell*), which reopens every execution channel this
 * contract exists to close.
 */
export function assertExternalGitDir(root: string, gitDir: string): void {
  if (!within(root, gitDir) && !within(gitDir, root)) return;
  throw new WorldNotARepoError(
    root,
    `the git directory ${gitDir} overlaps the world; it must live outside the world. `
      + migrationNote(root, gitDir));
}

/** `lstat` the path, or null when it is absent entirely (a dangling symlink is present). */
export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** One `git config --list --show-origin -z` record, which is `origin\0key\nvalue\0`. */
interface ConfigEntry {
  readonly origin: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Parses the `-z` scan. The `-z` form is used because the plain form lets a
 * multi-line value forge an origin line; here an origin or a key can never be
 * forged. A valueless key emits `origin\0key\0` and is parsed as an empty value.
 */
function parseConfigScan(out: string): ConfigEntry[] {
  const tokens = out.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const origin = tokens[i] ?? '';
    const record = tokens[i + 1] ?? '';
    if (origin === '' && record === '') continue;
    const newline = record.indexOf('\n');
    entries.push({
      origin,
      key: newline === -1 ? record : record.slice(0, newline),
      value: newline === -1 ? '' : record.slice(newline + 1),
    });
  }
  return entries;
}

/**
 * The keys a git dir's own `config` may never carry (layer 1). Matching is
 * prefix/suffix on git's normalized (lowercased) output, never camelCase
 * equality: a subsection keeps its case. The include directives are refused as
 * keys, not only by their targets' origins: a target absent at open is
 * silently skipped by git, so the origin rule never sees it — and an
 * agent-written target later would load `filter.*` into the kernel's own git.
 * Deliberately absent, with reasons: `alias.*` cannot override a builtin
 * (verified), `core.pager`/`pager.*` never run on a pipe (verified), and
 * `credential.helper`, `http.*`, `url.*`, `protocol.*`, `submodule.*` and
 * `uploadpack.*` are transports the kernel's plumbing never reaches once lazy
 * fetching is refused and disabled.
 */
const CONFIG_REFUSE_KEYS: ReadonlySet<string> = new Set([
  'core.fsmonitor', 'core.hookspath', 'core.sshcommand', 'core.attributesfile',
  'core.excludesfile', 'diff.external', 'log.showsignature', 'gpg.program',
  'gpg.ssh.program', 'extensions.worktreeconfig', 'extensions.partialclone',
  'extensions.refstorage',
]);

/** The layer-1 refusal for one config scan, or null when every entry is trusted. */
function configRefusal(entries: readonly ConfigEntry[], gitDir: string): string | null {
  const own = `file:${gitDir}/config`;
  for (const entry of entries) {
    if (entry.origin !== own) {
      return `config entry ${entry.key} comes from ${entry.origin}, not ${own} `
        + '(includes, config.worktree and commondir redirects are not trusted)';
    }
    if (entry.value.includes('\n')) {
      return `config entry ${entry.key} carries a multi-line value`;
    }
    const key = entry.key.toLowerCase();
    if (key === 'include.path' || key.startsWith('includeif.')) {
      return `config entry ${entry.key} redirects to another config file`;
    }
    if (key.startsWith('filter.')) return `config entry ${entry.key} configures a filter`;
    if (CONFIG_REFUSE_KEYS.has(key)) return `config entry ${entry.key} is execution-capable`;
    if (key.startsWith('diff.') && (key.endsWith('.command') || key.endsWith('.textconv'))) {
      return `config entry ${entry.key} names an external diff driver`;
    }
    if (key.startsWith('merge.') && key.endsWith('.driver')) {
      return `config entry ${entry.key} names a merge driver`;
    }
    if (key.startsWith('remote.') && key.endsWith('.promisor')) {
      return `config entry ${entry.key} enables lazy fetching`;
    }
  }
  return null;
}

/**
 * How many metadata entries the layer-2 walk will visit. The budget excludes
 * loose-object payload files: `objects/<2 hex>/` legitimately accumulates a few
 * files per turn forever, and is payload rather than metadata.
 */
const MAX_METADATA_ENTRIES = 10_000;

/** Whether `rel` is a loose-object payload file (`objects/<2 hex>/<name>`). */
function isLooseObjectPayload(rel: string): boolean {
  const parts = rel.split('/');
  return parts.length === 3 && parts[0] === 'objects' && /^[0-9a-f]{2}$/.test(parts[1] ?? '');
}

/**
 * The layer-2 walk: any symlink anywhere under the git dir, and any
 * non-directory entry with more than one hard link, is a refusal. A symlinked
 * `refs/heads`, `objects`, `logs`, `info` or `reftable` redirects refs and
 * object reads into the world while every entry-level check still passes; a
 * hardlinked `HEAD` or branch ref stays agent-writable through its world alias.
 */
async function treeRefusal(gitDir: string): Promise<string | null> {
  let counted = 0;
  const visit = async (abs: string, rel: string): Promise<string | null> => {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(abs, entry.name);
      const info = await lstat(childAbs);
      if (info.isSymbolicLink()) return `${childRel} is a symlink`;
      if (!info.isDirectory() && info.nlink > 1) {
        return `${childRel} has ${info.nlink} hard links`;
      }
      if (!isLooseObjectPayload(childRel)) {
        counted += 1;
        if (counted > MAX_METADATA_ENTRIES) {
          return `the metadata tree exceeds ${MAX_METADATA_ENTRIES} entries`;
        }
      }
      if (info.isDirectory()) {
        const nested = await visit(childAbs, childRel);
        if (nested !== null) return nested;
      }
    }
    return null;
  };
  return visit(gitDir, '');
}

/** The layer-2 metadata battery, or null when the git dir's shape is trusted. */
async function metadataRefusal(gitDir: string): Promise<string | null> {
  const config = await lstatOrNull(join(gitDir, 'config'));
  if (config === null || !config.isFile()) return 'config is not a regular file';
  for (const rel of [
    'config.worktree', 'objects/info/alternates', 'info/grafts', 'shallow',
  ]) {
    if (await lstatOrNull(join(gitDir, rel)) !== null) return `${rel} is present`;
  }
  const hooks = await lstatOrNull(join(gitDir, 'hooks'));
  if (hooks !== null) {
    if (!hooks.isDirectory()) return 'hooks is not a real directory';
    for (const entry of await readdir(join(gitDir, 'hooks'), { withFileTypes: true })) {
      if (!entry.name.endsWith('.sample')) return `hooks/${entry.name} is not a sample hook`;
      const info = await lstat(join(gitDir, 'hooks', entry.name));
      if (!info.isFile()) return `hooks/${entry.name} is not a regular file`;
    }
  }
  const head = await lstatOrNull(join(gitDir, 'HEAD'));
  if (head === null || !head.isFile()) return 'HEAD is not a regular file';
  const refs = await lstatOrNull(join(gitDir, 'refs'));
  if (refs !== null && !refs.isDirectory()) return 'refs is not a real directory';
  const packed = await lstatOrNull(join(gitDir, 'packed-refs'));
  if (packed !== null && !packed.isFile()) return 'packed-refs is not a regular file';
  return treeRefusal(gitDir);
}

/**
 * Refuses a world that is not a dedicated directory (kernel.md §7, the first
 * safeguard): `$HOME` and broad roots are what turns a commit-per-turn kernel
 * into the documented 200 GB incident.
 *
 * `$HOME` is resolved before the comparison: if the home is itself behind a
 * symlink, comparing a real world path against the unresolved `homedir()` string
 * would let a symlink to the real home through — the safeguard is about the
 * directory the kernel would really commit, on both sides of the comparison.
 *
 * @throws UnsafeWorldPathError.
 */
export async function assertDedicated(path: string): Promise<string> {
  const depth = path.split(sep).filter((part) => part !== '').length;
  const home = await realpathOrSelf(resolve(homedir()));
  if (path === home || depth < 2) throw new UnsafeWorldPathError(path);
  return path;
}

/**
 * The canonical path of a world directory, checked as such. The check runs on
 * the *resolved* path: a symlink to `$HOME` is a way to be handed `$HOME`
 * without spelling it, and the safeguard is about the directory the kernel
 * would really commit, not about the string it was given.
 *
 * @throws UnsafeWorldPathError when the resolved path is `$HOME` or a broad root.
 * @throws WorldNotARepoError when the directory does not exist.
 */
export async function canonicalWorldPath(dir: string): Promise<string> {
  const given = resolve(dir);
  let path: string;
  try {
    path = await realpath(given);
  } catch (err) {
    // A world directory that is not there is a configuration fact, not a crash:
    // it is reported in this module's family rather than as a raw fs error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new WorldNotARepoError(given);
    throw err;
  }
  return assertDedicated(path);
}

/**
 * Verifies that `gitDir` is still the kernel-owned git dir for the world at
 * `worldPath`: the config comes wholly from the git dir's own `config`, the
 * metadata tree is free of symlinks and multi-linked files, and git itself
 * confirms the pair (`core.worktree` names this root, and
 * `rev-parse --absolute-git-dir` resolves back here).
 *
 * Runs on `runGit` alone — no repository object exists yet at this point — and
 * every refusal carries the sanitizing migration recipe.
 *
 * @throws WorldNotARepoError when any of the three layers refuses.
 */
export async function verifyGitDirTrust(worldPath: string, gitDir: string): Promise<void> {
  // Layer 1 — the config scan. No `-c` flags on this call: a command-line
  // config would surface with a `command line` origin and trip the origin rule
  // below. A nonzero exit (a cyclic include, an unreadable config) is a
  // refusal, never an empty config.
  let scan: string;
  try {
    scan = await runGit(worldPath, ['--git-dir', gitDir, 'config', '--list', '--show-origin', '-z']);
  } catch {
    throw new WorldNotARepoError(
      worldPath,
      `git could not read the configuration of ${gitDir}. ${migrationNote(worldPath, gitDir)}`);
  }
  const entries = parseConfigScan(scan);
  const configFault = configRefusal(entries, gitDir);
  if (configFault !== null) {
    throw new WorldNotARepoError(worldPath, `${configFault}. ${migrationNote(worldPath, gitDir)}`);
  }

  // Layer 2 — the metadata battery.
  const metadataFault = await metadataRefusal(gitDir);
  if (metadataFault !== null) {
    throw new WorldNotARepoError(worldPath, `${metadataFault}. ${migrationNote(worldPath, gitDir)}`);
  }

  // Layer 3 — the pair check. `core.worktree` must be absolute: a relative
  // value resolves against the git dir, so it would false-accept or
  // false-reject depending on where the pair happens to be. A duplicated key
  // takes its last value, which is the one git itself would use.
  const worktree = entries
    .filter((entry) => entry.key.toLowerCase() === 'core.worktree')
    .at(-1)?.value;
  if (worktree === undefined || worktree === '') {
    throw new WorldNotARepoError(
      worldPath,
      `core.worktree is not set in ${gitDir}/config. ${migrationNote(worldPath, gitDir)}`);
  }
  if (!isAbsolute(worktree)) {
    throw new WorldNotARepoError(
      worldPath, `core.worktree ${worktree} is relative; it must be absolute. `
        + migrationNote(worldPath, gitDir));
  }
  let recordedWorktree: string;
  try {
    recordedWorktree = await realpath(worktree);
  } catch {
    throw new WorldNotARepoError(
      worldPath, `core.worktree ${worktree} does not resolve to a directory. `
        + migrationNote(worldPath, gitDir));
  }
  if (recordedWorktree !== worldPath) {
    throw new WorldNotARepoError(
      worldPath, `core.worktree resolves to ${recordedWorktree}, not the world root. `
        + migrationNote(worldPath, gitDir));
  }
  let absoluteGitDir: string;
  try {
    absoluteGitDir = (await runGit(
      worldPath, ['--git-dir', gitDir, '--work-tree', worldPath, 'rev-parse', '--absolute-git-dir'],
    )).trim();
  } catch {
    throw new WorldNotARepoError(
      worldPath, `git could not confirm the git directory for ${gitDir}. `
        + migrationNote(worldPath, gitDir));
  }
  if (await realpathOrSelf(absoluteGitDir) !== gitDir) {
    throw new WorldNotARepoError(
      worldPath, `git resolves the pair to ${absoluteGitDir}, not ${gitDir}. `
        + migrationNote(worldPath, gitDir));
  }
}
