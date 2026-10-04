import { catalogEntry, type ModelProviderKind, type SubscriptionProviderKind } from "@ocw/contracts";

/**
 * Cell provider id per provider kind: prefix of the `<id>/<model>` model ref sent to the cell (and, for
 * API-key providers, the OpenClaw `models.providers.<id>` entry). Subscription providers keep their own id
 * (`openai-codex`); the plugin maps them to the OpenClaw provider that owns the sign-in (`openai`).
 */
export const OPENCLAW_PROVIDER_ID: Record<ModelProviderKind, string> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  "openai-compatible": "openai-compatible",
  "openai-codex": "openai-codex",
  mock: "fake",
};

/** OpenClaw provider that owns a subscription's credentials and model catalog. */
export const SUBSCRIPTION_RUNTIME_PROVIDER: Record<SubscriptionProviderKind, string> = {
  "openai-codex": "openai",
};

/** Wire API OpenClaw must use for each API-key provider kind. */
export const PROVIDER_API: Record<
  Exclude<ModelProviderKind, SubscriptionProviderKind>,
  "anthropic-messages" | "openai-completions"
> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
  openrouter: "openai-completions",
  "openai-compatible": "openai-completions",
  mock: "openai-completions",
};

export function modelRef(provider: ModelProviderKind, modelId: string): string {
  return `${OPENCLAW_PROVIDER_ID[provider]}/${modelId}`;
}

export function resolveBaseUrl(
  provider: ModelProviderKind,
  override: string | null | undefined,
  mockBaseUrl: string,
): string | null {
  if (provider === "mock") return mockBaseUrl;
  return override || catalogEntry(provider)?.defaultBaseUrl || null;
}

/** Last 4 characters, for display. Never more of the key leaves the server. */
export function keyHint(key: string): string {
  return key.trim().slice(-4);
}

/** "Product Manager" → "product-manager"; always matches AgentUsername. */
export function slugifyUsername(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return base.length >= 2 ? base : `bot-${base || "x"}`.slice(0, 32);
}

/** First free username: `base`, `base-2`, `base-3`, … */
export function nextFreeUsername(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
