import { type AiUsage, estimateCostMicros, estimateTokens, type ModelProviderKind } from "@ocw/contracts";
import { aiUsageRecords, type Tx, tenantOf } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { GenerationRow } from "./dto";
import { usageDto } from "./dto";

/**
 * D-06, AICHAT-07: exactly one immutable usage record per generation and kind (append-only table, unique
 * `(generation_id, kind)`). Provider-reported counts when present; otherwise an estimate (`estimated: true`,
 * ceil(chars / 4)) from the prompt and the text produced. A member's plan costs the organization nothing (null).
 */
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
    reported: ReportedUsage | null;
    /** Text sent and received, for the estimate when the provider reported nothing. */
    promptText: string;
    outputText: string;
  },
): Promise<AiUsage> {
  const g = input.generation;
  const r = input.reported;
  const reported = r !== null && typeof r.inputTokens === "number" && typeof r.outputTokens === "number";
  const inputTokens = reported ? (r?.inputTokens ?? 0) : estimateTokens(input.promptText);
  const outputTokens = reported ? (r?.outputTokens ?? 0) : estimateTokens(input.outputText);
  const cachedInputTokens = reported ? (r?.cachedInputTokens ?? null) : null;
  const reasoningTokens = reported ? (r?.reasoningTokens ?? null) : null;
  const cost = estimateCostMicros(g.backend, g.provider as ModelProviderKind, g.modelId, {
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
      backend: g.backend,
      provider: g.provider,
      modelId: g.modelId,
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
  if (row) return usageDto(row);
  // Already recorded (a retried finalize): the first record stands.
  const [existing] = await tx
    .select()
    .from(aiUsageRecords)
    .where(and(eq(aiUsageRecords.generationId, g.id), eq(aiUsageRecords.kind, input.kind)))
    .limit(1);
  if (!existing) throw new Error("usage record missing after conflict");
  return usageDto(existing);
}
