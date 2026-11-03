import {
  AgentChannelAutomationPropose,
  AgentChannelAutomationProposeResponse,
  ApiError,
  BUILTIN_TOOLS,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agentTurns, orgMembers, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
// Types only: the automation module imports this module's index (run delivery), so a value import would be a cycle.
import type { AutomationProposals } from "../automation";
import { type CellPrincipal, cellOf } from "./auth";
import { auditUnknownTurn, claimToolCall, liveTurn } from "./claim";

/**
 * `POST /agent-channel/v1/automations/propose` (`ocw_automation_propose`, 07.6-12; AUTO-03, D-02, D-03, D-07): a bot
 * proposes a scheduled automation for the person of its turn. The automation module stores the draft, requests the
 * `automation.create` approval and posts the platform-owned `automation` card; nothing runs until that person confirms.
 *
 * Order: tx0 (no user) finds the turn's human in the turn ledger (RLS: another organization's event is invisible) — no
 * delivered turn of this bot → 404 `unknown_turn`; tx1 runs AS that human: the live turn (they still read its
 * conversation) → the tool on the turn (`not_in_turn`) → the claim, always side-effecting (D-02: a turn that read
 * outside content is refused 403 `tainted` before anything is stored or posted; no approval ever lifts it) → the
 * proposal. Every refusal answers `{ok: false, code, sentence}` with the model-facing sentence (UI-SPEC) and is recorded:
 * a denied `agent_tool_calls` row, or an `automation.proposal_refused` audit after the claim.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const TOOL = BUILTIN_TOOLS.automationPropose;
/** Trusted output, always side-effecting (D-02): never from a tainted turn, whatever the turn's flags say. */
const FLAGS: TurnToolFlags = { untrustedOutput: false, sideEffecting: true };
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const Refusal = z.union([AgentChannelAutomationProposeResponse, ApiError]);

/** The claim's refusals as the model reads them (the plugin answers `tainted` with the same sentence). */
const CLAIM_SENTENCES = {
  tainted: (person: string) =>
    `I can't propose an automation after reading outside content in this turn. Tell ${person} to ask again in a new message.`,
  not_in_turn: () => "Proposing automations is not available on this turn.",
  cap_reached: () => "This turn already used all its tool calls. Ask again in a new message.",
} as const;
type ClaimRefusal = keyof typeof CLAIM_SENTENCES;
type Status = 200 | 400 | 403 | 409;
const CLAIM_STATUS: Record<ClaimRefusal, Status> = { tainted: 403, not_in_turn: 403, cap_reached: 409 };

/** The status of each refusal of the proposal itself (the automation module's codes): the REST create's statuses. */
const REFUSAL_STATUS: Record<string, Status> = {
  not_allowed: 403,
  target_refused: 403,
  agent_unavailable: 403,
  invalid_cron: 400,
  invalid_time_zone: 400,
  schedule_too_frequent: 400,
  runs_per_day: 400,
  automation_cap: 409,
};

type Answer = { status: Status; body: AgentChannelAutomationProposeResponse };

async function personName(tx: Tx, userId: string): Promise<string> {
  const [m] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return m?.name ?? "the person who asked";
}

async function propose(
  core: Core,
  proposals: AutomationProposals,
  cell: CellPrincipal,
  body: AgentChannelAutomationPropose,
): Promise<Answer | null> {
  // Ids, the target kind and lengths only: never the name, the instructions or the schedule.
  const metadata = {
    eventId: body.eventId,
    targetKind: body.target.kind,
    nameChars: body.name.length,
    instructionsChars: body.instructions.length,
  };
  const human = await core.db.withTenant(
    { organizationId: cell.organizationId, userId: null },
    async (tx) => {
      const [turn] = await tx
        .select({ agentId: agentTurns.agentId, userId: agentTurns.userId })
        .from(agentTurns)
        .where(eq(agentTurns.eventId, body.eventId));
      if (turn && turn.agentId === body.agentId) return turn.userId;
      await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason: "unknown_turn", metadata });
      return null;
    },
  );
  if (!human) return null;
  return core.db.withTenant({ organizationId: cell.organizationId, userId: human }, async (tx) => {
    const turn = await liveTurn(tx, core, body);
    if (!turn || turn.userId !== human) {
      await auditUnknownTurn(tx, core, { cell, tool: TOOL, reason: "unknown_turn", metadata });
      return null;
    }
    const claim = await claimToolCall(tx, core, {
      cell,
      turn,
      tool: TOOL,
      flags: FLAGS,
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: null,
      // D-02: a turn that read outside content says so (the tool is never offered on a turn that starts tainted).
      reason: turn.tainted ? "tainted" : turn.tools.includes(TOOL) ? null : "not_in_turn",
      metadata,
    });
    if (!claim.allowed) {
      const code = (claim.reason ?? "cap_reached") as ClaimRefusal;
      const sentence = (CLAIM_SENTENCES[code] ?? CLAIM_SENTENCES.cap_reached)(await personName(tx, human));
      return { status: CLAIM_STATUS[code] ?? 409, body: { ok: false, code, sentence } };
    }
    const out = await proposals.propose(tx, { turn, input: body });
    return {
      status: out.ok ? 200 : (REFUSAL_STATUS[out.code] ?? 400),
      body: out,
    };
  });
}

export function registerAutomationProposalRoutes(
  scope: App,
  core: Core,
  proposals: AutomationProposals,
): void {
  scope.post(
    "/automations/propose",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelAutomationPropose,
        // A refusal is the model's answer; a validation or authorization error keeps the uniform error body.
        response: {
          200: AgentChannelAutomationProposeResponse,
          400: Refusal,
          403: Refusal,
          409: Refusal,
        },
      },
    },
    async (req, reply) => {
      const answer = await propose(core, proposals, cellOf(req), req.body);
      if (!answer) throw notFound(UNKNOWN_TURN, "unknown_turn");
      return reply.code(answer.status).send(answer.body);
    },
  );
}
