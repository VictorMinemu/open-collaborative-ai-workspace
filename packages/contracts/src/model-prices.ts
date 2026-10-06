import type { ModelProviderKind } from "./agent";
import type { AiBackend } from "./ai-generation";

/**
 * Versioned price table for organization-key generations (D-06). Costs are stored in micro-USD on every usage
 * record together with `priceRef`, so a later price change never rewrites history. 05-08 adds sourced OpenAI and
 * OpenRouter rows and bumps the version.
 */
export interface ModelPrice {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Price of cache-read input tokens; absent = cached input is billed at `inputPerMTokUsd`. */
  cachedInputPerMTokUsd?: number;
  /** Where the price comes from (URL and date). */
  source: string;
}

export const PRICE_TABLE_VERSION = "2026-10-06";

const ANTHROPIC_SOURCE = "https://docs.claude.com/en/docs/about-claude/pricing (2026-10-06)";

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
  "anthropic/claude-haiku-4-5": { inputPerMTokUsd: 1, outputPerMTokUsd: 5, source: ANTHROPIC_SOURCE },
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
  const input = Math.max(0, usage.inputTokens);
  const cached = Math.min(input, Math.max(0, usage.cachedInputTokens ?? 0));
  const output = Math.max(0, usage.outputTokens);
  // tokens / 1e6 × USD per MTok × 1e6 micro-USD per USD = tokens × USD per MTok.
  const micros =
    (input - cached) * price.inputPerMTokUsd +
    cached * (price.cachedInputPerMTokUsd ?? price.inputPerMTokUsd) +
    output * price.outputPerMTokUsd;
  return { costMicrosUsd: Math.round(micros), priceRef: `${PRICE_TABLE_VERSION}:${provider}/${modelId}` };
}

/** Rough token count when a provider reports none (stopped or interrupted answers): ceil(chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
