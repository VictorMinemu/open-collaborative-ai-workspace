import { type ConnectorErrorCode, connectorOAuthUrls } from "@ocw/contracts";
import { connectorOAuthClients, type mcpServers, type Tx } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { authOf, type Core, tenant } from "../../core";
import { egressFor } from "../../lib/egress";
import { HttpError } from "../../lib/errors";
import { oauthClientsOf, setAuthFailure, setOAuthStatus } from "../mcp";
import { authFailureOf } from "./diagnosis";
import {
  buildAuthorization,
  type ClientChoice,
  type ClientPreviewOptions,
  ConnectorOAuthError,
  chooseClient,
  chooseScope,
  type DiscoveredAuth,
  discover,
} from "./oauth";

/** The client name the instance presents to authorization servers (CIMD and dynamic registration). */
export const CONNECTOR_CLIENT_NAME = "Open Collaborative AI Workspace";

/** A started sign-in lives this long, single use (GETDEL), bound to the user, organization and connector. */
export const CONNECT_FLOW_TTL_S = 600;
export const connectFlowKey = (state: string) => `ocw:conn:oauth:${state}`;
/** `buildAuthorization` states are 32 random bytes, base64url: anything else is never looked up. */
export const STATE_RE = /^[A-Za-z0-9_-]{43}$/u;

/** Who a sign-in connects: the member themself (07.4) or the organization's shared account (07.14 D-02). */
export const FlowPrincipal = z.enum(["member", "organization"]);
export type FlowPrincipal = z.infer<typeof FlowPrincipal>;

/**
 * Server-side state of one sign-in (Redis only: the verifier never reaches the browser). The discovered authorization
 * server travels with it so the callback checks `iss` and redeems the code against the exact issuer the flow started
 * with; a client secret never does (it is read again from `connector_oauth_clients`). `principal` defaults to
 * `member`, so a record written by a pre-07.14 instance stays valid for its 10 minutes (A-01).
 */
export const FlowRecord = z.object({
  organizationId: z.string(),
  userId: z.string(),
  serverId: z.string(),
  principal: FlowPrincipal.default("member"),
  verifier: z.string(),
  redirectUri: z.string(),
  scope: z.string().nullable(),
  client: z.object({
    method: z.enum(["pre_registered", "cimd", "dcr"]),
    issuer: z.string(),
    clientId: z.string(),
  }),
  discovered: z.object({
    serverUrl: z.string(),
    resource: z.string(),
    issuer: z.string(),
    sameOrigin: z.string(),
    metadata: z.record(z.string(), z.unknown()),
  }),
});
export type FlowRecord = z.infer<typeof FlowRecord>;

const MESSAGES: Record<ConnectorErrorCode, string> = {
  https_required: "Member sign-in needs HTTPS on this workspace.",
  discovery_failed: "Couldn't reach this connector's sign-in.",
  pkce_unsupported: "This connector's sign-in doesn't meet OCW's security requirements.",
  needs_client: "This connector isn't ready for sign-in yet. An admin has to finish setting it up.",
  egress_refused: "This connector's sign-in points to an address OCW won't contact.",
  flow_expired: "That sign-in took too long or was already used.",
  session_mismatch: "This sign-in was started from another account.",
  access_denied: "Access was not allowed.",
  issuer_mismatch: "The sign-in came back from an unexpected server.",
  token_exchange_failed: "The connector didn't finish the sign-in.",
  not_connected: "You aren't connected to this connector.",
  needs_reconnect: "Your sign-in stopped working. Reconnect to keep using it.",
};
export const connectError = (code: ConnectorErrorCode) => new HttpError(409, code, MESSAGES[code]);

type ServerRow = typeof mcpServers.$inferSelect;

/**
 * Where a sign-in's browser lands: Settings › Connections for a member (07.4, unchanged), Settings › MCP servers for
 * the organization (07.14 D-02). The query carries a connector id or a closed code only.
 */
