import type { AutomationTarget, Permission } from "@ocw/contracts";
import { agents, boardColumns, conversations, messages, orgUnits, type Tx } from "@ocw/db";
import { and, asc, eq, isNull, ne, or } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { channelFacts } from "../chat";
import {
  type AgentFacts,
  agentResource,
  channelResource,
  orgResource,
  type PermissionService,
  type ResourceFacts,
} from "../organization";

/**
 * Who may do what with automations (D-07, P-04, P-08). Every decision is the resolver's: the grains are
 * `automation.create` (own automations), `automation.webhook` (webhook triggers) and `automation.manage` (everyone's,
 * `scope=all`: list, pause, delete; never edit, resume or run as someone else). Targets are decided for the creator and
 * the bot together (agent membership and post rights, agent ∩ creator read, the creator's own post rights, the
 * personal-bot rule, the creator's `bot.read` on the bot), here at create and update and again by the runner (09) at
 * every fire.
 */

/** The person acting. `req` is set on REST requests, so the decision is recorded on the request (strict authz). */
export interface AutomationActor {
  userId: string;
  req?: FastifyRequest;
}

type AgentRow = typeof agents.$inferSelect;
type ConversationRow = typeof conversations.$inferSelect;

/** One organization-scope (or given resource) decision for the actor. */
export async function allows(
  perms: PermissionService,
  tx: Tx,
  actor: AutomationActor,
  permission: Permission,
  resource: ResourceFacts = orgResource(),
): Promise<boolean> {
  if (actor.req) return perms.can(actor.req, tx, permission, resource);
  return (await perms.decide(tx, { kind: "user", userId: actor.userId }, permission, resource)).allowed;
}

export const canCreate = (perms: PermissionService, tx: Tx, actor: AutomationActor) =>
  allows(perms, tx, actor, "automation.create");
export const canManage = (perms: PermissionService, tx: Tx, actor: AutomationActor) =>
  allows(perms, tx, actor, "automation.manage");
export const canWebhook = (perms: PermissionService, tx: Tx, actor: AutomationActor) =>
  allows(perms, tx, actor, "automation.webhook");

export interface UsableBot {
  id: string;
  displayName: string;
  personal: boolean;
  unitName: string | null;
  /** The bot's cell is configured and running. */
  ready: boolean;
  row: AgentRow;
}

/** A bot (live or not) with the path of its unit, for the resolver. */
async function botWithUnit(tx: Tx, agentId: string) {
  const [r] = await tx
    .select({ agent: agents, unitName: orgUnits.name, unitPath: orgUnits.path })
    .from(agents)
    .leftJoin(orgUnits, eq(orgUnits.id, agents.unitId))
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  return r ?? null;
}

const agentFactsOf = (row: AgentRow, unitPath: readonly string[] | null): AgentFacts => ({
  scope: row.scope,
  ownerUserId: row.ownerUserId,
  disabled: row.status === "disabled",
  unitPath: unitPath ?? [],
});

/**
 * The bots `userId` may build automations with: their own personal bots and the team bots they may see (`bot.read`),
 * never a disabled one. `ready` says whether a run would reach the bot's cell now.
 */
export async function usableBots(tx: Tx, perms: PermissionService, userId: string): Promise<UsableBot[]> {
  const rows = await tx
    .select({ agent: agents, unitName: orgUnits.name, unitPath: orgUnits.path })
    .from(agents)
    .leftJoin(orgUnits, eq(orgUnits.id, agents.unitId))
    .where(
      and(
        isNull(agents.deletedAt),
        ne(agents.status, "disabled"),
        or(eq(agents.scope, "team"), eq(agents.ownerUserId, userId)),
      ),
    )
    .orderBy(asc(agents.name), asc(agents.id));
  const allowed = await perms.filterFor(tx, { kind: "user", userId }, rows, "bot.read", (r) =>
    agentResource(agentFactsOf(r.agent, r.unitPath), userId),
  );
  return allowed.map((r) => ({
    id: r.agent.id,
    displayName: r.agent.name,
    personal: r.agent.scope === "personal",
    unitName: r.unitName ?? null,
    ready: r.agent.status === "ready",
    row: r.agent,
  }));
}

export type TargetCode =
  | "agent_not_member"
  | "target_not_postable"
  | "personal_bot_target"
  | "bot_not_readable"
  | "agent_unavailable";

