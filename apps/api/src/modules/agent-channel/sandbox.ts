import {
  AgentChannelSandboxExec,
  AgentChannelSandboxExecResponse,
  BUILTIN_TOOLS,
  CONFINED_TOOL_FLAGS,
  type ConfinedToolName,
  MAX_SANDBOX_CALLS_PER_TURN,
  SANDBOX_LIMITS,
  SANDBOX_REFUSAL_STATUS,
  type SandboxdErrorCode,
  type SandboxRefusal,
  type SandboxRuntime,
  type ToolApprovalRefusal,
} from "@ocw/contracts";
import { agentToolCalls, agentTurns, type Tx } from "@ocw/db";
import { and, eq, lt, type SQL, sql } from "drizzle-orm";
import type { App, Core } from "../../core";
import { HttpError } from "../../lib/errors";
import type { PermissionService } from "../organization";
import {
  type ConfinedKind,
  markState,
  reserveSandbox,
  type SandboxContainer,
  type SandboxdClient,
  SandboxdRefusedError,
  sandboxAvailable,
  touchSandbox,
} from "../sandbox";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, liveTurn } from "./claim";
import { APPROVAL_MESSAGES, approvalDetails, approvalVerdict, type ToolApprovalGate } from "./tool-calls";

/**
 * The bots' sandbox routes of the Agent Channel (07.8-05; SBX-02, SBX-04; D-02 (b), D-03, D-09, D-11 F-7, D-12; P-04,
 * P-06, P-07). `POST /agent-channel/v1/sandbox/exec` runs an argv array in the bot's own sandbox. Plans 10 and 14 add
 * the file, process and browser routes here, every one through `decideSandboxCall`.
 *
 * Order (refusals before sandboxd are recorded in `agent_tool_calls` and audited `bot.tool_call`; nothing calls out in
 * a transaction):
 *   1. tx0 (no user): the turn's human, from the turn ledger; no such turn of this agent → 403 `no_trigger`;
 *   2. tx1, AS that human (every id resolved in the cell's tenant), `decideSandboxCall`:
 *      the live turn (the human still reads the conversation, else 403 `no_trigger`) → the availability, re-decided now
 *      (`sandboxAvailable`: the resolver's `sandbox.use` for agent ∩ human → `not_allowed`; the organization switch →
 *      `sandbox_off`; the kill switch → `killed`; the bot's switch → `bot_off`) → the tool on the turn
 *      (`policy_changed`) → the service configured (`service_unavailable`) → the per-turn budget under the turn row
 *      lock (`budget_exhausted`, 40 calls, separate from the 8-call cap) → the organization cap under its advisory lock
 *      (`cap_reached`, checked before the approval so a consumed grant is never wasted) → 07.5 `approvalForCall` with
 *      the canonical arguments (`approval_required` … with `details`) → the slot taken (`starting`) → the claim: ONE
 *      conditional UPDATE counts `sandbox_calls` and taints the turn (exec output is untrusted);
 *   3. outside any tx: sandboxd `ensure` (only when the bot's container is not running) and `exec`;
 *   4. tx2 (as the human): the call's status and duration, the container's state, and one `sandbox.exec` audit with
 *      the event, exit code, duration and status only (never the argv, the working folder or any output).
 *
 * Status mapping (ledger, WINDOWS #233): every `SandboxRefusal` answers `SANDBOX_REFUSAL_STATUS`, the contract's one
 * table: 403 for decisions (switches, resolver, kill, budget, cap, taint, and `no_trigger` as on every Agent Channel
 * route), 404 for no such thing, 409 for approvals and state, 503 when sandboxd is unavailable. The 07.4 connector and
 * keychain routes keep answering 409 for `cap_reached` and `tainted` (unchanged, shipped behaviour). The two approval codes outside `SandboxRefusal` (`arguments_too_large`, `arguments_invalid`) answer 409 as on the
 * 07.5 proxy routes. The plugin keys on the code, never on the status.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const EXEC = BUILTIN_TOOLS.sandboxExec;
/** Default deadline of one command when the bot names none. */
const DEFAULT_EXEC_TIMEOUT_SECONDS = 120;
/** How much longer than the yield the API waits for sandboxd's answer. */
const EXEC_ANSWER_MARGIN_MS = 15_000;
const ENSURE_TIMEOUT_MS = 60_000;

