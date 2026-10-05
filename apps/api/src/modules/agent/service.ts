import {
  type Agent,
  AgentChannelEventTypes,
  type AllowedModel,
  type CellAgent,
  type CellConfigChangedEvent,
  type CellProvider,
  type CellSubscription,
  cellTopic,
  DEFAULT_MODEL,
  DEFAULT_SUBSCRIPTION_MODEL,
  EventTypes,
  isSubscriptionProvider,
  MOCK_MODEL,
  type ModelProvider,
  type ModelProviderKind,
  modelLabel,
} from "@ocw/contracts";
import { agents, modelProviders, type Tx, tenantOf } from "@ocw/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Core } from "../../core";
import {
  modelRef,
  OPENCLAW_PROVIDER_ID,
  PROVIDER_API,
  resolveBaseUrl,
  SUBSCRIPTION_RUNTIME_PROVIDER,
} from "./providers";

type AgentRow = typeof agents.$inferSelect;
type ProviderRow = typeof modelProviders.$inferSelect;

export function toAgentDto(r: AgentRow): Agent {
  return {
    id: r.id,
    organizationId: r.organizationId,
    name: r.name,
    username: r.username,
    avatarUrl: r.avatarUrl,
    description: r.description,
    instructions: r.instructions,
    modelProvider: r.modelProvider,
    modelId: r.modelId,
    runtime: r.runtime,
    status: r.status,
    statusMessage: r.statusMessage,
    createdBy: r.createdBy,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    scope: r.scope,
    ownerUserId: r.ownerUserId,
  };
}

export function toProviderDto(r: ProviderRow): ModelProvider {
  const subscription = isSubscriptionProvider(r.provider);
  return {
    id: r.id,
    provider: r.provider,
    authMode: subscription ? "subscription" : "api_key",
    baseUrl: r.baseUrl,
    allowedModels: r.allowedModels,
    enabled: r.enabled,
    hasKey: r.secretId !== null,
    keyHint: r.secretId ? r.keyHint : null,
    account:
      subscription && r.account
        ? {
            email: r.account.email ?? null,
            planType: r.account.planType ?? null,
            connectedAt: new Date(r.account.connectedAt).toISOString(),
            needsReconnect: !!r.account.needsReconnect,
          }
        : null,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

/** Live (not deleted) agents of the tx's organization, by name. */
export async function listAgents(tx: Tx): Promise<Agent[]> {
  const rows = await tx.select().from(agents).where(isNull(agents.deletedAt)).orderBy(asc(agents.name));
  return rows.map(toAgentDto);
}

export async function findAgent(tx: Tx, id: string): Promise<AgentRow | null> {
  const [row] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), isNull(agents.deletedAt)));
  return row ?? null;
}

/**
 * Public helper for other modules (chat author resolution, mention autocomplete): id → display info,
 * including soft-deleted agents so old messages keep their author name.
 */
export async function agentDirectory(
  tx: Tx,
  ids?: string[],
): Promise<Map<string, { id: string; name: string; username: string; avatarUrl: string | null }>> {
  if (ids && ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: agents.id, name: agents.name, username: agents.username, avatarUrl: agents.avatarUrl })
    .from(agents)
    .where(ids ? inArray(agents.id, ids) : undefined);
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Providers usable right now: enabled and with a key, or (subscriptions) signed in through the cell. A
 * subscription whose cell lost its credentials stays usable here (bots keep their model) and the cell
 * reports those bots as `error` until an admin reconnects.
 */
function usable(p: ProviderRow) {
  if (!p.enabled) return false;
  if (isSubscriptionProvider(p.provider)) return p.account !== null;
  return p.secretId !== null && (p.provider !== "openai-compatible" || !!p.baseUrl);
}

/** Models a bot may use: enabled providers with a key, plus the mock model when the operator enabled it. */
export async function allowedModels(core: Core, tx: Tx): Promise<AllowedModel[]> {
  const rows = await tx.select().from(modelProviders).orderBy(asc(modelProviders.createdAt));
  const out: AllowedModel[] = [];
  for (const p of rows.filter(usable)) {
    for (const modelId of p.allowedModels) {
      out.push({
        provider: p.provider,
        modelId,
        label: modelLabel(p.provider, modelId),
        isDefault:
          (p.provider === DEFAULT_MODEL.provider && modelId === DEFAULT_MODEL.modelId) ||
          (p.provider === DEFAULT_SUBSCRIPTION_MODEL.provider &&
            modelId === DEFAULT_SUBSCRIPTION_MODEL.modelId),
      });
    }
  }
  if (core.env.OCW_MODEL_PROVIDER === "mock") {
    out.push({ provider: "mock", modelId: MOCK_MODEL.modelId, label: MOCK_MODEL.label, isDefault: false });
  }
  // Exactly one default: the org's Anthropic default wins over the subscription one, else the first.
  const defaults = out.filter((m) => m.isDefault);
  for (const extra of defaults.slice(1)) extra.isDefault = false;
  const first = out[0];
  if (first && defaults.length === 0) first.isDefault = true;
  return out;
}

export async function isModelAllowed(core: Core, tx: Tx, provider: ModelProviderKind, modelId: string) {
  return (await allowedModels(core, tx)).some((m) => m.provider === provider && m.modelId === modelId);
}

