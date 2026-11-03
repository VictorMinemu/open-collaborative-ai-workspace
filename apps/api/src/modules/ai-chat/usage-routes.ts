import {
  type AiBackend,
  AiMyUsageReportQuery,
  type AiUsageKind,
  AiUsageReport,
  AiUsageReportQuery,
  type AiUsageReportRow,
  AiUsageToday,
  type ModelProviderKind,
  modelLabel,
} from "@ocw/contracts";
import { aiUsageRecords, orgMembers, type Tx, tenantOf } from "@ocw/db";
import { and, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import { type App, authOf, type Core, tenant } from "../../core";
import { loadAiChatPolicy } from "../model-gateway";
import { createPermissionService, orgResource } from "../organization";
import { usageToday } from "./limits";

/**
 * AI chat usage routes (05-08/05-09, AICHAT-07, D-06), registered once by `ai-chat/index.ts`. Usage views carry ids,
 * counts and money only, never prompt, answer or title text (T-05-08-04, T-05-09-02): the report query reads no text
 * column of `ai_usage_records` and joins nothing that holds messages.
 *
 *   GET /me/ai-usage/today  → the caller's own counters for today against the organization's caps (only the caller's
 *                             rows; RLS isolates organizations).
 *   GET /me/ai-usage/report → the caller's own records over the last `days`, by model only (`groupBy=user` is a 400).
 *   GET /ai-usage/report    → the organization's usage over the last `days` (1-90, default 30) UTC days, by member or
 *                             by model (`provider.manage`, T-05-09-01).
 */
export function registerUsageRoutes(app: App, ctx: { core: Core }): void {
  const { core } = ctx;
  const perms = createPermissionService(core);
  app.get(
    "/me/ai-usage/today",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      schema: { tags: ["ai-chat"], response: { 200: AiUsageToday } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        return usageToday(tx, authOf(req).userId, await loadAiChatPolicy(tx));
      }),
  );

  app.get(
    "/me/ai-usage/report",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      schema: { tags: ["ai-chat"], querystring: AiMyUsageReportQuery, response: { 200: AiUsageReport } },
    },
    async (req) => {
      const q = req.query as AiMyUsageReportQuery;
      return core.db.withTenant(tenant(req), async (tx) => {
        await perms.assertCan(req, tx, "ai_chat.use", orgResource());
        return usageReport(tx, { days: q.days, groupBy: "model", userId: authOf(req).userId });
      });
    },
  );

  app.get(
    "/ai-usage/report",
    {
      config: { authz: "user" },
      onRequest: core.identity.requireUser,
      preHandler: perms.requirePermission("provider.manage"),
      schema: { tags: ["ai-chat"], querystring: AiUsageReportQuery, response: { 200: AiUsageReport } },
    },
    async (req) => {
      const q = req.query as AiUsageReportQuery;
      return core.db.withTenant(tenant(req), (tx) => usageReport(tx, { days: q.days, groupBy: q.groupBy }));
    },
  );
}

const DAY_MS = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** The display label of a recorded model: the catalog name when known (plan models use the Codex catalog). */
function reportModelLabel(backend: string, provider: string, modelId: string): string {
  if (backend === "mock") return "Mock (E2E)";
  if (backend === "chatgpt_plan") return modelLabel("openai-codex" as ModelProviderKind, modelId);
  return modelLabel(provider as ModelProviderKind, modelId);
}

type Totals = AiUsageReport["totals"];

/**
 * The by-model row of each usage kind (P-16): chat answers keep the model's own row; titles, digests and Work Zone
 * session summaries each get theirs, so what they cost shows next to chat. Every kind adds to the totals.
 */
const KIND_SUFFIX: Record<AiUsageKind, string> = {
  chat: "",
  title: " · titles",
  digest: " · digests",
  session_summary: " · session summaries",
};

/** Null-safe sum: a null cost (member's plan, unpriced model) adds nothing; all null stays null. */
function addTotals(a: Totals, b: Totals): Totals {
  return {
    generations: a.generations + b.generations,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    estimatedGenerations: a.estimatedGenerations + b.estimatedGenerations,
    estimatedRecords: a.estimatedRecords + b.estimatedRecords,
    costMicrosUsd:
      a.costMicrosUsd === null && b.costMicrosUsd === null
        ? null
        : (a.costMicrosUsd ?? 0) + (b.costMicrosUsd ?? 0),
  };
}

