import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeUid } from '../../journal/index.js';
import { NodeError } from '../errors.js';
import { realpathOrSelf } from '../world.js';

/**
 * The filesystem policy of the persistent shell (kernel.md §7, C1.4c): the
 * grants the vendored Landlock launcher applies, the env the sandbox owns, and
 * the functional probe that proves the ruleset bites before a command runs.
 *
 * The policy is a strict allowlist built kernel-side from the world path, the
 * cell home and the node uid only — never from the agent environment or world
 * content: the world and a per-node scratch leaf are writable, the merged-usr
 * system dirs are read+execute, a narrow `/etc` file list and `/proc` are read,
 * and five device files are granted individually. `/tmp`, `/home`, `/var`, the
 * project checkout and `<home>` itself are never granted.
 *
 * Landlock rules are allow-only, so a launcher inside a granted root would be
 * agent-writable and could rewrite the very binary that applies the rules:
 * that invariant is enforced here, as are the scratch leaf's realness and its
 * `0700` mode. Every refusal is a `SandboxUnavailableError` — a partial policy
 * is never returned, and the runtime turns the error into `spawn-failed`,
 * never a silent unconfined shell. No network rights are handled by the
 * launcher (egress stays open by decision); the signal and abstract-socket
 * scopes are the launcher's own choice, not this policy's.
 */

/** The built policy: argv for the probe and the spawn, plus the env the sandbox owns. */
export type SandboxSpec = {
  readonly launcherPath: string;
  readonly probeArgv: readonly string[];
  readonly spawnArgv: readonly string[];
  readonly env: { readonly HOME: string; readonly TMPDIR: string; readonly HISTFILE: '/dev/null' };
  readonly scratchDir: string;
};

export type SandboxStatus =
  | { readonly mode: 'off' }
  | { readonly mode: 'landlock'; readonly abi: number; readonly enforcement: 'full' | 'partial' };

/** The message always carries the bounded launcher stderr/builder detail. */
export class SandboxUnavailableError extends NodeError {}

type GrantFlag = '--ro' | '--rox' | '--rw';

type Grant = { readonly flag: GrantFlag; readonly path: string };

/** The merged-usr system dirs, in the plan's fixed order (`/usr` first). */
const SYSTEM_ROOTS: readonly string[] = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32'];

/**
 * The narrow `/etc` read set. `resolv.conf`'s realpath lands on the systemd
 * resolver under `/run`; `localtime`'s lands under the already-granted `/usr`,
 * where the drop rule discards it. `bash.bashrc` silences the cosmetic warning
 * an agent-run `bash -c` prints when the file is unreadable.
 */
const ETC_FILES: readonly string[] = [
  'ld.so.cache', 'passwd', 'group', 'nsswitch.conf', 'hosts', 'resolv.conf', 'localtime',
  'bash.bashrc',
];

/**
 * Device files, granted one by one. `/dev/pts` and `/dev/ptmx` are deliberately
 * absent: inherited stdio fds are exempt from Landlock, and granting the
 * directory would allow cross-terminal injection.
 */
const DEVICES: readonly (readonly [GrantFlag, string])[] = [
  ['--rw', '/dev/null'],
  ['--rw', '/dev/tty'],
  ['--ro', '/dev/zero'],
  ['--ro', '/dev/random'],
  ['--ro', '/dev/urandom'],
];

/**
 * The launcher shipped with the checkout. Three levels up from
 * `src/node/tools/`; `fileURLToPath` turns the URL into the plain string
 * `execFile`/`pty.spawn` require.
 */
const DEFAULT_LAUNCHER = fileURLToPath(
  new URL('../../../native/es-landlock/es-landlock', import.meta.url),
);

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER = 64 * 1024;
/** The bound on a diagnostic carried in a `SandboxUnavailableError` message. */
const MAX_DETAIL_CHARS = 4096;

/** True when `path` is `root` itself or lies below it, compared by path segments. */
function isWithin(path: string, root: string): boolean {
  if (path === root) return true;
  if (root === sep) return true;
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The diagnostic form of an error message: trimmed and bounded for the runtime's `output`. */
function boundedDetail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_DETAIL_CHARS ? trimmed : trimmed.slice(0, MAX_DETAIL_CHARS);
}

/** `realpath`, or `null` when the entry is absent; any other failure is a refusal. */
async function optionalRealpath(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new SandboxUnavailableError(`could not resolve ${candidate}: ${describe(err)}`);
  }
}

