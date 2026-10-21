import { AGENT_CARD_FIELDS_MAX, type AgentCardField, type AgentCardInput } from "@ocw/contracts";
import { conversations, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApprovalCardContent, ApprovalRow } from "../approval";
import {
  agentName,
  humanMembersOf,
  memberName,
  parseArgs,
  type SourceInfo,
  shownTarget,
  sourceOf,
  type ToolCallRow,
  titleOf,
} from "./kind";
import {
  browserActionView,
  browserSummaryTitle,
  isBrowserActionTool,
  maskForDisplay,
  orderPreview,
  type PreviewResult,
  shortToolName,
  summaryTitle,
} from "./view";

/** 07.8-14 (R8): a browser action's fields as the card's preview (the values a person checks before approving). */
function browserPreview(args: Record<string, unknown>): PreviewResult {
  const v = browserActionView(args);
  const raw = typeof args.value === "string" ? args.value : "";
  return {
    fields: v.fields.map((f) => ({ key: f.label.toLowerCase(), label: f.label, value: f.value })),
    truncated: raw.length > 500,
    notices: { hiddenCharacters: false, maskedSecret: raw !== "" && maskForDisplay(raw).masked },
  };
}

/**
 * The platform-owned card that mirrors a `tool.call` request in its conversation (07.5-07, P-07, Pitfall 7, UI-SPEC
 * Surface 1). Card fields, the message body and every `message.updated` reach EVERY reader of the conversation, so the
 * card shows the call's values only where the requester alone reads it: a DM whose single human is the requester. Any
 * other conversation (channel, thread, group DM, AI chat) gets a summary: who wants to run which tool for whom, from
 * which source, and nothing of the arguments; the deciders and the requester review the values at `/approvals/<id>`.
 */

export const CARD_LABELS = { approve: "Approve", deny: "Deny", open: "Review" } as const;

export const TAINT_WARNING = (bot: string) =>
  `${bot} read outside content earlier in this turn. Check the values.`;
export const TRUNCATED_WARNING =
  "Some values are too long for the card. Review them in full before approving.";
export const HIDDEN_WARNING = "Contains hidden characters, shown as ⟨U+…⟩.";
export const MASKED_WARNING = "A value looks like a secret and is masked.";

export type CardDisplay = "exact" | "summary" | "review_only";

/**
 * The audience rule (pure): `exact` only for a conversation of kind `dm` whose single human member is the requester;
 * there, `review_only` when the card could not show every value as it is (a value cut at 500 characters, more fields
 * than a card holds, or a value that is empty or starts or ends with whitespace, which a card field trims).
 */
export function cardDisplay(p: {
  conversationKind: string | null;
  humanIds: readonly string[];
  requesterId: string;
  preview: PreviewResult;
  actionFields: number;
}): CardDisplay {
  const alone = p.conversationKind === "dm" && p.humanIds.length === 1 && p.humanIds[0] === p.requesterId;
  if (!alone) return "summary";
  const fits = p.actionFields + p.preview.fields.length <= AGENT_CARD_FIELDS_MAX;
  const asIs = p.preview.fields.every((f) => f.value.length > 0 && f.value === f.value.trim());
  return p.preview.truncated || !fits || !asIs ? "review_only" : "exact";
}

/** The card's display and how many of its leading fields are the ACTION section, for the stored call now. */
export async function cardDisplayOf(
  tx: Tx,
  t: ToolCallRow,
): Promise<{ display: CardDisplay; actionFields: number; preview: PreviewResult }> {
  const [conv] = await tx
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(eq(conversations.id, t.conversationId))
    .limit(1);
  const humanIds = conv?.kind === "dm" ? await humanMembersOf(tx, t.conversationId) : [];
  const browser = isBrowserActionTool(t.tool);
  const preview = browser ? browserPreview(parseArgs(t)) : orderPreview(parseArgs(t));
  // A browser action's card is its R8 fields alone (Action, Element, Page, Session, Value or Option).
  const exactActionFields = browser ? 0 : shownTarget(t) ? 3 : 2;
  const display = cardDisplay({
    conversationKind: conv?.kind ?? null,
    humanIds,
    requesterId: t.requestedForUserId,
    preview,
    actionFields: exactActionFields,
  });
  return { display, actionFields: display === "summary" ? 2 : exactActionFields, preview };
}

function sourceLabel(s: SourceInfo, exact: boolean): string {
  switch (s.kind) {
    case "mcp":
      return exact ? `${s.name} · MCP server` : s.name;
    case "connector":
      return exact ? `${s.name} · your account` : s.name;
    case "plugin":
      return exact ? `${s.name} · plugin` : s.name;
    case "http":
      return exact && s.keyName ? `Keychain key ${s.keyName}` : "Web request";
    case "sandbox":
    case "browser":
      return s.name;
  }
}

const field = (label: string, value: string): AgentCardField => ({
  label,
  value: value.trim() ? value.slice(0, 500) : "(empty)",
});

export async function composeToolCallCard(
  tx: Tx,
  row: ApprovalRow,
  t: ToolCallRow,
  waitingFor: string,
): Promise<ApprovalCardContent> {
  const source = await sourceOf(tx, t);
  const bot = await agentName(tx, t.agentId);
  const { display, actionFields, preview } = await cardDisplayOf(tx, t);
  const open = { kind: "open" as const, label: CARD_LABELS.open, target: `/approvals/${row.id}` };
  const warnings: string[] = t.tainted ? [TAINT_WARNING(bot)] : [];

  if (display === "summary") {
    const requesterName = (await memberName(tx, t.requestedForUserId)) ?? "Former member";
    const title = isBrowserActionTool(t.tool)
      ? browserSummaryTitle({ botName: bot, requesterName, args: parseArgs(t) })
      : summaryTitle({ botName: bot, tool: t.tool, requesterName });
    const card: AgentCardInput = {
      kind: "approval",
      title,
      fields: [field("Tool", shortToolName(t.tool)), field("Source", sourceLabel(source, false))],
      status: "pending",
      actions: [open],
      summary: `${title}. ${waitingFor}.`,
    };
    // No in-card decision: deciding happens on the review, which only the deciders and the requester can open.
    return { card, warnings, inlineDecision: false, labels: CARD_LABELS };
  }

  const title = await titleOf(tx, t, source);
  const target = shownTarget(t);
  const fields: AgentCardField[] = isBrowserActionTool(t.tool)
    ? preview.fields.slice(0, AGENT_CARD_FIELDS_MAX).map((p) => field(p.label, p.value))
    : [
        field("Tool", shortToolName(t.tool)),
        field("Source", sourceLabel(source, true)),
        // Never the internal server name (WINDOWS #221): only a real destination, such as an HTTP host.
        ...(target ? [field("Target", target)] : []),
        ...preview.fields.slice(0, AGENT_CARD_FIELDS_MAX - actionFields).map((p) => field(p.label, p.value)),
      ];
  if (display === "review_only") warnings.push(TRUNCATED_WARNING);
  if (preview.notices.hiddenCharacters) warnings.push(HIDDEN_WARNING);
  if (preview.notices.maskedSecret) warnings.push(MASKED_WARNING);
  const card: AgentCardInput = {
    kind: "approval",
    title,
    fields,
    status: "pending",
    actions: [open],
    // The message body (search, notifications) never carries a value, even in the requester's own DM.
    summary: title,
  };
  return { card, warnings: warnings.slice(0, 3), inlineDecision: true, labels: CARD_LABELS };
}
