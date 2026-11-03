import {
  type AgentMessagingSettings,
  AgentMessagingSettings as AgentMessagingSettingsSchema,
  type AuthzDenial,
  agentMessageTool,
  UpdateAgentMessagingSettingsRequest,
} from "@ocw/contracts";
import { agents, orgUnits, permissionRules, type Tx } from "@ocw/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
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

export function registerAgentMessagingRoutes(app: App, core: Core, perms: PermissionService): void {
  const tags = ["organization"];
  const requireUser = core.identity.requireUser;

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