/**
 * Creates the scratch leaf `<home>/tmp/<uid>` when absent and verifies it is a
 * real directory owned by the kernel uid with mode `0700`, under a real
 * `<home>/tmp` that is not group- or world-writable. An existing correct leaf
 * is reused; a symlink or a foreign-owned leaf is refused (the launcher would
 * follow it into a grant).
 */
async function prepareScratch(home: string, uid: string): Promise<string> {
  const parent = join(home, 'tmp');
  const scratchDir = join(parent, uid);

  try {
    // An explicit mode, not the ambient umask: a umask of 0002 would mint a
    // group-writable parent, which the verification below must refuse.
    await mkdir(parent, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new SandboxUnavailableError(
      `could not create the scratch parent ${parent}: ${describe(err)}`);
  }
  try {
    await mkdir(scratchDir, { mode: 0o700 });
  } catch (err) {
    // EEXIST is the reuse path: the lstat verification below judges the leaf.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new SandboxUnavailableError(
        `could not create the scratch directory ${scratchDir}: ${describe(err)}`);
    }
  }

  let parentInfo;
  try {
    parentInfo = await lstat(parent);
  } catch (err) {
    throw new SandboxUnavailableError(
      `could not inspect the scratch parent ${parent}: ${describe(err)}`);
  }
  if (!parentInfo.isDirectory()) {
    throw new SandboxUnavailableError(`the scratch parent ${parent} is not a real directory`);
  }
  if ((parentInfo.mode & 0o022) !== 0) {
    throw new SandboxUnavailableError(
      `the scratch parent ${parent} is group- or world-writable; refusing to grant it`);
  }

  let info;
  try {
    info = await lstat(scratchDir);
  } catch (err) {
    throw new SandboxUnavailableError(
      `could not inspect the scratch directory ${scratchDir}: ${describe(err)}`);
  }
  if (!info.isDirectory()) {
    throw new SandboxUnavailableError(
      `the scratch directory ${scratchDir} is not a real directory (a symlink or a file)`);
  }
  const kernelUid = process.getuid?.();
  if (kernelUid === undefined) {
    throw new SandboxUnavailableError('this platform has no kernel uid; Linux is required');
  }
  if (info.uid !== kernelUid) {
    throw new SandboxUnavailableError(
      `the scratch directory ${scratchDir} is owned by uid ${info.uid}, `
        + `not the kernel uid ${kernelUid}`);
  }
  const mode = info.mode & 0o777;
  if (mode !== 0o700) {
    throw new SandboxUnavailableError(
      `the scratch directory ${scratchDir} is mode 0${mode.toString(8)}, not 0700`);
  }
  return scratchDir;
}

/** Resolves the launcher to an existing regular file, or refuses with the build hint. */
async function resolveLauncher(requested: string): Promise<string> {
  let launcherPath: string;
  try {
    launcherPath = await realpath(resolve(requested));
  } catch (err) {
    throw new SandboxUnavailableError(
      `the Landlock launcher ${requested} is not usable: ${describe(err)}; `
        + 'run `npm run build:native` to build it');
  }
  let info;
  try {
    info = await lstat(launcherPath);
  } catch (err) {
    throw new SandboxUnavailableError(
      `could not inspect the Landlock launcher ${launcherPath}: ${describe(err)}`);
  }
  if (!info.isFile()) {
    throw new SandboxUnavailableError(
      `the Landlock launcher ${launcherPath} is not a regular file; `
        + 'run `npm run build:native` to build it');
  }
  return launcherPath;
}

/**
 * Builds the policy. Every invariant is checked before any spawn, and every
 * refusal is a `SandboxUnavailableError` — never a partial policy.
 */
