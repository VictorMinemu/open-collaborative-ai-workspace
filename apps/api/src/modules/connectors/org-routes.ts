import {
  ClientCredentialsInput,
  ConnectorAuthFailure,
  ConnectStartResponse,
  IdParams,
  McpServer,
  type OrgSignInError,
} from "@ocw/contracts";
import type { mcpServers, Tx } from "@ocw/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type App, type AuthContext, authOf, type Core, tenant } from "../../core";
import { egressFor } from "../../lib/egress";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import { getMcpServer, mcpReadOptions, setAuthFailure, setOAuthStatus } from "../mcp";
import { orgResource, type PermissionService } from "../organization";
import {
  ccBundleFrom,
  clientSecretFor,
  disconnectOrg,
  oauthBundleOf,
  orgAccountServer,
  orgClientCredentialsOf,
  storeOrgConnection,
} from "./credentials";
import { authFailureOf } from "./diagnosis";
import { type FlowRecord, flowAuth, settingsUrl, startOAuthFlow } from "./flow";
import {
  type ClientCredentialsToken,
  ConnectorOAuthError,
  clientCredentialsGrant,
  discoverTokenEndpoint,
  exchangeCode,
  revokeToken,
  type TokenBundle,
  type TokenEndpointDiscovery,
} from "./oauth";
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
 * Organization connection routes (Phase 07.14, D-02, D-05, D-06, D-08; COA-01, COA-03), all `mcp.manage`: an admin
 * connects the organization's shared account once through the one OAuth callback (`completeOrgSignIn`), and every
 * member's bots use it wherever organization tools are allowed; Disconnect revokes it at the provider. Another
 * organization's server id is a 404 (tenant RLS). No response or redirect carries a token, refresh token, code,
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

  // Client credentials (D-03, D-05, D-06, PD-07): discover → grant → seal → probe. The secret is write-only.
  app.put(
    "/connectors/:id/org-connection/client-credentials",
    {
      ...admin,
      logLevel: "info",
      schema: { tags, params: IdParams, body: ClientCredentialsInput, response: { 200: McpServer } },
    },
    async (req) => saveClientCredentials(core, req, req.params.id, req.body),
  );

  // Disconnect (D-08): revoke at the provider first, then forget the account. 404 `not_connected` when there is none.
  app.delete(
    "/connectors/:id/org-connection",
    { ...admin, logLevel: "info", schema: { tags, params: IdParams } },
    async (req, reply) => {
      const auth = authOf(req);
      await core.db.withTenant(tenant(req), (tx) => orgServerIn(tx, req.params.id));
      const done = await disconnectOrg(core, {
        organizationId: auth.organizationId,
        serverId: req.params.id,
        actingUserId: auth.userId,
      });
      if (!done) throw notFound("The organization isn't connected to this connector", "not_connected");
      return reply.code(204).send();
    },
  );
}

/**
 * `PUT /connectors/:id/org-connection/client-credentials` (07.14 D-03, D-05, D-06, D-15, PD-07). The secret is the
 * body's, else the stored one for the same client id (a new client id needs its secret: 400 `secret_required`). The
 * token endpoint is the published one (RFC 9728 → RFC 8414, the issuer pinned), else the admin's Token URL (or the
 * one saved before), checked by `trusted()` before the secret is sent. A refused discovery or grant answers 409 whose
 * `code` is the D-10 failure, records it as `auth_failure` in its own transaction and stores nothing. A grant is sealed
 * for the organization with the server row held (`connected_by` = the admin), audited `connector.org_connected`,
 * `auth_failure` cleared; then the tools are listed with the new token. Nothing returned or logged carries the secret
 * or the token.
 */
