import type {
  AgentTemplate,
  AgentTemplateChangedField,
  AgentTemplateLink,
  AgentTemplateList,
  AgentTemplatePreview,
  AgentTemplateSkip,
  AgentTemplateVersion,
  AgentTemplateVersionBody,
  ConnectionStatus,
  CreateAgentTemplateRequest,
  InstantiateAgentTemplateRequest,
  InstantiateAgentTemplateResponse,
} from "@ocw/contracts";
import {
  agents,
  agentTemplates,
  agentTemplateVersions,
  connectorConnections,
  mcpServers,
  orgMembers,
  orgUnits,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf, type Core } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { loadPolicy } from "../bot-capabilities";
import {
  agentResource,
  createPermissionService,
  loadPrincipalFacts,
  orgResource,
  type PrincipalFacts,
  type ResourceFacts,
  unitResource,
} from "../organization";
import { createPersonalBot, DEFAULT_MAX_PERSONAL_BOTS, personalModels } from "./personal";
import { type AgentUnit, agentFacts, findAgent, isModelAllowed, loadAgentUnit } from "./service";

/**
 * Agent templates (07.4-08, D-05, CONN-06, ADR-0010 privacy). A unit (or the organization) publishes immutable numbered
 * versions; a member starts a personal bot from the current one. The bot is a FORK: it records `template_id` and
 * `template_version` and is created by `createPersonalBot` (same advisory lock and cap as one-click bots). Template
 * routes only ever return what the template's authors wrote, never an instance's instructions or memory.
 *
 * Every referenced id (template, unit, model provider, tool source, connector, key) is resolved inside the caller's
 * tenant transaction: RLS hides other organizations' rows, so a cross-org id reads as missing (WINDOWS 169).
 */

type TemplateRow = typeof agentTemplates.$inferSelect;
type VersionRow = typeof agentTemplateVersions.$inferSelect;

export const TEMPLATE_NOT_FOUND = "Template not found";

// ---------------------------------------------------------------- visibility and management

/**
 * The audience of a unit template (same rule as unit personas and unit memory): a member of the unit or of a unit
 * below it, or a lead of a unit on its path.
 */
function inUnitAudience(p: PrincipalFacts, unitPath: readonly string[]): boolean {
  const unitId = unitPath[unitPath.length - 1];
  if (unitId !== undefined && p.memberUnitPaths.some((path) => path.includes(unitId))) return true;
  return unitPath.some((u) => p.leadOfUnitIds.has(u));
}

/** The resource `agent_template.manage` is decided on: the template's unit, or the organization. */
const manageResource = (unit: AgentUnit | null): ResourceFacts => (unit ? unitResource(unit) : orgResource());

interface Access {
  unit: AgentUnit | null;
  visible: boolean;
  canManage: boolean;
}

/** What the caller may do with one template: see it (org templates: everyone) and manage it (the resolver). */
async function accessTo(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  t: TemplateRow,
  facts: PrincipalFacts,
): Promise<Access> {
  const perms = createPermissionService(core);
  const unit = await loadAgentUnit(tx, t.unitId);
  const canManage = await perms.can(req, tx, "agent_template.manage", manageResource(unit));
  const visible = canManage || t.unitId === null || (unit !== null && inUnitAudience(facts, unit.path));
  return { unit, visible, canManage };
}

const callerFacts = (req: FastifyRequest, tx: Tx) =>
  loadPrincipalFacts(tx, { kind: "user", userId: authOf(req).userId });

/**
 * A template the caller may see, or 404 (nobody learns that another unit's template exists). `live` also refuses an
 * archived template with 409 `template_archived`.
 */
