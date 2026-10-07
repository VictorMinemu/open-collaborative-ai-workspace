import {
  type AiChatPolicy,
  type AiChatSettings,
  type AiToolState,
  type AiToolUnavailableReason,
  aiToolStates,
  type ModelCaps,
  type ModelRef,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { type ModelGateway, webPolicyReason } from "../model-gateway";
import type { PermissionService } from "../organization";

/**
 * The four tool toggles of an AI chat (05-11, AICHAT-06). Web is the only one built. It is available when the
 * organization allows web search in AI chats (policy `webEnabled`), the member holds `ai_chat.web` through the
 * resolver (explicit deny wins, principle 6) and the model can search on its backend (D-04: the plan's hosted
 * search; SearXNG on organization keys and the mock, so without `OCW_AI_SEARXNG_URL` they cannot). The same rule
 * (`webAllowed`) decides at every turn whether a search tool is attached. Company Knowledge, MCP and Skills are
 * visible but always `not_available_yet` in Phase 5 (`aiToolStates`) and never reach a model.
 */

export interface WebRuleInput {
  userId: string;
  policy: AiChatPolicy;
  perms: PermissionService;
  /** Capabilities of the model the answer runs on (null = no model yet: policy and permission only). */
  caps: ModelCaps | null;
  backend: ModelRef["backend"] | null;
}

/** Why Web cannot be used right now, or null when it can (policy → permission → model support). */
export async function webUnavailableReason(tx: Tx, i: WebRuleInput): Promise<AiToolUnavailableReason | null> {
  const policyReason = await webPolicyReason(tx, i.perms, i.userId, i.policy);
  if (policyReason) return policyReason;
  if (i.caps?.webSearch === "none") {
    return i.backend === "chatgpt_plan" ? "not_supported_by_model" : "search_not_configured";
  }
  return null;
}

/** The turn-time rule: true when a web search tool may be attached for this requester and model. */
export async function webAllowed(tx: Tx, i: WebRuleInput): Promise<boolean> {
  if (!i.caps) return false;
  return (await webUnavailableReason(tx, i)) === null;
}

/** The tool states of a chat for its owner, for the chat's last model. */
export async function toolStates(
  tx: Tx,
  i: {
    userId: string;
    policy: AiChatPolicy;
    perms: PermissionService;
    gateway: ModelGateway;
    chat: AiChatSettings;
    model: ModelRef | null;
  },
): Promise<AiToolState[]> {
  const caps = i.model ? await i.gateway.capsOf(tx, i.model, i.userId) : null;
  const reason = await webUnavailableReason(tx, { ...i, caps, backend: i.model?.backend ?? null });
  return aiToolStates({ reason, on: i.chat.tools.web });
}