export const settingsUrl = (core: Core, principal: FlowPrincipal, query: Record<string, string>) =>
  `${core.env.OCW_PUBLIC_WEB_URL.replace(/\/+$/u, "")}/settings/${
    principal === "organization" ? "mcp-servers" : "connections"
  }?${new URLSearchParams(query)}`;

/** The authorization server and client a flow started with, rebuilt for the code exchange at the callback. */
export function flowAuth(
  flow: FlowRecord,
  clientSecret: string | undefined,
): { d: DiscoveredAuth; client: ClientChoice } {
  const d: DiscoveredAuth = {
    serverUrl: flow.discovered.serverUrl,
    resource: flow.discovered.resource,
    issuer: flow.discovered.issuer,
    metadata: flow.discovered.metadata as unknown as DiscoveredAuth["metadata"],
    scopes: undefined,
    sameOrigin: flow.discovered.sameOrigin,
  };
  const client = {
    ...flow.client,
    ...(clientSecret ? { clientSecret } : {}),
    ...(flow.client.method === "dcr" ? { isNew: false } : {}),
  } as ClientChoice;
  return { d, client };
}

/**
 * A server's OAuth clients for `previewClient` / `chooseClient`, secrets revealed in the caller's tenant transaction
 * (RLS): the admin's pre-registered ones and the stored CIMD / DCR ones, per issuer. Shared by the sign-in start and
 * the Test sign-in (07.14-09), so both decide from the same clients.
 */
export async function serverClientsOf(
  tx: Tx,
  core: Core,
  serverId: string,
): Promise<Pick<ClientPreviewOptions, "preRegistered" | "stored">> {
  const clients = await oauthClientsOf(tx, serverId);
  const reveal = async (id: string | null) =>
    id ? await core.secrets.reveal(tx, id).catch(() => undefined) : undefined;
  const preRegistered: Array<ClientPreviewOptions["preRegistered"][number]> = [];
  const stored: Array<ClientPreviewOptions["stored"][number]> = [];
  for (const c of clients) {
    const clientSecret = await reveal(c.clientSecretId);
    const entry = { issuer: c.issuer, clientId: c.clientId, ...(clientSecret ? { clientSecret } : {}) };
    if (c.method === "pre_registered") preRegistered.push(entry);
    else stored.push({ ...entry, method: c.method });
  }
  return { preRegistered, stored };
}

/**
 * Starts a sign-in for `principal` on a server the route already resolved (and authorized) in the caller's tenant
 * (07.4-10; 07.14 PD-06): load the server's clients, discover the authorization server, choose a client, keep a new
 * dynamic registration per issuer, choose the scope, build the PKCE authorization, then write the flow record. The
 * member and the organization routes share this body; only the record's `principal` differs.
 *
 * A refusal answers the 07.4 409 code. Admin-visible states are recorded in their own transaction (the request's own
 * rolls back with its 409): `oauth_status` (`needs_client` / `error`) for both principals as before, and, for the
 * organization only, `auth_failure` = the D-10 step that failed (D-10, D-15; member flows never write it).
 */
