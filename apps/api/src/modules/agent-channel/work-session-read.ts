import {
  AgentChannelWorkSessionRead,
  AgentChannelWorkSessionReadResponse,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  BUILTIN_TOOLS,
  WORK_SESSION_TOOL_FLAGS,
} from "@ocw/contracts";
import { agentTurns, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
import { auditBotWorkSession, ownBotSession, refusedAnswer, type WorkSessionModule } from "../work-session";
import { type CellPrincipal, cellOf } from "./auth";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, claimToolCall, liveTurn } from "./claim";

/**
 * Phase 07.16-17 (D-05, D-10, D-14, D-20; PD-14, PD-15, PD-21): `POST /agent-channel/v1/work-sessions/read`
 * (`ocw_work_session_read`). The bot reads what its own session did, bounded, redacted and repo-relative
 * (`readBotWorkSession`), so it can report and decide its next prompt. Only a session it started (`ownBotSession`, the
 * one rule: `not_your_session` for a person's, another bot's or another organization's).
 *
 * Order (07.16-15's): tx0, user-less, finds the delivered turn of THIS bot in the cell's organization (else 404
 * `unknown_turn`) and the bot's own session; tx1 runs AS THE SESSION'S SPONSOR (its creator, who always sees it): the
 * live turn → the tool on the turn (`not_in_turn`) → the session as the sponsor sees it now (`not_allowed`) → the claim
 * (the read counts against the turn's cap; it is not side-effecting, so neither outside content nor an earlier read
 * blocks it) → the read → `agent_turns.session_output_read = true` → `bot.work_session_read`. A read needs no active
 * profile: a bot can always report on its own session, a failure included (PD-14).
 *
 * D-20: the answer carries the runtime's work product, untrusted text the plugin wraps as such. Once read, the claim
 * refuses every other side-effecting call of the turn (`tainted`) except prompting and stopping the bot's session, and a
 * start answers `session_output` (07.16-15). Nothing here resolves a runtime approval (P3): the answer names deciders.
 *
 * Every refusal is recorded once (a denied `agent_tool_calls` row before the claim, plus `bot.work_session_refused`) and
 * never sets the flag. Audits carry ids, the cursor, the returned character count and `truncated` only: never the
 * output, a title, a tool summary or a path (P1).
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const READ = BUILTIN_TOOLS.workSessionRead;
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const UNKNOWN: unique symbol = Symbol("unknown_turn");

type OwnSession = NonNullable<Awaited<ReturnType<typeof ownBotSession>>>;

export function registerWorkSessionReadRoute(
  scope: App,
  core: Core,
  workSession: Pick<WorkSessionModule, "botRead">,
): void {
  scope.post(
    "/work-sessions/read",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelWorkSessionRead,
        response: { 200: AgentChannelWorkSessionReadResponse },
      },
    },
    async (req) => {
      const body = req.body;
      const cell = cellOf(req);
      // Ids and the cursor only.
      const metadata = {
        eventId: body.eventId,
        workSessionId: body.workSessionId,
        ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
      };
      const unknownTurn = async (tx: Tx): Promise<typeof UNKNOWN> => {
        await auditUnknownTurn(tx, core, { cell, tool: READ, reason: "unknown_turn", metadata });
        return UNKNOWN;
      };

      /** The call's `agent_tool_calls` row: denied with `reason`, or claimed against the turn (`reason` null). */
      const recordCall = (tx: Tx, c: CellPrincipal, turn: AgentTurnRow, reason: string | null) =>
        claimToolCall(tx, core, {
          cell: c,
          turn,
          tool: READ,
          flags: WORK_SESSION_TOOL_FLAGS[READ],
          web: false,
          sourceKind: "builtin",
          sourceId: null,
          target: body.workSessionId,
          reason,
          metadata,
        });

      /** A refusal: the denied call (the turn is not counted, the flag is not set) and `bot.work_session_refused`. */
      const refuse = async (
        tx: Tx,
        turn: AgentTurnRow,
        own: OwnSession | null,
        code: BotWorkSessionRefusal,
        claimed = false,
      ): Promise<BotWorkSessionRefused> => {
        if (!claimed) await recordCall(tx, cell, turn, code);
        await auditBotWorkSession(tx, core, {
          action: "bot.work_session_refused",
          tool: READ,
          turn,
          auditBase: cellAuditBase(cell),
          outcome: code,
          sponsorUserId: own?.bot.sponsorUserId ?? null,
          projectId: own?.session.projectId ?? null,
          deviceId: own?.session.deviceId ?? null,
          workSessionId: body.workSessionId,
        });
        return refusedAnswer(code);
      };

      // tx0 (no user): the turn of this bot and its own session (over the whole tenant).
      const found = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: null },
        async (tx): Promise<typeof UNKNOWN | { own: OwnSession } | { answer: BotWorkSessionRefused }> => {
          const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
          if (!turn || turn.agentId !== body.agentId) return unknownTurn(tx);
          const own = await ownBotSession(tx, { agentId: turn.agentId, workSessionId: body.workSessionId });
          if (own) return { own };
          const live = await liveTurn(tx, core, body);
          if (!live) return unknownTurn(tx);
          return { answer: await refuse(tx, live, null, "not_your_session") };
        },
      );
      if (found === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      if ("answer" in found) return found.answer;
      const sponsorUserId = found.own.bot.sponsorUserId;

      // tx1, as the session's sponsor.
      const out = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: sponsorUserId },
        async (tx) => {
          const turn = await liveTurn(tx, core, body);
          if (!turn) return unknownTurn(tx);
          if (!turn.tools.includes(READ)) return refuse(tx, turn, found.own, "not_in_turn");
          // The session as its sponsor sees it now (a sponsor who left the organization sees nothing).
          const own = await ownBotSession(tx, { agentId: turn.agentId, workSessionId: body.workSessionId });
          if (!own) return refuse(tx, turn, found.own, "not_allowed");

          const claimed = await recordCall(tx, cell, turn, null);
          if (!claimed.allowed) return refuse(tx, turn, own, "cap_reached", true);

          const model = await workSession.botRead(tx, {
            session: own.session,
            sponsorUserId,
            agentId: turn.agentId,
            ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
          });
          // D-20: the turn has read the session's output; its other side effects stay blocked from now on.
          await tx
            .update(agentTurns)
            .set({ sessionOutputRead: true })
            .where(eq(agentTurns.eventId, turn.eventId));
          await core.audit.record(tx, {
            ...cellAuditBase(cell),
            sessionId: own.session.id,
            action: "bot.work_session_read",
            actorKind: "agent",
            actorId: turn.agentId,
            agentId: turn.agentId,
            userId: turn.userId,
            deviceId: own.session.deviceId,
            resourceType: "work_session",
            resourceId: own.session.id,
            result: "success",
            metadata: {
              eventId: turn.eventId,
              sponsorUserId,
              workSessionId: own.session.id,
              cursor: model.cursor,
              chars: model.output.texts.reduce((n, t) => n + t.text.length, 0),
              truncated: model.output.truncated,
            },
          });
          return { kind: "read" as const, ...model };
        },
      );
      if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return out;
    },
  );
}
