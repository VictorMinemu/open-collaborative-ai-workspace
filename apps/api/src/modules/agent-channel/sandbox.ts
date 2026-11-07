import {
  AgentChannelSandboxDelete,
  AgentChannelSandboxDeleteResponse,
  AgentChannelSandboxExec,
  AgentChannelSandboxExecResponse,
  AgentChannelSandboxImport,
  AgentChannelSandboxImportResponse,
  AgentChannelSandboxList,
  AgentChannelSandboxProcess,
  AgentChannelSandboxRead,
  AgentChannelSandboxReadResponse,
  AgentChannelSandboxShare,
  AgentChannelSandboxShareResponse,
  AgentChannelSandboxWrite,
  AgentChannelSandboxWriteResponse,
  type BrowserRefusal,
  BUILTIN_TOOLS,
  CONFINED_TOOL_FLAGS,
  type ConfinedToolName,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_SANDBOX_CALLS_PER_TURN,
  SANDBOX_LIMITS,
  SANDBOX_REFUSAL_STATUS,
  SANDBOX_TIMEOUTS_MS,
  type SandboxdErrorCode,
  type SandboxdTarget,
  type SandboxFileEntry,
  SandboxFileList,
  SandboxFilePath,
  type SandboxRefusal,
  SandboxRelativePath,
  type SandboxRuntime,
  type SandboxToolName,
  sanitizeFilename,
  TOOL_APPROVAL_LIMITS,
  type ToolApprovalRefusal,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agentToolCalls, agentTurns, type Tx, withSavepoint } from "@ocw/db";
import { and, eq, lt, type SQL, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { App, Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import {
  type AttachmentRow,
  AttachmentTooLargeError,
  createObjectStorage,
  pendingTurnAttachmentCount,
  readAttachmentBytes,
  storeServerAttachment,
} from "../artifact";
import { createConversationAccess } from "../chat";
import { audienceCoverFacts, audienceCovers, type PermissionService } from "../organization";
import {
  type ConfinedKind,
  ensureSandbox,
  loadSandboxBot,
  loadSandboxPolicy,
  markState,
  reserveSandbox,
  type SandboxContainer,
  type SandboxdCallOptions,
  type SandboxdClient,
  SandboxdRefusedError,
  sandboxAvailable,
  touchSandbox,
} from "../sandbox";
import { approvalMessageRouteOf } from "../tool-approval";
import { recordStep, type StepOutcomeInput, stepFor } from "./activity";
import { attachmentForTurn } from "./attachment-access";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, liveTurn, taintReturnTurns } from "./claim";
import { APPROVAL_MESSAGES, approvalDetails, approvalVerdict, type ToolApprovalGate } from "./tool-calls";

/**
 * The bots' sandbox routes of the Agent Channel (07.8-05; SBX-02, SBX-04; D-02 (b), D-03, D-09, D-11 F-7, D-12; P-04,
 * P-06, P-07). `POST /agent-channel/v1/sandbox/exec` runs an argv array in the bot's own sandbox; 07.8-10 adds
 * `process`, `read`, `write`, `list`, `delete` and `share` (every one through `runSandboxCall` → `decideSandboxCall`,
 * with its static flag class: read, list, process and exec taint the turn, write and delete do not, share is
 * side-effecting) and records each decided call as a step of the turn's activity (`activity.ts`). 07.8-14 adds the
 * browser routes.
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
const EXEC_ANSWER_MARGIN_MS = SANDBOX_TIMEOUTS_MS.execAnswerMargin;
/** A shared file comes back from sandboxd as base64 JSON (up to the attachment limit). */
const SHARE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** How much longer than the start's share the transport may wait, so the share (`starting`) always decides first. */
const START_BACKSTOP_MS = 1_000;

/** Every code a sandbox call can be refused with. */
export type SandboxCallRefusal =
  | SandboxRefusal
  | Extract<ToolApprovalRefusal, "arguments_too_large" | "arguments_invalid">;

/** Every code a confined call (sandbox or browser, 07.8-14) can be refused with. */
export type ConfinedCallRefusal = SandboxCallRefusal | BrowserRefusal;

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
  starting: "The sandbox is still starting",
};

/**
 * The sandbox tools that change a bot's workspace (P-11): refused on a team bot once its turn has member data. Read,
 * list, process and share leave the workspace as it is (share moves a file towards the conversation, never into it).
 */
const WORKSPACE_MUTATIONS: ReadonlySet<ConfinedToolName> = new Set([
  BUILTIN_TOOLS.sandboxWrite,
  BUILTIN_TOOLS.sandboxDelete,
  BUILTIN_TOOLS.sandboxExec,
  BUILTIN_TOOLS.sandboxImport,
]);

const statusOf = (code: SandboxCallRefusal): number =>
  code in SANDBOX_REFUSAL_STATUS ? SANDBOX_REFUSAL_STATUS[code as SandboxRefusal] : 409;

/** A refusal as the HTTP error the plugin reads (`code`, fixed message, optional approval `details`). */
export function sandboxRefusal(code: SandboxCallRefusal, details?: Record<string, unknown>): HttpError {
  return new HttpError(statusOf(code), code, MESSAGES[code], details);
}

