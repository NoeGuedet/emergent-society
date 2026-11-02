import type { BoundaryGate } from '../gate.js';
import { MAX_CAPTURE_BYTES } from '../gate.js';
import {
  DEFAULT_THREAD_READ, MAX_SPEAK_BYTES, renderConversationThread,
  type ConversationSent, type ConversationThread,
} from '../conversation.js';
import type { RequestId } from '../../context/contracts.js';
import type { AgentConfig, LlmModel } from '../../context/contracts.js';
import { canonicalizeJson } from '../../journal/index.js';
import { boundToolText } from './text.js';
import { modelIds, modelRefusal } from './providers.js';
import { Buffer } from 'node:buffer';
import { singleLine } from '../../text.js';
import { PackageError } from '../packages/errors.js';
import {
  DEFAULT_HISTORY_ENTRIES, MAX_HISTORY_ENTRIES, renderHistory, type HistoryPort,
} from '../history.js';
import { SelfRefusedError, type SelfPort } from '../self.js';
import type { PackageDefinition, PackageStore } from '../packages/store.js';
import type { RunSupervisor } from '../packages/supervisor.js';

/**
 * The extend executor (kernel.md, the sandbox and local-log sections): the
 * peer of terminal and web — the twelve verbs, including the conversation's
 * two (send_message, get_messages; the node `speak` verb is removed) and the
 * node's own history (`history`, the projection over the live fold's observed
 * events); the append home of the four verb facts (define, run, stop, undefine; the
 * registry's effect facts and the supervisor's error/service facts ride the
 * injected event port), the funnel's kernel-side schema validation, and the
 * honest inspect catalogue.
 *
 * Invariants this module owns:
 * - **Recognition never lives here** — decide() validated the verb and its
 *   exact key set before the executor runs; it receives a typed decision.
 * - **Verb facts append at the handler** — the store stays gate-less and
 *   liveness-free; the registry owns effect facts; the supervisor owns
 *   crash/timeout/protocol/service facts.
 * - **The funnel validates before the send** — the registered schema is
 *   kernel-side and restricted to the safe dialect, so the validation
 *   work is bounded and a violation is a teaching refusal
 *   (`tool/invalid-args`), never a wire round-trip.
 * - **Results append like base results** — raw-captured through
 *   `gate.capture`, bounded by `maxToolResultBytes`, `frontierCall: null`.
 *
 * What this module never does: mutate the offering (frozen for the process
 * lifetime — the registry is read at dispatch, never spliced into the
 * request), read a path outside the store's injected roots, or trust the
 * child's own good behavior.
 */

/** The funnel's thread into dispatchCalls, exactly like TerminalPort/WebTools. */
export type ExtendPort = {
  readonly store: PackageStore;
  readonly supervisor: RunSupervisor;
  /** The Run sandbox mode the supervisor spawns under — inspect's honesty. */
  readonly sandbox: boolean;
  /**
   * The kernel's spawn capability (A3), when this node was granted it. A node
   * without the grant sees the honest denial in inspect and in the verb; the
   * host owns composition and the home's flat roster — a node's end removes
   * only that node, never the nodes it composed.
   */
  readonly spawn?: SpawnPort;
  /**
   * The conversation interface (A3), bound to THIS node's uid by the runtime:
   * every node holds it. Absent is the port-less composition, which renders the
   * honest denial (the speak pattern, without the channel that owned speak).
   */
  readonly conversation?: ConversationPort;
  /**
   * The node's own history (the H1 read verb): the runtime-composed port over
   * the live fold's observed events plus the read-time commit-paths reader.
   * Bound to this node's uid at composition, never an argument. Absent is the
   * port-less composition, which renders the honest denial.
   */
  readonly history?: HistoryPort;
  /**
   * The operator-declared served-model catalog (providers.json `llm.models`),
   * when the store declares one. inspect lists its IDS honestly; it is the one
   * source for validating a model a verb requests (the host's pool validates
   * `spawn` against it, the executor validates `update_self`). The declared
   * context window never appears here: it is a host fact the wire does not
   * carry, and no verb reads it.
   */
  readonly models?: readonly LlmModel[];
  /**
   * The node's own identity rewrite (§0.7), supplied by the runtime — it reads
   * the live folded config, so the seam cannot be constructed by a caller that
   * does not hold the fold. Absent resolves `update_self` as a bounded denial.
   */
  readonly self?: SelfPort;
  /**
   * The node's own clean end (§0.9), host-composed over the pool — the check-
   * and-mark is synchronous so the executor's decision, its one result and the
   * stop share one turn. Absent resolves `request_death` as a bounded denial.
   */
  readonly depart?: DepartPort;
};

/** One spawn request, already typed: the host validates it against the caps. */
export type SpawnRequest = {
  readonly model?: string;
  readonly heading?: string;
  readonly charter?: string;
  readonly spawn?: boolean;
};

/** What this node may still create; inspect's honesty, never a promise. */
export type SpawnCaps = {
  readonly available: boolean;
  /** The home's remaining roster places: one flat ceiling, no per-node cap. */
  readonly nodesLeft: number;
};

/** The host's spawn seam: compose a node, or refuse with a bounded reason. */
export type SpawnPort = {
  spawn(request: SpawnRequest): Promise<{ readonly uid: string }>;
  caps(): SpawnCaps;
};

