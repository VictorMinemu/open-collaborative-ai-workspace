import {
  AgentChannelTaskContinue,
  AgentChannelTaskContinueResponse,
  AgentChannelTaskFinish,
  AgentChannelTaskFinishResponse,
  AgentChannelTaskStart,
  AgentChannelTaskStartResponse,
  BOT_TASK_SENTENCES,
  type BotTaskRefusal,
  type BotTaskRefused,
  BotTaskStopResponse,
  BUILTIN_TOOLS,
  IdParams,
  TASK_TOOL_FLAGS,
  type TaskToolName,
} from "@ocw/contracts";
import { agentTurns, botTasks, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import { type App, authOf, type Core, tenant } from "../../core";
import { HttpError, notFound } from "../../lib/errors";
import { createConversationAccess } from "../chat";
import type { PermissionService } from "../organization";
import { type CellPrincipal, cellOf } from "./auth";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, claimToolCall, liveTurn } from "./claim";
import {
  auditTaskRefused,
  type BotTaskRow,
  continueTask,
  finishTask,
  isActiveTask,
  lockTask,
  mayStopTask,
  startTask,
  stopTask,
  type TaskAuditMetadata,
  type TaskSessionFact,
  taskOfTurn,
  taskSessionOf,
} from "./tasks";
import { judgedConversationId } from "./work-session-calls";

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
const CONTINUE = BUILTIN_TOOLS.taskContinue;
const FINISH = BUILTIN_TOOLS.taskFinish;
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const UNKNOWN: unique symbol = Symbol("unknown_turn");

const refused = (code: BotTaskRefusal): BotTaskRefused => ({
  ok: false,
  code,
  sentence: BOT_TASK_SENTENCES[code],
});

/** The tool is on the turn, and the turn is not an AI chat's (D-10: never a task there, whatever the ledger says). */
const offered = (turn: AgentTurnRow, tool: TaskToolName): boolean =>
  turn.conversationKind !== "ai_chat" && turn.tools.includes(tool);

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
      /** Counts and kinds of the call (P1: never the goal, a note or the summary). */
      extra?: TaskAuditMetadata;
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
      metadata: { eventId: p.turn.eventId, ...(p.task ? { taskId: p.task } : {}), ...p.extra },
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
   * The two transactions every task call opens (above): `prefetch` runs in tx0 (user-less reads the person could not
   * make, e.g. a bot Work Zone session's state), `decide` in tx1 on the live turn; an unknown or no longer live turn
   * answers 404 `unknown_turn`.
   */
  async function onTurn<R, F = null>(
    cell: CellPrincipal,
    body: { eventId: string; agentId: string },
    tool: TaskToolName,
    decide: (tx: Tx, turn: AgentTurnRow, fetched: F | null) => Promise<R>,
    prefetch?: (tx: Tx) => Promise<F | null>,
  ): Promise<R> {
    const metadata = { eventId: body.eventId };
    const unknownTurn = async (tx: Tx): Promise<typeof UNKNOWN> => {
      await auditUnknownTurn(tx, core, { cell, tool, reason: "unknown_turn", metadata });
      return UNKNOWN;
    };
    const found = await core.db.withTenant(
      { organizationId: cell.organizationId, userId: null },
      async (tx): Promise<{ userId: string; fetched: F | null } | typeof UNKNOWN> => {
        const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
        if (!turn || turn.agentId !== body.agentId) return unknownTurn(tx);
        return { userId: turn.userId, fetched: prefetch ? await prefetch(tx) : null };
      },
    );
    if (found === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
    const out = await core.db.withTenant(
      { organizationId: cell.organizationId, userId: found.userId },
      async (tx): Promise<R | typeof UNKNOWN> => {
        const turn = await liveTurn(tx, core, body);
        if (!turn) return unknownTurn(tx);
        return decide(tx, turn, found.fetched);
      },
    );
    if (out === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
    return out;
  }

  /**
   * The checks of a continue or finish (PD-05, PD-08), in order: the tool on the turn (`not_in_turn`), the turn's task
   * (`no_task`), under its lock: ended (`task_stopped`), another person's (`not_requester`), and the busy rule (one
   * execution authority: while the task runs, only its current turn controls it; while it waits, its requester's turns
   * may, `task_busy`). The locked row, or the recorded refusal.
   */
  async function control(
    tx: Tx,
    base: { cell: CellPrincipal; turn: AgentTurnRow; tool: TaskToolName },
  ): Promise<{ task: BotTaskRow } | { refusal: BotTaskRefused }> {
    const { turn } = base;
    const no = async (code: BotTaskRefusal, task: Pick<BotTaskRow, "id"> | null) => ({
      refusal: await refuse(tx, { ...base, code, task }),
    });
    if (!offered(turn, base.tool)) return no("not_in_turn", null);
    const linked = await taskOfTurn(tx, turn.eventId);
    const task = linked ? await lockTask(tx, linked.id) : null;
    if (!task) return no("no_task", null);
    if (!isActiveTask(task)) return no("task_stopped", task);
    if (task.requesterUserId !== turn.userId || task.agentId !== turn.agentId)
      return no("not_requester", task);
    if (task.status === "running" && task.currentEventId !== turn.eventId) return no("task_busy", task);
    return { task };
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
        if (!offered(turn, START)) return refuse(tx, { ...base, code: "not_in_turn", task: null });
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

  scope.post(
    "/tasks/continue",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelTaskContinue,
        response: { 200: AgentChannelTaskContinueResponse },
      },
    },
    async (req): Promise<AgentChannelTaskContinueResponse> => {
      const cell = cellOf(req);
      const body = req.body;
      const sessionId = body.waitFor && "workSessionId" in body.waitFor ? body.waitFor.workSessionId : null;
      return onTurn<AgentChannelTaskContinueResponse, TaskSessionFact>(
        cell,
        body,
        CONTINUE,
        async (tx, turn, session) => {
          const base = { cell, turn, tool: CONTINUE } as const;
          const checked = await control(tx, base);
          if ("refusal" in checked) return checked.refusal;
          const out = await continueTask(tx, core, checked.task, {
            turn,
            progress: body.progress,
            nextStep: body.nextStep,
            afterSeconds: body.afterSeconds,
            waitFor: body.waitFor,
            session,
            auditBase: cellAuditBase(cell),
          });
          if (!out.ok) return refuse(tx, { ...base, code: out.code, task: checked.task });
          await claim(tx, {
            ...base,
            task: out.task.id,
            reason: null,
            extra: {
              turnsUsed: out.task.turnsUsed,
              maxTurns: out.task.maxTurns,
              ...(out.task.waitKind ? { waitKind: out.task.waitKind } : {}),
            },
          });
          return { ok: true, next: out.next, at: out.at, turnsLeft: out.turnsLeft, quiet: out.quiet };
        },
        sessionId ? (tx) => taskSessionOf(tx, sessionId) : undefined,
      );
    },
  );

  scope.post(
    "/tasks/finish",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelTaskFinish,
        response: { 200: AgentChannelTaskFinishResponse },
      },
    },
    async (req): Promise<AgentChannelTaskFinishResponse> => {
      const cell = cellOf(req);
      const body = req.body;
      return onTurn(cell, body, FINISH, async (tx, turn): Promise<AgentChannelTaskFinishResponse> => {
        const base = { cell, turn, tool: FINISH } as const;
        const checked = await control(tx, base);
        if ("refusal" in checked) return checked.refusal;
        const ended = await finishTask(tx, core, checked.task, {
          turn,
          summary: body.summary,
          outcome: body.outcome,
          auditBase: cellAuditBase(cell),
        });
        // The row was locked active above: it cannot have ended in between.
        if (!ended) throw new Error("bot task ended under its lock");
        await claim(tx, {
          ...base,
          task: ended.id,
          reason: null,
          extra: { outcome: body.outcome, turnsUsed: ended.turnsUsed, maxTurns: ended.maxTurns },
        });
        return { ok: true, status: ended.status === "done" ? "done" : "failed" };
      });
    },
  );
}