/** Every code a sandbox call can be refused with. */
export type SandboxCallRefusal =
  | SandboxRefusal
  | Extract<ToolApprovalRefusal, "arguments_too_large" | "arguments_invalid">;

const MESSAGES: Record<SandboxCallRefusal, string> = {
  ...APPROVAL_MESSAGES,
  no_trigger: "This call does not answer a delivered turn of this agent",
  sandbox_off: "Sandbox & Browser is off for this organization",
  module_off: "The Sandbox module is off for this person",
  bot_off: "The sandbox is off for this bot",
  not_allowed: "This bot may not use its sandbox for this person",
  killed: "An admin stopped every sandbox of this organization",
  cap_reached: "The organization runs as many sandboxes as it allows",
  cpu_budget: "The organization used its sandbox CPU time for today",
  disk_full: "The bot's workspace is full",
  budget_exhausted: "This turn used all of its sandbox calls",
  tainted: "This turn read untrusted content and can no longer make changes",
  member_data: "This turn used a member's sign-in and can no longer do that",
  audience_narrower: "That file is shared with fewer people than the workspace",
  policy_changed: "That tool is no longer available on this turn",
  service_unavailable: "The sandbox service is not available",
  timeout: "The sandbox did not answer in time",
  not_found: "Not found in the sandbox",
  too_large: "Too large for the sandbox",
  invalid_path: "That path is not inside the workspace",
  busy: "The sandbox is busy",
};

const statusOf = (code: SandboxCallRefusal): number =>
  code in SANDBOX_REFUSAL_STATUS ? SANDBOX_REFUSAL_STATUS[code as SandboxRefusal] : 409;

/** A refusal as the HTTP error the plugin reads (`code`, fixed message, optional approval `details`). */
export function sandboxRefusal(code: SandboxCallRefusal, details?: Record<string, unknown>): HttpError {
  return new HttpError(statusOf(code), code, MESSAGES[code], details);
}

/** sandboxd's refusal of a decided call → the code the bot gets (anything unexpected is the service failing). */
function refusalOfSandboxd(code: SandboxdErrorCode): SandboxRefusal {
  switch (code) {
    case "disk_full":
    case "busy":
    case "invalid_path":
    case "too_large":
    case "timeout":
    case "killed":
    case "not_found":
      return code;
    case "limit_reached":
      return "cap_reached";
    default:
      return "service_unavailable";
  }
}

export interface SandboxCallDeps {
  core: Core;
  perms: Pick<PermissionService, "decide">;
  toolApproval: ToolApprovalGate;
  /** sandboxd is configured (`OCW_SANDBOX_URL`); without it every call is `service_unavailable`. */
  configured: boolean;
  cell: CellPrincipal;
}

export interface SandboxClaim {
  /** The `agent_tool_calls` row of this call. */
  callId: string;
  /** The bot's container is not running: ask sandboxd to `ensure` it first. */
  ensure: boolean;
  /** The approval whose grant this call consumed, if any. */
  approvalId: string | null;
}

export type SandboxDecision =
  | { ok: true; claim: SandboxClaim }
  | { ok: false; reason: SandboxCallRefusal; details?: Record<string, unknown> };

