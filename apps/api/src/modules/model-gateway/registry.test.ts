import { describe, expect, it } from "vitest";
import { anthropicBase, mockLanguageModel, orgLanguageModel, orgModelCaps } from "./registry";

/**
 * The provider registry (P-04): every org-key and mock model is a provider INSTANCE with an explicit key and base
 * URL, never a "provider/model" string (which would route through the metered Vercel AI Gateway).
 */

const KEY = "sk-test-registry-not-a-real-key";

describe("anthropicBase", () => {
  it("defaults to the public Anthropic API with /v1", () => {
    expect(anthropicBase(null)).toBe("https://api.anthropic.com/v1");
  });
  it("appends /v1 to an override without it", () => {
    expect(anthropicBase("http://127.0.0.1:4291")).toBe("http://127.0.0.1:4291/v1");
    expect(anthropicBase("http://127.0.0.1:4291/")).toBe("http://127.0.0.1:4291/v1");
    expect(anthropicBase("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1");
  });
  it("keeps an override that already ends in /v1", () => {
    expect(anthropicBase("http://127.0.0.1:4291/v1")).toBe("http://127.0.0.1:4291/v1");
    expect(anthropicBase("http://127.0.0.1:4291/v1/")).toBe("http://127.0.0.1:4291/v1");
  });
});

describe("orgLanguageModel", () => {
  it("anthropic: a provider instance on the given model, no provider options", () => {
    const r = orgLanguageModel({ provider: "anthropic", baseUrl: null }, KEY, "claude-sonnet-5-5");
    expect(typeof r.model).toBe("object");
    expect((r.model as { modelId: string }).modelId).toBe("claude-sonnet-5-5");
    expect((r.model as { provider: string }).provider).toMatch(/^anthropic/u);
    expect(r.providerOptions).toEqual({});
  });

  it("openai: the Responses API with store:false", () => {
    const r = orgLanguageModel({ provider: "openai", baseUrl: null }, KEY, "gpt-5");
    expect(typeof r.model).toBe("object");
    expect((r.model as { modelId: string }).modelId).toBe("gpt-5");
    expect((r.model as { provider: string }).provider).toMatch(/responses/u);
    expect(r.providerOptions).toEqual({ openai: { store: false } });
  });

  it("openrouter and openai-compatible: chat completions under their own provider name", () => {
    const or = orgLanguageModel(
      { provider: "openrouter", baseUrl: null },
      KEY,
      "anthropic/claude-sonnet-5-5",
    );
    expect(typeof or.model).toBe("object");
    expect((or.model as { provider: string }).provider).toMatch(/^openrouter/u);
    const oc = orgLanguageModel(
      { provider: "openai-compatible", baseUrl: "http://127.0.0.1:8000/v1" },
      KEY,
      "llama-4",
    );
    expect(typeof oc.model).toBe("object");
    expect((oc.model as { provider: string }).provider).toMatch(/^openai-compatible/u);
    expect((oc.model as { modelId: string }).modelId).toBe("llama-4");
  });

  it("openai-compatible without a base URL is refused (never a default host)", () => {
    expect(() => orgLanguageModel({ provider: "openai-compatible", baseUrl: null }, KEY, "x")).toThrow();
  });
});

describe("mockLanguageModel", () => {
  it("is a provider instance on mock-1", () => {
    const m = mockLanguageModel("http://127.0.0.1:4291/v1");
    expect(typeof m).toBe("object");
    expect((m as { modelId: string }).modelId).toBe("mock-1");
  });
});

describe("orgModelCaps", () => {
  const vp = { vision: true, pdf: true, webSearch: "function" };
  it("anthropic claude-* → vision + pdf", () => {
    expect(orgModelCaps("anthropic", "claude-sonnet-5-5")).toEqual(vp);
    expect(orgModelCaps("anthropic", "other-model")).toEqual({
      vision: false,
      pdf: false,
      webSearch: "function",
    });
  });
  it("openai gpt-5* / gpt-6* / gpt-4.1* → vision + pdf", () => {
    expect(orgModelCaps("openai", "gpt-5")).toEqual(vp);
    expect(orgModelCaps("openai", "gpt-5-mini")).toEqual(vp);
    expect(orgModelCaps("openai", "gpt-6-astra")).toEqual(vp);
    expect(orgModelCaps("openai", "gpt-4.1")).toEqual(vp);
    expect(orgModelCaps("openai", "o3")).toEqual({ vision: false, pdf: false, webSearch: "function" });
  });
  it("openrouter anthropic/… → vision + pdf, openai/… → vision only", () => {
    expect(orgModelCaps("openrouter", "anthropic/claude-sonnet-5-5")).toEqual(vp);
    expect(orgModelCaps("openrouter", "openai/gpt-5")).toEqual({
      vision: true,
      pdf: false,
      webSearch: "function",
    });
    expect(orgModelCaps("openrouter", "meta/llama")).toEqual({
      vision: false,
      pdf: false,
      webSearch: "function",
    });
  });
  it("openai-compatible → none; mock → vision + pdf; web search is the function tool everywhere", () => {
    expect(orgModelCaps("openai-compatible", "gpt-5")).toEqual({
      vision: false,
      pdf: false,
      webSearch: "function",
    });
    expect(orgModelCaps("mock", "mock-1")).toEqual(vp);
  });
});
