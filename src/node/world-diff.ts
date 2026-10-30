import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utf8Prefix } from '../text.js';
import { GitCommandError } from './errors.js';
import { GIT_READ_TIMEOUT_MS } from './limits.js';
import {
  MAX_GIT_STDERR_BYTES, assertHash, commitExists, emptyTree, killGitTree, spawnGit, treeOf,
  type WorldIo,
} from './world-git.js';
import type { BoundedText, DiffCapture, WorldRange } from './world-types.js';

/**
 * The bounded, hermetic patch renderer: one `from-tree → to-tree` diff run
 * against an isolated bare metadata view whose object database is the world's,
 * streamed out under a decoded-byte cap.
 *
 * A free function over `WorldIo` — the repository's paths, its policy seams and
 * its cached object format — so a render can be exercised against a double
 * without constructing a repository. The process layer is `world-git.ts`; the
 * revision primitives are built on those paths and seams there too; the
 * repository that owns the policy is `world.ts`.
 *
 * The renderer deliberately never builds its argv from `io.baseArgs()`: the
 * scratch view is this call's sole git dir, and git's last-wins rule would let
 * a later `--git-dir`/`--work-tree` pair mask it. That divergence, together
 * with the `Buffer`/`TextDecoder` decoding and the SIGKILL cap policy, is why
 * `world-git.ts` exports only the spawn primitive and each streaming consumer
 * keeps its own decode/accumulate/kill loop.
 */

/**
 * The hermetic diff flag set (T4 step 5). `-c` are git global options and must
 * precede the subcommand; `-O/dev/null` is itself a diff option and must follow
 * it — the plan's prose lists it first, but git 2.43.0 rejects `-O` before the
 * subcommand ("unknown option"), so it is placed after `diff`, which is the only
 * position git accepts. The flag set is otherwise exactly the contract's.
 */
const HERMETIC_CONFIG: readonly string[] = [
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'color.ui=false',
  '-c', 'core.quotePath=true',
  '-c', 'diff.algorithm=myers',
  '-c', 'diff.renames=false',
  '-c', 'diff.submodule=short',
  '-c', 'diff.interHunkContext=0',
];

const HERMETIC_DIFF_ARGS: readonly string[] = [
  'diff', '-O/dev/null', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
  '--no-indent-heuristic', '--full-index', '--unified=3', '--inter-hunk-context=0',
  '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/',
];

/**
 * The bounded, hermetic patch of one range (T4 step 4–6): a `from-tree →
 * to-tree` diff run against an isolated bare metadata view whose object
 * database is the world's, with the exact flag/env policy that removes the
 * working-tree attributes, `.git/info/attributes`, repo-local diff drivers
 * and host `diff.orderFile` as inputs. A `null`/missing `from` uses the empty
 * tree; a missing `to` rejects. The renderer fails closed: any failure to
 * build the view or run git rejects rather than falling back to the working
 * tree. Emission is capped at `maxBytes` decoded bytes with deterministic
 * U+FFFD replacement.
 */
export async function renderDiff(
  io: WorldIo, range: WorldRange, maxBytes: number,
  timeoutMs: number = GIT_READ_TIMEOUT_MS,
): Promise<DiffCapture> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`maxBytes must be a positive integer, got ${maxBytes}`);
  }
  if (range.from !== null) await assertHash(io, 'from', range.from);
  if (range.to !== null) await assertHash(io, 'to', range.to);

  if (range.to === null) return { text: '', truncated: false, bytesRetained: 0 };
  if (range.from !== null && range.from === range.to) {
    return { text: '', truncated: false, bytesRetained: 0 };
  }

  const toTree = await treeOf(io, range.to);
  const fromTree = range.from === null
    ? await emptyTree(io)
    : (await commitExists(io, range.from)
      ? await treeOf(io, range.from)
      : await emptyTree(io));

  const scratch = await openScratchView(io);
  let result: BoundedText | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const env: Record<string, string> = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      LC_ALL: 'C',
      GIT_ATTR_SOURCE: range.to,
    };
    const args = [`--git-dir=${scratch}`, ...HERMETIC_CONFIG, ...HERMETIC_DIFF_ARGS, fromTree, toTree, '--'];
    result = await streamDiff(io, args, env, maxBytes, timeoutMs);
  } catch (err) {
    failed = true;
    failure = err;
  }
  // The scratch view is always removed, but a render failure outranks a
  // cleanup failure so the original git error is never masked by `rm`.
  try {
    await rm(scratch, { recursive: true, force: true });
  } catch (err) {
    if (!failed) {
      failed = true;
      failure = err;
    }
  }
  if (failed) throw failure;
  return result!;
}

