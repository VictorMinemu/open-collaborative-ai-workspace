import {
  type AgentMessagingOutboundMode,
  type AgentMessagingSettings,
  AgentMessagingSettings as AgentMessagingSettingsSchema,
  AgentMessagingView,
  type AgentRef,
  type AuthzDenial,
  agentMessageTool,
  IdParams,
  SetAgentMessagingRequest,
  UpdateAgentMessagingSettingsRequest,
} from "@ocw/contracts";
import { agents, orgUnits, permissionRules, type Tx } from "@ocw/db";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, notFound } from "../../lib/errors";
import { type AgentFacts, agentResource, orgResource } from "./permissions/policy";
import type { PermissionService } from "./permissions/service";
import { deleteRuleRow, insertRuleRow, type RuleRow, rulesChanged } from "./rules";

/**
 * Who may consult whom (Phase 07.7, A2A-02, D-02, D-04, P-03 … P-05, ADR-0027). Agent-to-agent consults are decided by
 * the resolver on the `agent.message` grain, which agents never hold by default: only an allow rule opens it. This
 * file owns the two admin writers of those rules (the organization switch and the per-bot consult rules) and the one
 * canonical decision every consult path makes. Rows go through 07.3's helpers (per-row audit, `via: agent_messaging`)
 * and one `permission_rules.updated` per request that changed rows re-decides live subscriptions (ADR-0009). Who may
 * read or change them is the resolver's `rule.read` / `rule.manage` (admins in v1), never a role check here.
 */

const PERMISSION = "agent.message";
const VIA = "agent_messaging";

// ---------------------------------------------------------------- the canonical decision (P-05)

/** What the resolver needs about a bot, with a unit persona's unit path loaded (AGENT-01, the `loadBotFacts` rule). */
async function targetFactsOf(tx: Tx, agentId: string): Promise<AgentFacts | null> {
  const [row] = await tx
    .select({
      scope: agents.scope,
      ownerUserId: agents.ownerUserId,
      status: agents.status,
      unitPath: orgUnits.path,
    })
    .from(agents)
    .leftJoin(orgUnits, eq(orgUnits.id, agents.unitId))
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!row) return null;
  return {
    scope: row.scope,
    ownerUserId: row.ownerUserId,
    disabled: row.status === "disabled",
    unitPath: row.unitPath ?? [],
  };
}

export interface MessagingDecisionInput {
  sourceAgentId: string;
  /** The human the asking bot acts for (the chain's human). */
  humanUserId: string;
  targetAgentId: string;
}

/**
 * May `sourceAgentId`, acting for `humanUserId`, consult `targetAgentId`? One resolver call (D-02, P-05):
 *
 * - agent pass: the source agent as principal on the target bot with tool `agent:<target>` — rules only (the grain is
 *   closed by default for agents), per-target rules through the `tool` column, deny wins;
 * - human pass: the human on the same target with the owner relation the human has — the role grant, the human's rules,
 *   and target visibility (the `unit_agent` and personal-bot preconditions, extended to `agent.message`).
 *
 * 07.7-04's `decideAgentMessage` must make exactly this call (same resources, same tool) for the offered targets and the
 * request. A target that does not exist in this organization (deleted, or another tenant's id under RLS) is denied.
 */
export async function messagingDecision(
  tx: Tx,
  perms: PermissionService,
  input: MessagingDecisionInput,
): Promise<{ allowed: boolean; denial?: AuthzDenial }> {
  const target = await targetFactsOf(tx, input.targetAgentId);
  if (!target) {
    return {
      allowed: false,
      denial: { permission: PERMISSION, layer: "resource", reason: "agent_not_found" },
    };
  }
  const tool = agentMessageTool(input.targetAgentId);
  return perms.decide(
    tx,
    { kind: "agent", agentId: input.sourceAgentId, onBehalfOfUserId: input.humanUserId },
    PERMISSION,
    { ...agentResource(target, null), tool },
    { ...agentResource(target, input.humanUserId), tool },
  );
}

// ---------------------------------------------------------------- the organization switch (P-03)

/** The switch's rows: organization scope, `everyone`, allow, no tool, no folder. Duplicates count as one switch. */
async function switchRows(tx: Tx): Promise<RuleRow[]> {
  return tx
    .select()
    .from(permissionRules)
    .where(
      and(
        isNull(permissionRules.scopeUnitId),
        eq(permissionRules.subjectKind, "everyone"),
        isNull(permissionRules.subjectId),
        eq(permissionRules.permission, PERMISSION),
        isNull(permissionRules.tool),
        isNull(permissionRules.pathPrefix),
        eq(permissionRules.effect, "allow"),
      ),
    );
}

