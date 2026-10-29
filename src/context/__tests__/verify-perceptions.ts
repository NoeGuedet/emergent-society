import { canonicalizeJson } from '../../journal/index.js';
import { eventKey, resolveStored, toJson } from '../artifacts.js';
import type { VerifiedEventIndex } from '../artifacts.js';
import { RENDER_POLICY, presentWorld } from '../diff.js';
import { createBoundaryRegistry } from '../events.js';
import { sourceOf } from '../loader.js';
import type { VerifiedEvent, VerifiedEvents } from '../loader.js';
import { isRecord } from '../validate.js';
import type { GateScope } from '../../node/gate.js';
import type { WorldRepo, WorldRange } from '../../node/world.js';
import type { Stored, WorldPerception } from '../contracts.js';

/**
 * The perception re-derivation the retired `rederivePlans` carried (C1.4d T5).
 *
 * Plans left the local log, so the plan↔wire reconstruction is gone; the
 * perception half does not depend on plans and survives here as a test helper
 * used by the offline-join tests. It re-renders every recorded
 * `world/perception` from git and compares canonically, including the exact
 * Git version, refusing a divergence rather than promising equality.
 *
 * The module-private set it needs moved with the function rather than widening
 * the assembler's API: `PerceptionPayload`, `canonicalText`, the
 * perception-only `replayData`/`recordedPerception`, and `presentWorld` from
 * `./diff.js`.
 */

/** The resolved wrapper of a recorded `world/perception` fact. */
type PerceptionPayload = {
  readonly turn: number; readonly range: WorldRange; readonly value: Stored<WorldPerception>;
};

const REPLAY_REGISTRY = createBoundaryRegistry();
const REPLAY_SIGNAL = new AbortController().signal;

/** The canonical JSON text of a value — the comparison `canonicalBytes` hashes. */
function canonicalText(value: unknown): string {
  return canonicalizeJson(toJson(value));
}

/**
 * The replay's own data guard. Chain verification proves bytes, not shapes: a
 * chain-valid fact can carry a null/malformed payload, and the fold's typed
 * handlers would classify it only AFTER this utility has already dereferenced
 * it. Refuse it here with the replay's own vocabulary instead of a TypeError.
 */
function replayData(event: VerifiedEvent, what: string): Record<string, unknown> {
  if (!isRecord(event.data)) {
    const at = sourceOf(event);
    throw new Error(`replay: ${what} data at ${at.seq}:${at.hash} is not an object`);
  }
  return event.data;
}

/**
 * Resolves a recorded `world/perception` through the same T1 registry the gate
 * and fold use (so the wrapper/value range equality is enforced), refusing a
 * renderer policy outside the accepted set with an explicit message before
 * shape validation.
 */
function recordedPerception(
  events: VerifiedEvents | VerifiedEventIndex, data: PerceptionPayload,
): WorldPerception {
  const scope: GateScope = {
    phase: 'turn', turn: data.turn, signal: REPLAY_SIGNAL, lookup: () => null,
  };
  const validate = (raw: unknown): WorldPerception => {
    if (isRecord(raw)) {
      const renderer = raw['renderer'];
      if (isRecord(renderer) && renderer['policy'] !== 'commit-patches-v1'
        && renderer['policy'] !== 'commit-patches-v2') {
        throw new Error(
          `replay: recorded perception renderer policy ${JSON.stringify(renderer['policy'])}`
          + ' is not one of commit-patches-v1 | commit-patches-v2');
      }
    }
    const wrapped = REPLAY_REGISTRY['world/perception'](
      { turn: data.turn, range: data.range, value: { kind: 'inline', value: raw } }, scope,
    ) as unknown as { value: { value: WorldPerception } };
    return wrapped.value.value;
  };
  return resolveStored(events, data.value, validate);
}

/**
 * Recomputes a recorded perception from the world and compares it canonically.
 * The recorded `uid` is fed to the renderer and compared, never re-derived; a
 * differing exact Git version and a differing rendered value both fail
 * reconstruction explicitly. Missing Git objects propagate as explicit errors.
 *
 * A v1 record (the pre-v2 oldest-first budgeting) validates and replays its
 * recorded bytes, but the current renderer re-derives newest-first, so a byte
 * comparison is impossible: for v1 only the exact Git version is checked
 * against the host's and the re-derivation is skipped.
 */
async function verifyPerception(
  events: VerifiedEvents | VerifiedEventIndex, world: WorldRepo, event: VerifiedEvent,
): Promise<void> {
  const data = replayData(event, 'world/perception') as unknown as PerceptionPayload;
  const recorded = recordedPerception(events, data);
  if (recorded.renderer.policy !== RENDER_POLICY) {
    const hostVersion = await world.gitVersion();
    if (recorded.renderer.gitVersion !== hostVersion) {
      throw new Error(
        `replay: recorded Git version ${JSON.stringify(recorded.renderer.gitVersion)}`
        + ` differs from the host's ${JSON.stringify(hostVersion)}`);
    }
    return;
  }
  const rederived = await presentWorld(
    world, recorded.uid, recorded.range, recorded.maxBytes, recorded.maxCommits,
  );
  if (recorded.renderer.gitVersion !== rederived.renderer.gitVersion) {
    throw new Error(
      `replay: recorded Git version ${JSON.stringify(recorded.renderer.gitVersion)}`
      + ` differs from the host's ${JSON.stringify(rederived.renderer.gitVersion)}`);
  }
  if (canonicalText(recorded) !== canonicalText(rederived)) {
    const at = sourceOf(event);
    throw new Error(
      `replay: the world perception recorded at ${at.seq}:${at.hash}`
      + ' does not match the perception rederived from the world');
  }
}

/**
 * Re-verifies every recorded `world/perception` in `events` against the world,
 * in order, through the observed prefix only: an event that has not yet been
 * reached cannot resolve a receipt, so a perception can never be verified
 * against a future fact.
 */
export async function verifyPerceptions(
  world: WorldRepo, events: VerifiedEvents,
): Promise<void> {
  const prefix = new Map<string, VerifiedEvent>();
  for (const event of events) {
    prefix.set(eventKey(event.raw), event);
    if (event.type === 'world/perception') await verifyPerception(prefix, world, event);
  }
}
