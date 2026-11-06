import type { ApiModule, Core } from "../../core";
import { createPermissionService } from "../organization";
import { registerOrgConnectionRoutes } from "./org-routes";
import { registerConnectorRoutes } from "./routes";

export {
  type AccessToken,
  accessTokenFor,
  type ConnectionKey,
  ConnectorTokenUnavailableError,
  type CredentialKey,
  connectionAad,
  connectionStatusFor,
  credentialKeyOf,
  credentialStatusFor,
  disconnectOrg,
  forceRefresh,
  isOrgKey,
  markNeedsReconnect,
  type OrgConnectionKey,
  orgAccountServer,
  orgConnectionAad,
  reconnectReasonOf,
  storeOrgConnection,
  touchConnection,
  touchCredential,
} from "./credentials";
export { callTool, listTools, type McpAuth, McpUpstreamError, stripControl } from "./mcp-client";
export { activeShare, readersOf } from "./shares";

/**
 * connectors module (Phase 07.4, D-01 … D-03, D-07 item 4; CONN-01 … CONN-03): the member side of per-member
 * connectors. Members connect their own account (OAuth through the API's own callback, or a key pasted once), the
 * credential is sealed per member and refreshed serially, a dead grant asks to reconnect, and a disconnect revokes at
 * the provider. The first connection probes the server's tools API-side.
 *
 * Phase 07.14 (D-02, D-05 … D-08): the same custody for a second principal, the organization. An admin (`mcp.manage`)
 * connects an `org_oauth` server's shared account once through the same callback; it is sealed for the organization
 * (`orgConnectionAad`), refreshed serially (`orgRefreshLockKey`), and revoked at the provider on Disconnect.
 *
 * Routes (under /api/v1): GET `/connectors` (member-mode servers only), POST `/connectors/:id/connect`,
 * PUT `/connectors/:id/secret`, DELETE `/connectors/:id/connection` (`connector.connect`); POST
 * `/connectors/:id/probe` (`mcp.manage`: the caller's own connection, or the organization's for an org mode);
 * POST `/connectors/:id/org-connection/connect`, DELETE `/connectors/:id/org-connection` (`mcp.manage`); public GET
 * `/connectors/oauth/callback` and `/connectors/oauth/client-metadata.json`; GET/POST `/member-account-shares`,
 * GET `/member-account-shares/preview`, DELETE `/member-account-shares/:id`.
 *
 * For the connector proxy (07.4-11/12, 07.14-08): `credentialKeyOf`, `accessTokenFor`, `forceRefresh`,
 * `markNeedsReconnect`, `credentialStatusFor`, `touchCredential` (both principals), `connectionStatusFor`,
 * `touchConnection`, `activeShare`.
 */
export function createConnectorsModule(core: Core): ApiModule {
  const perms = createPermissionService(core);
  return {
    name: "connectors",
    register(app) {
      registerConnectorRoutes(app, core, perms);
      registerOrgConnectionRoutes(app, core, perms);
    },
  };
}