/**
 * Creates the isolated bare metadata view: a temporary GIT_DIR whose
 * `objects/info/alternates` points at the world's object database (shared, no
 * repository copy), with no `info/attributes` and an empty config. A failure
 * here rejects, so the renderer never silently falls back to the world.
 */
async function openScratchView(io: WorldIo): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'c13-render-'));
  await mkdir(join(scratch, 'objects', 'info'), { recursive: true });
  await mkdir(join(scratch, 'refs'), { recursive: true });
  await writeFile(join(scratch, 'objects', 'info', 'alternates'), `${join(io.gitDir, 'objects')}\n`);
  // The scratch git dir is explicit (`--git-dir=`), so git derives the object
  // format from *its* config, not the world's. An empty config means "sha1"
  // and rejects a sha256 world's 64-hex ids, so the scratch view declares the
  // world's own format (validated by `format()`; no other setting is read).
  const format = await io.format();
  await writeFile(join(scratch, 'config'), format === 'sha256'
    ? '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tobjectFormat = sha256\n'
    : '');
  await writeFile(join(scratch, 'HEAD'), 'ref: refs/heads/main\n');
  return scratch;
}

/**
 * Streams one hermetic diff to at most `maxBytes` decoded UTF-8 bytes. Invalid
 * bytes become deterministic U+FFFD; hitting the cap kills the child and is
 * the only accepted truncation, while any other nonzero exit or signal is an
 * error. stderr is bounded and never the payload.
 *
 * The scratch view is this call's sole git dir (`--git-dir=`), so the pair is
 * deliberately absent here: git's last-wins rule would let a `--git-dir` after
 * the scratch one mask it. Only the two defense-in-depth overrides are
 * prepended.
 */
function streamDiff(
  io: WorldIo, args: readonly string[], env: Record<string, string>, maxBytes: number,
  timeoutMs: number,
): Promise<BoundedText> {
  return new Promise<BoundedText>((resolvePromise, rejectPromise) => {
    const child = spawnGit([
      '-c', 'log.showSignature=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { cwd: io.path, env });
    const decoder = new TextDecoder('utf-8');
    let text = '';
    let bytes = 0;
    let truncated = false;
    let capped = false;
    let timedOut = false;
    let stderr = Buffer.alloc(0);
    // The streaming read is bounded like every other git child: a slow render
    // is a typed `timeout` failure, never a handler hang. `spawnGit` starts
    // git in its own group, so the kill also reaps a helper that inherited the
    // pipes (otherwise the close would never fire).
    const deadline = setTimeout(() => {
      timedOut = true;
      killGitTree(child);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (capped) return;
      const decoded = decoder.decode(chunk, { stream: true });
      const prefix = utf8Prefix(decoded, maxBytes - bytes);
      text += prefix.text;
      bytes += prefix.bytes;
      if (prefix.text.length < decoded.length) {
        capped = true;
        truncated = true;
        killGitTree(child);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const room = MAX_GIT_STDERR_BYTES - stderr.length;
      if (room > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, room)]);
    });
    child.on('error', (err) => {
      clearTimeout(deadline);
      if (!capped) {
        rejectPromise(new GitCommandError(args, null, String(err), { kind: 'spawn' }));
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      if (capped) {
        resolvePromise({ text, truncated: true, bytesRetained: bytes });
        return;
      }
      // Flush the streaming decoder: a truncated input sequence becomes its
      // deterministic U+FFFD, and the tail is bounded like the rest.
      const tail = decoder.decode();
      if (tail !== '') {
        const prefix = utf8Prefix(tail, maxBytes - bytes);
        text += prefix.text;
        bytes += prefix.bytes;
        if (prefix.text.length < tail.length) truncated = true;
      }
      if (timedOut) {
        rejectPromise(new GitCommandError(
          args, code ?? null, stderr.toString('utf8'), { kind: 'timeout' },
        ));
        return;
      }
      if (signal !== null || code !== 0) {
        rejectPromise(new GitCommandError(
          args, code ?? null, stderr.toString('utf8'), { kind: 'exit' },
        ));
        return;
      }
      resolvePromise({ text, truncated, bytesRetained: bytes });
    });
  });
}
