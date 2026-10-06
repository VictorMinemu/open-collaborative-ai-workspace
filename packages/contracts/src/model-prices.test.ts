import { describe, expect, it } from "vitest";
import {
  estimateCostMicros,
  estimateTokens,
  MODEL_PRICES,
  PRICE_TABLE_VERSION,
  priceOf,
} from "./model-prices";

describe("model prices", () => {
  it("prices an org-key generation in micro-USD with a versioned price reference", () => {
    expect(PRICE_TABLE_VERSION).toBe("2026-10-06");
    expect(
      estimateCostMicros("org_key", "anthropic", "claude-sonnet-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedInputTokens: null,
      }),
    ).toEqual({ costMicrosUsd: 12_000_000, priceRef: "2026-10-06:anthropic/claude-sonnet-5-5" });
    expect(
      estimateCostMicros("org_key", "anthropic", "claude-opus-5-5", {
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 0,
      }),
    ).toEqual({ costMicrosUsd: 14_000, priceRef: "2026-10-06:anthropic/claude-opus-5-5" });
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
    // A model without a cache price bills cached input at the full input price.
    expect(
      estimateCostMicros("org_key", "anthropic", "claude-haiku-4-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
      }).costMicrosUsd,
    ).toBe(1_000_000);
  });

  it("the mock model is free and every row names its source", () => {
    expect(
      estimateCostMicros("mock", "mock", "mock-1", {
        inputTokens: 5,
        outputTokens: 5,
        cachedInputTokens: null,
      }),
    ).toEqual({ costMicrosUsd: 0, priceRef: "2026-10-06:mock/mock-1" });
    for (const [key, price] of Object.entries(MODEL_PRICES)) {
      expect(price.source.length, key).toBeGreaterThan(0);
      expect(price.inputPerMTokUsd, key).toBeGreaterThanOrEqual(0);
    }
  });

  it("estimateTokens is ceil(length / 4)", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
  });
});
