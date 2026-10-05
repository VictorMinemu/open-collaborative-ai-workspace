import {
  AgentChannelEventTypes,
  type BotCapabilities,
  BotCapabilityView,
  type BotGovernanceEntry,
  BotGovernanceList,
  type BotPolicy,
  BotPolicyView,
  type BotUsage,
  type CellConfigChangedEvent,
  cellTopic,
  IdParams,
  isDangerousToolName,
  MAX_DAILY_LIMIT,
  type Permission,
  UpdateBotCapabilitiesRequest,
  UpdateBotPolicyRequest,
} from "@ocw/contracts";
import { agents, agentUsageDaily, orgMembers, type Tx, tenantOf } from "@ocw/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, notFound } from "../../lib/errors";
import {
  agentResource,
  type PermissionService,
  type PrincipalRef,
  type ResourceFacts,
} from "../organization";
import { effectiveCapabilities, effectiveTools, readCapabilities } from "./capabilities";
import { loadCatalog, loadGrants, replaceGrants } from "./catalog";
import { availableSearchProviders, internetConfigured, loadPolicy, savePolicy } from "./policy";

type AgentRow = typeof agents.$inferSelect;

const tags = ["bot-capabilities"];
const VIEWER_CANDIDATES: Permission[] = ["bot.read", "bot.configure", "bot.manage"];
const TOGGLES = ["internet", "memory", "dateTime", "replyMode", "dailyLimit"] as const;

// ---------------------------------------------------------------- data helpers (exported through index.ts)

/** A live (not deleted) bot of the tx's organization, or null. */
export async function findBot(tx: Tx, id: string): Promise<AgentRow | null> {
  const [row] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), isNull(agents.deletedAt)));
  return row ?? null;
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

function nextUtcMidnight(d = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/** Turns delivered today (UTC) per bot (D-11). */
export async function usageToday(tx: Tx, agentId?: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ agentId: agentUsageDaily.agentId, turns: agentUsageDaily.turns })
    .from(agentUsageDaily)
    .where(
      and(eq(agentUsageDaily.day, utcDay()), ...(agentId ? [eq(agentUsageDaily.agentId, agentId)] : [])),
    );
  return new Map(rows.map((r) => [r.agentId, r.turns]));
}

const usageOf = (today: number, caps: BotCapabilities): BotUsage => ({
  today,
  limit: caps.dailyLimit,
  resetsAt: nextUtcMidnight(),
});

/**
 * Personal-bot governance (D-01, BOT-05): metadata and usage only. Never instructions, DMs or memory
 * (Pitfall 5): the DTO is built field by field.
 */
export async function governanceList(tx: Tx): Promise<BotGovernanceEntry[]> {
  const rows = await tx
    .select({ agent: agents, ownerName: orgMembers.displayName })
    .from(agents)
    .leftJoin(orgMembers, eq(orgMembers.userId, agents.ownerUserId))
    .where(and(eq(agents.scope, "personal"), isNull(agents.deletedAt)))
    .orderBy(asc(agents.name), asc(agents.createdAt));
  const usage = await usageToday(tx);
  return rows.map(({ agent: a, ownerName }) => {
    const caps = readCapabilities(a);
    return {
      id: a.id,
      name: a.name,
      username: a.username,
      avatarUrl: a.avatarUrl,
      owner: { id: a.ownerUserId as string, displayName: ownerName ?? "Former member" },
      model: { provider: a.modelProvider, modelId: a.modelId },
      status: a.status,
      capabilities: caps,
      usage: usageOf(usage.get(a.id) ?? 0, caps),
      createdAt: new Date(a.createdAt).toISOString(),
    };
  });
}

/** Durable hint on the cell stream: the plugin refetches `GET /agent-channel/v1/cell` and reconciles. */
export async function notifyCellConfig(
  core: Core,
  tx: Tx,
  reason: CellConfigChangedEvent["reason"],
  agentId: string | null,
): Promise<void> {
  const { organizationId } = tenantOf(tx);
  await core.realtime.appendEvent(tx, cellTopic(organizationId), AgentChannelEventTypes.configChanged, {
    type: AgentChannelEventTypes.configChanged,
    organizationId,
    cellId: organizationId,
    reason,
    agentId,
  });
}

