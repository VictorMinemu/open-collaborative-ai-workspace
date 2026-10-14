import { z } from "zod";
import { Id, IsoDateTime } from "./common";

/**
 * Per-member connectors (Phase 07.4, D-01 … D-03; CONN-01 … CONN-03). A connector is an admin-registered MCP server
 * (`mcp.ts`) whose credential is either the organization's (`org_secret`, Phase 3.1) or each member's own account
 * (`per_member_oauth`, `per_member_secret`). Members connect in Settings; the API keeps every member credential sealed
 * per member and calls the server itself through the connector proxy, so a token never reaches the cell, the model,
 * a log or an audit row (principles 6, 8, 9).
 *
 * Secret material is WRITE-ONLY: request schemas take it (`ConnectorOAuthClientInput.clientSecret`,
 * `ConnectSecretRequest.value`), response schemas only say whether one is stored (`hasSecret`).
 */

export const ConnectorAuthMode = z.enum(["org_secret", "per_member_oauth", "per_member_secret"]);
export type ConnectorAuthMode = z.infer<typeof ConnectorAuthMode>;

/** Whether members can start an OAuth connection: `needs_client` = no usable client registration for the issuer. */
export const ConnectorOAuthStatus = z.enum(["ready", "needs_client", "https_required", "error"]);
export type ConnectorOAuthStatus = z.infer<typeof ConnectorOAuthStatus>;

