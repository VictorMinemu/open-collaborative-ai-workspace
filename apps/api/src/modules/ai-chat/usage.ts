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
  const measured = measure(m, input);
  const [row] = await tx
    .insert(aiUsageRecords)
    .values({
      organizationId: tenantOf(tx).organizationId,
      generationId: g.id,
      kind: input.kind,
      requesterUserId: g.requesterUserId,
      conversationId: g.conversationId,
      messageId: g.assistantMessageId,
      ...measured,
    })
    .onConflictDoNothing({ target: [aiUsageRecords.generationId, aiUsageRecords.kind] })
    .returning();
  if (row) {
    await addToToday(
      tx,
      { userId: g.requesterUserId, at: new Date(g.startedAt), backend: g.backend as AiBackend },
      row,
    );
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

/**
 * Phase 07.6 (D-05, D-06, P-16): the usage record of a model call that is not a chat generation: a digest's summary
 * (`digest`, subject = the automation run) or a Work Zone session's memory summary (`session_summary`, subject = the
 * session; a later summary of new work in the same session uses its own subject id, `summarySubjectId`). Same estimate,
 * price table and daily counters as `recordUsage`, billed to `requesterUserId`. Idempotent on (subject_id, kind): a
 * retried job adds nothing, and the first record stands.
 */
export async function recordStandaloneUsage(
  tx: Tx,
  i: {
    kind: "digest" | "session_summary";
    subjectId: string;
    requesterUserId: string;
    model: ModelRef;
    reported: ReportedUsage | null;
    promptText: string;
    outputText: string;
  },
): Promise<AiUsage> {
  const [row] = await tx
    .insert(aiUsageRecords)
    .values({
      organizationId: tenantOf(tx).organizationId,
      generationId: null,
      kind: i.kind,
      requesterUserId: i.requesterUserId,
      conversationId: null,
      messageId: null,
      subjectId: i.subjectId,
      ...measure(i.model, i),
    })
    .onConflictDoNothing({
      target: [aiUsageRecords.subjectId, aiUsageRecords.kind],
      where: sql`subject_id is not null`,
    })
    .returning();
  if (row) {
    await addToToday(tx, { userId: i.requesterUserId, at: new Date(), backend: i.model.backend }, row);
    return usageDto(row);
  }
  const [existing] = await tx
    .select()
    .from(aiUsageRecords)
    .where(and(eq(aiUsageRecords.subjectId, i.subjectId), eq(aiUsageRecords.kind, i.kind)))
    .limit(1);
  if (!existing) throw new Error("usage record missing after conflict");
  return usageDto(existing);
}

/** Tokens (reported, else estimated from the text) and cost of one model call on `m`. */
function measure(
  m: { backend: AiBackend; provider: string; modelId: string },
  input: { reported: ReportedUsage | null; promptText: string; outputText: string },
) {
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
  return {
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
  };
}

/** Adds one record's tokens and cost to the requester's counters of that UTC day and backend class (one upsert). */
async function addToToday(
  tx: Tx,
  who: { userId: string; at: Date; backend: AiBackend },
  r: { inputTokens: number; outputTokens: number; costMicrosUsd: number | null },
): Promise<void> {
  const cost = r.costMicrosUsd ?? 0;
  await tx
    .insert(aiUsageDaily)
    .values({
      organizationId: tenantOf(tx).organizationId,
      userId: who.userId,
      day: utcDay(who.at),
      backendClass: backendClassOf(who.backend),
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
