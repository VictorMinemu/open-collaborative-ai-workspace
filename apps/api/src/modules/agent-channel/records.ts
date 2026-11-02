import {
  AgentChannelRecordUpdate,
  AgentChannelRecordUpdateResponse,
  ApiError,
  BUILTIN_TOOLS,
  TOOL_APPROVAL_LIMITS,
  type ToolApprovalRefusal,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agents, agentTurns, orgMembers, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
// Types only: the watched module reaches chat and automation, which import this module (a value import would be a cycle).
import type { CasRefusal, CasResult, RecordWrites } from "../watched";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";
import { auditUnknownTurn, claimToolCall, finishToolCall, liveTurn } from "./claim";
import { approvalVerdict, deliveredApproval, type ToolApprovalGate, turnAtCap } from "./tool-calls";

/**
 * `POST /agent-channel/v1/records/update` (`ocw_record_update`, 07.6-14; AUTO-04, D-04, D-07, P-13): a bot changes the
 * watched record of the card thread it was asked in. The body names the turn, the agent and the changes only: the API
 * binds the record, its connector and its last seen hash from the turn's thread (never from the request).
 *
 * Order (plan mode, P-19):
 *   1. tx0 (no user): the turn in the ledger (RLS: another organization's event is invisible) → 404 `unknown_turn`;
 *      another agent's turn → 403 `no_trigger`; both audited `bot.tool_call` denied;
 *   2. tx1, AS the turn's human: the live turn (they still read its conversation, else 403 `no_trigger`) → the tool on
 *      the turn (`not_in_turn`: offered only in a watched card's thread, `turn-policy.ts`) → the watched record whose
 *      card is the thread root of the turn's message, watched by this bot (`not_watched`) → the watch's rules
 *      (`preflight`: write tool, watched top-level fields, the 07.6-07 tool rule for this bot, the connector on, and for
 *      a per-member connector the requester's connection and share on the board) → with an approval rule, the caps
 *      under the turn lock → 07.5 `approvalForCall` on the record and the changes (`approval_required` posts the card,
 *      nothing is written) → the claim, side-effecting with untrusted output (a tainted turn is refused 403 `tainted`
 *      unless a grant covers exactly this call); every refusal is a denied `agent_tool_calls` row and audit;
 *   3. outside any transaction: `compareAndSet` (re-checks the rules, re-reads, compares, writes, re-reads, notes);
 *   4. tx2: the call's status and duration (`bot.tool_call.completed`).
 * Every answer the model reads is `{ok, code, sentence}` (UI-SPEC model-facing results): 200 written; 403 decisions
 * (taint, tool, rule); 409 state (changed elsewhere, approvals, connection, share, fields, cap).
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const TOOL = BUILTIN_TOOLS.recordUpdate;
/** Side-effecting (a change outside the workspace), with untrusted output (outside values). */
const FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const Refusal = z.union([AgentChannelRecordUpdateResponse, ApiError]);
const ASKER = "the person who asked";

type Status = 200 | 403 | 409;
type Code = CasRefusal | ToolApprovalRefusal | "record_changed" | "tainted" | "not_in_turn" | "cap_reached";

interface Names {
  person: string;
  recordId: string | null;
  connector: string | null;
  bot: string;
}

const RECORD = (n: Names) => n.recordId ?? "the record";
const CONNECTOR = (n: Names) => n.connector ?? "the connected system";

/** What the model reads (07.6-UI-SPEC model-facing results; the approval wording follows 07.5's). */
const SENTENCES: Record<Code, (n: Names) => string> = {
  record_changed: (n) =>
    `The record changed in ${CONNECTOR(n)} since the last check, so nothing was written. A card with the new values ` +
    `is in the thread. Tell ${n.person} and ask whether to apply the update to the new values.`,
  not_watched: (n) => `This card has no watched record. Ask ${n.person} to link one first.`,
  no_write_tool: (n) =>
    `The watch on ${RECORD(n)} has no update tool, so it can't be changed from here. Ask ${n.person} to choose one ` +
    "in the watch settings.",
  field_not_watched: (n) =>
    `Only the watched fields of ${RECORD(n)} can be changed, each as a top-level JSON pointer like "/status". ` +
    "Leave out any other field.",
  tool_not_allowed: (n) =>
    `Updating ${RECORD(n)} in ${CONNECTOR(n)} isn't allowed for this bot. Ask an admin to grant its tools.`,
  not_connected: (n) =>
    `${CONNECTOR(n)} uses ${n.person}'s own account, and it isn't connected (or needs reconnecting). Ask ${n.person} ` +
    "to connect it first.",
  member_account: (n) =>
    `${CONNECTOR(n)} uses ${n.person}'s own account, and it isn't allowed in this channel. Ask ${n.person} to allow ` +
    "it here first.",
  not_checked: (n) =>
    `${RECORD(n)} hasn't been checked yet, so there is nothing to compare with. Try again in a minute.`,
  connector_error: (n) =>
    `${CONNECTOR(n)} didn't answer or refused the update, so nothing was saved. Tell ${n.person} and try again later.`,
  tainted: (n) =>
    "I can't update the record after reading outside content in this turn. " +
    `Tell ${n.person} to ask again in a new message.`,
  not_in_turn: () => "Updating a watched record is not available on this turn.",
  cap_reached: () => "This turn already used all its tool calls. Ask again in a new message.",
  approval_required: (n) =>
    `This update needs approval. I posted a card asking for it. Tell ${n.person} in one short sentence that you are ` +
    "waiting for that approval, without repeating the values. Don't call ocw_record_update again now: when it is " +
    "approved you will get a new message.",
  approval_pending: (n) =>
    `This exact update is already waiting for approval in a card. Don't ask again; tell ${n.person} it is still waiting.`,
  approval_denied: (n) => `This exact update was denied. Don't retry it; ask ${n.person} what to change.`,
  approval_used: (n) => `That approval was already used once. Ask ${n.person} if they want to run it again.`,
  arguments_too_large: (n) => `This update is too large to approve. Ask ${n.person} to split it.`,
  arguments_invalid: () =>
    "This update can't be approved because its values aren't valid. Try again with plain values.",
  too_many_pending: (n) =>
    `${n.person} already has ${TOOL_APPROVAL_LIMITS.pendingPerRequester} actions waiting for approval. Wait for those first.`,
  policy_changed: () => "Updating a watched record is no longer available on this turn.",
};

const STATUS: Partial<Record<Code, Status>> = { tainted: 403, not_in_turn: 403, tool_not_allowed: 403 };

const answerOf = (code: Code, n: Names): Answer => ({
  status: STATUS[code] ?? 409,
  body: { ok: false, code, sentence: SENTENCES[code](n).slice(0, 500) },
});

type Answer = { status: Status; body: AgentChannelRecordUpdateResponse };

async function personName(tx: Tx, userId: string): Promise<string> {
  const [m] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return m?.name ?? ASKER;
}

async function botName(tx: Tx, agentId: string): Promise<string> {
  const [a] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return a?.name ?? "The bot";
}

type Decided =
  | { kind: "no_trigger" }
  | { kind: "answer"; answer: Answer }
  | {
      kind: "go";
      callId: string;
      watchedRecordId: string;
      names: Names;
    };

async function decide(
  core: Core,
  deps: { toolApproval: ToolApprovalGate; records: RecordWrites },
  cell: CellPrincipal,
  body: AgentChannelRecordUpdate,
  human: string,
): Promise<Decided> {
  const fieldCount = Object.keys(body.changes).length;
  // Ids and counts only: never a field, a value or the record id.
  const metadata = { eventId: body.eventId, fieldCount };
  return core.db.withTenant({ organizationId: cell.organizationId, userId: human }, async (tx) => {
    const turn = await liveTurn(tx, core, body);
    if (!turn || turn.userId !== human) {
      await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason: "no_trigger", metadata });
      return { kind: "no_trigger" };
    }
    const names: Names = {
      person: await personName(tx, human),
      recordId: null,
      connector: null,
      bot: await botName(tx, turn.agentId),
    };
    let target: string | null = null;
    const refuse = async (code: Code, extra: Record<string, unknown> = {}): Promise<Decided> => {
      await claimToolCall(tx, core, {
        cell,
        turn,
        tool: TOOL,
        flags: FLAGS,
        web: false,
        sourceKind: "builtin",
        sourceId: null,
        target,
        reason: code,
        metadata: { ...metadata, ...extra },
      });
      return { kind: "answer", answer: answerOf(code, names) };
    };

    if (!turn.tools.includes(TOOL)) return refuse("not_in_turn");
    const bound = await deps.records.watchedForTurn(tx, turn);
    if (!bound) return refuse("not_watched");
    const { w, server } = bound;
    names.recordId = w.externalRef;
    names.connector = server.name;
    target = server.safeName;
    const watched = { watchedRecordId: w.id };
    const rule = await deps.records.preflight(tx, {
      w,
      server,
      requesterUserId: human,
      agentId: turn.agentId,
      changes: body.changes,
    });
    if (rule) return refuse(rule, watched);

    // 07.5 (D-04, APPROVE-01): with a rule, the caps first (a consumed grant is never given back), then the decision on
    // exactly this record and these changes (the record is part of the approved action, so a grant for one card never
    // serves another card's call).
    if (deliveredApproval(turn.toolFlags, TOOL) && (await turnAtCap(tx, turn.eventId, false))) {
      return refuse("cap_reached", watched);
    }
    const verdict = approvalVerdict(
      await deps.toolApproval.approvalForCall(tx, {
        turn: { eventId: turn.eventId, agentId: turn.agentId },
        tool: TOOL,
        args: { record: w.externalRef, connector: server.name, changes: body.changes },
        toolCallId: null,
        source: { kind: "builtin", id: null, target: server.safeName },
      }),
    );
    if (verdict.reason) return refuse(verdict.reason, { ...watched, ...verdict.metadata });

    const claim = await claimToolCall(tx, core, {
      cell,
      turn,
      tool: TOOL,
      flags: FLAGS,
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target,
      reason: null,
      metadata: { ...metadata, ...watched },
      grantApprovalId: verdict.grantApprovalId,
    });
    if (!claim.allowed) {
      const code: Code = claim.reason === "tainted" ? "tainted" : "cap_reached";
      return { kind: "answer", answer: answerOf(code, names) };
    }
    return { kind: "go", callId: claim.callId, watchedRecordId: w.id, names };
  });
}

