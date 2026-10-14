import {
  Agent,
  AgentList,
  AllowedModelList,
  CreateAgentRequest,
  CreatePersonalBotRequest,
  CreatePersonalBotResponse,
  catalogEntry,
  EventTypes,
  IdParams,
  isSubscriptionProvider,
  ModelProvider,
  ModelProviderList,
  Ok,
  OpenDmResponse,
  type Permission,
  ProviderParams,
  UpdateAgentRequest,
  UpsertModelProviderRequest,
} from "@ocw/contracts";
import {
  agents,
  conversationMembers,
  conversations,
  modelProviders,
  orgMembers,
  orgUnits,
  type Tx,
} from "@ocw/db";
import { and, asc, eq, inArray, isNull, like, ne, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type ApiModule, authOf, type Core, tenant } from "../../core";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { ensureDm, setAgentDmsArchived } from "../chat";
import {
  AuthzDeniedError,
  agentResource,
  createPermissionService,
  orgResource,
  type ResourceFacts,
  unitResource,
} from "../organization";
import { createPersonalBot, personalModels } from "./personal";
import { keyHint, nextFreeUsername, slugifyUsername } from "./providers";
import {
  type AgentUnit,
  agentAudience,
  agentFacts,
  allowedModels,
  findAgent,
  isModelAllowed,
  listAgentsWithUnits,
  loadAgentUnit,
  notifyCell,
  publishAgent,
  publishAgentDeleted,
  toAgentDto,
  toProviderDto,
} from "./service";
import { revokeSubscriptionInCell } from "./subscription";
import { registerTemplateRoutes } from "./templates-routes";

export { createPersonalBot, DEFAULT_MAX_PERSONAL_BOTS, type PersonalBotInput } from "./personal";
export {
  agentDirectory,
  agentFacts,
  allowedModels,
  applyCellStatus,
  cellAgents,
  cellProviders,
  cellSubscriptions,
  findAgent,
  listAgents,
  loadAgentUnit,
  toAgentDto,
} from "./service";
export {
  applySubscriptionConnected,
  markSubscriptionNeedsReconnect,
  subscriptionAccount,
} from "./subscription";

/** Fields the OpenClaw cell provisions from; changing one re-provisions the bot. */
const CELL_FIELDS = ["name", "username", "instructions", "modelProvider", "modelId", "description"] as const;

/** Per-bot permissions every bot list and detail reports as `viewerCan`. */
const BOT_VIEWER_CAN: readonly Permission[] = ["bot.read", "bot.configure", "bot.manage"];
/**
 * A unit persona also reports `bot.manage_unit`: its governance (enable, delete) by an admin or a lead of a unit on
 * its path (AGENT-01). Organization bots keep the Phase 1 set.
 */
const UNIT_BOT_VIEWER_CAN: readonly Permission[] = [...BOT_VIEWER_CAN, "bot.manage_unit"];

/**
 * Set as the status message when an admin (not the owner) disables a personal bot: the owner may still edit
 * it but cannot switch it back on; only someone holding `bot.manage` can (BOT-01 governance).
 */
export const GOVERNANCE_DISABLED_MESSAGE = "Disabled by a workspace admin";

/**
 * Resolver facts of one bot, as seen by `userId` (the `owner` relation only for the owner); `unitPath` = the path of
 * a unit persona's unit ([] = the organization).
 */
function botResource(
  a: { scope: Agent["scope"]; ownerUserId: string | null; status: string },
  userId: string,
  unitPath: readonly string[] = [],
) {
  return agentResource(agentFacts(a, unitPath), userId);
}

/** A unit of this tenant (RLS hides every other organization's: the FK alone would accept them), or 404. */
async function requireTenantUnit(tx: Tx, unitId: string): Promise<AgentUnit> {
  const u = await loadAgentUnit(tx, unitId);
  if (!u) throw notFound("Unit not found", "unit_not_found");
  return u;
}

