import {
  AgentChannelToolCallDecision,
  AgentChannelToolCallRequest,
  AgentChannelToolCallResult,
  BUILTIN_TOOLS,
  Id,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_WEB_CALLS_PER_TURN,
  Ok,
  type SearchProvider,
  type ToolApprovalRefusal,
  TurnToolFlags,
} from "@ocw/contracts";
import { agentToolCalls, agentTurns, type Tx } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
import { audienceOf } from "../ai-chat";
import { currentTurnTools, loadCatalog, loadPolicy } from "../bot-capabilities";
import type { PermissionService } from "../organization";
import type { ApprovalOutcome, ToolApprovalService } from "../tool-approval";
import { cellOf } from "./auth";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, claimToolCall } from "./claim";

/**
 * The tool gate's authority (D-08 guard 3, research Pattern 4 and Pitfall 8). The cell's `before_tool_call`
 * hook asks before every gated call; this route:
 *   1. trusts only the delivered turn (`agent_turns`, written at delivery): unknown or foreign event → deny;
 *   2. requires the tool to be in that turn;
 *   3. re-decides it with the CURRENT policy for the stored human and conversation kind (a rule or policy
 *      change bites mid-turn: `policy_changed`);
 *   4. enforces the per-turn caps and the taint rule with ONE conditional UPDATE (race-free); a tool whose own route
 *      counts the call (the memory tools) is checked against the cap here but counted there, once;
 *   5. records `agent_tool_calls` and audits `bot.tool_call` (bot, human, tool, host; never the query, the URL
 *      path or results).
 * Per-tool approvals (07.5-11, D-01, D-02, D-04, APPROVE-01/02/04), between 3 and 4: a tool the current rules flag
 * (`approval`) that the delivered turn did not flag and whose call carries no arguments is `policy_changed` (nothing to
 * decide on); then `approvalForCall` decides: none (no rule now: any arguments are dropped unread, the claim is
 * today's), the grant consumed for this call (the claim lifts the taint condition for it alone), one pending request
 * with its card (`approval_required` / `approval_pending` + `approval`) or a refusal (`approval_denied` + `denial`, …).
 * The turn's human is read first without a user (unknown → audited deny), then everything runs in one short
 * transaction opened AS that human, like the proxy routes. No external calls: the hook fails closed after 15 s.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const cellRoute = { config: { authz: "cell" as const } };

const WEB_TOOLS: ReadonlySet<string> = new Set([BUILTIN_TOOLS.webSearch, BUILTIN_TOOLS.webFetch]);
/**
 * Tools whose own Agent Channel route counts the call against the turn's cap (memory-files.ts, WINDOWS 148): asked
 * here, the gate checks the cap and the taint but does not count, so a call the cell also gates counts once.
 */
const ROUTE_COUNTED: ReadonlySet<string> = new Set([
  BUILTIN_TOOLS.memoryList,
  BUILTIN_TOOLS.memoryRead,
  BUILTIN_TOOLS.memoryWrite,
  BUILTIN_TOOLS.memoryPropose,
]);
const BUILTIN_NAMES: ReadonlySet<string> = new Set(Object.values(BUILTIN_TOOLS));
/** Unknown flags are treated as the most dangerous combination. */
const UNKNOWN_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };

export type ToolCallDenial =
  | "unknown_turn"
  | "not_in_turn"
  | "policy_changed"
  | "bad_url"
  | "cap_reached"
  | "tainted"
  | ToolApprovalRefusal;

/** The one approval decision every agent-action route asks (07.5-07), as the agent-channel module receives it. */
export type ToolApprovalGate = Pick<ToolApprovalService, "approvalForCall">;

/** Host of an http(s) URL, lower-cased; null for anything else. Never the path or the query. */
export function httpHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function searchHost(provider: SearchProvider, env: Core["env"]): string {
  if (provider === "searxng") return httpHost(env.OCW_SEARXNG_URL) ?? "searxng";
  return "duckduckgo.com";
}

