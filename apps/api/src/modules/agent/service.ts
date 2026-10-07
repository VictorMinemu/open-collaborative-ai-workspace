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
import { agents, modelProviders, orgUnits, type Tx, tenantOf } from "@ocw/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { MissingSecretError } from "../../lib/secret-store";
import { type AgentFacts, agentResource, createPermissionService } from "../organization";
import {
  modelRef,
  OPENCLAW_PROVIDER_ID,
  PROVIDER_API,
  resolveBaseUrl,
  SUBSCRIPTION_RUNTIME_PROVIDER,
} from "./providers";

type AgentRow = typeof agents.$inferSelect;
type ProviderRow = typeof modelProviders.$inferSelect;

/** The unit a shared persona belongs to (AGENT-01), with its path (root → self) for the resolver. */
export interface AgentUnit {
  id: string;
  name: string;
  kind: "department" | "team" | "project";
  path: string[];
}

/** The persona's unit (RLS scopes the read to the tenant); null for organization personas and personal bots. */
export async function loadAgentUnit(tx: Tx, unitId: string | null): Promise<AgentUnit | null> {
  if (!unitId) return null;
  const [u] = await tx
    .select({ id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind, path: orgUnits.path })
    .from(orgUnits)
    .where(eq(orgUnits.id, unitId))
    .limit(1);
  return u ?? null;
}

/** What the resolver needs about one bot (D-01, AGENT-01). */
export function agentFacts(
  a: { scope: Agent["scope"]; ownerUserId: string | null; status: string },
  unitPath: readonly string[] = [],
): AgentFacts {
  return { scope: a.scope, ownerUserId: a.ownerUserId, disabled: a.status === "disabled", unitPath };
}

export function toAgentDto(r: AgentRow, unit: AgentUnit | null = null): Agent {
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
    unitId: r.unitId,
    unit: unit && unit.id === r.unitId ? { id: unit.id, name: unit.name, kind: unit.kind } : null,
  };
}

