import {
  type ApprovalToolSourceKind,
  canonicalJson,
  prettyCanonicalJson,
  TOOL_APPROVAL_LIMITS,
  TOOL_CALL_KIND,
  type ToolCallApprovalView,
} from "@ocw/contracts";
import { agents, cellPlugins, mcpServers, orgMembers, type Tx, toolCallApprovals, vaultItems } from "@ocw/db";
import { eq } from "drizzle-orm";
import { sha256Hex } from "../../lib/crypto";
import type { ApprovalKind, ApprovalRow } from "../approval";
import { composeToolCallCard } from "./card";
import { resolveFor } from "./policies";
import type { ResolvedApproval } from "./resolve";
import { approverText, orderPreview, toolCallTitle } from "./view";

/**
 * The `tool.call` approval kind (07.5-07, D-02, D-04, APPROVE-02, ADR-0023): one later use of exactly one call a bot
 * asked to make. The stored action is `tool_call_approvals` (immutable by trigger); every hook reads it through the
 * transaction's tenant (RLS), so another organization's row reads as missing. Deciders are decided live at every read
 * and decision from the rule that applies now.
 */

export const TOOL_CALL_RESOURCE = "tool_call";

export type ToolCallRow = typeof toolCallApprovals.$inferSelect;

/** The stored action of a request (null when it is gone or belongs to another organization). */
export async function loadToolCall(
  tx: Tx,
  row: Pick<ApprovalRow, "resourceId">,
): Promise<ToolCallRow | null> {
  const [t] = await tx
    .select()
    .from(toolCallApprovals)
    .where(eq(toolCallApprovals.id, row.resourceId))
    .limit(1);
  return t ?? null;
}

/** A member's display name in this organization, or null (not a member here). */
export async function memberName(tx: Tx, userId: string): Promise<string | null> {
  const [m] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return m?.name ?? null;
}

async function agentName(tx: Tx, agentId: string): Promise<string> {
  const [a] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return a?.name ?? "Deleted bot";
}

export interface SourceInfo {
  kind: ApprovalToolSourceKind;
  name: string;
  /** Whose account runs it: the requester's (connector, personal key) or the organization's. */
  account: "requester" | "org" | null;
  keyName: string | null;
}

/** Where the stored call's tool comes from, for people (names only, never a secret or a full URL). */
export async function sourceOf(tx: Tx, t: Pick<ToolCallRow, "sourceKind" | "sourceId">): Promise<SourceInfo> {
  if (t.sourceKind === "mcp" && t.sourceId) {
    const [s] = await tx
      .select({ name: mcpServers.name, authMode: mcpServers.authMode })
      .from(mcpServers)
      .where(eq(mcpServers.id, t.sourceId))
      .limit(1);
    const connector = !!s?.authMode && s.authMode !== "org_secret";
    return {
      kind: connector ? "connector" : "mcp",
      name: s?.name ?? "A removed server",
      account: connector ? "requester" : "org",
      keyName: null,
    };
  }
  if (t.sourceKind === "plugin" && t.sourceId) {
    const [p] = await tx
      .select({ name: cellPlugins.packageName })
      .from(cellPlugins)
      .where(eq(cellPlugins.id, t.sourceId))
      .limit(1);
    return { kind: "plugin", name: p?.name ?? "A removed plugin", account: null, keyName: null };
  }
  if (t.sourceKind === "vault" && t.sourceId) {
    // A personal key reads only for its owner (RLS): anyone else sees "Web request" without the key's name.
    const [k] = await tx
      .select({ name: vaultItems.name, scope: vaultItems.scope })
      .from(vaultItems)
      .where(eq(vaultItems.id, t.sourceId))
      .limit(1);
    return {
      kind: "http",
      name: "Web request",
      account: k ? (k.scope === "personal" ? "requester" : "org") : null,
      keyName: k?.name ?? null,
    };
  }
  return {
    kind: t.sourceKind === "plugin" ? "plugin" : "http",
    name: "Web request",
    account: null,
    keyName: null,
  };
}

