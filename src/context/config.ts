import type { JsonValue } from '../journal/index.js';
import { canonicalBytes, toJson } from './artifacts.js';
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
    allowedTools: ['execute', 'wait'],
    tools: [
      {
        name: 'execute', description: 'Run a foreground command in the shared world.',
        parameters: {
          type: 'object', properties: { cmd: { type: 'string', minLength: 1 } },
          required: ['cmd'], additionalProperties: false,
        },
      },
      {
        name: 'wait', description: 'Wait for a foreign world commit.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    policy: {
      stepsPerTurn: 8, compactAfterBytes: 262144, keepRecentGroups: 8,
      maxAttempts: 2, retryDelayMs: 250, requestTimeoutMs: 30000,
      shellTimeoutMs: 60000, killGraceMs: 200,
      maxCaptureBytes: 33554432, maxRequestBytes: 33554432,
      maxShellCaptureBytes: 16777216, shellDrainMs: 500,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects any key outside `allowed`, so a boundary payload cannot smuggle extra shape. */
function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${where}: unexpected key ${JSON.stringify(key)}`);
  }
}

function safeInt(
  value: unknown, where: string, min: number, max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${where}: expected a safe integer in [${min}, ${max}]`);
  }
  return value as number;
}

function nonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${where}: expected a nonempty string`);
  return value as string;
}

function json(value: unknown, where: string): JsonValue {
  try {
    return toJson(value);
  } catch (err) {
    fail(`${where}: ${err instanceof Error ? err.message : 'not JSON'}`);
  }
}

const POLICY_KEYS = [
  'stepsPerTurn', 'compactAfterBytes', 'keepRecentGroups', 'maxAttempts', 'retryDelayMs',
  'requestTimeoutMs', 'shellTimeoutMs', 'killGraceMs', 'maxCaptureBytes', 'maxRequestBytes',
  'maxShellCaptureBytes', 'shellDrainMs', 'maxDiffBytes', 'maxCommits', 'maxAssistantBytes',
  'maxToolResultBytes', 'maxToolArgumentBytes', 'maxCallsPerResponse',
] as const;

export function validateSeedPolicy(value: unknown, where = 'policy'): SeedPolicy {
  if (!isRecord(value)) fail(`${where}: expected an object`);
  onlyKeys(value, POLICY_KEYS, where);
  for (const key of POLICY_KEYS) if (!(key in value)) fail(`policy.${key}: missing`);
  return {
    stepsPerTurn: safeInt(value['stepsPerTurn'], 'policy.stepsPerTurn', 1),
    compactAfterBytes: safeInt(value['compactAfterBytes'], 'policy.compactAfterBytes', 1),
    keepRecentGroups: safeInt(value['keepRecentGroups'], 'policy.keepRecentGroups', 0),
    maxAttempts: safeInt(value['maxAttempts'], 'policy.maxAttempts', 1),
    retryDelayMs: safeInt(value['retryDelayMs'], 'policy.retryDelayMs', 0),
    requestTimeoutMs: safeInt(value['requestTimeoutMs'], 'policy.requestTimeoutMs', 1),
    shellTimeoutMs: safeInt(value['shellTimeoutMs'], 'policy.shellTimeoutMs', 1),
    killGraceMs: safeInt(value['killGraceMs'], 'policy.killGraceMs', 1),
    maxCaptureBytes: safeInt(value['maxCaptureBytes'], 'policy.maxCaptureBytes', 1, 32 * MiB),
    maxRequestBytes: safeInt(value['maxRequestBytes'], 'policy.maxRequestBytes', 1, 32 * MiB),
    maxShellCaptureBytes:
      safeInt(value['maxShellCaptureBytes'], 'policy.maxShellCaptureBytes', 1, 24 * MiB - 4096),
    shellDrainMs: safeInt(value['shellDrainMs'], 'policy.shellDrainMs', 1, 60000),
    maxDiffBytes: safeInt(value['maxDiffBytes'], 'policy.maxDiffBytes', 512, MiB),
    maxCommits: safeInt(value['maxCommits'], 'policy.maxCommits', 1, 4096),
    maxAssistantBytes: safeInt(value['maxAssistantBytes'], 'policy.maxAssistantBytes', 256, 256 * 1024),
    maxToolResultBytes: safeInt(value['maxToolResultBytes'], 'policy.maxToolResultBytes', 256, 256 * 1024),
    maxToolArgumentBytes: safeInt(value['maxToolArgumentBytes'], 'policy.maxToolArgumentBytes', 1, 256 * 1024),
    maxCallsPerResponse: safeInt(value['maxCallsPerResponse'], 'policy.maxCallsPerResponse', 1, 32),
  };
}

export function validateToolSchema(value: unknown, where: string): ToolSchema {
  if (!isRecord(value)) fail(`${where}: expected an object`);
  onlyKeys(value, ['name', 'description', 'parameters'], where);
  return {
    name: nonEmptyString(value['name'], `${where}.name`),
    description: typeof value['description'] === 'string'
      ? (value['description'] as string)
      : fail(`${where}.description: expected a string`),
    parameters: json(value['parameters'], `${where}.parameters`),
  };
}

/**
 * Validates an untrusted configuration value and returns a frozen JSON copy.
 * Every numeric field is checked against its recorded bound; the whole value is
 * bounded by the 32 MiB capture ceiling so an oversize config is refused before
 * it is accepted (the prior durable config stays in force).
 */
export function validateAgentConfig(value: unknown): AgentConfig {
  if (!isRecord(value)) fail('expected an object');
  onlyKeys(value, [
    'version', 'charter', 'heading', 'tools', 'allowedTools', 'model', 'parameters', 'policy',
  ], 'config');
  const version = safeInt(value['version'], 'version', 1);
  const charter = typeof value['charter'] === 'string'
    ? (value['charter'] as string) : fail('charter: expected a string');
  const heading = typeof value['heading'] === 'string'
    ? (value['heading'] as string) : fail('heading: expected a string');
  const model = nonEmptyString(value['model'], 'model');

  if (!Array.isArray(value['tools'])) fail('tools: expected an array');
  const tools = (value['tools'] as unknown[]).map((tool, i) =>
    validateToolSchema(tool, `tools[${i}]`));
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) fail(`tools: duplicate name ${JSON.stringify(tool.name)}`);
    names.add(tool.name);
  }

  if (!Array.isArray(value['allowedTools'])) fail('allowedTools: expected an array');
  const allowedTools = (value['allowedTools'] as unknown[]).map((name, i) =>
    nonEmptyString(name, `allowedTools[${i}]`));
  const seen = new Set<string>();
  for (const name of allowedTools) {
    if (seen.has(name)) fail(`allowedTools: duplicate ${JSON.stringify(name)}`);
    seen.add(name);
    if (!names.has(name)) fail(`allowedTools: ${JSON.stringify(name)} is not offered`);
  }

  const parameters = json(value['parameters'], 'parameters');
  if (!isRecord(parameters)) fail('parameters: expected an object');
  const policy = validateSeedPolicy(value['policy']);

  const config = { version, charter, heading, tools, allowedTools, model, parameters, policy };
  const size = canonicalBytes(config).length;
  if (size > MAX_CONFIG_BYTES) fail(`canonical size ${size} exceeds ${MAX_CONFIG_BYTES}`);
  return toJson(config) as unknown as AgentConfig;
}