const ZERO: Totals = {
  generations: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedGenerations: 0,
  estimatedRecords: 0,
  costMicrosUsd: null,
};

/** Most expensive first, then most used, then by name (stable for the UI and the tests). */
function byWeight(a: AiUsageReportRow, b: AiUsageReportRow): number {
  return (
    (b.costMicrosUsd ?? -1) - (a.costMicrosUsd ?? -1) ||
    b.generations - a.generations ||
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
    a.label.localeCompare(b.label)
  );
}

/**
 * One aggregate over `ai_usage_records` in the tenant transaction (RLS; the explicit organization predicate lets the
 * planner use `(organization_id, created_at)` / `(organization_id, requester_user_id, created_at)`). The window is the
 * last `days` UTC days, today included. "Answers" (`generations`, `estimatedGenerations`) count chat records only;
 * title records add tokens and cost and, by model, have their own row ("<model> · titles"), as digests and Work Zone
 * session summaries do (Phase 07.6, P-16: "<model> · digests", "<model> · session summaries"). `userId` restricts the
 * report to one member's own records (the `/me` report).
 */
export async function usageReport(
  tx: Tx,
  i: { days: number; groupBy: "user" | "model"; userId?: string; now?: Date },
): Promise<AiUsageReport> {
  const now = i.now ?? new Date();
  const to = utcDay(now);
  const from = utcDay(new Date(now.getTime() - (i.days - 1) * DAY_MS));
  const r = aiUsageRecords;
  const where: SQL[] = [
    eq(r.organizationId, tenantOf(tx).organizationId),
    gte(r.createdAt, `${from}T00:00:00.000Z`),
  ];
  if (i.userId) where.push(eq(r.requesterUserId, i.userId));
  const measures = {
    generations: sql<number>`count(*) filter (where ${r.kind} = 'chat')`.mapWith(Number),
    estimatedGenerations: sql<number>`count(*) filter (where ${r.kind} = 'chat' and ${r.estimated})`.mapWith(
      Number,
    ),
    estimatedRecords: sql<number>`count(*) filter (where ${r.estimated})`.mapWith(Number),
    inputTokens: sql<number>`coalesce(sum(${r.inputTokens}), 0)`.mapWith(Number),
    outputTokens: sql<number>`coalesce(sum(${r.outputTokens}), 0)`.mapWith(Number),
    costMicrosUsd: sql<string | null>`sum(${r.costMicrosUsd})`,
  };
  const cost = (v: string | null) => (v === null ? null : Number(v));

  let rows: AiUsageReportRow[];
  if (i.groupBy === "user") {
    const agg = await tx
      .select({ userId: r.requesterUserId, ...measures })
      .from(r)
      .where(and(...where))
      .groupBy(r.requesterUserId);
    const ids = agg.map((a) => a.userId);
    const names = new Map(
      ids.length === 0
        ? []
        : (
            await tx
              .select({ userId: orgMembers.userId, displayName: orgMembers.displayName })
              .from(orgMembers)
              .where(inArray(orgMembers.userId, ids))
          ).map((m) => [m.userId, m.displayName]),
    );
    rows = agg.map((a) => ({
      key: a.userId,
      label: names.get(a.userId) ?? "Former member",
      backend: null,
      generations: a.generations,
      estimatedGenerations: a.estimatedGenerations,
      estimatedRecords: a.estimatedRecords,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      costMicrosUsd: cost(a.costMicrosUsd),
    }));
  } else {
    const agg = await tx
      .select({ backend: r.backend, provider: r.provider, modelId: r.modelId, kind: r.kind, ...measures })
      .from(r)
      .where(and(...where))
      .groupBy(r.backend, r.provider, r.modelId, r.kind);
    rows = agg.map((a) => {
      const suffix = KIND_SUFFIX[a.kind];
      return {
        key: `${a.backend}:${a.provider}/${a.modelId}${suffix}`,
        label: `${reportModelLabel(a.backend, a.provider, a.modelId)}${suffix}`,
        backend: a.backend as AiBackend,
        kind: a.kind,
        generations: a.generations,
        estimatedGenerations: a.estimatedGenerations,
        estimatedRecords: a.estimatedRecords,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        costMicrosUsd: cost(a.costMicrosUsd),
      };
    });
  }
  rows.sort(byWeight);
  return { from, to, groupBy: i.groupBy, rows, totals: rows.reduce<Totals>(addTotals, ZERO) };
}
