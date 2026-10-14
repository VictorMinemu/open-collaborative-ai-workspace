import {
  type Agent,
  type AgentTemplate,
  type AgentTemplateChangedField,
  type AgentTemplateLink,
  type AgentTemplateList,
  type AgentTemplateOptions,
  type AgentTemplatePreview,
  type AgentTemplateSkip,
  type AgentTemplateToolGrant,
  type AgentTemplateVersion,
  type AgentTemplateVersionBody,
  type ConnectionStatus,
  type CreateAgentTemplateRequest,
  EventTypes,
  type InstantiateAgentTemplateRequest,
  type InstantiateAgentTemplateResponse,
  isDangerousToolName,
  type Permission,
  type ToolGrant,
  type UpdateAgentTemplateRequest,
} from "@ocw/contracts";
import {
  agents,
  agentTemplates,
  agentTemplateVersions,
  agentVaultGrants,
  connectorConnections,
  mcpServers,
  orgMembers,
  orgUnits,
  type Tx,
  tenantOf,
  vaultItems,
} from "@ocw/db";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf, type Core } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { loadCatalog, loadGrants, loadPolicy, replaceGrants } from "../bot-capabilities";
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
import {
  type AgentUnit,
  agentFacts,
  findAgent,
  isModelAllowed,
  loadAgentUnit,
  notifyCell,
  publishAgent,
  toAgentDto,
} from "./service";

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

/** One template tool grant as a bot grant (`tool` is the OpenClaw tool name). */
const asToolGrant = (g: AgentTemplateToolGrant): ToolGrant => ({
  sourceKind: g.sourceKind,
  sourceId: g.sourceId,
  tool: g.toolName,
});

/**
 * Checks one version body against this tenant (WINDOWS 169: every id resolved under RLS, so another organization's id
 * reads as missing): the model is one the organization allows; every tool is in the catalog and never a dangerous one;
 * required connectors are per-member connectors; keys are unit keys of the template's own unit.
 */
async function assertVersionRefs(
  core: Core,
  tx: Tx,
  body: AgentTemplateVersionBody,
  unitId: string | null,
): Promise<void> {
  if (!(await isModelAllowed(core, tx, body.modelProvider, body.modelId))) {
    throw badRequest("This model is not in the organization's allowed list", "model_not_allowed");
  }
  if (body.toolGrants.length > 0) {
    const catalog = await loadCatalog(tx);
    for (const g of body.toolGrants) {
      if (isDangerousToolName(g.toolName)) {
        throw badRequest(`The tool ${g.toolName} can never be enabled on a bot`, "dangerous_tool");
      }
      const known = catalog.some(
        (src) =>
          src.sourceKind === g.sourceKind &&
          src.sourceId === g.sourceId &&
          src.tools.some((t) => t.name === g.toolName),
      );
      if (!known) throw badRequest(`Unknown tool ${g.toolName}`, "unknown_tool");
    }
  }
  const connectorIds = [...new Set(body.requiredConnectorIds)];
  if (connectorIds.length > 0) {
    const found = await tx
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(inArray(mcpServers.id, connectorIds), ne(mcpServers.authMode, "org_secret")));
    if (found.length !== connectorIds.length) {
      throw badRequest(
        "A required connector must be a connector members connect themselves",
        "unknown_connector",
      );
    }
  }
  const keyIds = [...new Set(body.unitVaultItemIds)];
  if (keyIds.length > 0) {
    const found = await tx
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(
        and(
          inArray(vaultItems.id, keyIds),
          eq(vaultItems.scope, "unit"),
          unitId ? eq(vaultItems.unitId, unitId) : isNull(vaultItems.unitId),
        ),
      );
    if (found.length !== keyIds.length) {
      throw badRequest("A template can only grant its own unit's keys", "unknown_vault_item");
    }
  }
}

/**
 * 409 when a live template with this name already exists in the same place (unit or organization). Writers of one
 * place are serialised (transaction-scoped advisory lock), so two concurrent creates cannot both pass the check.
 */