/** An active member of this tenant may own a persona (T-06-07-04), else 404. */
async function requireActiveOwner(tx: Tx, userId: string): Promise<void> {
  const [m] = await tx
    .select({ deactivatedAt: orgMembers.deactivatedAt })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  if (!m || m.deactivatedAt !== null) throw notFound("Owner not found", "owner_not_found");
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * agent module: bots (first-class agent principals), model providers (admin; API keys encrypted through
 * core.secrets, never returned) and the allowed-model list. Provisioning in the OpenClaw cell is driven by
 * `cell.config.changed` events on `cell:<orgId>`; the cell acks through the Agent Channel API.
 */
const BOT_NOT_FOUND = "Bot not found";

/**
 * What a bot deletion tells the approvals it asked for (the approval primitive's gone path, WINDOWS 164): the server
 * never applies a request on behalf of a deleted bot. Structural: this module never imports `approval`.
 */
export interface AgentModuleDeps {
  approvals: { closeGone(tx: Tx, which: { requestedByAgentId: string }): Promise<unknown> };
}

export function createAgentModule(core: Core, deps: AgentModuleDeps): ApiModule {
  const perms = createPermissionService(core);
  const requireUser = core.identity.requireUser;
  /**
   * A bot the caller may not see reads exactly like a missing one (same status, code and message), or the message
   * itself would tell that the bot exists (07.3-01 open item 5).
   */
  async function assertHidden(
    req: FastifyRequest,
    tx: Tx,
    permission: Permission,
    resource: ResourceFacts,
  ): Promise<void> {
    try {
      await perms.assertCan(req, tx, permission, resource, { hideAs404: true });
    } catch (err) {
      if (err instanceof AuthzDeniedError && err.hidden) {
        throw new AuthzDeniedError(err.denial, { hideAs404: true, message: BOT_NOT_FOUND });
      }
      throw err;
    }
  }
  // Every route is a signed-in user's, decided by the resolver on an organization-scope permission.
  const user = { authz: "user" as const };
  const allow = {
    "provider.manage": {
      config: user,
      preHandler: [requireUser, perms.requirePermission("provider.manage")],
    },
    "bot.read": { config: user, preHandler: [requireUser, perms.requirePermission("bot.read")] },
  };

  return {
    name: "agent",
    register(app) {
      // ---------------------------------------------------------------- model providers (provider.manage)
      app.get(
        "/model-providers",
        { ...allow["provider.manage"], schema: { tags: ["agent"], response: { 200: ModelProviderList } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const rows = await tx.select().from(modelProviders).orderBy(asc(modelProviders.createdAt));
            return {
              providers: rows.filter((r) => r.provider !== "mock").map(toProviderDto),
              mockEnabled: core.env.OCW_MODEL_PROVIDER === "mock",
            };
          }),
      );

      app.post(
        "/model-providers",
        {
          ...allow["provider.manage"],
          schema: { tags: ["agent"], body: UpsertModelProviderRequest, response: { 200: ModelProvider } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const body = req.body;
            const [existing] = await tx
              .select()
              .from(modelProviders)
              .where(eq(modelProviders.provider, body.provider));
            if (isSubscriptionProvider(body.provider)) {
              // Subscriptions are created by signing in through the cell; here only models/enabled change.
              if (body.apiKey || body.baseUrl) {
                throw badRequest(
                  "This provider connects by signing in, not with a key",
                  "subscription_provider",
                );
              }
              if (!existing) throw conflict("Connect the subscription first", "not_connected");
            } else if (!existing && !body.apiKey) {
              throw badRequest("An API key is required", "api_key_required");
            }
            const baseUrl = body.baseUrl === undefined ? (existing?.baseUrl ?? null) : body.baseUrl;
            if (catalogEntry(body.provider)?.baseUrlRequired && !baseUrl) {
              throw badRequest("A base URL is required for this provider", "base_url_required");
            }
            const allowed = [...new Set(body.allowedModels.map((m) => m.trim()))];

            // The key lives behind a SecretReference (D-07); `secret_id` mirrors a `db` reference only so the
            // documented rollback of the 05-01 backfill stays possible. Nothing reads `secret_id` for resolution.
            let secretRef = existing?.secretRef ?? null;
            let secretId = existing?.secretId ?? null;
            let hint = existing?.keyHint ?? null;
            const oldRef = body.apiKey ? secretRef : null;
            const oldSecretId = body.apiKey ? secretId : null;
            if (body.apiKey) {
              secretId = await core.secrets.put(tx, {
                name: `${body.provider} API key`,
                kind: "provider_api_key",
                provider: body.provider,
                value: body.apiKey,
              });
              secretRef = { provider: "db", secretId, organizationId: auth.organizationId };
              hint = keyHint(body.apiKey);
            }
            const now = new Date().toISOString();
            const values = {
              secretRef,
              secretId,
              keyHint: hint,
              baseUrl,
              allowedModels: allowed,
              enabled: body.enabled,
              updatedAt: now,
            };
            const [row] = existing
              ? await tx
                  .update(modelProviders)
                  .set(values)
                  .where(eq(modelProviders.id, existing.id))
                  .returning()
              : await tx
                  .insert(modelProviders)
                  .values({ organizationId: auth.organizationId, provider: body.provider, ...values })
                  .returning();
            if (!row) throw new Error("model provider upsert failed");
            // A replaced key's sealed row goes away (whether it was referenced by `secret_ref`, `secret_id` or both).
            for (const stale of new Set([oldRef?.provider === "db" ? oldRef.secretId : null, oldSecretId])) {
              if (stale && stale !== secretId) await core.secrets.remove(tx, stale);
            }

            await core.audit.record(tx, {
              action: existing ? "model_provider.updated" : "model_provider.created",
              resourceType: "model_provider",
              resourceId: row.id,
              sessionId: auth.sessionId,
              // Never the key itself; only whether it changed.
              metadata: {
                provider: body.provider,
                keyChanged: !!body.apiKey,
                baseUrl,
                allowedModels: allowed,
                enabled: body.enabled,
              },
            });
            const dto = toProviderDto(row);
            await core.realtime.appendEvent(
              tx,
              `org:${auth.organizationId}`,
              EventTypes.modelProvidersUpdated,
              { provider: dto.provider },
            );
            await notifyCell(core, tx, "providers.updated", null);
            return dto;
          }),
      );

      app.delete(
        "/model-providers/:provider",
        {
          ...allow["provider.manage"],
          schema: { tags: ["agent"], params: ProviderParams, response: { 200: Ok } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const [row] = await tx
              .delete(modelProviders)
              .where(eq(modelProviders.provider, req.params.provider))
              .returning();
            if (!row) throw notFound("Provider not configured");
            for (const stale of new Set([
              row.secretRef?.provider === "db" ? row.secretRef.secretId : null,
              row.secretId,
            ])) {
              if (stale) await core.secrets.remove(tx, stale);
            }
            const subscription = isSubscriptionProvider(row.provider);
            await core.audit.record(tx, {
              action: subscription ? "model_provider.disconnected" : "model_provider.deleted",
              resourceType: "model_provider",
              resourceId: row.id,
              sessionId: auth.sessionId,
              metadata: subscription
                ? { provider: row.provider, accountEmail: row.account?.email ?? null }
                : { provider: row.provider },
            });
            // The cell deletes its stored sign-in for this subscription (same transaction as the row).
            if (isSubscriptionProvider(row.provider)) await revokeSubscriptionInCell(core, tx, row.provider);
            await core.realtime.appendEvent(
              tx,
              `org:${auth.organizationId}`,
              EventTypes.modelProvidersUpdated,
              { provider: row.provider },
            );
            await notifyCell(core, tx, "providers.updated", null);
            return { ok: true as const };
          }),
      );

      app.get(
        "/models",
        { ...allow["bot.read"], schema: { tags: ["agent"], response: { 200: AllowedModelList } } },
        async (req) => ({
          models: await core.db.withTenant(tenant(req), (tx) => allowedModels(core, tx)),
        }),
      );

      // ---------------------------------------------------------------- bots
      // Lists and details are decided per bot (`bot.read` on the agent resource): a personal bot exists only
      // for its owner, admins included (D-01, T-03.1-02-01). Personal bots are governed through 03.1-03's list.
      const withViewerCan = async (
        req: FastifyRequest,
        tx: Tx,
        a: Agent,
        unitPath: readonly string[],
      ): Promise<Agent> => ({
        ...a,
        viewerCan: await perms.viewerCan(
          req,
          tx,
          botResource(a, authOf(req).userId, unitPath),
          unitPath.length ? UNIT_BOT_VIEWER_CAN : BOT_VIEWER_CAN,
        ),
      });

      app.get(
        "/agents",
        { config: user, preHandler: requireUser, schema: { tags: ["agent"], response: { 200: AgentList } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const me = authOf(req).userId;
            const rows = (await listAgentsWithUnits(tx)).filter(
              (r) => r.agent.scope === "team" || r.agent.ownerUserId === me,
            );
            const visible = await perms.filter(req, tx, rows, "bot.read", (r) =>
              botResource(r.agent, me, r.unitPath),
            );
            const out: Agent[] = [];
            for (const r of visible) out.push(await withViewerCan(req, tx, r.agent, r.unitPath));
            // Where the caller may create a shared persona (AGENT-01): the resolver decides per unit.
            const units = await tx.select().from(orgUnits).orderBy(asc(orgUnits.createdAt), asc(orgUnits.id));
            const creatable = await perms.filter(req, tx, units, "bot.manage_unit", (u) => unitResource(u));
            return {
              agents: out,
              create: {
                organization: await perms.can(req, tx, "bot.manage", orgResource()),
                unitIds: creatable.map((u) => u.id),
              },
            };
          }),
      );

      app.get(
        "/agents/:id",
        {
          config: user,
          preHandler: requireUser,
          schema: { tags: ["agent"], params: IdParams, response: { 200: Agent } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const row = await findAgent(tx, req.params.id);
            if (!row) throw notFound(BOT_NOT_FOUND);
            const unit = await loadAgentUnit(tx, row.unitId);
            await assertHidden(req, tx, "bot.read", botResource(row, authOf(req).userId, unit?.path));
            return withViewerCan(req, tx, toAgentDto(row, unit), unit?.path ?? []);
          }),
      );

      // SC2 (D-03): the caller's private chat with a bot they may use, created on first use. One DM per
      // (bot, member): two members never share history.
      app.post(
        "/agents/:id/dm",
        {
          config: user,
          preHandler: requireUser,
          schema: { tags: ["agent"], params: IdParams, response: { 200: OpenDmResponse } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const row = await findAgent(tx, req.params.id);
            if (!row) throw notFound(BOT_NOT_FOUND);
            const unit = await loadAgentUnit(tx, row.unitId);
            await assertHidden(req, tx, "bot.read", botResource(row, auth.userId, unit?.path));
            if (row.status === "disabled") throw conflict("This bot is disabled", "bot_disabled");
            const { conv, created } = await ensureDm(
              tx,
              { audit: core.audit, realtime: core.realtime },
              { agentId: row.id, userId: auth.userId },
            );
            if (created) {
              await core.audit.record(tx, {
                action: "dm.opened",
                resourceType: "conversation",
                resourceId: conv.id,
                agentId: row.id,
                sessionId: auth.sessionId,
                metadata: { agentId: row.id },
              });
            }
            return { dmId: conv.id, created };
          }),
      );

      // AGENT-01: an organization persona needs `bot.manage`; a department, team or project persona needs
      // `bot.manage_unit` on its unit (admins everywhere, unit leads on the subtrees they lead).
      app.post(
        "/agents",
        {
          config: user,
          preHandler: requireUser,
          schema: { tags: ["agent"], body: CreateAgentRequest, response: { 200: Agent } },
        },
        async (req) => {
          try {
            return await core.db.withTenant(tenant(req), async (tx) => {
              const auth = authOf(req);
              const body = req.body;
              const unit = body.unitId ? await requireTenantUnit(tx, body.unitId) : null;
              if (unit) await perms.assertCan(req, tx, "bot.manage_unit", unitResource(unit));
              else await perms.assertCan(req, tx, "bot.manage", orgResource());
              if (body.ownerUserId) await requireActiveOwner(tx, body.ownerUserId);
              // Default owner: none for an organization persona, the creator for a unit persona.
              const ownerUserId = body.ownerUserId ?? (unit ? auth.userId : null);
              if (!(await isModelAllowed(core, tx, body.modelProvider, body.modelId))) {
                throw badRequest("This model is not in the organization's allowed list", "model_not_allowed");
              }
              let username = body.username;
              if (username) {
                const [taken] = await tx
                  .select({ id: agents.id })
                  .from(agents)
                  .where(and(eq(agents.username, username), isNull(agents.deletedAt)));
                if (taken) throw conflict(`@${username} is already taken`, "username_taken");
              } else {
                const base = slugifyUsername(body.name);
                const rows = await tx
                  .select({ username: agents.username })
                  .from(agents)
                  .where(
                    and(
                      isNull(agents.deletedAt),
                      or(eq(agents.username, base), like(agents.username, `${base}-%`)),
                    ),
                  );
                username = nextFreeUsername(base, new Set(rows.map((r) => r.username)));
              }
              const [row] = await tx
                .insert(agents)
                .values({
                  organizationId: auth.organizationId,
                  name: body.name,
                  username,
                  avatarUrl: body.avatarUrl ?? null,
                  description: body.description || null,
                  instructions: body.instructions,
                  modelProvider: body.modelProvider,
                  modelId: body.modelId,
                  status: "provisioning",
                  createdBy: auth.userId,
                  ownerUserId,
                  unitId: unit?.id ?? null,
                })
                .returning();
              if (!row) throw new Error("agent insert failed");
              const dto = toAgentDto(row, unit);
              await core.audit.record(tx, {
                action: "agent.created",
                resourceType: "agent",
                resourceId: row.id,
                agentId: row.id,
                sessionId: auth.sessionId,
                // Ids only (T-06-07-05).
                metadata: {
                  username,
                  model: `${body.modelProvider}/${body.modelId}`,
                  runtime: "openclaw",
                  unitId: row.unitId,
                  ownerUserId: row.ownerUserId,
                },
              });
              await publishAgent(core, tx, EventTypes.agentCreated, dto);
              await notifyCell(core, tx, "agent.created", row.id);
              return withViewerCan(req, tx, dto, unit?.path ?? []);
            });
          } catch (err) {
            if (isUniqueViolation(err)) throw conflict("That username is already taken", "username_taken");
            throw err;
          }
        },
      );

      // One click (BOT-01): any member the resolver allows `bot.create_personal` (decided inside).
      app.post(
        "/agents/personal",
        {
          config: user,
          preHandler: requireUser,
          schema: {
            tags: ["agent"],
            body: CreatePersonalBotRequest,
            response: { 200: CreatePersonalBotResponse },
          },
        },
        async (req) => {
          try {
            return await core.db.withTenant(tenant(req), (tx) => createPersonalBot(core, req, tx, req.body));
          } catch (err) {
            if (isUniqueViolation(err)) throw conflict("That username is already taken", "username_taken");
            throw err;
          }
        },
      );

      // 07.4-08: agent templates (D-05); a started agent is a personal bot made by createPersonalBot.
      registerTemplateRoutes(app, core, isUniqueViolation);

      // Per-bot decision (D-01/D-02, AGENT-01). A personal bot takes field edits from its owner only
      // (`bot.configure`) and `{enabled}` from its owner or an admin (`bot.manage`, governance); it never takes a unit
      // or another owner. A shared persona: fields and owner need `bot.configure` (admins, its owner, leads of a unit
      // on its path); `{enabled}` needs `bot.manage` (organization) or `bot.manage_unit` (unit persona); a move needs
      // the right on both the old and the new place. Nobody learns a personal bot or someone else's unit persona
      // exists (404).
      app.patch(
        "/agents/:id",
        {
          config: user,
          preHandler: requireUser,
          schema: { tags: ["agent"], params: IdParams, body: UpdateAgentRequest, response: { 200: Agent } },
        },
        async (req) => {
          try {
            return await core.db.withTenant(tenant(req), async (tx) => {
              const auth = authOf(req);
              const body = req.body;
              const row = await findAgent(tx, req.params.id);
              if (!row) throw notFound(BOT_NOT_FOUND);
              const unit = await loadAgentUnit(tx, row.unitId);
              const resource = botResource(row, auth.userId, unit?.path);
              const personal = row.scope === "personal";
              const owner = personal && row.ownerUserId === auth.userId;
              const fields = (Object.keys(body) as Array<keyof typeof body>).filter(
                (k) => k !== "enabled" && k !== "unitId" && body[k] !== undefined,
              );
              const moving = body.unitId !== undefined && body.unitId !== row.unitId;
              let target: AgentUnit | null = unit;
              if (personal) {
                if (owner) {
                  await assertHidden(req, tx, "bot.configure", resource);
                } else {
                  await assertHidden(req, tx, "bot.manage", resource);
                  // Governance never touches what is inside: instructions, model, identity (403 personal_bot).
                  if (fields.length) await perms.assertCan(req, tx, "bot.configure", resource);
                }
                // A personal bot is its owner's alone (D-01): no unit, no other owner.
                if (body.unitId)
                  throw badRequest("A personal bot cannot belong to a unit", "personal_bot_unit");
                if (body.ownerUserId !== undefined && body.ownerUserId !== row.ownerUserId) {
                  throw badRequest("A personal bot always belongs to its creator", "personal_bot_owner");
                }
              } else {
                // A unit persona outside the caller's reach does not exist for them (`unit_agent`).
                if (unit) await assertHidden(req, tx, "bot.read", resource);
                if (fields.length || (body.enabled === undefined && !moving)) {
                  await perms.assertCan(req, tx, "bot.configure", resource);
                }
                if (body.enabled !== undefined) {
                  await perms.assertCan(req, tx, unit ? "bot.manage_unit" : "bot.manage", resource);
                }
                if (moving) {
                  target = body.unitId ? await requireTenantUnit(tx, body.unitId) : null;
                  await perms.assertCan(
                    req,
                    tx,
                    unit ? "bot.manage_unit" : "bot.manage",
                    unit ? unitResource(unit) : orgResource(),
                  );
                  await perms.assertCan(
                    req,
                    tx,
                    target ? "bot.manage_unit" : "bot.manage",
                    target ? unitResource(target) : orgResource(),
                  );
                }
                if (body.ownerUserId) await requireActiveOwner(tx, body.ownerUserId);
              }
              const governance = personal && !owner;
              const before = await agentAudience(tx, row);

              const provider = body.modelProvider ?? row.modelProvider;
              const modelId = body.modelId ?? row.modelId;
              const modelChanged = provider !== row.modelProvider || modelId !== row.modelId;
              if (modelChanged) {
                const allowed = personal
                  ? (await personalModels(core, tx)).some(
                      (m) => m.provider === provider && m.modelId === modelId,
                    )
                  : await isModelAllowed(core, tx, provider, modelId);
                if (!allowed) {
                  throw badRequest(
                    personal
                      ? "This model is not allowed for personal bots"
                      : "This model is not in the organization's allowed list",
                    "model_not_allowed",
                  );
                }
              }
              if (body.username && body.username !== row.username) {
                const [taken] = await tx
                  .select({ id: agents.id })
                  .from(agents)
                  .where(and(eq(agents.username, body.username), isNull(agents.deletedAt)));
                if (taken) throw conflict(`@${body.username} is already taken`, "username_taken");
              }
              if (
                body.enabled === true &&
                row.status === "disabled" &&
                owner &&
                row.statusMessage === GOVERNANCE_DISABLED_MESSAGE
              ) {
                throw forbidden(
                  "A workspace admin disabled this bot; ask them to enable it",
                  "disabled_by_admin",
                );
              }

              const next = {
                name: body.name ?? row.name,
                username: body.username ?? row.username,
                avatarUrl: body.avatarUrl === undefined ? row.avatarUrl : body.avatarUrl,
                description: body.description === undefined ? row.description : body.description || null,
                instructions: body.instructions ?? row.instructions,
                modelProvider: provider,
                modelId,
                unitId: personal ? row.unitId : (target?.id ?? null),
                ownerUserId: personal || body.ownerUserId === undefined ? row.ownerUserId : body.ownerUserId,
              };
              const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
                (k) => next[k] !== row[k],
              );
              const cellChanged = changed.some((k) => (CELL_FIELDS as readonly string[]).includes(k));

              let status = row.status;
              let reason: "agent.updated" | "agent.disabled" | "agent.enabled" | null = cellChanged
                ? "agent.updated"
                : null;
              if (body.enabled === false && row.status !== "disabled") {
                status = "disabled";
                reason = "agent.disabled";
              } else if (body.enabled === true && row.status === "disabled") {
                status = "provisioning";
                reason = "agent.enabled";
              } else if (cellChanged && row.status !== "disabled") {
                status = "provisioning";
              }
              if (!changed.length && status === row.status) {
                return withViewerCan(req, tx, toAgentDto(row, unit), unit?.path ?? []);
              }

              const statusMessage =
                status === row.status
                  ? row.statusMessage
                  : reason === "agent.disabled" && governance
                    ? GOVERNANCE_DISABLED_MESSAGE
                    : null;
              const [updated] = await tx
                .update(agents)
                .set({ ...next, status, statusMessage, updatedAt: new Date().toISOString() })
                .where(eq(agents.id, row.id))
                .returning();
              if (!updated) throw notFound(BOT_NOT_FOUND);
              const dto = toAgentDto(updated, target);
              // D-04: a disabled bot's chats are archived; re-enabling restores them (same transaction).
              if (reason === "agent.disabled" || reason === "agent.enabled") {
                await setAgentDmsArchived(
                  tx,
                  { audit: core.audit, realtime: core.realtime },
                  row.id,
                  reason === "agent.disabled",
                );
              }
              await core.audit.record(tx, {
                action:
                  reason === "agent.disabled"
                    ? "agent.disabled"
                    : reason === "agent.enabled"
                      ? "agent.enabled"
                      : "agent.updated",
                resourceType: "agent",
                resourceId: row.id,
                agentId: row.id,
                sessionId: auth.sessionId,
                metadata: {
                  changed,
                  ...(modelChanged ? { model: `${provider}/${modelId}` } : {}),
                  ...(personal
                    ? { scope: "personal", ownerUserId: row.ownerUserId }
                    : { unitId: updated.unitId, ownerUserId: updated.ownerUserId }),
                  ...(governance ? { governance: true } : {}),
                },
              });
              // Users who lost the persona (a move, an owner change) are told on their own topic.
              await publishAgent(core, tx, EventTypes.agentUpdated, dto, before);
              if (reason) await notifyCell(core, tx, reason, row.id);
              const out = await withViewerCan(req, tx, dto, target?.path ?? []);
              // Governance sees metadata only (D-01): never what is inside someone else's personal bot.
              return governance ? { ...out, instructions: "", description: null } : out;
            });
          } catch (err) {
            if (isUniqueViolation(err)) throw conflict("That username is already taken", "username_taken");
            throw err;
          }
        },
      );

      // Owner (`bot.configure`) or, as governance, an admin (`bot.manage`); team bots need `bot.manage`.
      app.delete(
        "/agents/:id",
        {
          config: user,
          preHandler: requireUser,
          schema: { tags: ["agent"], params: IdParams, response: { 200: Ok } },
        },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const row = await findAgent(tx, req.params.id);
            if (!row) throw notFound(BOT_NOT_FOUND);
            const unit = await loadAgentUnit(tx, row.unitId);
            const resource = botResource(row, auth.userId, unit?.path);
            const personal = row.scope === "personal";
            const owner = personal && row.ownerUserId === auth.userId;
            if (!personal && unit) {
              // A unit persona: its governance (admins, leads of a unit on its path); unknown to outsiders.
              await assertHidden(req, tx, "bot.read", resource);
              await perms.assertCan(req, tx, "bot.manage_unit", resource);
            } else if (!personal) await perms.assertCan(req, tx, "bot.manage", resource);
            else if (owner) await assertHidden(req, tx, "bot.configure", resource);
            else await assertHidden(req, tx, "bot.manage", resource);

            const now = new Date().toISOString();
            await tx
              .update(agents)
              .set({ status: "disabled", deletedAt: now, updatedAt: now })
              .where(eq(agents.id, row.id));
            // Its DMs are archived (history kept for their member); then it leaves every channel. Its past
            // messages stay attributed to it.
            await setAgentDmsArchived(tx, { audit: core.audit, realtime: core.realtime }, row.id, true);
            const channels = tx
              .select({ id: conversations.id })
              .from(conversations)
              .where(ne(conversations.kind, "dm"));
            await tx
              .delete(conversationMembers)
              .where(
                and(
                  eq(conversationMembers.memberKind, "agent"),
                  eq(conversationMembers.memberId, row.id),
                  inArray(conversationMembers.conversationId, channels),
                ),
              );
            await core.audit.record(tx, {
              action: "agent.deleted",
              resourceType: "agent",
              resourceId: row.id,
              agentId: row.id,
              sessionId: auth.sessionId,
              metadata: {
                username: row.username,
                ...(personal
                  ? { scope: "personal", ownerUserId: row.ownerUserId }
                  : { unitId: row.unitId, ownerUserId: row.ownerUserId }),
                ...(personal && !owner ? { governance: true } : {}),
              },
            });
            // Its pending requests (memory proposals) close as failed `bot_deleted`, cards updated live (WINDOWS 164).
            await deps.approvals.closeGone(tx, { requestedByAgentId: row.id });
            await publishAgentDeleted(core, tx, row);
            await notifyCell(core, tx, "agent.deleted", row.id);
            return { ok: true as const };
          }),
      );
    },
  };
}