/** A bounded, path-free spawn refusal the executor renders as a denied result. */
export class SpawnRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnRefusedError';
  }
}

/**
 * The host's departure seam (plan §0.9): a node's own clean end.
 *
 * `beginDepart` is the pool's synchronous **check-and-mark**: it refuses the
 * last live node (counting in-flight departures as leaving, so two concurrent
 * departures can never empty the pool) and otherwise marks this node's
 * departure. The mark lives until the node's run settles — cleared by the
 * node's own end, never by an error path — so the last-node rule cannot flip
 * mid-flight. `depart` stops the node through `stop('self-requested')`.
 *
 * Both methods are deliberately synchronous: the executor appends its one
 * honest result between them with no await, so no other node's decision can
 * interleave between the mark and the stop.
 */
export type DepartPort = {
  beginDepart(): boolean;
  depart(): void;
};

/** The conversation interface's kernel seam, bound to the caller's uid. */
export type ConversationPort = {
  /** Append one record; `to` absent resolves to the reserved gateway. */
  send(to: string | undefined, text: string): Promise<ConversationSent>;
  /** The caller's own thread: the last n records, oldest-first at render. */
  thread(n: number): Promise<ConversationThread>;
};

/**
 * How a verb addresses a Package (the friction pass): by name — the ergonomic standard
 * the models are trained for, resolving to the latest stored version — or by
 * id, the exact content-addressed channel. Exactly one, as decide() enforced.
 * `stop` alone adds the bare channel (its decision variant): the Run is a
 * singleton, so a referenceless stop names THE live Run.
 */
export type PackageRef =
  | { readonly by: 'name'; readonly name: string }
  | { readonly by: 'id'; readonly id: string };

/** The stop channel: a name, an id, or nothing at all (the live Run itself). */
export type StopRef = PackageRef | { readonly by: 'bare' };

/** One validated extend decision, as decide() produced it. */
export type ExtendDecision =
  | { readonly kind: 'extend'; readonly verb: 'inspect' }
  | {
    readonly kind: 'extend'; readonly verb: 'define';
    readonly name: string; readonly purpose: string; readonly path: string;
  }
  | { readonly kind: 'extend'; readonly verb: 'run'; readonly ref: PackageRef }
  | {
    readonly kind: 'extend'; readonly verb: 'call';
    readonly tool: string; readonly args: unknown;
  }
  | { readonly kind: 'extend'; readonly verb: 'stop'; readonly ref: StopRef }
  | { readonly kind: 'extend'; readonly verb: 'undefine'; readonly ref: PackageRef }
  | {
    readonly kind: 'extend'; readonly verb: 'spawn';
    readonly model?: string; readonly heading?: string;
    readonly charter?: string; readonly spawn?: boolean;
  }
  | {
    readonly kind: 'extend'; readonly verb: 'update_self';
    readonly heading?: string; readonly path?: string; readonly model?: string;
  }
  | { readonly kind: 'extend'; readonly verb: 'request_death' }
  | {
    readonly kind: 'extend'; readonly verb: 'send_message';
    readonly to?: string; readonly text: string;
  }
  | { readonly kind: 'extend'; readonly verb: 'get_messages'; readonly n?: number }
  | { readonly kind: 'extend'; readonly verb: 'history'; readonly n?: number };

/** A schema violation the funnel refuses with, naming the field. */
function schemaViolation(args: unknown, schema: unknown, where: string): string | null {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return `${where}: the registered schema is not an object`;
  }
  const node = schema as Record<string, unknown>;
  const type = node['type'];
  if (type === 'object') {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return `${where}: expected an object`;
    }
    const record = args as Record<string, unknown>;
    const properties = typeof node['properties'] === 'object'
      && node['properties'] !== null && !Array.isArray(node['properties'])
      ? node['properties'] as Record<string, unknown> : {};
    if (node['additionalProperties'] === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) {
          return `${where}: the argument ${JSON.stringify(key)} is not declared`;
        }
      }
    }
    if (Array.isArray(node['required'])) {
      for (const required of node['required']) {
        if (typeof required === 'string' && !Object.hasOwn(record, required)) {
          return `${where}: the required argument ${JSON.stringify(required)} is missing`;
        }
      }
    }
    // Only keys PRESENT on the args object are validated: an omitted
    // optional property is legal (required was enforced above) — the
    // design's own worked example has optional properties.
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(record, key)) continue;
      const violation = schemaViolation(record[key], child, `${where}.${key}`);
      if (violation !== null) return violation;
    }
    return null;
  }
  if (type === 'array') {
    if (!Array.isArray(args)) return `${where}: expected an array`;
    return null;
  }
  if (type === 'string') {
    if (typeof args !== 'string') return `${where}: expected a string`;
    const minLength = node['minLength'];
    if (typeof minLength === 'number' && args.length < minLength) {
      return `${where}: shorter than minLength ${minLength}`;
    }
    return null;
  }
  if (type === 'integer') {
    if (typeof args !== 'number' || !Number.isSafeInteger(args)) {
      return `${where}: expected an integer`;
    }
    const maximum = node['maximum'];
    if (typeof maximum === 'number' && args > maximum) {
      return `${where}: greater than maximum ${maximum}`;
    }
    return null;
  }
  if (type === 'number') {
    if (typeof args !== 'number' || !Number.isFinite(args)) {
      return `${where}: expected a number`;
    }
    const maximum = node['maximum'];
    if (typeof maximum === 'number' && args > maximum) {
      return `${where}: greater than maximum ${maximum}`;
    }
    return null;
  }
  if (type === 'boolean') {
    if (typeof args !== 'boolean') return `${where}: expected a boolean`;
    return null;
  }
  return `${where}: the schema type ${JSON.stringify(type)} is not in the dialect`;
}

