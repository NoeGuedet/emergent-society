import { describe, expect, it } from 'vitest';
import { defaultAgentConfig, validateAgentConfig } from '../../context/config.js';
import type { AgentConfig } from '../../context/contracts.js';
import { MAX_CAPTURE_BYTES } from '../gate.js';
import { DIRECTION_MAX_BYTES } from '../direction.js';
import { MAX_COMPACTION_SOURCES } from '../../context/groups.js';
import { substrateText } from '../../context/assembler.js';
import {
  AUTHORED_IDENTITY_RE, composerOf, identitySentence, ownIdentitySentenceRe,
  stripAuthoredIdentity,
} from '../identity.js';
import {
  ESCAPE_FACTOR, FACTORY_KEEP_RECENT_GROUPS, IDENTITY_FLOOR, PLAN_MARGIN,
  PLAN_MARGIN_SLACK_BYTES, SOURCE_RECEIPT_BYTES, assertSendableIdentity,
  effectiveCeiling, identityBudget, identityBytes, reserve,
} from '../identity-budget.js';
import {
  SelfRefusedError, createSelfPort, renewedIdentityConfig,
} from '../self.js';
import { canonicalBytes } from '../../context/artifacts.js';
import { METER_CHARS_PER_TOKEN, meterThreshold } from '../../context/meter.js';

/**
 * The identity vocabulary (plan §0.5 and §0.8): the two sentence patterns, the
 * renew composition, and the identity-budget arithmetic — the factory /
 * uncapped / degenerate bands computed through the exported functions instead
 * of restated. The budget is admission-only: `validateAgentConfig` is untouched,
 * so an old-rules configuration still validates here.
 */

const MiB = 1024 * 1024;

/** A factory config with one policy field replaced. */
function withPolicy(patch: Partial<AgentConfig['policy']>): AgentConfig {
  const base = defaultAgentConfig();
  return validateAgentConfig({ ...base, policy: { ...base.policy, ...patch } });
}

describe('identity sentences: the two named patterns', () => {
  it('strips ANY trailing identity sentence with the authored-strip pattern', () => {
    expect(stripAuthoredIdentity('base You are alice.')).toBe('base');
    expect(stripAuthoredIdentity('base You are a.b-c_9.')).toBe('base');
    expect(stripAuthoredIdentity('base You are a.b-c_9, composed by x.y.')).toBe('base');
    expect(stripAuthoredIdentity(' You are alice.')).toBe('');
    // Only a TRAILING sentence is an identity sentence: mid-text prose stays.
    expect(stripAuthoredIdentity('You are alice.\nmore')).toBe('You are alice.\nmore');
    // The grammar is the uid grammar, not a word soup: spaces never match.
    expect(stripAuthoredIdentity('You are not a uid.')).toBe('You are not a uid.');
    expect(AUTHORED_IDENTITY_RE.test('base You are node-4, composed by node-0.'))
      .toBe(true);
    // Trailing whitespace (a world file's newline) never defeats the strip.
    expect(stripAuthoredIdentity('base You are alice.\n')).toBe('base');
    expect(stripAuthoredIdentity('base You are a.b, composed by x.y.\n \t')).toBe('base');
  });

  it('matches only this node\'s own sentence and extracts its composer', () => {
    const own = ownIdentitySentenceRe('node-1');
    expect(own.test('base You are node-1.')).toBe(true);
    expect(own.test('base You are node-1, composed by node-0.')).toBe(true);
    expect(own.test('base You are node-12.')).toBe(false);
    expect(own.test('base You are node-12, composed by node-0.')).toBe(false);
    // The uid is regex-escaped: a '.' in a custom uid is not a wildcard.
    expect(ownIdentitySentenceRe('a.b').test('base You are aXb.')).toBe(false);
    expect(composerOf('base You are node-1, composed by node-0.', 'node-1')).toBe('node-0');
    expect(composerOf('base You are node-1, composed by node-0.\n', 'node-1')).toBe('node-0');
    expect(composerOf('base You are node-1.', 'node-1')).toBeNull();
    expect(composerOf('base You are node-2, composed by node-0.', 'node-1')).toBeNull();
  });

  it('stamps the boot and composer sentences exactly', () => {
    expect(identitySentence('node-1')).toBe(' You are node-1.');
    expect(identitySentence('node-1', 'node-0')).toBe(' You are node-1, composed by node-0.');
    expect('base' + identitySentence('a.b-c_9', 'x.y')).toBe('base You are a.b-c_9, composed by x.y.');
  });
});