/** sandboxd's refusal of a decided call → the code the bot gets (anything unexpected is the service failing). */
function refusalOfSandboxd(code: SandboxdErrorCode): SandboxRefusal {
  switch (code) {
    case "exists":
      // `create` on a path that is there (and an import onto one): the bot is told the workspace is busy.
      return "busy";
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
  | { ok: false; reason: ConfinedCallRefusal; details?: Record<string, unknown> };

/** One `agent_tool_calls` row and its `bot.tool_call` audit (ids, tool and reason only; never the arguments). */
async function recordCall(
  tx: Tx,
  core: Core,
  p: {
    cell: CellPrincipal;
    turn: AgentTurnRow;
    tool: string;
    reason: ConfinedCallRefusal | null;
    approvalId: string | null;
    metadata: Record<string, unknown>;
    /** The ledger's and audit's target: `sandbox` or (07.8-14) `browser`. */
    target?: "sandbox" | "browser";
  },
): Promise<string> {
  const target = p.target ?? "sandbox";
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
      target,
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
      target,
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
    /**
     * 07.8-14 (D-11 F-7): this call's flag class when the API decides it per call (`ocw_browser_act` is side-effecting
     * only while a member session is loaded for the page); never looser than the static class's taint.
     */
    flags?: TurnToolFlags;
    /** 07.8-14 (P-06, P-18): the approval floor and the shorter pending TTL of a browser action. */
    approval?: { floor?: "always"; pendingTtlMs?: number };
    /** 07.8-25: ids the call's audit rows carry (an import's attachment id); never a path or content. */
    metadata?: Record<string, unknown>;
  },
): Promise<SandboxDecision> {
  const { turn } = p;
  const container: SandboxContainer = p.kind === "sandbox" ? "sbx" : "brw";
  const target = p.kind === "sandbox" ? "sandbox" : "browser";
  const base = CONFINED_TOOL_FLAGS[p.tool];
  const flags = p.flags
    ? {
        untrustedOutput: base.untrustedOutput || p.flags.untrustedOutput,
        sideEffecting: base.sideEffecting || p.flags.sideEffecting,
      }
    : base;
  const meta: Record<string, unknown> = { kind: p.kind, ...p.metadata };
  const refuse = async (
    reason: ConfinedCallRefusal,
    extra: { details?: Record<string, unknown>; metadata?: Record<string, unknown> } = {},
  ): Promise<SandboxDecision> => {
    await recordCall(tx, deps.core, {
      cell: deps.cell,
      turn,
      tool: p.tool,
      reason,
      approvalId: null,
      metadata: { ...meta, ...extra.metadata },
      target,
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

  // The turn row, locked: the per-turn budget (the claim below re-checks it in its UPDATE) and its member data.
  const [locked] = await tx
    .select({ sandboxCalls: agentTurns.sandboxCalls, memberData: agentTurns.memberData })
    .from(agentTurns)
    .where(eq(agentTurns.eventId, turn.eventId))
    .for("update");
  if (!locked) return refuse("budget_exhausted");

  // P-11 (D-11 F-8, Pitfall 13): once a member's session was loaded in this turn, a team bot puts nothing into the
  // workspace other people's turns read, for the rest of the turn. A personal bot's workspace is its owner's alone.
  if (locked.memberData && WORKSPACE_MUTATIONS.has(p.tool)) {
    const bot = await loadSandboxBot(tx, turn.agentId);
    if (bot?.facts.scope !== "personal") return refuse("member_data");
  }
  if (locked.sandboxCalls >= MAX_SANDBOX_CALLS_PER_TURN) return refuse("budget_exhausted");

  // D-13 (P-18): once a member's sign-in was used in this turn, a command that can reach the internet waits for the
  // requester's own approval, every time, for 15 minutes (`withFloor`: the requester alone decides, whatever 07.5 rule
  // applies). The organization's shell egress is read from its settings now, never from the request, and is part of
  // the canonical action, so a grant given under `allowlist` never serves a call under `public`. Egress `off` is exempt.
  let args = p.args;
  let approval = p.approval;
  if (base.memberData === "egress_exec" && locked.memberData) {
    const egress = (await loadSandboxPolicy(tx)).sandboxEgress;
    if (egress !== "off") {
      args = { ...p.args, egress };
      approval = { floor: "always", pendingTtlMs: TOOL_APPROVAL_LIMITS.browserPendingTtlMs };
      meta.memberData = "egress_exec";
      meta.egress = egress;
    }
  }

  // The organization cap before the approval: a grant consumed by a call the cap then refuses is never given back.
  // The advisory lock taken here is held until commit, so the reservation below cannot fail.
  const cap = await reserveSandbox(tx, { agentId: turn.agentId }, container, { dryRun: true });
  if (!cap.ok) return refuse(cap.reason);

  const verdict = approvalVerdict(
    await deps.toolApproval.approvalForCall(tx, {
      turn: { eventId: turn.eventId, agentId: turn.agentId },
      tool: p.tool,
      args,
      toolCallId: p.toolCallId,
      source: { kind: "builtin", id: null, target },
      ...(approval?.floor ? { floor: approval.floor } : {}),
      ...(approval?.pendingTtlMs !== undefined ? { pendingTtlMs: approval.pendingTtlMs } : {}),
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
  // CR-A-01 follow-up: the turn's live return turns are tainted with it (claim.ts, `taintReturnTurns`).
  if (updated.length > 0 && flags.untrustedOutput) await taintReturnTurns(tx, turn.eventId);
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
    target,
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
    /** The outcome audit (`sandbox.exec`, `sandbox.file_written`, …); null = the ledger row only (reads and lists). */
    action: string | null;
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
  if (!p.action) return;
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
 * service failed; `disk_full` when sandboxd said so; `killed` when the kill switch won the race with the start; nothing
 * otherwise. A `starting` slot taken by the decision is always released by one of these (so a failed start never holds
 * the organization's cap), except a start the call's share cut (`starting`): sandboxd is still starting it, so the
 * reservation stays until sandboxd's state event, the next call's ensure or the stale-reservation sweep settles it.
 */
export function containerStateAfter(p: {
  reserved: boolean;
  ensured: boolean;
  failure: SandboxRefusal | null;
}): {
  state: "running" | "unavailable" | "disk_full" | "killed";
  stopReason: "service_down" | "disk_full" | "kill_switch" | null;
} | null {
  if (p.failure === "starting") return null;
  if (p.failure === "service_unavailable") return { state: "unavailable", stopReason: "service_down" };
  if (p.failure === "disk_full") return { state: "disk_full", stopReason: "disk_full" };
  if (p.failure === "killed") return { state: "killed", stopReason: "kill_switch" };
  if (p.ensured) return { state: "running", stopReason: null };
  if (p.reserved) return { state: "unavailable", stopReason: "service_down" };
  return null;
}

/** A refusal the API reaches itself around sandboxd's answer (a folder where a file is needed, a share too large). */
class LocalRefusal extends Error {
  constructor(readonly code: SandboxRefusal) {
    super(code);
    this.name = "LocalRefusal";
  }
}

// ---------------------------------------------------------------- the call's deadline (CI p142/p164/p178)

/** Test hook: shorter budgets than contracts SANDBOX_TIMEOUTS_MS (never read from the environment). */
export interface SandboxBudgets {
  /** One sandbox call end to end. */
  apiCall?: number;
  /** The start's share of it. */
  ensure?: number;
}

export function sandboxCallBudgets(b: SandboxBudgets = {}): { apiCall: number; ensure: number } {
  return {
    apiCall: b.apiCall ?? SANDBOX_TIMEOUTS_MS.apiCall,
    ensure: b.ensure ?? SANDBOX_TIMEOUTS_MS.ensure,
  };
}

/**
 * The bot's shell started within `ms`, or the call's `starting` (CI p142/p164/p178: a contended Docker daemon held a
 * cold start for 15-42 s). `start` gets the share as a signal and a transport deadline just past it, so the share always
 * decides first. sandboxd is not told: the start it is running finishes, and the bot's next call finds the shell
 * running. Any refusal or failure inside the share (a killed organization included) is kept as it is.
 */
export async function startWithin<T>(
  ms: number,
  start: (signal: AbortSignal, backstopMs: number) => Promise<T>,
): Promise<T> {
  const share = Math.max(0, ms);
  const cut = AbortSignal.timeout(share);
  try {
    return await start(cut, share + START_BACKSTOP_MS);
  } catch (err) {
    throw cut.aborted ? new LocalRefusal("starting") : err;
  }
}

/**
 * Every sandboxd call of one sandbox call under its deadline (an absolute time): a call the deadline cut, or one asked
 * after it, is the call's `timeout`; each keeps its own budget too. The deadline is below the cell's budget (contracts
 * SANDBOX_TIMEOUTS_MS), so the API's own answer always arrives first.
 */
export function sandboxUnderDeadline(client: SandboxdClient, deadlineAt: number): SandboxdClient {
  const expired = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
  const bounded = (o: SandboxdCallOptions = {}): SandboxdCallOptions => ({
    ...o,
    signal: o.signal ? AbortSignal.any([o.signal, expired]) : expired,
  });
  async function run<T>(go: (o: SandboxdCallOptions) => Promise<T>, o?: SandboxdCallOptions): Promise<T> {
    if (expired.aborted || Date.now() >= deadlineAt) throw new LocalRefusal("timeout");
    try {
      return await go(bounded(o));
    } catch (err) {
      throw expired.aborted ? new LocalRefusal("timeout") : err;
    }
  }
  return {
    call(op, input, o) {
      return run((b) => client.call(op, input, b), o);
    },
    stream(op, input, o) {
      return run((b) => client.stream(op, input, b), o);
    },
  };
}

/**
 * How long a command may run before it yields a process id: the whole yield on a warm call, what the call's deadline
 * leaves (less the answer's margin) after a slow start, never negative; a background command never waits.
 */
export function execYieldMs(background: boolean, leftMs: number): number {
  if (background) return 0;
  return Math.max(0, Math.min(SANDBOX_LIMITS.execYieldMs, leftMs - EXEC_ANSWER_MARGIN_MS));
}

/** The approval codes a step shows as waiting ("Needs approval"); every other refusal is a blocked step. */
export const WAITING: ReadonlySet<ConfinedCallRefusal> = new Set(["approval_required", "approval_pending"]);

/**
 * Records a refusal the route reached before `decideSandboxCall` (07.8-10: share without storage or with a full
 * reply): one denied `agent_tool_calls` row and its `bot.tool_call` audit, exactly like a refusal of the decision.
 */
export async function refuseSandboxCall(
  tx: Tx,
  deps: SandboxCallDeps,
  p: {
    turn: AgentTurnRow;
    tool: ConfinedToolName;
    reason: ConfinedCallRefusal;
    kind: ConfinedKind;
    metadata?: Record<string, unknown>;
  },
): Promise<SandboxDecision> {
  await recordCall(tx, deps.core, {
    cell: deps.cell,
    turn: p.turn,
    tool: p.tool,
    reason: p.reason,
    approvalId: null,
    metadata: { kind: p.kind, ...p.metadata },
    target: p.kind === "sandbox" ? "sandbox" : "browser",
  });
  return { ok: false, reason: p.reason };
}

interface CallOutcome<R> {
  /** What the bot gets. */
  response: R;
  /** What the activity step may show (exec output, a write's size, a share's name); masked by `stepFor`. */
  stepResult: Record<string, unknown> | null;
  /** The outcome audit's metadata: ids, sizes, counts and codes only. */
  audit: Record<string, unknown>;
}

/** One bot sandbox tool call, from the route's validated body to sandboxd and back (see `runSandboxCall`). */
interface SandboxCallSpec<Raw, R> {
  tool: SandboxToolName;
  body: { eventId: string; agentId: string };
  /** The canonical arguments a person approves (07.5): exactly what runs, never stored elsewhere. */
  args: Record<string, unknown>;
  /** The step's input (masked by `stepFor`; never content). */
  stepInput: Record<string, unknown>;
  /** The outcome audit action, or null for the ledger row only. */
  auditAction: string | null;
  /** The outcome audit's metadata when the call failed after its decision. */
  failureAudit?: (reason: SandboxRefusal) => Record<string, unknown>;
  /** Ensure and retry once when sandboxd says the container went away (exec: idle stop, restart). */
  retryOnGone?: boolean;
  /** A refusal before the decision, in its transaction (share, import). */
  precheck?: (tx: Tx, turn: AgentTurnRow) => Promise<SandboxCallRefusal | null>;
  /** Ids every audit row of this call carries (an import's attachment id); never a path or content. */
  auditIds?: Record<string, unknown>;
  /**
   * sandboxd, outside any transaction, under the call's deadline (`leftMs` of it remain: an exec yields within them).
   */
  call: (client: SandboxdClient, target: SandboxdTarget, leftMs: number) => Promise<Raw>;
  /** In the outcome transaction (a savepoint: a throw undoes only its own writes). */
  finish: (tx: Tx, raw: Raw, turn: AgentTurnRow) => Promise<CallOutcome<R>>;
  /**
   * One more audit row for every outcome of a call on a live turn (07.15-03: an import's `bot.attachment_imported`),
   * in the transaction that records it: a refusal before or at the decision in tx1 (`denied`), the outcome after
   * sandboxd in tx2 (`ok`, or `failed` with its code). Ids, counts and codes only.
   */
  outcomeAudit?: (tx: Tx, turn: AgentTurnRow, outcome: CallOutcomeAudit) => Promise<void>;
}

/** What `outcomeAudit` is told: the call succeeded, was refused before sandboxd, or failed after its decision. */
type CallOutcomeAudit =
  | { kind: "ok" }
  | { kind: "denied"; reason: ConfinedCallRefusal }
  | { kind: "failed"; reason: SandboxRefusal };

/** How the step of a call refused at its decision reads (a waiting one links its approval card, WINDOWS #245). */
export const refusedOutcome = (
  reason: ConfinedCallRefusal,
  approvalMessageRoute: string | null = null,
): StepOutcomeInput => ({
  kind: WAITING.has(reason) ? "approval" : "blocked",
  code: reason,
  approvalMessageRoute,
});

/** The card permalink of a decision waiting for a person, or null (read in the decision's transaction). */
export async function waitingRoute(tx: Tx, decision: SandboxDecision): Promise<string | null> {
  if (decision.ok || !WAITING.has(decision.reason)) return null;
  const approval = decision.details?.approval as { id?: unknown } | undefined;
  return typeof approval?.id === "string" ? approvalMessageRouteOf(tx, approval.id) : null;
}

/** Codes only: a sandboxd or local refusal → the bot's code (anything else is the service failing). */
function failureOf(err: unknown): SandboxRefusal {
  if (err instanceof LocalRefusal) return err.code;
  if (err instanceof SandboxdRefusedError) return refusalOfSandboxd(err.code);
  return "service_unavailable";
}

/**
 * Every bot sandbox tool call (07.8-05 exec; 07.8-10 process, read, write, list, delete, share), in four steps:
 *   1. tx0: the turn's human (`turnHumanOf`, 403 `no_trigger`);
 *   2. tx1 AS that human: the live turn, the route's precheck, `decideSandboxCall` (or the precheck's refusal), and the
 *      turn activity's step (`running` while sandboxd works, `blocked`/`approval` when refused), published after commit;
 *   3. outside any transaction: sandboxd (`ensure` first when the bot's container is not running);
 *   4. tx2 AS the human: the container's state, the route's `finish` (in a savepoint), the ledger row's status and the
 *      outcome audit (ids, sizes and codes only), and the step's outcome.
 */
async function runSandboxCall<Raw, R>(
  core: Core,
  deps: {
    perms: Pick<PermissionService, "decide">;
    toolApproval: ToolApprovalGate;
    client: SandboxdClient | null;
    budgets?: SandboxBudgets;
  },
  cell: CellPrincipal,
  spec: SandboxCallSpec<Raw, R>,
): Promise<R> {
  const { body, tool } = spec;
  const humanUserId = await turnHumanOf(core, cell, { ...body, tool });
  const ctx = { organizationId: cell.organizationId, userId: humanUserId };
  const callDeps: SandboxCallDeps = {
    core,
    perms: deps.perms,
    toolApproval: deps.toolApproval,
    configured: deps.client !== null,
    cell,
  };

  const decided = await core.db.withTenant(ctx, async (tx) => {
    const turn = await liveTurn(tx, core, body);
    if (!turn || turn.userId !== humanUserId) {
      await auditUnknownTurn(tx, core, {
        cell,
        tool,
        reason: "no_trigger",
        metadata: { eventId: body.eventId },
      });
      return null;
    }
    const pre = spec.precheck ? await spec.precheck(tx, turn) : null;
    const decision = pre
      ? await refuseSandboxCall(tx, callDeps, {
          turn,
          tool,
          reason: pre,
          kind: "sandbox",
          ...(spec.auditIds ? { metadata: spec.auditIds } : {}),
        })
      : await decideSandboxCall(tx, callDeps, {
          turn,
          tool,
          args: spec.args,
          toolCallId: null,
          kind: "sandbox",
          ...(spec.auditIds ? { metadata: spec.auditIds } : {}),
        });
    if (!decision.ok) await spec.outcomeAudit?.(tx, turn, { kind: "denied", reason: decision.reason });
    const step = stepFor(
      tool,
      spec.stepInput,
      decision.ok ? { kind: "running" } : refusedOutcome(decision.reason, await waitingRoute(tx, decision)),
    );
    await recordStep(tx, core, { turn, step, inFlight: decision.ok });
    return { turn, decision, stepId: step.id };
  });
  if (!decided) throw noTrigger();
  const { turn, decision, stepId } = decided;
  if (!decision.ok) throw sandboxRefusal(decision.reason as SandboxCallRefusal, decision.details);
  const client = deps.client;
  if (!client) throw sandboxRefusal("service_unavailable");

  // 3. sandboxd, outside any transaction, under the call's deadline (contracts SANDBOX_TIMEOUTS_MS, CI p142/p164/p178):
  // the API answers before the cell gives up, so the model reads `starting` or `timeout`, never "could not be reached".
  const target = { orgId: cell.organizationId, agentId: turn.agentId };
  const started = Date.now();
  const budgets = sandboxCallBudgets(deps.budgets);
  const deadlineAt = started + budgets.apiCall;
  const bounded = sandboxUnderDeadline(client, deadlineAt);
  const box: { ensured: boolean; runtime: SandboxRuntime | null } = { ensured: false, runtime: null };
  const ensure = async () => {
    // The start's share of the call (a cold start on a loaded daemon took 42 s); past it: `starting`. 07.8-18: a start
    // also brings the bot's sandbox packages up to date (never failing the call, outside the share).
    const share = Math.min(budgets.ensure, deadlineAt - Date.now());
    const status = await startWithin(share, (signal, timeoutMs) =>
      ensureSandbox(core, client, target, { timeoutMs, signal }),
    );
    box.ensured = true;
    box.runtime = status.runtime;
  };
  const run = () => spec.call(bounded, target, deadlineAt - Date.now());
  let raw: { value: Raw } | null = null;
  let failure: SandboxRefusal | null = null;
  try {
    if (decision.claim.ensure) await ensure();
    try {
      raw = { value: await run() };
    } catch (err) {
      // The container went away behind the API's back (idle stop, a restart): ensure it once and retry.
      const gone = err instanceof SandboxdRefusedError && (err.code === "not_found" || err.code === "killed");
      if (!spec.retryOnGone || !gone || box.ensured) throw err;
      await ensure();
      raw = { value: await run() };
    }
  } catch (err) {
    // Codes only: the error never names the argv, a path or content, and it is never logged with a body.
    failure = failureOf(err);
  }
  const durationMs = Date.now() - started;

  // 4. The outcome, audited with ids, sizes and codes only.
  const response = await core.db.withTenant(ctx, async (tx) => {
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
    let outcome: CallOutcome<R> | null = null;
    if (raw && !failure) {
      const value = raw.value;
      try {
        outcome = await withSavepoint(
          tx,
          (sp) => spec.finish(sp, value, turn),
          () => true,
        );
      } catch (err) {
        failure = failureOf(err);
      }
    }
    await finishSandboxCall(tx, core, {
      cell,
      turn,
      callId: decision.claim.callId,
      action: spec.auditAction,
      status: outcome ? "ok" : "error",
      durationMs,
      container: "sbx",
      metadata: outcome
        ? outcome.audit
        : (spec.failureAudit?.(failure ?? "service_unavailable") ?? {
            reason: failure ?? "service_unavailable",
          }),
    });
    await spec.outcomeAudit?.(
      tx,
      turn,
      outcome ? { kind: "ok" } : { kind: "failed", reason: failure ?? "service_unavailable" },
    );
    const step = stepFor(
      tool,
      spec.stepInput,
      outcome
        ? { kind: "ok", durationMs, result: outcome.stepResult }
        : { kind: "error", code: failure ?? "service_unavailable", durationMs },
      { id: stepId },
    );
    await recordStep(tx, core, { turn, step });
    return outcome ? { value: outcome.response } : null;
  });
  if (!response) throw sandboxRefusal(failure ?? "service_unavailable");
  return response.value;
}

/** A workspace path in an audit row: its length and hash, never the path (C-02, T-07.8-10-04). */
const pathAudit = (path: string) => ({ pathLength: path.length, pathSha256: sha256Hex(path) });

/**
 * The body checks a person would expect before any decision: a path the contract refuses is 422 `invalid_path`
 * (never a generic validation error), and write content over 1 MiB is 413 `too_large`. Runs before the schema.
 */
function guardBody(opts: { rootAllowed?: boolean; content?: boolean }) {
  const pathSchema = opts.rootAllowed ? SandboxRelativePath : SandboxFilePath;
  return async (req: FastifyRequest): Promise<void> => {
    const body = req.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== "object") return;
    if (typeof body.path === "string" && !pathSchema.safeParse(body.path).success) {
      throw sandboxRefusal("invalid_path");
    }
    if (
      opts.content &&
      typeof body.content === "string" &&
      Buffer.byteLength(body.content, "utf8") > SANDBOX_LIMITS.writeMaxBytes
    ) {
      throw sandboxRefusal("too_large");
    }
  };
}

/** The bot's view of a folder: folders first, then files, each by name (sandboxd's own order otherwise). */
function foldersFirst(list: SandboxFileList): SandboxFileList {
  const entries = [...list.entries].sort((a, b) =>
    a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === "dir" ? -1 : 1,
  );
  return { ...list, entries };
}

/** A path that must name a file: sandboxd's stat says what is there (a folder is `invalid_path`). */
async function assertFile(
  client: SandboxdClient,
  target: SandboxdTarget,
  path: string,
): Promise<SandboxFileEntry> {
  const entry = await client.call("filesStat", { target, path });
  if (entry.kind !== "file") throw new LocalRefusal("invalid_path");
  return entry;
}

/** Where an import lands when the bot names no path: `downloads/<the attachment's name>` (sanitized). */
function importPathOf(row: Pick<AttachmentRow, "id" | "filename">): string {
  const path = `downloads/${sanitizeFilename(row.filename)}`;
  return SandboxFilePath.safeParse(path).success ? path : `downloads/attachment-${row.id.slice(0, 8)}`;
}

export function registerSandboxRoutes(
  scope: App,
  core: Core,
  deps: {
    perms: Pick<PermissionService, "decide" | "usersAllowed">;
    toolApproval: ToolApprovalGate;
    client: SandboxdClient | null;
    /** Test hook: shorter call budgets (contracts SANDBOX_TIMEOUTS_MS otherwise); never read from the environment. */
    budgets?: SandboxBudgets;
  },
): void {
  // Shared files land in the conversation through the artifact storage (server credentials); null = not configured.
  const storage = createObjectStorage(core.env, core.secretStore);
  const attachmentMaxBytes = core.env.OCW_ATTACHMENT_MAX_BYTES;
  const route = <B extends z.ZodType, R extends z.ZodType>(body: B, response: R) => ({
    config: { authz: "cell" as const },
    schema: { tags, security: bearer, body, response: { 200: response } },
  });

  scope.post(
    "/sandbox/exec",
    route(AgentChannelSandboxExec, AgentChannelSandboxExecResponse),
    async (req) => {
      const body = req.body;
      return runSandboxCall(core, deps, cellOf(req), {
        tool: EXEC,
        body,
        // The canonical action a person approves: exactly what runs.
        args: {
          argv: body.argv,
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
          ...(body.timeoutSeconds !== undefined ? { timeoutSeconds: body.timeoutSeconds } : {}),
          ...(body.background !== undefined ? { background: body.background } : {}),
        },
        stepInput: { argv: body.argv, cwd: body.cwd },
        auditAction: "sandbox.exec",
        failureAudit: (reason) => ({ status: "error", exitCode: null, reason }),
        retryOnGone: true,
        call: (client, target, leftMs) => {
          // After a slow start the command yields within what the call's deadline leaves (a process id to poll).
          const yieldMs = execYieldMs(body.background === true, leftMs);
          return client.call(
            "exec",
            {
              target,
              argv: body.argv,
              cwd: body.cwd ?? "",
              timeoutMs: (body.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS) * 1000,
              yieldMs,
            },
            { timeoutMs: yieldMs + EXEC_ANSWER_MARGIN_MS },
          );
        },
        finish: async (_tx, result) => ({
          response: result,
          stepResult: result,
          audit: { status: result.status, exitCode: result.status === "exited" ? result.exitCode : null },
        }),
      });
    },
  );

  scope.post(
    "/sandbox/process",
    route(AgentChannelSandboxProcess, AgentChannelSandboxExecResponse),
    async (req) => {
      const body = req.body;
      return runSandboxCall(core, deps, cellOf(req), {
        tool: BUILTIN_TOOLS.sandboxProcess,
        body,
        args: { processId: body.processId, action: body.action },
        stepInput: { processId: body.processId, action: body.action },
        // Stopping a command changes the sandbox; a poll is in the ledger only.
        auditAction: body.action === "kill" ? "sandbox.process_stopped" : null,
        // sandboxd scopes process ids to the bot's own sandbox (the target is the turn's bot): another bot's id is
        // `not_found`.
        call: (client, target) =>
          client.call(
            "process",
            { target, processId: body.processId, action: body.action },
            { timeoutMs: SANDBOX_LIMITS.execYieldMs + EXEC_ANSWER_MARGIN_MS },
          ),
        finish: async (_tx, result) => ({
          response: result,
          stepResult: {
            status: result.status,
            exitCode: result.status === "exited" ? result.exitCode : null,
          },
          audit: { status: result.status, exitCode: result.status === "exited" ? result.exitCode : null },
        }),
      });
    },
  );

  scope.post(
    "/sandbox/read",
    { ...route(AgentChannelSandboxRead, AgentChannelSandboxReadResponse), preValidation: guardBody({}) },
    async (req) => {
      const body = req.body;
      return runSandboxCall(core, deps, cellOf(req), {
        tool: BUILTIN_TOOLS.sandboxRead,
        body,
        args: {
          path: body.path,
          ...(body.offset !== undefined ? { offset: body.offset } : {}),
          ...(body.limit !== undefined ? { limit: body.limit } : {}),
        },
        stepInput: { path: body.path },
        auditAction: null,
        call: async (client, target) => {
          await assertFile(client, target, body.path);
          return client.call("filesRead", {
            target,
            path: body.path,
            offset: body.offset ?? 0,
            limit: body.limit ?? SANDBOX_LIMITS.readMaxBytes,
          });
        },
        finish: async (_tx, result) => ({ response: result, stepResult: null, audit: {} }),
      });
    },
  );

  scope.post(
    "/sandbox/write",
    {
      ...route(AgentChannelSandboxWrite, AgentChannelSandboxWriteResponse),
      preValidation: guardBody({ content: true }),
    },
    async (req) => {
      const body = req.body;
      return runSandboxCall(core, deps, cellOf(req), {
        tool: BUILTIN_TOOLS.sandboxWrite,
        body,
        args: { path: body.path, content: body.content, mode: body.mode },
        stepInput: { path: body.path, content: body.content },
        auditAction: "sandbox.file_written",
        failureAudit: (reason) => ({ reason, ...pathAudit(body.path) }),
        call: (client, target) =>
          client.call("filesWrite", {
            target,
            path: body.path,
            content: body.content,
            encoding: "utf8",
            mode: body.mode,
          }),
        finish: async (_tx, result) => ({
          response: result,
          stepResult: { size: result.size },
          audit: { size: result.size, mode: body.mode, ...pathAudit(body.path) },
        }),
      });
    },
  );

  scope.post(
    "/sandbox/list",
    {
      ...route(AgentChannelSandboxList, SandboxFileList),
      preValidation: guardBody({ rootAllowed: true }),
    },
    async (req) => {
      const body = req.body;
      return runSandboxCall(core, deps, cellOf(req), {
        tool: BUILTIN_TOOLS.sandboxList,
        body,
        args: { path: body.path },
        stepInput: { path: body.path },
        auditAction: null,
        call: async (client, target) =>
          foldersFirst(await client.call("filesList", { target, path: body.path, hidden: true })),
        finish: async (_tx, result) => ({ response: result, stepResult: null, audit: {} }),
      });
    },
  );

  scope.post(
    "/sandbox/delete",
    {
      ...route(AgentChannelSandboxDelete, AgentChannelSandboxDeleteResponse),
      preValidation: guardBody({}),
    },
    async (req) => {
      const body = req.body;
      const recursive = body.recursive === true;
      return runSandboxCall(core, deps, cellOf(req), {
        tool: BUILTIN_TOOLS.sandboxDelete,
        body,
        args: { path: body.path, ...(body.recursive !== undefined ? { recursive: body.recursive } : {}) },
        stepInput: { path: body.path },
        auditAction: "sandbox.file_deleted",
        failureAudit: (reason) => ({ reason, recursive, ...pathAudit(body.path) }),
        call: async (client, target) => {
          // A folder goes only with `recursive`: without it, the path must be a file.
          if (!recursive) await assertFile(client, target, body.path);
          return client.call("filesDelete", { target, path: body.path, recursive });
        },
        finish: async (_tx, result) => ({
          response: result,
          stepResult: null,
          audit: { deleted: result.deleted, recursive, ...pathAudit(body.path) },
        }),
      });
    },
  );

  scope.post(
    "/sandbox/share",
    {
      ...route(AgentChannelSandboxShare, AgentChannelSandboxShareResponse),
      preValidation: guardBody({}),
    },
    async (req) => {
      const body = req.body;
      return runSandboxCall(core, deps, cellOf(req), {
        tool: BUILTIN_TOOLS.sandboxShare,
        body,
        args: { path: body.path },
        stepInput: { path: body.path },
        auditAction: "sandbox.file_shared",
        failureAudit: (reason) => ({ reason, ...pathAudit(body.path) }),
        // Before the decision: nowhere to store it, or the reply already holds as many files as a message can.
        precheck: async (tx, turn) => {
          if (!storage) return "service_unavailable";
          return (await pendingTurnAttachmentCount(tx, turn.eventId)) >= MAX_ATTACHMENTS_PER_MESSAGE
            ? "too_large"
            : null;
        },
        call: async (client, target) => {
          const entry = await assertFile(client, target, body.path);
          if (entry.size !== null && entry.size > attachmentMaxBytes) throw new LocalRefusal("too_large");
          const file = await client.call(
            "filesDownload",
            { target, path: body.path },
            { timeoutMs: SHARE_DOWNLOAD_TIMEOUT_MS },
          );
          const bytes = Buffer.from(file.data, "base64");
          if (bytes.length > attachmentMaxBytes) throw new LocalRefusal("too_large");
          return { name: file.name, bytes };
        },
        finish: async (tx, file, turn) => {
          if (!storage) throw new LocalRefusal("service_unavailable");
          const row = await storeServerAttachment(tx, storage, {
            conversationId: turn.conversationId,
            uploaderAgentId: turn.agentId,
            eventId: turn.eventId,
            name: file.name,
            bytes: file.bytes,
          });
          return {
            response: { attachmentId: row.id, name: row.filename, size: row.sizeBytes },
            stepResult: { name: row.filename },
            audit: { attachmentId: row.id, conversationId: row.conversationId, size: row.sizeBytes },
          };
        },
      });
    },
  );

  // 07.8-25 (D-11 F-8, P-11): an attachment the turn reads (07.15 D-16: a live message of its conversation, in its
  // thread for a channel: `attachmentForTurn`, the one row rule) copied into the workspace, only when the
  // conversation's audience already covers the workspace's (`audienceCovers`, the resolver's rule: refuse when unsure).
  // 07.15 D-07: every outcome on a live turn is also `bot.attachment_imported` (ids, type, size and outcome only).
  const access = createConversationAccess(core);
  const isReadable = (tx: Tx, userId: string, conversationId: string) =>
    access.isReadable(tx, userId, conversationId, { kinds: ["channel", "dm", "group", "ai_chat"] });
  scope.post(
    "/sandbox/import",
    {
      ...route(AgentChannelSandboxImport, AgentChannelSandboxImportResponse),
      preValidation: guardBody({}),
    },
    async (req) => {
      const body = req.body;
      // The attachment as the precheck resolved it in the turn's transaction (RLS, bound to the turn's conversation).
      let found: AttachmentRow | null = null;
      // The row the shared rule returned, even when a later check refused it (what the import audit describes).
      let resolved: AttachmentRow | null = null;
      const stepInput: Record<string, unknown> = { path: body.path ?? "downloads" };
      return runSandboxCall(core, deps, cellOf(req), {
        tool: BUILTIN_TOOLS.sandboxImport,
        body,
        // The canonical action a person approves: which attachment, and where (null = `downloads/<name>`).
        args: { attachmentId: body.attachmentId, path: body.path ?? null },
        stepInput,
        auditIds: { attachmentId: body.attachmentId },
        auditAction: "sandbox.file_imported",
        failureAudit: (reason) => ({ reason, attachmentId: body.attachmentId }),
        precheck: async (tx, turn) => {
          if (!storage) return "service_unavailable";
          // Only a file the turn reads (`attachmentForTurn`): anything else reads exactly like a missing file.
          const row = await attachmentForTurn(tx, turn, body.attachmentId);
          if (!row) return "not_found";
          resolved = row;
          if (row.sizeBytes > SANDBOX_LIMITS.uploadMaxBytes) return "too_large";
          const facts = await audienceCoverFacts(
            tx,
            { perms: deps.perms, isReadable },
            { conversationId: turn.conversationId, agentId: turn.agentId },
          );
          if (!audienceCovers(facts)) return "audience_narrower";
          found = row;
          stepInput.path = body.path ?? importPathOf(row);
          return null;
        },
        call: async (client, target) => {
          const row = found;
          if (!row || !storage) throw new LocalRefusal("not_found");
          let bytes: Uint8Array;
          try {
            bytes = await readAttachmentBytes(storage, row, "original", SANDBOX_LIMITS.uploadMaxBytes);
          } catch (err) {
            throw new LocalRefusal(
              err instanceof AttachmentTooLargeError ? "too_large" : "service_unavailable",
            );
          }
          return client.call("filesImport", {
            target,
            path: body.path ?? importPathOf(row),
            data: Buffer.from(bytes).toString("base64"),
            overwrite: false,
          });
        },
        finish: async (_tx, put) => ({
          response: { path: put.path, size: put.size },
          stepResult: { size: put.size },
          audit: {
            attachmentId: body.attachmentId,
            conversationId: found?.conversationId ?? null,
            size: put.size,
            ...pathAudit(put.path),
          },
        }),
        outcomeAudit: (tx, turn, outcome) =>
          core.audit.record(tx, {
            ...cellAuditBase(cellOf(req)),
            action: "bot.attachment_imported",
            actorKind: "agent",
            actorId: turn.agentId,
            agentId: turn.agentId,
            userId: turn.userId,
            resourceType: "attachment",
            resourceId: body.attachmentId,
            result: outcome.kind === "ok" ? "success" : outcome.kind === "denied" ? "denied" : "error",
            // Never the file's name, its content or a path (`pathLength` stays on `sandbox.file_imported`).
            metadata: {
              eventId: turn.eventId,
              conversationId: resolved?.conversationId ?? turn.conversationId,
              attachmentId: body.attachmentId,
              mediaType: resolved ? (resolved.contentType ?? resolved.declaredType) : null,
              bytes: resolved?.sizeBytes ?? 0,
              outcome: outcome.kind === "ok" ? "imported" : outcome.reason,
            },
          }),
      });
    },
  );
}