/** The rule that applies to the stored call now (live: a rule changed after the request applies as it is now). */
export async function currentRule(
  tx: Tx,
  t: Pick<ToolCallRow, "agentId" | "requestedForUserId" | "tool">,
): Promise<ResolvedApproval | null> {
  const r = await resolveFor(tx, { agentId: t.agentId, userId: t.requestedForUserId }, t.tool);
  return r && r.mode !== "never" ? r : null;
}

/** "Waiting for …" for the rule that applies now. */
export async function waitingForOf(
  tx: Tx,
  t: Pick<ToolCallRow, "requestedForUserId">,
  rule: ResolvedApproval | null,
): Promise<string> {
  const requesterName = (await memberName(tx, t.requestedForUserId)) ?? "Former member";
  return approverText({ approverKind: rule?.approverKind ?? null, requesterName, names: [], unitName: null });
}

/** The use window of an approved grant: `decided_at + 15 min` (P-05). */
export function useByOf(row: Pick<ApprovalRow, "decidedAt" | "status">): string | null {
  if (!row.decidedAt || (row.status !== "approved" && row.status !== "applied")) return null;
  return new Date(Date.parse(row.decidedAt) + TOOL_APPROVAL_LIMITS.grantUseMs).toISOString();
}

function parseArgs(t: ToolCallRow): Record<string, unknown> {
  const v: unknown = JSON.parse(t.argumentsCanonical);
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function createToolCallKind(): ApprovalKind {
  return {
    kind: TOOL_CALL_KIND,
    mode: "grant",
    resourceType: TOOL_CALL_RESOURCE,
    ttlMs: TOOL_APPROVAL_LIMITS.pendingTtlMs,

    async hashInput(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) throw new Error("tool call approval without its stored action");
      // From the stored row only, the arguments' hash recomputed from the canonical text itself (P-05).
      return [t.agentId, t.requestedForUserId, t.conversationId, t.tool, sha256Hex(t.argumentsCanonical)];
    },

    async canDecide(tx, deciderUserId, row) {
      const t = await loadToolCall(tx, row);
      if (!t) return false;
      const rule = await currentRule(tx, t);
      if (!rule || rule.approverKind === "requester") return deciderUserId === t.requestedForUserId;
      return false;
    },

    async audience(tx, row) {
      const t = await loadToolCall(tx, row);
      return t ? [t.requestedForUserId] : [];
    },

    async view(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) return { type: "fields", title: "This action no longer exists.", fields: [] };
      const source = await sourceOf(tx, t);
      const preview = orderPreview(parseArgs(t));
      const requesterName = (await memberName(tx, t.requestedForUserId)) ?? "Former member";
      const view: ToolCallApprovalView = {
        type: "tool_call",
        title: toolCallTitle({ tool: t.tool, sourceKind: source.kind, sourceName: source.name }),
        tool: t.tool,
        source,
        target: t.target,
        preview: preview.fields,
        truncated: preview.truncated,
        argumentsJson: prettyCanonicalJson(JSON.parse(t.argumentsCanonical)),
        argumentsBytes: Buffer.byteLength(canonicalJson(JSON.parse(t.argumentsCanonical)), "utf8"),
        notices: preview.notices,
        tainted: t.tainted,
        agent: { id: t.agentId, displayName: await agentName(tx, t.agentId) },
        requestedFor: { id: t.requestedForUserId, displayName: requesterName },
        approverLabel: await waitingForOf(tx, t, await currentRule(tx, t)),
        policy: null,
        audience: {
          origin: { kind: "dm", name: null },
          conversationReaders: 1,
          detailReaders: 1,
          messageRoute: null,
        },
        useBy: useByOf(row),
        usedAt: row.consumedAt ? new Date(row.consumedAt).toISOString() : null,
      };
      return view;
    },

    async card(tx, row) {
      const t = await loadToolCall(tx, row);
      if (!t) throw new Error("tool call approval without its stored action");
      return composeToolCallCard(tx, row, t);
    },
  };
}

export { agentName, parseArgs };
