import {
  type BotProfileInactiveReason,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  BUILTIN_TOOLS,
  WORK_SESSION_TOOL_FLAGS,
} from "@ocw/contracts";
import { agentToolCalls, conversations, type Tx } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { Core } from "../../core";
import { auditBotWorkSession, refusedAnswer } from "../work-session";
import type { CellPrincipal } from "./auth";
import { type AgentTurnRow, cellAuditBase, claimToolCall } from "./claim";

/**
 * 07.17.1.1-10 (PD-06): the claim, refusal and audit helpers of the bot's Work Zone routes, shared by
 * `work-sessions.ts` (start, prompt, stop) and 07.17.1.1-12's `work-session-files.ts` (upload, download). Moved from
 * `work-sessions.ts` without a behaviour change: each call is recorded exactly once, a refusal before the claim as a
 * denied `agent_tool_calls` row (the turn is not counted) plus `bot.work_session_refused`, after it as
 * `bot.work_session_refused` or the tool's success, all through the one builder `auditBotWorkSession`. Ids, the mode,
 * the model and the prompt's length only: never the prompt. `ocw_work_session_read` keeps its own claim path
 * (`work-session-read.ts`).
 */

const READ = BUILTIN_TOOLS.workSessionRead;

/** The tools that claim through these helpers (the read has its own path). */
export type WorkSessionCallTool =
  | typeof BUILTIN_TOOLS.workSessionStart
  | typeof BUILTIN_TOOLS.workSessionPrompt
  | typeof BUILTIN_TOOLS.workSessionStop
  | typeof BUILTIN_TOOLS.workSessionUpload
  | typeof BUILTIN_TOOLS.workSessionDownload;

/** What a call's records name: the claim's target and metadata, and the ids of its audit row. */
export interface CallRecord {
  tool: WorkSessionCallTool;
  /** The project (start) or the session (prompt, stop, upload, download) the call names. */
  target: string;
  /** The claim's audit metadata (ids and the prompt's length only). */
  metadata: Record<string, unknown>;
  sponsorUserId: string | null;
  projectId: string | null;
  deviceId: string | null;
  workSessionId?: string;
  promptChars?: number;
  /** 07.17.1.1 (PD-16): the chat attachment an upload names (its refusal audit names it too). */
  attachmentId?: string;
  /** 07.17.1.1 (PD-16): the repo-relative path's length of a file move; the path itself is never recorded (P1). */
  pathLength?: number;
}

/**
 * WR-02 (D-20): whether the turn's successful `ocw_work_session_read` calls (its allowed `agent_tool_calls` rows) read
 * `workSessionId` and nothing else. False when it read none (the mark came from another turn).
 */
export async function readOnly(tx: Tx, eventId: string, workSessionId: string): Promise<boolean> {
  const rows = await tx
    .selectDistinct({ target: agentToolCalls.target })
    .from(agentToolCalls)
    .where(
      and(
        eq(agentToolCalls.eventId, eventId),
        eq(agentToolCalls.tool, READ),
        eq(agentToolCalls.decision, "allowed"),
      ),
    );
  return rows.length > 0 && rows.every((r) => r.target === workSessionId);
}

/** The conversation whose readers decide a turn's audience: a thread is read through its channel or DM. */
export async function judgedConversationId(tx: Tx, conversationId: string): Promise<string> {
  const [conv] = await tx
    .select({ kind: conversations.kind, parent: conversations.parentConversationId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return conv?.kind === "thread" && conv.parent ? conv.parent : conversationId;
}

/** The shared helpers, bound to `core`. */
export function createWorkSessionCalls(core: Core) {
  /** `bot.work_session_refused` for `call` (after the claim, or with the denied row of `refuseBeforeClaim`). */
  async function auditRefusal(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      call: CallRecord;
      answer: BotWorkSessionRefused;
      proposalRefusal?: string;
    },
  ): Promise<BotWorkSessionRefused> {
    const { call, answer } = p;
    await auditBotWorkSession(tx, core, {
      action: "bot.work_session_refused",
      tool: call.tool,
      turn: p.turn,
      auditBase: cellAuditBase(p.cell),
      outcome: answer.code,
      sponsorUserId: call.sponsorUserId,
      projectId: call.projectId,
      deviceId: call.deviceId,
      ...(call.workSessionId ? { workSessionId: call.workSessionId } : {}),
      ...(call.promptChars !== undefined ? { promptChars: call.promptChars } : {}),
      ...(answer.reason ? { reason: answer.reason } : {}),
      ...(answer.field ? { field: answer.field } : {}),
      ...(p.proposalRefusal ? { proposalRefusal: p.proposalRefusal } : {}),
      // 07.17.1.1 (PD-16): a file move's refusal names the attachment, the path's length and, for `file_too_large`,
      // the size and whose limit applied. Absent for the 07.16 tools.
      ...(call.attachmentId ? { attachmentId: call.attachmentId } : {}),
      ...(call.pathLength !== undefined ? { pathLength: call.pathLength } : {}),
      ...(answer.sizeBytes !== undefined ? { bytes: answer.sizeBytes } : {}),
      ...(answer.limit ? { limitSource: answer.limit.source } : {}),
    });
    return answer;
  }

  /**
   * A refusal decided before the claim: a denied `agent_tool_calls` row (the turn is not counted) and
   * `bot.work_session_refused`, then the fixed answer.
   */
  async function refuseBeforeClaim(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      call: CallRecord;
      code: BotWorkSessionRefusal;
      reason?: BotProfileInactiveReason;
      /** 07.17.1.1: the full answer when it carries more than the code's sentence (`file_too_large`'s limit). */
      answer?: BotWorkSessionRefused;
    },
  ): Promise<BotWorkSessionRefused> {
    const { cell, turn, call } = p;
    await claimToolCall(tx, core, {
      cell,
      turn,
      tool: call.tool,
      flags: WORK_SESSION_TOOL_FLAGS[call.tool],
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: call.target,
      reason: p.code,
      metadata: call.metadata,
    });
    return auditRefusal(tx, {
      cell,
      turn,
      call,
      answer: p.answer ?? refusedAnswer(p.code, p.reason ? { reason: p.reason } : {}),
    });
  }

  /** The claim of a call on the turn (the call counts), with the tool's options; refused → its audited answer. */
  async function claim(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      call: CallRecord;
      outsideContent?: boolean;
      sessionOutputExempt?: boolean;
    },
  ): Promise<BotWorkSessionRefused | null> {
    const { cell, turn, call } = p;
    const claimed = await claimToolCall(tx, core, {
      cell,
      turn,
      tool: call.tool,
      flags: WORK_SESSION_TOOL_FLAGS[call.tool],
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: call.target,
      reason: null,
      metadata: call.metadata,
      ...(p.outsideContent ? { outsideContent: true } : {}),
      ...(p.sessionOutputExempt ? { sessionOutputExempt: true } : {}),
    });
    if (claimed.allowed) return null;
    const code: BotWorkSessionRefusal = claimed.reason === "tainted" ? "outside_content" : "cap_reached";
    return auditRefusal(tx, { cell, turn, call, answer: refusedAnswer(code) });
  }

  return { auditRefusal, refuseBeforeClaim, claim };
}
