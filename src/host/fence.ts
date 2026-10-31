import { lstat } from 'node:fs/promises';
import type { FenceOutcome, FencePort } from '../node/index.js';
import { singleLine } from '../text.js';
import {
  ensureLeaf, freezeSet, LIMITS, listLeaves, nodeLeaf, thawSet,
} from './cgroups.js';
import type { HostLog } from './observe.js';

/**
 * The production commit fence: the host's cgroup port, built from the cell
 * root and the node's uid and injected into `NodeDriver.open`.
 *
 * The commit's critical section (walk → add → write-tree → commit-tree →
 * update-ref) runs with every confined child of this cell frozen: the node's
 * own leaf `node-<uid>` — created first if it does not exist, because an idle
 * cell still commits before any shell has run — plus every existing `run-*`
 * leaf. Enumeration is read-only (`listLeaves`); a leaf that vanishes between
 * the list and the freeze write is gone, not a failure, and a leaf that
 * vanishes during the freeze wait is dropped from the wait rather than held to
 * the deadline.
 *
 * The port never throws and never leaves a caller frozen. `acquire` maps every
 * failure to `freeze-failed` with a bounded detail after thawing what it froze;
 * `release` thaws the set and is idempotent. Each acquire emits exactly one
 * bounded `host/fence` line (`state`, `leaves`, `ms`) so an operator and the
 * acceptance smoke can observe engagement — never a path.
 */

/** The bounded detail budget for a freeze-failure line. */
const MAX_FENCE_DETAIL = 120;

/** ENOENT/ENOTDIR on a leaf write: the leaf is gone, not a timeout. */
function isVanish(reason: string): boolean {
  return reason.includes('ENOENT') || reason.includes('ENOTDIR');
}

function describeFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error && err.name !== '' ? err.name : 'fence-failed';
}

/**
 * Builds the fence port for one cell root.
 *
 * The root is the attached cell's `<anchor>/es-<hash>`; `uid` names the node
 * leaf. The port keeps no long-lived state beyond the leaves of the current
 * acquire, so a `release` after a failed acquire is still safe.
 */
export function createFencePort(input: {
  readonly root: string;
  readonly uid: string;
  readonly log: HostLog;
}): FencePort {
  let frozen: readonly string[] = [];
  const detail = (text: string): string => singleLine(text, MAX_FENCE_DETAIL);

  /**
   * Every existing Run leaf plus the node leaf (created if absent). The
   * enumeration runs first: a readdir/lstat failure other than ENOENT/ENOTDIR
   * must refuse before any leaf is frozen, and a missing root still lists as
   * empty so the node leaf can be created.
   */
  async function currentLeaves(): Promise<string[]> {
    const runs = await listLeaves(input.root);
    const node = nodeLeaf(input.root, input.uid);
    await ensureLeaf(node);
    return [node, ...runs];
  }

  /**
   * The leaves that still exist; a leaf that provably vanished (ENOENT/
   * ENOTDIR) is dropped, never fenced. Any other lstat failure (EACCES, EIO,
   * ELOOP, a transient cgroupfs read error) is NOT evidence the leaf is gone:
   * it is a freeze failure, so the acquire refuses and thaws rather than
   * reporting `fenced: true` with that Run un-frozen. The first enumeration
   * applies the same rule inside `listLeaves`.
   */
  async function existing(leaves: readonly string[]): Promise<string[]> {
    const live: string[] = [];
    for (const leaf of leaves) {
      try {
        await lstat(leaf);
        live.push(leaf);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw err;
      }
    }
    return live;
  }

  return {
    async acquire(): Promise<FenceOutcome> {
      const started = Date.now();
      let leaves: string[] = [];
      try {
        leaves = await currentLeaves();
        frozen = leaves;
        const polled = {
          deadlineMs: LIMITS.freezeDeadlineMs, pollMs: LIMITS.freezePollMs,
        };
        let verdict = await freezeSet(leaves, polled);
        if (!verdict.ok && isVanish(verdict.reason)) {
          // One retry on a vanished leaf: RE-ENUMERATE (not filter the stale
          // list) so a leaf created in the window is included and one that
          // vanished is dropped. A leaf that vanished is "gone", never a
          // timeout; an unstattable one is a freeze failure (existing()).
          // The node's own leaf may not vanish under a live cell — if it did,
          // the tree was detached and a subset freeze would not fence the shell.
          const node = nodeLeaf(input.root, input.uid);
          const live = await existing([node, ...await listLeaves(input.root)]);
          const changed = live.length !== leaves.length
            || live.some((leaf) => !leaves.includes(leaf));
          if (!live.includes(node)) {
            verdict = { ok: false, reason: 'node-leaf-vanished' };
          } else if (changed) {
            leaves = live;
            frozen = leaves;
            verdict = await freezeSet(leaves, polled);
          }
        }
        if (!verdict.ok) {
          await thawSet(leaves);
          input.log.emit('host/fence', {
            state: 'freeze-failed', leaves: leaves.length, ms: Date.now() - started,
          });
          return { fenced: false, reason: 'freeze-failed', detail: detail(verdict.reason) };
        }
        input.log.emit('host/fence', {
          state: 'fenced', leaves: leaves.length, ms: Date.now() - started,
        });
        return { fenced: true, leaves: leaves.length };
      } catch (err) {
        await thawSet(leaves);
        input.log.emit('host/fence', {
          state: 'freeze-failed', leaves: leaves.length, ms: Date.now() - started,
        });
        return { fenced: false, reason: 'freeze-failed', detail: detail(describeFailure(err)) };
      }
    },

    async release(): Promise<void> {
      const leaves = frozen;
      frozen = [];
      if (leaves.length === 0) return;
      // thawSet is best-effort by contract: a removed leaf is already safe.
      await thawSet(leaves);
    },
  };
}