// ---------------------------------------------------------------- the effective view

export const botFacts = (row: AgentRow) => ({
  scope: row.scope,
  ownerUserId: row.ownerUserId,
  disabled: row.status === "disabled",
});

/**
 * The bot as the human side of a decision sees it. A live bot is judged as itself acting for the caller
 * (agent ∩ human, the confused-deputy rule); a disabled bot cannot act at all, so its view is the caller's.
 */
function humanSide(row: AgentRow, userId: string): PrincipalRef | undefined {
  return row.status === "disabled" ? undefined : { kind: "agent", agentId: row.id, onBehalfOfUserId: userId };
}

async function capabilityView(
  core: Core,
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
  row: AgentRow,
): Promise<BotCapabilityView> {
  const caller = authOf(req).userId;
  const resource = agentResource(botFacts(row), caller);
  const as = humanSide(row, caller);
  const caps = readCapabilities(row);
  const policy = await loadPolicy(tx);
  const configured = await internetConfigured(tx, core.env, policy);
  const internet = await perms.can(req, tx, "bot.internet", resource, as ? { as } : {});
  const catalog = await loadCatalog(tx);
  const grants = await loadGrants(tx, row.id);

  // The tool layer per granted tool (facts are memoised per request: one in-memory decision each).
  const toolAllowed = new Map<string, boolean>();
  for (const g of grants) {
    const toolRes: ResourceFacts = { ...resource, tool: g.tool };
    toolAllowed.set(g.tool, await perms.can(req, tx, "bot.tool.use", toolRes, as ? { as } : {}));
  }
  const usage = await usageToday(tx, row.id);
  return {
    agentId: row.id,
    scope: row.scope,
    capabilities: caps,
    effective: effectiveCapabilities({
      scope: row.scope,
      caps,
      policy,
      configured: { internet: configured },
      human: { internet },
    }),
    tools: effectiveTools({
      scope: row.scope,
      caps,
      policy,
      catalog,
      grants,
      humanToolAllowed: (tool) => toolAllowed.get(tool) ?? null,
    }),
    usage: usageOf(usage.get(row.id) ?? 0, caps),
    dailyLimitMax: row.scope === "personal" ? policy.personalDailyLimitMax : MAX_DAILY_LIMIT,
    viewerCan: await perms.viewerCan(req, tx, resource, VIEWER_CANDIDATES),
  };
}

/**
 * The bot, decided for the caller: a personal bot of someone else is 404 (`bot.read`, nobody learns it
 * exists), then `bot.configure` (owner of a personal bot; admins on team bots) or 403.
 */
async function configurableBot(perms: PermissionService, req: FastifyRequest, tx: Tx, id: string) {
  const row = await findBot(tx, id);
  if (!row) throw notFound("Bot not found", "agent_not_found");
  const resource = agentResource(botFacts(row), authOf(req).userId);
  await perms.assertCan(req, tx, "bot.read", resource, { hideAs404: true });
  await perms.assertCan(req, tx, "bot.configure", resource);
  return row;
}

// ---------------------------------------------------------------- routes

