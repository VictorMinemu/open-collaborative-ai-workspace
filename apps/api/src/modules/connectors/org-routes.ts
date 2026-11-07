import {
  ClientCredentialsInput,
  ConnectorAuthFailure,
  ConnectStartResponse,
  connectorOAuthUrls,
  IdParams,
  McpServer,
  OAuthTestRequest,
  OAuthTestResponse,
  type OrgSignInError,
} from "@ocw/contracts";
import { mcpServers, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type App, type AuthContext, authOf, type Core, tenant } from "../../core";
import { egressFor } from "../../lib/egress";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors";
import { checkMcpUrl, getMcpServer, mcpReadOptions, setAuthFailure, setOAuthStatus } from "../mcp";
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
import { authFailureOf, type DiagnoseInput, diagnose } from "./diagnosis";
import { type FlowRecord, flowAuth, serverClientsOf, settingsUrl, startOAuthFlow } from "./flow";
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
/**
 * Calls per admin per minute, per route, of the routes that reach admin-chosen URLs: Test sign-in, the
 * client-credentials save and organization Connect (T-07.14-09-04, review WR-01: not a port scanner).
 */
const ORG_OUTBOUND_PER_MINUTE = 10;

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
  /**
   * An `mcp.manage` route that reaches admin-chosen URLs (discovery, a token endpoint, DCR), limited per admin (07.14
   * T-07.14-09-04, review WR-01: not a port scanner). The bucket is counted after requireUser and mcp.manage, so it is
   * the admin's, not the IP's. Each route gets a COPY of the preHandler array: the rate-limit plugin appends its hook to
   * the route's own array, which must never be the shared one (plan 09's fix).
   */
  const limitedAdmin = (bucket: string) => ({
    config: {
      authz: "user" as const,
      rateLimit: {
        max: ORG_OUTBOUND_PER_MINUTE,
        timeWindow: "1 minute",
        hook: "preHandler" as const,
        keyGenerator: (r: FastifyRequest) => `${bucket}:${r.auth?.userId ?? r.ip}`,
      },
    },
    preHandler: [...admin.preHandler],
  });

  app.post(
    "/connectors/:id/org-connection/connect",
    {
      ...limitedAdmin("org-connect"),
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
      ...limitedAdmin("org-cc"),
      logLevel: "info",
      schema: { tags, params: IdParams, body: ClientCredentialsInput, response: { 200: McpServer } },
    },
    async (req) => saveClientCredentials(core, req, req.params.id, req.body),
  );

  // Test sign-in (D-10, D-18, PD-08): a dry run on unsaved or saved values; writes nothing, registers nothing.
  app.post(
    "/connectors/oauth-test",
    {
      ...limitedAdmin("oauth-test"),
      logLevel: "info",
      schema: { tags, body: OAuthTestRequest, response: { 200: OAuthTestResponse } },
    },
    async (req) => testSignIn(core, req, req.body),
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
 * `POST /connectors/oauth-test` (07.14 D-10, D-18, PD-08): loads the values to check and calls `diagnose`, nothing
 * else. The URL is the form's (checked as the registry checks it, before any request) or the saved server's; a saved
 * server is read in the caller's tenant only (another organization's id is a 404, its stored values never used). Its
 * stored clients, and for client credentials its stored client and secret, fill in what the form omits, and only
 * against the saved target (stored secrets are write-only, ADR-0025): the saved URL, the same client id and Token URL,
 * and, for a stored secret, the saved issuer and endpoint as discovered now (`pin`). A form Token URL meets the
 * registry's URL policy first. Scopes are the form's, else the server's. Reads only: no row, client, secret,
 * `auth_failure` or `oauth_status` is written and no client is registered. The answer is `diagnose`'s (closed codes,
 * no token, secret or provider text); the log line carries the outcome code only.
 */
