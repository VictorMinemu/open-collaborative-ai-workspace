import {
  type ConnectorErrorCode,
  ConnectSecretRequest,
  ConnectStartResponse,
  CreateMemberAccountShareRequest,
  connectorOAuthUrls,
  IdParams,
  McpServer,
  MemberAccountShare,
  MemberAccountShareList,
  type MemberConnector,
  MemberConnectorList,
  MemberConnector as MemberConnectorSchema,
  PER_MEMBER_MODES,
  ReadersPreview,
} from "@ocw/contracts";
import { connectorConnections, mcpServers, mcpServerTools, type Tx } from "@ocw/db";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import { egressFor } from "../../lib/egress";
import { conflict, HttpError, notFound } from "../../lib/errors";
import { createConversationAccess } from "../chat";
import { getMcpServer, mcpReadOptions, setOAuthStatus } from "../mcp";
import type { PermissionService } from "../organization";
import { clientMetadataDocument } from "./client-metadata";
import {
  accessTokenFor,
  ConnectorTokenUnavailableError,
  clientSecretFor,
  disconnect,
  oauthBundleOf,
  perMemberServer,
  reconnectReasonOf,
  storeConnection,
} from "./credentials";
import {
  CONNECTOR_CLIENT_NAME,
  connectError,
  connectFlowKey,
  FlowRecord,
  flowAuth,
  STATE_RE,
  settingsUrl,
  startOAuthFlow,
} from "./flow";
import {
  ConnectorOAuthError,
  checkCallbackIssuer,
  type DiscoveredAuth,
  exchangeCode,
  revokeToken,
  type TokenBundle,
} from "./oauth";
import { completeOrgSignIn, orgSignInFailed } from "./org-routes";
import { probeConnector } from "./probe";
import { createShare, listShares, previewReaders, revokeShare, type SharesDeps } from "./shares";

const tags = ["connectors"];

// Moved to `flow.ts` (07.14 PD-06); re-exported so existing imports keep working.
export { CONNECT_FLOW_TTL_S, CONNECTOR_CLIENT_NAME, connectFlowKey } from "./flow";

/** Query of the authorization response. Only these fields are read; `error_description` is never used or shown. */
const CallbackQuery = z.object({
  state: z.string().max(512).optional(),
  code: z.string().max(4096).optional(),
  iss: z.string().max(2048).optional(),
  error: z.string().max(256).optional(),
});

type ServerRow = typeof mcpServers.$inferSelect;
type ConnectionRow = typeof connectorConnections.$inferSelect;

function oauthStatusOf(core: Core, server: ServerRow): MemberConnector["oauthStatus"] {
  if (server.authMode !== "per_member_oauth") return null;
  if (!connectorOAuthUrls(core.env.OCW_PUBLIC_API_URL).oauthAvailable) return "https_required";
  return server.oauthStatus ?? "ready";
}

function memberConnectorOf(core: Core, server: ServerRow, row: ConnectionRow | null): MemberConnector {
  const key = server.authMode === "per_member_secret";
  return {
    serverId: server.id,
    name: server.name,
    safeName: server.safeName,
    authMode: key ? "per_member_secret" : "per_member_oauth",
    status: row?.status ?? "not_connected",
    connectedAt: row ? new Date(row.connectedAt).toISOString() : null,
    lastUsedAt: row?.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
    scopes: row?.status === "connected" ? row.scopes : [],
    oauthStatus: oauthStatusOf(core, server),
    secretHeaderName: key ? (server.memberHeaderName ?? "Authorization") : null,
    secretHeaderPrefix: key ? (server.memberHeaderPrefix ?? null) : null,
    accountLabel: !key && row?.status === "connected" ? (row.accountLabel ?? null) : null,
    reconnectReason: row?.status === "needs_reconnect" ? reconnectReasonOf(row.lastError) : null,
  };
}

const missing = () => notFound("Connector not found", "connector_not_found");

/** A per-member connector of the caller's organization in the expected mode: 404 when absent, 409 in another mode. */
async function serverIn(tx: Tx, id: string, mode?: ServerRow["authMode"]): Promise<ServerRow> {
  const server = await perMemberServer(tx, id);
  if (!server) throw missing();
  if (mode && server.authMode !== mode) {
    throw conflict(
      mode === "per_member_secret"
        ? "This connector signs in with an account, not a key"
        : "This connector takes a key, not a sign-in",
      "wrong_auth_mode",
    );
  }
  return server;
}

/** Header values carry visible ASCII / Latin-1 and tab only: a key with CR, LF or NUL could smuggle a header. */
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]+$/u;