export async function visibleTemplate(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  id: string,
  opts: { live?: boolean } = {},
): Promise<{ template: TemplateRow } & Access> {
  const [t] = await tx.select().from(agentTemplates).where(eq(agentTemplates.id, id)).limit(1);
  if (!t) throw notFound(TEMPLATE_NOT_FOUND, "template_not_found");
  const access = await accessTo(core, req, tx, t, await callerFacts(req, tx));
  if (!access.visible) throw notFound(TEMPLATE_NOT_FOUND, "template_not_found");
  if (opts.live && t.archivedAt) throw conflict("This template was archived.", "template_archived");
  return { template: t, ...access };
}

// ---------------------------------------------------------------- DTOs

async function loadVersion(tx: Tx, templateId: string, version: number): Promise<VersionRow> {
  const [v] = await tx
    .select()
    .from(agentTemplateVersions)
    .where(and(eq(agentTemplateVersions.templateId, templateId), eq(agentTemplateVersions.version, version)))
    .limit(1);
  if (!v) throw new Error("template version missing");
  return v;
}

/** The stored version body (capabilities are re-read through the contract's shape). */
export function versionBodyOf(v: VersionRow): AgentTemplateVersionBody {
  const caps = (v.capabilities ?? {}) as Record<string, unknown>;
  return {
    instructions: v.instructions,
    modelProvider: v.modelProvider,
    modelId: v.modelId,
    capabilities: {
      internet: caps.internet === true,
      memory: caps.memory === true,
      dailyLimit: typeof caps.dailyLimit === "number" ? caps.dailyLimit : null,
    },
    toolGrants: v.toolGrants ?? [],
    requiredConnectorIds: v.requiredConnectorIds ?? [],
    unitVaultItemIds: v.unitVaultItemIds ?? [],
  };
}

async function memberNames(tx: Tx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ userId: orgMembers.userId, name: orgMembers.displayName })
    .from(orgMembers)
    .where(inArray(orgMembers.userId, wanted));
  return new Map(rows.map((r) => [r.userId, r.name]));
}

