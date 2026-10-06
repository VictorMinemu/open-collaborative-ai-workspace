import { type AiChatPolicy, DEFAULT_AI_CHAT_POLICY } from "@ocw/contracts";
import { aiChatPolicies, type Tx } from "@ocw/db";

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