export function registerBotCapabilityRoutes(app: App, core: Core, perms: PermissionService) {
  const requireUser = core.identity.requireUser;
  const user = { config: { authz: "user" as const }, preHandler: [requireUser] };
  const manage = {
    config: { authz: "user" as const },
    preHandler: [requireUser, perms.requirePermission("bot.manage")],
  };

  app.get(
    "/agents/:id/capabilities",
    { ...user, schema: { tags, params: IdParams, response: { 200: BotCapabilityView } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const row = await configurableBot(perms, req, tx, req.params.id);
        return capabilityView(core, perms, req, tx, row);
      }),
  );

  app.patch(
    "/agents/:id/capabilities",
    {
      ...user,
      schema: {
        tags,
        params: IdParams,
        body: UpdateBotCapabilitiesRequest,
        response: { 200: BotCapabilityView },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const row = await configurableBot(perms, req, tx, req.params.id);
        const body = req.body;
        const policy = await loadPolicy(tx);

        if (row.scope === "personal" && body.replyMode === "all") {
          throw badRequest("A personal bot only lives in its owner's DM", "dm_only");
        }
        if (
          row.scope === "personal" &&
          body.dailyLimit !== undefined &&
          body.dailyLimit > policy.personalDailyLimitMax
        ) {
          throw badRequest(
            `The organization allows at most ${policy.personalDailyLimitMax} turns a day for personal bots`,
            "limit_above_policy",
          );
        }
        if (body.tools) {
          const catalog = await loadCatalog(tx);
          for (const g of body.tools) {
            if (isDangerousToolName(g.tool)) {
              throw badRequest(`The tool ${g.tool} can never be enabled on a bot`, "dangerous_tool");
            }
            const known = catalog.some(
              (s) =>
                s.sourceKind === g.sourceKind &&
                s.sourceId === g.sourceId &&
                s.tools.some((t) => t.name === g.tool),
            );
            if (!known) throw badRequest(`Unknown tool ${g.tool}`, "unknown_tool");
          }
        }

        const caps = readCapabilities(row);
        const patch: Partial<BotCapabilities> = {};
        const changed: string[] = [];
        for (const key of TOGGLES) {
          const value = body[key];
          if (value === undefined || value === caps[key]) continue;
          (patch as Record<string, unknown>)[key] = value;
          changed.push(key);
        }
        let current = row;
        if (changed.length > 0) {
          const stored = (row.capabilities ?? {}) as Record<string, unknown>;
          const [updated] = await tx
            .update(agents)
            .set({ capabilities: { ...stored, ...patch } })
            .where(eq(agents.id, row.id))
            .returning();
          if (updated) current = updated;
        }
        let toolChange: { granted: string[]; revoked: string[] } | null = null;
        if (body.tools) {
          toolChange = await replaceGrants(tx, row.id, body.tools, auth.userId);
          if (toolChange.granted.length > 0 || toolChange.revoked.length > 0) changed.push("tools");
        }

        if (changed.length > 0) {
          // Keys and tool names only: never values of free text (T-03.1-03-06).
          await core.audit.record(tx, {
            action: "agent.capabilities_updated",
            resourceType: "agent",
            resourceId: row.id,
            agentId: row.id,
            sessionId: auth.sessionId,
            metadata: {
              scope: row.scope,
              changed,
              ...(toolChange ? { granted: toolChange.granted, revoked: toolChange.revoked } : {}),
            },
          });
          await notifyCellConfig(core, tx, "agent.capabilities_updated", row.id);
        }
        return capabilityView(core, perms, req, tx, current);
      }),
  );

  /** The policy and which search providers the cell can run (the admin page explains the others). */
  const policyView = async (tx: Tx, policy: BotPolicy): Promise<BotPolicyView> => ({
    ...policy,
    availableSearchProviders: [...(await availableSearchProviders(tx, core.env))].sort(),
  });

  app.get("/bot-policy", { ...manage, schema: { tags, response: { 200: BotPolicyView } } }, async (req) =>
    core.db.withTenant(tenant(req), async (tx) => policyView(tx, await loadPolicy(tx))),
  );

  app.put(
    "/bot-policy",
    { ...manage, schema: { tags, body: UpdateBotPolicyRequest, response: { 200: BotPolicyView } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const { policy, changed } = await savePolicy(tx, core.env, req.body, auth.userId);
        if (changed.length > 0) {
          await core.audit.record(tx, {
            action: "bot_policy.updated",
            resourceType: "bot_policy",
            resourceId: auth.organizationId,
            sessionId: auth.sessionId,
            metadata: { changed },
          });
          await notifyCellConfig(core, tx, "policy.updated", null);
        }
        return policyView(tx, policy);
      }),
  );

  app.get(
    "/bot-governance",
    { ...manage, schema: { tags, response: { 200: BotGovernanceList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return { bots: await core.db.withTenant(tenant(req), (tx) => governanceList(tx)) };
    },
  );
}