/** Connector names by id, resolved in the tenant (an id of another organization is simply absent). */
export async function connectorNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: mcpServers.id, name: mcpServers.name })
    .from(mcpServers)
    .where(inArray(mcpServers.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function versionDto(v: VersionRow, names: Map<string, string>): AgentTemplateVersion {
  return {
    ...versionBodyOf(v),
    templateId: v.templateId,
    version: v.version,
    createdAt: new Date(v.createdAt).toISOString(),
    createdBy: v.createdBy,
    createdByName: v.createdBy ? (names.get(v.createdBy) ?? null) : null,
  };
}

async function templateDto(tx: Tx, t: TemplateRow, access: Access): Promise<AgentTemplate> {
  const latest = await loadVersion(tx, t.id, t.currentVersion);
  const names = await memberNames(tx, [latest.createdBy]);
  const connectors = await connectorNames(tx, latest.requiredConnectorIds ?? []);
  return {
    id: t.id,
    unitId: t.unitId,
    unitName: access.unit?.name ?? null,
    name: t.name,
    description: t.description,
    currentVersion: t.currentVersion,
    archivedAt: t.archivedAt ? new Date(t.archivedAt).toISOString() : null,
    latest: versionDto(latest, names),
    canManage: access.canManage,
    requiredConnectors: (latest.requiredConnectorIds ?? []).flatMap((serverId) => {
      const name = connectors.get(serverId);
      return name ? [{ serverId, name }] : [];
    }),
  };
}

// ---------------------------------------------------------------- list, create

/** Live templates the caller may see, and where the caller may publish new ones. */
export async function listTemplates(core: Core, req: FastifyRequest, tx: Tx): Promise<AgentTemplateList> {
  const perms = createPermissionService(core);
  const facts = await callerFacts(req, tx);
  const rows = await tx
    .select()
    .from(agentTemplates)
    .where(isNull(agentTemplates.archivedAt))
    .orderBy(asc(agentTemplates.name), asc(agentTemplates.id));
  const templates: AgentTemplate[] = [];
  for (const t of rows) {
    const access = await accessTo(core, req, tx, t, facts);
    if (access.visible) templates.push(await templateDto(tx, t, access));
  }
  const units = await tx
    .select({ id: orgUnits.id, name: orgUnits.name, path: orgUnits.path })
    .from(orgUnits)
    .orderBy(asc(orgUnits.name), asc(orgUnits.id));
  const manageable = await perms.filter(req, tx, units, "agent_template.manage", (u) => unitResource(u));
  const manageableUnits = [
    ...((await perms.can(req, tx, "agent_template.manage", orgResource()))
      ? [{ unitId: null, name: "Organization" }]
      : []),
    ...manageable.map((u) => ({ unitId: u.id, name: u.name })),
  ];
  return { templates, manageableUnits };
}

/**
 * Checks one version body against this tenant: the model is one the organization allows. (Tools, connectors and keys
 * are checked by `assertVersionRefs`.)
 */
async function assertVersionRefs(core: Core, tx: Tx, body: AgentTemplateVersionBody): Promise<void> {
  if (!(await isModelAllowed(core, tx, body.modelProvider, body.modelId))) {
    throw badRequest("This model is not in the organization's allowed list", "model_not_allowed");
  }
}

async function insertVersion(
  tx: Tx,
  templateId: string,
  version: number,
  body: AgentTemplateVersionBody,
  by: string,
) {
  const { organizationId } = tenantOf(tx);
  const [row] = await tx
    .insert(agentTemplateVersions)
    .values({
      organizationId,
      templateId,
      version,
      instructions: body.instructions,
      modelProvider: body.modelProvider,
      modelId: body.modelId,
      capabilities: { ...body.capabilities },
      toolGrants: body.toolGrants,
      requiredConnectorIds: [...new Set(body.requiredConnectorIds)],
      unitVaultItemIds: [...new Set(body.unitVaultItemIds)],
      createdBy: by,
    })
    .returning();
  if (!row) throw new Error("template version insert failed");
  return row;
}

/** `POST /agent-templates`: the template and its version 1 (`agent_template.manage` on the unit or the org). */
export async function createTemplate(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  body: CreateAgentTemplateRequest,
): Promise<AgentTemplate> {
  const perms = createPermissionService(core);
  const auth = authOf(req);
  const unit = body.unitId ? await loadAgentUnit(tx, body.unitId) : null;
  if (body.unitId && !unit) throw notFound("Unit not found", "unit_not_found");
  await perms.assertCan(req, tx, "agent_template.manage", manageResource(unit));
  await assertVersionRefs(core, tx, body.version);

  const [t] = await tx
    .insert(agentTemplates)
    .values({
      organizationId: auth.organizationId,
      unitId: unit?.id ?? null,
      name: body.name,
      description: body.description,
      currentVersion: 1,
      createdBy: auth.userId,
    })
    .returning();
  if (!t) throw new Error("template insert failed");
  await insertVersion(tx, t.id, 1, body.version, auth.userId);
  await core.audit.record(tx, {
    action: "agent_template.created",
    resourceType: "agent_template",
    resourceId: t.id,
    sessionId: auth.sessionId,
    // Ids only: never the instructions.
    metadata: { templateId: t.id, unitId: t.unitId, version: 1 },
  });
  return templateDto(tx, t, { unit, visible: true, canManage: true });
}

// ---------------------------------------------------------------- what a member's agent gets

interface Plan {
  modelProvider: VersionRow["modelProvider"];
  modelId: string;
  capabilities: Record<string, unknown>;
  skipped: AgentTemplateSkip[];
}

/**
 * The personal-agent caps applied to one version for the caller (D-05): the model must be allowed for personal bots
 * (else the default, reported) and the daily limit is clamped by the bot policy.
 */
async function planFor(core: Core, tx: Tx, v: VersionRow): Promise<Plan> {
  const body = versionBodyOf(v);
  const skipped: AgentTemplateSkip[] = [];
  const policy = await loadPolicy(tx);
  const models = await personalModels(core, tx);
  let model = models.find((m) => m.provider === body.modelProvider && m.modelId === body.modelId);
  if (!model) {
    model = models.find((m) => m.isDefault) ?? models[0];
    if (!model) {
      throw conflict(
        "No model is available yet: an admin needs to connect a model provider first",
        "no_models",
      );
    }
    skipped.push({ kind: "model", id: `${body.modelProvider}/${body.modelId}`, reason: "model_not_allowed" });
  }
  const capabilities: Record<string, unknown> = {
    internet: body.capabilities.internet,
    memory: body.capabilities.memory,
  };
  if (body.capabilities.dailyLimit !== null) {
    const wanted = Math.max(1, body.capabilities.dailyLimit);
    const clamped = Math.min(wanted, policy.personalDailyLimitMax);
    if (clamped !== body.capabilities.dailyLimit) {
      skipped.push({ kind: "capability", id: "dailyLimit", reason: "clamped" });
    }
    capabilities.dailyLimit = clamped;
  }
  return { modelProvider: model.provider, modelId: model.modelId, capabilities, skipped };
}

/** The caller's personal-bot count against the policy cap. */
async function capOf(req: FastifyRequest, tx: Tx): Promise<{ capReached: boolean; limit: number }> {
  const policy = await loadPolicy(tx);
  const limit = policy.maxPersonalBotsPerUser ?? DEFAULT_MAX_PERSONAL_BOTS;
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(agents)
    .where(
      and(eq(agents.scope, "personal"), eq(agents.ownerUserId, authOf(req).userId), isNull(agents.deletedAt)),
    );
  return { capReached: n >= limit, limit };
}

/** `GET /agent-templates/:id/preview`: what the caller's agent would get from the current version, and the cap. */
export async function previewTemplate(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  templateId: string,
): Promise<AgentTemplatePreview> {
  const { template } = await visibleTemplate(core, req, tx, templateId, { live: true });
  const version = await loadVersion(tx, template.id, template.currentVersion);
  const plan = await planFor(core, tx, version);
  return { skipped: plan.skipped, requiredConnectors: [], ...(await capOf(req, tx)) };
}

/**
 * `POST /agent-templates/:id/instantiate`: the caller's own personal bot from the current version, created by
 * `createPersonalBot` (its advisory lock and cap, its DM, its `agent.created` audit), then audited
 * `agent.created_from_template` with what was left out.
 */
export async function instantiateTemplate(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  templateId: string,
  body: InstantiateAgentTemplateRequest,
): Promise<InstantiateAgentTemplateResponse> {
  const auth = authOf(req);
  const { template } = await visibleTemplate(core, req, tx, templateId, { live: true });
  const version = await loadVersion(tx, template.id, template.currentVersion);
  const plan = await planFor(core, tx, version);
  const created = await createPersonalBot(core, req, tx, {
    name: body.name ?? template.name,
    instructions: version.instructions,
    modelProvider: plan.modelProvider,
    modelId: plan.modelId,
    capabilities: plan.capabilities,
    templateId: template.id,
    templateVersion: version.version,
  });
  await core.audit.record(tx, {
    action: "agent.created_from_template",
    resourceType: "agent",
    resourceId: created.agent.id,
    agentId: created.agent.id,
    sessionId: auth.sessionId,
    metadata: { templateId: template.id, version: version.version, skipped: plan.skipped },
  });
  const cap = await capOf(req, tx);
  return {
    agent: created.agent,
    dmConversationId: created.dmId,
    skipped: plan.skipped,
    requiredConnectors: [],
    capReached: cap.capReached,
    limit: cap.limit,
  };
}

// ---------------------------------------------------------------- an instance's link to its template (owner only)

/** The required connectors with the caller's own connection status (connections are per member, never per bot). */
async function connectorsWithStatus(
  tx: Tx,
  userId: string,
  ids: readonly string[],
): Promise<Array<{ serverId: string; name: string; status: ConnectionStatus }>> {
  const names = await connectorNames(tx, ids);
  if (names.size === 0) return [];
  const rows = await tx
    .select({ serverId: connectorConnections.serverId, status: connectorConnections.status })
    .from(connectorConnections)
    .where(
      and(eq(connectorConnections.userId, userId), inArray(connectorConnections.serverId, [...names.keys()])),
    );
  const status = new Map(rows.map((r) => [r.serverId, r.status]));
  return ids.flatMap((serverId) => {
    const name = names.get(serverId);
    return name ? [{ serverId, name, status: status.get(serverId) ?? ("not_connected" as const) }] : [];
  });
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const grantKeys = (v: AgentTemplateVersionBody) =>
  v.toolGrants.map((g) => `${g.sourceKind}:${g.sourceId}:${g.toolName}`);

/** Which template-owned fields differ between two versions (what applying `to` overwrites). */
export function changedFields(
  from: AgentTemplateVersionBody,
  to: AgentTemplateVersionBody,
): AgentTemplateChangedField[] {
  const out: AgentTemplateChangedField[] = [];
  if (from.instructions !== to.instructions) out.push("instructions");
  if (from.modelProvider !== to.modelProvider || from.modelId !== to.modelId) out.push("model");
  const fc = from.capabilities;
  const tc = to.capabilities;
  if (fc.internet !== tc.internet || fc.memory !== tc.memory || fc.dailyLimit !== tc.dailyLimit) {
    out.push("capabilities");
  }
  if (!sameSet(grantKeys(from), grantKeys(to))) out.push("toolGrants");
  if (!sameSet(from.requiredConnectorIds, to.requiredConnectorIds)) out.push("requiredConnectors");
  if (!sameSet(from.unitVaultItemIds, to.unitVaultItemIds)) out.push("vaultItems");
  return out;
}

/**
 * The caller's own template-made bot, or 404 for anyone else (admins and the template's authors included: ADR-0010,
 * a personal bot exists only for its owner) and for bots not made from a template.
 */
async function ownTemplateBot(core: Core, req: FastifyRequest, tx: Tx, agentId: string) {
  const me = authOf(req).userId;
  const row = await findAgent(tx, agentId);
  if (!row || row.scope !== "personal" || row.ownerUserId !== me || !row.templateId || !row.templateVersion) {
    throw notFound("Bot not found", "agent_not_found");
  }
  await createPermissionService(core).assertCan(req, tx, "bot.read", agentResource(agentFacts(row), me), {
    hideAs404: true,
  });
  return { row, templateId: row.templateId, version: row.templateVersion };
}

/** `GET /agents/:id/template`: the bot's template, its version, a newer one when there is, the owner's connections. */
export async function templateLinkFor(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  agentId: string,
): Promise<AgentTemplateLink> {
  const { templateId, version } = await ownTemplateBot(core, req, tx, agentId);
  const [t] = await tx.select().from(agentTemplates).where(eq(agentTemplates.id, templateId)).limit(1);
  if (!t) throw notFound("Bot not found", "agent_not_found");
  const mine = versionBodyOf(await loadVersion(tx, t.id, version));
  const facts = await callerFacts(req, tx);
  const { visible } = await accessTo(core, req, tx, t, facts);
  let update: AgentTemplateLink["update"] = null;
  if (visible && t.currentVersion > version) {
    const latest = versionBodyOf(await loadVersion(tx, t.id, t.currentVersion));
    update = { from: version, to: t.currentVersion, changedFields: changedFields(mine, latest) };
  }
  return {
    templateId: t.id,
    templateName: t.name,
    version,
    latestVersion: t.currentVersion,
    update,
    requiredConnectors: await connectorsWithStatus(tx, authOf(req).userId, mine.requiredConnectorIds),
  };
}
