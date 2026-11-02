import { isDangerousToolName } from "@ocw/contracts";
import { agents, botToolGrants, mcpServerTools, type Tx } from "@ocw/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

/**
 * Which connector tools a watch may name (security fix in 07.6-07, coordinator finding). A watch's tools are called by
 * the API on a schedule with a person's (or the workspace's) account, so naming one is not enough:
 *
 * - every tool exists on the server, its MCP name and OpenClaw name pass `isDangerousToolName` (the cell's denylist),
 *   and the admin granted it to the watch's bot (`bot_tool_grants`, the per-bot side of the cell's `toolFilter`; the
 *   preview, which has no bot yet, needs a grant on any live bot, exactly the cell's `toolFilter.include`);
 * - the read tool is recorded read-only and not destructive (its MCP annotations, as the last probe recorded them).
 *
 * Checked at link, at edit and preview, and again before every scheduled or on-access read (`readRecord`), so a re-probe
 * that changes a tool's annotations or a revoked grant fails the check closed. Writes and notes still go only through
 * 07.6-14's approval path, never from a check.
 */

export type ToolRefusal =
  | { code: "tool_not_found"; tool: string }
  | { code: "read_tool_not_read_only"; tool: string }
  | { code: "tool_not_allowed"; tool: string };

export async function refuseTools(
  tx: Tx,
  p: {
    serverId: string;
    /** The watch's bot; null = any live bot (the preview). */
    agentId: string | null;
    readTool: string;
    otherTools?: Array<string | null | undefined>;
  },
): Promise<ToolRefusal | null> {
  const others = (p.otherTools ?? []).filter((t): t is string => typeof t === "string" && t !== "");
  const wanted = [...new Set([p.readTool, ...others])];
  const rows = await tx
    .select({
      name: mcpServerTools.name,
      openclawName: mcpServerTools.openclawName,
      readOnly: mcpServerTools.readOnly,
      destructive: mcpServerTools.destructive,
    })
    .from(mcpServerTools)
    .where(and(eq(mcpServerTools.serverId, p.serverId), inArray(mcpServerTools.name, wanted)));
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const tool of wanted) if (!byName.has(tool)) return { code: "tool_not_found", tool };

  const grants = await tx
    .selectDistinct({ toolName: botToolGrants.toolName })
    .from(botToolGrants)
    .innerJoin(agents, eq(agents.id, botToolGrants.agentId))
    .where(
      and(
        eq(botToolGrants.sourceKind, "mcp"),
        eq(botToolGrants.sourceId, p.serverId),
        inArray(
          botToolGrants.toolName,
          rows.map((r) => r.openclawName),
        ),
        isNull(agents.deletedAt),
        ...(p.agentId ? [eq(botToolGrants.agentId, p.agentId)] : []),
      ),
    );
  const granted = new Set(grants.map((g) => g.toolName));
  for (const tool of wanted) {
    const row = byName.get(tool);
    if (!row) return { code: "tool_not_found", tool };
    if (
      isDangerousToolName(row.name) ||
      isDangerousToolName(row.openclawName) ||
      !granted.has(row.openclawName)
    ) {
      return { code: "tool_not_allowed", tool };
    }
  }
  const read = byName.get(p.readTool);
  if (read?.readOnly !== true || read.destructive === true) {
    return { code: "read_tool_not_read_only", tool: p.readTool };
  }
  return null;
}

export const TOOL_REFUSAL_MESSAGES: Record<ToolRefusal["code"], (tool: string, server: string) => string> = {
  tool_not_found: (tool, server) => `${server} has no tool named ${tool}`,
  read_tool_not_read_only: (tool, server) =>
    `${tool} on ${server} isn't marked read-only, so it can't be used to check a record`,
  tool_not_allowed: (tool, server) =>
    `${tool} on ${server} isn't allowed for this bot. Ask an admin to grant it.`,
};
