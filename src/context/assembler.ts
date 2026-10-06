import { sha256HexOf } from '../journal/canon.js';
import { canonicalBytes, toJson } from './artifacts.js';
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
