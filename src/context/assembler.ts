import { canonicalizeJson } from '../journal/index.js';
import { sha256HexOf } from '../journal/canon.js';
import { canonicalBytes, resolveStored, toJson } from './artifacts.js';
import { RENDER_POLICY, presentWorld } from './diff.js';
import { createBoundaryRegistry, validateRequestPlan } from './events.js';
import { ContextFold } from './fold.js';
import { sourceOf } from './loader.js';
import type { GateScope } from '../node/gate.js';
import type { WorldRepo, WorldRange } from '../node/world.js';
import type { VerifiedEvent, VerifiedEvents } from './loader.js';
import type {
  ChatMessage, PlanSection, ProjectionState, RequestId, RequestPlan, Source, Stored, ToolSchema,
  WorldPerception,
} from './contracts.js';

/**
 * The pure request assembler (kernel.md §4).
 *
 * `assemble` turns a folded `ProjectionState` into the one canonical plan a
 * turn will send. It is a pure function: it performs no I/O, appends no journal
 * fact and measures no captured size. The trusted runtime — not this module —
 * measures `canonicalBytes(plan)` against the capture ceiling and journals
 * `request/plan` or `request/refused`; a plan is refused here only for a state
 * that cannot be assembled at all.
 *
 * The offering is the config's tools sorted by UTF-16 code unit (never
 * `localeCompare`, never the config's own order), the same sorted value the
 * serializer hashes and emits. `stateHash` covers exactly the canonical
 * `{config, surface, open, recovery}` — capturing a plan artifact before
 * `request/plan` cannot change this plan's own rederived hash.
 */

/** The input of one assembly: the logical request and the state it is built from. */
export type AssembleInput = { readonly id: RequestId; readonly state: ProjectionState };

function refuse(message: string): never {
  throw new Error(`cannot assemble: ${message}`);
}