/** The DTO of one row, its unit loaded. */
export async function agentDto(tx: Tx, r: AgentRow): Promise<Agent> {
  return toAgentDto(r, await loadAgentUnit(tx, r.unitId));
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
    hasKey: r.secretRef !== null,
    keyHint: r.secretRef ? r.keyHint : null,
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

/** Live (not deleted) agents of the tx's organization, by name, each with its unit path ([] = organization). */
export async function listAgentsWithUnits(tx: Tx): Promise<Array<{ agent: Agent; unitPath: string[] }>> {
  const rows = await tx
    .select({
      a: agents,
      u: { id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind, path: orgUnits.path },
    })
    .from(agents)
    .leftJoin(orgUnits, eq(orgUnits.id, agents.unitId))
    .where(isNull(agents.deletedAt))
    .orderBy(asc(agents.name));
  return rows.map(({ a, u }) => ({ agent: toAgentDto(a, u), unitPath: u?.path ?? [] }));
}

/** Live (not deleted) agents of the tx's organization, by name. */
export async function listAgents(tx: Tx): Promise<Agent[]> {
  return (await listAgentsWithUnits(tx)).map((r) => r.agent);
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
export function usable(p: ProviderRow) {
  if (!p.enabled) return false;
  if (isSubscriptionProvider(p.provider)) return p.account !== null;
  return p.secretRef !== null && (p.provider !== "openai-compatible" || !!p.baseUrl);
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

/** Who may see one bot: its scope, owner and unit path (AGENT-01). */
export interface AgentAudience {
  scope: Agent["scope"];
  ownerUserId: string | null;
  unitPath: readonly string[];
}

type Readers = { kind: "org" } | { kind: "users"; userIds: Set<string> };

/**
 * The users who may read a bot right now: everyone (the org topic) for an organization persona, the owner for a
 * personal bot, and for a unit persona the active members the resolver allows `bot.read` (candidates: admins, the
 * owner, members of the unit's subtree and leads of a unit on its path).
 */
async function readersOf(core: Core, tx: Tx, a: AgentAudience): Promise<Readers> {
  if (a.scope === "personal")
    return { kind: "users", userIds: new Set(a.ownerUserId ? [a.ownerUserId] : []) };
  const unitId = a.unitPath[a.unitPath.length - 1];
  if (!unitId) return { kind: "org" };
  const unitArr = sql`${`{${unitId}}`}::uuid[]`;
  const pathArr = sql`${`{${a.unitPath.join(",")}}`}::uuid[]`;
  const res = await tx.execute(sql`
    select m.user_id as id from app.org_members m
     where m.deactivated_at is null
       and (m.role = 'admin'
            or m.user_id = ${a.ownerUserId}::uuid
            or exists (select 1 from app.unit_memberships um join app.org_units u on u.id = um.unit_id
                        where um.user_id = m.user_id
                          and (u.path @> ${unitArr} or (um.role = 'lead' and um.unit_id = any(${pathArr})))))`);
  const perms = createPermissionService(core);
  const facts = { scope: a.scope, ownerUserId: a.ownerUserId, disabled: false, unitPath: a.unitPath };
  const userIds = new Set<string>();
  for (const row of res.rows as Array<{ id: string }>) {
    const d = await perms.decide(
      tx,
      { kind: "user", userId: row.id },
      "bot.read",
      agentResource(facts, row.id),
    );
    if (d.allowed) userIds.add(row.id);
  }
  return { kind: "users", userIds };
}

async function activeMemberIds(tx: Tx): Promise<string[]> {
  const res = await tx.execute(sql`select user_id as id from app.org_members where deactivated_at is null`);
  return (res.rows as Array<{ id: string }>).map((r) => r.id);
}

const audienceOf = (a: Pick<Agent, "scope" | "ownerUserId">, unit: AgentUnit | null): AgentAudience => ({
  scope: a.scope,
  ownerUserId: a.ownerUserId,
  unitPath: unit?.path ?? [],
});

/** The audience of a stored row (its unit path loaded), e.g. before a PATCH changes it. */
export async function agentAudience(
  tx: Tx,
  a: Pick<Agent, "scope" | "ownerUserId"> & { unitId?: string | null },
): Promise<AgentAudience> {
  return audienceOf(a, await loadAgentUnit(tx, a.unitId ?? null));
}

/**
 * Broadcast an agent change to exactly who may see it: an organization bot to every browser of the org (status
 * chips, autocomplete); a personal bot only to its owner's `user:` topic (D-01, Pitfall 4); a unit persona to the
 * `user:` topic of each of its readers (AGENT-01, T-06-07-02). With `previous` (a move or an owner change), the
 * users who lost it get `agent.deleted` on their own topic.
 */
export async function publishAgent(
  core: Core,
  tx: Tx,
  type: typeof EventTypes.agentCreated | typeof EventTypes.agentUpdated,
  agent: Agent,
  previous?: AgentAudience,
) {
  const now = await readersOf(core, tx, await agentAudience(tx, agent));
  await sendTo(core, tx, agent, now, type, agent);
  if (!previous || now.kind === "org") return;
  const before = await readersOf(core, tx, previous);
  const lost = (before.kind === "org" ? await activeMemberIds(tx) : [...before.userIds]).filter(
    (id) => !now.userIds.has(id),
  );
  if (lost.length) {
    await sendTo(core, tx, agent, { kind: "users", userIds: new Set(lost) }, EventTypes.agentDeleted, {
      id: agent.id,
    });
  }
}

async function sendTo(
  core: Core,
  tx: Tx,
  agent: Pick<Agent, "organizationId">,
  readers: Readers,
  type: string,
  payload: unknown,
) {
  if (readers.kind === "org") {
    await core.realtime.appendEvent(tx, `org:${agent.organizationId}`, type, payload);
    return;
  }
  for (const userId of [...readers.userIds].sort()) {
    await core.realtime.appendEvent(tx, `user:${userId}`, type, payload);
  }
}

/** Same routing as `publishAgent` for a deletion (payload `{ id }`). */
export async function publishAgentDeleted(
  core: Core,
  tx: Tx,
  agent: Pick<Agent, "id" | "organizationId" | "scope" | "ownerUserId"> & { unitId?: string | null },
) {
  const readers = await readersOf(core, tx, await agentAudience(tx, agent));
  await sendTo(core, tx, agent, readers, EventTypes.agentDeleted, { id: agent.id });
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
    if (!baseUrl || !p.secretRef) continue;
    let apiKey: string;
    try {
      // Only through the reference (D-07, P-10): `secret_id` is never read for resolution.
      apiKey = await core.secrets.resolve(tx, p.secretRef);
    } catch (err) {
      if (!(err instanceof MissingSecretError)) throw err;
      // A dangling reference (operator env unset, foreign org) leaves the provider out; never the reason's value.
      core.log.warn({ provider: p.provider, ref: p.secretRef.provider }, "provider key reference unresolved");
      continue;
    }
    out.push({
      id: OPENCLAW_PROVIDER_ID[p.provider],
      kind: p.provider,
      api: PROVIDER_API[p.provider],
      baseUrl,
      apiKey,
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
  if (row.status === "disabled") return agentDto(tx, row);
  const message = status === "error" ? detail?.trim() || "The bot runtime reported an error" : null;
  if (row.status === status && row.statusMessage === message) return agentDto(tx, row);
  const [updated] = await tx
    .update(agents)
    .set({ status, statusMessage: message, updatedAt: new Date().toISOString() })
    .where(eq(agents.id, agentId))
    .returning();
  if (!updated) return null;
  const dto = await agentDto(tx, updated);
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
