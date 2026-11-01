import { canonicalBytes } from '../context/artifacts.js';
import { substrateText } from '../context/assembler.js';
import { MAX_COMPACTION_SOURCES } from '../context/groups.js';
import type { AgentConfig } from '../context/contracts.js';
import { DIRECTION_MAX_BYTES } from './direction.js';
import { MAX_CAPTURE_BYTES } from './gate.js';

/**
 * The identity budget (plan §0.5) — the one derived physics bound on a node's
 * identity block.
 *
 * A node's identity is `heading + charter + the kernel's identity sentence +
 * model`, and the model IS identity: the measured block aligns the bound with
 * the arbitration. The block is measured **in the wire plan's own units** — the
 * canonical JSON-escaped bytes the runtime's ceiling actually counts, because a
 * raw-text bound mis-measures escaped strings. All of it stays **strictly
 * below** the budget:
 *
 *   budget = min(max(C − W, IDENTITY_FLOOR), C)
 *
 *   C = min(MAX_CAPTURE_BYTES, config.policy.maxRequestBytes)   (the ceiling)
 *   W = max(compactAfterBytes,
 *           (keepRecentGroups × maxCallsPerResponse × maxToolResultBytes
 *            + keepRecentGroups × maxAssistantBytes) × ESCAPE_FACTOR)
 *       + the tool offering + the substrate block + the direction
 *       + PLAN_MARGIN                                             (the reserve)
 *
 * `compactAfterBytes` is already in canonical units (compaction triggers on
 * `canonicalMessagesBytes(history) >= compactAfterBytes`, so a history just
 * below it is under the threshold verbatim) and therefore takes **no** escape
 * factor; the caps term is raw decoded-text caps and takes `ESCAPE_FACTOR = 6`
 * (the JSON-escaping worst case for control characters). The three constants,
 * the reserve and the budget are exported so every seam and every test computes
 * the bound instead of restating it.
 *
 * The guarantee is **nominal, not worst-case**: the retained conversation also
 * carries tool-call arguments (`maxToolArgumentBytes` per call), the open turn
 * is never compacted, and a compaction selection refusal, the compaction
 * notice, retained perception groups and a policy whose `keepRecentGroups`
 * outgrows the factory-sized receipts are documented residuals. No absolute
 * sendability is claimed. Under the stated premises — the residual overhead
 * `O` satisfies `O ≤ PLAN_MARGIN`, and the plan's canonical bytes dominate the
 * wire's — an identity strictly below the budget composes with the nominal
 * bound under the ceiling; in the capped and degenerate bands the excess is
 * **policy-owned** (a config may always set budgets that wedge it).
 *
 * The check lives at exactly three admission seams — the START composition
 * (S5), the spawn-side config composition, and `update_self`'s renew — and
 * NEVER inside `validateAgentConfig`: the fold re-runs that validator over
 * every journaled config on every replay, so hardening it would poison the
 * replay of every existing home (the journaled-configs-win invariant). The
 * budget is admission-only.
 */

/**
 * The nominal minimum identity budget when the ceiling has room. The factory
 * policy's reserve (≈ 97.5 MiB + the fixed terms) exceeds the 32 MiB ceiling,
 * so the factory budget equals this floor.
 */
export const IDENTITY_FLOOR = 256 * 1024;

/**
 * The JSON-escaping worst case for control characters: every raw byte of the
 * caps term may serialize as a six-byte `\u00XX` escape.
 */
export const ESCAPE_FACTOR = 6;

/** The factory policy's `keepRecentGroups`, the plan's receipts accounting base. */
export const FACTORY_KEEP_RECENT_GROUPS = 8;

/**
 * The nominal canonical size of one compaction `Source` receipt
 * (`{"hash":"…64 hex…","seq":N}`): the §0.5 accounting figure.
 */
export const SOURCE_RECEIPT_BYTES = 96;

/**
 * The slack beside the receipts: the per-message sources, the plan metadata
 * (the config's own receipt, the tools/state/shadow hashes, the section
 * list) and the extra decimal digits of a maximal `seq`.
 */
export const PLAN_MARGIN_SLACK_BYTES = 1 * 1024 * 1024;