function answerFor(out: CasResult, names: Names): Answer {
  switch (out.kind) {
    case "written":
      return {
        status: 200,
        body: {
          ok: true,
          code: null,
          sentence: `Updated ${out.recordId} in ${CONNECTOR(names)}.`.slice(0, 500),
        },
      };
    case "conflict":
      return answerOf("record_changed", names);
    case "refused":
      return answerOf(out.code, names);
  }
}

export function registerRecordRoutes(
  scope: App,
  core: Core,
  deps: { toolApproval: ToolApprovalGate; records: RecordWrites },
): void {
  scope.post(
    "/records/update",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelRecordUpdate,
        // A refusal is the model's answer; a validation or authorization error keeps the uniform error body.
        response: { 200: AgentChannelRecordUpdateResponse, 403: Refusal, 409: Refusal },
      },
    },
    async (req, reply) => {
      const cell = cellOf(req);
      const body = req.body;
      const metadata = { eventId: body.eventId, fieldCount: Object.keys(body.changes).length };

      // 1. The turn's human, from the ledger (no user in this transaction; never a body field).
      const found = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: null },
        async (tx) => {
          const [turn] = await tx
            .select({ agentId: agentTurns.agentId, userId: agentTurns.userId })
            .from(agentTurns)
            .where(eq(agentTurns.eventId, body.eventId));
          if (turn && turn.agentId === body.agentId) return { userId: turn.userId };
          const reason = turn ? "no_trigger" : "unknown_turn";
          await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason, metadata });
          return { reason };
        },
      );
      if ("reason" in found) {
        if (found.reason === "unknown_turn") throw notFound(UNKNOWN_TURN, "unknown_turn");
        throw noTrigger();
      }

      // 2. Every decision as that human, in one short transaction with no outside call.
      const decided = await decide(core, deps, cell, body, found.userId);
      if (decided.kind === "no_trigger") throw noTrigger();
      if (decided.kind === "answer") return reply.code(decided.answer.status).send(decided.answer.body);

      // 3. The compare-and-set, outside any transaction.
      const started = Date.now();
      let out: CasResult;
      try {
        out = await deps.records.compareAndSet({
          organizationId: cell.organizationId,
          watchedRecordId: decided.watchedRecordId,
          requesterUserId: found.userId,
          requesterName: decided.names.person,
          agent: { id: body.agentId, displayName: decided.names.bot },
          changes: body.changes,
          eventId: body.eventId,
        });
      } catch (err) {
        core.log.warn({ eventId: body.eventId, err: { name: (err as Error)?.name } }, "record update failed");
        out = { kind: "refused", code: "connector_error" };
      }

      // 4. The call's outcome (ids, codes and counts only).
      await core.db.withTenant({ organizationId: cell.organizationId, userId: found.userId }, (tx) =>
        finishToolCall(tx, core, {
          cell,
          callId: decided.callId,
          status: out.kind === "written" ? "ok" : out.kind === "conflict" ? "blocked" : "error",
          durationMs: Date.now() - started,
          metadata: {
            eventId: body.eventId,
            watchedRecordId: decided.watchedRecordId,
            outcome: out.kind === "refused" ? out.code : out.kind,
          },
        }),
      );
      const answer = answerFor(out, decided.names);
      return reply.code(answer.status).send(answer.body);
    },
  );
}