/** The bounded, raw-captured tool result — the execute append shape. */
async function appendResult(
  gate: BoundaryGate, id: RequestId, callId: string,
  content: string, isError: boolean, maxToolResultBytes: number,
): Promise<void> {
  const raw = content.length > 0
    ? await gate.capture(Buffer.from(content, 'utf8'), 'utf8', !isError) : null;
  gate.append('tool/result', {
    turn: id.turn, request: id, callId,
    message: {
      role: 'tool',
      content: raw === null ? content
        : boundToolText(content, maxToolResultBytes, {
          kind: 'artifact', sha256: raw.sha256, bytes: raw.bytes, complete: raw.complete,
        }),
      tool_call_id: callId,
    },
    isError,
    raw,
    failure: null,
    synthetic: false,
    frontierCall: null,
  });
}

function failure(text: string): { content: string; isError: true } {
  return { content: text, isError: true };
}

/**
 * The request_death branch's ONE result, appended without a capture.
 *
 * `appendResult` awaits `gate.capture` and `executeExtend` is async, but this
 * branch must not await between the departure decision and the stop: the
 * check-and-mark, the result and the stop share one synchronous turn, so no
 * other node's departure can interleave and the last-node rule cannot change
 * under the decision. `gate.append` is synchronous and the short grant or
 * denial needs no raw artifact — `raw: null` is the honest shape.
 */
function appendDepartureResult(
  gate: BoundaryGate, id: RequestId, callId: string, content: string, isError: boolean,
): void {
  gate.append('tool/result', {
    turn: id.turn, request: id, callId,
    message: { role: 'tool', content, tool_call_id: callId },
    isError, raw: null, failure: null, synthetic: false, frontierCall: null,
  });
}

function storeFailureText(err: PackageError): { content: string; isError: boolean } {
  switch (err.code) {
    case 'invalid-argument':
      return failure(`error: define/invalid-argument\n${err.message}`);
    case 'path-refused':
      return failure(`error: define/path-refused\n${err.message}`);
    case 'invalid-source':
      return failure(`error: define/invalid-source\n${err.message}`);
    case 'cap-exceeded':
      return failure(`error: define/cap-exceeded\n${err.message}`);
    case 'not-found':
      return failure('error: package/not-found\nno stored package has that id'
        + ' — extend {verb:"inspect"} lists the stored catalogue');
  }
}

/**
 * The self channel's store refusal: the same bounded codes, spelled for
 * `update_self` (a charter read, not a definition). A store method never
 * truncates — an over-bound file is refused whole.
 */
function selfStoreFailureText(err: PackageError): { content: string; isError: boolean } {
  switch (err.code) {
    case 'path-refused':
      return failure(`error: update_self/path-refused\n${err.message}`);
    case 'cap-exceeded':
      return failure(`error: update_self/cap-exceeded\n${err.message}`);
    default:
      return failure(`error: update_self/refused\n${err.message}`);
  }
}

/** The strict UTF-8 decode of a charter read; invalid bytes are a refusal, never U+FFFD. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Renders the honest inspect catalogue (kernel.md, the sandbox and
 * local-log sections): base tools, package tools with their schemas, the
 * stored packages with the caps and their meaning, the operator-declared
 * served models when the store declares a catalog, the conversation interface,
 * the kernel-owned `spawn` and the `request_death` rule, and the runtime honesty — the
 * sandbox mode with its
 * spelled-out meaning, the fail-closed contract, the withheld capabilities,
 * the caps, the no-rlimit residual, the egress-open residual, the
 * 256 KiB funneled-args input cap with the svc.execute workaround, the svc
 * facade (its resolve/reject contract), the Run's file reach (mode-conditional),
 * and the Run's in-memory lifetime.
 */
