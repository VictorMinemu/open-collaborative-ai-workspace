import {
  AgentChannelConnectorCall,
  AgentChannelConnectorCallResponse,
  type AgentChannelToolRefusal,
  BUILTIN_TOOLS,
  type TurnToolFlags,
} from "@ocw/contracts";
import { agentTurns, mcpServers, mcpServerTools, type Tx } from "@ocw/db";
import { and, eq, ne } from "drizzle-orm";
import type { App, Core } from "../../core";
import { egressFor } from "../../lib/egress";
import { HttpError } from "../../lib/errors";
import { audienceOf } from "../ai-chat";
import { currentTurn } from "../bot-capabilities";
import {
  type AccessToken,
  accessTokenFor,
  callTool,
  connectionStatusFor,
  McpUpstreamError,
  touchConnection,
} from "../connectors";
import type { PermissionService } from "../organization";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";
import { type AgentTurnRow, auditUnknownTurn, claimToolCall, finishToolCall, liveTurn } from "./claim";

/**
 * The connector proxy (07.4-12; D-01, D-02, D-03, D-07; CONN-02 … CONN-04, SC2): the cell's `ocw_connector_call` runs one
 * tool of a per-member connector with the account of the person who asked. The member is ALWAYS the turn's human
 * (`agent_turns.user_id`, read from the ledger, never a body field); there is no fallback to the bot owner, another
 * member or an organization secret.
 *
 * `POST /connectors/call`, in the order of `/http-requests` (07.4-11):
 *   1. tx0 (no user): the turn's human; no turn of this agent → 403 `no_trigger`, audited;
 *   2. tx1, opened AS that human: the live turn → the connector and its logical tool `<safe>__<tool>` (unknown →
 *      `not_in_turn`) → the tool on the turn (`not_in_turn`, or `member_account` when the audience rule withholds it
 *      here now) → the turn re-decided now, audience rule and shares included (`policy_changed`) → the member's
 *      connection (`not_connected` / `needs_reconnect`) → the claim with the logical tool's flags (caps, taint);
 *      refusals before the claim are recorded and audited through `claimToolCall`;
 *   3. outside any tx: the member's token (`accessTokenFor`, refreshed serially when due) → the MCP call through the
 *      egress guard (`egress.bound` inside `callTool`, 30 s, every credential string redacted from the result);
 *   4. tx2 (as the human): `bot.tool_call.completed` with status and duration (never arguments or results) and the
 *      connection's `last_used_at`.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const CALL_TOOL = BUILTIN_TOOLS.connectorCall;
const TIMEOUT_MS = 30_000;
/** A logical tool the turn carries no flags for is treated as the most dangerous kind. */
const UNKNOWN_FLAGS: TurnToolFlags = { untrustedOutput: true, sideEffecting: true };

type Refusal = Extract<
  AgentChannelToolRefusal,
  | "not_in_turn"
  | "policy_changed"
  | "member_account"
  | "not_connected"
  | "needs_reconnect"
  | "cap_reached"
  | "tainted"
>;
type Failure = Extract<AgentChannelToolRefusal, "egress_refused" | "upstream_error" | "timeout">;

const MESSAGES: Record<Refusal | Failure, string> = {
  not_in_turn: "That connector tool was not offered on this turn",
  policy_changed: "That connector tool is no longer available on this turn",
  member_account: "That connector uses the member's own account and is not used in this conversation",
  not_connected: "The member has not connected this connector",
  needs_reconnect: "The member must reconnect this connector",
  cap_reached: "This turn reached its tool call limit",
  tainted: "This turn read untrusted content and can no longer make changes",
  egress_refused: "The connector is not reachable from the workspace",
  upstream_error: "The connector returned an error",
  timeout: "The connector did not answer in time",
};

type ServerRow = typeof mcpServers.$inferSelect;
type ToolRow = typeof mcpServerTools.$inferSelect;

/** A per-member connector of the tx's organization by its safe name, and its catalog tool by logical name. */
async function connectorTool(
  tx: Tx,
  safeName: string,
  logical: string,
): Promise<{ server: ServerRow; tool: ToolRow | null } | null> {
  const [server] = await tx
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.safeName, safeName), ne(mcpServers.authMode, "org_secret")))
    .limit(1);
  if (!server) return null;
  const [tool] = await tx
    .select()
    .from(mcpServerTools)
    .where(and(eq(mcpServerTools.serverId, server.id), eq(mcpServerTools.openclawName, logical)))
    .limit(1);
  return { server, tool: tool ?? null };
}

/** The human of this agent's turn, from the ledger (tx without a user); null = no such turn, audited. */
async function turnHuman(
  core: Core,
  cell: CellPrincipal,
  body: { eventId: string; agentId: string },
  tool: string,
  meta: Record<string, unknown>,
): Promise<string | null> {
  return core.db.withTenant({ organizationId: cell.organizationId, userId: null }, async (tx) => {
    const [turn] = await tx
      .select({ agentId: agentTurns.agentId, userId: agentTurns.userId })
      .from(agentTurns)
      .where(eq(agentTurns.eventId, body.eventId));
    if (turn && turn.agentId === body.agentId) return turn.userId;
    await auditUnknownTurn(tx, core, { cell, tool, reason: "no_trigger", metadata: meta });
    return null;
  });
}

