import type { AgentCardField, AgentCardInput } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { ApprovalCardContent, ApprovalRow } from "../approval";
import { parseArgs, sourceOf, type ToolCallRow } from "./kind";
import { orderPreview, shortToolName, toolCallTitle } from "./view";

/**
 * The platform-owned card that mirrors a `tool.call` request in its conversation (07.5-07, P-07, UI-SPEC Surface 1).
 * Card fields reach every reader of the conversation through `message.updated`, so what a card may show is decided
 * here by its audience.
 */

export const CARD_LABELS = { approve: "Approve", deny: "Deny", open: "Review" } as const;

export async function composeToolCallCard(
  tx: Tx,
  row: ApprovalRow,
  t: ToolCallRow,
): Promise<ApprovalCardContent> {
  const source = await sourceOf(tx, t);
  const title = toolCallTitle({ tool: t.tool, sourceKind: source.kind, sourceName: source.name });
  const preview = orderPreview(parseArgs(t));
  const fields: AgentCardField[] = [
    { label: "Tool", value: shortToolName(t.tool) },
    { label: "Source", value: source.name },
    ...(t.target ? [{ label: "Target", value: t.target }] : []),
    ...preview.fields.map((p) => ({ label: p.label, value: p.value.trim() ? p.value : "(empty)" })),
  ];
  const card: AgentCardInput = {
    kind: "approval",
    title,
    fields,
    status: "pending",
    actions: [{ kind: "open", label: CARD_LABELS.open, target: `/approvals/${row.id}` }],
    summary: title,
  };
  return { card, warnings: [], labels: CARD_LABELS };
}
