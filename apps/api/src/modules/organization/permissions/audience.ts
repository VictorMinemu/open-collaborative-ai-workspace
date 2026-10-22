import { agents, conversations, orgUnits, type Tx } from "@ocw/db";
import { and, eq, isNull } from "drizzle-orm";
import { type AgentFacts, AUDIENCE_COVER_MAX, type AudienceCoverFacts, agentResource } from "./policy";
import type { PermissionService } from "./service";

/**
 * The facts `audienceCovers` decides with (07.8-25; D-11 F-8; ADR-0029), loaded in the caller's tenant transaction
 * (RLS: a bot or conversation of another organization does not exist here, so the answer is "unknown"):
 * - the bot's **workspace audience**: a personal bot's owner; for any other bot, every active member who holds
 *   `bot.read` on it (whose turns read its workspace: for a unit bot its unit audience, its owner and admins) and every
 *   one who holds `sandbox.files` on it (who browse its files), each decided by the resolver (`usersAllowed`);
 * - of those, the **readers** of the conversation the turn is judged in (a thread through its channel or DM), each by
 *   the chat's readable-set decision (`isReadable`: the resolver's `channel.read` and the AI chats module gate).
 * The chat module's decision is passed in (it sits above this module); nothing here re-implements it.
 */
export async function audienceCoverFacts(
  tx: Tx,
  deps: {
    perms: Pick<PermissionService, "usersAllowed">;
    isReadable: (tx: Tx, userId: string, conversationId: string) => Promise<boolean>;
  },
  p: { conversationId: string; agentId: string },
): Promise<AudienceCoverFacts> {
  const unknown: AudienceCoverFacts = { workspace: null, readers: null };
  const [bot] = await tx
    .select({
      scope: agents.scope,
      ownerUserId: agents.ownerUserId,
      status: agents.status,
      unitId: agents.unitId,
    })
    .from(agents)
    .where(and(eq(agents.id, p.agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!bot) return unknown;
  const [unit] = bot.unitId
    ? await tx.select({ path: orgUnits.path }).from(orgUnits).where(eq(orgUnits.id, bot.unitId)).limit(1)
    : [];
  const facts: AgentFacts = {
    scope: bot.scope,
    ownerUserId: bot.ownerUserId,
    disabled: bot.status === "disabled",
    unitPath: unit?.path ?? [],
  };

  let workspace: string[];
  if (facts.scope === "personal") {
    if (!facts.ownerUserId) return unknown;
    workspace = [facts.ownerUserId];
  } else {
    const resourceFor = (userId: string) => agentResource(facts, userId);
    const users = await deps.perms.usersAllowed(tx, {
      candidates: "members",
      permission: "bot.read",
      resourceFor,
    });
    const browsers = await deps.perms.usersAllowed(tx, {
      candidates: "members",
      permission: "sandbox.files",
      resourceFor,
    });
    workspace = [...new Set([...users, ...browsers])].sort();
  }
  if (workspace.length === 0 || workspace.length > AUDIENCE_COVER_MAX) return { workspace, readers: null };

  const [conv] = await tx
    .select({ id: conversations.id, kind: conversations.kind, parent: conversations.parentConversationId })
    .from(conversations)
    .where(eq(conversations.id, p.conversationId))
    .limit(1);
  const judged = conv?.kind === "thread" ? conv.parent : (conv?.id ?? null);
  if (!judged) return { workspace, readers: null };
  const readers = new Set<string>();
  for (const userId of workspace) {
    // Sequential: one transaction = one connection.
    if (await deps.isReadable(tx, userId, judged)) readers.add(userId);
  }
  return { workspace, readers };
}