function readFlags(stored: unknown, tool: string): TurnToolFlags | null {
  const entry = stored && typeof stored === "object" ? (stored as Record<string, unknown>)[tool] : undefined;
  if (!entry || typeof entry !== "object") return null;
  const f = entry as Partial<TurnToolFlags>;
  return { untrustedOutput: f.untrustedOutput !== false, sideEffecting: f.sideEffecting !== false };
}

/** The approval mode the delivered turn flagged for `tool` (07.5-11), or undefined (unflagged, or not a valid mode). */
export function deliveredApproval(stored: unknown, tool: string): TurnToolFlags["approval"] {
  const entry = stored && typeof stored === "object" ? (stored as Record<string, unknown>)[tool] : undefined;
  const parsed = TurnToolFlags.shape.approval.safeParse(
    entry && typeof entry === "object" ? (entry as { approval?: unknown }).approval : undefined,
  );
  return parsed.success ? parsed.data : undefined;
}

/**
 * The turn's caps, read under the turn row lock (07.5-11): asked before an approval decision that may consume a grant,
 * so a grant is never consumed by a call the claim would then refuse at the cap (consumption is never given back).
 */
export async function turnAtCap(tx: Tx, eventId: string, web: boolean): Promise<boolean> {
  const [row] = await tx
    .select({ toolCalls: agentTurns.toolCalls, webCalls: agentTurns.webCalls })
    .from(agentTurns)
    .where(eq(agentTurns.eventId, eventId))
    .for("update");
  if (!row) return true;
  return row.toolCalls >= MAX_TOOL_CALLS_PER_TURN || (web && row.webCalls >= MAX_WEB_CALLS_PER_TURN);
}

/** The 409 messages of the approval refusals on the proxy routes (the plugin answers the model with fixed sentences). */
export const APPROVAL_MESSAGES: Record<ToolApprovalRefusal, string> = {
  approval_required: "This action needs a person's approval first",
  approval_pending: "This exact action is already waiting for approval",
  approval_denied: "A person denied this exact action",
  approval_used: "That approval was already used",
  arguments_too_large: "This action is too large to approve",
  arguments_invalid: "This action's values cannot be approved",
  too_many_pending: "Too many actions are waiting for approval",
  policy_changed: "That tool is no longer available on this turn",
};

/** The `details` of a proxy route's approval refusal (`AgentChannelApprovalRefusalDetails`), or undefined. */
export function approvalDetails(v: ReturnType<typeof approvalVerdict>): Record<string, unknown> | undefined {
  if (v.approval) return { approval: v.approval };
  if (v.denial) return { denial: v.denial };
  return undefined;
}

/**
 * What a route does with `approvalForCall`'s outcome: the claim's grant, or the refusal recorded with its reason, the
 * approval the bot tells its person about and who denied it (display name and note only; never an id or arguments).
 */
export function approvalVerdict(outcome: ApprovalOutcome): {
  grantApprovalId: string | null;
  reason: ToolApprovalRefusal | null;
  approval: { id: string; created: boolean; waitingFor: string; requesterName: string } | null;
  denial: { deciderName: string; note: string | null } | null;
  /** Audit metadata: the approval's id (ids only). */
  metadata: Record<string, unknown>;
} {
  switch (outcome.kind) {
    case "none":
      return { grantApprovalId: null, reason: null, approval: null, denial: null, metadata: {} };
    case "grant":
      return {
        grantApprovalId: outcome.approvalId,
        reason: null,
        approval: null,
        denial: null,
        metadata: {},
      };
    case "required":
      return {
        grantApprovalId: null,
        reason: outcome.created ? "approval_required" : "approval_pending",
        approval: {
          id: outcome.approvalId,
          created: outcome.created,
          waitingFor: outcome.waitingFor.slice(0, 200),
          requesterName: outcome.requesterName.slice(0, 120),
        },
        denial: null,
        metadata: { approvalId: outcome.approvalId },
      };
    case "refused":
      return {
        grantApprovalId: null,
        reason: outcome.reason,
        approval: null,
        denial: outcome.denial
          ? { deciderName: outcome.denial.deciderName.slice(0, 200), note: outcome.denial.note }
          : null,
        metadata: {},
      };
  }
}

