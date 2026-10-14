import {
  AgentChannelConnectorCall,
  AgentChannelConnectorCallResponse,
  type AgentChannelConnectorEntry,
  AgentChannelConnectorList,
  AgentChannelConnectorListResponse,
  type AgentChannelToolRefusal,
  BUILTIN_TOOLS,
  CONNECTOR_TOOL_LIMITS,
  TurnToolFlags,
} from "@ocw/contracts";
import { agentTurns, mcpServers, mcpServerTools, type Tx } from "@ocw/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
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
  forceRefresh,
  McpUpstreamError,
  markNeedsReconnect,
  touchConnection,
} from "../connectors";
import type { PermissionService } from "../organization";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";
import { type AgentTurnRow, auditUnknownTurn, claimToolCall, finishToolCall, liveTurn } from "./claim";
import { type ConnectCardReason, postConnectCard } from "./connect-card";

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
 *      egress guard (`egress.bound` inside `callTool`, 30 s, every credential string redacted from the result). An
 *      upstream 401 on a token that still looked valid gets exactly one forced refresh and one retry; a second 401
 *      (or a refresh the provider refuses) marks the connection `needs_reconnect` (`upstream_unauthorized`);
 *   4. tx2 (as the human): `bot.tool_call.completed` with status and duration (never arguments or results) and the
 *      connection's `last_used_at`.
 * Not connected or needing a reconnect: 409 and, once per (turn, connector), the platform's connect card in the turn's
 * conversation and thread (`connect-card.ts`), posted after the transaction; a card that fails never changes the 409.
 *
 * `POST /connectors/list`: the per-member connectors and tools the turn may use now (re-decided, audience rule
 * included), with the asker's connection status and argument schemas, and the keys the bot may use here (handle, name,
 * hosts). Never a credential. Claimed like any tool with the turn's `ocw_connector_list` flags: once it lists
 * per-member connectors their third-party descriptions taint the turn (WINDOWS #184).
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const CALL_TOOL = BUILTIN_TOOLS.connectorCall;
const LIST_TOOL = BUILTIN_TOOLS.connectorList;
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

/** The scope names of an `insufficient_scope` challenge (plain scope tokens only, at most 10). */
function missingScopes(challenge: string | undefined): string[] {
  const raw = /\bscope\s*=\s*"([^"]*)"/iu.exec(challenge ?? "")?.[1] ?? "";
  return raw
    .split(/\s+/u)
    .filter((s) => /^[A-Za-z0-9:._/-]{1,64}$/u.test(s))
    .slice(0, 10);
}

