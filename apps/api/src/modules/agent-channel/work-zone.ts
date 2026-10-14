import {
  AgentChannelWorkZoneProjects,
  AgentChannelWorkZoneProjectsResponse,
  AgentChannelWorkZonePropose,
  AgentChannelWorkZoneProposeResponse,
  BUILTIN_TOOLS,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agentTurns, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { conflict, notFound } from "../../lib/errors";
import type { WorkZoneProposalService } from "../work-session";
import { type CellPrincipal, cellOf } from "./auth";
import { type AgentTurnRow, auditUnknownTurn, claimToolCall, liveTurn } from "./claim";

/**
 * Work Zone proposals for bots (07.5-08; D-03, D-04, P-08; APPROVE-03, APPROVE-04):
 *
 * - `POST /agent-channel/v1/work-zone/projects` (`ocw_work_zone_projects`): the projects the turn's human may start a
 *   session on, names and ids only (principle 7). Read-only: a tainted turn may still list.
 * - `POST /agent-channel/v1/work-zone/proposals` (`ocw_start_work_zone`): proposes a session as a `work_zone` card that
 *   only that human can start. Always side-effecting, so a turn that read untrusted content is refused before anything
 *   is stored or posted. The body has no mode, model or user field (strict schema: 400).
 *
 * Order: tx0 (no user) finds the turn's human in the turn ledger (RLS: another organization's event is invisible) — no
 * delivered turn of this bot → 404 `unknown_turn`; tx1 runs AS that human: the live turn (the human still reads its
 * conversation) → the tool on the turn (`not_in_turn`) → the claim (caps, taint) → the work-session service. Every
 * refusal is a 200 `{ refused }` for proposals (the plugin turns it into a fixed sentence) and is recorded: a denied
 * `agent_tool_calls` row, or a `work_zone.proposal_refused` audit after the claim.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const PROJECTS = BUILTIN_TOOLS.workZoneProjects;
const START = BUILTIN_TOOLS.startWorkZone;
/** The API's own answer (trusted); lists without changing anything. */
const PROJECTS_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: false };
/** Trusted output, always side-effecting (D-03): never from a tainted turn, whatever the turn's flags say. */
const START_FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };

const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const UNKNOWN = Symbol("unknown_turn");

type ClaimRefusal = "not_in_turn" | "tainted" | "cap_reached";

/**
 * Finds the turn, then runs `act` as its human after the tool passed the turn and the claim. Returns `UNKNOWN` when
 * there is no live delivered turn of this bot (the caller answers 404), or the claim's refusal.
 */
async function onTurn<T>(
  core: Core,
  p: {
    cell: CellPrincipal;
    tool: string;
    flags: TurnToolFlags;
    body: { eventId: string; agentId: string };
    metadata: Record<string, unknown>;
  },
  act: (tx: Tx, turn: AgentTurnRow) => Promise<T>,
): Promise<T | { refused: ClaimRefusal } | typeof UNKNOWN> {
  const { cell, tool, body, metadata } = p;
  const human = await core.db.withTenant(
    { organizationId: cell.organizationId, userId: null },
    async (tx) => {
      const [turn] = await tx
        .select({ agentId: agentTurns.agentId, userId: agentTurns.userId })
        .from(agentTurns)
        .where(eq(agentTurns.eventId, body.eventId));
      if (turn && turn.agentId === body.agentId) return turn.userId;
      await auditUnknownTurn(tx, core, { cell, tool, reason: "unknown_turn", metadata });
      return null;
    },
  );
  if (!human) return UNKNOWN;
  return core.db.withTenant({ organizationId: cell.organizationId, userId: human }, async (tx) => {
    const turn = await liveTurn(tx, core, body);
    if (!turn || turn.userId !== human) {
      await auditUnknownTurn(tx, core, { cell, tool, reason: "unknown_turn", metadata });
      return UNKNOWN;
    }
    const inTurn = turn.tools.includes(tool);
    const claim = await claimToolCall(tx, core, {
      cell,
      turn,
      tool,
      flags: p.flags,
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: null,
      reason: inTurn ? null : "not_in_turn",
      metadata,
    });
    if (!claim.allowed) return { refused: (claim.reason ?? "cap_reached") as ClaimRefusal };
    return act(tx, turn);
  });
}

export function registerWorkZoneRoutes(scope: App, core: Core, workZone: WorkZoneProposalService): void {
  scope.post(
    "/work-zone/projects",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelWorkZoneProjects,
        response: { 200: AgentChannelWorkZoneProjectsResponse },
      },
    },
    async (req) => {
      const body = req.body;
      const out = await onTurn(
        core,
        {
          cell: cellOf(req),
          tool: PROJECTS,
          flags: PROJECTS_FLAGS,
          body,
          metadata: { eventId: body.eventId },
        },
        (tx, turn) => workZone.listProjects(tx, { turn }),
      );
      if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      if ("refused" in out) throw conflict("That tool can't be used on this turn", out.refused);
      return out;
    },
  );

  scope.post(
    "/work-zone/proposals",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelWorkZonePropose,
        response: { 200: AgentChannelWorkZoneProposeResponse },
      },
    },
    async (req) => {
      const body = req.body;
      // Ids and the prompt's length only: the prompt itself is never logged or audited.
      const metadata = {
        eventId: body.eventId,
        projectId: body.projectId,
        deviceId: body.deviceId,
        promptChars: body.prompt.length,
      };
      const out = await onTurn(
        core,
        { cell: cellOf(req), tool: START, flags: START_FLAGS, body, metadata },
        (tx, turn) => workZone.propose(tx, { turn, input: body }),
      );
      if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return out;
    },
  );
}
