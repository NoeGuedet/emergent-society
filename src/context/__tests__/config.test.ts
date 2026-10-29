import { describe, expect, it } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../config.js';
import { validateProviderParameters } from '../parameters.js';
import type { SeedPolicy } from '../contracts.js';

const base = (): ReturnType<typeof defaultAgentConfig> => defaultAgentConfig();

/** A valid config with one policy field replaced, as an untrusted value. */
const withPolicy = (patch: Partial<SeedPolicy>): unknown => {
  const d = base();
  return { ...d, policy: { ...d.policy, ...patch } };
};

describe('defaultAgentConfig', () => {
  it('returns the fully expanded factory default', () => {
    expect(base()).toEqual({
      version: 1,
      charter: 'You act by writing in the shared world. Preserve durable knowledge in files. Your context is finite: it is compacted periodically and whatever you have not put outside it is lost. The heading is the boot seed; the living direction is the world\'s files.',
      heading: 'Work on the current shared direction.',
      model: 'mock-model',
      parameters: { temperature: 0 },
      allowedTools: ['execute', 'wait', 'web_search', 'web_fetch', 'extend'],
      tools: [
        {
          name: 'execute', description: 'Run a command in the shared world. The shell session persists across calls: working directory, exports and background jobs survive. A command that times out resets the session. By default the shell is confined (the operator may start or resume with the sandbox off, which changes the boundaries below): write access is limited to the world (your working directory), $TMPDIR and two writable devices (/dev/null, /dev/tty); reads additionally cover /usr, /bin, /sbin, /lib*, a narrow /etc set, /proc and the remaining devices. /, /home, /var and the rest of the cell home are denied. Egress is open by decision: the shell can reach the network, and those exchanges are not journaled — the frontier records kernel-mediated calls only. The world\'s git metadata lives outside your worktree: a plain git in the world cannot see the world\'s history, and a .git you create is ignored and never staged — use ls and cat to explore the world.',
          parameters: {
            type: 'object', properties: { cmd: { type: 'string', minLength: 1 } },
            required: ['cmd'], additionalProperties: false,
          },
        },
        {
          name: 'wait',
          description: 'End the turn and park until a foreign world commit lands (a commit you did not author; your own commits never wake you). Costs no tokens while parked. The next turn opens with a bounded patch view of the foreign commits since your last wake — read that first.',
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
          description: 'Manage this node\'s own capabilities. Six verbs: inspect (the live catalogue: tools, packages, caps, runtime honesty); define (store a Package: name, purpose, path of a source file in the world — define parses the source and stores it; run validates the registration); run (activate a stored Package as a Run: its tools become callable — address it by name or id; a name resolves to the latest stored version); call (invoke a running Package tool with args — through the funnel, or by its bare name); stop (deactivate the live Run — by its package\'s name or id, or by nothing: the Run is a singleton, so a bare stop names it, reversible); undefine (delete a stored Package by name or id, irreversible). A Package source is plain JavaScript evaluated as an async function body: it must return exactly {tools:[{name, description, parameters, handler}]} (handler a function; parameters in the safe schema dialect — type/properties/required/minLength/maximum/additionalProperties, every node carries a type from object|array|string|number|integer|boolean, root type object). A handler is called as handler(args, svc): svc.execute(cmd) runs one command in the same persistent shell the execute tool uses — a completed command resolves {status, exitCode, output}, any other outcome rejects with a bounded JSON error; svc.web_search(query, maxResults?) and svc.web_fetch(url) make the same kernel-mediated calls as the base tools and resolve {body}, rejecting on failure. A Run is in-memory: a restart reaps it — the stored Package survives, so run it again. inspect lists the caps.',
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
    });
  });

  it('returns a fresh, deeply frozen copy each call', () => {
    const first = base();
    const second = base();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.policy)).toBe(true);
    expect(Object.isFrozen(first.tools)).toBe(true);
    expect(Object.isFrozen(first.tools[0])).toBe(true);
  });
});

