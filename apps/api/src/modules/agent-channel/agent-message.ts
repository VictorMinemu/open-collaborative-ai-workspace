import { A2A_MAX_TARGETS, type ConsultTarget, permissionMatches } from "@ocw/contracts";
import { agents, conversationMembers, conversations, permissionRules, type Tx } from "@ocw/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { messagingDecision, type PermissionService } from "../organization";

/**
 * Who may consult whom (Phase 07.7, A2A-02; D-02, D-04, P-05; ADR-0027). One canonical resolver call per hop: the source
 * bot acting on behalf of the chain's human, `agent.message`, the target bot as the resource with the per-target rule
 * tool `agent:<id>`. The agent pass judges the rules on the target (closed by default for agents: only an allow rule
 * grants it; any deny wins), the human pass judges what the human may see and use (their own rights, 07.3's Bots module,
 * and the target-visibility preconditions 07.7-03 adds). The consult route and the turn's offered targets use exactly
 * this call; nothing else decides it.
 */

export type AgentMessageDecision = Awaited<ReturnType<PermissionService["decide"]>>;

/**
 * The canonical `agent.message` decision for one (source, human, target): exactly 07.7-03's `messagingDecision` (the
 * same resources and tool the admin's "Right now" summary uses). A missing or foreign target is denied.
 */
export function decideAgentMessage(
  tx: Tx,
  perms: PermissionService,
  p: { sourceAgentId: string; humanUserId: string; targetAgentId: string },
): Promise<AgentMessageDecision> {
  return messagingDecision(tx, perms, p);
}

/**
 * Whether any rule of the organization could grant `agent.message` (an allow rule whose pattern matches it). Without one
 * the decision is denied for every pair (agents hold it only through an allow rule), so the offering skips every
 * per-target decision: organizations that never turned consults on pay one small query per delivery.
 */
async function anyAllowRule(tx: Tx): Promise<boolean> {
  const rows = await tx
    .select({ permission: permissionRules.permission })
    .from(permissionRules)
    .where(eq(permissionRules.effect, "allow"));
  return rows.some((r) => permissionMatches(r.permission, "agent.message"));
}

/**
 * The bots a turn may consult (D-04, D-08): live, enabled team bots that are members of the conversation (or of its
 * parent channel), never the source itself, the chain's root or a bot already asked in the chain, and allowed by
 * `decideAgentMessage`; at most `A2A_MAX_TARGETS`, in a stable order. `[]` at once when no rule could allow it.
 */
export async function consultTargets(
  tx: Tx,
  perms: PermissionService,
  p: {
    sourceAgentId: string;
    humanUserId: string;
    conversationId: string;
    chain: { rootAgentId: string | null; usedTargetIds: readonly string[] } | null;
  },
): Promise<ConsultTarget[]> {
  if (!(await anyAllowRule(tx))) return [];
  const [conv] = await tx
    .select({ id: conversations.id, parent: conversations.parentConversationId })
    .from(conversations)
    .where(eq(conversations.id, p.conversationId))
    .limit(1);
  if (!conv) return [];
  const scope = [conv.id, ...(conv.parent ? [conv.parent] : [])];
  const members = await tx
    .select({ id: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(inArray(conversationMembers.conversationId, scope), eq(conversationMembers.memberKind, "agent")),
    );
  const excluded = new Set([
    p.sourceAgentId,
    ...(p.chain?.rootAgentId ? [p.chain.rootAgentId] : []),
    ...(p.chain?.usedTargetIds ?? []),
  ]);
  const ids = [...new Set(members.map((m) => m.id))].filter((id) => !excluded.has(id));
  if (ids.length === 0) return [];
  const candidates = (
    await tx
      .select()
      .from(agents)
      .where(and(inArray(agents.id, ids), isNull(agents.deletedAt)))
  )
    .filter((a) => a.scope === "team" && a.status !== "disabled")
    .sort((x, y) => (x.username < y.username ? -1 : x.username > y.username ? 1 : 0));
  const out: ConsultTarget[] = [];
  for (const a of candidates) {
    if (out.length >= A2A_MAX_TARGETS) break;
    const d = await decideAgentMessage(tx, perms, {
      sourceAgentId: p.sourceAgentId,
      humanUserId: p.humanUserId,
      targetAgentId: a.id,
    });
    if (!d.allowed) continue;
    out.push({
      id: a.id,
      handle: a.username.slice(0, 64),
      displayName: a.name.slice(0, 120),
      description: a.description ? a.description.slice(0, 200) : null,
    });
  }
  return out;
}
