import {
  AgentChannelConversationOpen,
  AgentChannelConversationOpenResponse,
  BUILTIN_TOOLS,
  CONVERSATION_OPEN_FLAGS,
  CONVERSATION_OPEN_SENTENCES,
  type ConversationOpenRefusal,
} from "@ocw/contracts";
import { agentTurns, automationRuns, automations, type Tx } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
import type { AutomationFanOut } from "../automation";
import { type CellPrincipal, cellOf } from "./auth";
import { lockRunAndAutomation } from "./automation-runs";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, claimToolCall, liveTurn } from "./claim";

/**
 * Phase 07.17 (D-02, D-03, D-05, D-15; PD-07, PD-10, PD-17): `POST /agent-channel/v1/conversations/open`
 * (`ocw_conversation_open`), the one way a fan-out run's bot opens one conversation per new item. The body names the
 * turn, the bot and the items only (strict: no target, column, run, automation or person can be expressed, P6); the
 * route takes all of them from the stored turn and automation.
 *
 * Order (the 07.16 two-transaction pattern, PD-07):
 * - tx0, user-less: the delivered turn of THIS bot in the cell's organization (RLS hides another organization's; else
 *   404 `unknown_turn`, recorded by `auditUnknownTurn`) and its run (`automation_runs.agent_event_id`) with the
 *   automation's run-as person.
 * - tx1, AS the run-as person: the live turn (else 404) → the tool on the turn (`not_in_turn`) → the run of this turn
 *   and bot (`not_a_run`) → under the run and automation locks, the automation `active` (`automation_inactive`) with
 *   fan-out on (`fan_out_off`) → the claim (`CONVERSATION_OPEN_FLAGS`, target = the automation, counts only, and
 *   `outsideContent` on a tainted run turn, D-05: the open call alone is exempt; `cap_reached` from the claim) → the
 *   automation module's `fanOut.open` (caps, dedupe, posts, item jobs, the run answered, the audit).
 * - A post the target refuses (the bot left the board, the person lost access) rolls tx1 back, so nothing is posted
 *   or stored, and a fresh transaction records `target_not_postable` through the claim's `reason`.
 *
 * A refusal before the claim is a denied `agent_tool_calls` row (the turn is not counted) and its `bot.tool_call`
 * audit; every refusal answers 200 `{ ok: false, code, sentence }` with the fixed sentence. Ids and counts only: never
 * an external key, a title or a body in a record or a log line (P1).
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const OPEN = BUILTIN_TOOLS.conversationOpen;
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const UNKNOWN: unique symbol = Symbol("unknown_turn");

/** Thrown out of tx1 when the target refused a post: tx1 rolls back and the refusal is recorded afresh. */
class PostRefused extends Error {
  constructor(readonly metadata: Record<string, unknown>) {
    super("target_not_postable");
  }
}

const refusal = (code: ConversationOpenRefusal): AgentChannelConversationOpenResponse => ({
  ok: false,
  code,
  sentence: CONVERSATION_OPEN_SENTENCES[code],
});