function renderInspect(
  config: AgentConfig,
  port: ExtendPort,
  packages: readonly { id: string; name: string; purpose: string; sourceBytes: number }[],
): string {
  const lines: string[] = [];
  lines.push('== base tools (the offering, frozen for this process) ==');
  for (const tool of config.tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
  }
  lines.push('');
  lines.push('== package tools (live) ==');
  lines.push('call them natively by name, or through the funnel:'
    + ' extend {verb:"call", tool:"<name>", args:{...}}');
  const registered = port.supervisor.registry.tools();
  if (registered.length === 0) {
    lines.push(port.supervisor.liveRunId() !== null
      ? '(no tools registered — a zero-tool Run is active, inert but honest)'
      : '(none registered — no Run is active)');
  }
  for (const tool of registered) {
    lines.push(`- ${tool.name}: ${tool.description}`);
    lines.push(`  schema: ${canonicalizeJson(tool.parameters)}`);
    lines.push(`  package: ${tool.packageId}`);
  }
  lines.push('a Run is in-memory: a restart reaps it — stored definitions'
    + ' survive, so run it again.');
  lines.push('');
  lines.push('== packages (stored, persistent across restarts) ==');
  if (packages.length === 0) {
    lines.push('(none stored — define one from a world file)');
  }
  for (const pkg of packages) {
    const running = port.supervisor.livePackageId() === pkg.id;
    lines.push(`- ${pkg.name} (id ${pkg.id}, ${pkg.sourceBytes} bytes of source):`
      + ` ${pkg.purpose} — ${running ? 'running' : 'defined, not running'}`);
  }
  const usedBytes = packages.reduce((sum, pkg) => sum + pkg.sourceBytes, 0);
  lines.push(`caps: one Run at a time (a tool swap is stop then run — two`
    + ' deliberate acts); 32 tools per Run; definition sources total'
    + ` ${usedBytes} / 67108864 bytes.`);
  // The substrate: the operator's served-model declaration, listed honestly.
  // Absent means the store declares no catalog at all, and the section is not
  // rendered — no line, today's inspect.
  if (port.models !== undefined) {
    lines.push('');
    lines.push('== the substrate this kernel serves (operator-declared, unverified) ==');
    if (port.models.length === 0) {
      lines.push('(none declared — every start is refused; providers.json declares'
        + ' llm.models empty)');
    } else {
      lines.push('not a routing table: the kernel does not probe these ids. A start, a'
        + ' spawn or an update_self that names a model outside the declared catalog is'
        + ' refused:');
      for (const model of port.models) lines.push(`- ${model.id}`);
    }
  }
  lines.push('');
  lines.push('== the conversation (the interface) ==');
  if (port.conversation !== undefined) {
    lines.push('- send_message: send one message into the conversation —'
      + ' extend {verb:"send_message", to?, text}; `to` is absent (the reserved'
      + ` gateway addressee) or "gateway" — the kernel is not a node-to-node`
      + ' transport. The kernel stamps the sender and'
      + ` the addressee; the message is at most ${MAX_SPEAK_BYTES} bytes, non-blank.`);
    lines.push('- get_messages: read your own conversation thread —'
      + ' extend {verb:"get_messages", n?}; the last n records (default'
      + ` ${DEFAULT_THREAD_READ}) that involve this node, oldest-first, with an`
      + ' "older records exist" line when the thread is longer. There is no'
      + ' cursor: re-reading is always possible.');
  } else {
    lines.push('- send_message / get_messages: the conversation interface —'
      + ' not available in this composition (no conversation port was composed).');
  }
  lines.push('');
  lines.push('== your own history ==');
  if (port.history !== undefined) {
    lines.push('- history: read your own records —'
      + ' extend {verb:"history", n?}; the last n entries of your own timeline'
      + ` (default ${DEFAULT_HISTORY_ENTRIES}, at most ${MAX_HISTORY_ENTRIES}),`
      + ' oldest-first, with an'
      + ' "older records exist" line when the timeline is longer. The entries are the'
      + ' kernel\'s record of your identity versions (charter bytes and digest, never'
      + ' the text), your turns with the paths their commits changed, your perceptions'
      + ' of the world\'s patches as you saw them, your lifecycle, compaction markers'
      + ' and pinned directions. There is no cursor: re-reading always returns the'
      + ' same records.');
  } else {
    lines.push('- history: your own records — this cell was composed without a'
      + ' history port.');
  }
  lines.push('');
  lines.push('== kernel-owned, visible but never mounted ==');
  if (port.spawn !== undefined) {
    const caps = port.spawn.caps();
    lines.push(caps.available
      ? `- spawn: creating new nodes — available: ${caps.nodesLeft} nodes left in the home.`
        + ' extend {verb:"spawn", model?, heading?, charter?, spawn?}; the child'
        + ' inherits this node\'s tools and budget, gets its own local log and cgroup'
        + ' leaf, and keeps running when this node ends; pass spawn: true to pass the'
        + ' capability on (a node grants only what it holds).'
      : '- spawn: creating new nodes — not granted to this node.');
  } else {
    lines.push('- spawn: creating new nodes — not granted to this node.');
  }
  // Static rule text, never a live query: the departure decision is a
  // check-and-MARK, so a read must not call `beginDepart` (it would leave a
  // departure mark as a read side effect). The line states the rule, not a
  // promise about this node's place in the roster.
  lines.push('- request_death: this node\'s own clean end — extend {verb:"request_death"};'
    + ' granted unless this is the last live node (the operator pauses the host); the'
    + ' stop cancels the turn\'s remaining calls.');
  lines.push('');
  lines.push('== runtime honesty ==');
  const status = port.supervisor.sandboxStatus();
  lines.push(port.sandbox
    ? `Run sandbox: ${status === null
      ? 'Landlock confinement (not yet probed this process; fail-closed: a'
        + ' sandbox that cannot be built or probed makes every extend run close'
        + ' as run/spawn-failed)'
      : `landlock abi ${status.abi} enforcement ${status.enforcement}`
        + ' (fail-closed: a sandbox that cannot be built or probed makes every'
        + ' extend run close as run/spawn-failed)'}`
    : 'Run sandbox: OFF — package code runs as this kernel process: it can'
      + ' read, overwrite and destroy the credential store and every node'
      + ' tree, and signal the kernel');
  lines.push('withheld from package code by design: the kernel objects (the'
    + ' gate, the journal writer, the git plumbing, the provider transport,'
    + ' providers.json loading) and the model call (the first future svc kind).'
    + ' Egress is open by design (Landlock mediates no network); timers and'
    + ' process authority remain the guest process\'s own — the facade is the'
    + ' capability channel, not the whole sandbox.');
  lines.push('funneled args are capped at 256 KiB per call — larger inputs go'
    + ' through svc.execute against world files.');
  // This pair mirrors the extend description's svc sentence (config.ts):
  // keep the two in step; the tests pin both independently.
  lines.push('the facade is svc: a handler is called as handler(args, svc) —'
    + ' svc.execute(cmd) runs one command in the same persistent shell the'
    + ' execute tool uses (when the execute tool is allowed); a completed'
    + ' command resolves {status, exitCode, output}, any other outcome'
    + ' (denied, timeout, spawn or session failure) rejects with a bounded'
    + ' JSON error — catch it.');
  lines.push('svc.web_search(query, maxResults?) and svc.web_fetch(url) make'
    + ' the same kernel-mediated calls as the base tools (when the web tools'
    + ' are allowed); they resolve {body} and reject on failure.');
  lines.push(port.sandbox
    ? 'a Run\'s file reach: its own leaf and the system read set only —'
      + ' the world and the cell home are EACCES; world files go through'
      + ' svc.execute.'
    : 'a Run\'s file reach: none — unconfined (sandbox OFF above); the world'
      + ' and the cell home are as reachable as to the kernel.');
  lines.push('cgroup membership, freeze and kill exist for the shell and Runs'
    + ' when the cell has a tree (a host without cgroup v2 runs Landlock-only);'
    + ' memory/pids limits are not written yet — they arrive with the delegated'
    + ' launch. The caps above are the availability physics until then. Egress'
    + ' from a Run is open (unmediated); svc.web_search/svc.web_fetch is the'
    + ' credential-backed, frontier-visible form.');
  return lines.join('\n');
}

