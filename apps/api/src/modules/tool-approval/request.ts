import {
  CanonicalJsonError,
  canonicalJson,
  TOOL_APPROVAL_LIMITS,
  TOOL_CALL_KIND,
  type ToolApprovalRefusal,
} from "@ocw/contracts";
import {
  agentToolCalls,
  agentTurns,
  approvalRequests,
  conversations,
  messages,
  type Tx,
  tenantOf,
  toolCallApprovals,
} from "@ocw/db";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { sha256Hex } from "../../lib/crypto";
import { type ApprovalService, actionHash } from "../approval";
import { loadPrincipalFacts } from "../organization";
import { currentRule, memberName, parseArgs, waitingForOf } from "./kind";
import type { ResolvedApproval } from "./resolve";

/**
 * `approvalForCall` (07.5-07, D-01, D-02, D-04, P-05, APPROVE-02, APPROVE-04): the one decision of an agent action that
 * may need a person, called by the three agent-action routes (`/tool-calls`, `/connectors/call`, `/http-requests`,
 * 07.5-11) inside their claim transaction, opened as the turn's human. It never waits for a person and never calls out:
 * a call that needs approval becomes one pending request with its card (or the one already pending), and the bot is
 * told to stop; the approved call is found later only by the hash recomputed from the re-run turn (the model never
 * names an approval), and consumed once through the 07.2 primitive.
 */

export type ApprovalOutcome =
  | { kind: "none" }
  | { kind: "grant"; approvalId: string }
  | { kind: "required"; approvalId: string; created: boolean; waitingFor: string; requesterName: string }
  | {
      kind: "refused";
      reason: ToolApprovalRefusal;
      /**
       * `approval_denied` only: who said no and their note, so the bot can tell its person (display name only, never
       * an email or an id; the note is the decider's own words, at most 280 characters).
       */
      denial?: ApprovalDenial;
    };

export interface ApprovalDenial {
  deciderName: string;
  note: string | null;
}

/** Where the tool comes from, as the claim records it (`agent_tool_calls.source_kind`, `source_id`, `target`). */
export interface ToolCallSource {
  kind: "builtin" | "mcp" | "plugin" | "vault";
  id: string | null;
  /** Domain or connector safe name; never a full URL with a query. */
  target: string | null;
}

export interface ApprovalForCallDeps {
  approvals: Pick<ApprovalService, "request" | "consumeGrant">;
}

export interface ApprovalForCallInput {
  /** The delivered turn (only its ids are trusted: the row is re-read and locked here). */
  turn: { eventId: string; agentId: string };
  tool: string;
  /** The call's arguments; null when the cell did not send them (the turn did not flag the tool). */
  args: Record<string, unknown> | null;
  /** The cell's id of this call: a client retry with the same id returns the same request. */
  toolCallId: string | null;
  source: ToolCallSource;
  /**
   * 07.8-14 (D-11, D-13, P-06, P-18): a mode this call needs whatever the policies say. `always` makes the call need a
   * person even with no rule (the requester decides then); a rule that applies keeps its approvers, and the stricter of
   * the two modes wins. Additive: absent, 07.5 behaves exactly as before.
   */
  floor?: "always";
  /** 07.8-14 (D-12 U-5, R8): the new request expires after this (shorter than the kind's 24 h only). */
  pendingTtlMs?: number;
}

const refused = (reason: ToolApprovalRefusal): ApprovalOutcome => ({ kind: "refused", reason });

/** The rule a call is decided by: a policy's, raised to the floor (no policy: the floor, decided by the requester). */
type EffectiveRule = Omit<ResolvedApproval, "policyId"> & { policyId: string | null };

function withFloor(rule: ResolvedApproval | null, floor: "always" | undefined): EffectiveRule | null {
  if (floor !== "always") return rule;
  if (rule) return rule.mode === "always" ? rule : { ...rule, mode: "always" };
  return {
    mode: "always",
    approverKind: "requester",
    approverUserIds: [],
    policyId: null,
    scopeUnitId: null,
    pattern: "",
  };
}

