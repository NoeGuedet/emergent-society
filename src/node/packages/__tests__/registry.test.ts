import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../journal/index.js';
import {
  createRunRegistry,
  type DeclaredTool,
  type RegistrationRefusal,
  type RegistrationVerdict,
} from '../registry.js';

/**
 * The live runtime registry (kernel.md, the local-log sections): the
 * transactional, collision-checked home of every tool a running Package
 * registers. Validation happens before any spawn-visible effect — the
 * registry never moves half-registered — and every accepted tool appends
 * its `package/effect` fact through the injected port. Pure and
 * model-agnostic: static name lists, no dispatch dependency.
 */

const PKG = 'a'.repeat(64);

function tool(over: Partial<DeclaredTool> = {}): DeclaredTool {
  return {
    name: 'grep_world',
    description: 'search the world files',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', minLength: 1 } },
      required: ['pattern'],
      additionalProperties: false,
    },
    ...over,
  };
}

function registry() {
  const effects: { id: string; runId: string; kind: string; tool: string }[] = [];
  const reg = createRunRegistry({
    effect: (payload) => { effects.push(payload); },
  });
  return { reg, effects };
}

function refusal(value: RegistrationVerdict): RegistrationRefusal {
  expect(value).toMatchObject({ ok: false });
  return value as { ok: false } & RegistrationRefusal;
}

describe('run registry: registration acceptance', () => {
  it('registers a valid declaration and appends one effect per tool', () => {
    const { reg, effects } = registry();
    const runId = 'b'.repeat(32);
    const verdict = reg.registerRun(PKG, runId, [
      tool({ name: 'alpha' }),
      tool({ name: 'beta' }),
    ]);
    expect(verdict).toEqual({ ok: true });
    expect(reg.lookup('alpha')).toMatchObject({ name: 'alpha', runId, packageId: PKG });
    expect(reg.lookup('beta')).not.toBeNull();
    expect(effects).toEqual([
      { id: PKG, runId, kind: 'tool-registered', tool: 'alpha' },
      { id: PKG, runId, kind: 'tool-registered', tool: 'beta' },
    ]);
  });

  it('accepts a zero-tool declaration (inert but honest)', () => {
    const { reg, effects } = registry();
    expect(reg.registerRun(PKG, 'b'.repeat(32), [])).toEqual({ ok: true });
    expect(effects).toEqual([]);
    expect(reg.tools()).toEqual([]);
  });

  it('accepts every scalar type and each dialect keyword', () => {
    const { reg } = registry();
    const verdict = reg.registerRun(PKG, 'b'.repeat(32), [tool({
      name: 'typed',
      parameters: {
        type: 'object',
        properties: {
          s: { type: 'string', minLength: 1 },
          n: { type: 'number', maximum: 10 },
          i: { type: 'integer', maximum: 3 },
          b: { type: 'boolean' },
          a: { type: 'array' },
          nested: {
            type: 'object',
            properties: { inner: { type: 'string' } },
            required: ['inner'],
            additionalProperties: false,
          },
        },
        required: ['s'],
      },
    })]);
    expect(verdict).toEqual({ ok: true });
  });
});