export type TargetDecision = { ok: true; conversationId: string | null } | { ok: false; code: TargetCode };

/**
 * Whether the bot may deliver to `conv` for `userId` (both sides, in this order so nothing about a conversation the
 * creator cannot read leaks): the creator reads it, the bot is a member and may post, the creator may post, and the bot
 * acting for the creator may read it (agent ∩ human). `null` = allowed.
 */
export async function decideConversation(
  tx: Tx,
  perms: PermissionService,
  a: { agentId: string; userId: string; conv: ConversationRow },
): Promise<"agent_not_member" | "target_not_postable" | null> {
  const { agentId, userId, conv } = a;
  if (conv.kind !== "channel" || conv.archivedAt !== null) return "target_not_postable";
  const humanRes = channelResource(await channelFacts(tx, conv, { kind: "user", id: userId }));
  const human = { kind: "user", userId } as const;
  if (!(await perms.decide(tx, human, "channel.read", humanRes)).allowed) return "target_not_postable";
  const agentFacts = await channelFacts(tx, conv, { kind: "agent", id: agentId });
  if (agentFacts.viewerRole === null) return "agent_not_member";
  const agentRes = channelResource(agentFacts);
  if (!(await perms.decide(tx, { kind: "agent", agentId }, "channel.post", agentRes)).allowed) {
    return "target_not_postable";
  }
  if (!(await perms.decide(tx, human, "channel.post", humanRes)).allowed) return "target_not_postable";
  const reading = await perms.decide(
    tx,
    { kind: "agent", agentId, onBehalfOfUserId: userId },
    "channel.read",
    agentRes,
    humanRes,
  );
  return reading.allowed ? null : "target_not_postable";
}

/**
 * The delivery target of an automation, decided for its creator and its bot (P-08): the bot is live and the creator may
 * see it (`bot.read`); a personal bot delivers only to its owner's DM; a channel target is a text channel, a board
 * target a board channel with one of its own columns, a thread target a top-level message of the conversation; and the
 * conversation passes `decideConversation`. A DM target is the creator's own DM with the bot, resolved per run.
 */
export async function decideTarget(
  tx: Tx,
  perms: PermissionService,
  a: { agentId: string; userId: string; target: AutomationTarget },
): Promise<TargetDecision> {
  const bot = await botWithUnit(tx, a.agentId);
  if (!bot || bot.agent.status === "disabled") return { ok: false, code: "agent_unavailable" };
  const facts = agentFactsOf(bot.agent, bot.unitPath);
  const reads = await perms.decide(
    tx,
    { kind: "user", userId: a.userId },
    "bot.read",
    agentResource(facts, a.userId),
  );
  if (!reads.allowed) return { ok: false, code: "bot_not_readable" };
  if (bot.agent.scope === "personal") {
    if (bot.agent.ownerUserId !== a.userId) return { ok: false, code: "bot_not_readable" };
    if (a.target.kind !== "dm") return { ok: false, code: "personal_bot_target" };
  }
  const target = a.target;
  if (target.kind === "dm") return { ok: true, conversationId: null };

  const [conv] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, target.conversationId))
    .limit(1);
  if (!conv) return { ok: false, code: "target_not_postable" };
  const code = await decideConversation(tx, perms, { agentId: a.agentId, userId: a.userId, conv });
  if (code) return { ok: false, code };

  if (target.kind === "channel" && conv.layout !== "text") return { ok: false, code: "target_not_postable" };
  if (target.kind === "board") {
    if (conv.layout !== "board") return { ok: false, code: "target_not_postable" };
    const [column] = await tx
      .select({ id: boardColumns.id })
      .from(boardColumns)
      .where(and(eq(boardColumns.id, target.columnId), eq(boardColumns.conversationId, conv.id)))
      .limit(1);
    if (!column) return { ok: false, code: "target_not_postable" };
  }
  if (target.kind === "thread") {
    const [root] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, target.threadRootMessageId),
          eq(messages.conversationId, conv.id),
          isNull(messages.threadId),
          isNull(messages.deletedAt),
        ),
      )
      .limit(1);
    if (!root) return { ok: false, code: "target_not_postable" };
  }
  return { ok: true, conversationId: conv.id };
}
