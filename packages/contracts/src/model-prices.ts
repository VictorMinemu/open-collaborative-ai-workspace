import type { ModelProviderKind } from "./agent";
import type { AiBackend } from "./ai-generation";

/**
 * Versioned price table for organization-key generations (D-06). Costs are stored in micro-USD on every usage
 * record together with `priceRef`, so a later price change never rewrites history. Every row names the official page
 * it was read from and the date; a model without a row has no estimate (cost null, "—" in the UI): nothing here is
 * guessed (T-05-08-05). Prices are the providers' standard (non-batch, non-priority) per-MTok rates.
 */
export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Price of cache-read input tokens; absent = cached input is billed at `inputPerMTokUsd`. */
  cachedInputPerMTokUsd?: number;
  /** Where the price comes from (URL and date). */
  source: string;
}

/**
 * Bumped whenever a row changes. "2026-10-06" was the 05-01 seed (Anthropic only); ".2" is the same day's 05-08
 * revision (OpenAI, OpenRouter, Haiku 4.5 cache reads), kept distinct so every stored `priceRef` names one table.
 */
export const PRICE_TABLE_VERSION = "2026-10-06.2";

const ANTHROPIC_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing (2026-10-06)";
/** The standard tier of the "Text tokens" table (Input, Cached input, Output). */
const OPENAI_SOURCE = "https://developers.openai.com/api/docs/pricing standard tier (2026-10-06)";
/** OpenRouter's public models API (`pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, USD/token). */
const OPENROUTER_SOURCE = "https://openrouter.ai/api/v1/models";

/** Keyed by `${provider}/${modelId}`. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "anthropic/claude-opus-5-5": {
    inputPerMTokUsd: 4,
    outputPerMTokUsd: 20,
    cachedInputPerMTokUsd: 0.2,
    source: ANTHROPIC_SOURCE,
  },
  "anthropic/claude-sonnet-5-5": {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 10,
    cachedInputPerMTokUsd: 0.2,
    source: ANTHROPIC_SOURCE,
  },
  "anthropic/claude-haiku-4-5": {
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 5,
    cachedInputPerMTokUsd: 0.1,
    source: ANTHROPIC_SOURCE,
  },
  "openai/gpt-5": {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10,
    cachedInputPerMTokUsd: 0.125,
    source: OPENAI_SOURCE,
  },
  "openai/gpt-5-mini": {
    inputPerMTokUsd: 0.25,
    outputPerMTokUsd: 2,
    cachedInputPerMTokUsd: 0.025,
    source: OPENAI_SOURCE,
  },
  "openai/gpt-4.1": {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 8,
    cachedInputPerMTokUsd: 0.5,
    source: OPENAI_SOURCE,
  },
  // OpenRouter lists this model as `anthropic/claude-sonnet-5.5` (dot), which is the id the catalog sends.
  "openrouter/anthropic/claude-sonnet-5.5": {
    inputPerMTokUsd: 2,
    outputPerMTokUsd: 10,
    cachedInputPerMTokUsd: 0.2,
    source: `${OPENROUTER_SOURCE} anthropic/claude-sonnet-5.5 (2026-10-06)`,
  },
  "openrouter/openai/gpt-5": {
    inputPerMTokUsd: 1.25,
    outputPerMTokUsd: 10,
    cachedInputPerMTokUsd: 0.125,
    source: `${OPENROUTER_SOURCE} openai/gpt-5 (2026-10-06)`,
  },
  "mock/mock-1": { inputPerMTokUsd: 0, outputPerMTokUsd: 0, source: "infra/fake-model (never metered)" },
});

export function priceOf(provider: ModelProviderKind, modelId: string): ModelPrice | null {
  return MODEL_PRICES[`${provider}/${modelId}`] ?? null;
}

/**
 * Cost of one generation in micro-USD. `cachedInputTokens` is a subset of `inputTokens` (AI SDK 7 reports the
 * total input with a cache-read detail): uncached input at the input price, cached input at the cache price.
 * A member's ChatGPT plan costs the organization nothing → `null` (not 0); an unpriced model → `null`.
 */
export function estimateCostMicros(
  backend: AiBackend,
  provider: ModelProviderKind,
  modelId: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null },
): { costMicrosUsd: number | null; priceRef: string | null } {
  if (backend === "chatgpt_plan") return { costMicrosUsd: null, priceRef: null };
  const price = priceOf(provider, modelId);
  if (!price) return { costMicrosUsd: null, priceRef: null };
  return {
    costMicrosUsd: costMicrosOf(price, usage),
    priceRef: `${PRICE_TABLE_VERSION}:${provider}/${modelId}`,
  };
}

/**
 * Micro-USD of `usage` at `price`, rounded. `cachedInputTokens` is a subset of `inputTokens`: uncached input at the
 * input price, cached input at the cache price (the input price when the row has none).
 */
export function costMicrosOf(
  price: ModelPrice,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number | null },
): number {
  const input = Math.max(0, usage.inputTokens);
  const cached = Math.min(input, Math.max(0, usage.cachedInputTokens ?? 0));
  const output = Math.max(0, usage.outputTokens);
  // tokens / 1e6 × USD per MTok × 1e6 micro-USD per USD = tokens × USD per MTok.
  const micros =
    (input - cached) * price.inputPerMTokUsd +
    cached * (price.cachedInputPerMTokUsd ?? price.inputPerMTokUsd) +
    output * price.outputPerMTokUsd;
  return Math.round(micros);
}

/** Rough token count when a provider reports none (stopped or interrupted answers): ceil(chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