describe('renew: the identity rewrite', () => {
  const base = (): AgentConfig => validateAgentConfig({
    ...defaultAgentConfig(), heading: 'seed heading', charter: 'base You are n1.',
  });

  it('applies only the named fields, bumps the version by one, keeps capabilities', () => {
    const current = base();
    const next = renewedIdentityConfig(current, 'n1', { heading: 'new heading' });
    expect(next.version).toBe(current.version + 1);
    expect(next.heading).toBe('new heading');
    expect(next.charter).toBe(current.charter);
    expect(next.model).toBe(current.model);
    expect(next.tools).toEqual(current.tools);
    expect(next.allowedTools).toEqual(current.allowedTools);
    expect(next.policy).toEqual(current.policy);
    expect(next.parameters).toEqual(current.parameters);
  });

  it('strips any authored sentence from a world charter and re-stamps its own', () => {
    const next = renewedIdentityConfig(base(), 'n1', {
      charter: 'a world charter You are node-9.',
    });
    expect(next.charter).toBe('a world charter You are n1.');
    // No stacking even when the authored sentence names another node.
    expect(next.charter.match(/You are /g)).toHaveLength(1);
  });

  it('preserves the composer suffix across a rewrite (kinship survives)', () => {
    const current = renewedIdentityConfig(
      validateAgentConfig({ ...defaultAgentConfig(), charter: 'base You are node-1.' }),
      'node-1', {},
    );
    // The composed child, then a rewrite from the composed identity.
    const composed = validateAgentConfig({
      ...current, version: current.version + 1,
      charter: 'base You are node-1, composed by node-0.',
    });
    const next = renewedIdentityConfig(composed, 'node-1', { charter: 'rewritten' });
    expect(next.charter).toBe('rewritten You are node-1, composed by node-0.');
    expect(composerOf(next.charter, 'node-1')).toBe('node-0');
  });

  it('increases the version strictly across two rewrites in one turn', () => {
    const first = renewedIdentityConfig(base(), 'n1', { heading: 'one' });
    const second = renewedIdentityConfig(first, 'n1', { heading: 'two' });
    expect([first.version, second.version]).toEqual([2, 3]);
    expect(second.heading).toBe('two');
  });

  it('accepts a model rewrite and refutes no capability change', () => {
    const next = renewedIdentityConfig(base(), 'n1', { model: 'model-b' });
    expect(next.model).toBe('model-b');
    expect(() => renewedIdentityConfig(base(), 'n1', {})).not.toThrow();
  });

  it('still validates the whole config (a bad value is a typed refusal)', () => {
    const current = base();
    expect(() => renewedIdentityConfig(current, 'n1', { model: '' })).toThrow();
  });
});

