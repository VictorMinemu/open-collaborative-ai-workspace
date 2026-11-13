import {
  AgentChannelTaskStart,
  AgentChannelTaskStartResponse,
  BOT_TASK_SENTENCES,
  type BotTaskRefusal,
  type BotTaskRefused,
  BUILTIN_TOOLS,
  TASK_TOOL_FLAGS,
  type TaskToolName,
} from "@ocw/contracts";
import { agentTurns, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
import { type CellPrincipal, cellOf } from "./auth";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, claimToolCall, liveTurn } from "./claim";
import { auditTaskRefused, type BotTaskRow, startTask } from "./tasks";

/**
 * Phase 07.17.1.1.2 (D-01, D-02, D-04, D-05, D-07, D-13; PD-05, PD-08 … PD-12, PD-18, PD-19; ADR-0042): the long task's
 * routes. The cell's three (`POST /agent-channel/v1/tasks/start|continue|finish`, the plugin's `ocw_task_*`) name the
 * turn, the bot and the bot's own text only (strict bodies: never a person, a conversation, a budget or a time, P6);
 * everything else comes from the stored turn and the task row under its lock (P3).
 *
 * Order of each cell call (PD-08, the 07.16 two-transaction pattern):
 * - tx0, user-less: the delivered turn of THIS bot in the cell's organization (RLS hides another organization's), else
 *   404 `unknown_turn`, recorded by `auditUnknownTurn`.
 * - tx1, AS the turn's person: the live turn (the person still reads the conversation, else 404) → the tool on the turn
 *   (`not_in_turn`) → the task and its checks → the claim (`TASK_TOOL_FLAGS`, outside the cap of 8, never counted,
 *   D-13) → the state change, the card, the job and the audit → the answer.
 *
 * A refusal is a denied `agent_tool_calls` row (the turn is not counted), its `bot.tool_call` audit and one
 * `bot.task_refused` (ids and the code), answered 200 `{ ok: false, code, sentence }` with the fixed sentence.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const START = BUILTIN_TOOLS.taskStart;
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const UNKNOWN: unique symbol = Symbol("unknown_turn");

const refused = (code: BotTaskRefusal): BotTaskRefused => ({
  ok: false,
  code,
  sentence: BOT_TASK_SENTENCES[code],
});

export function registerTaskRoutes(scope: App, core: Core): void {
  /** The claim of a task call: recorded and audited, outside the cap of 8; `reason` set = a refusal. */
  async function claim(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      tool: TaskToolName;
      task: string | null;
      reason: string | null;
    },
  ): Promise<void> {
    const claimed = await claimToolCall(tx, core, {
      cell: p.cell,
      turn: p.turn,
      tool: p.tool,
      flags: TASK_TOOL_FLAGS[p.tool],
      web: false,
      sourceKind: "builtin",
      sourceId: null,
      target: p.task,
      reason: p.reason,
      countCall: false,
      uncapped: true,
      // Ids only (P1): never the goal, a note or the summary.
      metadata: { eventId: p.turn.eventId, ...(p.task ? { taskId: p.task } : {}) },
    });
    // An uncapped, non-side-effecting claim always passes: anything else is a bug, never a silent allow.
    if (p.reason === null && !claimed.allowed) throw new Error(`task claim refused: ${claimed.reason}`);
  }

  /** A refusal decided before the claim: the denied row, `bot.task_refused` and the fixed answer. */
  async function refuse(
    tx: Tx,
    p: {
      cell: CellPrincipal;
      turn: AgentTurnRow;
      tool: TaskToolName;
      code: BotTaskRefusal;
      task: Pick<BotTaskRow, "id"> | null;
    },
  ): Promise<BotTaskRefused> {
    await claim(tx, { ...p, task: p.task?.id ?? null, reason: p.code });
    await auditTaskRefused(tx, core, {
      auditBase: cellAuditBase(p.cell),
      turn: p.turn,
      tool: p.tool,
      code: p.code,
      task: p.task,
    });
    return refused(p.code);
  }

  /**
   * The two transactions every task call opens (above): `decide` runs in tx1 on the live turn; an unknown or no longer
   * live turn answers 404 `unknown_turn`.
   */
  async function onTurn<R>(
    cell: CellPrincipal,
    body: { eventId: string; agentId: string },
    tool: TaskToolName,
    decide: (tx: Tx, turn: AgentTurnRow) => Promise<R>,
  ): Promise<R> {
    const metadata = { eventId: body.eventId };
    const unknownTurn = async (tx: Tx): Promise<typeof UNKNOWN> => {
      await auditUnknownTurn(tx, core, { cell, tool, reason: "unknown_turn", metadata });
      return UNKNOWN;
    };
    const userId = await core.db.withTenant(
      { organizationId: cell.organizationId, userId: null },
      async (tx): Promise<string | typeof UNKNOWN> => {
        const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
        if (!turn || turn.agentId !== body.agentId) return unknownTurn(tx);
        return turn.userId;
      },
    );
    if (userId === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
    const out = await core.db.withTenant(
      { organizationId: cell.organizationId, userId },
      async (tx): Promise<R | typeof UNKNOWN> => {
        const turn = await liveTurn(tx, core, body);
        if (!turn) return unknownTurn(tx);
        return decide(tx, turn);
      },
    );
    if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
    return out;
  }

  scope.post(
    "/tasks/start",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelTaskStart,
        response: { 200: AgentChannelTaskStartResponse },
      },
    },
    async (req): Promise<AgentChannelTaskStartResponse> => {
      const cell = cellOf(req);
      const body = req.body;
      return onTurn(cell, body, START, async (tx, turn): Promise<AgentChannelTaskStartResponse> => {
        const base = { cell, turn, tool: START } as const;
        if (!turn.tools.includes(START)) return refuse(tx, { ...base, code: "not_in_turn", task: null });
        const started = await startTask(tx, core, { turn, goal: body.goal, auditBase: cellAuditBase(cell) });
        if (!started.ok) return refuse(tx, { ...base, code: started.code, task: started.task });
        await claim(tx, { ...base, task: started.task.id, reason: null });
        return {
          ok: true,
          taskId: started.task.id,
          maxTurns: started.task.maxTurns,
          deadlineAt: new Date(started.task.deadlineAt).toISOString(),
        };
      });
    },
  );
}
