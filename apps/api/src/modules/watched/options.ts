import {
  isDangerousToolName,
  isPerMemberMode,
  type WatchOptionConnector,
  type WatchOptions,
} from "@ocw/contracts";
import { botToolGrants, mcpServers, mcpServerTools, type Tx } from "@ocw/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { authOf } from "../../core";
import { activeShare, connectionStatusFor, readersOf } from "../connectors";
import { channelResource } from "../organization";
import { boardBots, boardFor, type WatchedCtx } from "./service";

/**
 * The watch dialog's options (07.6-17, D-07, Pitfall 8): what the viewer may link on one board, decided with the link's
 * own rules so the dialog never offers what `POST /watched-records` would refuse.
 *
 * - The board for posting (archived 410, `channel.post` 403, hidden = missing 404) plus `record.watch` there.
 * - Bots: members of the board that may post there and read it for the viewer (`decideConversation`, agent ∩ human).
 * - Connectors: remote ones (never the stdio sandbox), workspace ones (organization headers or, since 07.14, the
 *   organization's own account) only while switched on, with every tool that passes the cell's dangerous-name
 *   denylist, and each tool's grants among those bots. Offered only when one of those bots may use a read-only,
 *   non-destructive tool there (`tools.ts`'s read rule).
 * - Workspace connectors are `org_secret` on the watched wire: no connection to show, no share needed (07.14 D-04).
 * - Per-member connectors: the viewer's own connection state and share on this board, never anyone else's.
 *
 * Read-only: no audit (nothing is read from the connector; `/preview` and the link audit their own actions).
 */
export async function watchOptions(
  req: FastifyRequest,
  tx: Tx,
  ctx: WatchedCtx,
  conversationId: string,
): Promise<WatchOptions> {
  const userId = authOf(req).userId;
  const board = await boardFor(req, tx, ctx, conversationId, "write");
  await ctx.perms.assertCan(req, tx, "record.watch", channelResource(board.facts));

  const bots: WatchOptions["bots"] = (await boardBots(tx, ctx, { userId, conv: board.conv })).map((b) => ({
    id: b.id,
    displayName: b.name,
  }));
  const botIds = bots.map((b) => b.id);

  const servers = await tx
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      authMode: mcpServers.authMode,
      orgEnabled: mcpServers.orgEnabled,
      transport: mcpServers.transport,
      url: mcpServers.url,
    })
    .from(mcpServers)
    .orderBy(asc(mcpServers.name), asc(mcpServers.id));
  const usable = servers.filter(
    (s) => s.transport !== "sandboxed-stdio" && !!s.url && (isPerMemberMode(s.authMode) || s.orgEnabled),
  );
  const serverIds = usable.map((s) => s.id);
  const tools =
    serverIds.length === 0
      ? []
      : await tx
          .select({
            serverId: mcpServerTools.serverId,
            name: mcpServerTools.name,
            openclawName: mcpServerTools.openclawName,
            title: mcpServerTools.title,
            readOnly: mcpServerTools.readOnly,
            destructive: mcpServerTools.destructive,
            inputSchema: mcpServerTools.inputSchema,
          })
          .from(mcpServerTools)
          .where(inArray(mcpServerTools.serverId, serverIds))
          .orderBy(asc(mcpServerTools.name));
  const grants =
    serverIds.length === 0 || botIds.length === 0
      ? []
      : await tx
          .select({
            agentId: botToolGrants.agentId,
            serverId: botToolGrants.sourceId,
            toolName: botToolGrants.toolName,
          })
          .from(botToolGrants)
          .where(
            and(
              eq(botToolGrants.sourceKind, "mcp"),
              inArray(botToolGrants.sourceId, serverIds),
              inArray(botToolGrants.agentId, botIds),
            ),
          );
  const grantedTo = new Map<string, string[]>();
  for (const g of grants) {
    const key = `${g.serverId}\u0000${g.toolName}`;
    grantedTo.set(key, [...(grantedTo.get(key) ?? []), g.agentId]);
  }

  const perMember = usable.filter((s) => isPerMemberMode(s.authMode)).map((s) => s.id);
  const connections = await connectionStatusFor(tx, userId, perMember);
  const connectors: WatchOptionConnector[] = [];
  for (const s of usable) {
    const own = tools
      .filter((t) => t.serverId === s.id)
      .filter((t) => !isDangerousToolName(t.name) && !isDangerousToolName(t.openclawName))
      .map((t) => ({
        name: t.name,
        title: t.title,
        readOnly: t.readOnly,
        destructive: t.destructive,
        idArg: firstRequired(t.inputSchema),
        agentIds: botIds.filter((id) => grantedTo.get(`${s.id}\u0000${t.openclawName}`)?.includes(id)),
      }));
    if (!own.some((t) => t.readOnly && !t.destructive && t.agentIds.length > 0)) continue;
    // Organization headers and the organization's own account alike: one shared credential (workspace access).
    const workspace = !isPerMemberMode(s.authMode);
    connectors.push({
      id: s.id,
      name: s.name,
      authMode: workspace ? "org_secret" : "per_member",
      connection: workspace ? null : (connections.get(s.id) ?? "not_connected"),
      shared:
        workspace ||
        (await activeShare(tx, {
          userId,
          conversationId: board.conv.id,
          resourceKind: "connector",
          resourceId: s.id,
        })),
      tools: own.slice(0, 200),
    });
  }

  const { readers } = await readersOf(tx, board.conv.id, userId);
  return {
    channel: { id: board.conv.id, name: board.conv.name ?? "channel", readers },
    connectors: connectors.slice(0, 100),
    bots: bots.slice(0, 100),
  };
}

/** The first required argument of a tool's input schema (its record id, by convention), when it names one. */
function firstRequired(schema: Record<string, unknown> | null): string | null {
  const required = schema?.required;
  if (!Array.isArray(required)) return null;
  const first = required.find((r): r is string => typeof r === "string" && /^[\w.-]{1,64}$/u.test(r));
  return first ?? null;
}