/**
 * Member connector routes (Phase 07.4, D-01 … D-03, D-07 item 4; CONN-01, CONN-02). Each member reads and changes only
 * their own connection: every route keys on the session user, the connector is resolved inside the caller's tenant
 * transaction (another organization's id is a 404) and RLS hides every other member's row. No response or redirect
 * carries a token, refresh token, code, verifier, client secret or member key: redirects carry a connector id or a
 * `ConnectorErrorCode`, and request logs never carry a query string (app.ts).
 */
export function registerConnectorRoutes(app: App, core: Core, perms: PermissionService): void {
  const redis = core.bus.pub;
  const member = {
    config: { authz: "user" as const },
    preHandler: [core.identity.requireUser, perms.requirePermission("connector.connect")],
  };
  const urls = () => connectorOAuthUrls(core.env.OCW_PUBLIC_API_URL);
  const webUrl = (query: Record<string, string>) => settingsUrl(core, "member", query);

  // Listing is decided here, not by a preHandler: without `connector.connect` (Bots off, a deny rule) the member still
  // sees their OWN connections so they can withdraw them (WINDOWS #196; DELETE below), and nothing else.
  app.get(
    "/connectors",
    {
      config: { authz: "user" as const },
      preHandler: [core.identity.requireUser],
      schema: { tags, response: { 200: MemberConnectorList } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      markDecided(req);
      const userId = authOf(req).userId;
      return core.db.withTenant(tenant(req), async (tx) => {
        const canConnect = await perms.can(req, tx, "connector.connect");
        const servers = await tx
          .select()
          .from(mcpServers)
          // Member modes only: an organization-account server is the organization's, never a member's (07.14).
          .where(inArray(mcpServers.authMode, [...PER_MEMBER_MODES]))
          .orderBy(asc(mcpServers.name), asc(mcpServers.createdAt));
        const rows = await tx
          .select()
          .from(connectorConnections)
          .where(eq(connectorConnections.userId, userId));
        const byServer = new Map(rows.map((r) => [r.serverId, r]));
        const listed = canConnect ? servers : servers.filter((s) => byServer.has(s.id));
        return {
          connectors: listed.map((s) => memberConnectorOf(core, s, byServer.get(s.id) ?? null)),
          oauth: urls(),
          canConnect,
        };
      });
    },
  );

  app.post(
    "/connectors/:id/connect",
    {
      ...member,
      logLevel: "info",
      schema: { tags, params: IdParams, response: { 200: ConnectStartResponse } },
    },
    async (req) => {
      const server = await core.db.withTenant(tenant(req), (tx) =>
        serverIn(tx, req.params.id, "per_member_oauth"),
      );
      return startOAuthFlow(core, req, { server, principal: "member" });
    },
  );

  // The authorization server sends the browser here (D-02): a member's own sign-in, or an admin's sign-in for the
  // organization (07.14, `FlowRecord.principal`). Public: the session is checked by hand against the flow, which is
  // consumed FIRST so a mismatch or a replay can never be retried (T-07.4-10-01/02, T-07.14-07-01). An unknown or used
  // state names no flow, so it goes back to the member page.
  app.get(
    "/connectors/oauth/callback",
    { config: { authz: "public" }, logLevel: "info", schema: { tags, hide: true } },
    async (req, reply) => {
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
      const fail = (code: ConnectorErrorCode, serverId?: string) =>
        reply.redirect(webUrl(serverId ? { error: code, connector: serverId } : { error: code }), 302);
      const parsed = CallbackQuery.safeParse(req.query);
      const q = parsed.success ? parsed.data : {};
      const raw = q.state && STATE_RE.test(q.state) ? await redis.getDel(connectFlowKey(q.state)) : null;
      let flow: FlowRecord | null = null;
      try {
        const candidate = raw ? FlowRecord.safeParse(JSON.parse(raw)) : null;
        flow = candidate?.success ? candidate.data : null;
      } catch {
        flow = null;
      }
      if (!flow) {
        req.log.info({ code: "flow_expired" }, "connector callback refused");
        return fail("flow_expired");
      }
      const f = flow;
      const failed = async (code: ConnectorErrorCode) => {
        req.log.info({ serverId: f.serverId, code }, "connector callback refused");
        await core.db
          .withTenant({ organizationId: f.organizationId, userId: f.userId }, (tx) =>
            core.audit.record(tx, {
              action: "connector.connect_failed",
              resourceType: "mcp_server",
              resourceId: f.serverId,
              metadata: { serverId: f.serverId, code },
            }),
          )
          .catch(() => {});
        return fail(code, f.serverId);
      };
      // The checks both principals share fail on the flow's own page.
      const sharedFailed = (code: "session_mismatch" | "issuer_mismatch") =>
        f.principal === "organization" ? orgSignInFailed(core, req, reply, f, code) : failed(code);

      // Account binding (T-07.4-10-01): only the user who started the flow, in the same organization, completes it.
      const session = await core.identity.authenticate(req.headers).catch(() => null);
      if (!session || session.userId !== f.userId || session.organizationId !== f.organizationId) {
        return sharedFailed("session_mismatch");
      }
      // RFC 9207 before anything else in the response: on a mix-up its error fields are not trusted either.
      const metadata = f.discovered.metadata as unknown as DiscoveredAuth["metadata"];
      try {
        checkCallbackIssuer(metadata, f.discovered.issuer, q.iss ?? null);
      } catch {
        return sharedFailed("issuer_mismatch");
      }
      if (f.principal === "organization") return completeOrgSignIn(core, perms, req, reply, f, session, q);
      if (q.error) return failed(q.error === "access_denied" ? "access_denied" : "token_exchange_failed");
      if (!q.code) return failed("token_exchange_failed");

      const ctx = {
        organizationId: f.organizationId,
        userId: f.userId,
        sessionId: session.sessionId,
        clientKind: session.clientKind,
      };
      const prepared = await core.db.withTenant(ctx, async (tx) => {
        const server = await perMemberServer(tx, f.serverId);
        if (server?.authMode !== "per_member_oauth") return null;
        const clientSecret = await clientSecretFor(tx, core, f.serverId, f.client.issuer, f.client.clientId);
        return { server, clientSecret };
      });
      if (!prepared) return failed("flow_expired");
      const { d, client } = flowAuth(f, prepared.clientSecret);
      const egress = egressFor(core.env);
      let bundle: TokenBundle;
      try {
        bundle = await exchangeCode(egress, d, client, {
          code: q.code,
          codeVerifier: f.verifier,
          redirectUri: f.redirectUri,
          ...(f.scope ? { scope: f.scope } : {}),
        });
      } catch (err) {
        return failed(err instanceof ConnectorOAuthError ? err.code : "token_exchange_failed");
      }

      let needsProbe = false;
      try {
        needsProbe = await core.db.withTenant(ctx, async (tx) => {
          const server = await perMemberServer(tx, f.serverId);
          if (!server) throw missing();
          const row = await storeConnection(tx, core, {
            userId: f.userId,
            serverId: f.serverId,
            bundle: oauthBundleOf(bundle),
          });
          if (server.oauthStatus === "needs_client" || server.oauthStatus === "error") {
            await setOAuthStatus(tx, server.id, null);
          }
          await core.audit.record(tx, {
            action: "connector.connected",
            resourceType: "connector_connection",
            resourceId: row.id,
            metadata: { serverId: f.serverId, method: "oauth", issuer: bundle.issuer },
          });
          const [tool] = await tx
            .select({ name: mcpServerTools.name })
            .from(mcpServerTools)
            .where(eq(mcpServerTools.serverId, f.serverId))
            .limit(1);
          return tool === undefined;
        });
      } catch {
        // Nothing was stored: do not leave a live grant behind at the provider.
        await revokeToken(egress, bundle, prepared.clientSecret);
        return failed("token_exchange_failed");
      }
      if (needsProbe) {
        await probeConnector(core, f, {
          headerName: "Authorization",
          headerValue: `Bearer ${bundle.accessToken}`,
        });
      }
      return reply.redirect(webUrl({ connected: f.serverId }), 302);
    },
  );

  // The client ID metadata document (CIMD): its URL is the client id. Only an https instance serves one.
  app.get(
    "/connectors/oauth/client-metadata.json",
    { config: { authz: "public" }, schema: { tags, hide: true } },
    async (_req, reply) => {
      const doc = clientMetadataDocument(urls(), CONNECTOR_CLIENT_NAME);
      if (!doc) throw notFound("No client metadata document on this workspace", "not_found");
      return reply.header("cache-control", "public, max-age=300").type("application/json").send(doc);
    },
  );

  app.put(
    "/connectors/:id/secret",
    {
      ...member,
      logLevel: "info",
      schema: {
        tags,
        params: IdParams,
        body: ConnectSecretRequest,
        response: { 200: MemberConnectorSchema },
      },
    },
    async (req) => {
      const auth = authOf(req);
      const value = req.body.value.trim();
      const stored = await core.db.withTenant(tenant(req), async (tx) => {
        const server = await serverIn(tx, req.params.id, "per_member_secret");
        if (!value || !HEADER_VALUE_RE.test(`${server.memberHeaderPrefix ?? ""}${value}`)) {
          throw new HttpError(400, "invalid_key", "Enter your key without line breaks");
        }
        const row = await storeConnection(tx, core, {
          userId: auth.userId,
          serverId: server.id,
          bundle: { kind: "secret", value },
        });
        await core.audit.record(tx, {
          action: "connector.connected",
          resourceType: "connector_connection",
          resourceId: row.id,
          metadata: { serverId: server.id, method: "secret" },
        });
        const [tool] = await tx
          .select({ name: mcpServerTools.name })
          .from(mcpServerTools)
          .where(eq(mcpServerTools.serverId, server.id))
          .limit(1);
        return { server, row, needsProbe: tool === undefined };
      });
      if (stored.needsProbe) {
        const header = `${stored.server.memberHeaderPrefix ?? ""}${value}`;
        await probeConnector(
          core,
          { organizationId: auth.organizationId, userId: auth.userId, serverId: stored.server.id },
          { headerName: stored.server.memberHeaderName ?? "Authorization", headerValue: header },
        );
      }
      return memberConnectorOf(core, stored.server, stored.row);
    },
  );

  // Withdrawal (CONN-02): a member may always delete their OWN connection, even after `connector.connect` was taken
  // away (it only reduces access; the ownedAiChat precedent). Another member's row is invisible (RLS), hence 404.
  app.delete(
    "/connectors/:id/connection",
    {
      config: { authz: "user" as const },
      preHandler: [core.identity.requireUser],
      logLevel: "info",
      schema: { tags, params: IdParams },
    },
    async (req, reply) => {
      markDecided(req);
      const auth = authOf(req);
      await core.db.withTenant(tenant(req), (tx) => serverIn(tx, req.params.id));
      const done = await disconnect(core, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        serverId: req.params.id,
      });
      if (!done) throw notFound("You aren't connected to this connector", "not_connected");
      return reply.code(204).send();
    },
  );

  // Settings › MCP servers "Re-probe" for a per-member connector (UI-SPEC R6): with the admin's OWN connection only.
  app.post(
    "/connectors/:id/probe",
    {
      config: { authz: "user" as const },
      preHandler: [core.identity.requireUser, perms.requirePermission("mcp.manage")],
      schema: { tags, params: IdParams, response: { 200: McpServer } },
    },
    async (req) => {
      const auth = authOf(req);
      await core.db.withTenant(tenant(req), (tx) => serverIn(tx, req.params.id));
      const key = { organizationId: auth.organizationId, userId: auth.userId, serverId: req.params.id };
      const token = await accessTokenFor(core, key).catch((err) => {
        if (err instanceof ConnectorTokenUnavailableError) {
          throw new HttpError(
            502,
            "connector_unavailable",
            "The connector's sign-in is not reachable right now.",
          );
        }
        throw err;
      });
      if (!token.ok) throw connectError(token.reason);
      await probeConnector(core, key, token);
      return core.db.withTenant(tenant(req), (tx) => getMcpServer(tx, req.params.id, mcpReadOptions(core)));
    },
  );

  registerShareRoutes(app, { core, perms, access: createConversationAccess(core) });
}

