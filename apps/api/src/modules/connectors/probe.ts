import { mcpServers } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Core } from "../../core";
import { egressFor } from "../../lib/egress";
import { replaceServerTools } from "../mcp";
import { listTools, McpUpstreamError } from "./mcp-client";

/**
 * The API-side probe of a per-member connector (D-02): the cell never probes these servers, so the first member who
 * connects (or an admin with their own connection, `POST /connectors/:id/probe`) lists the tools with their own
 * credential, through the egress guard, and the catalog records names, flags and input schemas (`replaceServerTools`).
 * A failure sets the server's status to `error` with a coded detail; it never fails the member's connection.
 */
export async function probeConnector(
  core: Core,
  p: { organizationId: string; userId: string; serverId: string },
  auth: { headerName: string; headerValue: string },
): Promise<{ ok: boolean; code?: string }> {
  const ctx = { organizationId: p.organizationId, userId: p.userId };
  const server = await core.db.withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(mcpServers).where(eq(mcpServers.id, p.serverId)).limit(1);
    return row ?? null;
  });
  if (!server?.url || server.authMode === "org_secret" || server.transport === "sandboxed-stdio") {
    return { ok: false, code: "not_probeable" };
  }
  const target = {
    url: server.url,
    transport: server.transport === "sse" ? ("sse" as const) : ("streamable-http" as const),
  };
  try {
    const tools = await listTools(egressFor(core.env), target, auth);
    await core.db.withTenant(ctx, (tx) =>
      replaceServerTools(
        core,
        tx,
        p.serverId,
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          readOnly: t.readOnly,
          destructive: t.destructive,
          inputSchema: t.inputSchema,
        })),
      ),
    );
    return { ok: true };
  } catch (err) {
    const code = err instanceof McpUpstreamError ? err.code : "upstream_error";
    core.log.warn({ serverId: p.serverId, code }, "connector probe failed");
    await core.db.withTenant(ctx, async (tx) => {
      const now = new Date().toISOString();
      await tx
        .update(mcpServers)
        .set({ status: "error", statusDetail: `The probe failed (${code})`, probedAt: now, updatedAt: now })
        .where(eq(mcpServers.id, p.serverId));
      await core.audit.record(tx, {
        action: "mcp.server.probed",
        resourceType: "mcp_server",
        resourceId: p.serverId,
        actorKind: "system",
        metadata: { ok: false, toolCount: 0, code },
      });
    });
    return { ok: false, code };
  }
}
