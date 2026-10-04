import {
  Agent,
  AgentList,
  AllowedModelList,
  CreateAgentRequest,
  catalogEntry,
  EventTypes,
  IdParams,
  isSubscriptionProvider,
  ModelProvider,
  ModelProviderList,
  Ok,
  ProviderParams,
  UpdateAgentRequest,
  UpsertModelProviderRequest,
} from "@ocw/contracts";
import { agents, conversationMembers, modelProviders } from "@ocw/db";
import { and, asc, eq, isNull, like, or } from "drizzle-orm";
import { type ApiModule, authOf, type Core, tenant } from "../../core";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { createPermissionService } from "../organization";
import { keyHint, nextFreeUsername, slugifyUsername } from "./providers";
import {
  allowedModels,
  findAgent,
  isModelAllowed,
  listAgents,
  notifyCell,
  publishAgent,
  toAgentDto,
  toProviderDto,
} from "./service";
import { revokeSubscriptionInCell } from "./subscription";

export {
  agentDirectory,
  allowedModels,
  applyCellStatus,
  cellAgents,
  cellProviders,
  cellSubscriptions,
  findAgent,
  listAgents,
  toAgentDto,
} from "./service";
export {
  applySubscriptionConnected,
  markSubscriptionNeedsReconnect,
  subscriptionAccount,
} from "./subscription";

/** Fields the OpenClaw cell provisions from; changing one re-provisions the bot. */
const CELL_FIELDS = ["name", "username", "instructions", "modelProvider", "modelId", "description"] as const;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * agent module: bots (first-class agent principals), model providers (admin; API keys encrypted through
 * core.secrets, never returned) and the allowed-model list. Provisioning in the OpenClaw cell is driven by
 * `cell.config.changed` events on `cell:<orgId>`; the cell acks through the Agent Channel API.
 */