export async function buildSandboxSpec(opts: {
  readonly world: string;
  readonly home: string;
  readonly uid: string;
  readonly launcherPath?: string;
}): Promise<SandboxSpec> {
  // The runtime validates the uid before constructing the sandbox; repeating it
  // here keeps the scratch leaf a single path segment by construction.
  let uid: string;
  try {
    uid = assertNodeUid(opts.uid);
  } catch (err) {
    throw new SandboxUnavailableError(
      `refusing node uid ${JSON.stringify(opts.uid)} as a scratch path segment: ${describe(err)}`);
  }

  let home: string;
  try {
    home = await realpathOrSelf(resolve(opts.home));
  } catch (err) {
    throw new SandboxUnavailableError(
      `the cell home ${opts.home} is not usable: ${describe(err)}`);
  }

  let world: string;
  try {
    world = await realpath(resolve(opts.world));
  } catch (err) {
    throw new SandboxUnavailableError(
      `the world ${opts.world} is not usable: ${describe(err)}`);
  }
  let worldInfo;
  try {
    worldInfo = await lstat(world);
  } catch (err) {
    throw new SandboxUnavailableError(`could not inspect the world ${world}: ${describe(err)}`);
  }
  if (!worldInfo.isDirectory()) {
    throw new SandboxUnavailableError(`the world ${world} is not a directory`);
  }

  // A home inside the world would be granted the world's writable rights: the
  // journal and the credential store would be inside the agent's write set.
  if (isWithin(home, world)) {
    throw new SandboxUnavailableError(
      `the cell home ${home} is inside the world ${world}; `
        + 'the shell would be granted the home itself');
  }

  const launcherPath = await resolveLauncher(
    opts.launcherPath !== undefined ? opts.launcherPath : DEFAULT_LAUNCHER,
  );
  const scratchDir = await prepareScratch(home, uid);

  const grants: Grant[] = [];
  const addGrant = (flag: GrantFlag, path: string): void => {
    // A realpath landing under an already-granted root is redundant: the
    // fixed order puts `/usr` before the merged-usr symlink targets, and the
    // zoneinfo target of `/etc/localtime` under `/usr`.
    if (grants.some((grant) => isWithin(path, grant.path))) return;
    grants.push({ flag, path });
  };

  addGrant('--rw', world);
  addGrant('--rw', scratchDir);

  for (const candidate of SYSTEM_ROOTS) {
    const real = await optionalRealpath(candidate);
    if (real !== null) addGrant('--rox', real);
  }
  for (const name of ETC_FILES) {
    const real = await optionalRealpath(join('/etc', name));
    if (real !== null) addGrant('--ro', real);
  }
  const certs = await optionalRealpath('/etc/ssl/certs');
  if (certs !== null) addGrant('--ro', certs);
  const proc = await optionalRealpath('/proc');
  if (proc !== null) addGrant('--ro', proc);
  for (const [flag, candidate] of DEVICES) {
    const real = await optionalRealpath(candidate);
    if (real !== null) addGrant(flag, real);
  }

  // The launcher runs unconfined for a few dozen instructions before
  // `restrict_self`; an agent-writable launcher would be a full escape, and the
  // probe's deny check (the launcher itself) would false-fail.
  const covering = grants.find((grant) => isWithin(launcherPath, grant.path));
  if (covering !== undefined) {
    throw new SandboxUnavailableError(
      `the Landlock launcher ${launcherPath} is inside the granted root ${covering.path}; `
        + 'the shell could rewrite it and escape the policy');
  }

  const grantArgs = grants.flatMap((grant) => [grant.flag, grant.path]);
  const probeArgv: readonly string[] = [
    '--probe',
    '--probe-deny', launcherPath,
    '--probe-rw', scratchDir,
    '--probe-rw', world,
    ...grantArgs,
  ];
  const spawnArgv: readonly string[] = [
    ...grantArgs,
    '--', '/bin/bash', '--noprofile', '--norc', '-i',
  ];
  const env: SandboxSpec['env'] = { HOME: world, TMPDIR: scratchDir, HISTFILE: '/dev/null' };

  return { launcherPath, probeArgv, spawnArgv, env, scratchDir };
}

/**
 * Runs the functional probe in a short-lived child of the launcher: write /
 * read-back / remove in both writable dirs, an exact-EACCES deny read, and the
 * ptrace pair that proves the domain restriction bites. Resolves the status or
 * throws `SandboxUnavailableError` with the bounded stderr in the message.
 * Never cached here — the terminal runtime memoizes.
 */
export async function probeSandbox(
  spec: SandboxSpec,
): Promise<{ readonly abi: number; readonly enforcement: 'full' | 'partial' }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      spec.launcherPath,
      [...spec.probeArgv],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER },
      (err, stdout, stderr) => {
        const stderrDetail = boundedDetail(stderr);
        if (err !== null) {
          const detail = stderrDetail !== '' ? stderrDetail : boundedDetail(err.message);
          reject(new SandboxUnavailableError(
            `the Landlock probe failed: ${detail !== '' ? detail : 'no diagnostic'}`));
          return;
        }
        const abi = /^abi=(\d+)$/m.exec(stdout);
        const enforcement = /^enforcement=(full|partial)$/m.exec(stdout);
        if (abi === null || enforcement === null) {
          reject(new SandboxUnavailableError(
            'the Landlock probe produced no parseable status'
              + (stderrDetail !== '' ? `: ${stderrDetail}` : '')));
          return;
        }
        resolvePromise({
          abi: Number(abi[1]),
          enforcement: enforcement[1] as 'full' | 'partial',
        });
      },
    );
  });
}
