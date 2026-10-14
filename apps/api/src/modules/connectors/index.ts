import type { ApiModule, Core } from "../../core";
import { createPermissionService } from "../organization";
import { registerConnectorRoutes } from "./routes";

export {
  type AccessToken,
  accessTokenFor,
  type ConnectionKey,
  ConnectorTokenUnavailableError,
  connectionAad,
  connectionStatusFor,
  forceRefresh,
  markNeedsReconnect,
  reconnectReasonOf,
  touchConnection,
} from "./credentials";
export { callTool, listTools, McpUpstreamError } from "./mcp-client";
export { activeShare, readersOf } from "./shares";

/**
 * connectors module (Phase 07.4, D-01 … D-03, D-07 item 4; CONN-01 … CONN-03): the member side of per-member
 * connectors. Members connect their own account (OAuth through the API's own callback, or a key pasted once), the
 * credential is sealed per member and refreshed serially, a dead grant asks to reconnect, and a disconnect revokes at
 * the provider. The first connection probes the server's tools API-side.
 *
 * Routes (under /api/v1): GET `/connectors`, POST `/connectors/:id/connect`, PUT `/connectors/:id/secret`,
 * DELETE `/connectors/:id/connection` (`connector.connect`); POST `/connectors/:id/probe` (`mcp.manage`, the caller's
 * own connection); public GET `/connectors/oauth/callback` and `/connectors/oauth/client-metadata.json`;
 * GET/POST `/member-account-shares`, GET `/member-account-shares/preview`, DELETE `/member-account-shares/:id`.
 *
 * For the connector proxy (07.4-11/12): `accessTokenFor`, `forceRefresh`, `markNeedsReconnect`,
 * `connectionStatusFor`, `touchConnection`, `activeShare`.
 */
export function createConnectorsModule(core: Core): ApiModule {
  const perms = createPermissionService(core);
  return {
    name: "connectors",
    register(app) {
      registerConnectorRoutes(app, core, perms);
    },
  };
}