export function registerConversationOpenRoute(scope: App, core: Core, fanOut: AutomationFanOut): void {
  /** A refusal decided before the claim (or the post's, after the rollback): recorded, the turn not counted. */
  async function refuse(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      target: string | null;
      metadata: Record<string, unknown>;
      code: ConversationOpenRefusal;
    },
  ): Promise<AgentChannelConversationOpenResponse> {
    await claimToolCall(tx, core, {
      cell: p.cell,
      turn: p.turn,
      tool: OPEN,
      flags: CONVERSATION_OPEN_FLAGS,
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: p.target,
      reason: p.code,
      metadata: p.metadata,
    });
    return refusal(p.code);
  }

  scope.post(
    "/conversations/open",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelConversationOpen,
        response: { 200: AgentChannelConversationOpenResponse },
      },
    },
    async (req): Promise<AgentChannelConversationOpenResponse> => {
      const body = req.body;
      const cell = cellOf(req);
      // Ids and the item count only: never a key, a title or a body.
      const metadata: Record<string, unknown> = { eventId: body.eventId, items: body.items.length };
      const unknownTurn = async (tx: Tx): Promise<typeof UNKNOWN> => {
        await auditUnknownTurn(tx, core, { cell, tool: OPEN, reason: "unknown_turn", metadata });
        return UNKNOWN;
      };

      // tx0 (no user): the turn of this bot, its run and the run-as person.
      const found = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: null },
        async (tx): Promise<typeof UNKNOWN | { userId: string; runId: string | null }> => {
          const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
          if (!turn || turn.agentId !== body.agentId) return unknownTurn(tx);
          const [run] = await tx
            .select({ id: automationRuns.id, runAsUserId: automations.runAsUserId })
            .from(automationRuns)
            .innerJoin(automations, eq(automations.id, automationRuns.automationId))
            .where(eq(automationRuns.agentEventId, turn.eventId))
            .limit(1);
          return { userId: run?.runAsUserId ?? turn.userId, runId: run?.id ?? null };
        },
      );
      if (found === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");

      let out: AgentChannelConversationOpenResponse | typeof UNKNOWN;
      try {
        // tx1, as the run-as person.
        out = await core.db.withTenant(
          { organizationId: cell.organizationId, userId: found.userId },
          async (tx): Promise<AgentChannelConversationOpenResponse | typeof UNKNOWN> => {
            const turn = await liveTurn(tx, core, body);
            if (!turn) return unknownTurn(tx);
            const base = { cell, turn, target: null, metadata };
            if (!turn.tools.includes(OPEN)) return refuse(tx, { ...base, code: "not_in_turn" });
            if (!found.runId) return refuse(tx, { ...base, code: "not_a_run" });

            // The runner's order: the run, then its automation; the state below is read under both locks.
            await lockRunAndAutomation(tx, found.runId);
            const [run] = await tx
              .select({
                id: automationRuns.id,
                automationId: automationRuns.automationId,
                anchorMessageId: automationRuns.anchorMessageId,
                agentId: automations.agentId,
                runAsUserId: automations.runAsUserId,
                status: automations.status,
                fanOutEnabled: automations.fanOutEnabled,
              })
              .from(automationRuns)
              .innerJoin(automations, eq(automations.id, automationRuns.automationId))
              .where(and(eq(automationRuns.id, found.runId), eq(automationRuns.agentEventId, turn.eventId)))
              .limit(1);
            if (!run || run.agentId !== turn.agentId || run.runAsUserId !== turn.userId) {
              return refuse(tx, { ...base, code: "not_a_run" });
            }
            const callMetadata = { ...metadata, automationId: run.automationId, runId: run.id };
            const call = { ...base, target: run.automationId, metadata: callMetadata };
            if (run.status !== "active") return refuse(tx, { ...call, code: "automation_inactive" });
            if (!run.fanOutEnabled) return refuse(tx, { ...call, code: "fan_out_off" });

            // D-05 (PD-10): a run turn that read outside content still opens, in its own target only; the claim says
            // `outsideContent: true`. Nothing else on the turn is loosened.
            const claimed = await claimToolCall(tx, core, {
              cell,
              turn,
              tool: OPEN,
              flags: CONVERSATION_OPEN_FLAGS,
              web: false,
              sourceKind: "builtin",
              sourceId: null,
              target: run.automationId,
              reason: null,
              metadata: callMetadata,
              ...(turn.tainted ? { outsideContent: true } : {}),
            });
            // A session read (never offered on a run turn) is the only other refusal: the tool is not for this turn.
            if (!claimed.allowed)
              return refusal(claimed.reason === "tainted" ? "not_in_turn" : "cap_reached");

            try {
              return await fanOut.open(tx, {
                auditBase: cellAuditBase(cell),
                turn: { eventId: turn.eventId, agentId: turn.agentId, tainted: turn.tainted },
                run: { id: run.id, automationId: run.automationId, anchorMessageId: run.anchorMessageId },
                items: body.items,
              });
            } catch (err) {
              if (fanOut.isPostRefusal(err)) throw new PostRefused(callMetadata);
              throw err;
            }
          },
        );
      } catch (err) {
        if (!(err instanceof PostRefused)) throw err;
        // tx1 rolled back (nothing posted, stored or counted): the refusal is recorded in its own transaction.
        out = await core.db.withTenant(
          { organizationId: cell.organizationId, userId: found.userId },
          async (tx): Promise<AgentChannelConversationOpenResponse | typeof UNKNOWN> => {
            const turn = await liveTurn(tx, core, body);
            if (!turn) return unknownTurn(tx);
            return refuse(tx, {
              cell,
              turn,
              target: (err.metadata.automationId as string | undefined) ?? null,
              metadata: err.metadata,
              code: "target_not_postable",
            });
          },
        );
      }
      if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return out;
    },
  );
}
