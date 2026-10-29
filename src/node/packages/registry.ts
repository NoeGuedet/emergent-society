import type { JsonValue } from '../../journal/index.js';
import { canonicalizeJson } from '../../journal/index.js';
import {
  MAX_DECLARED_SURFACE_BYTES,
  MAX_PACKAGE_NAME_CHARS,
  MAX_PACKAGE_PURPOSE_CHARS,
  MAX_TOOL_SCHEMA_BYTES,
  MAX_TOOLS_PER_RUN,
} from './constants.js';

/**
 * The live runtime registry (kernel.md, the local-log sections): the
 * transactional, collision-checked home of every tool a running Package
 * registers. The offering stays frozen — the registry is read at dispatch
 * time by the funnel, never spliced into the request's tools array.
 *
 * Invariants this module owns:
 * - **Registration is transactional** — the whole declaration is validated
 *   before any visible effect; a refusal lands nothing, and a collision
 *   inside the declaration is caught before the first tool moves.
 * - **Collision-checked against every reserved vocabulary** — the base five,
 *   the extend verbs, the kernel-owned `spawn`/`speak` (a package tool named
 *   `spawn` would corrupt the honesty catalogue), already-registered names,
 *   and duplicates within the declaration.
 * - **The declaration bounds** — at most `MAX_TOOLS_PER_RUN` tools, each
 *   schema at most `MAX_TOOL_SCHEMA_BYTES`, the whole surface (names +
 *   descriptions + schemas) at most `MAX_DECLARED_SURFACE_BYTES` so the
 *   maximal `run` result and `inspect` catalogue stay text.
 * - **The safe schema dialect** — `type`/`properties`/`required`/
 *   `minLength`/`maximum`/`additionalProperties` over the scalar type set
 *   and nothing else: a guest-authored regex or combinatorial tree is
 *   unbounded kernel-side evaluation work, refused here, never validated.
 *
 * What this module never does: dispatch (the funnel's), liveness of the child
 * (the supervisor's), or a spawn-visible effect on any refusal path.
 */

/** The wire's serializable tool declaration (design §5.3 — the bootstrap sends this). */
export type DeclaredTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
};

/** One registered tool, with its owning Run and Package. */
export type RegisteredTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
  readonly runId: string;
  readonly packageId: string;
};

/** The refusal vocabulary the funnel and the run verb map (design §3). */
export type RegistrationRefusal =
  | { readonly code: 'name-conflict'; readonly names: readonly string[] }
  | { readonly code: 'invalid-registration'; readonly detail: string }
  | { readonly code: 'busy' };

/** The registration outcome: acceptance, or the first refusal the funnel maps. */
export type RegistrationVerdict =
  | { readonly ok: true }
  | ({ readonly ok: false } & RegistrationRefusal);

/** The registry's one outbound port: the `package/effect` append home. */
export type RunRegistryEvents = {
  readonly effect: (payload: {
    readonly id: string;
    readonly runId: string;
    readonly kind: 'tool-registered';
    readonly tool: string;
  }) => void;
};

const BASE_TOOLS: ReadonlySet<string> = new Set([
  'execute', 'wait', 'web_search', 'web_fetch', 'extend',
]);

const VERB_VOCABULARY: ReadonlySet<string> = new Set([
  'inspect', 'define', 'run', 'call', 'stop', 'undefine', 'verb',
]);

const KERNEL_OWNED: ReadonlySet<string> = new Set(['spawn', 'speak']);

const SCALAR_TYPES: ReadonlySet<string> = new Set([
  'object', 'array', 'string', 'number', 'integer', 'boolean',
]);

/** Every reserved name — the base offering, the verbs, the kernel's own. */
const RESERVED: ReadonlySet<string> = new Set([
  ...BASE_TOOLS, ...VERB_VOCABULARY, ...KERNEL_OWNED,
]);

/** The store's name rule (§4 item 1), shared with the definition store. */
function validToolName(name: string): boolean {
  return typeof name === 'string' && name.length >= 1
    && name.length <= MAX_PACKAGE_NAME_CHARS
    && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
    && name !== '.' && name !== '..' && !name.startsWith('.')
    && name.isWellFormed();
}