async function canManage(req: FastifyRequest, tx: Tx, perms: PermissionService): Promise<boolean> {
  return perms.can(req, tx, "rule.manage", orgResource());
}

async function settingsView(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
): Promise<AgentMessagingSettings> {
  return AgentMessagingSettingsSchema.parse({
    enabled: (await switchRows(tx)).length > 0,
    canManage: await canManage(req, tx, perms),
  });
}

// ---------------------------------------------------------------- per-bot consult rules (P-04)

/** The candidates a "Right now" summary reads, and how many it names (the contract's cap). */
const EFFECTIVE_READ_MAX = 200;
const EFFECTIVE_LIST_MAX = 50;

const botColumns = {
  id: agents.id,
  name: agents.name,
  username: agents.username,
  scope: agents.scope,
  ownerUserId: agents.ownerUserId,
  status: agents.status,
  unitPath: orgUnits.path,
};

interface BotRow {
  id: string;
  name: string;
  username: string;
  scope: "team" | "personal";
  ownerUserId: string | null;
  status: string;
  unitPath: string[] | null;
}

const refOf = (b: BotRow): AgentRef => ({ id: b.id, handle: b.username, displayName: b.name });
const factsOf = (b: BotRow): AgentFacts => ({
  scope: b.scope,
  ownerUserId: b.ownerUserId,
  disabled: b.status === "disabled",
  unitPath: b.unitPath ?? [],
});

/**
 * Live team bots of this organization (RLS scopes the read): organization bots and unit personas. Personal bots are out
 * of v1 (D-04), deleted bots are gone. `ids` narrows the read; the order is the display name, then the id.
 */
async function teamBots(
  tx: Tx,
  where: { ids?: readonly string[]; exceptId?: string; limit?: number } = {},
): Promise<BotRow[]> {
  const conds = [eq(agents.scope, "team"), isNull(agents.deletedAt)];
  if (where.ids) conds.push(inArray(agents.id, [...where.ids]));
  if (where.exceptId) conds.push(ne(agents.id, where.exceptId));
  const q = tx
    .select(botColumns)
    .from(agents)
    .leftJoin(orgUnits, eq(orgUnits.id, agents.unitId))
    .where(and(...conds))
    .orderBy(asc(agents.name), asc(agents.id));
  return where.limit ? q.limit(where.limit) : q;
}

/** The bot behind `:id`: a live team bot of this organization, else 404 (personal, deleted or another tenant's). */
async function requireTeamBot(tx: Tx, id: string): Promise<BotRow> {
  const [row] = await teamBots(tx, { ids: [id.toLowerCase()] });
  if (!row) throw notFound("Bot not found", "bot_not_found");
  return row;
}

/**
 * A bot's own rows (P-04): organization-scope `agent.message` rules without a folder whose subject is the bot, plus the
 * `everyone` rules whose tool names it (inbound). Unit-scoped `agent.message` rows (07.3 module rows, admin unit
 * rules) are never per-bot settings: agents carry no member paths, so "agents of unit X" would bind nothing (Pitfall 10).
 */
async function ownRows(tx: Tx, agentId: string): Promise<RuleRow[]> {
  return tx
    .select()
    .from(permissionRules)
    .where(
      and(
        isNull(permissionRules.scopeUnitId),
        eq(permissionRules.permission, PERMISSION),
        isNull(permissionRules.pathPrefix),
        or(
          and(eq(permissionRules.subjectKind, "agent"), eq(permissionRules.subjectId, agentId)),
          and(
            eq(permissionRules.subjectKind, "everyone"),
            isNull(permissionRules.subjectId),
            eq(permissionRules.tool, agentMessageTool(agentId)),
          ),
        ),
      ),
    )
    .orderBy(asc(permissionRules.createdAt), asc(permissionRules.id));
}

/** The bot a rule tool names (`agent:<uuid>`), or null. */
const targetOfTool = (tool: string | null): string | null =>
  tool?.startsWith("agent:") ? tool.slice("agent:".length) : null;

interface DerivedRules {
  mode: AgentMessagingOutboundMode;
  allow: string[];
  deny: string[];
  consultable: boolean;
}

