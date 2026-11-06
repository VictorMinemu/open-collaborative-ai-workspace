import { ConnectStartResponse, IdParams, type OrgSignInError } from "@ocw/contracts";
import type { mcpServers, Tx } from "@ocw/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type App, type AuthContext, type Core, tenant } from "../../core";
import { egressFor } from "../../lib/egress";
import { conflict, notFound } from "../../lib/errors";
import { setAuthFailure, setOAuthStatus } from "../mcp";
import type { PermissionService } from "../organization";
import { clientSecretFor, oauthBundleOf, orgAccountServer, storeOrgConnection } from "./credentials";
import { type FlowRecord, flowAuth, settingsUrl, startOAuthFlow } from "./flow";
import { exchangeCode, revokeToken, type TokenBundle } from "./oauth";
import { probeConnector } from "./probe";

const tags = ["connectors"];
type ServerRow = typeof mcpServers.$inferSelect;

/** An organization-account server of the caller's organization, in `mode` when given: 404 when absent, 409 otherwise. */
async function orgServerIn(tx: Tx, id: string, mode?: ServerRow["authMode"]): Promise<ServerRow> {
  const server = await orgAccountServer(tx, id);
  if (!server) throw notFound("Connector not found", "connector_not_found");
  if (mode && server.authMode !== mode) {
    throw conflict(
      mode === "org_oauth"
        ? "This connector uses client credentials, not a sign-in"
        : "This connector signs in with an account, not client credentials",
      "wrong_auth_mode",
    );
  }
  return server;
}

/**
 * Organization connection routes (Phase 07.14, D-02, D-05, D-06; COA-01, COA-03), all `mcp.manage`: an admin connects
 * the organization's shared account once through the one OAuth callback (`completeOrgSignIn`), and every member's bots
 * use it wherever organization tools are allowed. No response or redirect carries a token, refresh token, code,
 * verifier or client secret: redirects carry a connector id or an `OrgSignInError`.
 */
export function registerOrgConnectionRoutes(app: App, core: Core, perms: PermissionService): void {
  const admin = {
    config: { authz: "user" as const },
    preHandler: [core.identity.requireUser, perms.requirePermission("mcp.manage")],
  };

  app.post(
    "/connectors/:id/org-connection/connect",
    {
      ...admin,
      logLevel: "info",
      schema: { tags, params: IdParams, response: { 200: ConnectStartResponse } },
    },
    async (req) => {
      const server = await core.db.withTenant(tenant(req), (tx) =>
        orgServerIn(tx, req.params.id, "org_oauth"),
      );
      return startOAuthFlow(core, req, { server, principal: "organization" });
    },
  );
}

/**
 * A failed organization sign-in: audited `connector.connect_failed` with `principal: organization` in the flow's
 * tenant, then the browser goes back to Settings › MCP servers with the closed code.
 */
export async function orgSignInFailed(
  core: Core,
  req: FastifyRequest,
  reply: FastifyReply,
  flow: FlowRecord,
  code: OrgSignInError,
) {
  req.log.info({ serverId: flow.serverId, code, principal: "organization" }, "connector callback refused");
  await core.db
    .withTenant({ organizationId: flow.organizationId, userId: flow.userId }, (tx) =>
      core.audit.record(tx, {
        action: "connector.connect_failed",
        resourceType: "mcp_server",
        resourceId: flow.serverId,
        metadata: { serverId: flow.serverId, code, principal: "organization" },
      }),
    )
    .catch(() => {});
  return reply.redirect(settingsUrl(core, "organization", { error: code, connector: flow.serverId }), 302);
}

/**
 * The organization branch of `GET /connectors/oauth/callback` (07.14 PD-06), called after the shared checks (the flow
 * consumed first, the session's user and organization equal the flow's, RFC 9207 `iss`). Redeems the code against the
 * flow's issuer, seals the bundle for the organization (`storeOrgConnection`, `connected_by` = the admin) and audits
 * `connector.org_connected` in one tenant transaction that holds the server row, then lists the tools with the new
 * token and sends the admin back to Settings › MCP servers. A server that left `org_oauth` meanwhile stores nothing
 * (`flow_expired`); a grant that could not be stored is revoked at its issuer.
 */
export async function completeOrgSignIn(
  core: Core,
  _perms: PermissionService,
  req: FastifyRequest,
  reply: FastifyReply,
  flow: FlowRecord,
  session: Pick<AuthContext, "sessionId" | "clientKind">,
  q: { code?: string | undefined; error?: string | undefined },
) {
  const failed = (code: OrgSignInError) => orgSignInFailed(core, req, reply, flow, code);
  if (q.error) return failed(q.error === "access_denied" ? "access_denied" : "token_exchange_failed");
  if (!q.code) return failed("token_exchange_failed");

  const ctx = {
    organizationId: flow.organizationId,
    userId: flow.userId,
    sessionId: session.sessionId,
    clientKind: session.clientKind,
  };
  const prepared = await core.db.withTenant(ctx, async (tx) => {
    const server = await orgAccountServer(tx, flow.serverId);
    if (server?.authMode !== "org_oauth") return null;
    return {
      clientSecret: await clientSecretFor(tx, core, flow.serverId, flow.client.issuer, flow.client.clientId),
    };
  });
  if (!prepared) return failed("flow_expired");
  const { d, client } = flowAuth(flow, prepared.clientSecret);
  const egress = egressFor(core.env);
  let bundle: TokenBundle;
  try {
    bundle = await exchangeCode(egress, d, client, {
      code: q.code,
      codeVerifier: flow.verifier,
      redirectUri: flow.redirectUri,
      ...(flow.scope ? { scope: flow.scope } : {}),
    });
  } catch {
    return failed("token_exchange_failed");
  }

  let stored: "stored" | "gone" | "failed";
  try {
    stored = await core.db.withTenant(ctx, async (tx) => {
      // The server row is held until commit: a concurrent mode switch or delete waits, or has already happened.
      const server = await orgAccountServer(tx, flow.serverId, true);
      if (server?.authMode !== "org_oauth") return "gone";
      const row = await storeOrgConnection(tx, core, {
        serverId: flow.serverId,
        connectedBy: flow.userId,
        bundle: oauthBundleOf(bundle),
      });
      if (server.oauthStatus === "needs_client" || server.oauthStatus === "error") {
        await setOAuthStatus(tx, server.id, null);
      }
      if (server.authFailure !== null) await setAuthFailure(tx, server.id, null);
      await core.audit.record(tx, {
        action: "connector.org_connected",
        resourceType: "connector_org_connection",
        resourceId: row.id,
        metadata: { serverId: flow.serverId, method: "oauth", issuer: bundle.issuer },
      });
      return "stored";
    });
  } catch {
    stored = "failed";
  }
  if (stored !== "stored") {
    // Nothing was stored: do not leave a live grant behind at the provider.
    await revokeToken(egress, bundle, prepared.clientSecret);
    return failed(stored === "gone" ? "flow_expired" : "token_exchange_failed");
  }
  // Always probe with the organization's new token (D-05): the catalog follows the account that is now connected.
  await probeConnector(
    core,
    { organizationId: flow.organizationId, userId: flow.userId, serverId: flow.serverId },
    { headerName: "Authorization", headerValue: `Bearer ${bundle.accessToken}` },
  );
  return reply.redirect(settingsUrl(core, "organization", { connected: flow.serverId }), 302);
}
