import { describe, expect, it } from 'vitest';
import { normalizeUsage } from '../usage.js';
import type { CanonicalUsage } from '../../context/contracts.js';

/**
 * Usage normalization: the exact numeric cases of the T6 brief. Unknown/absent/
 * invalid is `null`, an explicit `0` stays `0`, dialect selection is deterministic
 * and cross-dialect counters are never mixed to invent a total.
 */

const NONE: CanonicalUsage = {
  inputTotal: null, inputUncached: null, output: null, cacheRead: null, cacheWrite: null,
};

describe('normalizeUsage: absence and malformed input', () => {
  it('yields all-null for absent, non-object and empty usage', () => {
    expect(normalizeUsage(undefined)).toEqual(NONE);
    expect(normalizeUsage(null)).toEqual(NONE);
    expect(normalizeUsage([])).toEqual(NONE);
    expect(normalizeUsage('usage')).toEqual(NONE);
    expect(normalizeUsage({})).toEqual(NONE);
    expect(normalizeUsage({ unrelated: 1 })).toEqual(NONE);
  });

  it('treats a malformed counter as null without touching raw', () => {
    expect(normalizeUsage({
      prompt_tokens: -5, completion_tokens: 1.5,
      prompt_tokens_details: { cached_tokens: 'x' },
    })).toEqual(NONE);
  });
});

describe('normalizeUsage: OpenAI dialect', () => {
  it('maps prompt/completion/nested cached and derives uncached', () => {
    expect(normalizeUsage({
      prompt_tokens: 100, completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 70 },
    })).toEqual({
      inputTotal: 100, inputUncached: 30, output: 5, cacheRead: 70, cacheWrite: null,
    });
  });

  it('leaves uncached null when the cache field is missing (never total - 0)', () => {
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 5 })).toEqual({
      inputTotal: 100, inputUncached: null, output: 5, cacheRead: null, cacheWrite: null,
    });
  });

  it('preserves an explicit zero', () => {
    expect(normalizeUsage({
      prompt_tokens: 0, completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    })).toEqual({
      inputTotal: 0, inputUncached: 0, output: 0, cacheRead: 0, cacheWrite: null,
    });
  });

  it('leaves uncached null when cacheRead exceeds inputTotal', () => {
    expect(normalizeUsage({
      prompt_tokens: 100, completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 170 },
    })).toEqual({
      inputTotal: 100, inputUncached: null, output: 5, cacheRead: 170, cacheWrite: null,
    });
  });
});

describe('normalizeUsage: DeepSeek dialect', () => {
  it('sums hit+miss into a total when both are present', () => {
    expect(normalizeUsage({
      prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30,
    })).toEqual({
      inputTotal: 100, inputUncached: 30, output: null, cacheRead: 70, cacheWrite: null,
    });
  });

  it('nulls the total when a supplied prompt_tokens conflicts with the sum', () => {
    expect(normalizeUsage({
      prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, prompt_tokens: 99,
    })).toEqual({
      inputTotal: null, inputUncached: 30, output: null, cacheRead: 70, cacheWrite: null,
    });
  });

  it('keeps prompt_tokens raw-only for a single counter (no invented total)', () => {
    expect(normalizeUsage({
      prompt_cache_hit_tokens: 70, prompt_tokens: 99,
    })).toEqual({
      inputTotal: null, inputUncached: null, output: null, cacheRead: 70, cacheWrite: null,
    });
  });

  it('accepts a matching prompt_tokens as the sum', () => {
    expect(normalizeUsage({
      prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, prompt_tokens: 100,
    })).toEqual({
      inputTotal: 100, inputUncached: 30, output: null, cacheRead: 70, cacheWrite: null,
    });
  });

  it('takes precedence over generic OpenAI keys', () => {
    expect(normalizeUsage({
      prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30,
      prompt_tokens: 100, completion_tokens: 5,
    })).toEqual({
      inputTotal: 100, inputUncached: 30, output: 5, cacheRead: 70, cacheWrite: null,
    });
  });
});

describe('normalizeUsage: Anthropic fixture dialect', () => {
  it('sums uncached+read+write only when all three are known', () => {
    expect(normalizeUsage({
      input_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 10,
      output_tokens: 5,
    })).toEqual({
      inputTotal: 100, inputUncached: 20, output: 5, cacheRead: 70, cacheWrite: 10,
    });
  });

  it('leaves the total null when an Anthropic cache field is missing', () => {
    expect(normalizeUsage({
      input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 5,
    })).toEqual({
      inputTotal: null, inputUncached: 20, output: 5, cacheRead: 70, cacheWrite: null,
    });
  });
});