/** One schema node against the safe dialect; the first violation names the field. */
function schemaDialectError(node: unknown, where: string): string | null {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return `${where} must be a JSON object`;
  }
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'type' && key !== 'properties' && key !== 'required'
      && key !== 'minLength' && key !== 'maximum' && key !== 'additionalProperties') {
      return `${where}.${key} is outside the safe schema dialect`
        + ' (type/properties/required/minLength/maximum/additionalProperties only)';
    }
  }
  const type = record['type'];
  if (typeof type !== 'string' || !SCALAR_TYPES.has(type)) {
    return `${where}.type must be one of ${[...SCALAR_TYPES].join(' | ')}`;
  }
  if ('properties' in record) {
    const properties = record['properties'];
    if (typeof properties !== 'object' || properties === null
      || Array.isArray(properties)) {
      return `${where}.properties must be a JSON object`;
    }
    for (const [key, child] of Object.entries(properties)) {
      const nested = schemaDialectError(child, `${where}.properties.${key}`);
      if (nested !== null) return nested;
    }
  }
  if ('required' in record) {
    const required = record['required'];
    if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
      return `${where}.required must be an array of property names`;
    }
    if ('properties' in record) {
      const properties = record['properties'] as Record<string, unknown>;
      for (const entry of required as string[]) {
        if (!Object.hasOwn(properties, entry)) {
          return `${where}.required names ${JSON.stringify(entry)},`
            + ' which is not among the declared properties';
        }
      }
    }
  }
  if ('minLength' in record) {
    const minLength = record['minLength'];
    if (typeof minLength !== 'number' || !Number.isSafeInteger(minLength)
      || minLength < 0) {
      return `${where}.minLength must be a nonnegative integer`;
    }
  }
  if ('maximum' in record) {
    const maximum = record['maximum'];
    if (typeof maximum !== 'number' || !Number.isFinite(maximum)) {
      return `${where}.maximum must be a finite number`;
    }
  }
  if ('additionalProperties' in record) {
    const additional = record['additionalProperties'];
    if (typeof additional !== 'boolean') {
      return `${where}.additionalProperties must be a boolean`;
    }
  }
  return null;
}

/** Canonical byte size of a JSON value — the declaration-bound unit. */
function canonicalBytes(value: JsonValue): number {
  return Buffer.byteLength(canonicalizeJson(value), 'utf8');
}

/**
 * Builds the registry over the injected effect port. Model-agnostic: the
 * reserved vocabularies are static, and no dispatch or tool module is
 * imported — the funnel reads the registry at dispatch time.
 */
