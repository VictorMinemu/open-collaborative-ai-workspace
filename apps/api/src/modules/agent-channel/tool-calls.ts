import { randomUUID } from "node:crypto";
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
  type TurnToolFlags,
} from "@ocw/contracts";
import { agentToolCalls, agentTurns, type Tx } from "@ocw/db";
import { and, eq, lt, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
import { audienceOf } from "../ai-chat";
import { currentTurnTools, loadCatalog, loadPolicy } from "../bot-capabilities";
import type { PermissionService } from "../organization";
import { type CellPrincipal, cellOf } from "./auth";

/**
 * The tool gate's authority (D-08 guard 3, research Pattern 4 and Pitfall 8). The cell's `before_tool_call`
 * hook asks before every gated call; this route:
 *   1. trusts only the delivered turn (`agent_turns`, written at delivery): unknown or foreign event → deny;
 *   2. requires the tool to be in that turn;
 *   3. re-decides it with the CURRENT policy for the stored human and conversation kind (a rule or policy
 *      change bites mid-turn: `policy_changed`);
 *   4. enforces the per-turn caps and the taint rule with ONE conditional UPDATE (race-free);
 *   5. records `agent_tool_calls` and audits `bot.tool_call` (bot, human, tool, host; never the query, the URL
 *      path or results).
 * One short transaction per request, no external calls: the hook fails closed after 15 s.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const cellRoute = { config: { authz: "cell" as const } };

const WEB_TOOLS: ReadonlySet<string> = new Set([BUILTIN_TOOLS.webSearch, BUILTIN_TOOLS.webFetch]);
const BUILTIN_NAMES: ReadonlySet<string> = new Set(Object.values(BUILTIN_TOOLS));
/** Unknown flags are treated as the most dangerous combination. */
const UNKNOWN_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };

export type ToolCallDenial =
  | "unknown_turn"
  | "not_in_turn"
  | "policy_changed"
  | "bad_url"
  | "cap_reached"
  | "tainted";

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

export function registerToolCallRoutes(scope: App, core: Core, perms: PermissionService): void {
  const auditBase = (cell: CellPrincipal) => ({
    clientKind: "agent",
    sessionId: `cell:${cell.credentialId}`,
  });

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
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      return core.db.withTenant({ organizationId: cell.organizationId, userId: null }, async (tx) => {
        const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
        const queryChars = body.params.query?.length ?? null;

        // Unknown (or another organization's: RLS hides it) or another bot's delivery: no human to attribute.
        if (!turn || turn.agentId !== body.agentId) {
          await core.audit.record(tx, {
            ...auditBase(cell),
            action: "bot.tool_call",
            actorKind: "system",
            resourceType: "tool",
            resourceId: body.tool,
            result: "denied",
            metadata: { tool: body.tool, reason: "unknown_turn", queryChars },
          });
          return { callId: randomUUID(), allowed: false, reason: "unknown_turn" };
        }

        const source = await toolSource(tx, body.tool);
        const web = WEB_TOOLS.has(body.tool);
        let target = source.target;
        let reason: ToolCallDenial | null = null;
        let flags = readFlags(turn.toolFlags, body.tool) ?? UNKNOWN_FLAGS;

        if (!turn.tools.includes(body.tool)) {
          reason = "not_in_turn";
        } else {
          // Re-decided now, for the human the turn was delivered to: a policy, toggle or rule change bites
          // between delivery and the call. In an AI chat, with today's readers too (06-10: a team grant or a
          // participant's deny added mid-turn withdraws a scoped tool).
          const now = await currentTurnTools(
            tx,
            perms,
            { agentId: turn.agentId, humanUserId: turn.userId, conversationKind: turn.conversationKind },
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
          }
        }

        if (!reason && body.tool === BUILTIN_TOOLS.webSearch) {
          target = searchHost((await loadPolicy(tx)).searchProvider, core.env);
        }
        if (!reason && body.tool === BUILTIN_TOOLS.webFetch) {
          target = httpHost(body.params.url);
          if (!target) reason = "bad_url";
        }

        if (!reason) {
          // Caps and taint in ONE statement: concurrent calls of one turn serialise on the row lock and the
          // WHERE clause is re-checked, so at most the cap is ever allowed.
          const conditions: Array<SQL | undefined> = [
            eq(agentTurns.eventId, turn.eventId),
            lt(agentTurns.toolCalls, MAX_TOOL_CALLS_PER_TURN),
            web ? lt(agentTurns.webCalls, MAX_WEB_CALLS_PER_TURN) : undefined,
            flags.sideEffecting ? eq(agentTurns.tainted, false) : undefined,
          ];
          const updated = await tx
            .update(agentTurns)
            .set({
              toolCalls: sql`${agentTurns.toolCalls} + 1`,
              webCalls: web ? sql`${agentTurns.webCalls} + 1` : sql`${agentTurns.webCalls}`,
              tainted: flags.untrustedOutput ? true : sql`${agentTurns.tainted}`,
            })
            .where(and(...conditions))
            .returning({ eventId: agentTurns.eventId });
          if (updated.length === 0) {
            // Nothing updated: say why from a fresh read (only on the denial path).
            const [after] = await tx
              .select({ tainted: agentTurns.tainted })
              .from(agentTurns)
              .where(eq(agentTurns.eventId, turn.eventId));
            reason = flags.sideEffecting && after?.tainted ? "tainted" : "cap_reached";
          }
        }

        const [row] = await tx
          .insert(agentToolCalls)
          .values({
            organizationId: cell.organizationId,
            eventId: turn.eventId,
            agentId: turn.agentId,
            userId: turn.userId,
            tool: body.tool,
            sourceKind: source.sourceKind,
            sourceId: source.sourceId,
            target,
            decision: reason ? "denied" : "allowed",
            reason,
          })
          .returning({ id: agentToolCalls.id });
        if (!row) throw new Error("agent_tool_calls insert failed");

        await core.audit.record(tx, {
          ...auditBase(cell),
          action: "bot.tool_call",
          actorKind: "agent",
          actorId: turn.agentId,
          agentId: turn.agentId,
          userId: turn.userId,
          resourceType: "tool",
          resourceId: body.tool,
          result: reason ? "denied" : "success",
          // Source = the MCP server (id + safe name) or plugin the tool belongs to; never arguments or results.
          metadata: {
            tool: body.tool,
            sourceKind: source.sourceKind,
            sourceId: source.sourceId,
            target,
            reason,
            queryChars,
          },
        });
        return { callId: row.id, allowed: reason === null, reason };
      });
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
          ...auditBase(cell),
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