/** One `agent_tool_calls` row and its `bot.tool_call` audit (ids, tool and reason only; never the arguments). */
async function recordCall(
  tx: Tx,
  core: Core,
  p: {
    cell: CellPrincipal;
    turn: AgentTurnRow;
    tool: string;
    reason: SandboxCallRefusal | null;
    approvalId: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<string> {
  const [row] = await tx
    .insert(agentToolCalls)
    .values({
      organizationId: p.turn.organizationId,
      eventId: p.turn.eventId,
      agentId: p.turn.agentId,
      userId: p.turn.userId,
      tool: p.tool,
      sourceKind: "builtin",
      sourceId: null,
      target: "sandbox",
      decision: p.reason ? "denied" : "allowed",
      reason: p.reason,
      approvalId: p.approvalId,
    })
    .returning({ id: agentToolCalls.id });
  if (!row) throw new Error("agent_tool_calls insert failed");
  await core.audit.record(tx, {
    ...cellAuditBase(p.cell),
    action: "bot.tool_call",
    actorKind: "agent",
    actorId: p.turn.agentId,
    agentId: p.turn.agentId,
    userId: p.turn.userId,
    resourceType: "tool",
    resourceId: p.tool,
    result: p.reason ? "denied" : "success",
    metadata: {
      tool: p.tool,
      sourceKind: "builtin",
      sourceId: null,
      target: "sandbox",
      reason: p.reason,
      eventId: p.turn.eventId,
      ...p.metadata,
      ...(p.approvalId ? { approvalId: p.approvalId, grant: true } : {}),
    },
  });
  return row.id;
}

/**
 * The one decision of every confined tool call (exec here; files in 10, browser in 14), inside the caller's
 * transaction opened AS the turn's human, after the live turn was found. See the file comment for the order. A
 * refusal is recorded and audited here; an allowed call is claimed (budget counted, turn tainted when the tool's output
 * is untrusted, the container's cap slot taken) and the caller calls sandboxd after the commit.
 */
export async function decideSandboxCall(
  tx: Tx,
  deps: SandboxCallDeps,
  p: {
    turn: AgentTurnRow;
    tool: ConfinedToolName;
    /** The call's canonical arguments for `approvalForCall` (what a person approves; never stored elsewhere). */
    args: Record<string, unknown>;
    toolCallId: string | null;
    kind: ConfinedKind;
  },
): Promise<SandboxDecision> {
  const { turn } = p;
  const container: SandboxContainer = p.kind === "sandbox" ? "sbx" : "brw";
  const flags = CONFINED_TOOL_FLAGS[p.tool];
  const meta = { kind: p.kind };
  const refuse = async (
    reason: SandboxCallRefusal,
    extra: { details?: Record<string, unknown>; metadata?: Record<string, unknown> } = {},
  ): Promise<SandboxDecision> => {
    await recordCall(tx, deps.core, {
      cell: deps.cell,
      turn,
      tool: p.tool,
      reason,
      approvalId: null,
      metadata: { ...meta, ...extra.metadata },
    });
    return { ok: false, reason, ...(extra.details ? { details: extra.details } : {}) };
  };

  const available = await sandboxAvailable(
    tx,
    deps.perms,
    { agentId: turn.agentId, userId: turn.userId },
    p.kind,
  );
  if (!available.ok) return refuse(available.reason);
  if (!turn.tools.includes(p.tool)) return refuse("policy_changed");
  if (!deps.configured) return refuse("service_unavailable");

  // The per-turn budget, under the turn row lock (the claim below re-checks it in its UPDATE).
  const [locked] = await tx
    .select({ sandboxCalls: agentTurns.sandboxCalls })
    .from(agentTurns)
    .where(eq(agentTurns.eventId, turn.eventId))
    .for("update");
  if (!locked || locked.sandboxCalls >= MAX_SANDBOX_CALLS_PER_TURN) return refuse("budget_exhausted");

  // The organization cap before the approval: a grant consumed by a call the cap then refuses is never given back.
  // The advisory lock taken here is held until commit, so the reservation below cannot fail.
  const cap = await reserveSandbox(tx, { agentId: turn.agentId }, container, { dryRun: true });
  if (!cap.ok) return refuse(cap.reason);

  const verdict = approvalVerdict(
    await deps.toolApproval.approvalForCall(tx, {
      turn: { eventId: turn.eventId, agentId: turn.agentId },
      tool: p.tool,
      args: p.args,
      toolCallId: p.toolCallId,
      source: { kind: "builtin", id: null, target: "sandbox" },
    }),
  );
  if (verdict.reason) {
    return refuse(verdict.reason, { details: approvalDetails(verdict), metadata: verdict.metadata });
  }

  const reserved = await reserveSandbox(tx, { agentId: turn.agentId }, container);
  if (!reserved.ok) return refuse(reserved.reason);

  // The claim: the budget and the taint in ONE conditional UPDATE (race-free on the row lock).
  const conditions: Array<SQL | undefined> = [
    eq(agentTurns.eventId, turn.eventId),
    lt(agentTurns.sandboxCalls, MAX_SANDBOX_CALLS_PER_TURN),
    flags.sideEffecting && !verdict.grantApprovalId ? eq(agentTurns.tainted, false) : undefined,
  ];
  const updated = await tx
    .update(agentTurns)
    .set({
      sandboxCalls: sql`${agentTurns.sandboxCalls} + 1`,
      tainted: flags.untrustedOutput ? true : sql`${agentTurns.tainted}`,
    })
    .where(and(...conditions))
    .returning({ eventId: agentTurns.eventId });
  if (updated.length === 0) {
    const [after] = await tx
      .select({ tainted: agentTurns.tainted })
      .from(agentTurns)
      .where(eq(agentTurns.eventId, turn.eventId));
    return refuse(flags.sideEffecting && after?.tainted ? "tainted" : "budget_exhausted");
  }
  const callId = await recordCall(tx, deps.core, {
    cell: deps.cell,
    turn,
    tool: p.tool,
    reason: null,
    approvalId: verdict.grantApprovalId,
    metadata: meta,
  });
  return { ok: true, claim: { callId, ensure: reserved.ensure, approvalId: verdict.grantApprovalId } };
}

/**
 * The turn's human for a cell call, from the turn ledger in a user-less transaction (no session user is ever taken
 * from the request); an unknown or foreign turn is audited and answered 403 `no_trigger`.
 */
export async function turnHumanOf(
  core: Core,
  cell: CellPrincipal,
  p: { eventId: string; agentId: string; tool: string },
): Promise<string> {
  const human = await core.db.withTenant(
    { organizationId: cell.organizationId, userId: null },
    async (tx) => {
      const [turn] = await tx
        .select({ agentId: agentTurns.agentId, userId: agentTurns.userId })
        .from(agentTurns)
        .where(eq(agentTurns.eventId, p.eventId));
      if (turn && turn.agentId === p.agentId) return turn.userId;
      await auditUnknownTurn(tx, core, {
        cell,
        tool: p.tool,
        reason: "no_trigger",
        metadata: { eventId: p.eventId },
      });
      return null;
    },
  );
  if (!human) throw noTrigger();
  return human;
}

/**
 * The outcome of a call that went to sandboxd: the ledger row's status and duration, the container marked used, and
 * one `sandbox.<verb>` audit (ids, codes, counts and durations only).
 */
export async function finishSandboxCall(
  tx: Tx,
  core: Core,
  p: {
    cell: CellPrincipal;
    turn: AgentTurnRow;
    callId: string;
    action: string;
    status: "ok" | "error";
    durationMs: number;
    container: SandboxContainer;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const durationMs = Math.max(0, Math.trunc(p.durationMs));
  await tx
    .update(agentToolCalls)
    .set({ status: p.status, durationMs, completedAt: new Date().toISOString() })
    .where(and(eq(agentToolCalls.id, p.callId), eq(agentToolCalls.decision, "allowed")));
  if (p.status === "ok") await touchSandbox(tx, { agentId: p.turn.agentId, kind: p.container });
  await core.audit.record(tx, {
    ...cellAuditBase(p.cell),
    action: p.action,
    actorKind: "agent",
    actorId: p.turn.agentId,
    agentId: p.turn.agentId,
    userId: p.turn.userId,
    resourceType: "agent",
    resourceId: p.turn.agentId,
    result: p.status === "ok" ? "success" : "error",
    metadata: { eventId: p.turn.eventId, durationMs, ...p.metadata },
  });
}

/**
 * What the API records about the bot's container after a call: running once sandboxd ensured it; unavailable when the
 * service failed; `disk_full` when sandboxd said so; nothing otherwise. A `starting` slot taken by the decision is
 * always released by one of these (so a failed start never holds the organization's cap).
 */
export function containerStateAfter(p: {
  reserved: boolean;
  ensured: boolean;
  failure: SandboxRefusal | null;
}): {
  state: "running" | "unavailable" | "disk_full";
  stopReason: "service_down" | "disk_full" | null;
} | null {
  if (p.failure === "service_unavailable") return { state: "unavailable", stopReason: "service_down" };
  if (p.failure === "disk_full") return { state: "disk_full", stopReason: "disk_full" };
  if (p.ensured) return { state: "running", stopReason: null };
  if (p.reserved) return { state: "unavailable", stopReason: "service_down" };
  return null;
}

export function registerSandboxRoutes(
  scope: App,
  core: Core,
  deps: {
    perms: Pick<PermissionService, "decide">;
    toolApproval: ToolApprovalGate;
    client: SandboxdClient | null;
  },
): void {
  scope.post(
    "/sandbox/exec",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelSandboxExec,
        response: { 200: AgentChannelSandboxExecResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      const humanUserId = await turnHumanOf(core, cell, { ...body, tool: EXEC });

      // 2. Decided as that human, in one short transaction without any outbound call.
      const decided = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: humanUserId },
        async (tx) => {
          const turn = await liveTurn(tx, core, body);
          if (!turn || turn.userId !== humanUserId) {
            await auditUnknownTurn(tx, core, {
              cell,
              tool: EXEC,
              reason: "no_trigger",
              metadata: { eventId: body.eventId },
            });
            return null;
          }
          const decision = await decideSandboxCall(
            tx,
            {
              core,
              perms: deps.perms,
              toolApproval: deps.toolApproval,
              configured: deps.client !== null,
              cell,
            },
            {
              turn,
              tool: EXEC,
              // The canonical action a person approves: exactly what runs.
              args: {
                argv: body.argv,
                ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
                ...(body.timeoutSeconds !== undefined ? { timeoutSeconds: body.timeoutSeconds } : {}),
                ...(body.background !== undefined ? { background: body.background } : {}),
              },
              toolCallId: null,
              kind: "sandbox",
            },
          );
          return { turn, decision };
        },
      );
      if (!decided) throw noTrigger();
      const { turn, decision } = decided;
      if (!decision.ok) throw sandboxRefusal(decision.reason, decision.details);
      const client = deps.client;
      if (!client) throw sandboxRefusal("service_unavailable");

      // 3. sandboxd, outside any transaction.
      const target = { orgId: cell.organizationId, agentId: turn.agentId };
      const yieldMs = body.background ? 0 : SANDBOX_LIMITS.execYieldMs;
      const execInput = {
        target,
        argv: body.argv,
        cwd: body.cwd ?? "",
        timeoutMs: (body.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS) * 1000,
        yieldMs,
      };
      const started = Date.now();
      const box: { ensured: boolean; runtime: SandboxRuntime | null } = { ensured: false, runtime: null };
      const ensure = async () => {
        const status = await client.call("ensure", { target }, { timeoutMs: ENSURE_TIMEOUT_MS });
        box.ensured = true;
        box.runtime = status.runtime;
      };
      let result: AgentChannelSandboxExecResponse | null = null;
      let failure: SandboxRefusal | null = null;
      try {
        if (decision.claim.ensure) await ensure();
        try {
          result = await client.call("exec", execInput, { timeoutMs: yieldMs + EXEC_ANSWER_MARGIN_MS });
        } catch (err) {
          // The container went away behind the API's back (idle stop, a restart): ensure it once and retry.
          const gone =
            err instanceof SandboxdRefusedError && (err.code === "not_found" || err.code === "killed");
          if (!gone || box.ensured) throw err;
          await ensure();
          result = await client.call("exec", execInput, { timeoutMs: yieldMs + EXEC_ANSWER_MARGIN_MS });
        }
      } catch (err) {
        // Codes only: the error never names the argv, and it is never logged with a body.
        failure = err instanceof SandboxdRefusedError ? refusalOfSandboxd(err.code) : "service_unavailable";
      }
      const durationMs = Date.now() - started;

      // 4. The outcome, audited with ids, exit code, duration and status only.
      await core.db.withTenant({ organizationId: cell.organizationId, userId: humanUserId }, async (tx) => {
        const after = containerStateAfter({ reserved: decision.claim.ensure, ensured: box.ensured, failure });
        if (after) {
          await markState(tx, {
            agentId: turn.agentId,
            kind: "sbx",
            state: after.state,
            stopReason: after.stopReason,
            ...(after.state === "running" ? { runtime: box.runtime, active: true } : {}),
          });
        }
        await finishSandboxCall(tx, core, {
          cell,
          turn,
          callId: decision.claim.callId,
          action: "sandbox.exec",
          status: result ? "ok" : "error",
          durationMs,
          container: "sbx",
          metadata: {
            status: result?.status ?? "error",
            exitCode: result?.status === "exited" ? result.exitCode : null,
            ...(failure ? { reason: failure } : {}),
          },
        });
      });
      if (!result) throw sandboxRefusal(failure ?? "service_unavailable");
      return result;
    },
  );
}
