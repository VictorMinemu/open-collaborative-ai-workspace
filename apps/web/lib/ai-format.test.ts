import type { AiGeneration, AiUsage } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { footerLabel, formatCostMicros, formatTokens, formatUsage, usageTitle } from "./ai-format";

const usage = (u: Partial<AiUsage> = {}): AiUsage => ({
  inputTokens: 1234,
  outputTokens: 340,
  cachedInputTokens: null,
  reasoningTokens: null,
  estimated: false,
  costMicrosUsd: 4000,
  priceRef: "2026-10-06.2:anthropic/claude-sonnet-5-5",
  ...u,
});

const gen = (g: Partial<AiGeneration> = {}): AiGeneration => ({
  id: "00000000-0000-4000-8000-000000000001",
  status: "completed",
  backend: "org_key",
  provider: "anthropic",
  modelId: "claude-sonnet-5-5",
  modelLabel: "Claude Sonnet 5.5",
  metered: true,
  attempt: 1,
  errorCode: null,
  errorParam: null,
  usage: usage(),
  webUsed: false,
  sourceDomains: [],
  startedAt: "2026-10-06T10:00:00.000Z",
  finishedAt: "2026-10-06T10:00:05.000Z",
  ...g,
});

describe("formatTokens", () => {
  it("keeps small counts whole and shortens thousands and millions", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.25M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});

describe("formatCostMicros", () => {
  it("shows dollars, '~' when estimated and '—' when the price is unknown", () => {
    expect(formatCostMicros(null, false)).toBe("—");
    expect(formatCostMicros(null, true)).toBe("—");
    expect(formatCostMicros(4000, false)).toBe("$0.004");
    expect(formatCostMicros(4000, true)).toBe("~$0.004");
    expect(formatCostMicros(1234, false)).toBe("$0.0012");
    expect(formatCostMicros(1, false)).toBe("$0.000001");
    expect(formatCostMicros(345_000, false)).toBe("$0.35");
    expect(formatCostMicros(12_345_678, false)).toBe("$12.35");
    expect(formatCostMicros(0, false)).toBe("$0");
  });
});

describe("formatUsage", () => {
  it("org keys: tokens and cost", () => {
    expect(formatUsage(gen())).toBe("1.2k in · 340 out · $0.004");
    expect(formatUsage(gen({ usage: usage({ estimated: true }) }))).toBe("~1.2k in · ~340 out · ~$0.004");
    expect(formatUsage(gen({ usage: usage({ costMicrosUsd: null, priceRef: null }) }))).toBe(
      "1.2k in · 340 out · —",
    );
  });

  it("the member's plan has no cost and the mock is not metered", () => {
    const plan = gen({
      backend: "chatgpt_plan",
      provider: "openai",
      modelLabel: "GPT-6 Astra",
      metered: false,
      usage: usage({ costMicrosUsd: null, priceRef: null }),
    });
    expect(formatUsage(plan)).toBe("1.2k in · 340 out · ChatGPT plan");
    const mock = gen({ backend: "mock", provider: "mock", modelLabel: "Mock (E2E)", metered: false });
    expect(formatUsage(mock)).toBe("1.2k in · 340 out · not metered");
  });

  it("is empty while nothing is recorded", () => {
    expect(formatUsage(gen({ usage: null, status: "running" }))).toBe("");
  });
});

describe("footerLabel", () => {
  it("reads usage, model, then who pays", () => {
    expect(footerLabel(gen())).toBe("1.2k in · 340 out · $0.004 · Claude Sonnet 5.5 · METERED");
    expect(
      footerLabel(
        gen({
          backend: "chatgpt_plan",
          provider: "openai",
          modelLabel: "GPT-6 Astra",
          metered: false,
          usage: usage({ costMicrosUsd: null, priceRef: null }),
        }),
      ),
    ).toBe("1.2k in · 340 out · GPT-6 Astra · ChatGPT plan");
    expect(
      footerLabel(gen({ backend: "mock", provider: "mock", modelLabel: "Mock (E2E)", metered: false })),
    ).toBe("1.2k in · 340 out · Mock (E2E) · not metered");
    expect(footerLabel(gen({ usage: null }))).toBe("Claude Sonnet 5.5 · METERED");
  });

  it("the tooltip has the exact counts and says when they are estimated", () => {
    expect(usageTitle(gen({ usage: usage({ cachedInputTokens: 200, estimated: true }) }))).toBe(
      "1,234 input tokens (200 cached) · 340 output tokens · estimated $0.004 · estimated counts",
    );
    expect(usageTitle(gen())).toBe("1,234 input tokens · 340 output tokens · estimated $0.004");
    expect(usageTitle(gen({ usage: usage({ costMicrosUsd: null }) }))).toBe(
      "1,234 input tokens · 340 output tokens · no price for this model",
    );
    expect(usageTitle(gen({ usage: null }))).toBeUndefined();
  });
});