export function createRunRegistry(events: RunRegistryEvents): {
  /** Transactional registration; a refusal lands nothing. */
  registerRun(packageId: string, runId: string, declared: readonly DeclaredTool[]): RegistrationVerdict;
  /** Removes the run's tools (the sequential disposal's registry step). */
  unregisterRun(runId: string): void;
  /** The registered tool a funneled call resolves to, or null. */
  lookup(name: string): RegisteredTool | null;
  /** Every registered tool (the inspect catalogue's package section). */
  tools(): readonly RegisteredTool[];
  /** The one live run's id, or null. */
  liveRunId(): string | null;
} {
  const byName = new Map<string, RegisteredTool>();
  let live: string | null = null;

  function registerRun(
    packageId: string,
    runId: string,
    declared: readonly DeclaredTool[],
  ): RegistrationVerdict {
    if (declared.length > MAX_TOOLS_PER_RUN) {
      return {
        ok: false,
        code: 'invalid-registration',
        detail: `the declaration has ${declared.length} tools;`
          + ` at most ${MAX_TOOLS_PER_RUN} are registrable per run`,
      };
    }

    // Validate the whole declaration before anything moves: shape, names,
    // collisions (reserved, duplicate, cross-run) and the schema dialect.
    const seen = new Set<string>();
    const collisions: string[] = [];
    let surfaceBytes = 0;
    for (const [index, entry] of declared.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return {
          ok: false,
          code: 'invalid-registration',
          detail: `tool ${index} must be a JSON object`,
        };
      }
      const keys = Object.keys(entry);
      for (const key of keys) {
        if (key !== 'name' && key !== 'description' && key !== 'parameters') {
          return {
            ok: false,
            code: 'invalid-registration',
            detail: `tool ${index} carries the field ${JSON.stringify(key)};`
              + ' a declaration is exactly {name, description, parameters}'
              + ' (the handler stays in the child)',
          };
        }
      }
      const { name, description, parameters } = entry as DeclaredTool;
      if (!validToolName(name)) {
        return {
          ok: false,
          code: 'invalid-registration',
          detail: `tool ${index}'s name is not 1-${MAX_PACKAGE_NAME_CHARS}`
            + ' well-formed characters without separators, NUL, a leading dot,'
            + ' or "."/".."',
        };
      }
      if (RESERVED.has(name) || seen.has(name) || byName.has(name)) {
        collisions.push(name);
        continue;
      }
      seen.add(name);
      if (typeof description !== 'string' || description.length < 1
        || description.length > MAX_PACKAGE_PURPOSE_CHARS) {
        return {
          ok: false,
          code: 'invalid-registration',
          detail: `tool ${index}'s description must be 1-${MAX_PACKAGE_PURPOSE_CHARS} characters`,
        };
      }
      const dialect = schemaDialectError(parameters, `tool ${index}'s parameters`);
      if (dialect !== null) {
        return { ok: false, code: 'invalid-registration', detail: dialect };
      }
      // The funnel's one shape rule, made a registration rule (the friction pass): the
      // invoked arguments are one JSON object, so the declared root must be
      // one — a scalar- or array-rooted tool could never be called through
      // the funnel, and the native bridge holds the funnel's own shapes.
      if (typeof parameters !== 'object' || parameters === null
        || Array.isArray(parameters)
        || (parameters as Record<string, unknown>)['type'] !== 'object') {
        return {
          ok: false,
          code: 'invalid-registration',
          detail: `tool ${index}'s parameters must have root type "object"`
            + ' — the invoked arguments are one JSON object',
        };
      }
      const schemaBytes = canonicalBytes(parameters);
      if (schemaBytes > MAX_TOOL_SCHEMA_BYTES) {
        return {
          ok: false,
          code: 'invalid-registration',
          detail: `tool ${index}'s schema is ${schemaBytes} bytes;`
            + ` at most ${MAX_TOOL_SCHEMA_BYTES} are registrable`,
        };
      }
      surfaceBytes += canonicalBytes(name as JsonValue)
        + canonicalBytes(description as unknown as JsonValue) + schemaBytes;
    }
    if (collisions.length > 0) {
      return { ok: false, code: 'name-conflict', names: collisions };
    }
    if (surfaceBytes > MAX_DECLARED_SURFACE_BYTES) {
      return {
        ok: false,
        code: 'invalid-registration',
        detail: `the declaration is ${surfaceBytes} bytes of surface;`
          + ` at most ${MAX_DECLARED_SURFACE_BYTES} keep the catalogue text`,
      };
    }
    // The whole declaration is valid before the one-live-run rule is applied:
    // the refusal names the first real problem, and the supervisor owns the
    // spawn-time busy check (design §2's run/busy is the verb's refusal).
    if (live !== null) return { ok: false, code: 'busy' };

    // Acceptance: every tool lands, and each lands its effect fact.
    for (const entry of declared) {
      const registered: RegisteredTool = {
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
        runId,
        packageId,
      };
      byName.set(entry.name, registered);
      events.effect({
        id: packageId, runId, kind: 'tool-registered', tool: entry.name,
      });
    }
    live = runId;
    return { ok: true };
  }

  function unregisterRun(runId: string): void {
    if (live !== runId) return;
    for (const [name, tool] of byName) {
      if (tool.runId === runId) byName.delete(name);
    }
    live = null;
  }

  function lookup(name: string): RegisteredTool | null {
    return byName.get(name) ?? null;
  }

  function tools(): readonly RegisteredTool[] {
    return [...byName.values()];
  }

  function liveRunId(): string | null {
    return live;
  }

  return { registerRun, unregisterRun, lookup, tools, liveRunId };
}