describe('the identity budget: constants and the arithmetic', () => {
  it('pins the constants and PLAN_MARGIN from the kernel maxima', () => {
    expect(IDENTITY_FLOOR).toBe(256 * 1024);
    expect(ESCAPE_FACTOR).toBe(6);
    // The factory policy is the accounting base of §0.5.
    expect(defaultAgentConfig().policy.keepRecentGroups).toBe(FACTORY_KEEP_RECENT_GROUPS);
    expect(MAX_COMPACTION_SOURCES).toBe(4096);
    // Receipts: 8 × 4096 × ~96 canonical bytes = 3 MiB, plus the slack.
    expect(FACTORY_KEEP_RECENT_GROUPS * MAX_COMPACTION_SOURCES * SOURCE_RECEIPT_BYTES)
      .toBe(3 * MiB);
    expect(PLAN_MARGIN_SLACK_BYTES).toBe(1 * MiB);
    expect(PLAN_MARGIN).toBe(4 * MiB);
    // The nominal per-Source figure is a real strict upper bound for an
    // ordinary receipt; a maximal seq costs a few more bytes, covered by slack.
    const receipt = canonicalBytes({ seq: 4_096, hash: 'f'.repeat(64) });
    expect(receipt.length).toBeLessThan(SOURCE_RECEIPT_BYTES);
  });

  it('the factory policy collapses the budget to the floor and it is positive', () => {
    const config = defaultAgentConfig();
    const ceiling = effectiveCeiling(config);
    expect(ceiling).toBe(MAX_CAPTURE_BYTES);
    // The factory reserve (≈ 97.5 MiB + fixed terms) exceeds the ceiling.
    expect(reserve(config)).toBeGreaterThan(ceiling);
    expect(identityBudget(config)).toBe(IDENTITY_FLOOR);
    expect(identityBudget(config)).toBeGreaterThan(0);
  });

  it('a shrunk policy in the uncapped band follows C − reserve', () => {
    const config = withPolicy({
      maxRequestBytes: 8 * MiB, compactAfterBytes: 64 * 1024, keepRecentGroups: 2,
      maxCallsPerResponse: 4, maxToolResultBytes: 4096, maxAssistantBytes: 1024,
    });
    const ceiling = effectiveCeiling(config);
    // The premise of the uncapped band: the reserve leaves room above the floor.
    expect(reserve(config)).toBeLessThanOrEqual(ceiling - IDENTITY_FLOOR);
    expect(identityBudget(config)).toBe(ceiling - reserve(config));
    expect(identityBudget(config)).toBeGreaterThan(IDENTITY_FLOOR);
    // The reserve's history term is the caps branch here, not compactAfterBytes.
    const policy = config.policy;
    const caps = (policy.keepRecentGroups * policy.maxCallsPerResponse
      * policy.maxToolResultBytes + policy.keepRecentGroups * policy.maxAssistantBytes)
      * ESCAPE_FACTOR;
    expect(caps).toBeGreaterThan(policy.compactAfterBytes);
  });

  it('the compactAfterBytes-dominant branch sizes the history term', () => {
    const config = withPolicy({
      maxRequestBytes: 8 * MiB, compactAfterBytes: 3 * MiB, keepRecentGroups: 2,
      maxCallsPerResponse: 1, maxToolResultBytes: 256, maxAssistantBytes: 256,
    });
    const history = Math.max(
      config.policy.compactAfterBytes,
      (config.policy.keepRecentGroups * config.policy.maxCallsPerResponse
        * config.policy.maxToolResultBytes
        + config.policy.keepRecentGroups * config.policy.maxAssistantBytes) * ESCAPE_FACTOR,
    );
    expect(history).toBe(config.policy.compactAfterBytes);
    expect(reserve(config)).toBeGreaterThan(history + PLAN_MARGIN + DIRECTION_MAX_BYTES);
  });

  it('the reserve is the sum of its five terms, the substrate only with a catalog', () => {
    const config = withPolicy({
      maxRequestBytes: 8 * MiB, compactAfterBytes: 64 * 1024, keepRecentGroups: 2,
      maxCallsPerResponse: 4, maxToolResultBytes: 4096, maxAssistantBytes: 1024,
    });
    const p = config.policy;
    const history = Math.max(
      p.compactAfterBytes,
      (p.keepRecentGroups * p.maxCallsPerResponse * p.maxToolResultBytes
        + p.keepRecentGroups * p.maxAssistantBytes) * ESCAPE_FACTOR,
    );
    const offering = canonicalBytes(
      [...config.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ).length;
    expect(reserve(config)).toBe(history + offering + DIRECTION_MAX_BYTES + PLAN_MARGIN);
    const models = [{ id: 'model-a' }, { id: 'model-b' }];
    expect(reserve(config, models))
      .toBe(reserve(config) + canonicalBytes(substrateText(models)).length);
    expect(reserve(config, [])).toBe(reserve(config) + canonicalBytes(substrateText([])).length);
  });

  it('a degenerate C ≤ floor collapses to C and refuses identities at or above C', () => {
    const config = withPolicy({ maxRequestBytes: 1024 });
    const ceiling = effectiveCeiling(config);
    expect(ceiling).toBe(1024);
    expect(identityBudget(config)).toBe(ceiling);
    // Below the bound: admitted.
    const small = validateAgentConfig({
      ...config, heading: '', charter: '', model: 'm'.repeat(1017),
    });
    expect(identityBytes(small)).toBe(ceiling - 1);
    expect(() => assertSendableIdentity(small)).not.toThrow();
    // At the bound: refused, with the sendability message naming the bound.
    const at = validateAgentConfig({
      ...config, heading: '', charter: '', model: 'm'.repeat(1018),
    });
    expect(identityBytes(at)).toBe(ceiling);
    expect(() => assertSendableIdentity(at)).toThrow(/sendability budget/);
    expect(() => assertSendableIdentity(at)).toThrow(String(ceiling));
  });

  it('refuses a model past the derived budget (the catalog-less model hole)', () => {
    const config = validateAgentConfig({
      ...defaultAgentConfig(), heading: 'h', charter: 'c', model: 'm'.repeat(300_000),
    });
    // Legal to validate (and therefore legal to replay): the budget is admission-only.
    expect(() => validateAgentConfig(config)).not.toThrow();
    expect(identityBytes(config)).toBeGreaterThan(IDENTITY_FLOOR);
    expect(() => assertSendableIdentity(config)).toThrow(/sendability budget/);
    expect(() => assertSendableIdentity(config)).toThrow('262144');
  });
});

describe('the self port: renew over the live fold', () => {
  const live = (): AgentConfig => validateAgentConfig({
    ...defaultAgentConfig(), heading: 'seed', charter: 'base You are n1.',
  });

  it('reads the live config at call time, not a snapshot', () => {
    let current = live();
    const port = createSelfPort(() => current, 'n1');
    const first = port.renew({ heading: 'one' });
    current = first;
    const second = port.renew({ heading: 'two' });
    expect([first.version, second.version]).toEqual([2, 3]);
    expect(second.heading).toBe('two');
  });

  it('refuses an over-budget rewrite with the bounded sendability message', () => {
    const port = createSelfPort(() => live(), 'n1');
    let caught: unknown;
    try {
      port.renew({ model: 'm'.repeat(300_000) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SelfRefusedError);
    expect((caught as Error).message).toMatch(/sendability budget/);
  });

  it('refuses a heading or a charter past the budget (the whole measured block)', () => {
    const port = createSelfPort(() => live(), 'n1');
    for (const update of [{ heading: 'h'.repeat(300_000) }, { charter: 'c'.repeat(300_000) }]) {
      let caught: unknown;
      try {
        port.renew(update);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SelfRefusedError);
      expect((caught as Error).message).toMatch(/sendability budget/);
    }
  });

  it('re-derives the reserve premise under the token trigger (a stated under-reserve)', () => {
    // The reserve's history term still keys off compactAfterBytes. Under the
    // token trigger a cell's history can hold the whole threshold in TOKENS: at
    // the estimator's own 4 chars/token the 200k arm's 152,000 tokens are 608,000
    // canonical bytes — more than 262,144, so the byte term under-reserves the
    // history under the token rule. The factory floor/caps mask it (the budget
    // collapses to the floor), and the pins are re-derived, never deleted.
    const factory = defaultAgentConfig();
    const rule = factory.policy.compactAfterTokens!;
    const threshold = meterThreshold(200_000, 32_000, rule);
    expect(threshold).toBe(152_000);
    expect(threshold * METER_CHARS_PER_TOKEN)
      .toBeGreaterThan(factory.policy.compactAfterBytes);
    // The factory's own reserve already exceeds its ceiling, so the budget is
    // the floor: the under-reserve is masked, not active, in the factory cell.
    expect(reserve(factory)).toBeGreaterThan(effectiveCeiling(factory));
    expect(identityBudget(factory)).toBe(IDENTITY_FLOOR);
  });

  it('admits an under-budget rewrite', () => {
    const port = createSelfPort(() => live(), 'n1');
    const next = port.renew({ heading: 'x'.repeat(1000) });
    expect(identityBytes(next)).toBeLessThan(identityBudget(next));
  });
});
