import { describe, expect, it } from "vitest";
import {
  costMicrosOf,
  estimateCostMicros,
  estimateTokens,
  MODEL_PRICES,
  PRICE_TABLE_VERSION,
  priceOf,
} from "./model-prices";

const ref = (key: string) => `${PRICE_TABLE_VERSION}:${key}`;

describe("model prices", () => {
  it("prices an org-key generation in micro-USD with a versioned price reference", () => {
    expect(PRICE_TABLE_VERSION).toMatch(/^2026-10-06(\.\d+)?$/u);
    expect(
      estimateCostMicros("org_key", "anthropic", "claude-sonnet-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: null,
      }),
    ).toEqual({ costMicrosUsd: 12_000_000, priceRef: ref("anthropic/claude-sonnet-5-5") });
    expect(
      estimateCostMicros("org_key", "anthropic", "claude-opus-5-5", {
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 0,
      }),
    ).toEqual({ costMicrosUsd: 14_000, priceRef: ref("anthropic/claude-opus-5-5") });
  });

  it("a ChatGPT plan generation costs the organization nothing (null, not 0)", () => {
    expect(
      estimateCostMicros("chatgpt_plan", "openai", "gpt-6-astra", {
        inputTokens: 1_000,
        outputTokens: 1_000,
        cachedInputTokens: null,
      }),
    ).toEqual({ costMicrosUsd: null, priceRef: null });
  });

  it("an unknown model has no estimate", () => {
    expect(priceOf("openai-compatible", "llama-9")).toBeNull();
    expect(
      estimateCostMicros("org_key", "openai-compatible", "llama-9", {
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: null,
      }),
    ).toEqual({ costMicrosUsd: null, priceRef: null });
  });

  it("prices cached input (a subset of the input tokens) at the cache price", () => {
    // 1M input of which 1M cache reads at 0.20 → 200_000 micros, no output.
    expect(
      estimateCostMicros("org_key", "anthropic", "claude-sonnet-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
      }).costMicrosUsd,
    ).toBe(200_000);
    // 1M input of which 500k cached: 500k × 2 + 500k × 0.20 = 1_100_000 micros.
    expect(
      estimateCostMicros("org_key", "anthropic", "claude-sonnet-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 500_000,
      }).costMicrosUsd,
    ).toBe(1_100_000);
    // A price without a cache rate bills cached input at the full input price.
    expect(
      costMicrosOf(
        { inputPerMTokUsd: 1, outputPerMTokUsd: 5, source: "test" },
        { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 },
      ),
    ).toBe(1_000_000);
  });

  it("the mock model is free", () => {
    expect(
      estimateCostMicros("mock", "mock", "mock-1", {
        inputTokens: 5,
        outputTokens: 5,
        cachedInputTokens: null,
      }),
    ).toEqual({ costMicrosUsd: 0, priceRef: ref("mock/mock-1") });
  });

  it("estimateTokens is ceil(length / 4)", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
  });
});

/**
 * D-06, T-05-08-05: nothing is invented. Every row names where its numbers come from (an official URL and the date
 * it was read), and the rows below are exactly the ones read from those pages on 2026-10-06 (05-08).
 */
describe("price sources (05-08)", () => {
  const SOURCE = /^(https:\/\/\S+|infra\/fake-model\S*) .*\(\d{4}-\d{2}-\d{2}\)$|^infra\/fake-model/u;

  it("every row has a non-empty source with a URL and a date", () => {
    for (const [key, price] of Object.entries(MODEL_PRICES)) {
      expect(price.source.length, key).toBeGreaterThan(0);
      expect(price.source, key).toMatch(SOURCE);
      expect(price.inputPerMTokUsd, key).toBeGreaterThanOrEqual(0);
      expect(price.outputPerMTokUsd, key).toBeGreaterThanOrEqual(0);
      if (price.cachedInputPerMTokUsd !== undefined) {
        expect(price.cachedInputPerMTokUsd, key).toBeLessThanOrEqual(price.inputPerMTokUsd);
      }
    }
  });

  it("the Anthropic rows equal the published Anthropic table (claude-api skill, platform.claude.com pricing)", () => {
    const anthropic = (id: string) => {
      const p = priceOf("anthropic", id);
      return p && [p.inputPerMTokUsd, p.outputPerMTokUsd, p.cachedInputPerMTokUsd];
    };
    expect(anthropic("claude-opus-5-5")).toEqual([4, 20, 0.2]);
    expect(anthropic("claude-sonnet-5-5")).toEqual([2, 10, 0.2]);
    expect(anthropic("claude-haiku-4-5")).toEqual([1, 5, 0.1]);
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]) {
      expect(priceOf("anthropic", id)?.source).toMatch(/^https:\/\/platform\.claude\.com\//u);
    }
  });

  it("OpenAI and OpenRouter catalog models are priced from their official pages", () => {
    const rows: Array<[string, string, string]> = [
      ["openai", "gpt-5", "https://developers.openai.com/api/docs/pricing"],
      ["openai", "gpt-5-mini", "https://developers.openai.com/api/docs/pricing"],
      ["openai", "gpt-4.1", "https://developers.openai.com/api/docs/pricing"],
      ["openrouter", "anthropic/claude-sonnet-5-5", "https://openrouter.ai/api/v1/models"],
      ["openrouter", "openai/gpt-5", "https://openrouter.ai/api/v1/models"],
    ];
    for (const [provider, id, url] of rows) {
      const p = priceOf(provider as "openai" | "openrouter", id);
      expect(p, `${provider}/${id}`).not.toBeNull();
      expect(p?.source.startsWith(url), `${provider}/${id}`).toBe(true);
      expect(p?.inputPerMTokUsd, `${provider}/${id}`).toBeGreaterThan(0);
      expect(p?.outputPerMTokUsd, `${provider}/${id}`).toBeGreaterThan(0);
    }
    // gpt-5 standard tier: $1.25 in, $0.125 cached, $10 out per MTok → 1k in (half cached) + 1k out.
    expect(
      estimateCostMicros("org_key", "openai", "gpt-5", {
        inputTokens: 1_000,
        outputTokens: 1_000,
        cachedInputTokens: 500,
      }).costMicrosUsd,
    ).toBe(Math.round(500 * 1.25 + 500 * 0.125 + 1_000 * 10));
  });
});