/**
 * The plan-overhead margin: the compaction receipts a factory-policy history
 * can retain — `keepRecentGroups × MAX_COMPACTION_SOURCES × ~96 canonical
 * bytes` in `sections.history.sources`, plus the per-message sources and the
 * plan metadata (≈ 3 MiB + slack). The receipts scale with the config's own
 * `keepRecentGroups`, which has no validator ceiling: a journaled policy with
 * a much larger value can outgrow this factory-sized margin — a policy-owned
 * residual stated beside the argument- and open-turn terms.
 */
export const PLAN_MARGIN =
  FACTORY_KEEP_RECENT_GROUPS * MAX_COMPACTION_SOURCES * SOURCE_RECEIPT_BYTES
  + PLAN_MARGIN_SLACK_BYTES;

/** A sendability refusal: the identity block is at or above the derived budget. */
export class IdentityBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityBudgetError';
  }
}

/** The binding request ceiling: the adapter refuses the wire here too. */
export function effectiveCeiling(config: AgentConfig): number {
  return Math.min(MAX_CAPTURE_BYTES, config.policy.maxRequestBytes);
}

/** The tool offering's canonical size — the same sorted `tools` block the plan sends. */
function offeringBytes(config: AgentConfig): number {
  const sorted = [...config.tools].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return canonicalBytes(sorted).length;
}

/** The substrate block's canonical size; absent catalog, no block, no bytes. */
function substrateBytes(models: readonly string[] | undefined): number {
  return models === undefined ? 0 : canonicalBytes(substrateText(models)).length;
}

/**
 * `W = worstCaseCanonical(config, models)` — the plan's nominal serialized
 * bound of the retained history and the fixed blocks, a function of the config
 * AND the catalog (the offering comes from `config.tools`, the substrate from
 * `models`). The plan aliases this function `reserve`.
 */
export function reserve(config: AgentConfig, models?: readonly string[]): number {
  const policy = config.policy;
  const history = Math.max(
    policy.compactAfterBytes,
    (policy.keepRecentGroups * policy.maxCallsPerResponse * policy.maxToolResultBytes
      + policy.keepRecentGroups * policy.maxAssistantBytes) * ESCAPE_FACTOR,
  );
  return history + offeringBytes(config) + substrateBytes(models)
    + DIRECTION_MAX_BYTES + PLAN_MARGIN;
}

/**
 * The derived identity budget:
 * `min(max(C − reserve, IDENTITY_FLOOR), C)`. The final `min(…, C)` clamp is
 * what keeps the budget ≤ the ceiling in the degenerate band: when `C ≤
 * IDENTITY_FLOOR` the budget collapses to `C`, and identities at or above `C`
 * are refused at the seam.
 */
export function identityBudget(config: AgentConfig, models?: readonly string[]): number {
  const ceiling = effectiveCeiling(config);
  return Math.min(Math.max(ceiling - reserve(config, models), IDENTITY_FLOOR), ceiling);
}

/**
 * The measured identity block in canonical bytes: heading + charter + model.
 * The kernel's identity sentence lives INSIDE the charter (boot, spawn and
 * renew stamp it), so measuring the charter measures the sentence too; the
 * model is its own wire field and counts as identity (§0.7).
 */
export function identityBytes(config: AgentConfig): number {
  return canonicalBytes(config.heading).length
    + canonicalBytes(config.charter).length
    + canonicalBytes(config.model).length;
}

/** The bounded, path-free sendability refusal: it names the measurement and the bound. */
function sendabilityMessage(
  identity: number, budget: number, ceiling: number, reserved: number,
): string {
  return `the identity is ${identity} canonical bytes; the sendability budget is`
    + ` ${budget} bytes (request ceiling ${ceiling} minus a ${reserved}-byte reserve,`
    + ` floored at ${IDENTITY_FLOOR})`;
}

/**
 * Refuses an identity block at or above the derived budget with the bounded
 * sendability message. Call this at an admission seam, never in a validator
 * that replay re-runs.
 *
 * @throws IdentityBudgetError when `identityBytes(config) >= identityBudget(config, models)`.
 */
export function assertSendableIdentity(
  config: AgentConfig, models?: readonly string[],
): void {
  const budget = identityBudget(config, models);
  const identity = identityBytes(config);
  if (identity >= budget) {
    throw new IdentityBudgetError(
      sendabilityMessage(identity, budget, effectiveCeiling(config), reserve(config, models)),
    );
  }
}
