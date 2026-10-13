import { z } from "zod";

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

/** UTF-8 bytes of `value` serialized as JSON (`Infinity` when it cannot be serialized): the bound of tool payloads. */
export function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : new TextEncoder().encode(json).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