export function createAgentModule(core: Core): ApiModule {
  const perms = createPermissionService(core);
  const requireUser = core.identity.requireUser;
  // Every route is a signed-in user's, decided by the resolver on an organization-scope permission.
  const user = { authz: "user" as const };
  const allow = {
    "provider.manage": {
      config: user,
      preHandler: [requireUser, perms.requirePermission("provider.manage")],
    },
    "bot.manage": { config: user, preHandler: [requireUser, perms.requirePermission("bot.manage")] },
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

            let secretId = existing?.secretId ?? null;
            let hint = existing?.keyHint ?? null;
            const oldSecretId = body.apiKey ? secretId : null;
            if (body.apiKey) {
              secretId = await core.secrets.put(tx, {
                name: `${body.provider} API key`,
                kind: "provider_api_key",
                provider: body.provider,
                value: body.apiKey,
              });
              hint = keyHint(body.apiKey);
            }
            const now = new Date().toISOString();
            const values = {
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
            if (oldSecretId && oldSecretId !== secretId) await core.secrets.remove(tx, oldSecretId);

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
            if (row.secretId) await core.secrets.remove(tx, row.secretId);
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
      app.get(
        "/agents",
        { ...allow["bot.read"], schema: { tags: ["agent"], response: { 200: AgentList } } },
        async (req) => ({ agents: await core.db.withTenant(tenant(req), listAgents) }),
      );

      app.get(
        "/agents/:id",
        { ...allow["bot.read"], schema: { tags: ["agent"], params: IdParams, response: { 200: Agent } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const row = await findAgent(tx, req.params.id);
            if (!row) throw notFound("Bot not found");
            return toAgentDto(row);
          }),
      );

      app.post(
        "/agents",
        {
          ...allow["bot.manage"],
          schema: { tags: ["agent"], body: CreateAgentRequest, response: { 200: Agent } },
        },
        async (req) => {
          try {
            return await core.db.withTenant(tenant(req), async (tx) => {
              const auth = authOf(req);
              const body = req.body;
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
                })
                .returning();
              if (!row) throw new Error("agent insert failed");
              const dto = toAgentDto(row);
              await core.audit.record(tx, {
                action: "agent.created",
                resourceType: "agent",
                resourceId: row.id,
                agentId: row.id,
                sessionId: auth.sessionId,
                metadata: { username, model: `${body.modelProvider}/${body.modelId}`, runtime: "openclaw" },
              });
              await publishAgent(core, tx, EventTypes.agentCreated, dto);
              await notifyCell(core, tx, "agent.created", row.id);
              return dto;
            });
          } catch (err) {
            if (isUniqueViolation(err)) throw conflict("That username is already taken", "username_taken");
            throw err;
          }
        },
      );

      app.patch(
        "/agents/:id",
        {
          ...allow["bot.manage"],
          schema: { tags: ["agent"], params: IdParams, body: UpdateAgentRequest, response: { 200: Agent } },
        },
        async (req) => {
          try {
            return await core.db.withTenant(tenant(req), async (tx) => {
              const auth = authOf(req);
              const body = req.body;
              const row = await findAgent(tx, req.params.id);
              if (!row) throw notFound("Bot not found");

              const provider = body.modelProvider ?? row.modelProvider;
              const modelId = body.modelId ?? row.modelId;
              const modelChanged = provider !== row.modelProvider || modelId !== row.modelId;
              if (modelChanged && !(await isModelAllowed(core, tx, provider, modelId))) {
                throw badRequest("This model is not in the organization's allowed list", "model_not_allowed");
              }
              if (body.username && body.username !== row.username) {
                const [taken] = await tx
                  .select({ id: agents.id })
                  .from(agents)
                  .where(and(eq(agents.username, body.username), isNull(agents.deletedAt)));
                if (taken) throw conflict(`@${body.username} is already taken`, "username_taken");
              }

              const next = {
                name: body.name ?? row.name,
                username: body.username ?? row.username,
                avatarUrl: body.avatarUrl === undefined ? row.avatarUrl : body.avatarUrl,
                description: body.description === undefined ? row.description : body.description || null,
                instructions: body.instructions ?? row.instructions,
                modelProvider: provider,
                modelId,
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
              if (!changed.length && status === row.status) return toAgentDto(row);

              const [updated] = await tx
                .update(agents)
                .set({
                  ...next,
                  status,
                  statusMessage: status === row.status ? row.statusMessage : null,
                  updatedAt: new Date().toISOString(),
                })
                .where(eq(agents.id, row.id))
                .returning();
              if (!updated) throw notFound("Bot not found");
              const dto = toAgentDto(updated);
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
                metadata: { changed, ...(modelChanged ? { model: `${provider}/${modelId}` } : {}) },
              });
              await publishAgent(core, tx, EventTypes.agentUpdated, dto);
              if (reason) await notifyCell(core, tx, reason, row.id);
              return dto;
            });
          } catch (err) {
            if (isUniqueViolation(err)) throw conflict("That username is already taken", "username_taken");
            throw err;
          }
        },
      );

      app.delete(
        "/agents/:id",
        { ...allow["bot.manage"], schema: { tags: ["agent"], params: IdParams, response: { 200: Ok } } },
        async (req) =>
          core.db.withTenant(tenant(req), async (tx) => {
            const auth = authOf(req);
            const row = await findAgent(tx, req.params.id);
            if (!row) throw notFound("Bot not found");
            const now = new Date().toISOString();
            await tx
              .update(agents)
              .set({ status: "disabled", deletedAt: now, updatedAt: now })
              .where(eq(agents.id, row.id));
            // The bot leaves every conversation; its past messages stay attributed to it.
            await tx
              .delete(conversationMembers)
              .where(
                and(eq(conversationMembers.memberKind, "agent"), eq(conversationMembers.memberId, row.id)),
              );
            await core.audit.record(tx, {
              action: "agent.deleted",
              resourceType: "agent",
              resourceId: row.id,
              agentId: row.id,
              sessionId: auth.sessionId,
              metadata: { username: row.username },
            });
            await core.realtime.appendEvent(tx, `org:${auth.organizationId}`, EventTypes.agentDeleted, {
              id: row.id,
            });
            await notifyCell(core, tx, "agent.deleted", row.id);
            return { ok: true as const };
          }),
      );
    },
  };
}
