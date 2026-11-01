import { sha256HexOf } from '../journal/index.js';
import { canonicalBytes, toJson } from './artifacts.js';
import { sortUnique } from './groups.js';
import type {
  ChatMessage, PlanSection, ProjectionState, RequestId, RequestPlan, Source, ToolSchema,
} from './contracts.js';

/**
 * The pure request assembler (kernel.md §4).
 *
 * `assemble` turns a folded `ProjectionState` into the one canonical plan a
 * turn will send. It is a pure function: it performs no I/O, appends no journal
 * fact and measures no captured size. The trusted runtime — not this module —
 * measures `canonicalBytes(plan)` against the capture ceiling and journals
 * `request/refused` for an oversize plan; the plan itself is never journaled
 * anywhere — the exact bytes it produces are the frontier journal's fact. A
 * plan is refused here only for a state that cannot be assembled at all.
 *
 * The offering is the config's tools sorted by UTF-16 code unit (never
 * `localeCompare`, never the config's own order), the same sorted value the
 * serializer hashes and emits. `stateHash` covers exactly the canonical
 * `{config, surface, open, recovery}`.
 */

/** The input of one assembly: the logical request and the state it is built from. */
export type AssembleInput = {
  readonly id: RequestId; readonly state: ProjectionState;
  /**
   * The ratified direction this turn pins, when the driver read one. Its text
   * replaces the journaled heading and its local-log receipt is the heading
   * block's citation; absent means the journaled heading (the boot seed).
   */
  readonly direction?: { readonly text: string; readonly source: Source };
  /**
   * The operator-declared served-model catalog, handed in by the runtime from
   * its own host fact. Presentation only: it rides the plan's substrate block
   * as the third kernel-owned system message, never inside the charter or
   * heading text, and it never enters `stateHash` (which covers the journaled
   * state alone). Absent means no catalog: no block, today's plan.
   */
  readonly models?: readonly string[];
};

/**
 * The pinned substrate sentence: the kernel-owned block naming the served
 * models, immediately after the heading block and before the history. Its
 * prefix is fixed; the ids follow in declaration order, joined by `, `, and an
 * empty declaration says so rather than rendering a dangling list.
 */
const SUBSTRATE_PREFIX = 'The substrate this kernel serves — models: ';

function refuse(message: string): never {
  throw new Error(`cannot assemble: ${message}`);
}

/** UTF-16 code-unit order, the same comparison the serializer's hash uses. */
function byName(a: ToolSchema, b: ToolSchema): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
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

  const headingText = input.direction?.text ?? surface.heading.text;
  const headingSource = input.direction?.source ?? surface.heading.source;
  // The substrate block is a host fact with no receipt: it enters the plan
  // only when the operator declared a catalog, its section cites no source,
  // and it is the one prefix block whose bytes an operator edit can move — the
  // documented cache invalidator beside a heading change.
  const substrate = input.models === undefined
    ? undefined
    : `${SUBSTRATE_PREFIX}${input.models.length === 0
      ? '(none declared)' : input.models.join(', ')}`;
  const sections: PlanSection[] = [
    { name: 'tools', cache: 'stable', sources: [source] },
    { name: 'charter', cache: 'stable', sources: [source] },
    { name: 'heading', cache: 'stable', sources: [headingSource] },
    ...(substrate !== undefined
      ? [{ name: 'substrate' as const, cache: 'stable' as const, sources: [] }]
      : []),
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
    heading: headingText,
    ...(substrate !== undefined ? { substrate } : {}),
  };
  return toJson(plan) as unknown as RequestPlan;
}