async function assertNameFree(tx: Tx, unitId: string | null, name: string, exceptId?: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`ocw:agent-template-names:${unitId ?? "org"}`}))`,
  );
  const [taken] = await tx
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(
      and(
        isNull(agentTemplates.archivedAt),
        unitId ? eq(agentTemplates.unitId, unitId) : isNull(agentTemplates.unitId),
        sql`lower(${agentTemplates.name}) = lower(${name})`,
        exceptId ? ne(agentTemplates.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (taken) throw conflict(`A template named “${name}” already exists here`, "template_name_taken");
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
  await assertVersionRefs(core, tx, body.version, unit?.id ?? null);
  await assertNameFree(tx, unit?.id ?? null, body.name);

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

/** A template the caller may see and manage (`agent_template.manage` on its unit or the organization), else 404/403. */
async function managedTemplate(core: Core, req: FastifyRequest, tx: Tx, id: string) {
  const found = await visibleTemplate(core, req, tx, id);
  await createPermissionService(core).assertCan(req, tx, "agent_template.manage", manageResource(found.unit));
  return found;
}

/**
 * `POST /agent-templates/:id/versions`: the next immutable version. Started agents keep theirs until their owner
 * applies the new one (a fork, never a live link).
 */
export async function publishVersion(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  id: string,
  body: AgentTemplateVersionBody,
): Promise<AgentTemplate> {
  const auth = authOf(req);
  const found = await managedTemplate(core, req, tx, id);
  // Serialise publishers of the same template: version numbers never collide.
  const [locked] = await tx.select().from(agentTemplates).where(eq(agentTemplates.id, id)).for("update");
  if (!locked) throw notFound(TEMPLATE_NOT_FOUND, "template_not_found");
  if (locked.archivedAt) throw conflict("This template was archived.", "template_archived");
  await assertVersionRefs(core, tx, body, locked.unitId);
  const version = locked.currentVersion + 1;
  await insertVersion(tx, id, version, body, auth.userId);
  const [t] = await tx
    .update(agentTemplates)
    .set({ currentVersion: version, updatedAt: new Date().toISOString() })
    .where(eq(agentTemplates.id, id))
    .returning();
  if (!t) throw notFound(TEMPLATE_NOT_FOUND, "template_not_found");
  await core.audit.record(tx, {
    action: "agent_template.version_published",
    resourceType: "agent_template",
    resourceId: id,
    sessionId: auth.sessionId,
    metadata: { templateId: id, version },
  });
  return templateDto(tx, t, found);
}

/** `PATCH /agent-templates/:id`: name, description, archived (a body change is a new version). */
export async function updateTemplate(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  id: string,
  body: UpdateAgentTemplateRequest,
): Promise<AgentTemplate> {
  const auth = authOf(req);
  const found = await managedTemplate(core, req, tx, id);
  const t = found.template;
  const changed: string[] = [];
  const next: Partial<typeof agentTemplates.$inferInsert> = {};
  if (body.name !== undefined && body.name !== t.name) {
    next.name = body.name;
    changed.push("name");
  }
  if (body.description !== undefined && body.description !== t.description) {
    next.description = body.description;
    changed.push("description");
  }
  const archiving = body.archived === true && t.archivedAt === null;
  const restoring = body.archived === false && t.archivedAt !== null;
  if (archiving) next.archivedAt = new Date().toISOString();
  if (restoring) {
    next.archivedAt = null;
    changed.push("archived");
  }
  if (!archiving && changed.length === 0) return templateDto(tx, t, found);
  // A live template's name stays unique in its place (a restored one too).
  if (!archiving && (next.name !== undefined || restoring)) {
    await assertNameFree(tx, t.unitId, next.name ?? t.name, t.id);
  }
  const [row] = await tx
    .update(agentTemplates)
    .set({ ...next, updatedAt: new Date().toISOString() })
    .where(eq(agentTemplates.id, id))
    .returning();
  if (!row) throw notFound(TEMPLATE_NOT_FOUND, "template_not_found");
  if (archiving) {
    await core.audit.record(tx, {
      action: "agent_template.archived",
      resourceType: "agent_template",
      resourceId: id,
      sessionId: auth.sessionId,
      metadata: { templateId: id },
    });
  }
  if (changed.length > 0) {
    await core.audit.record(tx, {
      action: "agent_template.updated",
      resourceType: "agent_template",
      resourceId: id,
      sessionId: auth.sessionId,
      // Field names only, never the text.
      metadata: { templateId: id, changed },
    });
  }
  return templateDto(tx, row, found);
}

/** `GET /agent-templates/options?unitId=`: the editor's choices for one unit (or the organization when omitted). */
export async function templateOptions(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  unitId: string | undefined,
): Promise<AgentTemplateOptions> {
  const unit = unitId ? await loadAgentUnit(tx, unitId) : null;
  if (unitId && !unit) throw notFound("Unit not found", "unit_not_found");
  await createPermissionService(core).assertCan(req, tx, "agent_template.manage", manageResource(unit));
  const catalog = await loadCatalog(tx);
  const tools = catalog.flatMap((src) =>
    src.tools
      .filter((t) => !isDangerousToolName(t.name))
      .map((t) => ({
        sourceKind: src.sourceKind,
        sourceId: src.sourceId,
        sourceName: src.sourceName,
        toolName: t.name,
        personalAllowed: src.personalAllowed,
      })),
  );
  const connectors = await tx
    .select({ serverId: mcpServers.id, name: mcpServers.name })
    .from(mcpServers)
    .where(ne(mcpServers.authMode, "org_secret"))
    .orderBy(asc(mcpServers.name), asc(mcpServers.id));
  // Id, name and handle only: never the value or its secret reference.
  const keys = await tx
    .select({ id: vaultItems.id, name: vaultItems.name, handle: vaultItems.handle })
    .from(vaultItems)
    .where(
      and(eq(vaultItems.scope, "unit"), unit ? eq(vaultItems.unitId, unit.id) : isNull(vaultItems.unitId)),
    )
    .orderBy(asc(vaultItems.name), asc(vaultItems.id));
  return { tools, connectors, vaultItems: keys };
}

// ---------------------------------------------------------------- what a member's agent gets

interface Plan {
  modelProvider: VersionRow["modelProvider"];
  modelId: string;
  capabilities: Record<string, unknown>;
  toolGrants: ToolGrant[];
  vaultItemIds: string[];
  skipped: AgentTemplateSkip[];
}

/**
 * The personal-agent caps applied to one version for the caller, who will own the bot (D-05, ADR-0010): the model must
 * be allowed for personal bots (else the default, reported); a built-in capability the policy keeps off for personal
 * bots is left off; the daily limit is clamped by the bot policy; tools only from sources allowed for personal bots;
 * unit keys only when the owner may `vault.use` them (the unit's audience and the resolver). Everything left out is
 * listed.
 */
async function planFor(core: Core, req: FastifyRequest, tx: Tx, v: VersionRow): Promise<Plan> {
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
  const capabilities: Record<string, unknown> = {};
  for (const cap of ["internet", "memory"] as const) {
    const entry = policy.capabilities[cap];
    const allowed = entry.orgWide && entry.personal;
    capabilities[cap] = body.capabilities[cap] && allowed;
    if (body.capabilities[cap] && !allowed)
      skipped.push({ kind: "capability", id: cap, reason: "not_personal_allowed" });
  }
  if (body.capabilities.dailyLimit !== null) {
    const wanted = Math.max(1, body.capabilities.dailyLimit);
    const clamped = Math.min(wanted, policy.personalDailyLimitMax);
    if (clamped !== body.capabilities.dailyLimit) {
      skipped.push({ kind: "capability", id: "dailyLimit", reason: "clamped" });
    }
    capabilities.dailyLimit = clamped;
  }

  const toolGrants: ToolGrant[] = [];
  if (body.toolGrants.length > 0) {
    const catalog = await loadCatalog(tx);
    for (const g of body.toolGrants) {
      const src = catalog.find((c) => c.sourceKind === g.sourceKind && c.sourceId === g.sourceId);
      const usable =
        !!src &&
        src.orgEnabled &&
        src.personalAllowed &&
        !isDangerousToolName(g.toolName) &&
        src.tools.some((t) => t.name === g.toolName);
      if (usable) toolGrants.push(asToolGrant(g));
      else skipped.push({ kind: "tool", id: g.toolName, reason: "not_personal_allowed" });
    }
  }

  const vaultItemIds: string[] = [];
  const keyIds = [...new Set(body.unitVaultItemIds)];
  if (keyIds.length > 0) {
    const perms = createPermissionService(core);
    const facts = await callerFacts(req, tx);
    const keys = await tx
      .select({ id: vaultItems.id, unitId: vaultItems.unitId })
      .from(vaultItems)
      .where(and(inArray(vaultItems.id, keyIds), eq(vaultItems.scope, "unit")));
    for (const id of keyIds) {
      const key = keys.find((k) => k.id === id);
      const unit = key ? await loadAgentUnit(tx, key.unitId) : null;
      const inAudience =
        !!key && (key.unitId === null || (unit !== null && inUnitAudience(facts, unit.path)));
      const allowed = inAudience && (await perms.can(req, tx, "vault.use", manageResource(unit)));
      if (allowed) vaultItemIds.push(id);
      else skipped.push({ kind: "vault_item", id, reason: "vault_denied" });
    }
  }
  return {
    modelProvider: model.provider,
    modelId: model.modelId,
    capabilities,
    toolGrants,
    vaultItemIds,
    skipped,
  };
}

/** Grants the plan's keys to a bot (existing grants are kept). */
async function grantVaultItems(tx: Tx, agentId: string, ids: readonly string[], by: string): Promise<void> {
  if (ids.length === 0) return;
  const { organizationId } = tenantOf(tx);
  await tx
    .insert(agentVaultGrants)
    .values(ids.map((vaultItemId) => ({ organizationId, agentId, vaultItemId, createdBy: by })))
    .onConflictDoNothing();
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
  const plan = await planFor(core, req, tx, version);
  return {
    skipped: plan.skipped,
    requiredConnectors: await connectorsWithStatus(
      tx,
      authOf(req).userId,
      version.requiredConnectorIds ?? [],
    ),
    ...(await capOf(req, tx)),
  };
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
  const plan = await planFor(core, req, tx, version);
  const created = await createPersonalBot(core, req, tx, {
    name: body.name ?? template.name,
    instructions: version.instructions,
    modelProvider: plan.modelProvider,
    modelId: plan.modelId,
    capabilities: plan.capabilities,
    templateId: template.id,
    templateVersion: version.version,
  });
  await replaceGrants(tx, created.agent.id, plan.toolGrants, auth.userId);
  await grantVaultItems(tx, created.agent.id, plan.vaultItemIds, auth.userId);
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
    requiredConnectors: await connectorsWithStatus(tx, auth.userId, version.requiredConnectorIds ?? []),
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
  if (!row?.templateId || !row.templateVersion || row.scope !== "personal" || row.ownerUserId !== me) {
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

/** What the caller may do with their own bot, as every bot detail reports it. */
const BOT_VIEWER_CAN: readonly Permission[] = ["bot.read", "bot.configure", "bot.manage"];

/**
 * `POST /agents/:id/template/apply`: the owner overwrites the template-owned fields with the latest version (D-05:
 * updates fork, never link). Instructions, model and the capability toggles the template sets are replaced, the
 * previous version's tools are swapped for the new version's (tools the owner added himself stay), permitted keys are
 * added; the personal-agent caps are applied again. Memory, chats and connections stay. Audited
 * `agent.template_updated`.
 */
export async function applyTemplateUpdate(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  agentId: string,
  toVersion: number,
): Promise<Agent> {
  const auth = authOf(req);
  const perms = createPermissionService(core);
  const { row, templateId, version } = await ownTemplateBot(core, req, tx, agentId);
  const resource = agentResource(agentFacts(row), auth.userId);
  await perms.assertCan(req, tx, "bot.configure", resource, { hideAs404: true });
  const [t] = await tx.select().from(agentTemplates).where(eq(agentTemplates.id, templateId)).limit(1);
  if (!t || !(await accessTo(core, req, tx, t, await callerFacts(req, tx))).visible) {
    throw notFound(TEMPLATE_NOT_FOUND, "template_not_found");
  }
  if (toVersion !== t.currentVersion || toVersion <= version) {
    throw conflict("A newer version was published. Review it again.", "template_version_conflict");
  }
  const previous = versionBodyOf(await loadVersion(tx, t.id, version));
  const target = await loadVersion(tx, t.id, toVersion);
  const plan = await planFor(core, req, tx, target);

  // Tools: the previous version's grants are the template's; anything else on the bot is the owner's own.
  const templateOwned = new Set(
    previous.toolGrants.map((g) => `${g.sourceKind}:${g.sourceId}:${g.toolName}`),
  );
  const own = (await loadGrants(tx, row.id)).filter(
    (g) => !templateOwned.has(`${g.sourceKind}:${g.sourceId}:${g.tool}`),
  );
  await replaceGrants(tx, row.id, [...own, ...plan.toolGrants], auth.userId);
  await grantVaultItems(tx, row.id, plan.vaultItemIds, auth.userId);

  const cellChanged =
    row.instructions !== target.instructions ||
    row.modelProvider !== plan.modelProvider ||
    row.modelId !== plan.modelId;
  const status = cellChanged && row.status !== "disabled" ? "provisioning" : row.status;
  const [updated] = await tx
    .update(agents)
    .set({
      instructions: target.instructions,
      modelProvider: plan.modelProvider,
      modelId: plan.modelId,
      capabilities: { ...((row.capabilities ?? {}) as Record<string, unknown>), ...plan.capabilities },
      templateVersion: toVersion,
      status,
      statusMessage: status === row.status ? row.statusMessage : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agents.id, row.id))
    .returning();
  if (!updated) throw notFound("Bot not found", "agent_not_found");
  await core.audit.record(tx, {
    action: "agent.template_updated",
    resourceType: "agent",
    resourceId: row.id,
    agentId: row.id,
    sessionId: auth.sessionId,
    metadata: { templateId: t.id, from: version, to: toVersion, skipped: plan.skipped },
  });
  const dto = toAgentDto(updated);
  await publishAgent(core, tx, EventTypes.agentUpdated, dto);
  await notifyCell(core, tx, "agent.updated", row.id);
  return { ...dto, viewerCan: await perms.viewerCan(req, tx, resource, BOT_VIEWER_CAN) };
}
