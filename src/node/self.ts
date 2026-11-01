import { validateAgentConfig } from '../context/config.js';
import type { AgentConfig } from '../context/contracts.js';
import { composerOf, identitySentence, stripAuthoredIdentity } from './identity.js';
import { IdentityBudgetError, assertSendableIdentity } from './identity-budget.js';

/**
 * The self seam (plan §0.7): a node rewrites its own heading, charter and
 * model with `extend {verb:"update_self"}`.
 *
 * `update_self` follows the packages pattern. The new self is authored in the
 * world — the charter by `path`, a world source file mirroring `define`'s
 * vocabulary, never a second meaning for `spawn`'s inline `charter` — the
 * change is journaled as a **versioned config event** in the node-local journal
 * (the fold enforces strictly-increasing versions and a heading-surface
 * replacement), and the new identity applies **from the next assembled
 * request, possibly within the same turn** (the assembler re-reads the live
 * fold each step; the turn's dispatch and policy stay on the config captured at
 * turn start).
 *
 * `renew` reads the **live folded config**, strips any trailing identity
 * sentence from a new charter (the authored-strip pattern, any uid), re-stamps
 * the node's own sentence **preserving the composer suffix** extracted from the
 * current sentence (the own-sentence pattern), applies only the identity fields
 * the request named, bumps the version by exactly one, validates, checks the
 * derived identity budget, and returns. Capabilities — `tools`, `allowedTools`
 * and `policy` — are carried over untouched by construction: never
 * self-amplified.
 *
 * The local log is the identity history: a restart folds it, so a rewrite is
 * durable and a superseded identity is never resurrected. The dashboard does
 * not own a second copy.
 */

/** The identity fields one rewrite may set; at least one is always present. */
export type SelfUpdate = {
  readonly heading?: string;
  /** The new charter text (the executor reads it from the world `path`). */
  readonly charter?: string;
  readonly model?: string;
};

/** The kernel's self seam: rewrite this node's own identity, or refuse bounded. */
export type SelfPort = {
  renew(input: SelfUpdate): AgentConfig;
};

/** A bounded, path-free self-seam refusal the executor renders as a denied result. */
export class SelfRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfRefusedError';
  }
}

/**
 * The renewed configuration, from the current one: only the named identity
 * fields move, the version is the current version plus exactly one, and the
 * kernel owns the charter's final sentence.
 *
 * A charter rewrite strips ANY authored trailing identity sentence first (a
 * world charter may echo another node's), then stamps this node's own sentence
 * carrying the composer suffix extracted from the current charter — so a
 * spawned node's rewrite keeps `, composed by <requester>.` and a booted node's
 * rewrite keeps its bare sentence. When the request names no charter, the
 * current one is untouched.
 */
export function renewedIdentityConfig(
  current: AgentConfig, uid: string, update: SelfUpdate,
): AgentConfig {
  let charter = current.charter;
  if (update.charter !== undefined) {
    const composer = composerOf(current.charter, uid);
    charter = stripAuthoredIdentity(update.charter)
      + (composer === null ? identitySentence(uid) : identitySentence(uid, composer));
  }
  return validateAgentConfig({
    ...current,
    version: current.version + 1,
    heading: update.heading ?? current.heading,
    charter,
    model: update.model ?? current.model,
  });
}

/**
 * Builds the runtime's self port over the live fold: `current` reads the folded
 * configuration at call time (the seam re-reads it every rewrite), and
 * `models` is the operator-declared catalog the budget's substrate term needs.
 * The budget check runs at renew, **before** the executor journals anything.
 */
export function createSelfPort(
  current: () => AgentConfig | null, uid: string, models?: readonly string[],
): SelfPort {
  return {
    renew: (update) => {
      const live = current();
      if (live === null) {
        throw new SelfRefusedError('this node has no journaled configuration');
      }
      // A bad identity must be a bounded denial, never a handler fault: the
      // validator's own message (a whole-config refusal) becomes the seam's
      // refusal, and the executor clamps it for the model.
      let next: AgentConfig;
      try {
        next = renewedIdentityConfig(live, uid, update);
      } catch (err) {
        throw new SelfRefusedError(
          err instanceof Error ? err.message : 'the renewed configuration was refused');
      }
      try {
        assertSendableIdentity(next, models);
      } catch (err) {
        if (err instanceof IdentityBudgetError) throw new SelfRefusedError(err.message);
        throw err;
      }
      return next;
    },
  };
}