/** What the model reads when the member's account lacks a permission (CONN-02): the scopes, never a token. */
function insufficientScopeAnswer(err: McpUpstreamError): AgentChannelConnectorCallResponse {
  const scopes = missingScopes(err.wwwAuthenticate);
  return {
    content:
      "The service refused this: the account of the person who asked is missing a permission it needs" +
      (scopes.length > 0 ? ` (it asks for: ${scopes.join(", ")})` : "") +
      ". They can reconnect in Settings › Connections and allow it, or ask an admin.",
    truncated: false,
    isError: true,
  };
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
  | { refused: Refusal; card?: { turn: AgentTurnRow; server: ServerRow; reason: ConnectCardReason } }
  | { go: { turn: AgentTurnRow; server: ServerRow; tool: ToolRow; callId: string } };

type ListDecided =
  | { refused: "no_trigger" }
  | { refused: Refusal }
  | { list: AgentChannelConnectorListResponse };

/** The stricter of two flag sets (either one untrusted / side-effecting makes the result so). */
const stricter = (a: TurnToolFlags | undefined, b: TurnToolFlags | undefined): TurnToolFlags => ({
  untrustedOutput: (a?.untrustedOutput ?? false) || (b?.untrustedOutput ?? false),
  sideEffecting: (a?.sideEffecting ?? false) || (b?.sideEffecting ?? false),
});

/**
 * The per-member connectors whose logical tools are in `tools`, each with those tools (catalog order) and the asker's
 * connection status. Descriptions and schemas are the probe's (third-party) values, bounded by the contract.
 */
async function listedConnectors(
  tx: Tx,
  userId: string,
  tools: readonly string[],
): Promise<AgentChannelConnectorEntry[]> {
  const offered = new Set(tools.filter((t) => /^m[0-9a-f]{8}__/u.test(t)));
  if (offered.size === 0) return [];
  const rows = await tx
    .select({ server: mcpServers, tool: mcpServerTools })
    .from(mcpServerTools)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerTools.serverId))
    .where(and(ne(mcpServers.authMode, "org_secret"), inArray(mcpServerTools.openclawName, [...offered])))
    .orderBy(asc(mcpServers.name), asc(mcpServerTools.openclawName));
  const byServer = new Map<string, { server: ServerRow; tools: ToolRow[] }>();
  for (const r of rows) {
    const entry = byServer.get(r.server.id) ?? { server: r.server, tools: [] };
    entry.tools.push(r.tool);
    byServer.set(r.server.id, entry);
  }
  const groups = [...byServer.values()].slice(0, CONNECTOR_TOOL_LIMITS.connectors);
  const statuses = await connectionStatusFor(
    tx,
    userId,
    groups.map((g) => g.server.id),
  );
  return groups.map(({ server, tools: serverTools }) => ({
    connector: server.safeName,
    name: server.name,
    status: statuses.get(server.id) ?? "not_connected",
    tools: serverTools.slice(0, CONNECTOR_TOOL_LIMITS.toolsPerConnector).map((t) => ({
      name: t.openclawName.slice(server.safeName.length + 2),
      description: (t.description ?? t.title ?? "").slice(0, CONNECTOR_TOOL_LIMITS.descriptionChars),
      inputSchema: t.inputSchema ?? null,
    })),
  }));
}

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

          // No connection (or a dead one): refused before the claim, so the turn is neither counted nor tainted.
          const status = (await connectionStatusFor(tx, turn.userId, [server.id])).get(server.id);
          if (status !== "connected") {
            const reason = status === "needs_reconnect" ? "needs_reconnect" : "not_connected";
            await refuse(reason, flags);
            return { refused: reason, card: { turn, server, reason } };
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
        if ("card" in decided && decided.card) {
          await postConnectCard(core, {
            organizationId: cell.organizationId,
            turn: decided.card.turn,
            server: decided.card.server,
            reason: decided.card.reason,
          });
        }
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
      const run = (token: Extract<AccessToken, { ok: true }>) => {
        sent = true;
        return callTool(
          egressFor(core.env),
          target,
          { headerName: token.headerName, headerValue: token.headerValue },
          { name: tool.name, arguments: body.arguments },
          { timeoutMs: TIMEOUT_MS, redact: token.secretParts },
        );
      };
      const unauthorized = (err: unknown) => err instanceof McpUpstreamError && err.code === "unauthorized";
      try {
        const token: AccessToken = await accessTokenFor(core, key);
        if (!token.ok) {
          refusal = token.reason;
        } else {
          try {
            answer = await run(token);
          } catch (err) {
            if (!unauthorized(err)) throw err;
            // A 401 on a token that still looked valid: exactly one forced refresh and one retry (D-01).
            const fresh = await forceRefresh(core, key);
            if (!fresh.ok) {
              refusal = "needs_reconnect";
            } else {
              try {
                answer = await run(fresh);
              } catch (retryErr) {
                if (!unauthorized(retryErr)) throw retryErr;
                await markNeedsReconnect(core, { ...key, code: "upstream_unauthorized" });
                refusal = "needs_reconnect";
              }
            }
          }
        }
      } catch (err) {
        // Codes only: an upstream error (which may carry response text) is never logged or returned.
        if (err instanceof McpUpstreamError && err.code === "insufficient_scope") {
          answer = insufficientScopeAnswer(err);
        } else {
          failure = failureOf(err);
        }
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
      if (refusal) {
        await postConnectCard(core, {
          organizationId: cell.organizationId,
          turn,
          server,
          reason: refusal,
        });
        throw new HttpError(409, refusal, MESSAGES[refusal]);
      }
      if (failure || !answer) {
        const code = failure?.code ?? "upstream_error";
        throw new HttpError(502, code, MESSAGES[code]);
      }
      return answer;
    },
  );

  scope.post(
    "/connectors/list",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelConnectorList,
        response: { 200: AgentChannelConnectorListResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const body = req.body;
      const meta = { eventId: body.eventId };
      const humanUserId = await turnHuman(core, cell, body, LIST_TOOL, meta);
      if (!humanUserId) throw noTrigger();
      const decided = await core.db.withTenant(
        { organizationId: cell.organizationId, userId: humanUserId },
        async (tx): Promise<ListDecided> => {
          const turn = await liveTurn(tx, core, body);
          if (!turn || turn.userId !== humanUserId) {
            await auditUnknownTurn(tx, core, { cell, tool: LIST_TOOL, reason: "no_trigger", metadata: meta });
            return { refused: "no_trigger" };
          }
          const now = await decideNow(tx, perms, core, turn);
          // The turn's flags and today's: listing per-member connectors is third-party content (WINDOWS #184).
          const delivered = TurnToolFlags.safeParse(turn.toolFlags[LIST_TOOL]);
          const flags = stricter(delivered.success ? delivered.data : undefined, now.toolFlags[LIST_TOOL]);
          const claimWith = (reason: Refusal | null) =>
            claimToolCall(tx, core, {
              cell,
              turn,
              tool: LIST_TOOL,
              flags,
              web: false,
              sourceKind: "builtin",
              sourceId: null,
              target: null,
              reason,
              metadata: meta,
            });
          if (!turn.tools.includes(LIST_TOOL)) {
            await claimWith("not_in_turn");
            return { refused: "not_in_turn" };
          }
          if (!now.tools.includes(LIST_TOOL)) {
            await claimWith("policy_changed");
            return { refused: "policy_changed" };
          }
          const started = Date.now();
          const claim = await claimWith(null);
          if (!claim.allowed) return { refused: claim.reason as Refusal };
          const connectors = await listedConnectors(tx, turn.userId, now.tools);
          const keys = now.keys.usable.slice(0, CONNECTOR_TOOL_LIMITS.keys).map((k) => ({
            handle: k.handle,
            name: k.name,
            allowedHosts: k.allowedHosts,
          }));
          await finishToolCall(tx, core, {
            cell,
            callId: claim.callId,
            status: "ok",
            durationMs: Date.now() - started,
            metadata: { connectors: connectors.length, keys: keys.length },
          });
          return { list: { connectors, keys } };
        },
      );
      if ("refused" in decided) {
        if (decided.refused === "no_trigger") throw noTrigger();
        throw new HttpError(409, decided.refused, MESSAGES[decided.refused]);
      }
      return decided.list;
    },
  );
}
