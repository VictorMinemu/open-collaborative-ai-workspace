import {
  type AllowedModel,
  type CreatePersonalBotRequest,
  type CreatePersonalBotResponse,
  EventTypes,
} from "@ocw/contracts";
import { agents, botPolicies, orgMembers, type Tx, tenantOf } from "@ocw/db";
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf, type Core } from "../../core";
import { badRequest, conflict } from "../../lib/errors";
import { ensureDm } from "../chat";
import { createPermissionService } from "../organization";
import { nextFreeUsername, slugifyUsername } from "./providers";
import { allowedModels, notifyCell, publishAgent, toAgentDto } from "./service";

/** D-01: personal bots per member when the organization has no `bot_policies` row. */
export const DEFAULT_MAX_PERSONAL_BOTS = 3;

type PolicyRow = typeof botPolicies.$inferSelect;

/**
 * Models a personal bot may use: the organization's allowed models narrowed by
 * `bot_policies.personal_allowed_models` (empty or no policy row = every allowed model).
 */
export async function personalModels(core: Core, tx: Tx, policy?: PolicyRow | null): Promise<AllowedModel[]> {
  const row = policy === undefined ? ((await tx.select().from(botPolicies).limit(1))[0] ?? null) : policy;
  const personalAllowed = row?.personalAllowedModels ?? [];
  return (await allowedModels(core, tx)).filter(
    (m) => personalAllowed.length === 0 || personalAllowed.includes(`${m.provider}/${m.modelId}`),
  );
}

/**
 * What internal callers (07.4-08 templates) may add to a one-click create, written in the same insert under the same
 * advisory lock and cap. The public `/agents/personal` route keeps its contract: its body schema never carries these.
 */
export interface PersonalBotInput extends CreatePersonalBotRequest {
  /** Stored capability toggles (partial; defaults are filled in by the capability model). */
  capabilities?: Record<string, unknown>;
  /** The template and version this bot is forked from (D-05). */
  templateId?: string;
  templateVersion?: number;
}

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/u)[0] || "My";
}

/**
 * One-click personal bot (BOT-01/02): a bot owned by the caller (`scope = 'personal'`) and its private DM,
 * in the caller's transaction. Decided by the resolver (`bot.create_personal`, deniable by rules), capped by
 * `bot_policies.max_personal_bots_per_user`, audited, and announced only to the owner (never `org:`).
 */
export async function createPersonalBot(
  core: Core,
  req: FastifyRequest,
  tx: Tx,
  body: PersonalBotInput,
): Promise<CreatePersonalBotResponse> {
  const perms = createPermissionService(core);
  await perms.assertCan(req, tx, "bot.create_personal");
  const auth = authOf(req);
  const { organizationId } = tenantOf(tx);

  // Serialise concurrent creates of the same member so the cap cannot be raced.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ocw:personal-bots:${auth.userId}`}))`);

  const [policy = null] = await tx.select().from(botPolicies).limit(1);
  const max = policy?.maxPersonalBotsPerUser ?? DEFAULT_MAX_PERSONAL_BOTS;
  const [{ n } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.scope, "personal"), eq(agents.ownerUserId, auth.userId), isNull(agents.deletedAt)));
  if (n >= max) {
    throw conflict(
      max === 1
        ? "You already have a personal bot (the limit is 1)"
        : `You already have ${n} personal bots (the limit is ${max})`,
      "personal_bot_limit",
    );
  }

  // Model: the requested one when the organization allows it for personal bots, else the default.
  const models = await personalModels(core, tx, policy);
  let model = models.find((m) => m.isDefault) ?? models[0];
  if (body.modelProvider || body.modelId) {
    const wanted = models.find((m) => m.provider === body.modelProvider && m.modelId === body.modelId);
    if (!wanted) {
      throw badRequest("This model is not allowed for personal bots", "model_not_allowed");
    }
    model = wanted;
  }
  if (!model) {
    throw conflict(
      "No model is available yet: an admin needs to connect a model provider first",
      "no_models",
    );
  }

  const [owner] = await tx
    .select({ displayName: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, auth.userId));
  const ownerName = owner?.displayName ?? "you";
  const name = body.name ?? `${firstName(ownerName)}'s assistant`;
  const base = slugifyUsername(name);
  const taken = await tx
    .select({ username: agents.username })
    .from(agents)
    .where(and(isNull(agents.deletedAt), or(eq(agents.username, base), like(agents.username, `${base}-%`))));
  const username = nextFreeUsername(base, new Set(taken.map((r) => r.username)));
  const instructions =
    body.instructions ?? `You are ${name}, the personal assistant of ${ownerName}. Be concise and helpful.`;

  const [row] = await tx
    .insert(agents)
    .values({
      organizationId,
      name,
      username,
      avatarUrl: body.avatarUrl ?? null,
      description: null,
      instructions,
      modelProvider: model.provider,
      modelId: model.modelId,
      status: "provisioning",
      createdBy: auth.userId,
      scope: "personal",
      ownerUserId: auth.userId,
      capabilities: body.capabilities ?? {},
      templateId: body.templateId ?? null,
      templateVersion: body.templateVersion ?? null,
    })
    .returning();
  if (!row) throw new Error("personal bot insert failed");

  const { conv } = await ensureDm(
    tx,
    { audit: core.audit, realtime: core.realtime },
    {
      agentId: row.id,
      userId: auth.userId,
    },
  );

  const agent = toAgentDto(row);
  await core.audit.record(tx, {
    action: "agent.created",
    resourceType: "agent",
    resourceId: row.id,
    agentId: row.id,
    sessionId: auth.sessionId,
    metadata: {
      scope: "personal",
      ownerUserId: auth.userId,
      username,
      model: `${model.provider}/${model.modelId}`,
      runtime: "openclaw",
    },
  });
  await publishAgent(core, tx, EventTypes.agentCreated, agent);
  await notifyCell(core, tx, "agent.created", row.id);
  return { agent, dmId: conv.id };
}