/**
 * Resolves the run reference to a stored definition with the channel's own
 * honest not-found wording (the friction pass): the name channel names the name, the id
 * channel names the id — never the bare pre-friction-pass id wording for a name the
 * model actually sent. (Undefine does not use this: its destructive
 * resolution never skips, so it resolves by hand.)
 */
async function resolveRef(
  port: ExtendPort, ref: PackageRef,
): Promise<{ readonly def: PackageDefinition | null; readonly notFoundText: string }> {
  if (ref.by === 'id') {
    return {
      def: await port.store.definitionById(ref.id),
      notFoundText: 'error: package/not-found\nno stored package has that id'
        + ' — extend {verb:"inspect"} lists the stored catalogue',
    };
  }
  return {
    def: await port.store.resolveLatestByName(ref.name),
    notFoundText: 'error: package/not-found\nno stored package has that name'
      + ' — extend {verb:"inspect"} lists the stored catalogue',
  };
}

/** Executes one validated extend decision and appends its result. */
export async function executeExtend(opts: {
  readonly gate: BoundaryGate;
  readonly id: RequestId;
  readonly callId: string;
  readonly decision: ExtendDecision;
  readonly config: AgentConfig;
  readonly port: ExtendPort;
}): Promise<void> {
  const { gate, id, callId, decision, config, port } = opts;
  const max = config.policy.maxToolResultBytes;

  if (decision.verb === 'inspect') {
    // The read-only catalogue: a read-only listing, never the deleting scan.
    const { definitions } = await port.store.listPackages();
    await appendResult(gate, id, callId,
      renderInspect(config, port, definitions.map((pkg) => ({
        id: pkg.id, name: pkg.name, purpose: pkg.purpose, sourceBytes: pkg.sourceBytes,
      }))), false, max);
    return;
  }

  if (decision.verb === 'request_death') {
    // The node's own clean end (§0.9). FULLY SYNCHRONOUS by construction: no
    // await anywhere in this branch, so nothing can interleave between the
    // pool's check-and-mark, this one result and the stop that fulfils the
    // mark. The append and the stop are wrapped so a granted mark always
    // receives its stop — an append that throws still calls `depart()`, since
    // the mark's fulfilment is the node's end and the mark dies with it.
    const depart = port.depart;
    if (depart === undefined) {
      appendDepartureResult(gate, id, callId,
        'denied: this cell was composed without a depart port', true);
      return;
    }
    const granted = depart.beginDepart();
    try {
      appendDepartureResult(gate, id, callId,
        granted
          ? 'departure granted: this node stops when this turn ends'
          : 'denied: the last live node cannot die; the operator pauses the host',
        !granted);
    } finally {
      if (granted) depart.depart();
    }
    return;
  }

  if (decision.verb === 'send_message') {
    const conversation = port.conversation;
    if (conversation === undefined) {
      await appendResult(gate, id, callId,
        'denied: this cell was composed without a conversation port', true, max);
      return;
    }
    try {
      // The runtime's port stamps `from` with this node's uid and resolves the
      // addressee; the executor only carries the validated message.
      const sent = await conversation.send(decision.to, decision.text);
      await appendResult(gate, id, callId,
        `sent to ${sent.to} (${Buffer.byteLength(decision.text, 'utf8')} bytes);`
        + ' the kernel wrote the record', false, max);
    } catch (err) {
      await appendResult(gate, id, callId,
        `error: conversation/failed\n${singleLine(
          err instanceof Error ? err.message : 'the conversation stream could not be written',
          200)}`, true, max);
    }
    return;
  }

  if (decision.verb === 'get_messages') {
    const conversation = port.conversation;
    if (conversation === undefined) {
      await appendResult(gate, id, callId,
        'denied: this cell was composed without a conversation port', true, max);
      return;
    }
    try {
      const thread = await conversation.thread(decision.n ?? DEFAULT_THREAD_READ);
      // SELF-BOUNDED: the renderer drops the oldest records itself; the generic
      // `boundToolText` would silently cut a record in half.
      const content = renderConversationThread(thread, max);
      await appendResult(gate, id, callId, content, false, max);
    } catch (err) {
      await appendResult(gate, id, callId,
        `error: conversation/failed\n${singleLine(
          err instanceof Error ? err.message : 'the conversation thread could not be read',
          200)}`, true, max);
    }
    return;
  }

  if (decision.verb === 'history') {
    const history = port.history;
    if (history === undefined) {
      await appendResult(gate, id, callId,
        'denied: this cell was composed without a history port', true, max);
      return;
    }
    try {
      // The renderer self-bounds under maxToolResultBytes (the per-entry bounds
      // do the clamping), so the generic tool-text truncation never fires.
      const content = await renderHistory(
        history, decision.n ?? DEFAULT_HISTORY_ENTRIES, max);
      await appendResult(gate, id, callId, content, false, max);
    } catch (err) {
      await appendResult(gate, id, callId,
        `error: history/failed\n${singleLine(
          err instanceof Error ? err.message : 'the history could not be rendered',
          200)}`, true, max);
    }
    return;
  }

  if (decision.verb === 'spawn') {
    if (port.spawn === undefined) {
      await appendResult(gate, id, callId,
        'denied: this node was not granted the spawn capability', true, max);
      return;
    }
    try {
      const spawned = await port.spawn.spawn({
        ...(decision.model !== undefined ? { model: decision.model } : {}),
        ...(decision.heading !== undefined ? { heading: decision.heading } : {}),
        ...(decision.charter !== undefined ? { charter: decision.charter } : {}),
        ...(decision.spawn !== undefined ? { spawn: decision.spawn } : {}),
      });
      const caps = port.spawn.caps();
      await appendResult(gate, id, callId,
        `spawned ${spawned.uid} — ${caps.nodesLeft} nodes left in the home; the child`
        + ' keeps running when this node ends'
        + (decision.spawn === true ? ', and the spawn capability was passed on' : ''),
        false, max);
    } catch (err) {
      if (err instanceof SpawnRefusedError) {
        await appendResult(gate, id, callId,
          `denied: ${singleLine(err.message, 200)}`, true, max);
        return;
      }
      throw err;
    }
    return;
  }

  if (decision.verb === 'update_self') {
    // The self channel (plan §0.7): the new charter is authored in the world
    // (a `path`, mirroring define's vocabulary), the identity fields are
    // applied by the runtime's renew over the LIVE folded config, and the
    // change is journaled exactly like the ready phase — `gate.store` plus a
    // versioned `system/message`. The new identity therefore applies from the
    // next assembled request (possibly this turn); the turn's dispatch and
    // policy stay on the config captured at turn start, which is the `config`
    // this executor was handed.
    if (port.self === undefined) {
      await appendResult(gate, id, callId,
        'denied: this cell was composed without a self port', true, max);
      return;
    }
    let charter: string | undefined;
    if (decision.path !== undefined) {
      // Bounded by the capture ceiling the config validator and the plan check
      // share — refuse, never truncate. A larger file could never become a
      // sendable identity anyway; the bound only stops the read from being a
      // DoS channel.
      let bytes: Buffer;
      try {
        bytes = await port.store.readWorldSource(decision.path, MAX_CAPTURE_BYTES);
      } catch (err) {
        if (err instanceof PackageError) {
          const text = selfStoreFailureText(err);
          await appendResult(gate, id, callId, text.content, true, max);
          return;
        }
        throw err;
      }
      try {
        charter = STRICT_UTF8.decode(bytes);
      } catch {
        await appendResult(gate, id, callId,
          'error: update_self/invalid-source\nthe charter is not valid UTF-8', true, max);
        return;
      }
    }
    // The model is validated against the operator's declared catalog when one
    // exists — the same source and the same bounded refusal as spawn's. With no
    // catalog the model stays the free string it was; the identity budget below
    // is what keeps the catalog-less model hole closed.
    if (decision.model !== undefined && port.models !== undefined
      && !port.models.some((model) => model.id === decision.model)) {
      await appendResult(gate, id, callId,
        `denied: ${modelRefusal(decision.model, modelIds(port.models))}`, true, max);
      return;
    }
    let next: AgentConfig;
    try {
      next = port.self.renew({
        ...(decision.heading !== undefined ? { heading: decision.heading } : {}),
        ...(charter !== undefined ? { charter } : {}),
        ...(decision.model !== undefined ? { model: decision.model } : {}),
      });
    } catch (err) {
      if (err instanceof SelfRefusedError) {
        await appendResult(gate, id, callId,
          `denied: ${singleLine(err.message, 200)}`, true, max);
        return;
      }
      throw err;
    }
    // The ready phase's exact shape: the config is stored (claim-checked like
    // any other value) and appended as its own versioned event. The fold
    // enforces the strictly-increasing version at replay; the executor's flush
    // (dispatchCalls) makes the event durable before the next request.
    const stored = await gate.store(next);
    gate.append('system/message', { version: next.version, value: stored });
    const changed = [
      ...(decision.heading !== undefined ? ['heading'] : []),
      ...(charter !== undefined ? ['charter'] : []),
      ...(decision.model !== undefined ? ['model'] : []),
    ];
    await appendResult(gate, id, callId,
      `self updated (version ${next.version}): ${changed.join(', ')}`, false, max);
    return;
  }

  if (decision.verb === 'define') {
    try {
      const defined = await port.store.definePackage({
        name: decision.name, purpose: decision.purpose, path: decision.path,
      });
      gate.append('package/define', {
        id: defined.id, name: decision.name,
        purpose: decision.purpose, sourceBytes: defined.sourceBytes,
      });
      await appendResult(gate, id, callId,
        `defined ${decision.name} (id ${defined.id},`
        + ` ${defined.sourceBytes} bytes of source) — ${decision.purpose}\n`
        + 'define parses the source and stores it; run validates the registration',
        false, max);
    } catch (err) {
      if (err instanceof PackageError) {
        await appendResult(gate, id, callId, storeFailureText(err).content, true, max);
        return;
      }
      throw err;
    }
    return;
  }

  if (decision.verb === 'run') {
    const { def, notFoundText } = await resolveRef(port, decision.ref);
    if (def === null) {
      await appendResult(gate, id, callId, notFoundText, true, max);
      return;
    }
    const source = await port.store.readPackageSource(def.id);
    if (source === null) {
      // The definition was resolved but is gone at delivery (an undefine
      // raced between the two reads): the refusal keeps the channel the
      // model actually used. Content integrity needs no re-verification
      // here — the Run's own verify-then-use makes a child spawned over
      // mismatched bytes exit fatal before any guest byte evaluates, so
      // the journaled package/run id can only ever name bytes that passed.
      await appendResult(gate, id, callId, notFoundText, true, max);
      return;
    }
    const verdict = await port.supervisor.startRun(def.id, source);
    if (!verdict.ok) {
      const text = verdict.code === 'busy'
        ? 'error: run/busy\na Run is already active — stop it first'
        : verdict.code === 'name-conflict'
          ? `error: run/name-conflict\nthe declaration collides with reserved names:`
            + ` ${verdict.names.join(', ')}`
          : verdict.code === 'invalid-registration'
            ? `error: run/invalid-registration\n${verdict.detail}`
            : verdict.code === 'timeout'
              ? 'error: run/timeout\nthe child sent no run/ready in time'
              : `error: run/${verdict.code}\n${verdict.detail}`;
      await appendResult(gate, id, callId, text, true, max);
      return;
    }
    gate.append('package/run', {
      id: def.id, runId: verdict.runId,
      sandbox: port.sandbox ? 'landlock' : 'off',
    });
    const lines = [`run started (package ${def.name} (id ${def.id}),`
      + ` run ${verdict.runId}, sandbox: ${port.sandbox ? 'landlock' : 'off'}),`
      + ` ${verdict.tools.length} tool(s):`];
    for (const tool of verdict.tools) {
      lines.push(`- ${tool.name}: ${tool.description}`);
      lines.push(`  schema: ${canonicalizeJson(tool.parameters)}`);
    }
    await appendResult(gate, id, callId, lines.join('\n'), false, max);
    return;
  }

  if (decision.verb === 'call') {
    const tool = port.supervisor.registry.lookup(decision.tool);
    if (tool === null) {
      await appendResult(gate, id, callId,
        `error: tool-not-found\nno live tool named ${JSON.stringify(decision.tool)}`
        + ' — extend {verb:"inspect"} lists the live catalogue', true, max);
      return;
    }
    const violation = schemaViolation(decision.args, tool.parameters, 'args');
    if (violation !== null) {
      await appendResult(gate, id, callId,
        `error: tool/invalid-args\n${violation}`, true, max);
      return;
    }
    const verdict = await port.supervisor.invokeTool(tool, decision.args, opts.gate.signal);
    if (verdict.status === 'ok') {
      await appendResult(gate, id, callId,
        canonicalizeJson(verdict.result as never), false, max);
      return;
    }
    if (verdict.status === 'error') {
      await appendResult(gate, id, callId, `error: ${verdict.message}`, true, max);
      return;
    }
    if (verdict.status === 'cancelled') {
      // The gate's stop settled this invoke: the synthetic cancelled closer,
      // the abort precedent — an effect is never left unattributed.
      gate.append('tool/result', {
        turn: id.turn, request: id, callId,
        message: { role: 'tool', content: 'cancelled', tool_call_id: callId },
        isError: true, raw: null, failure: { code: 'cancelled', status: null },
        synthetic: true, frontierCall: null,
      });
      return;
    }
    await appendResult(gate, id, callId,
      verdict.status === 'crashed'
        ? 'error: run/crashed\nthe Run died during the call'
        : 'error: run/timeout\nthe call exceeded the deadline and the Run was torn down',
      true, max);
    return;
  }

  // Stop acts on the one live Run. A bare stop (the friction pass 2) names
  // the singleton itself — no reference, no wrong-name round trip; a supplied
  // reference is still checked against it, so a version skew (run v1, define
  // v2, stop by name) can never misfire.
  if (decision.verb === 'stop') {
    const liveId = port.supervisor.liveRunId();
    const livePackage = port.supervisor.livePackageId();
    if (liveId === null || livePackage === null) {
      await appendResult(gate, id, callId,
        'error: package/not-found\nno Run is live — run a package first', true, max);
      return;
    }
    const liveDef = await port.store.definitionById(livePackage);
    // The manifest read above can straddle the Run's own death (a crash or a
    // clean exit lands between the two live reads). Re-read the live ids and
    // refuse when they moved: a stop must never journal a verb fact for a
    // Run that already ended — the crash fact owns that Run's ending. The
    // remaining residual is the supervisor's drain rule, unchanged by the
    // addressing channel: a child that exited while a grandchild still holds its
    // stdout open keeps `live` set until the drain, a death this re-read
    // cannot see — kernelStopped and the drain own that verdict.
    if (port.supervisor.liveRunId() !== liveId
      || port.supervisor.livePackageId() !== livePackage) {
      await appendResult(gate, id, callId,
        'error: package/not-found\nthe Run ended before the stop landed'
        + ' — extend {verb:"inspect"} shows the live catalogue', true, max);
      return;
    }
    if (decision.ref.by !== 'bare') {
      const matches = decision.ref.by === 'id'
        ? livePackage === decision.ref.id
        : liveDef !== null && liveDef.name === decision.ref.name;
      if (!matches) {
        const wanted = decision.ref.by === 'name'
          ? `name ${JSON.stringify(decision.ref.name)}` : `id ${decision.ref.id}`;
        const liveName = liveDef !== null
          ? `${liveDef.name} (id ${livePackage})` : livePackage;
        await appendResult(gate, id, callId,
          `error: package/not-found\nno live Run of ${wanted}`
          + ` — the live Run is package ${liveName}`, true, max);
        return;
      }
    }
    await port.supervisor.stopRun();
    gate.append('package/stop', {
      id: livePackage, runId: liveId, reason: 'verb',
    });
    await appendResult(gate, id, callId,
      `stopped (package ${liveDef !== null ? liveDef.name : livePackage}, run ${liveId});`
      + ' the package stays defined — re-run it anytime',
      false, max);
    return;
  }

  // undefine — the destructive resolution. By name: the newest stored id
  // under that name with NO skipping — a corrupt newest version is faced
  // and refused (teaching the id channel), never stepped around onto an
  // older version the name was not addressing. By id: existence-only, the
  // model names the exact entry — deleting it whatever its state is the
  // honest escape hatch the corrupt refusal teaches.
  if (decision.ref.by === 'id') {
    if (port.supervisor.livePackageId() === decision.ref.id) {
      await appendResult(gate, id, callId,
        'error: undefine while a Run is active\nstop it first — two deliberate'
        + ' acts, two facts', true, max);
      return;
    }
    try {
      await port.store.undefinePackage(decision.ref.id);
    } catch (err) {
      if (err instanceof PackageError && err.code === 'not-found') {
        await appendResult(gate, id, callId,
          'error: package/not-found\nno stored package has that id', true, max);
        return;
      }
      throw err;
    }
    gate.append('package/undefine', { id: decision.ref.id });
    await appendResult(gate, id, callId,
      `undefined (id ${decision.ref.id}); the definition is gone — re-defining the same`
      + ' source restores the exact identity', false, max);
    return;
  }
  const newest = await port.store.newestIdByName(decision.ref.name);
  if (newest === null) {
    await appendResult(gate, id, callId,
      'error: package/not-found\nno stored package has that name'
      + ' — extend {verb:"inspect"} lists the stored catalogue', true, max);
    return;
  }
  const def = await port.store.definitionById(newest);
  if (def === null) {
    await appendResult(gate, id, callId,
      'error: undefine/corrupt\nthe newest version of that name does not verify'
      + ` — undefine it by id instead: {verb:"undefine", id:"${newest}"}`, true, max);
    return;
  }
  if (port.supervisor.livePackageId() === def.id) {
    await appendResult(gate, id, callId,
      'error: undefine while a Run is active\nstop it first — two deliberate'
      + ' acts, two facts', true, max);
    return;
  }
  try {
    await port.store.undefinePackage(def.id);
  } catch (err) {
    if (err instanceof PackageError && err.code === 'not-found') {
      await appendResult(gate, id, callId,
        'error: package/not-found\nno stored package has that name'
        + ' — extend {verb:"inspect"} lists the stored catalogue', true, max);
      return;
    }
    throw err;
  }
  gate.append('package/undefine', { id: def.id });
  await appendResult(gate, id, callId,
    `undefined ${def.name} (id ${def.id}); the definition is gone — re-defining the same`
    + ' source restores the exact identity', false, max);
}