export async function startOAuthFlow(
  core: Core,
  req: FastifyRequest,
  p: { server: ServerRow; principal: FlowPrincipal },
): Promise<{ authorizeUrl: string }> {
  const { server, principal } = p;
  const auth = authOf(req);
  const oauthUrls = connectorOAuthUrls(core.env.OCW_PUBLIC_API_URL);

  const refuse = async (e: ConnectorOAuthError): Promise<HttpError> => {
    req.log.info({ serverId: server.id, code: e.code, principal }, "connector connect refused");
    const status =
      e.code === "needs_client"
        ? ("needs_client" as const)
        : e.code === "pkce_unsupported" || (e.code === "discovery_failed" && e.terminal)
          ? ("error" as const)
          : null;
    // D-10, D-15: the organization's server shows the step that failed; member flows never write it.
    const failure = principal === "organization" ? authFailureOf(e) : null;
    if (status || failure) {
      await core.db
        .withTenant(tenant(req), async (tx) => {
          if (status) await setOAuthStatus(tx, server.id, status);
          if (failure) await setAuthFailure(tx, server.id, failure);
        })
        .catch(() => {});
    }
    return connectError(e.code);
  };

  const loaded = await core.db.withTenant(tenant(req), (tx) => serverClientsOf(tx, core, server.id));
  if (!oauthUrls.oauthAvailable || !oauthUrls.redirectUri) {
    throw await refuse(new ConnectorOAuthError("https_required", { step: "https_required" }));
  }
  if (!server.url) {
    throw await refuse(new ConnectorOAuthError("discovery_failed", { step: "discovery_failed" }));
  }

  const egress = egressFor(core.env);
  let d: DiscoveredAuth;
  let client: ClientChoice;
  try {
    d = await discover(egress, server.url);
    client = await chooseClient(egress, d, {
      preRegistered: loaded.preRegistered,
      stored: loaded.stored,
      urls: oauthUrls,
      clientName: CONNECTOR_CLIENT_NAME,
      // WINDOWS #179: the admin turned the client metadata document off for this server.
      allowCimd: server.oauthUseCimd,
    });
  } catch (err) {
    throw await refuse(
      err instanceof ConnectorOAuthError ? err : new ConnectorOAuthError("discovery_failed"),
    );
  }

  if (client.method === "dcr" && client.isNew) {
    // Keep the registration per issuer; a concurrent registration for the same issuer wins and is used instead.
    const kept = await core.db.withTenant(tenant(req), async (tx) => {
      const secretId =
        client.method === "dcr" && client.clientSecret
          ? await core.secrets.put(tx, {
              name: "Connector OAuth client",
              kind: "mcp_credential",
              provider: server.id,
              value: client.clientSecret,
            })
          : null;
      const inserted = await tx
        .insert(connectorOAuthClients)
        .values({
          organizationId: auth.organizationId,
          serverId: server.id,
          issuer: client.issuer,
          clientId: client.clientId,
          clientSecretId: secretId,
          method: "dcr",
        })
        .onConflictDoNothing()
        .returning({ id: connectorOAuthClients.id });
      if (inserted.length > 0) return { ...client, isNew: false } as ClientChoice;
      if (secretId) await core.secrets.remove(tx, secretId);
      const [existing] = await tx
        .select()
        .from(connectorOAuthClients)
        .where(
          and(eq(connectorOAuthClients.serverId, server.id), eq(connectorOAuthClients.issuer, client.issuer)),
        )
        .limit(1);
      if (!existing) return null;
      const clientSecret = existing.clientSecretId
        ? await core.secrets.reveal(tx, existing.clientSecretId).catch(() => undefined)
        : undefined;
      return {
        method: "dcr",
        issuer: existing.issuer,
        clientId: existing.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        isNew: false,
      } as ClientChoice;
    });
    if (!kept) {
      throw await refuse(
        new ConnectorOAuthError("needs_client", { step: "client_registration_unavailable" }),
      );
    }
    client = kept;
  }

  const scope = chooseScope(d, undefined, server.oauthScopes);
  let started: Awaited<ReturnType<typeof buildAuthorization>>;
  try {
    started = await buildAuthorization(d, client, oauthUrls, scope);
  } catch (err) {
    throw await refuse(
      err instanceof ConnectorOAuthError ? err : new ConnectorOAuthError("discovery_failed"),
    );
  }
  const flow: FlowRecord = {
    organizationId: auth.organizationId,
    userId: auth.userId,
    serverId: server.id,
    principal,
    verifier: started.codeVerifier,
    redirectUri: oauthUrls.redirectUri,
    scope: scope ?? null,
    client: { method: client.method, issuer: client.issuer, clientId: client.clientId },
    discovered: {
      serverUrl: d.serverUrl,
      resource: d.resource,
      issuer: d.issuer,
      sameOrigin: d.sameOrigin,
      metadata: d.metadata as unknown as Record<string, unknown>,
    },
  };
  await core.bus.pub.set(connectFlowKey(started.state), JSON.stringify(flow), {
    expiration: { type: "EX", value: CONNECT_FLOW_TTL_S },
  });
  return { authorizeUrl: started.authorizationUrl };
}