describe('validateAgentConfig', () => {
  it('accepts the default configuration', () => {
    expect(validateAgentConfig(base())).toEqual(base());
  });

  it('rejects a missing or malformed shape', () => {
    expect(() => validateAgentConfig(null)).toThrow();
    expect(() => validateAgentConfig({})).toThrow();
    expect(() => validateAgentConfig({ ...base(), version: 0 })).toThrow();
    expect(() => validateAgentConfig({ ...base(), version: 1.5 })).toThrow();
    expect(() => validateAgentConfig({ ...base(), charter: 3 })).toThrow();
    expect(() => validateAgentConfig({ ...base(), heading: 3 })).toThrow();
    expect(() => validateAgentConfig({ ...base(), model: '' })).toThrow();
    expect(() => validateAgentConfig({ ...base(), parameters: [] })).toThrow();
  });

  it('rejects undefined or non-finite numbers anywhere in the JSON', () => {
    expect(() => validateAgentConfig({ ...base(), parameters: { temperature: Number.NaN } }))
      .toThrow();
    expect(() => validateAgentConfig({ ...base(), parameters: { temperature: Infinity } }))
      .toThrow();
    expect(() => validateAgentConfig({ ...base(), parameters: { temperature: undefined } }))
      .toThrow();
  });

  it('rejects duplicate or unknown tool names and a bad allowlist', () => {
    const d = base();
    expect(() => validateAgentConfig({ ...d, tools: [d.tools[0], d.tools[0]] })).toThrow();
    expect(() => validateAgentConfig({ ...d, tools: [{ ...d.tools[0], name: '' }] })).toThrow();
    expect(() => validateAgentConfig({ ...d, allowedTools: ['execute', 'execute'] })).toThrow();
    expect(() => validateAgentConfig({ ...d, allowedTools: ['execute', 'not-a-tool'] })).toThrow();
  });

  it('enforces positive step/attempt/time limits', () => {
    expect(() => validateAgentConfig(withPolicy({ stepsPerTurn: 0 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ stepsPerTurn: -1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxAttempts: 0 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ requestTimeoutMs: 0 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ shellTimeoutMs: 0 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ killGraceMs: 0 }))).toThrow();
    // retryDelay and keepRecentGroups allow zero.
    expect(() => validateAgentConfig(withPolicy({ retryDelayMs: 0 }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ keepRecentGroups: 0 }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ retryDelayMs: -1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ keepRecentGroups: -1 }))).toThrow();
  });

  it('bounds the retry and timeout knobs above', () => {
    // Bounds are inclusive; one past is refused, so a persisted policy cannot
    // approach 2^53 attempts or retry without an overall deadline.
    expect(() => validateAgentConfig(withPolicy({ maxAttempts: 32 }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxAttempts: 33 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxAttempts: 2 ** 53 - 1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ retryDelayMs: 300_000 }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ retryDelayMs: 300_001 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ requestTimeoutMs: 300_000 }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ requestTimeoutMs: 300_001 }))).toThrow();
  });

  it('enforces capture, request and shell capture ceilings', () => {
    const MiB = 1024 * 1024;
    expect(() => validateAgentConfig(withPolicy({ maxCaptureBytes: 32 * MiB }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxCaptureBytes: 32 * MiB + 1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxRequestBytes: 32 * MiB + 1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxShellCaptureBytes: 24 * MiB - 4096 })))
      .not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxShellCaptureBytes: 24 * MiB - 4095 })))
      .toThrow();
  });

  it('enforces diff, assistant, tool result, argument, calls and commit bounds', () => {
    expect(() => validateAgentConfig(withPolicy({ maxDiffBytes: 511 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxDiffBytes: 512 }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxDiffBytes: 1024 * 1024 + 1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxAssistantBytes: 255 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxAssistantBytes: 256 }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxAssistantBytes: 256 * 1024 + 1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxToolResultBytes: 255 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxToolResultBytes: 256 * 1024 + 1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxToolArgumentBytes: 0 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxToolArgumentBytes: 256 * 1024 + 1 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxCallsPerResponse: 0 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxCallsPerResponse: 33 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxCommits: 0 }))).toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxCommits: 4096 }))).not.toThrow();
    expect(() => validateAgentConfig(withPolicy({ maxCommits: 4097 }))).toThrow();
  });

  it('the retired drain knob is refused', () => {
    const defaults = defaultAgentConfig();
    const retired = { ...defaults, policy: { ...defaults.policy, shellDrainMs: 500 } };
    expect(() => validateAgentConfig(retired)).toThrow(/unexpected key/);
  });

  it('rejects an oversize configuration before it is accepted', () => {
    const d = base();
    const oversize = { ...d, charter: 'c'.repeat(32 * 1024 * 1024 + 1) };
    expect(() => validateAgentConfig(oversize)).toThrow();
  });
});

describe('provider parameters: the config boundary', () => {
  /** A valid config with its parameters replaced, as an untrusted value. */
  const withParameters = (parameters: unknown): unknown => ({ ...base(), parameters });

  const INVALID: ReadonlyArray<readonly [string, unknown]> = [
    ['reserved n', { n: 2 }],
    ['reserved stream', { stream: true }],
    ['unknown foo', { foo: 1 }],
    ['temperature above 2', { temperature: 3 }],
    ['temperature below 0', { temperature: -0.1 }],
    ['top_p above 1', { top_p: 2 }],
    ['max_tokens zero', { max_tokens: 0 }],
    ['max_tokens fractional', { max_tokens: 1.5 }],
    ['stop as a number', { stop: 7 }],
    ['stop with too many strings', { stop: ['a', 'b', 'c', 'd', 'e'] }],
    ['stop as an empty array', { stop: [] }],
  ];

  it.each(INVALID)('rejects %s before the config is accepted', (_name, parameters) => {
    expect(() => validateAgentConfig(withParameters(parameters))).toThrow();
  });

  it('accepts the exact boundary values as a frozen canonical copy', () => {
    const value = { temperature: 2, top_p: 1, max_tokens: 1, stop: ['a', 'b', 'c', 'd'] };
    const config = validateAgentConfig(withParameters(value));
    expect(config.parameters).toEqual(value);
    expect(Object.isFrozen(config.parameters)).toBe(true);
  });

  it('shares one decision with direct parameter validation', () => {
    for (const [, parameters] of INVALID) {
      expect(() => validateProviderParameters(parameters)).toThrow();
    }
    expect(validateProviderParameters({ temperature: 0 })).toEqual({ temperature: 0 });
    expect(() => validateProviderParameters([])).toThrow();
    expect(() => validateProviderParameters(null)).toThrow();
  });
});
