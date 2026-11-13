import { randomUUID } from "node:crypto";
import { MAX_TOOL_CALLS_PER_TURN, MAX_WEB_CALLS_PER_TURN, type TurnToolFlags } from "@ocw/contracts";
import { agentChainHops, agentChains, agentToolCalls, agentTurns, conversations, type Tx } from "@ocw/db";
import { and, eq, lt, type SQL, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { createConversationAccess } from "../chat";
import type { CellPrincipal } from "./auth";

/**
 * The one claim of a tool call against its delivered turn (D-08, 07.4-11): the per-turn caps and the taint rule in ONE
 * conditional UPDATE (race-free: concurrent calls of one turn serialise on the row lock and the WHERE clause is
 * re-checked, so at most the cap is ever allowed), then the `agent_tool_calls` row and the `bot.tool_call` audit. Shared
 * by the tool gate (`/tool-calls`) and the proxy routes (`/http-requests`, later `/connectors/*`), so every path claims
 * the same way. A call refused before the claim (`reason` set) is recorded and audited the same way, without touching
 * the turn. No external call ever happens here: the caller does that after its transaction commits.
 */

export type AgentTurnRow = typeof agentTurns.$inferSelect;

export type ClaimSourceKind = "builtin" | "mcp" | "plugin" | "vault";

export interface ClaimedCall {
  callId: string;
  allowed: boolean;
  reason: string | null;
}

/** The `clientKind` / `sessionId` every cell-initiated audit row carries. */
export const cellAuditBase = (cell: CellPrincipal) => ({
  clientKind: "agent",
  sessionId: `cell:${cell.credentialId}`,
});

export async function claimToolCall(
  tx: Tx,
  core: Core,
  p: {
    cell: CellPrincipal;
    turn: AgentTurnRow;
    tool: string;
    flags: TurnToolFlags;
    /** A web call: also counted against the turn's web cap. */
    web: boolean;
    sourceKind: ClaimSourceKind;
    sourceId: string | null;
    target: string | null;
    /** A refusal decided before the claim: recorded and audited, the turn is not touched. */
    reason: string | null;
    /**
     * False for a tool whose own route counts the call (the memory tools, WINDOWS 148): the cap and the taint are
     * checked here but the call is not counted, so a call the cell also gates counts once. Default true.
     */
    countCall?: boolean;
    /** Extra audit metadata (ids, counts and hosts only: never arguments, paths, queries or results). */
    metadata?: Record<string, unknown>;
    /**
     * 07.5-11 (D-02, D-04, APPROVE-02, APPROVE-04): the approval whose one-use grant `approvalForCall` just consumed for
     * THIS call, in this transaction. The claim then omits the taint condition for this one UPDATE (a person approved
     * exactly this action), records `agent_tool_calls.approval_id` and audits `approvalId` and `grant: true`. The caps
     * still apply, and untrusted output still taints the turn afterwards; every other call of the turn is unchanged.
     */
    grantApprovalId?: string | null;
    /**
     * 07.15 D-17 (PD-06): a file read (`ocw_attachment_read`) is counted on the turn's own attachment counters instead
     * of the cap of 8: the conditional UPDATE checks `attachment_reads < maxReads` and `attachment_chars < maxChars`
     * (not `tool_calls`) and adds one read. The characters a read returns are added by its route afterwards.
     */
    attachmentRead?: { maxReads: number; maxChars: number };
    /**
     * 07.16 D-08 (PD-15): the bot's profile lets it act on outside content, so a side-effecting call is claimed on a
     * tainted turn: the taint condition is omitted for this one UPDATE (like `grantApprovalId`) and the audit says
     * `outsideContent: true`. The caps and the session-output condition below still apply.
     */
    outsideContent?: boolean;
    /**
     * 07.16 D-20 (PD-15): once a turn read a Work Zone session's output (`agent_turns.session_output_read`), every
     * other side-effecting call of the turn is refused as `tainted`; prompting and stopping that session are exempt.
     */
    sessionOutputExempt?: boolean;
    /**
     * 07.17.1.1.2 D-13 (PD-08): a task tool (`ocw_task_*`) is outside the per-turn cap of 8: the cap is neither checked
     * nor counted (the plugin bounds each task tool to one call per turn). Only for flags that are not side-effecting,
     * so the taint and session-output conditions never apply to it either; the call is still recorded and audited.
     */
    uncapped?: boolean;
  },
): Promise<ClaimedCall> {
  const { turn, flags } = p;
  let reason = p.reason;
  if (!reason) {
    const conditions: Array<SQL | undefined> = [
      eq(agentTurns.eventId, turn.eventId),
      ...(p.attachmentRead
        ? [
            lt(agentTurns.attachmentReads, p.attachmentRead.maxReads),
            lt(agentTurns.attachmentChars, p.attachmentRead.maxChars),
          ]
        : p.uncapped && !flags.sideEffecting
          ? []
          : [lt(agentTurns.toolCalls, MAX_TOOL_CALLS_PER_TURN)]),
      p.web ? lt(agentTurns.webCalls, MAX_WEB_CALLS_PER_TURN) : undefined,
      flags.sideEffecting && !p.grantApprovalId && !p.outsideContent
        ? eq(agentTurns.tainted, false)
        : undefined,
      // D-20: false only after a session read; a person's one-use grant lifts it as it lifts the taint.
      flags.sideEffecting && !p.grantApprovalId && !p.sessionOutputExempt
        ? eq(agentTurns.sessionOutputRead, false)
        : undefined,
    ];
    const updated = await tx
      .update(agentTurns)
      .set({
        toolCalls:
          p.countCall === false || (p.uncapped && !flags.sideEffecting)
            ? sql`${agentTurns.toolCalls}`
            : sql`${agentTurns.toolCalls} + 1`,
        webCalls: p.web ? sql`${agentTurns.webCalls} + 1` : sql`${agentTurns.webCalls}`,
        tainted: flags.untrustedOutput ? true : sql`${agentTurns.tainted}`,
        ...(p.attachmentRead ? { attachmentReads: sql`${agentTurns.attachmentReads} + 1` } : {}),
      })
      .where(and(...conditions))
      .returning({ eventId: agentTurns.eventId });
    if (updated.length > 0 && flags.untrustedOutput) await taintReturnTurns(tx, turn.eventId);
    if (updated.length === 0) {
      // Nothing updated: say why from a fresh read (only on the denial path).
      const [after] = await tx
        .select({ tainted: agentTurns.tainted, sessionOutputRead: agentTurns.sessionOutputRead })
        .from(agentTurns)
        .where(eq(agentTurns.eventId, turn.eventId));
      const taintRefused = after?.tainted === true && !p.grantApprovalId && !p.outsideContent;
      const outputRefused = after?.sessionOutputRead === true && !p.grantApprovalId && !p.sessionOutputExempt;
      reason = flags.sideEffecting && (taintRefused || outputRefused) ? "tainted" : "cap_reached";
    }
  }

  const [row] = await tx
    .insert(agentToolCalls)
    .values({
      organizationId: turn.organizationId,
      eventId: turn.eventId,
      agentId: turn.agentId,
      userId: turn.userId,
      tool: p.tool,
      sourceKind: p.sourceKind,
      sourceId: p.sourceId,
      target: p.target,
      decision: reason ? "denied" : "allowed",
      reason,
      // The consumed grant stays bound to this call even on a refusal (the grant is never given back).
      approvalId: p.grantApprovalId ?? null,
    })
    .returning({ id: agentToolCalls.id });
  if (!row) throw new Error("agent_tool_calls insert failed");

  await core.audit.record(tx, {
    ...cellAuditBase(p.cell),
    action: "bot.tool_call",
    actorKind: "agent",
    actorId: turn.agentId,
    agentId: turn.agentId,
    userId: turn.userId,
    resourceType: "tool",
    resourceId: p.tool,
    result: reason ? "denied" : "success",
    // Source = the MCP server (id + safe name), plugin or keychain item the tool used; never arguments or results.
    metadata: {
      tool: p.tool,
      sourceKind: p.sourceKind,
      sourceId: p.sourceId,
      target: p.target,
      reason,
      ...p.metadata,
      ...(p.grantApprovalId ? { approvalId: p.grantApprovalId, grant: true } : {}),
      ...(p.outsideContent ? { outsideContent: true } : {}),
    },
  });
  return { callId: row.id, allowed: reason === null, reason };
}

/** `agent_chains_budget_check`'s ceiling: a chain never has more hops, so never more return turns in a row. */
const LATE_TAINT_MAX_STEPS = 10;

/**
 * Late taint (07.7 CR-A-01 follow-up; A2A-03, D-09, Pitfall 2): a turn that just read untrusted content hands its taint
 * to every still-running return turn that continues it. A consult is asynchronous: the asking turn keeps running after
 * its call, so the consulted bot may answer (and the return turn be delivered untainted, `deliverConsultReply`'s
 * snapshot) before the asking turn reads outside content. The return turn resumes the same per-thread OpenClaw session,
 * so it is tainted from then on, like its asker. Transitive through the chain (a return turn that asked again and got
 * its own answer back), bounded by the largest hop budget a chain may have (every hop adds at most one return turn).
 * Scoped to the one chain this turn roots or belongs to (unique `root_event_id`, indexed `chain_id`); a finished return
 * turn is left as it was. The server is the authority: every side-effecting call is claimed against `agent_turns.tainted` (this file,
 * the sandbox claim, the memory, board and consult routes), so the cell's local guard needs no new signal.
 */
export async function taintReturnTurns(tx: Tx, eventId: string): Promise<void> {
  await markReturnTurns(tx, eventId, "tainted");
}

/**
 * 07.16 D-20 (code review CR-02): the turn read a Work Zone session's output (`ocw_work_session_read`). The mark is set
 * on the turn and handed, like late taint, to every still-running return turn that continues it: they resume the same
 * per-thread OpenClaw session, which now holds the output. Only `session_output_read` is set (it is not a taint).
 */
export async function markSessionOutputRead(tx: Tx, eventId: string): Promise<void> {
  await tx.update(agentTurns).set({ sessionOutputRead: true }).where(eq(agentTurns.eventId, eventId));
  await markReturnTurns(tx, eventId, "session_output_read");
}

/** `taintReturnTurns`' walk, for one of the two carried marks (a fixed column name, never caller text). */
async function markReturnTurns(
  tx: Tx,
  eventId: string,
  mark: "tainted" | "session_output_read",
): Promise<void> {
  const column = sql.raw(mark);
  await tx.execute(sql`
    with recursive chain as (
      select c.id from ${agentChains} c where c.root_event_id = ${eventId}
      union
      select t.chain_id from ${agentTurns} t where t.event_id = ${eventId} and t.chain_id is not null
    ), reach(event_id, n) as (
      select ${eventId}::uuid, 0
      union
      select t.event_id, r.n + 1
        from reach r
        join ${agentChainHops} h
          on h.source_event_id = r.event_id and h.mode = 'consult' and h.chain_id in (select id from chain)
        join ${agentTurns} t on t.returning_hop_id = h.id and t.chain_id = h.chain_id
       where r.n < ${LATE_TAINT_MAX_STEPS}
    )
    update ${agentTurns} t set ${column} = true
      from reach r
     where t.event_id = r.event_id and r.n > 0 and t.${column} = false and t.done_at is null`);
}

/** A call refused before any turn was found (unknown, foreign or no longer live): audited with no human to attribute. */
export async function auditUnknownTurn(
  tx: Tx,
  core: Core,
  p: { cell: CellPrincipal; tool: string; reason: string; metadata?: Record<string, unknown> },
): Promise<string> {
  await core.audit.record(tx, {
    ...cellAuditBase(p.cell),
    action: "bot.tool_call",
    actorKind: "system",
    resourceType: "tool",
    resourceId: p.tool,
    result: "denied",
    metadata: { tool: p.tool, reason: p.reason, ...p.metadata },
  });
  return randomUUID();
}

/**
 * The outcome of an allowed call the API itself carried out (a proxy route), in a second short transaction after the
 * outbound request: the `agent_tool_calls` row gets its status and duration, and `bot.tool_call.completed` is audited
 * with ids, counts and hosts only.
 */
export async function finishToolCall(
  tx: Tx,
  core: Core,
  p: {
    cell: CellPrincipal;
    callId: string;
    status: "ok" | "error" | "blocked";
    durationMs: number;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const [call] = await tx
    .update(agentToolCalls)
    .set({
      status: p.status,
      durationMs: Math.max(0, Math.trunc(p.durationMs)),
      completedAt: new Date().toISOString(),
    })
    .where(and(eq(agentToolCalls.id, p.callId), eq(agentToolCalls.decision, "allowed")))
    .returning();
  if (!call) return;
  await core.audit.record(tx, {
    ...cellAuditBase(p.cell),
    action: "bot.tool_call.completed",
    actorKind: "agent",
    actorId: call.agentId,
    agentId: call.agentId,
    userId: call.userId,
    resourceType: "tool",
    resourceId: call.tool,
    result: p.status === "ok" ? "success" : p.status === "blocked" ? "denied" : "error",
    metadata: { tool: call.tool, status: p.status, durationMs: call.durationMs, ...p.metadata },
  });
}

/**
 * The rule of every agent call (PR #25, 07.2-11): the delivered turn of THIS agent, in the cell's organization (RLS),
 * whose human still reads the turn's conversation (a thread is read through its channel). Anything else is no live
 * turn: the caller answers 403 `no_trigger`.
 */
export async function liveTurn(
  tx: Tx,
  core: Core,
  p: { eventId: string; agentId: string },
): Promise<AgentTurnRow | null> {
  const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, p.eventId));
  if (!turn || turn.agentId !== p.agentId) return null;
  // A thread is read through its channel or DM (single-level threads).
  const [conv] = await tx
    .select({ id: conversations.id, kind: conversations.kind, parent: conversations.parentConversationId })
    .from(conversations)
    .where(eq(conversations.id, turn.conversationId))
    .limit(1);
  if (!conv) return null;
  const judged = conv.kind === "thread" ? conv.parent : conv.id;
  if (!judged) return null;
  const readable = await createConversationAccess(core).isReadable(tx, turn.userId, judged, {
    kinds: ["channel", "dm", "group", "ai_chat"],
  });
  return readable ? turn : null;
}
