import type { ToolGrant } from "@ocw/contracts";
import {
  botToolGrants,
  cellPlugins,
  cellPluginTools,
  mcpServers,
  mcpServerTools,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, asc, eq, ne } from "drizzle-orm";
import type { CatalogSource } from "./capabilities";

/**
 * The tool catalog (BOT-10): tools discovered on the org's MCP servers and declared by its marketplace
 * plugins, plus the per-bot grants. Source metadata is untrusted (names are re-checked against the dangerous
 * list by the pure decision). Sources that are not usable are still listed, so a granted tool shows
 * `source_unavailable` instead of disappearing; uninstalled plugins are omitted.
 */
export async function loadCatalog(tx: Tx): Promise<CatalogSource[]> {
  const servers = await tx.select().from(mcpServers).orderBy(asc(mcpServers.name));
  const serverTools = await tx.select().from(mcpServerTools).orderBy(asc(mcpServerTools.openclawName));
  const plugins = await tx
    .select()
    .from(cellPlugins)
    .where(ne(cellPlugins.status, "uninstalled"))
    .orderBy(asc(cellPlugins.packageName));
  const pluginTools = await tx.select().from(cellPluginTools).orderBy(asc(cellPluginTools.name));

  const out: CatalogSource[] = [];
  for (const s of servers) {
    out.push({
      sourceKind: "mcp",
      sourceId: s.id,
      sourceName: s.name,
      status: s.status,
      orgEnabled: s.orgEnabled,
      personalAllowed: s.personalAllowed,
      trustedChaining: s.trustedChaining,
      tools: serverTools
        .filter((t) => t.serverId === s.id)
        .map((t) => ({
          name: t.openclawName,
          title: t.title,
          description: t.description,
          // MCP annotations: only a read-only, non-destructive tool is free of side effects.
          sideEffecting: !t.readOnly || t.destructive,
        })),
    });
  }
  for (const p of plugins) {
    out.push({
      sourceKind: "plugin",
      sourceId: p.id,
      sourceName: p.packageName,
      status: p.status,
      orgEnabled: p.orgEnabled,
      personalAllowed: p.personalAllowed,
      trustedChaining: p.trustedChaining,
      tools: pluginTools
        .filter((t) => t.pluginRowId === p.id)
        .map((t) => ({
          name: t.name,
          title: null,
          description: t.description,
          sideEffecting: t.sideEffecting,
        })),
    });
  }
  return out;
}

export async function loadGrants(tx: Tx, agentId: string): Promise<ToolGrant[]> {
  const rows = await tx
    .select()
    .from(botToolGrants)
    .where(eq(botToolGrants.agentId, agentId))
    .orderBy(asc(botToolGrants.toolName));
  return rows.map((r) => ({ sourceKind: r.sourceKind, sourceId: r.sourceId, tool: r.toolName }));
}

/** Every grant of the org, by agent (one query for the cell snapshot). */
export async function loadAllGrants(tx: Tx): Promise<Map<string, ToolGrant[]>> {
  const rows = await tx.select().from(botToolGrants);
  const out = new Map<string, ToolGrant[]>();
  for (const r of rows) {
    const list = out.get(r.agentId) ?? [];
    list.push({ sourceKind: r.sourceKind, sourceId: r.sourceId, tool: r.toolName });
    out.set(r.agentId, list);
  }
  return out;
}

const key = (g: ToolGrant) => `${g.sourceKind}:${g.sourceId}:${g.tool}`;

/** Replaces a bot's grant set; returns the tool names granted and revoked (for the audit). */
export async function replaceGrants(
  tx: Tx,
  agentId: string,
  grants: readonly ToolGrant[],
  actorUserId: string | null,
): Promise<{ granted: string[]; revoked: string[] }> {
  const current = await loadGrants(tx, agentId);
  const wanted = new Map(grants.map((g) => [key(g), g]));
  const have = new Map(current.map((g) => [key(g), g]));
  const added = [...wanted.values()].filter((g) => !have.has(key(g)));
  const removed = [...have.values()].filter((g) => !wanted.has(key(g)));
  for (const g of removed) {
    await tx
      .delete(botToolGrants)
      .where(
        and(
          eq(botToolGrants.agentId, agentId),
          eq(botToolGrants.sourceKind, g.sourceKind),
          eq(botToolGrants.sourceId, g.sourceId),
          eq(botToolGrants.toolName, g.tool),
        ),
      );
  }
  if (added.length > 0) {
    const { organizationId } = tenantOf(tx);
    await tx.insert(botToolGrants).values(
      added.map((g) => ({
        organizationId,
        agentId,
        sourceKind: g.sourceKind,
        sourceId: g.sourceId,
        toolName: g.tool,
        createdBy: actorUserId,
      })),
    );
  }
  return { granted: added.map((g) => g.tool).sort(), revoked: removed.map((g) => g.tool).sort() };
}