/**
 * Where a tool comes from, for the `agent_tool_calls` row and the audit: built-in (target decided per call), an
 * MCP server (target = its safe name, the `<safe>__` prefix OpenClaw gives its tools) or a plugin (package name).
 */
type Source = { sourceKind: "builtin" | "mcp" | "plugin"; sourceId: string | null; target: string | null };

async function toolSource(tx: Tx, tool: string): Promise<Source> {
  if (BUILTIN_NAMES.has(tool)) return { sourceKind: "builtin", sourceId: null, target: null };
  for (const source of await loadCatalog(tx)) {
    if (!source.tools.some((t) => t.name === tool)) continue;
    const safe =
      source.sourceKind === "mcp" && tool.includes("__") ? tool.slice(0, tool.indexOf("__")) : null;
    return { sourceKind: source.sourceKind, sourceId: source.sourceId, target: safe ?? source.sourceName };
  }
  // A tool the catalog no longer knows: classified as a plugin tool (never trusted).
  return { sourceKind: "plugin", sourceId: null, target: null };
}

export function registerToolCallRoutes(
  scope: App,
  core: Core,
  perms: PermissionService,
  toolApproval: ToolApprovalGate,
): void {
  scope.post(
    "/tool-calls",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        body: AgentChannelToolCallRequest,
        response: { 200: AgentChannelToolCallDecision },
      },
    },
    async (req): Promise<AgentChannelToolCallDecision> => {
      const cell = cellOf(req);
      const body = req.body;
      const queryChars = body.params.query?.length ?? null;
      const org = cell.organizationId;
      /** Unknown (or another organization's: RLS hides it) or another bot's delivery: no human to attribute. */
      const unknownTurn = async (tx: Tx): Promise<AgentChannelToolCallDecision> => {
        const callId = await auditUnknownTurn(tx, core, {
          cell,
          tool: body.tool,
          reason: "unknown_turn",
          metadata: { queryChars },
        });
        return { callId, allowed: false, reason: "unknown_turn" };
      };

      // 1. The turn's human, from the ledger (no session user is ever taken from the request).
      const known = await core.db.withTenant(
        { organizationId: org, userId: null },
        async (tx): Promise<{ unknown: AgentChannelToolCallDecision } | { userId: string }> => {
          const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
          if (!turn || turn.agentId !== body.agentId) return { unknown: await unknownTurn(tx) };
          return { userId: turn.userId };
        },
      );
      if ("unknown" in known) return known.unknown;

      // 2-5, AS that human (07.5-11: the approval decision, its card and the stored action run as the turn's human).
      return core.db.withTenant({ organizationId: org, userId: known.userId }, async (tx) => {
        const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
        if (!turn || turn.agentId !== body.agentId || turn.userId !== known.userId) return unknownTurn(tx);
        return decideToolCall(tx, turn);
      });

      async function decideToolCall(tx: Tx, turn: AgentTurnRow): Promise<AgentChannelToolCallDecision> {
        const source = await toolSource(tx, body.tool);
        const web = WEB_TOOLS.has(body.tool);
        let target = source.target;
        let reason: ToolCallDenial | null = null;
        let flags = readFlags(turn.toolFlags, body.tool) ?? UNKNOWN_FLAGS;
        let currentApproval: TurnToolFlags["approval"];

        if (!turn.tools.includes(body.tool)) {
          reason = "not_in_turn";
        } else {
          // Re-decided now, for the human the turn was delivered to: a policy, toggle or rule change bites
          // between delivery and the call. In an AI chat, with today's readers too (06-10: a team grant or a
          // participant's deny added mid-turn withdraws a scoped tool).
          const now = await currentTurnTools(
            tx,
            perms,
            {
              agentId: turn.agentId,
              humanUserId: turn.userId,
              conversationKind: turn.conversationKind,
              conversationId: turn.conversationId,
            },
            core.env,
            turn.conversationKind === "ai_chat" ? await audienceOf(tx, turn.conversationId) : null,
          );
          const current = now.toolFlags[body.tool];
          if (!now.tools.includes(body.tool) || !current) {
            reason = "policy_changed";
          } else {
            // Stricter of the delivered and the current flags.
            flags = {
              untrustedOutput: flags.untrustedOutput || current.untrustedOutput,
              sideEffecting: flags.sideEffecting || current.sideEffecting,
            };
            currentApproval = current.approval;
          }
        }

        if (!reason && body.tool === BUILTIN_TOOLS.webSearch) {
          target = searchHost((await loadPolicy(tx)).searchProvider, core.env);
        }
        if (!reason && body.tool === BUILTIN_TOOLS.webFetch) {
          target = httpHost(body.params.url);
          if (!target) reason = "bad_url";
        }

        // 07.5-11 (D-04, Pattern 1 rule 5): a rule added after delivery, and the cell (rightly) sent no arguments for an
        // unflagged tool: nothing to decide on. The next delivery carries the flag.
        if (
          !reason &&
          currentApproval &&
          !deliveredApproval(turn.toolFlags, body.tool) &&
          body.arguments === undefined
        ) {
          reason = "policy_changed";
        }
        // A rule applies now: the caps first, under the turn lock, so a grant is never consumed by a refused call.
        if (!reason && currentApproval && (await turnAtCap(tx, turn.eventId, web))) reason = "cap_reached";

        // The approval decision (07.5-07): none for a tool without a rule now (its arguments, if any, are dropped
        // unread); the grant consumed for this call; or a refusal with the approval or the denial the bot reports.
        const verdict = reason
          ? approvalVerdict({ kind: "none" })
          : approvalVerdict(
              await toolApproval.approvalForCall(tx, {
                turn: { eventId: turn.eventId, agentId: turn.agentId },
                tool: body.tool,
                args: body.arguments ?? null,
                toolCallId: body.toolCallId ?? null,
                source: { kind: source.sourceKind, id: source.sourceId, target },
              }),
            );
        reason ??= verdict.reason;

        // Steps 4-5: caps and taint in one conditional UPDATE, the agent_tool_calls row and the audit (claim.ts).
        const claimed = await claimToolCall(tx, core, {
          cell,
          turn,
          tool: body.tool,
          flags,
          web,
          sourceKind: source.sourceKind,
          sourceId: source.sourceId,
          target,
          reason,
          countCall: !ROUTE_COUNTED.has(body.tool),
          metadata: { queryChars, ...verdict.metadata },
          grantApprovalId: verdict.grantApprovalId,
        });
        return {
          ...claimed,
          ...(verdict.approval ? { approval: verdict.approval } : {}),
          ...(verdict.denial ? { denial: verdict.denial } : {}),
        };
      }
    },
  );

  scope.post(
    "/tool-calls/:callId/result",
    {
      ...cellRoute,
      schema: {
        tags,
        security: bearer,
        params: z.object({ callId: Id }),
        body: AgentChannelToolCallResult,
        response: { 200: Ok },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      await core.db.withTenant({ organizationId: cell.organizationId, userId: null }, async (tx) => {
        const [call] = await tx
          .select()
          .from(agentToolCalls)
          .where(and(eq(agentToolCalls.id, req.params.callId), eq(agentToolCalls.decision, "allowed")));
        if (!call) throw notFound("Tool call not found", "unknown_call");
        if (call.completedAt) return; // already reported (retry): idempotent, audited once
        const finalHost = httpHost(body.finalUrl);
        await tx
          .update(agentToolCalls)
          .set({
            status: body.status,
            resultCount: body.resultCount ?? null,
            durationMs: body.durationMs,
            completedAt: new Date().toISOString(),
          })
          .where(eq(agentToolCalls.id, call.id));
        await core.audit.record(tx, {
          ...cellAuditBase(cell),
          action: "bot.tool_call.completed",
          actorKind: "agent",
          actorId: call.agentId,
          agentId: call.agentId,
          userId: call.userId,
          resourceType: "tool",
          resourceId: call.tool,
          result: body.status === "ok" ? "success" : body.status === "blocked" ? "denied" : "error",
          metadata: {
            tool: call.tool,
            status: body.status,
            resultCount: body.resultCount ?? null,
            provider: body.provider ?? null,
            finalHost,
            durationMs: body.durationMs,
          },
        });
      });
      return { ok: true as const };
    },
  );
}