const GRANT_USE_SECS = TOOL_APPROVAL_LIMITS.grantUseMs / 1000;
const DENIED_SUPPRESS_SECS = TOOL_APPROVAL_LIMITS.deniedSuppressMs / 1000;

/** `approval_denied` with who decided (display name only) and their note. */
async function deniedBy(
  tx: Tx,
  d: { decidedBy: string | null; note: string | null },
): Promise<ApprovalOutcome> {
  const deciderName = (d.decidedBy ? await memberName(tx, d.decidedBy) : null) ?? "An approver";
  return { kind: "refused", reason: "approval_denied", denial: { deciderName, note: d.note } };
}

/** A transaction-scoped advisory lock on one key of this organization (released at commit or rollback). */
async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function approvalForCall(
  tx: Tx,
  deps: ApprovalForCallDeps,
  c: ApprovalForCallInput,
): Promise<ApprovalOutcome> {
  const { organizationId } = tenantOf(tx);

  // 1. The turn, locked (its taint is read under the lock), in this organization only (RLS): an id of another
  //    organization, or another agent's turn, is no turn. Its conversation and human are resolved here too (no FK on
  //    the stored action's conversation, event and requester: WINDOWS 202).
  const [turn] = await tx
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.eventId, c.turn.eventId))
    .for("update");
  if (!turn || turn.agentId !== c.turn.agentId) return refused("policy_changed");

  // 2. The rule that applies now (agent ∩ human, strictest wins). No rule, `never`, or `when_tainted` on a clean turn:
  //    no approval, and the arguments are never read.
  const policyRule = await currentRule(tx, {
    agentId: turn.agentId,
    requestedForUserId: turn.userId,
    tool: c.tool,
  });
  const rule = withFloor(policyRule, c.floor);
  if (!rule) return { kind: "none" };
  if (rule.mode === "when_tainted" && !turn.tainted) return { kind: "none" };

  const [conv] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, turn.conversationId))
    .limit(1);
  const human = await loadPrincipalFacts(tx, { kind: "user", userId: turn.userId });
  if (!conv || human.deactivated) return refused("policy_changed");

  // 3. The exact arguments: sent, canonical and within bounds.
  if (c.args === null) return refused("policy_changed");
  let canonical: string;
  try {
    canonical = canonicalJson(c.args);
  } catch (err) {
    if (err instanceof CanonicalJsonError) return refused("arguments_invalid");
    throw err;
  }
  if (Buffer.byteLength(canonical, "utf8") > TOOL_APPROVAL_LIMITS.argumentsBytes) {
    return refused("arguments_too_large");
  }
  const argumentsSha256 = sha256Hex(canonical);
  const hash = actionHash(TOOL_CALL_KIND, [
    turn.agentId,
    turn.userId,
    turn.conversationId,
    c.tool,
    argumentsSha256,
  ]);
  const toolCallId =
    c.toolCallId && c.toolCallId.length >= 1 && c.toolCallId.length <= 200 ? c.toolCallId : null;

  // 4. Serialise everything about this action (and this retry) in the organization: concurrent identical calls create
  //    one request, concurrent re-runs consume once (Pitfall 4). Always retry key first, then the hash.
  if (toolCallId) await lockKey(tx, `tool.call:${organizationId}:${turn.eventId}:${toolCallId}`);
  await lockKey(tx, `tool.call:${organizationId}:${hash}`);

  // 5. An approved, unused grant for exactly this action, still inside its use window: consumed once, here.
  const [grant] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .innerJoin(toolCallApprovals, eq(toolCallApprovals.id, approvalRequests.resourceId))
    .where(
      and(
        eq(approvalRequests.kind, TOOL_CALL_KIND),
        eq(toolCallApprovals.actionHash, hash),
        eq(approvalRequests.actionHash, hash),
        eq(approvalRequests.status, "approved"),
        isNull(approvalRequests.consumedAt),
        sql`${approvalRequests.decidedAt} + make_interval(secs => ${GRANT_USE_SECS}) > now()`,
        sql`${approvalRequests.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(approvalRequests.decidedAt))
    .limit(1);
  if (grant) {
    const used = await deps.approvals.consumeGrant(tx, {
      id: grant.id,
      kind: TOOL_CALL_KIND,
      actionHash: hash,
    });
    return used.ok ? { kind: "grant", approvalId: grant.id } : refused("approval_used");
  }

  // 6. This turn already ran this action with a grant: once only.
  const [usedHere] = await tx
    .select({ id: agentToolCalls.id })
    .from(agentToolCalls)
    .innerJoin(approvalRequests, eq(approvalRequests.id, agentToolCalls.approvalId))
    .where(
      and(
        eq(agentToolCalls.eventId, turn.eventId),
        eq(approvalRequests.kind, TOOL_CALL_KIND),
        eq(approvalRequests.actionHash, hash),
      ),
    )
    .limit(1);
  if (usedHere) return refused("approval_used");

  // 7. A grant of exactly this action was just used (by another turn, e.g. a concurrent re-run): still inside its use
  //    window it is "used", not a reason for a second card. After the window the action may be asked for again.
  const [justUsed] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .innerJoin(toolCallApprovals, eq(toolCallApprovals.id, approvalRequests.resourceId))
    .where(
      and(
        eq(approvalRequests.kind, TOOL_CALL_KIND),
        eq(toolCallApprovals.actionHash, hash),
        eq(approvalRequests.status, "applied"),
        sql`${approvalRequests.decidedAt} + make_interval(secs => ${GRANT_USE_SECS}) > now()`,
      ),
    )
    .limit(1);
  if (justUsed) return refused("approval_used");

  const requesterName = (await memberName(tx, turn.userId)) ?? "Former member";
  const required = async (approvalId: string, created: boolean): Promise<ApprovalOutcome> => ({
    kind: "required",
    approvalId,
    created,
    waitingFor: await waitingForOf(tx, { requestedForUserId: turn.userId }, rule),
    requesterName,
  });

  // 8. A client retry of the same call (same event and tool call id) is answered by the request it made, whatever
  //    the arguments of the retry (the first one wins).
  if (toolCallId) {
    const [retry] = await tx
      .select({
        id: approvalRequests.id,
        status: approvalRequests.status,
        live: sql<boolean>`${approvalRequests.expiresAt} > now()`,
        decidedBy: approvalRequests.decidedBy,
        note: approvalRequests.decisionNote,
      })
      .from(toolCallApprovals)
      .innerJoin(approvalRequests, eq(approvalRequests.resourceId, toolCallApprovals.id))
      .where(
        and(
          eq(approvalRequests.kind, TOOL_CALL_KIND),
          eq(toolCallApprovals.eventId, turn.eventId),
          eq(toolCallApprovals.toolCallId, toolCallId),
        ),
      )
      .limit(1);
    if (retry) {
      if (retry.status === "pending" && retry.live) return required(retry.id, false);
      return retry.status === "denied" ? deniedBy(tx, retry) : refused("approval_used");
    }
  }

  // 9. The same action already waits for a person: no second card.
  const [pending] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .innerJoin(toolCallApprovals, eq(toolCallApprovals.id, approvalRequests.resourceId))
    .where(
      and(
        eq(approvalRequests.kind, TOOL_CALL_KIND),
        eq(toolCallApprovals.actionHash, hash),
        eq(approvalRequests.status, "pending"),
        gt(approvalRequests.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(1);
  if (pending) return required(pending.id, false);

  // 10. A person said no to exactly this in the last 24 h: no new card.
  const [denied] = await tx
    .select({ decidedBy: approvalRequests.decidedBy, note: approvalRequests.decisionNote })
    .from(approvalRequests)
    .innerJoin(toolCallApprovals, eq(toolCallApprovals.id, approvalRequests.resourceId))
    .where(
      and(
        eq(approvalRequests.kind, TOOL_CALL_KIND),
        eq(toolCallApprovals.actionHash, hash),
        eq(approvalRequests.status, "denied"),
        sql`${approvalRequests.decidedAt} > now() - make_interval(secs => ${DENIED_SUPPRESS_SECS})`,
      ),
    )
    .orderBy(desc(approvalRequests.decidedAt))
    .limit(1);
  if (denied) return deniedBy(tx, denied);

  // 11. At most 5 pending per (agent, requester).
  const [open] = await tx
    .select({ n: count() })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.kind, TOOL_CALL_KIND),
        eq(approvalRequests.requestedByAgentId, turn.agentId),
        eq(approvalRequests.requestedForUserId, turn.userId),
        eq(approvalRequests.status, "pending"),
        gt(approvalRequests.expiresAt, sql`now()`),
      ),
    );
  if ((open?.n ?? 0) >= TOOL_APPROVAL_LIMITS.pendingPerRequester) return refused("too_many_pending");

  // 12. One stored action and one request with its card, replying to the human's message (in its thread, if any).
  const [asked] = await tx
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, turn.messageId))
    .limit(1);
  const [stored] = await tx
    .insert(toolCallApprovals)
    .values({
      organizationId,
      agentId: turn.agentId,
      requestedForUserId: turn.userId,
      conversationId: turn.conversationId,
      threadRootMessageId: asked?.threadId ?? null,
      eventId: turn.eventId,
      toolCallId,
      tool: c.tool,
      sourceKind: c.source.kind,
      sourceId: c.source.id,
      target: c.source.target ? c.source.target.slice(0, 255) : null,
      argumentsCanonical: canonical,
      argumentsSha256,
      actionHash: hash,
      tainted: turn.tainted,
      policyId: rule.policyId ?? null,
    })
    .returning({ id: toolCallApprovals.id });
  if (!stored) throw new Error("tool call approval insert returned no row");
  const request = await deps.approvals.request(tx, {
    kind: TOOL_CALL_KIND,
    resourceId: stored.id,
    requestedByAgentId: turn.agentId,
    requestedForUserId: turn.userId,
    eventId: turn.eventId,
    ...(c.pendingTtlMs !== undefined ? { ttlMs: c.pendingTtlMs } : {}),
    card: {
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      inReplyToMessageId: turn.messageId,
      threadRootMessageId: asked?.threadId ?? null,
    },
  });
  if (request.actionHash !== hash) throw new Error("tool call approval hash mismatch");
  return required(request.id, true);
}

/**
 * 07.8-14 (D-13, P-18): the stored arguments of every approved, unused grant of `tool` for this bot, requester and
 * conversation that is still inside its use window. A browser action whose navigation the site lock stopped is approved
 * with its arguments plus the host it may reach (`navigateTo`); the bot's re-run repeats the action alone, so its route
 * finds that grant here and asks `approvalForCall` with exactly the stored arguments (the hash decides; nothing is
 * consumed here). Read in the caller's tenant transaction (RLS).
 */
export async function usableGrantArgs(
  tx: Tx,
  p: { agentId: string; requestedForUserId: string; conversationId: string; tool: string },
): Promise<Record<string, unknown>[]> {
  const rows = await tx
    .select({ argumentsCanonical: toolCallApprovals.argumentsCanonical })
    .from(approvalRequests)
    .innerJoin(toolCallApprovals, eq(toolCallApprovals.id, approvalRequests.resourceId))
    .where(
      and(
        eq(approvalRequests.kind, TOOL_CALL_KIND),
        eq(approvalRequests.actionHash, toolCallApprovals.actionHash),
        eq(approvalRequests.status, "approved"),
        isNull(approvalRequests.consumedAt),
        sql`${approvalRequests.decidedAt} + make_interval(secs => ${GRANT_USE_SECS}) > now()`,
        sql`${approvalRequests.expiresAt} > now()`,
        eq(toolCallApprovals.agentId, p.agentId),
        eq(toolCallApprovals.requestedForUserId, p.requestedForUserId),
        eq(toolCallApprovals.conversationId, p.conversationId),
        eq(toolCallApprovals.tool, p.tool),
      ),
    )
    .orderBy(desc(approvalRequests.decidedAt))
    .limit(20);
  return rows.map((r) => parseArgs(r));
}
