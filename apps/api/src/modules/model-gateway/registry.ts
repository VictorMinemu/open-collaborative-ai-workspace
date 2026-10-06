import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { catalogEntry, MOCK_MODEL, type ModelCaps, type ModelProviderKind } from "@ocw/contracts";
import type { JSONValue, LanguageModel } from "ai";

/**
 * Provider instances for organization keys and the E2E mock backend (P-04). Every model is built here as a provider
 * INSTANCE with an explicit `apiKey` and `baseURL`: a "provider/model" string would route through the metered Vercel
 * AI Gateway, and an omitted key would make the SDK read OPENAI_API_KEY / ANTHROPIC_API_KEY from the environment.
 */

export type OrgProviderKind = Exclude<ModelProviderKind, "openai-codex" | "mock">;

const ANTHROPIC_DEFAULT = "https://api.anthropic.com/v1";

/** The Anthropic SDK wants the `/v1` base; the catalog and the OpenClaw cell use the host without it. */
export function anthropicBase(baseUrl: string | null): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/u, "");
  if (!base) return ANTHROPIC_DEFAULT;
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function orgLanguageModel(
  row: { provider: OrgProviderKind; baseUrl: string | null },
  apiKey: string,
  modelId: string,
  opts: { fetch?: typeof fetch } = {},
): { model: LanguageModel; providerOptions: Record<string, Record<string, JSONValue>> } {
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  switch (row.provider) {
    case "anthropic":
      return {
        model: createAnthropic({ apiKey, baseURL: anthropicBase(row.baseUrl), ...fetchOpt })(modelId),
        providerOptions: {},
      };
    case "openai":
      return {
        model: createOpenAI({
          apiKey,
          baseURL: row.baseUrl ?? catalogEntry("openai")?.defaultBaseUrl ?? "https://api.openai.com/v1",
          ...fetchOpt,
        }).responses(modelId),
        // Never retained on the provider side (Pitfall 9 applies to org keys too).
        providerOptions: { openai: { store: false } },
      };
    case "openrouter":
    case "openai-compatible": {
      const baseURL = row.baseUrl ?? catalogEntry(row.provider)?.defaultBaseUrl ?? null;
      if (!baseURL) throw new Error(`${row.provider} needs a base URL`);
      return {
        model: createOpenAICompatible({
          name: row.provider,
          apiKey,
          baseURL,
          includeUsage: true,
          ...fetchOpt,
        })(modelId),
        providerOptions: {},
      };
    }
  }
}

/** The deterministic fake (infra/fake-model) behind `OCW_MODEL_PROVIDER=mock`; never metered. */
export function mockLanguageModel(baseUrl: string, opts: { fetch?: typeof fetch } = {}): LanguageModel {
  return createOpenAICompatible({
    name: "mock",
    apiKey: "mock-key-not-secret",
    baseURL: baseUrl,
    includeUsage: true,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  })(MOCK_MODEL.modelId);
}

/**
 * Conservative capabilities of an org-key or mock model. Web search on these backends is the SearXNG function tool
 * (D-04), never a provider-hosted (metered) search.
 */
export function orgModelCaps(provider: ModelProviderKind, modelId: string): ModelCaps {
  const caps = (vision: boolean, pdf: boolean): ModelCaps => ({ vision, pdf, webSearch: "function" });
  switch (provider) {
    case "anthropic":
      return /^claude-/u.test(modelId) ? caps(true, true) : caps(false, false);
    case "openai":
      return /^gpt-(5|6|4\.1)/u.test(modelId) ? caps(true, true) : caps(false, false);
    case "openrouter":
      if (modelId.startsWith("anthropic/")) return caps(true, true);
      if (modelId.startsWith("openai/")) return caps(true, false);
      return caps(false, false);
    case "mock":
      return caps(true, true);
    default:
      return caps(false, false);
  }
}