async function saveClientCredentials(
  core: Core,
  req: FastifyRequest,
  serverId: string,
  body: ClientCredentialsInput,
): Promise<McpServer> {
  const auth = authOf(req);
  const ctx = tenant(req);
  const { server, stored } = await core.db.withTenant(ctx, async (tx) => ({
    server: await orgServerIn(tx, serverId, "org_client_credentials"),
    stored: await orgClientCredentialsOf(tx, core, serverId),
  }));
  // Omitted = keep the stored secret, for the same client only (another client's secret is never reused).
  const clientSecret =
    body.clientSecret ?? (stored?.clientId === body.clientId ? stored.clientSecret : undefined);
  if (!clientSecret) throw badRequest("Enter this client's secret", "secret_required");

  const refused = async (err: unknown): Promise<never> => {
    const code = authFailureOf(err);
    req.log.info({ serverId, code, principal: "organization" }, "client credentials refused");
    await core.db
      .withTenant(ctx, async (tx) => {
        await core.audit.record(tx, {
          action: "connector.connect_failed",
          resourceType: "mcp_server",
          resourceId: serverId,
          metadata: { serverId, code, principal: "organization", method: "client_credentials" },
        });
        if (await orgAccountServer(tx, serverId)) await setAuthFailure(tx, serverId, code);
      })
      .catch(() => {});
    throw new HttpError(409, code, "The client-credentials check failed");
  };

  const egress = egressFor(core.env);
  const scopes = [...(server.oauthScopes ?? [])];
  let disc: TokenEndpointDiscovery;
  let tokenEndpoint: string;
  let token: ClientCredentialsToken;
  try {
    if (!server.url) throw new ConnectorOAuthError("discovery_failed", { step: "discovery_failed" });
    disc = await discoverTokenEndpoint(egress, server.url);
    // Published metadata wins; without it the admin's Token URL is required (or the admin-entered one saved before).
    const endpoint =
      disc.tokenEndpoint ??
      body.tokenEndpoint ??
      (stored && stored.issuer === null ? stored.tokenEndpoint : undefined);
    if (!endpoint) throw new ConnectorOAuthError("discovery_failed", { step: "discovery_failed" });
    tokenEndpoint = endpoint;
    token = await clientCredentialsGrant(egress, {
      tokenEndpoint,
      issuer: disc.issuer,
      resource: disc.resource,
      sameOrigin: disc.sameOrigin,
      mcpOrigin: disc.mcpOrigin,
      clientId: body.clientId,
      clientSecret,
      scopes,
      authMethods: disc.authMethods,
    });
  } catch (err) {
    return refused(err);
  }

  const bundle = ccBundleFrom(disc, { clientId: body.clientId, clientSecret, tokenEndpoint, scopes }, token);
  const saved = await core.db.withTenant(ctx, async (tx) => {
    // The server row is held until commit: a concurrent mode switch or delete waits, or has already happened.
    const current = await orgAccountServer(tx, serverId, true);
    if (current?.authMode !== "org_client_credentials") return false;
    const row = await storeOrgConnection(tx, core, {
      serverId,
      connectedBy: auth.userId,
      bundle,
      grantedScopes: token.scopes,
    });
    if (current.authFailure !== null) await setAuthFailure(tx, serverId, null);
    await core.audit.record(tx, {
      action: "connector.org_connected",
      resourceType: "connector_org_connection",
      resourceId: row.id,
      metadata: { serverId, method: "client_credentials", issuer: bundle.issuer },
    });
    return true;
  });
  if (!saved) throw conflict("This connector no longer uses client credentials", "wrong_auth_mode");
  // Always probe with the organization's new token (D-05): the catalog follows the client now in use.
  await probeConnector(
    core,
    { organizationId: auth.organizationId, userId: auth.userId, serverId },
    { headerName: "Authorization", headerValue: `Bearer ${token.accessToken}` },
  );
  return core.db.withTenant(ctx, (tx) => getMcpServer(tx, serverId, mcpReadOptions(core)));
}

/**
 * A failed organization sign-in: audited `connector.connect_failed` with `principal: organization` in the flow's
 * tenant, then the browser goes back to Settings › MCP servers with the closed code. A D-10 code is also recorded as
 * the server's `auth_failure` (D-10, D-15), while the server is still an organization-account one; `access_denied`,
 * `flow_expired` and `session_mismatch` never are (they say nothing about the provider's setup).
 */
export async function orgSignInFailed(
  core: Core,
  req: FastifyRequest,
  reply: FastifyReply,
  flow: FlowRecord,
  code: OrgSignInError,
) {
  req.log.info({ serverId: flow.serverId, code, principal: "organization" }, "connector callback refused");
  const failure = ConnectorAuthFailure.safeParse(code);
  await core.db
    .withTenant({ organizationId: flow.organizationId, userId: flow.userId }, async (tx) => {
      await core.audit.record(tx, {
        action: "connector.connect_failed",
        resourceType: "mcp_server",
        resourceId: flow.serverId,
        metadata: { serverId: flow.serverId, code, principal: "organization" },
      });
      if (failure.success && (await orgAccountServer(tx, flow.serverId))) {
        await setAuthFailure(tx, flow.serverId, failure.data);
      }
    })
    .catch(() => {});
  return reply.redirect(settingsUrl(core, "organization", { error: code, connector: flow.serverId }), 302);
}

/**
 * The organization branch of `GET /connectors/oauth/callback` (07.14 PD-06), called after the shared checks (the flow
 * consumed first, the session's user and organization equal the flow's, RFC 9207 `iss`). The admin must still hold
 * `mcp.manage` (re-decided now, as `requirePermission` decides it: a demotion within the 10 minutes is a
 * `session_mismatch`). `error=invalid_scope` is `scope_rejected` here (members keep `token_exchange_failed`). Redeems
 * the code against the flow's issuer, seals the bundle for the organization (`storeOrgConnection`, `connected_by` = the admin) and audits
 * `connector.org_connected` in one tenant transaction that holds the server row, then lists the tools with the new
 * token and sends the admin back to Settings › MCP servers. A server that left `org_oauth` meanwhile stores nothing
 * (`flow_expired`); a grant that could not be stored is revoked at its issuer.
 */
export async function completeOrgSignIn(
  core: Core,
  perms: PermissionService,
  req: FastifyRequest,
  reply: FastifyReply,
  flow: FlowRecord,
  session: Pick<AuthContext, "sessionId" | "clientKind">,
  q: { code?: string | undefined; error?: string | undefined },
) {
  const failed = (code: OrgSignInError) => orgSignInFailed(core, req, reply, flow, code);
  const ctx = {
    organizationId: flow.organizationId,
    userId: flow.userId,
    sessionId: session.sessionId,
    clientKind: session.clientKind,
  };
  // T-07.14-07-01: only an admin who still manages MCP servers completes the organization's sign-in.
  const decision = await core.db
    .withTenant(ctx, (tx) =>
      perms.decide(tx, { kind: "user", userId: flow.userId }, "mcp.manage", orgResource()),
    )
    .catch(() => ({ allowed: false }));
  if (!decision.allowed) return failed("session_mismatch");
  if (q.error) {
    return failed(
      q.error === "access_denied"
        ? "access_denied"
        : q.error === "invalid_scope"
          ? "scope_rejected"
          : "token_exchange_failed",
    );
  }
  if (!q.code) return failed("token_exchange_failed");

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
  } catch (err) {
    return failed(authFailureOf(err));
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
