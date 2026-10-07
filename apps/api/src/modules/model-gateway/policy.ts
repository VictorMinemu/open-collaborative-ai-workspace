import {
  type AiChatPolicy,
  type AiToolUnavailableReason,
  DEFAULT_AI_CHAT_POLICY,
  type UpdateAiChatPolicyRequest,
} from "@ocw/contracts";
import { aiChatPolicies, type Tx, tenantOf } from "@ocw/db";
import { orgResource, type PermissionService } from "../organization";

/** The organization's AI chat policy (one row per org; absent = `DEFAULT_AI_CHAT_POLICY`). */
export async function loadAiChatPolicy(tx: Tx): Promise<AiChatPolicy> {
  const [row] = await tx.select().from(aiChatPolicies).limit(1);
  if (!row) return { ...DEFAULT_AI_CHAT_POLICY, planAllowedModels: [], titleModels: {} };
  return {
    chatgptPlanEnabled: row.chatgptPlanEnabled,
    orgKeysEnabled: row.orgKeysEnabled,
    planAllowedModels: row.planAllowedModels,
    orgKeyDailyGenerations: row.orgKeyDailyGenerations,
    orgKeyDailyCostMicros: row.orgKeyDailyCostMicros,
    planDailyGenerations: row.planDailyGenerations,
    concurrentGenerationsPerUser: row.concurrentGenerationsPerUser,
    maxContextTokens: row.maxContextTokens,
    webEnabled: row.webEnabled,
    titleModels: row.titleModels,
  };
}

const KEYS = Object.keys(DEFAULT_AI_CHAT_POLICY) as Array<keyof AiChatPolicy>;

/**
 * Applies an admin's partial change (05-08, D-06). Returns the policy and the keys that actually changed (sorted;
 * empty = nothing written). Upserts the org's row and never touches `chatgpt_host_id` (05-05). Every send reads the
 * policy in its own transaction, so a change applies to the next send without a restart.
 */
export async function saveAiChatPolicy(
  tx: Tx,
  patch: UpdateAiChatPolicyRequest,
  actorUserId: string | null,
): Promise<{ policy: AiChatPolicy; changed: string[] }> {
  const before = await loadAiChatPolicy(tx);
  const next: AiChatPolicy = { ...before };
  for (const key of KEYS) {
    if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
  }
  next.planAllowedModels = [...new Set(next.planAllowedModels)];
  const changed = KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k])).sort();
  if (changed.length === 0) return { policy: before, changed };
  const values = { ...next, updatedBy: actorUserId, updatedAt: new Date().toISOString() };
  await tx
    .insert(aiChatPolicies)
    .values({ organizationId: tenantOf(tx).organizationId, ...values })
    .onConflictDoUpdate({ target: aiChatPolicies.organizationId, set: values });
  return { policy: await loadAiChatPolicy(tx), changed };
}

/**
 * Web search in AI chats before any model is considered (05-11, AICHAT-06): the organization turned it off
 * (`disabled_by_org`), or the resolver denies `ai_chat.web` to this member (`denied`: an explicit deny wins,
 * principle 6); null when both allow it. Model support is the caller's second check (`caps.webSearch`).
 */
export async function webPolicyReason(
  tx: Tx,
  perms: PermissionService,
  userId: string,
  policy: AiChatPolicy,
): Promise<Extract<AiToolUnavailableReason, "disabled_by_org" | "denied"> | null> {
  if (!policy.webEnabled) return "disabled_by_org";
  const decision = await perms.decide(tx, { kind: "user", userId }, "ai_chat.web", orgResource());
  return decision.allowed ? null : "denied";
}
