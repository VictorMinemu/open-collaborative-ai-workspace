import type { AiChatPolicy, AiUsageToday } from "@ocw/contracts";
import { aiUsageDaily, type Tx, tenantOf } from "@ocw/db";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
import { nextResetAt, utcDay } from "../bot-capabilities";

/**
 * Daily per-member caps on AI chat answers (D-06, Phase 3.1 pattern). One answer (a send or a regenerate) is counted
 * per UTC day and backend class INSIDE the send transaction, before any model call, with ONE conditional upsert: there
 * is no read-then-write, so concurrent sends can never push a member past a cap (T-05-08-01). Organization keys have
 * an answer cap and an optional dollar cap (today's cost, which finalize adds in usage.ts); the member's own ChatGPT
 * plan is capped only when the admin set `planDailyGenerations`. The mock counts as an organization model (no cost).
 * A refused send writes nothing but its `ai_chat.limit_reached` audit row.
 */

export type BackendClass = "org_key" | "chatgpt_plan";
export type DailyLimit = "generations" | "cost";

export type ConsumeResult =
  | { ok: true }
  | {
      ok: false;
      limit: DailyLimit;
      resetsAt: string /** The cap that was hit (answers or micro-USD). */;
      max: number;
    };

/** The caps of one backend class under `policy` (null = no cap). */
export function capsOf(policy: AiChatPolicy, backendClass: BackendClass) {
  return backendClass === "org_key"
    ? { generations: policy.orgKeyDailyGenerations, costMicros: policy.orgKeyDailyCostMicros }
    : { generations: policy.planDailyGenerations, costMicros: null };
}

/**
 * Counts one answer for `userId` today, unless a cap of its backend class is reached. Postgres row-locks the
 * conflicting row for the `do update` and re-evaluates the `where` against the latest committed value, so concurrent
 * callers serialise on the row and exactly `cap` of them succeed. A rollback of the send transaction un-counts it.
 */
export async function consumeGeneration(
  tx: Tx,
  i: { userId: string; backendClass: BackendClass; policy: AiChatPolicy; now?: Date },
): Promise<ConsumeResult> {
  const now = i.now ?? new Date();
  const caps = capsOf(i.policy, i.backendClass);
  const under: SQL[] = [];
  if (caps.generations !== null) under.push(sql`${aiUsageDaily.generations} < ${caps.generations}`);
  if (caps.costMicros !== null) under.push(sql`${aiUsageDaily.costMicrosUsd} < ${caps.costMicros}`);
  const target = [
    aiUsageDaily.organizationId,
    aiUsageDaily.userId,
    aiUsageDaily.day,
    aiUsageDaily.backendClass,
  ];
  // One statement: insert … on conflict do update … where <under every cap> returning.
  const rows = await tx
    .insert(aiUsageDaily)
    .values({
      organizationId: tenantOf(tx).organizationId,
      userId: i.userId,
      day: utcDay(now),
      backendClass: i.backendClass,
      generations: 1,
    })
    .onConflictDoUpdate({
      target,
      set: { generations: sql`${aiUsageDaily.generations} + 1` },
      ...(under.length > 0 ? { setWhere: and(...under) } : {}),
    })
    .returning({ generations: aiUsageDaily.generations });
  if (rows.length > 0) return { ok: true };
  // Refused: which cap (the row is locked by nobody now; this read only names the reason).
  const [row] = await tx
    .select({ generations: aiUsageDaily.generations })
    .from(aiUsageDaily)
    .where(
      and(
        eq(aiUsageDaily.userId, i.userId),
        eq(aiUsageDaily.day, utcDay(now)),
        eq(aiUsageDaily.backendClass, i.backendClass),
      ),
    )
    .limit(1);
  const byCount = caps.generations !== null && (row?.generations ?? 0) >= caps.generations;
  return byCount || caps.costMicros === null
    ? { ok: false, limit: "generations", resetsAt: nextResetAt(now), max: caps.generations ?? 0 }
    : { ok: false, limit: "cost", resetsAt: nextResetAt(now), max: caps.costMicros };
}

/** Today's usage of one member against the policy's caps (what `GET /me/ai-usage/today` answers). */
export async function usageToday(
  tx: Tx,
  userId: string,
  policy: AiChatPolicy,
  now = new Date(),
): Promise<AiUsageToday> {
  const rows = await tx
    .select()
    .from(aiUsageDaily)
    .where(and(eq(aiUsageDaily.userId, userId), eq(aiUsageDaily.day, utcDay(now))));
  const of = (cls: BackendClass) => rows.find((r) => r.backendClass === cls);
  const org = of("org_key");
  const plan = of("chatgpt_plan");
  return {
    day: utcDay(now),
    orgKey: {
      generations: org?.generations ?? 0,
      inputTokens: org?.inputTokens ?? 0,
      outputTokens: org?.outputTokens ?? 0,
      costMicrosUsd: org?.costMicrosUsd ?? 0,
    },
    chatgptPlan: {
      generations: plan?.generations ?? 0,
      inputTokens: plan?.inputTokens ?? 0,
      outputTokens: plan?.outputTokens ?? 0,
    },
    limits: {
      orgKeyGenerations: policy.orgKeyDailyGenerations,
      orgKeyCostMicros: policy.orgKeyDailyCostMicros,
      planGenerations: policy.planDailyGenerations,
    },
    resetsAt: nextResetAt(now),
  };
}

const WHERE: Record<BackendClass, string> = {
  org_key: "on organization models",
  chatgpt_plan: "on your ChatGPT plan in this workspace",
};

/**
 * Audits a refused answer and returns the 429 to throw once the send transaction committed (the audit row must
 * survive; nothing else was written). Callers run `consumeGeneration` after the model resolve and the concurrency cap,
 * before inserting anything, and call this when it refused.
 */
export async function refuseOverLimit(
  core: Core,
  tx: Tx,
  r: Extract<ConsumeResult, { ok: false }>,
  i: { userId: string; backendClass: BackendClass },
): Promise<HttpError> {
  await core.audit.record(tx, {
    action: "ai_chat.limit_reached",
    resourceType: "ai_usage",
    resourceId: i.userId,
    result: "denied",
    metadata: { backendClass: i.backendClass, limit: r.limit },
  });
  const message =
    r.limit === "cost"
      ? `You've reached today's spending limit ${WHERE[i.backendClass]}.`
      : `You've used today's ${r.max} ${r.max === 1 ? "answer" : "answers"} ${WHERE[i.backendClass]}.`;
  return new HttpError(429, "daily_limit_reached", `${message} It resets at 00:00 UTC.`, {
    limit: r.limit,
    backendClass: i.backendClass,
    max: r.max,
    resetsAt: r.resetsAt,
  });
}