const PreviewQuery = z.object({ conversationId: IdParams.shape.id });

/**
 * Member-account shares (D-03, CONN-03): the caller's own choices only. Creating one decides the resource's permission
 * (`connector.connect` / `vault.use`) and the conversation's readability; listing and revoking touch the caller's own
 * rows only (revoking only reduces access, so it is always allowed).
 */
function registerShareRoutes(app: App, d: SharesDeps): void {
  const { core } = d;
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };

  app.get(
    "/member-account-shares",
    { ...user, schema: { tags, response: { 200: MemberAccountShareList } } },
    async (req, reply) => {
      markDecided(req);
      reply.header("cache-control", "no-store");
      const shares = await core.db.withTenant(tenant(req), (tx) => listShares(d, tx, authOf(req).userId));
      return { shares };
    },
  );

  app.get(
    "/member-account-shares/preview",
    { ...user, schema: { tags, querystring: PreviewQuery, response: { 200: ReadersPreview } } },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) => previewReaders(d, req, tx, req.query.conversationId)),
  );

  app.post(
    "/member-account-shares",
    {
      ...user,
      logLevel: "info",
      schema: { tags, body: CreateMemberAccountShareRequest, response: { 201: MemberAccountShare } },
    },
    async (req, reply) => {
      const share = await core.db.withTenant(tenant(req), (tx) =>
        createShare(d, req, tx, authOf(req).userId, req.body),
      );
      reply.code(201);
      return share;
    },
  );

  app.delete(
    "/member-account-shares/:id",
    { ...user, logLevel: "info", schema: { tags, params: IdParams } },
    async (req, reply) => {
      markDecided(req);
      await core.db.withTenant(tenant(req), (tx) => revokeShare(d, tx, authOf(req).userId, req.params.id));
      return reply.code(204).send();
    },
  );
}