describe('run registry: name collisions (never half-registered)', () => {
  const COLLIDING = [
    'execute', 'wait', 'web_search', 'web_fetch', 'extend',
    'inspect', 'define', 'run', 'call', 'stop', 'undefine', 'verb',
    'spawn', 'speak',
  ];

  it.each(COLLIDING)('refuses the reserved name %s', (name) => {
    const { reg, effects } = registry();
    const verdict = refusal(reg.registerRun(PKG, 'b'.repeat(32), [tool({ name })]));
    expect(verdict.code).toBe('name-conflict');
    expect(reg.lookup(name)).toBeNull();
    expect(effects).toEqual([]);
  });

  it('refuses a collision with an already-registered name and lands nothing', () => {
    const { reg, effects } = registry();
    expect(reg.registerRun(PKG, 'b'.repeat(32), [tool({ name: 'mine' })])).toEqual({ ok: true });
    const verdict = refusal(reg.registerRun('c'.repeat(64), 'd'.repeat(32), [
      tool({ name: 'mine' }),
      tool({ name: 'fresh' }),
    ]));
    expect(verdict.code).toBe('name-conflict');
    expect(reg.lookup('fresh')).toBeNull();
    expect(effects).toHaveLength(1);
  });

  it('refuses a duplicate name inside one declaration', () => {
    const { reg, effects } = registry();
    const verdict = refusal(reg.registerRun(PKG, 'b'.repeat(32), [
      tool({ name: 'same' }), tool({ name: 'same' }),
    ]));
    expect(verdict.code).toBe('name-conflict');
    expect(effects).toEqual([]);
  });
});

describe('run registry: invalid registrations (the declaration bounds)', () => {
  it('refuses a malformed tool shape with a teaching detail', () => {
    const { reg } = registry();
    const verdict = refusal(reg.registerRun(PKG, 'b'.repeat(32), [
      { name: 'n', description: 'd', parameters: { type: 'object' }, handler: 1 },
    ] as never));
    expect(verdict.code).toBe('invalid-registration');
    if (verdict.code === 'invalid-registration') {
      expect(verdict.detail).toMatch(/handler/);
    }
  });

  it('refuses a bad tool name and an out-of-bound description', () => {
    const { reg } = registry();
    expect(refusal(reg.registerRun(PKG, 'b'.repeat(32), [tool({ name: 'bad/name' })]))
      .code).toBe('invalid-registration');
    expect(refusal(reg.registerRun(PKG, 'b'.repeat(32), [tool({ name: '.dot' })]))
      .code).toBe('invalid-registration');
    expect(refusal(reg.registerRun(PKG, 'b'.repeat(32), [
      tool({ description: 'x'.repeat(513) }),
    ])).code).toBe('invalid-registration');
  });

  it('refuses more than 32 tools', () => {
    const { reg } = registry();
    const many = Array.from({ length: 33 }, (_, i) => tool({ name: `t${i}` }));
    expect(refusal(reg.registerRun(PKG, 'b'.repeat(32), many)).code)
      .toBe('invalid-registration');
  });

  it('refuses a schema over 4 KiB and a declaration over the 48 KiB aggregate', () => {
    const { reg } = registry();
    // 4 KiB+ by repetition of many individually valid properties.
    const big: Record<string, JsonValue> = {};
    for (let i = 0; i < 200; i += 1) {
      big[`property_with_a_long_name_${i}`] = { type: 'string' };
    }
    const oversized: JsonValue = { type: 'object', properties: big };
    expect(refusal(reg.registerRun(PKG, 'b'.repeat(32), [
      tool({ name: 'big_schema', parameters: oversized }),
    ])).code).toBe('invalid-registration');

    // The aggregate: 24 tools x ~2 KiB schemas = ~48 KiB+ — over the bound while
    // each schema is individually legal.
    const quarter: Record<string, JsonValue> = {};
    for (let i = 0; i < 45; i += 1) {
      quarter[`p${i}`] = { type: 'string', minLength: 0, maximum: 9 };
    }
    const schema: JsonValue = { type: 'object', properties: quarter };
    // Each schema is individually legal (~2 KiB); twenty-four of them exceed
    // the 48 KiB aggregate while staying under the 32-tool count cap.
    const many = Array.from({ length: 24 }, (_, i) => tool({
      name: `wide${i}`, parameters: schema,
    }));
    expect(refusal(reg.registerRun(PKG, 'b'.repeat(32), many)).code)
      .toBe('invalid-registration');
  });

  it('refuses every schema outside the safe dialect', () => {
    const { reg } = registry();
    const outside = [
      { type: 'object', properties: { p: { type: 'string', pattern: '^a' } } },
      { type: 'object', properties: { p: { type: 'string' } }, allOf: [] },
      { type: 'object', properties: { p: { type: 'string' } }, anyOf: [] },
      { type: 'object', properties: { p: { type: 'string' } }, oneOf: [] },
      { type: 'object', properties: { p: { $ref: '#/x' } } },
      { type: 'object', properties: { p: { type: 'function' } } },
      { type: 'object', properties: 'not-an-object' },
      { type: 'object', properties: { p: { type: 'string' } }, required: 'pattern' },
      { type: 'object', properties: { p: { type: 'string' } }, required: ['absent'] },
      { type: 'object', properties: { p: { minLength: 'x' } } },
      { type: 'object', properties: { p: { maximum: 'x' } } },
      { type: 'object', properties: { p: { type: 'string' } }, additionalProperties: 'no' },
      { type: 42 },
      'not-an-object',
    ];
    for (const parameters of outside) {
      const verdict = refusal(reg.registerRun(PKG, 'b'.repeat(32), [
        tool({ name: 'dialect', parameters: parameters as never }),
      ]));
      expect(verdict.code, JSON.stringify(parameters)).toBe('invalid-registration');
    }
  });

  it('refuses parameters that are not a JSON object', () => {
    const { reg } = registry();
    expect(refusal(reg.registerRun(PKG, 'b'.repeat(32), [
      tool({ parameters: [1, 2] as never }),
    ])).code).toBe('invalid-registration');
  });

  it('refuses a schema whose root type is not object (the funnel shape, the friction pass)', () => {
    const { reg } = registry();
    // The invoked arguments are one JSON object — a scalar- or array-rooted
    // tool could never be called through the funnel, so it is refused at
    // registration, not discovered uncallable at dispatch.
    for (const parameters of [
      { type: 'string' },
      { type: 'integer' },
      { type: 'array' },
      { type: 'boolean' },
    ]) {
      const verdict = refusal(reg.registerRun(PKG, 'b'.repeat(32), [
        tool({ name: 'scalar_root', parameters: parameters as never }),
      ]));
      expect(verdict.code, JSON.stringify(parameters)).toBe('invalid-registration');
      expect(verdict.code === 'invalid-registration' ? verdict.detail : '',
        JSON.stringify(parameters)).toContain('root type "object"');
    }
  });
});

