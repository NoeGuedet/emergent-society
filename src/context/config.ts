import type { JsonValue } from '../journal/index.js';
import { canonicalBytes, toJson } from './artifacts.js';
import { validateProviderParameters } from './parameters.js';
import { createValidator } from './validate.js';
import type { AgentConfig, SeedPolicy, ToolSchema } from './contracts.js';

/**
 * The default, fully-expanded agent configuration (kernel.md §4, §1.4).
 *
 * This is factory content, not a replay constant: initial configuration is
 * journaled only when none exists, and a restart ignores a newly supplied one.
 * Every numeric limit is expanded here — defaults are never re-applied during
 * replay — and the value is deeply frozen so a caller cannot mutate the pin.
 */
export function defaultAgentConfig(): AgentConfig {
  return toJson({
    version: 1,
    charter: 'You act by writing in the shared world. Preserve durable knowledge in files.',
    heading: 'Work on the current shared direction.',
    model: 'mock-model',
    parameters: { temperature: 0 },
    allowedTools: ['execute', 'wait', 'web_search', 'web_fetch', 'extend'],
    tools: [
      {
        name: 'execute', description: 'Run a command in the shared world. The shell session persists across calls: working directory, exports and background jobs survive. A command that times out resets the session.',
        parameters: {
          type: 'object', properties: { cmd: { type: 'string', minLength: 1 } },
          required: ['cmd'], additionalProperties: false,
        },
      },
      {
        name: 'wait', description: 'Wait for a foreign world commit.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'web_search',
        description: 'Search the web through the kernel-mediated provider. Returns ranked results: title, url, snippet.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1 },
            max_results: { type: 'integer', minimum: 1, maximum: 20 },
          },
          required: ['query'], additionalProperties: false,
        },
      },
      {
        name: 'web_fetch',
        description: 'Fetch one web page through the kernel-mediated provider and return its extracted text. The url must be an absolute http(s) URL.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', minLength: 1 } },
          required: ['url'], additionalProperties: false,
        },
      },
      {
        name: 'extend',
        description: 'Manage this node\'s own capabilities. Six verbs: inspect (the live catalogue: tools, packages, caps, runtime honesty); define (store a Package: name, purpose, path of a source file in the world); run (activate a stored Package as a confined Run: its tools become callable); call (invoke a running Package tool by name with args — the funnel); stop (deactivate the running Run, reversible); undefine (delete a stored Package, irreversible).',
        parameters: {
          type: 'object',
          properties: {
            verb: {
              type: 'string',
              enum: ['inspect', 'define', 'run', 'call', 'stop', 'undefine'],
            },
            name: { type: 'string' },
            purpose: { type: 'string' },
            path: { type: 'string' },
            id: { type: 'string' },
            tool: { type: 'string' },
            args: { type: 'object' },
          },
          required: ['verb'], additionalProperties: false,
        },
      },
    ],
    policy: {
      stepsPerTurn: 8, compactAfterBytes: 262144, keepRecentGroups: 8,
      maxAttempts: 2, retryDelayMs: 250, requestTimeoutMs: 30000,
      shellTimeoutMs: 300000, killGraceMs: 200,
      maxCaptureBytes: 33554432, maxRequestBytes: 33554432,
      maxShellCaptureBytes: 16777216,
      maxDiffBytes: 32768, maxCommits: 4096, maxAssistantBytes: 32768,
      maxToolResultBytes: 65536, maxToolArgumentBytes: 262144, maxCallsPerResponse: 32,
    },
  }) as unknown as AgentConfig;
}

const MiB = 1024 * 1024;

/** The canonical configuration ceiling: an oversize config is refused, never journaled truncated. */
const MAX_CONFIG_BYTES = 32 * MiB;

function fail(message: string): never {
  throw new Error(`invalid agent configuration: ${message}`);
}

/**
 * The shared primitives, bound to this module's original vocabulary: the
 * configuration validator prefixes nothing at the root (`where === ''`) and
 * spells every other diagnostic as `<where>: <message>`.
 */
const v = createValidator((where, message) =>
  fail(where === '' ? message : `${where}: ${message}`));
const { record, onlyKeys, text, safeInt, array } = v;

function json(value: unknown, where: string): JsonValue {
  try {
    return toJson(value);
  } catch (err) {
    fail(`${where}: ${err instanceof Error ? err.message : 'not JSON'}`);
  }
}

/** The parameters block: the one shared provider-parameter contract, refused before acceptance. */
function providerParameters(value: unknown): { readonly [key: string]: JsonValue } {
  try {
    return validateProviderParameters(value);
  } catch (err) {
    return fail(`parameters: ${err instanceof Error ? err.message : 'invalid'}`);
  }
}

const POLICY_KEYS = [
  'stepsPerTurn', 'compactAfterBytes', 'keepRecentGroups', 'maxAttempts', 'retryDelayMs',
  'requestTimeoutMs', 'shellTimeoutMs', 'killGraceMs', 'maxCaptureBytes', 'maxRequestBytes',
  'maxShellCaptureBytes', 'maxDiffBytes', 'maxCommits', 'maxAssistantBytes',
  'maxToolResultBytes', 'maxToolArgumentBytes', 'maxCallsPerResponse',
] as const;

