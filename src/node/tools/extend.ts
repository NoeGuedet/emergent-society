import type { BoundaryGate } from '../gate.js';
import type { RequestId } from '../../context/contracts.js';
import type { AgentConfig } from '../../context/contracts.js';
import { canonicalizeJson } from '../../journal/index.js';
import { boundToolText } from './text.js';
import { PackageError } from '../packages/errors.js';
import type { PackageDefinition, PackageStore } from '../packages/store.js';
import type { RunSupervisor } from '../packages/supervisor.js';

/**
 * The extend executor (kernel.md, the sandbox and local-log sections): the
 * peer of terminal and web — the six verbs, the append home of the four
 * verb facts (define, run, stop, undefine; the registry's effect facts and
 * the supervisor's error/service facts ride the injected event port), the
 * funnel's kernel-side schema validation, and the honest inspect catalogue.
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
  | { readonly kind: 'extend'; readonly verb: 'undefine'; readonly ref: PackageRef };

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
 * Renders the honest inspect catalogue (kernel.md, the sandbox and
 * local-log sections): base tools, package tools with their schemas, the
 * stored packages with the caps and their meaning, the kernel-owned
 * `spawn`/`speak`, and the runtime honesty — the sandbox mode with its
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
  lines.push('');
  lines.push('== kernel-owned, visible but never mounted ==');
  lines.push('- spawn: creating new nodes — not available yet; its first use is a dated event.');
  lines.push('- speak: the human channel — agent zero alone, not available yet.');
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