describe('run registry: the one-live-run rule', () => {
  it('refuses a second registration while a run is live', () => {
    const { reg } = registry();
    expect(reg.registerRun(PKG, 'b'.repeat(32), [tool()])).toEqual({ ok: true });
    // A fresh, collision-free declaration: the refusal is the live-run rule.
    expect(refusal(reg.registerRun('c'.repeat(64), 'd'.repeat(32), [
      tool({ name: 'other_tool' }),
    ])).code).toBe('busy');
    expect(reg.liveRunId()).toBe('b'.repeat(32));
  });

  it('unregisters the run and frees the single slot', () => {
    const { reg } = registry();
    expect(reg.registerRun(PKG, 'b'.repeat(32), [tool({ name: 'one' })])).toEqual({ ok: true });
    reg.unregisterRun('b'.repeat(32));
    expect(reg.lookup('one')).toBeNull();
    expect(reg.liveRunId()).toBeNull();
    expect(reg.registerRun('c'.repeat(64), 'd'.repeat(32), [tool({ name: 'one' })]))
      .toEqual({ ok: true });
  });

  it('unregistering an unknown run changes nothing', () => {
    const { reg } = registry();
    expect(() => reg.unregisterRun('e'.repeat(32))).not.toThrow();
  });

  it('tools() lists every registered tool with its owning run', () => {
    const { reg } = registry();
    reg.registerRun(PKG, 'b'.repeat(32), [tool({ name: 'one' }), tool({ name: 'two' })]);
    expect(reg.tools().map((t) => t.name).sort()).toEqual(['one', 'two']);
    expect(reg.tools().every((t) => t.runId === 'b'.repeat(32))).toBe(true);
  });
});
