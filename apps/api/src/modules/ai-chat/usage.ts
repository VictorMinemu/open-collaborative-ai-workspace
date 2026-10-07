import {
  type AiBackend,
  type AiUsage,
  estimateCostMicros,
  estimateTokens,
  type ModelProviderKind,
  type ModelRef,
} from "@ocw/contracts";
import { aiUsageDaily, aiUsageRecords, type Tx, tenantOf } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import { utcDay } from "../bot-capabilities";
import type { GenerationRow } from "./dto";
import { usageDto } from "./dto";

/**
 * D-06, AICHAT-07: exactly one immutable usage record per generation and kind (append-only table, unique
 * `(generation_id, kind)`), whatever the outcome (completed, stopped, interrupted, failed; chat or title).
 * Provider-reported counts when present (AI SDK 7: `inputTokens` is the total input, cache reads included and
 * reported apart as `cachedInputTokens`); otherwise an estimate (`estimated: true`, ceil(chars / 4)) from the prompt
 * and the text produced. Cost from the sourced price table: null on a member's plan (it costs the organization
 * nothing) and for unpriced models, 0 on the mock. In the SAME transaction, today's counters of the requester
 * (`ai_usage_daily`, one row per member, UTC day and backend class) gain the tokens and cost; the generation counter
 * itself is consumed at send time (limits.ts). A retried finalize adds nothing.
 */

/** The daily-counter class of a backend: the mock counts as an organization model (with no cost). */
export function backendClassOf(backend: AiBackend): "org_key" | "chatgpt_plan" {
  return backend === "chatgpt_plan" ? "chatgpt_plan" : "org_key";
}
export interface ReportedUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  reasoningTokens: number | undefined;
}

export async function recordUsage(
  tx: Tx,
  input: {
    generation: GenerationRow;
    kind: "chat" | "title";
    /** The model that ran, when it is not the generation's own (a title on the backend's small model, 05-10). */
    model?: ModelRef;
    reported: ReportedUsage | null;
    /** Text sent and received, for the estimate when the provider reported nothing. */
    promptText: string;
    outputText: string;
  },
): Promise<AiUsage> {
  const g = input.generation;
  const m = input.model ?? { backend: g.backend, provider: g.provider, modelId: g.modelId };
  const r = input.reported;
  const reported = r !== null && typeof r.inputTokens === "number" && typeof r.outputTokens === "number";
  const inputTokens = reported ? (r?.inputTokens ?? 0) : estimateTokens(input.promptText);
  const outputTokens = reported ? (r?.outputTokens ?? 0) : estimateTokens(input.outputText);
  const cachedInputTokens = reported ? (r?.cachedInputTokens ?? null) : null;
  const reasoningTokens = reported ? (r?.reasoningTokens ?? null) : null;
  const cost = estimateCostMicros(m.backend, m.provider as ModelProviderKind, m.modelId, {
    inputTokens,
    outputTokens,
    cachedInputTokens,
  });
  const [row] = await tx
    .insert(aiUsageRecords)
    .values({
      organizationId: tenantOf(tx).organizationId,
      generationId: g.id,
      kind: input.kind,
      requesterUserId: g.requesterUserId,
      conversationId: g.conversationId,
      messageId: g.assistantMessageId,
      backend: m.backend,
      provider: m.provider,
      modelId: m.modelId,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      estimated: !reported,
      costMicrosUsd: cost.costMicrosUsd,
      priceRef: cost.priceRef,
    })
    .onConflictDoNothing({ target: [aiUsageRecords.generationId, aiUsageRecords.kind] })
    .returning();
  if (row) {
    await addToToday(tx, g, row);
    return usageDto(row);
  }
  // Already recorded (a retried finalize): the first record stands.
  const [existing] = await tx
    .select()
    .from(aiUsageRecords)
    .where(and(eq(aiUsageRecords.generationId, g.id), eq(aiUsageRecords.kind, input.kind)))
    .limit(1);
  if (!existing) throw new Error("usage record missing after conflict");
  return usageDto(existing);
}

/** Adds one record's tokens and cost to the requester's counters of the generation's UTC day (one upsert). */
async function addToToday(
  tx: Tx,
  g: GenerationRow,
  r: { inputTokens: number; outputTokens: number; costMicrosUsd: number | null },
): Promise<void> {
  const cost = r.costMicrosUsd ?? 0;
  await tx
    .insert(aiUsageDaily)
    .values({
      organizationId: tenantOf(tx).organizationId,
      userId: g.requesterUserId,
      day: utcDay(new Date(g.startedAt)),
      backendClass: backendClassOf(g.backend as AiBackend),
      generations: 0,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costMicrosUsd: cost,
    })
    .onConflictDoUpdate({
      target: [aiUsageDaily.organizationId, aiUsageDaily.userId, aiUsageDaily.day, aiUsageDaily.backendClass],
      set: {
        inputTokens: sql`${aiUsageDaily.inputTokens} + ${r.inputTokens}`,
        outputTokens: sql`${aiUsageDaily.outputTokens} + ${r.outputTokens}`,
        costMicrosUsd: sql`${aiUsageDaily.costMicrosUsd} + ${cost}`,
      },
    });
}