/**
 * The settings the rows add up to. Deny wins, so `none` hides per-target rows and `any` hides per-target allows; the
 * next PUT of what the view shows removes such leftovers. The "Right now" summary is what tells the truth either way.
 */
function deriveRules(rows: readonly RuleRow[], agentId: string): DerivedRules {
  const outbound = rows.filter((r) => r.subjectKind === "agent");
  const none = outbound.some((r) => r.effect === "deny" && r.tool === null);
  const any = outbound.some((r) => r.effect === "allow" && r.tool === null);
  const targets = (effect: "allow" | "deny") => [
    ...new Set(
      outbound
        .filter((r) => r.effect === effect)
        .map((r) => targetOfTool(r.tool))
        .filter((id): id is string => id !== null),
    ),
  ];
  const only = targets("allow");
  const mode: AgentMessagingOutboundMode = none ? "none" : any ? "any" : only.length > 0 ? "only" : "default";
  const inboundOff = rows.some(
    (r) => r.subjectKind === "everyone" && r.effect === "deny" && r.tool === agentMessageTool(agentId),
  );
  return {
    mode,
    allow: mode === "only" ? only : [],
    deny: mode === "none" ? [] : targets("deny"),
    consultable: !inboundOff,
  };
}

type WantedRow = Pick<RuleRow, "subjectKind" | "subjectId" | "tool" | "effect">;
const keyOf = (r: WantedRow) => `${r.subjectKind}|${r.subjectId ?? ""}|${r.tool ?? ""}|${r.effect}`;

/** The exact row set a request asks for (P-04), all organization scope, `agent.message`, no folder. */
function wantedRows(agentId: string, body: SetAgentMessagingRequest): WantedRow[] {
  const mine = (tool: string | null, effect: "allow" | "deny"): WantedRow => ({
    subjectKind: "agent",
    subjectId: agentId,
    tool,
    effect,
  });
  const out: WantedRow[] = [];
  const { mode, allow, deny } = body.outbound;
  if (mode === "any") out.push(mine(null, "allow"));
  if (mode === "none") out.push(mine(null, "deny"));
  if (mode === "only") for (const id of allow) out.push(mine(agentMessageTool(id), "allow"));
  for (const id of deny) out.push(mine(agentMessageTool(id), "deny"));
  if (!body.inbound.consultable) {
    out.push({ subjectKind: "everyone", subjectId: null, tool: agentMessageTool(agentId), effect: "deny" });
  }
  return out;
}

/**
 * "Right now" (P-04): the targets this bot may consult, decided by the resolver's agent pass alone (the bot as the
 * principal, the target with tool agent:<target>) over at most 200 candidates, naming at most 50. People still need to
 * see the target at consult time (the human pass of `messagingDecision`), so a hidden unit persona can be listed here
 * and refused for a given person. `any` = every candidate read is allowed.
 */
async function effectiveOf(
  tx: Tx,
  perms: PermissionService,
  bot: BotRow,
): Promise<AgentMessagingView["effective"]> {
  const candidates = await teamBots(tx, { exceptId: bot.id, limit: EFFECTIVE_READ_MAX });
  const allowed = await perms.filterFor(
    tx,
    { kind: "agent", agentId: bot.id },
    candidates,
    PERMISSION,
    (c) => ({ ...agentResource(factsOf(c), null), tool: agentMessageTool(c.id) }),
  );
  const kind = allowed.length === 0 ? "none" : allowed.length === candidates.length ? "any" : "some";
  return { kind, targets: allowed.slice(0, EFFECTIVE_LIST_MAX).map(refOf) };
}

async function botView(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
  bot: BotRow,
): Promise<AgentMessagingView> {
  const rules = deriveRules(await ownRows(tx, bot.id), bot.id);
  const named = [...rules.allow, ...rules.deny];
  const refs = new Map((named.length > 0 ? await teamBots(tx, { ids: named }) : []).map((b) => [b.id, b]));
  // Live team bots only, in display-name order; a rule naming a gone bot is not shown (and goes on the next PUT).
  const listed = (ids: readonly string[]) => [...refs.values()].filter((b) => ids.includes(b.id)).map(refOf);
  return AgentMessagingView.parse({
    agentId: bot.id,
    orgDefault: (await switchRows(tx)).length > 0,
    outbound: { mode: rules.mode, allow: listed(rules.allow), deny: listed(rules.deny) },
    inbound: { consultable: rules.consultable },
    effective: await effectiveOf(tx, perms, bot),
    canManage: await canManage(req, tx, perms),
  });
}

