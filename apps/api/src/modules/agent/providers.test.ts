import { describe, expect, it } from "vitest";
import { keyHint, modelRef, nextFreeUsername, resolveBaseUrl, slugifyUsername } from "./providers";

describe("agent provider helpers", () => {
  it("builds OpenClaw model refs", () => {
    expect(modelRef("anthropic", "claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5-5");
    expect(modelRef("mock", "mock-1")).toBe("fake/mock-1");
    expect(modelRef("openrouter", "openai/gpt-5")).toBe("openrouter/openai/gpt-5");
    // Subscription refs keep their own prefix; the cell maps them to OpenClaw's `openai` provider.
    expect(modelRef("openai-codex", "gpt-6-astra")).toBe("openai-codex/gpt-6-astra");
  });

  it("resolves base URLs", () => {
    expect(resolveBaseUrl("anthropic", null, "http://m")).toBe("https://api.anthropic.com");
    expect(resolveBaseUrl("openai", "https://proxy.example/v1", "http://m")).toBe("https://proxy.example/v1");
    expect(resolveBaseUrl("openai-compatible", null, "http://m")).toBeNull();
    expect(resolveBaseUrl("mock", "ignored", "http://fake:18999/v1")).toBe("http://fake:18999/v1");
  });

  it("only ever exposes the last 4 characters of a key", () => {
    expect(keyHint("sk-ant-api03-abcdefghijklmnop")).toBe("mnop");
  });

  it("slugifies usernames and finds a free one", () => {
    expect(slugifyUsername("Product Manager")).toBe("product-manager");
    expect(slugifyUsername("Revisión de Código!")).toBe("revision-de-codigo");
    expect(slugifyUsername("🤖")).toBe("bot-x");
    expect(nextFreeUsername("archie", new Set(["archie", "archie-2"]))).toBe("archie-3");
    expect(nextFreeUsername("pm", new Set())).toBe("pm");
  });
});