/** A member's connection to one per-member connector (no row = `not_connected`). */
export const ConnectionStatus = z.enum(["not_connected", "connected", "needs_reconnect"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/** Why a connect flow or a connection failed (the `?error=` of the callback redirect, the 409 of a member route). */
export const ConnectorErrorCode = z.enum([
  "https_required",
  "discovery_failed",
  "pkce_unsupported",
  "needs_client",
  "egress_refused",
  "flow_expired",
  "session_mismatch",
  "access_denied",
  "issuer_mismatch",
  "token_exchange_failed",
  "not_connected",
  "needs_reconnect",
]);
export type ConnectorErrorCode = z.infer<typeof ConnectorErrorCode>;

// ---------------------------------------------------------------- OAuth client registration

/** The instance's OAuth URLs, derived from `OCW_PUBLIC_API_URL` (`connectorOAuthUrls`). */
export const ConnectorOAuthUrls = z.object({
  redirectUri: z.string(),
  /** The client ID metadata document (CIMD); only an https instance can serve one. */
  clientMetadataUrl: z.string().nullable(),
  /** Redirect URIs must be https or loopback (MCP authorization spec): a plain-http LAN install cannot offer OAuth. */
  oauthAvailable: z.boolean(),
});
export type ConnectorOAuthUrls = z.infer<typeof ConnectorOAuthUrls>;

export const CONNECTOR_OAUTH_CALLBACK_PATH = "/api/v1/connectors/oauth/callback";
export const CONNECTOR_OAUTH_CLIENT_METADATA_PATH = "/api/v1/connectors/oauth/client-metadata.json";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The callback and client-metadata URLs under the public API URL (a trailing slash or a path prefix is kept, a query
 * or fragment dropped). `oauthAvailable` = https, or http to a loopback host; anything else (no URL, another scheme,
 * http on a LAN name) offers no OAuth. Pure: the API, the web and the tests share it.
 */
export function connectorOAuthUrls(publicApiUrl: string): ConnectorOAuthUrls {
  let url: URL;
  try {
    url = new URL(publicApiUrl);
  } catch {
    return { redirectUri: "", clientMetadataUrl: null, oauthAvailable: false };
  }
  const https = url.protocol === "https:";
  if (!https && url.protocol !== "http:") {
    return { redirectUri: "", clientMetadataUrl: null, oauthAvailable: false };
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return {
    redirectUri: `${base}${CONNECTOR_OAUTH_CALLBACK_PATH}`,
    clientMetadataUrl: https ? `${base}${CONNECTOR_OAUTH_CLIENT_METADATA_PATH}` : null,
    oauthAvailable: https || LOOPBACK_HOSTS.has(url.hostname),
  };
}

/** An admin's pre-registered client for one authorization server (keyed by its `issuer`). Request only. */
export const ConnectorOAuthClientInput = z.object({
  issuer: z.url().max(2000),
  clientId: z.string().trim().min(1).max(256),
  /** Write-only: sealed by the API, never returned. Omit for a public client. */
  clientSecret: z.string().min(1).max(4096).optional(),
});
export type ConnectorOAuthClientInput = z.infer<typeof ConnectorOAuthClientInput>;

/** How the client was obtained: entered by an admin, our client ID metadata document, or dynamic registration. */
export const ConnectorOAuthClientMethod = z.enum(["pre_registered", "cimd", "dcr"]);
export type ConnectorOAuthClientMethod = z.infer<typeof ConnectorOAuthClientMethod>;

export const ConnectorOAuthClientView = z.object({
  issuer: z.string(),
  clientId: z.string(),
  hasSecret: z.boolean(),
  method: ConnectorOAuthClientMethod,
});
export type ConnectorOAuthClientView = z.infer<typeof ConnectorOAuthClientView>;

// ---------------------------------------------------------------- member-account shares (D-03, R7)

/** What a member's account is: a per-member connector or a personal keychain item. */
export const MemberAccountResourceKind = z.enum(["connector", "vault_item"]);
export type MemberAccountResourceKind = z.infer<typeof MemberAccountResourceKind>;

/**
 * A member's explicit, audited choice to let a bot use their account in one shared conversation (D-03): results
 * obtained with it are visible to that conversation's readers. Revoking is immediate (the tool gate re-decides).
 */
export const MemberAccountShare = z.object({
  id: Id,
  conversationId: Id,
  /**
   * `#channel`, an AI chat's title, or a DM / group DM named for the viewer by its other members ("your private chat
   * with Scout", 07.4-12); null only when the viewer can no longer read the conversation.
   */
  conversationName: z.string().nullable(),
  resourceKind: MemberAccountResourceKind,
  resourceId: Id,
  resourceName: z.string(),
  /** How many people could read the conversation when the share was granted. */
  readersAtGrant: z.number().int().nonnegative(),
  grantedAt: IsoDateTime,
});
export type MemberAccountShare = z.infer<typeof MemberAccountShare>;

/** `GET /api/v1/member-account-shares`: the caller's active shares. */
export const MemberAccountShareList = z.object({ shares: z.array(MemberAccountShare) });
export type MemberAccountShareList = z.infer<typeof MemberAccountShareList>;

/** `POST /api/v1/member-account-shares`: the owner is always the session user, never a field. */
export const CreateMemberAccountShareRequest = z.object({
  conversationId: Id,
  resourceKind: MemberAccountResourceKind,
  resourceId: Id,
});
export type CreateMemberAccountShareRequest = z.infer<typeof CreateMemberAccountShareRequest>;

/** Who would see results in a conversation (the share confirm dialog). `unbounded` = a group grant, not a list. */
export const ReadersPreview = z.object({
  conversationId: Id,
  /** As `MemberAccountShare.conversationName`, for the person previewing. */
  conversationName: z.string().nullable(),
  readers: z.number().int().nonnegative(),
  unbounded: z.boolean(),
});
export type ReadersPreview = z.infer<typeof ReadersPreview>;

// ---------------------------------------------------------------- member connections (Settings › Connections)

/** Why a connection needs reconnecting (R2): mapped from the terminal refresh or callback error. */
export const ConnectorReconnectReason = z.enum(["expired", "revoked", "provider_changed"]);
export type ConnectorReconnectReason = z.infer<typeof ConnectorReconnectReason>;

/** One per-member connector as the calling member sees it. Never a token or key: only the connection's state. */
export const MemberConnector = z.object({
  serverId: Id,
  name: z.string(),
  safeName: z.string(),
  authMode: z.enum(["per_member_oauth", "per_member_secret"]),
  status: ConnectionStatus,
  connectedAt: IsoDateTime.nullable(),
  lastUsedAt: IsoDateTime.nullable(),
  /** Scopes granted to the member's token (empty for keys). */
  scopes: z.array(z.string()),
  oauthStatus: ConnectorOAuthStatus.nullable(),
  /** `per_member_secret`: where the member's key goes, so the form can say "sent as {header}: {prefix}…". */
  secretHeaderName: z.string().nullable(),
  secretHeaderPrefix: z.string().nullable(),
  /** "Connected as {account}" (R1): from an ID token's email or preferred_username; null for keys or when unknown. */
  accountLabel: z.string().max(320).nullable(),
  /** Only with `needs_reconnect` (R2). */
  reconnectReason: ConnectorReconnectReason.nullable(),
});
export type MemberConnector = z.infer<typeof MemberConnector>;

/** `GET /api/v1/connectors`. */
export const MemberConnectorList = z.object({
  connectors: z.array(MemberConnector),
  oauth: ConnectorOAuthUrls,
});
export type MemberConnectorList = z.infer<typeof MemberConnectorList>;

/** `POST /api/v1/connectors/:id/connect`: only where to send the browser; the flow state stays server-side. */
export const ConnectStartResponse = z.object({ authorizeUrl: z.string() });
export type ConnectStartResponse = z.infer<typeof ConnectStartResponse>;

/** `PUT /api/v1/connectors/:id/secret`: the member's key for a `per_member_secret` connector. Write-only. */
export const ConnectSecretRequest = z.object({ value: z.string().min(1).max(8192) });
export type ConnectSecretRequest = z.infer<typeof ConnectSecretRequest>;

/** UTF-8 bytes of `value` serialized as JSON (`Infinity` when it cannot be serialized): the bound of tool payloads. */
export function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : new TextEncoder().encode(json).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