/** 400 `invalid_agent_messaging` unless every named target is a live team bot of this organization other than `bot`. */
async function assertTargets(tx: Tx, bot: BotRow, body: SetAgentMessagingRequest): Promise<void> {
  const ids = [...new Set([...body.outbound.allow, ...body.outbound.deny].map((id) => id.toLowerCase()))];
  if (ids.length === 0) return;
  const invalid = () =>
    badRequest("Pick bots of this organization other than this one", "invalid_agent_messaging");
  if (ids.includes(bot.id)) throw invalid();
  const found = await teamBots(tx, { ids });
  if (found.length !== ids.length) throw invalid();
}

/** Lowercases every id, so one bot has one rule tool whatever the request's spelling. */
function normalised(body: SetAgentMessagingRequest): SetAgentMessagingRequest {
  return {
    outbound: {
      mode: body.outbound.mode,
      allow: body.outbound.allow.map((id) => id.toLowerCase()),
      deny: body.outbound.deny.map((id) => id.toLowerCase()),
    },
    inbound: body.inbound,
  };
}

export function registerAgentMessagingRoutes(app: App, core: Core, perms: PermissionService): void {
  const tags = ["organization"];
  const requireUser = core.identity.requireUser;

  app.get(
    "/agents/:id/messaging",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("rule.read")],
      schema: { tags, params: IdParams, response: { 200: AgentMessagingView } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) =>
        botView(req, tx, perms, await requireTeamBot(tx, req.params.id)),
      ),
  );

  app.put(
    "/agents/:id/messaging",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("rule.manage")],
      schema: {
        tags,
        params: IdParams,
        body: SetAgentMessagingRequest,
        response: { 200: AgentMessagingView },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const bot = await requireTeamBot(tx, req.params.id);
        const body = normalised(req.body);
        await assertTargets(tx, bot, body);
        const wanted = new Map(wantedRows(bot.id, body).map((w) => [keyOf(w), w]));
        const metadata = { via: VIA, agentId: bot.id };
        const changed: string[] = [];
        // Keep the first row of each wanted key; delete duplicates and everything not wanted (deny rows included).
        const kept = new Set<string>();
        for (const row of await ownRows(tx, bot.id)) {
          const key = keyOf(row);
          if (wanted.has(key) && !kept.has(key)) {
            kept.add(key);
            continue;
          }
          if (await deleteRuleRow(core, tx, row, metadata)) changed.push(row.id);
        }
        for (const [key, w] of wanted) {
          if (kept.has(key)) continue;
          const rule = await insertRuleRow(
            core,
            tx,
            { scopeUnitId: null, permission: PERMISSION, ...w },
            { createdBy: authOf(req).userId, metadata },
          );
          changed.push(rule.id);
        }
        const [first] = changed;
        if (first) await rulesChanged(core, tx, first, "agent_messaging_bot");
        return botView(req, tx, perms, bot);
      }),
  );

  app.get(
    "/agent-messaging",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("rule.read")],
      schema: { tags, response: { 200: AgentMessagingSettingsSchema } },
    },
    async (req) => core.db.withTenant(tenant(req), (tx) => settingsView(req, tx, perms)),
  );

  app.put(
    "/agent-messaging",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("rule.manage")],
      schema: {
        tags,
        body: UpdateAgentMessagingSettingsRequest,
        response: { 200: AgentMessagingSettingsSchema },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const existing = await switchRows(tx);
        const metadata = { via: VIA };
        const changed: string[] = [];
        if (req.body.enabled) {
          if (existing.length === 0) {
            const rule = await insertRuleRow(
              core,
              tx,
              {
                scopeUnitId: null,
                subjectKind: "everyone",
                subjectId: null,
                permission: PERMISSION,
                tool: null,
                effect: "allow",
              },
              { createdBy: authOf(req).userId, metadata },
            );
            changed.push(rule.id);
          }
        } else {
          for (const row of existing) {
            if (await deleteRuleRow(core, tx, row, metadata)) changed.push(row.id);
          }
        }
        const [first] = changed;
        if (first)
          await rulesChanged(
            core,
            tx,
            first,
            req.body.enabled ? "agent_messaging_on" : "agent_messaging_off",
          );
        return settingsView(req, tx, perms);
      }),
  );
}