/** Durable hint on the cell stream: the plugin refetches `GET /agent-channel/v1/cell` and reconciles. */
export async function notifyCell(
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

/**
 * Broadcast an agent change: team bots to every browser of the org (status chips, autocomplete); a personal
 * bot only to its owner's `user:` topic, so nobody else learns it exists (D-01, Pitfall 4).
 */
export async function publishAgent(
  core: Core,
  tx: Tx,
  type: typeof EventTypes.agentCreated | typeof EventTypes.agentUpdated,
  agent: Agent,
) {
  const topic =
    agent.scope === "personal" && agent.ownerUserId
      ? `user:${agent.ownerUserId}`
      : `org:${agent.organizationId}`;
  await core.realtime.appendEvent(tx, topic, type, agent);
}

/** Bots as the cell must provision them (deleted ones are omitted; disabled ones are listed as such). */
export async function cellAgents(tx: Tx): Promise<CellAgent[]> {
  const rows = await tx.select().from(agents).where(isNull(agents.deletedAt)).orderBy(asc(agents.createdAt));
  return rows.map((r) => ({
    id: r.id,
    handle: r.username,
    displayName: r.name,
    avatarUrl: r.avatarUrl,
    description: r.description,
    instructions: r.instructions,
    status: r.status,
    modelRef: modelRef(r.modelProvider, r.modelId),
    model: { provider: r.modelProvider, providerId: OPENCLAW_PROVIDER_ID[r.modelProvider], id: r.modelId },
    updatedAt: new Date(r.updatedAt).toISOString(),
    // Filled per agent by the agent-channel `/cell` route from bot-capabilities (D-08 layer 2).
    capabilities: { tools: [] },
  }));
}

/**
 * Provider credentials for the cell, keys decrypted ON DEMAND inside the tenant tx. The result must only be
 * sent over the authenticated Agent Channel API and must never be logged.
 */
export async function cellProviders(core: Core, tx: Tx): Promise<CellProvider[]> {
  const rows = await tx.select().from(modelProviders).orderBy(asc(modelProviders.createdAt));
  const out: CellProvider[] = [];
  for (const p of rows.filter(usable)) {
    // Subscriptions have no key to deliver: see cellSubscriptions().
    if (isSubscriptionProvider(p.provider)) continue;
    const baseUrl = resolveBaseUrl(p.provider, p.baseUrl, core.env.OCW_MOCK_MODEL_BASE_URL);
    if (!baseUrl || !p.secretId) continue;
    out.push({
      id: OPENCLAW_PROVIDER_ID[p.provider],
      kind: p.provider,
      api: PROVIDER_API[p.provider],
      baseUrl,
      apiKey: await core.secrets.reveal(tx, p.secretId),
      models: p.allowedModels,
    });
  }
  if (core.env.OCW_MODEL_PROVIDER === "mock") {
    out.push({
      id: OPENCLAW_PROVIDER_ID.mock,
      kind: "mock",
      api: PROVIDER_API.mock,
      baseUrl: core.env.OCW_MOCK_MODEL_BASE_URL,
      apiKey: "mock-key-not-secret",
      models: [MOCK_MODEL.modelId],
    });
  }
  return out;
}

/** Connected subscription providers for the cell. No secret: the cell holds the credentials itself. */
export async function cellSubscriptions(tx: Tx): Promise<CellSubscription[]> {
  const rows = await tx.select().from(modelProviders).orderBy(asc(modelProviders.createdAt));
  const out: CellSubscription[] = [];
  for (const p of rows.filter(usable)) {
    if (!isSubscriptionProvider(p.provider)) continue;
    out.push({
      id: p.provider,
      kind: p.provider,
      runtimeProvider: SUBSCRIPTION_RUNTIME_PROVIDER[p.provider],
      models: p.allowedModels,
      account: { email: p.account?.email ?? null },
    });
  }
  return out;
}

/**
 * The cell reports that it provisioned (ready) or failed to provision (error) a bot. Disabled bots stay
 * disabled. Returns the updated agent, or null when the bot does not exist in this org.
 */
export async function applyCellStatus(
  core: Core,
  tx: Tx,
  agentId: string,
  status: "ready" | "error",
  detail: string | null,
): Promise<Agent | null> {
  const row = await findAgent(tx, agentId);
  if (!row) return null;
  if (row.status === "disabled") return toAgentDto(row);
  const message = status === "error" ? detail?.trim() || "The bot runtime reported an error" : null;
  if (row.status === status && row.statusMessage === message) return toAgentDto(row);
  const [updated] = await tx
    .update(agents)
    .set({ status, statusMessage: message, updatedAt: new Date().toISOString() })
    .where(eq(agents.id, agentId))
    .returning();
  if (!updated) return null;
  const dto = toAgentDto(updated);
  await core.audit.record(tx, {
    action: "agent.status_changed",
    resourceType: "agent",
    resourceId: agentId,
    actorKind: "system",
    agentId,
    clientKind: "agent",
    metadata: { source: "openclaw_cell", from: row.status, to: status, detail: message },
  });
  await publishAgent(core, tx, EventTypes.agentUpdated, dto);
  return dto;
}
