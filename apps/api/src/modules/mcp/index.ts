import type { ApiModule, Core } from "../../core";
import { createPermissionService } from "../organization";
import { registerMcpRoutes } from "./routes";

export { cellEnvName, openclawToolName, openclawToolNames, safeServerName } from "./names";
export {
  cellMcpServers,
  createMcpServer,
  type DiscoveredTool,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  type McpReadOptions,
  mcpReadOptions,
  oauthClientsOf,
  orgSecretHeaders,
  probeMcpServer,
  reconnectReasonOfCode,
  recordProbeResult,
  replaceServerTools,
  requestProbe,
  sandboxInfo,
  setAuthFailure,
  setOAuthStatus,
  updateMcpServer,
} from "./service";
export { checkMcpUrl, type McpUrlCheck } from "./url-policy";

/**
 * mcp module (Phase 3.1, D-13; BOT-08, BOT-10): the organization's MCP server registry. Admins (`mcp.manage`)
 * register remote servers (or a vetted server of the stdio sandbox) with write-only header credentials; the
 * cell discovers their tools (`mcp.probe`); recorded tools join the bot capability catalog.
 *
 * Routes (all `authz: user` + `mcp.manage`): GET/POST `/mcp-servers`, GET/PATCH/DELETE `/mcp-servers/:id`,
 * POST `/mcp-servers/:id/probe`. The cell side (`/cell` mcpServers, probe-result route) is 03.1-10.
 *
 * Phase 07.4 (D-01): each server has an auth mode. `org_secret` servers are rendered in the cell as before;
 * `per_member_oauth` / `per_member_secret` connectors never are (the connectors module calls them with the member's
 * own credential and records their tools through `replaceServerTools`).
 *
 * Phase 07.14 (D-01): `org_oauth` / `org_client_credentials` servers use one organization account, also called by the
 * connectors module and never rendered in the cell. The registry shows that connection (`orgConnection`) and the last
 * sign-in failure (`authFailure`, written through `setAuthFailure`), and asks before a mode switch or a delete
 * destroys it (409 `org_connection_exists`).
 */
export function createMcpModule(core: Core): ApiModule {
  const perms = createPermissionService(core);
  return {
    name: "mcp",
    register(app) {
      registerMcpRoutes(app, core, perms);
    },
  };
}