export function validateSeedPolicy(value: unknown, where = 'policy'): SeedPolicy {
  const o = record(value, where);
  onlyKeys(o, POLICY_KEYS, where);
  for (const key of POLICY_KEYS) if (!(key in o)) fail(`policy.${key}: missing`);
  return {
    stepsPerTurn: safeInt(o['stepsPerTurn'], 'policy.stepsPerTurn', 1),
    compactAfterBytes: safeInt(o['compactAfterBytes'], 'policy.compactAfterBytes', 1),
    keepRecentGroups: safeInt(o['keepRecentGroups'], 'policy.keepRecentGroups', 0),
    // Retry/timeout knobs are bounded above as well: a persisted 2^53-scale
    // attempt count would otherwise make the adapter retry without a deadline.
    maxAttempts: safeInt(o['maxAttempts'], 'policy.maxAttempts', 1, 32),
    retryDelayMs: safeInt(o['retryDelayMs'], 'policy.retryDelayMs', 0, 300_000),
    requestTimeoutMs: safeInt(o['requestTimeoutMs'], 'policy.requestTimeoutMs', 1, 300_000),
    shellTimeoutMs: safeInt(o['shellTimeoutMs'], 'policy.shellTimeoutMs', 1),
    killGraceMs: safeInt(o['killGraceMs'], 'policy.killGraceMs', 1),
    maxCaptureBytes: safeInt(o['maxCaptureBytes'], 'policy.maxCaptureBytes', 1, 32 * MiB),
    maxRequestBytes: safeInt(o['maxRequestBytes'], 'policy.maxRequestBytes', 1, 32 * MiB),
    maxShellCaptureBytes:
      safeInt(o['maxShellCaptureBytes'], 'policy.maxShellCaptureBytes', 1, 24 * MiB - 4096),
    maxDiffBytes: safeInt(o['maxDiffBytes'], 'policy.maxDiffBytes', 512, MiB),
    maxCommits: safeInt(o['maxCommits'], 'policy.maxCommits', 1, 4096),
    maxAssistantBytes: safeInt(o['maxAssistantBytes'], 'policy.maxAssistantBytes', 256, 256 * 1024),
    maxToolResultBytes: safeInt(o['maxToolResultBytes'], 'policy.maxToolResultBytes', 256, 256 * 1024),
    maxToolArgumentBytes: safeInt(o['maxToolArgumentBytes'], 'policy.maxToolArgumentBytes', 1, 256 * 1024),
    maxCallsPerResponse: safeInt(o['maxCallsPerResponse'], 'policy.maxCallsPerResponse', 1, 32),
  };
}

export function validateToolSchema(value: unknown, where: string): ToolSchema {
  const o = record(value, where);
  onlyKeys(o, ['name', 'description', 'parameters'], where);
  return {
    name: text(o['name'], `${where}.name`),
    description: text(o['description'], `${where}.description`, false),
    parameters: json(o['parameters'], `${where}.parameters`),
  };
}

/**
 * Validates an untrusted configuration value and returns a frozen JSON copy.
 * Every numeric field is checked against its recorded bound; the `parameters`
 * block is checked against the shared provider-parameter contract, so a config
 * whose parameters could not be sent is refused here rather than at wire time;
 * the whole value is bounded by the 32 MiB capture ceiling so an oversize config
 * is refused before it is accepted (the prior durable config stays in force).
 */
export function validateAgentConfig(value: unknown): AgentConfig {
  const o = record(value, '');
  onlyKeys(o, [
    'version', 'charter', 'heading', 'tools', 'allowedTools', 'model', 'parameters', 'policy',
  ], 'config');
  const version = safeInt(o['version'], 'version', 1);
  const charter = text(o['charter'], 'charter', false);
  const heading = text(o['heading'], 'heading', false);
  const model = text(o['model'], 'model');

  const tools = array(o['tools'], 'tools').map((tool, i) =>
    validateToolSchema(tool, `tools[${i}]`));
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) fail(`tools: duplicate name ${JSON.stringify(tool.name)}`);
    names.add(tool.name);
  }

  const allowedTools = array(o['allowedTools'], 'allowedTools').map((name, i) =>
    text(name, `allowedTools[${i}]`));
  const seen = new Set<string>();
  for (const name of allowedTools) {
    if (seen.has(name)) fail(`allowedTools: duplicate ${JSON.stringify(name)}`);
    seen.add(name);
    if (!names.has(name)) fail(`allowedTools: ${JSON.stringify(name)} is not offered`);
  }

  const parameters = providerParameters(o['parameters']);
  const policy = validateSeedPolicy(o['policy']);

  const config = { version, charter, heading, tools, allowedTools, model, parameters, policy };
  const size = canonicalBytes(config).length;
  if (size > MAX_CONFIG_BYTES) fail(`canonical size ${size} exceeds ${MAX_CONFIG_BYTES}`);
  return toJson(config) as unknown as AgentConfig;
}
