import { AgentChannelMcpProbeResult, Ok } from "@ocw/contracts";
import type { App, Core } from "../../core";
import { recordProbeResult } from "../mcp";
import { cellOf } from "./auth";

/**
 * `POST /agent-channel/v1/mcp/probe-results` (D-13): the cell reports what an `mcp.probe` found. The API keeps the
 * authority: only the newest probe of a server counts, OpenClaw tool names are derived here (never taken from
 * the cell), annotations only make a tool safer when they say so explicitly, and a failure detail is redacted
 * of every header value before it is stored (modules/mcp `recordProbeResult`). Unknown server (or another
 * organization's: RLS) → 404 `mcp_server_not_found`. A stale report answers 200 and changes nothing, so a cell
 * retrying after a timeout never fails loudly.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];

export function registerMcpCellRoutes(scope: App, core: Core): void {
  scope.post(
    "/mcp/probe-results",
    {
      config: { authz: "cell" as const },
      schema: { tags, security: bearer, body: AgentChannelMcpProbeResult, response: { 200: Ok } },
    },
    async (req) => {
      const cell = cellOf(req);
      await core.db.withTenant({ organizationId: cell.organizationId, userId: null }, (tx) =>
        recordProbeResult(core, tx, req.body),
      );
      return { ok: true as const };
    },
  );
}
