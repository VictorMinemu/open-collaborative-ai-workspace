import { z } from "zod";
import { ModelId, ModelProviderKind } from "./agent";
import { Id, IsoDateTime } from "./common";

/**
 * Phase 5 (Direct AI Chat): the generation of one assistant answer. Lives apart from `ai-chat.ts` so `chat.ts`
 * can carry `Message.generation` without an import cycle (P-01): this file imports only `common` and `agent`.
 */

/**
 * Who pays for a turn (D-01 … D-03): `chatgpt_plan` = the requesting member's own ChatGPT plan (never pooled),
 * `org_key` = a provider key the organization configured (metered), `mock` = the E2E fake (never metered).
 */
export const AiBackend = z.enum(["chatgpt_plan", "org_key", "mock"]);
export type AiBackend = z.infer<typeof AiBackend>;

/** Providers an organization key can name: subscription and mock providers never carry an org key. */
const ORG_KEY_EXCLUDED: readonly ModelProviderKind[] = ["openai-codex", "mock"];

/** Every AI chat turn names the model it runs on (P-04). */
export const ModelRef = z
  .object({ backend: AiBackend, provider: ModelProviderKind, modelId: ModelId })
  .superRefine((ref, ctx) => {
    const ok =
      ref.backend === "chatgpt_plan"
        ? ref.provider === "openai"
        : ref.backend === "mock"
          ? ref.provider === "mock"
          : !ORG_KEY_EXCLUDED.includes(ref.provider);
    if (!ok) {
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message: `provider ${ref.provider} is not valid for backend ${ref.backend}`,
      });
    }
  });
export type ModelRef = z.infer<typeof ModelRef>;

/** Stable key of a model reference: `${backend}:${provider}/${modelId}`. */
export function modelRefKey(ref: ModelRef): string {
  return `${ref.backend}:${ref.provider}/${ref.modelId}`;
}

export const AiGenerationStatus = z.enum(["running", "completed", "stopped", "failed", "interrupted"]);
export type AiGenerationStatus = z.infer<typeof AiGenerationStatus>;

/** Normalized failure codes of a generation (provider error bodies never reach the client). */
export const AiErrorCode = z.enum([
  "usage_limit_exceeded",
  "user_not_eligible",
  "usage_unavailable",
  "unsupported_capability",
  "invalid_credential",
  "route_not_supported",
  "not_connected",
  "model_unavailable",
  "daily_limit_reached",
  "rate_limited",
  "context_too_large",
  "provider_error",
  "timeout",
  "interrupted",
]);
export type AiErrorCode = z.infer<typeof AiErrorCode>;

/** Usage of one generation (D-06). `costMicrosUsd` is null on a member's plan and for unpriced models. */
export const AiUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Subset of `inputTokens` served from the provider's prompt cache, when reported. */
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  /** True when the provider reported no usage (stopped, interrupted) and the counts were estimated. */
  estimated: z.boolean(),
  costMicrosUsd: z.number().int().nonnegative().nullable(),
  /** `${PRICE_TABLE_VERSION}:${provider}/${modelId}` of the price used, or null. */
  priceRef: z.string().nullable(),
});
export type AiUsage = z.infer<typeof AiUsage>;

/** Projection of an `ai_generations` row on an assistant message of an AI chat. */
export const AiGeneration = z.object({
  id: Id,
  status: AiGenerationStatus,
  backend: AiBackend,
  provider: ModelProviderKind,
  modelId: z.string(),
  modelLabel: z.string(),
  /** Billed to the organization (org keys); the UI shows the METERED label (P-11). */
  metered: z.boolean(),
  attempt: z.number().int().min(1),
  errorCode: AiErrorCode.nullable(),
  errorParam: z.string().max(200).nullable(),
  usage: AiUsage.nullable(),
  webUsed: z.boolean(),
  sourceDomains: z.array(z.string().max(253)).max(20),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  /** Phase 6 (P-07): who asked, and so who pays. Filled from 06-02 on; absent on Phase 5 producers. */
  requesterUserId: Id.optional(),
});
export type AiGeneration = z.infer<typeof AiGeneration>;

// ---------------------------------------------------------------- Phase 6: addressing (P-07, P-08)

/**
 * Why an addressed message of a multiplayer AI chat was not answered (P-07: its author had no usable model; nobody
 * else's plan or key is tried). A superset of `ModelUnavailableReason` (ai-chat.ts; a test keeps them aligned):
 * it lives here so `chat.ts` can carry `Message.aiAddressing` without importing `ai-chat.ts`.
 */
export const AiSkipReason = z.enum([
  "not_connected",
  "needs_reconnect",
  "not_eligible",
  "plan_usage_disabled",
  "plan_disabled_by_org",
  "org_keys_disabled",
  "no_key",
  "not_allowed",
  "not_in_catalog",
  "daily_limit_reached",
  "usage_unavailable",
  "concurrent_generations",
]);
export type AiSkipReason = z.infer<typeof AiSkipReason>;

export const AiAddressingStatus = z.enum(["not_addressed", "queued", "answering", "answered", "skipped"]);
export type AiAddressingStatus = z.infer<typeof AiAddressingStatus>;

/** Whether a human message of an AI chat asks the model, and where that request stands (D-05). */
export const AiAddressing = z.object({
  addressed: z.boolean(),
  status: AiAddressingStatus,
  skipReason: AiSkipReason.nullable(),
  generationId: Id.nullable(),
});
export type AiAddressing = z.infer<typeof AiAddressing>;