/** UTF-16 code-unit order, the same comparison the serializer's hash uses. */
function byName(a: ToolSchema, b: ToolSchema): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Deduplicated, receipt-ordered provenance: the same discipline the fold and surface use. */
function sortUnique(sources: readonly Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const source of sources) {
    const key = `${source.seq}:${source.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  out.sort((a, b) => (a.seq - b.seq) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return out;
}

function sortedTools(tools: readonly ToolSchema[]): ToolSchema[] {
  const sorted = [...tools].sort(byName);
  const seen = new Set<string>();
  for (const tool of sorted) {
    if (seen.has(tool.name)) refuse(`duplicate tool name ${JSON.stringify(tool.name)}`);
    seen.add(tool.name);
  }
  return sorted;
}

export function assemble(input: AssembleInput): RequestPlan {
  const state = input.state;
  const config = state.config;
  if (config === null) refuse('no configuration');
  const surface = state.surface;
  if (surface === null) refuse('no committed surface');
  if (state.recovery.length > 0) refuse('nonempty recovery list');

  const source = config.source;
  const tools = sortedTools(config.value.tools);
  const toolsHash = sha256HexOf(Buffer.from(canonicalBytes(tools)));
  const stateHash = sha256HexOf(Buffer.from(canonicalBytes({
    config: source, surface, open: state.open, recovery: state.recovery,
  })));

  // Committed history: every surface node except node 0 (the heading pin).
  const history: ChatMessage[] = [];
  const historySources: Source[] = [];
  for (const node of surface.nodes) {
    if (node.group.kind === 'heading') continue;
    history.push(...node.group.messages);
    historySources.push(...node.group.sources);
  }

  // The open turn: a consumed perception enters history, a first-use nonempty
  // perception is the queue, and complete open dialogues always follow.
  const queue: ChatMessage[] = [];
  const queueSources: Source[] = [];
  const open = state.open;
  if (open !== null) {
    if (open.perception !== null) {
      if (open.perceptionConsumed) {
        history.push(...open.perception.messages);
        historySources.push(...open.perception.sources);
      } else {
        queue.push(...open.perception.messages);
        queueSources.push(...open.perception.sources);
      }
    }
    history.push(...open.messages);
    historySources.push(...open.sources);
  }

  const sections: PlanSection[] = [
    { name: 'tools', cache: 'stable', sources: [source] },
    { name: 'charter', cache: 'stable', sources: [source] },
    { name: 'heading', cache: 'stable', sources: [surface.heading.source] },
    { name: 'history', cache: 'advance', sources: sortUnique(historySources) },
    { name: 'queue', cache: 'volatile', sources: sortUnique(queueSources) },
  ];

  const plan: RequestPlan = {
    id: input.id,
    config: source,
    stateHash,
    model: config.value.model,
    parameters: config.value.parameters,
    policy: config.value.policy,
    tools,
    toolsHash,
    sections,
    history,
    queue,
    charter: config.value.charter,
    heading: surface.heading.text,
  };
  return toJson(plan) as unknown as RequestPlan;
}

// --- offline reconstruction (T9) -------------------------------------------------

/**
 * One recorded plan and the plan rederived from the recorded facts that preceded
 * it. Equality is canonical JSON (`canonicalizeJson`, the bytes `canonicalBytes`
 * hashes), never `JSON.stringify` insertion order.
 */
export type ReplayComparison = {
  readonly source: Source; readonly recorded: RequestPlan; readonly rederived: RequestPlan;
};

/** The resolved wrapper of a recorded `world/perception` fact. */
type PerceptionPayload = {
  readonly turn: number; readonly range: WorldRange; readonly value: Stored<WorldPerception>;
};

const REPLAY_REGISTRY = createBoundaryRegistry();
const REPLAY_SIGNAL = new AbortController().signal;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The canonical JSON text of a value — the comparison `canonicalBytes` hashes. */
function canonicalText(value: unknown): string {
  return canonicalizeJson(toJson(value));
}

/**
 * Resolves a recorded `world/perception` through the same T1 registry the gate
 * and fold use (so the wrapper/value range equality is enforced), refusing an
 * incompatible renderer policy with an explicit message before shape validation.
 */
function recordedPerception(events: VerifiedEvents, data: PerceptionPayload): WorldPerception {
  const scope: GateScope = {
    phase: 'turn', turn: data.turn, signal: REPLAY_SIGNAL, lookup: () => null,
  };
  const validate = (raw: unknown): WorldPerception => {
    if (isRecord(raw)) {
      const renderer = raw['renderer'];
      if (isRecord(renderer) && renderer['policy'] !== RENDER_POLICY) {
        throw new Error(
          `replay: recorded perception renderer policy ${JSON.stringify(renderer['policy'])}`
          + ` is incompatible with ${RENDER_POLICY}`);
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
 */
async function verifyPerception(
  events: VerifiedEvents, world: WorldRepo, event: VerifiedEvent,
): Promise<void> {
  const data = event.data as unknown as PerceptionPayload;
  const recorded = recordedPerception(events, data);
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
 * Reconstructs a node's recorded plans and perceptions offline (kernel.md §4).
 *
 * It walks every recorded fact with a real `ContextFold`, assembles the plan
 * immediately before each recorded `request/plan` and compares it canonically,
 * and recomputes each `world/perception` from the recorded Git range, uid and
 * render budgets through `presentWorld`. A divergence — a changed renderer
 * policy, a differing exact Git version or any other canonical difference —
 * throws rather than promising equality. No external effect is executed: the
 * fold, the assembler and the renderer are read-only.
 */
export async function rederivePlans(
  events: VerifiedEvents, world: WorldRepo,
): Promise<readonly ReplayComparison[]> {
  const fold = new ContextFold();
  const comparisons: ReplayComparison[] = [];
  for (const event of events) {
    if (event.type === 'world/perception') {
      await verifyPerception(events, world, event);
    } else if (event.type === 'request/plan') {
      const data = event.data as unknown as { id: RequestId; value: Stored<RequestPlan> };
      const recorded = resolveStored(events, data.value, validateRequestPlan);
      const rederived = assemble({ id: data.id, state: fold.snapshot() });
      const source = sourceOf(event);
      if (canonicalText(rederived) !== canonicalText(recorded)) {
        throw new Error(
          `replay: the plan recorded at ${source.seq}:${source.hash}`
          + ' does not match the plan rederived from the recorded facts');
      }
      comparisons.push({ source, recorded, rederived });
    }
    await fold.observe([event]);
  }
  return comparisons;
}