async function testSignIn(
  core: Core,
  req: FastifyRequest,
  body: OAuthTestRequest,
): Promise<OAuthTestResponse> {
  const loaded = await core.db.withTenant(tenant(req), async (tx) => {
    let server: ServerRow | null = null;
    if (body.serverId !== undefined) {
      const [row] = await tx.select().from(mcpServers).where(eq(mcpServers.id, body.serverId)).limit(1);
      if (!row) throw notFound("Connector not found", "connector_not_found");
      server = row;
    }
    return {
      server,
      // A dry run never sends an OAuth client secret, so none is decrypted (IN-04).
      clients: server
        ? await serverClientsOf(tx, core, server.id, { revealSecrets: false })
        : { preRegistered: [], stored: [] },
      cc:
        server && body.authMode === "org_client_credentials"
          ? await orgClientCredentialsOf(tx, core, server.id)
          : null,
    };
  });
  const { server } = loaded;
  const serverUrl = body.url ?? server?.url ?? null;
  if (!serverUrl) throw badRequest("A URL is required to test a sign-in", "url_required");
  const check = checkMcpUrl(serverUrl);
  if (!check.ok) throw badRequest(check.reason, "invalid_url");
  const formEndpoint = body.clientCredentials?.tokenEndpoint;
  if (formEndpoint !== undefined) {
    // The admin's Token URL meets the registry's URL policy before any request (trusted() and the guard follow).
    const endpointCheck = checkMcpUrl(formEndpoint);
    if (!endpointCheck.ok) throw badRequest(endpointCheck.reason, "invalid_url");
  }
  // Stored secrets are write-only: the saved server's clients and secret are used only against its saved target. A
  // changed URL is another target, tested with what the form supplies alone.
  const savedTarget = server !== null && (body.url === undefined || body.url === server.url);
  const clients = savedTarget ? loaded.clients : { preRegistered: [], stored: [] };

  // The form's client for its issuer first; the saved ones for the others.
  const formClient = body.oauthClient;
  const preRegistered = formClient
    ? [
        {
          issuer: formClient.issuer,
          clientId: formClient.clientId,
          ...(formClient.clientSecret ? { clientSecret: formClient.clientSecret } : {}),
        },
        ...clients.preRegistered.filter((c) => c.issuer !== formClient.issuer),
      ]
    : clients.preRegistered;

  let cc: DiagnoseInput["cc"];
  if (body.authMode === "org_client_credentials") {
    const form = body.clientCredentials;
    const saved = savedTarget ? loaded.cc : null;
    const clientId = form?.clientId ?? saved?.clientId;
    // The stored secret: same client, same Token URL (omitted or repeated), and pinned to the saved issuer and endpoint.
    const keep =
      saved !== null &&
      saved.clientId === clientId &&
      (formEndpoint === undefined || formEndpoint === saved.tokenEndpoint);
    const clientSecret = form?.clientSecret ?? (keep ? saved.clientSecret : undefined);
    const tokenEndpoint = formEndpoint ?? (saved && saved.issuer === null ? saved.tokenEndpoint : undefined);
    const pin =
      form?.clientSecret === undefined && keep && saved
        ? { issuer: saved.issuer, tokenEndpoint: saved.tokenEndpoint }
        : undefined;
    // Always passed: the Token URL still drives discovery when there is no secret to try (the token step fails then).
    cc = {
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      ...(pin ? { pin } : {}),
    };
  }

  const result = await diagnose(egressFor(core.env), {
    serverUrl,
    mode: body.authMode,
    urls: connectorOAuthUrls(core.env.OCW_PUBLIC_API_URL),
    preRegistered,
    storedClients: clients.stored,
    allowCimd: body.oauthUseCimd ?? server?.oauthUseCimd ?? true,
    scopes: [...(body.oauthScopes ?? server?.oauthScopes ?? [])],
    ...(cc ? { cc } : {}),
    ...(body.pageOrigin !== undefined ? { pageOrigin: body.pageOrigin } : {}),
  });
  req.log.info(
    { serverId: server?.id ?? null, mode: body.authMode, failure: result.failure },
    "connector sign-in tested",
  );
  return result;
}

/**
 * The client-credentials save route (07.14 D-03, D-05, D-06, D-15, PD-07). The secret is the
 * body's, else the stored one for the same client id (a new client id needs its secret: 400 `secret_required`). The
 * token endpoint is the published one (RFC 9728 → RFC 8414, the issuer pinned), else the admin's Token URL (or the
 * one saved before), checked by the registry's URL policy and `trusted()` before the secret is sent. A kept secret
 * goes only to the issuer and token endpoint it was saved for (else 400 `secret_required`, nothing sent: stored
 * secrets are write-only, ADR-0025). A refused discovery or grant answers 409 whose
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
  // The admin's Token URL meets the registry's URL policy before any request (trusted() and the guard follow).
  if (body.tokenEndpoint !== undefined && !checkMcpUrl(body.tokenEndpoint).ok) {
    return refused(new ConnectorOAuthError("token_exchange_failed", { step: "token_endpoint_untrusted" }));
  }
  let disc: TokenEndpointDiscovery;
  let tokenEndpoint: string;
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
  } catch (err) {
    return refused(err);
  }
  // A kept (stored) secret is write-only: it goes only to the issuer and token endpoint it was saved for. Another
  // Token URL, or a server whose issuer or endpoint changed since, needs the secret typed again.
  if (
    body.clientSecret === undefined &&
    (stored?.issuer !== disc.issuer || stored?.tokenEndpoint !== tokenEndpoint)
  ) {
    throw badRequest("Enter this client's secret again: its token endpoint changed", "secret_required");
  }
  let token: ClientCredentialsToken;
  try {
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
    if (current?.authMode !== "org_client_credentials") return "wrong_mode";
    // The token was granted for the URL read before the grant: a URL changed since is another target (CR-01).
    if (current.url !== server.url) return "url_changed";
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
    return "stored";
  });
  if (saved === "wrong_mode") {
    throw conflict("This connector no longer uses client credentials", "wrong_auth_mode");
  }
  if (saved === "url_changed") {
    throw conflict(
      "This connector's URL changed while saving. Save its client credentials again.",
      "url_changed",
    );
  }
  // Always probe with the organization's new token (D-05): the catalog follows the client now in use.
  await probeConnector(
    core,
    { organizationId: auth.organizationId, userId: auth.userId, serverId },
    { headerName: "Authorization", headerValue: `Bearer ${token.accessToken}`, url: server.url ?? "" },
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
 * token and sends the admin back to Settings › MCP servers. A server that left `org_oauth`, or whose URL is no longer
 * the one the flow started on (CR-01), stores nothing (`flow_expired`); a grant that could not be stored is revoked at
 * its issuer.
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
    // A server whose URL changed since the flow started is another target: the code is never redeemed (CR-01).
    if (server?.authMode !== "org_oauth" || server.url !== flow.discovered.serverUrl) return null;
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
      if (server?.authMode !== "org_oauth" || server.url !== flow.discovered.serverUrl) return "gone";
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
  // Always probe with the organization's new token (D-05): the catalog follows the account that is now connected. It
  // never throws (IN-05): the connection is stored, so the admin lands on the page, with a note when it failed.
  const probe = await probeConnector(
    core,
    { organizationId: flow.organizationId, userId: flow.userId, serverId: flow.serverId },
    {
      headerName: "Authorization",
      headerValue: `Bearer ${bundle.accessToken}`,
      url: flow.discovered.serverUrl,
    },
  );
  return reply.redirect(
    settingsUrl(core, "organization", {
      connected: flow.serverId,
      ...(probe.ok ? {} : { probe: "failed" }),
    }),
    302,
  );
}