/** The turn re-decided now, with an AI chat's current readers (the audience rule). */
async function decideNow(tx: Tx, perms: PermissionService, core: Core, turn: AgentTurnRow) {
  return currentTurn(
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
}

function failureOf(err: unknown): { code: Failure; outcome: "blocked" | "error" } {
  if (err instanceof McpUpstreamError) {
    if (err.code === "timeout") return { code: "timeout", outcome: "error" };
    if (err.code === "egress_refused") return { code: "egress_refused", outcome: "blocked" };
  }
  return { code: "upstream_error", outcome: "error" };
}

type CallDecided =
  | { refused: "no_trigger" }
  | { refused: Refusal }
  | { go: { turn: AgentTurnRow; server: ServerRow; tool: ToolRow; callId: string } };

export function registerConnectorRoutes(scope: App, core: Core, perms: PermissionService): void {
  scope.post(
    "/connectors/call",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelConnectorCall,
        response: { 200: AgentChannelConnectorCallResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      const logical = `${body.connector}__${body.tool}`;
      // Ids and names only: never the arguments.
      const meta = { eventId: body.eventId, connector: body.connector, credential: "member" };

      // 1. The turn's human, from the ledger: the credential is always theirs.
      const humanUserId = await turnHuman(core, cell, body, logical, meta);
      if (!humanUserId) throw noTrigger();

      // 2. Everything decided as that human, in one short transaction without any outbound call.
      const decided = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: humanUserId },
        async (tx): Promise<CallDecided> => {
          const turn = await liveTurn(tx, core, body);
          if (!turn || turn.userId !== humanUserId) {
            await auditUnknownTurn(tx, core, { cell, tool: logical, reason: "no_trigger", metadata: meta });
            return { refused: "no_trigger" };
          }
          const found = await connectorTool(tx, body.connector, logical);
          const refuse = async (
            reason: Refusal,
            flags: TurnToolFlags = UNKNOWN_FLAGS,
          ): Promise<CallDecided> => {
            await claimToolCall(tx, core, {
              cell,
              turn,
              tool: logical,
              flags,
              web: false,
              sourceKind: "mcp",
              sourceId: found?.server.id ?? null,
              target: body.connector,
              reason,
              metadata: meta,
            });
            return { refused: reason };
          };
          if (!found?.tool) return refuse("not_in_turn");
          const { server, tool } = found;

          const now = await decideNow(tx, perms, core, turn);
          if (!turn.tools.includes(logical) || !turn.tools.includes(CALL_TOOL)) {
            // Never offered here: a forged call. Say why when the audience rule withholds it now.
            const withheld = now.withheld.some(
              (w) =>
                w.reason === "member_account" &&
                w.resource?.kind === "connector" &&
                w.resource.id === server.id,
            );
            return refuse(withheld ? "member_account" : "not_in_turn");
          }
          if (!now.tools.includes(logical)) return refuse("policy_changed");
          const flags = now.toolFlags[logical] ?? UNKNOWN_FLAGS;

          const status = (await connectionStatusFor(tx, turn.userId, [server.id])).get(server.id);
          if (status !== "connected") {
            return refuse(status === "needs_reconnect" ? "needs_reconnect" : "not_connected", flags);
          }

          const claim = await claimToolCall(tx, core, {
            cell,
            turn,
            tool: logical,
            flags,
            web: false,
            sourceKind: "mcp",
            sourceId: server.id,
            target: body.connector,
            reason: null,
            metadata: meta,
          });
          if (!claim.allowed) return { refused: claim.reason as Refusal };
          return { go: { turn, server, tool, callId: claim.callId } };
        },
      );
      if ("refused" in decided) {
        if (decided.refused === "no_trigger") throw noTrigger();
        throw new HttpError(409, decided.refused, MESSAGES[decided.refused]);
      }

      // 3. The member's token and the MCP call, outside any transaction.
      const { turn, server, tool, callId } = decided.go;
      const key = { organizationId: cell.organizationId, userId: turn.userId, serverId: server.id };
      const target = {
        url: server.url ?? "",
        transport: server.transport === "sse" ? ("sse" as const) : ("streamable-http" as const),
      };
      const started = Date.now();
      let refusal: Extract<Refusal, "not_connected" | "needs_reconnect"> | null = null;
      let failure: { code: Failure; outcome: "blocked" | "error" } | null = null;
      let answer: AgentChannelConnectorCallResponse | null = null;
      let sent = false;
      try {
        const token: AccessToken = await accessTokenFor(core, key);
        if (!token.ok) {
          refusal = token.reason;
        } else {
          sent = true;
          answer = await callTool(
            egressFor(core.env),
            target,
            { headerName: token.headerName, headerValue: token.headerValue },
            { name: tool.name, arguments: body.arguments },
            { timeoutMs: TIMEOUT_MS, redact: token.secretParts },
          );
        }
      } catch (err) {
        // Codes only: an upstream error (which may carry response text) is never logged or returned.
        failure = failureOf(err);
      }
      const durationMs = Date.now() - started;

      // 4. The outcome, audited without arguments or results.
      await core.db.withTenant({ organizationId: cell.organizationId, userId: turn.userId }, async (tx) => {
        await finishToolCall(tx, core, {
          cell,
          callId,
          status: refusal ? "blocked" : failure ? failure.outcome : answer?.isError ? "error" : "ok",
          durationMs,
          metadata: {
            connector: body.connector,
            credential: "member",
            reason: refusal ?? failure?.code ?? null,
          },
        });
        if (sent) await touchConnection(tx, { userId: turn.userId, serverId: server.id });
      });
      if (refusal) throw new HttpError(409, refusal, MESSAGES[refusal]);
      if (failure || !answer) {
        const code = failure?.code ?? "upstream_error";
        throw new HttpError(502, code, MESSAGES[code]);
      }
      return answer;
    },
  );
}
