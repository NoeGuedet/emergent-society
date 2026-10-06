import type { CanonicalUsage } from '../context/contracts.js';

/**
 * The one usage normalizer (T6, kernel.md §4).
 *
 * Provider usage is raw dialect data. It is normalized once into `CanonicalUsage`
 * with `null` for every unknown/absent/invalid counter — absence never implies
 * zero, and an explicit `0` is preserved as zero. Dialect selection is
 * deterministic (DeepSeek hit/miss counters, then generic OpenAI keys, then the
 * Anthropic fixture shape) and counters from different dialects are never mixed
 * to invent a total. Raw data is never mutated; a malformed counter is simply
 * `null`. These are local normalization rules, not certification of any provider.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A safe nonnegative integer, or `null` when absent/malformed (never a guess). */
function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function own(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A safe nonnegative integer sum, or `null` when the sum would be unsafe. */
function safeSum(...parts: readonly number[]): number | null {
  let sum = 0;
  for (const part of parts) {
    sum += part;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

function emptyUsage(): CanonicalUsage {
  return {
    inputTotal: null, inputUncached: null, output: null, cacheRead: null, cacheWrite: null,
  };
}

function deepseekUsage(raw: Record<string, unknown>): CanonicalUsage {
  const cacheRead = counter(raw['prompt_cache_hit_tokens']);
  const inputUncached = counter(raw['prompt_cache_miss_tokens']);
  const output = counter(raw['completion_tokens']);
  // `prompt_tokens` is kept raw-only: it is never mixed in to reconstruct a
  // total, and a single present counter leaves the total unknown. The only use
  // of `prompt_tokens` here is the conflict check against the safe hit+miss sum.
  const prompt = counter(raw['prompt_tokens']);
  let inputTotal: number | null = null;
  if (cacheRead !== null && inputUncached !== null) {
    const sum = safeSum(cacheRead, inputUncached);
    if (sum !== null && (prompt === null || prompt === sum)) inputTotal = sum;
  }
  return { inputTotal, inputUncached, output, cacheRead, cacheWrite: null };
}

function openaiUsage(raw: Record<string, unknown>): CanonicalUsage {
  const inputTotal = counter(raw['prompt_tokens']);
  const output = counter(raw['completion_tokens']);
  const details = raw['prompt_tokens_details'];
  const cacheRead = isRecord(details) ? counter(details['cached_tokens']) : null;
  const inputUncached = inputTotal !== null && cacheRead !== null && cacheRead <= inputTotal
    ? inputTotal - cacheRead
    : null;
  return { inputTotal, inputUncached, output, cacheRead, cacheWrite: null };
}

function anthropicUsage(raw: Record<string, unknown>): CanonicalUsage {
  const inputUncached = counter(raw['input_tokens']);
  const output = counter(raw['output_tokens']);
  const cacheRead = counter(raw['cache_read_input_tokens']);
  const cacheWrite = counter(raw['cache_creation_input_tokens']);
  const inputTotal = inputUncached !== null && cacheRead !== null && cacheWrite !== null
    ? safeSum(inputUncached, cacheRead, cacheWrite)
    : null;
  return { inputTotal, inputUncached, output, cacheRead, cacheWrite };
}

export function normalizeUsage(raw: unknown): CanonicalUsage {
  if (!isRecord(raw)) return emptyUsage();
  if (own(raw, 'prompt_cache_hit_tokens') || own(raw, 'prompt_cache_miss_tokens')) {
    return deepseekUsage(raw);
  }
  if (own(raw, 'prompt_tokens') || own(raw, 'completion_tokens')
    || own(raw, 'prompt_tokens_details')) {
    return openaiUsage(raw);
  }
  if (own(raw, 'input_tokens') || own(raw, 'output_tokens')
    || own(raw, 'cache_read_input_tokens') || own(raw, 'cache_creation_input_tokens')) {
    return anthropicUsage(raw);
  }
  return emptyUsage();
}