const TASK_NOT_FOUND = "Task not found";

/**
 * Stop (PD-12; D-05, D-07; ADR-0027's rule, the cell has no abort): `POST /api/v1/bot-tasks/{id}/stop`, a signed-in person
 * stops a bot's long task. A task of a conversation the caller cannot read, of another organization (RLS) or that does
 * not exist is 404 `task_not_found` (existence hidden); a reader who is not the person it runs for, a moderator of its
 * channel or a manager of the bot (`mayStopTask`) is refused 403 `not_task_owner`. Then, under the row lock: an ended
 * task answers its status and writes nothing more (idempotent); an active one is stopped (`stopped_by_person`, one
 * `bot.task_stopped` with the person as actor, the card "Stopped by <name>.", no thread message: the person acted). The
 * in-flight turn finishes and its later continue answers `task_stopped`; no further turn is delivered.
 */
export function registerTaskUserRoutes(app: App, core: Core, deps: { perms: PermissionService }): void {
  app.register(
    async (raw) => {
      // Child scopes lose the Zod type provider in their inferred type; restore it.
      const scope = raw as unknown as App;
      scope.post(
        "/bot-tasks/:id/stop",
        {
          config: { authz: "user" as const },
          preHandler: core.identity.requireUser,
          schema: { tags, params: IdParams, response: { 200: BotTaskStopResponse } },
        },
        async (req): Promise<BotTaskStopResponse> =>
          core.db.withTenant(tenant(req), async (tx) => {
            const { userId } = authOf(req);
            const [found] = await tx.select().from(botTasks).where(eq(botTasks.id, req.params.id)).limit(1);
            if (!found) throw notFound(TASK_NOT_FOUND, "task_not_found");
            // The resolver, for this request: the caller reads the task's conversation (a thread through its
            // channel), else the task does not exist for them.
            const judged = await judgedConversationId(tx, found.conversationId);
            try {
              await createConversationAccess(core).readable(req, tx, judged, {
                kinds: ["channel", "dm", "group"],
                notFoundMessage: TASK_NOT_FOUND,
              });
            } catch (err) {
              if (err instanceof HttpError && err.statusCode === 404) {
                throw notFound(TASK_NOT_FOUND, "task_not_found");
              }
              throw err;
            }
            if (!(await mayStopTask(tx, core, deps.perms, found, userId))) {
              throw new HttpError(
                403,
                "not_task_owner",
                "Only the person this task runs for, a channel moderator or the bot's manager can stop it",
              );
            }
            const task = await lockTask(tx, found.id);
            if (!task) throw notFound(TASK_NOT_FOUND, "task_not_found");
            if (!isActiveTask(task)) return { ok: true, status: task.status };
            const stopped = await stopTask(tx, core, task, "stopped_by_person", {
              byUserId: userId,
              notify: false,
            });
            return { ok: true, status: stopped?.status ?? task.status };
          }),
      );
    },
    { prefix: "/api/v1" },
  );
}
