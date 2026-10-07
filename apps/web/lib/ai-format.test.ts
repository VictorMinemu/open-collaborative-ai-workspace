import type { AiGeneration, AiUsage } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  footerLabel,
  footerParts,
  formatCostMicros,
  formatResetTime,
  formatTokens,
  formatUsage,
  limitNoticeText,
  payerLabel,
  queueText,
  usageTitle,
} from "./ai-format";

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

describe("limit notice", () => {
  const now = new Date(2026, 9, 6, 15, 0); // local 15:00
  it("names the cap and the local reset time", () => {
    const resetsAt = new Date(2026, 9, 6, 23, 30).toISOString();
    expect(
      limitNoticeText({ kind: "generations", backendClass: "org_key", max: 1, resetsAt }, now, "en-US"),
    ).toBe("You've used today's 1 answer on organization models. Resets at 11:30 PM.");
    const tomorrow = new Date(2026, 9, 7, 2, 0).toISOString();
    expect(
      limitNoticeText(
        { kind: "generations", backendClass: "chatgpt_plan", max: 20, resetsAt: tomorrow },
        now,
        "en-US",
      ),
    ).toBe("You've used today's 20 answers on your ChatGPT plan here. Resets at 2:00 AM tomorrow.");
    expect(
      limitNoticeText(
        { kind: "cost", backendClass: "org_key", max: 5_000_000, resetsAt: tomorrow },
        now,
        "en-US",
      ),
    ).toBe("You've reached today's $5.00 limit on organization models. Resets at 2:00 AM tomorrow.");
    expect(formatResetTime(tomorrow, now, "en-US")).toBe("2:00 AM tomorrow");
  });
});

// ---------------------------------------------------------------- Phase 6: who an answer was for, who paid (06-11)

describe("payerLabel (D-01)", () => {
  const ALEX = "00000000-0000-4000-8000-0000000000a1";
  const VIEWER = "00000000-0000-4000-8000-0000000000b2";
  const plan = gen({
    backend: "chatgpt_plan",
    provider: "openai",
    modelLabel: "GPT-6 Astra",
    metered: false,
  });

  it("names the requester and their own plan, or METERED on an organization model", () => {
    expect(payerLabel({ ...plan, requesterUserId: ALEX }, "Alex Kim", VIEWER)).toBe(
      "for Alex Kim · Alex's ChatGPT plan",
    );
    expect(payerLabel(gen({ requesterUserId: ALEX }), "Alex Kim", VIEWER)).toBe("for Alex Kim · METERED");
    expect(
      payerLabel(
        gen({ backend: "mock", provider: "mock", metered: false, requesterUserId: ALEX }),
        "Alex Kim",
        VIEWER,
      ),
    ).toBe("for Alex Kim · not metered");
    expect(payerLabel({ ...plan, requesterUserId: ALEX }, "Víctor Ruiz", VIEWER)).toBe(
      "for Víctor Ruiz · Víctor's ChatGPT plan",
    );
  });

  it("speaks to the viewer when they asked", () => {
    expect(payerLabel({ ...plan, requesterUserId: VIEWER }, "Sam Lee", VIEWER)).toBe(
      "for you · your ChatGPT plan",
    );
    expect(payerLabel(gen({ requesterUserId: VIEWER }), "Sam Lee", VIEWER)).toBe("for you · METERED");
  });

  it("is null for Phase 5 rows (no requester) and in solo chats (no requester name)", () => {
    expect(payerLabel(plan, "Alex Kim", VIEWER)).toBeNull();
    expect(payerLabel({ ...plan, requesterUserId: ALEX }, null, VIEWER)).toBeNull();
  });

  it("the multiplayer footer ends with the payer instead of the backend label", () => {
    const g = { ...plan, requesterUserId: ALEX, usage: usage({ costMicrosUsd: null, priceRef: null }) };
    expect(footerParts(g, payerLabel(g, "Alex Kim", VIEWER)).join(" · ")).toBe(
      "1.2k in · 340 out · GPT-6 Astra · for Alex Kim · Alex's ChatGPT plan",
    );
    const metered = gen({ requesterUserId: ALEX });
    expect(footerParts(metered, payerLabel(metered, "Alex Kim", VIEWER)).join(" · ")).toBe(
      "1.2k in · 340 out · $0.004 · Claude Sonnet 5.5 · for Alex Kim · METERED",
    );
    // Solo: the Phase 5 footer, unchanged.
    expect(footerParts(g, null).join(" · ")).toBe(footerLabel(g));
    expect(footerLabel(g)).toBe("1.2k in · 340 out · GPT-6 Astra · ChatGPT plan");
  });
});

describe("queueText (D-05)", () => {
  const names: Record<string, string> = {
    v: "Víctor Ruiz",
    a: "Alex Kim",
    s: "Sam Lee",
    r: "Riley Park",
    j: "Jo Diaz",
  };
  const nameOf = (id: string) => names[id] ?? "Someone";
  const authors: Record<string, string> = { m1: "v", m2: "a", m3: "s", m4: "r", m5: "j", m6: "a" };
  const authorOf = (id: string) => authors[id] ?? null;
  const running = (requester: string, respondingTo: string[]) => ({
    generationId: "g",
    requesterUserId: requester,
    respondingTo,
  });
  const pending = (...ids: string[]) =>
    ids.map((messageId) => ({ messageId, authorId: authors[messageId] ?? "" }));

  it("says whom the AI is answering and who is next, requesters first, each name once", () => {
    expect(queueText({ running: running("v", ["m1"]), pending: [] }, nameOf, authorOf)).toBe(
      "AI is answering Víctor Ruiz",
    );
    expect(queueText({ running: running("v", ["m1"]), pending: pending("m2") }, nameOf, authorOf)).toBe(
      "AI is answering Víctor Ruiz · Alex Kim is next",
    );
    expect(
      queueText({ running: running("v", ["m1"]), pending: pending("m2", "m3", "m6") }, nameOf, authorOf),
    ).toBe("AI is answering Víctor Ruiz · Alex Kim and Sam Lee are next");
    expect(queueText({ running: running("a", ["m3", "m2"]), pending: [] }, nameOf, authorOf)).toBe(
      "AI is answering Alex Kim and Sam Lee",
    );
    expect(
      queueText(
        { running: running("v", ["m1"]), pending: pending("m2", "m3", "m4", "m5") },
        nameOf,
        authorOf,
      ),
    ).toBe("AI is answering Víctor Ruiz · Alex Kim, Sam Lee and 2 others are next");
  });

  it("is null when idle and empty; a waiting queue says who is next", () => {
    expect(queueText({ running: null, pending: [] }, nameOf, authorOf)).toBeNull();
    expect(queueText({ running: null, pending: pending("m2") }, nameOf, authorOf)).toBe(
      "Waiting for the AI · Alex Kim is next",
    );
  });
});
