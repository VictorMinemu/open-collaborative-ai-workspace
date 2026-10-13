import { randomBytes } from "node:crypto";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  selectClientAuthMethod,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { ConnectorErrorCode, ConnectorOAuthUrls } from "@ocw/contracts";
import { decodeJwt } from "jose";
import { type Egress, type EgressPolicy, EgressRefusedError, hostPortOf } from "../../lib/egress";
import { clientMetadataDocument } from "./client-metadata";

/**
 * The API's OAuth 2.1 client for MCP servers (D-02, D-07; MCP authorization spec 2026-07-28): discovery (RFC 9728 →
 * RFC 8414 / OIDC), client choice, the authorization URL (PKCE S256, RFC 8707 `resource`, state), the RFC 9207 `iss`
 * check, the code exchange, refresh and RFC 7009 revocation.
 *
 * - Every request goes through the egress guard: each SDK helper receives `fetchFn = egress.bound(policy)`, because
 *   the SDK silently falls back to the global `fetch` without one. The MCP server's own `host:port` is the only
 *   private/plain-http target a policy admits.
 * - Authorization server endpoints must be https or on the admin-registered MCP URL's origin (the `trusted()` rule of
 *   ADR-0017); the issuer must be the URL it was discovered at (RFC 8414 §3.3). The SDK checks neither, nor does it
 *   refuse when `code_challenge_methods_supported` is absent: both are done here.
 * - The SDK's end-to-end `auth()` orchestrator is not used: it owns refresh, which OCW must serialize itself.
 * - Errors are `ConnectorOAuthError(code)`: never a token, code, verifier, client secret or response body.
 * - No routes, storage or Redis here (07.4-10 owns orchestration and custody).
 */

const OAUTH_TIMEOUT_MS = 10_000;
/** Metadata documents and token responses are small; anything bigger is refused by the guard. */
const OAUTH_MAX_BYTES = 256 * 1024;
const STATE_BYTES = 32;
const ACCOUNT_LABEL_MAX = 200;

/** RFC 6749 errors after which the grant is dead (reconnect), as for the ChatGPT plan (ADR-0017). */
const TERMINAL_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "refresh_token_reused",
  "invalid_client",
  "access_denied",
  "unauthorized_client",
]);

/** Guard refusals that are a policy decision (the rest are network trouble). */
const POLICY_REFUSALS = new Set([
  "bad_url",
  "scheme",
  "userinfo",
  "https_required",
  "private_address",
  "platform_host",
]);

/** `terminal`: the grant or client is dead (reconnect); otherwise transient (keep tokens, retry later). */
export class ConnectorOAuthError extends Error {
  readonly code: ConnectorErrorCode;
  readonly terminal: boolean;
  /** The RFC 6749 `error` of the authorization server when there was one (a fixed token, never free text). */
  readonly oauthError: string | null;

  constructor(code: ConnectorErrorCode, opts: { terminal?: boolean; oauthError?: string | null } = {}) {
    const oauthError =
      opts.oauthError && /^[a-z0-9_.-]{1,64}$/iu.test(opts.oauthError) ? opts.oauthError : null;
    super(`connector oauth: ${code}${oauthError ? ` (${oauthError})` : ""}`);
    this.name = "ConnectorOAuthError";
    this.code = code;
    this.terminal = opts.terminal ?? false;
    this.oauthError = oauthError;
  }
}

export interface DiscoveredAuth {
  serverUrl: string;
  /** RFC 8707 resource indicator: the PRM `resource`, verbatim. */
  resource: string;
  issuer: string;
  metadata: AuthServerMetadata;
  /** PRM `scopes_supported`. */
  scopes: string[] | undefined;
  /** `host:port` of the MCP URL: the only private / plain-http target the OAuth calls may reach. */
  sameOrigin: string;
}

export type AuthServerMetadata = AuthorizationServerMetadata;

/** The OAuth client used for one issuer. Credentials are keyed by issuer and never used at another one. */
export type ClientChoice =
  | { method: "pre_registered"; issuer: string; clientId: string; clientSecret?: string }
  | { method: "cimd"; issuer: string; clientId: string }
  | { method: "dcr"; issuer: string; clientId: string; clientSecret?: string; isNew: boolean };

export interface TokenBundle {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; null when the server did not say. */
  expiresAt: number | null;
  scopes: string[];
  issuer: string;
  clientId: string;
  resource: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  /** `client_secret_basic` | `client_secret_post` | `none` (the SDK's choice at the code exchange). */
  authMethod: string;
  /**
   * UI-SPEC R1: `email` or `preferred_username` of an id_token returned directly by the token endpoint, decoded for
   * display only (never verified, never used for a decision); null otherwise.
   */
  accountLabel: string | null;
}

// ---------------------------------------------------------------- helpers

const random = (bytes: number) => randomBytes(bytes).toString("base64url");

/** https, or on the admin-registered MCP URL's own origin; never userinfo or a fragment. */
function trusted(endpoint: string | undefined, mcpOrigin: string): boolean {
  if (endpoint === undefined) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && u.origin === mcpOrigin);
}

const stripSlash = (s: string) => s.replace(/\/+$/u, "");

/** RFC 7009 endpoint: an RFC 8414 field the SDK's OIDC metadata type does not declare. */
function revocationEndpointOf(metadata: AuthServerMetadata): string | undefined {
  const value = (metadata as { revocation_endpoint?: unknown }).revocation_endpoint;
  return typeof value === "string" ? value : undefined;
}

function findRefusal(err: unknown): EgressRefusedError | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (cur instanceof EgressRefusedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** The guard's policy for one MCP server's OAuth traffic. */
function oauthPolicy(sameOrigin: string): EgressPolicy {
  return {
    privateAllow: [sameOrigin],
    requireHttps: true,
    timeoutMs: OAUTH_TIMEOUT_MS,
    maxBytes: OAUTH_MAX_BYTES,
  };
}

/** A discovery failure as a code: a policy refusal by the guard, or anything else. */
function discoveryError(err: unknown): ConnectorOAuthError {
  if (err instanceof ConnectorOAuthError) return err;
  const refusal = findRefusal(err);
  if (refusal && POLICY_REFUSALS.has(refusal.code)) return new ConnectorOAuthError("egress_refused");
  return new ConnectorOAuthError("discovery_failed");
}

/** A token endpoint failure as a code; terminal only for the RFC 6749 errors that kill the grant. */
function tokenError(err: unknown): ConnectorOAuthError {
  if (err instanceof ConnectorOAuthError) return err;
  const refusal = findRefusal(err);
  if (refusal) {
    return new ConnectorOAuthError(
      POLICY_REFUSALS.has(refusal.code) ? "egress_refused" : "token_exchange_failed",
    );
  }
  if (err instanceof OAuthError) {
    const oauthError = err.errorCode;
    return new ConnectorOAuthError("token_exchange_failed", {
      terminal: TERMINAL_OAUTH_ERRORS.has(oauthError),
      oauthError,
    });
  }
  return new ConnectorOAuthError("token_exchange_failed");
}

/** `resource_metadata`, `scope` and `error` of a `WWW-Authenticate: Bearer …` challenge. */
export function parseWwwAuthenticate(header: string): {
  resourceMetadataUrl?: string;
  scope?: string;
  error?: string;
} {
  const params = extractWWWAuthenticateParams(
    new Response(null, { headers: { "www-authenticate": header } }),
  );
  return {
    ...(params.resourceMetadataUrl ? { resourceMetadataUrl: params.resourceMetadataUrl.href } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

/** Display label from an id_token (decoded, not verified: display only); null when absent or malformed. */
function accountLabelOf(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const claims = decodeJwt(idToken);
    const value = typeof claims.email === "string" ? claims.email : claims.preferred_username;
    if (typeof value !== "string") return null;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
    const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim();
    return clean ? clean.slice(0, ACCOUNT_LABEL_MAX) : null;
  } catch {
    return null;
  }
}

function clientInformation(client: { clientId: string; clientSecret?: string }): OAuthClientInformationMixed {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  };
}

function bundleFrom(
  tokens: OAuthTokens,
  ctx: Omit<TokenBundle, "accessToken" | "refreshToken" | "expiresAt" | "scopes" | "accountLabel">,
  fallbackScopes: string[],
  accountLabel: string | null,
): TokenBundle {
  if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.access_token) {
    throw new ConnectorOAuthError("token_exchange_failed");
  }
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt:
      typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
        ? Date.now() + tokens.expires_in * 1000
        : null,
    scopes: tokens.scope ? tokens.scope.split(/\s+/u).filter(Boolean) : fallbackScopes,
    ...ctx,
    accountLabel,
  };
}

// ---------------------------------------------------------------- discovery

/**
 * RFC 9728 protected resource metadata, then RFC 8414 / OIDC metadata of its first authorization server, all through
 * the guard. `wwwAuthenticate` (a 401 challenge from the MCP server) may name the PRM URL. Refuses with
 * `pkce_unsupported` unless the server advertises S256, `discovery_failed` for an untrusted endpoint, an issuer that
 * is not the discovered URL or a PRM `resource` that is not this server, and `egress_refused` for a guard refusal.
 */
export async function discover(
  egress: Egress,
  serverUrl: string,
  opts: { wwwAuthenticate?: string } = {},
): Promise<DiscoveredAuth> {
  let mcp: URL;
  let sameOrigin: string;
  try {
    mcp = new URL(serverUrl);
    sameOrigin = hostPortOf(mcp);
  } catch {
    throw new ConnectorOAuthError("discovery_failed");
  }
  if (mcp.protocol !== "https:" && mcp.protocol !== "http:")
    throw new ConnectorOAuthError("discovery_failed");
  const fetchFn = egress.bound(oauthPolicy(sameOrigin));

  let resourceMetadataUrl: URL | undefined;
  if (opts.wwwAuthenticate) {
    const challenge = parseWwwAuthenticate(opts.wwwAuthenticate);
    if (challenge.resourceMetadataUrl) {
      if (!trusted(challenge.resourceMetadataUrl, mcp.origin))
        throw new ConnectorOAuthError("discovery_failed");
      resourceMetadataUrl = new URL(challenge.resourceMetadataUrl);
    }
  }

  let prm: OAuthProtectedResourceMetadata;
  try {
    prm = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl }, fetchFn);
  } catch (err) {
    throw discoveryError(err);
  }
  // The token must be bound to this server: the PRM resource is the server URL or a prefix of it, same origin.
  let resourceOk = false;
  try {
    resourceOk = checkResourceAllowed({
      requestedResource: resourceUrlFromServerUrl(serverUrl),
      configuredResource: prm.resource,
    });
  } catch {
    resourceOk = false;
  }
  if (!resourceOk) throw new ConnectorOAuthError("discovery_failed");

  const asUrl = prm.authorization_servers?.[0];
  if (!asUrl || !trusted(asUrl, mcp.origin)) throw new ConnectorOAuthError("discovery_failed");

  let metadata: AuthServerMetadata | undefined;
  try {
    metadata = await discoverAuthorizationServerMetadata(asUrl, { fetchFn });
  } catch (err) {
    throw discoveryError(err);
  }
  if (!metadata) throw new ConnectorOAuthError("discovery_failed");
  if (stripSlash(metadata.issuer) !== stripSlash(asUrl)) throw new ConnectorOAuthError("discovery_failed");
  const endpoints = [metadata.authorization_endpoint, metadata.token_endpoint];
  const optional = [metadata.registration_endpoint, revocationEndpointOf(metadata)];
  if (
    !endpoints.every((e) => trusted(e, mcp.origin)) ||
    !optional.every((e) => e === undefined || trusted(e, mcp.origin))
  ) {
    throw new ConnectorOAuthError("discovery_failed");
  }
  if (!metadata.response_types_supported.includes("code")) throw new ConnectorOAuthError("discovery_failed");
  // MCP spec: "If the field is absent, MCP clients MUST refuse to proceed" (the SDK only checks a present field).
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new ConnectorOAuthError("pkce_unsupported");
  }
  return {
    serverUrl,
    resource: prm.resource,
    issuer: metadata.issuer,
    metadata,
    scopes: prm.scopes_supported,
    sameOrigin,
  };
}

// ---------------------------------------------------------------- client choice

/**
 * The client for the discovered issuer, in the spec's order: a pre-registered client for this exact issuer, else a
 * client ID metadata document (the instance has an https CIMD URL and the server advertises support), else dynamic
 * registration (RFC 7591, a stored client of this issuer is reused), else `needs_client`. Credentials are matched by
 * issuer only: a client registered at another authorization server is never used ("MUST NOT reuse").
 */
export async function chooseClient(
  egress: Egress,
  d: DiscoveredAuth,
  opts: {
    preRegistered: ReadonlyArray<{ issuer: string; clientId: string; clientSecret?: string }>;
    stored: ReadonlyArray<{
      issuer: string;
      clientId: string;
      clientSecret?: string;
      method: "cimd" | "dcr";
    }>;
    urls: ConnectorOAuthUrls;
    clientName: string;
  },
): Promise<ClientChoice> {
  const pre = opts.preRegistered.find((c) => c.issuer === d.issuer);
  if (pre) {
    return {
      method: "pre_registered",
      issuer: d.issuer,
      clientId: pre.clientId,
      ...(pre.clientSecret ? { clientSecret: pre.clientSecret } : {}),
    };
  }
  if (!opts.urls.oauthAvailable || !opts.urls.redirectUri) throw new ConnectorOAuthError("https_required");

  const cimd = clientMetadataDocument(opts.urls, opts.clientName);
  if (cimd && opts.urls.clientMetadataUrl && d.metadata.client_id_metadata_document_supported === true) {
    return { method: "cimd", issuer: d.issuer, clientId: opts.urls.clientMetadataUrl };
  }

  if (!d.metadata.registration_endpoint) throw new ConnectorOAuthError("needs_client");
  const stored = opts.stored.find((c) => c.issuer === d.issuer && c.method === "dcr");
  if (stored) {
    return {
      method: "dcr",
      issuer: d.issuer,
      clientId: stored.clientId,
      ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
      isNew: false,
    };
  }
  const supported = d.metadata.token_endpoint_auth_methods_supported ?? [];
  // A server-side app can keep a secret: ask for a confidential client when the server allows one.
  const authMethod =
    supported.length === 0 || supported.includes("client_secret_basic")
      ? "client_secret_basic"
      : supported.includes("client_secret_post")
        ? "client_secret_post"
        : "none";
  const clientMetadata: OAuthClientMetadata & { application_type: string } = {
    redirect_uris: [opts.urls.redirectUri],
    client_name: opts.clientName,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: authMethod,
    application_type: "web",
  };
  let registered: OAuthClientInformationFull;
  try {
    registered = await registerClient(d.issuer, {
      metadata: d.metadata,
      clientMetadata,
      fetchFn: egress.bound(oauthPolicy(d.sameOrigin)),
    });
  } catch (err) {
    const refusal = findRefusal(err);
    throw new ConnectorOAuthError(
      refusal && POLICY_REFUSALS.has(refusal.code) ? "egress_refused" : "needs_client",
    );
  }
  return {
    method: "dcr",
    issuer: d.issuer,
    clientId: registered.client_id,
    ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
    isNew: true,
  };
}

/**
 * The scope to request: the admin's override (UI-SPEC R11) when set, else the challenge's `scope`, else the PRM
 * `scopes_supported`, else none; `offline_access` is added only when the authorization server lists it.
 */
export function chooseScope(
  d: DiscoveredAuth,
  challengeScope?: string,
  adminScopes?: readonly string[] | null,
): string | undefined {
  const split = (s: string) => s.split(/\s+/u).filter(Boolean);
  let scopes: string[] | undefined;
  if (adminScopes && adminScopes.length > 0) scopes = [...adminScopes];
  else if (challengeScope && split(challengeScope).length > 0) scopes = split(challengeScope);
  else if (d.scopes && d.scopes.length > 0) scopes = [...d.scopes];
  if (!scopes) return undefined;
  if (d.metadata.scopes_supported?.includes("offline_access") && !scopes.includes("offline_access")) {
    scopes.push("offline_access");
  }
  return [...new Set(scopes)].join(" ");
}

// ---------------------------------------------------------------- authorization

function assertSameIssuer(d: DiscoveredAuth, client: ClientChoice) {
  if (client.issuer !== d.issuer) throw new ConnectorOAuthError("issuer_mismatch");
}

/** The authorization URL with PKCE S256, `resource` and a fresh state; the caller keeps verifier and state. */
export async function buildAuthorization(
  d: DiscoveredAuth,
  client: ClientChoice,
  urls: ConnectorOAuthUrls,
  scope: string | undefined,
): Promise<{ authorizationUrl: string; codeVerifier: string; state: string }> {
  if (!urls.oauthAvailable || !urls.redirectUri) throw new ConnectorOAuthError("https_required");
  assertSameIssuer(d, client);
  const state = random(STATE_BYTES);
  let started: { authorizationUrl: URL; codeVerifier: string };
  try {
    started = await startAuthorization(d.issuer, {
      metadata: d.metadata,
      clientInformation: { client_id: client.clientId },
      redirectUrl: urls.redirectUri,
      scope,
      state,
      resource: d.resource,
    });
  } catch {
    throw new ConnectorOAuthError("discovery_failed");
  }
  return { authorizationUrl: started.authorizationUrl.href, codeVerifier: started.codeVerifier, state };
}

/**
 * RFC 9207 on the authorization response: `iss` must equal the flow's issuer (plain string comparison); an absent
 * `iss` is refused only when the server advertises `authorization_response_iss_parameter_supported`. On a mismatch
 * the caller must not show the response's `error*` parameters.
 */
export function checkCallbackIssuer(
  metadata: AuthServerMetadata,
  flowIssuer: string,
  iss: string | null,
): void {
  if (iss !== null) {
    if (iss !== flowIssuer) throw new ConnectorOAuthError("issuer_mismatch");
    return;
  }
  if (
    (metadata as { authorization_response_iss_parameter_supported?: unknown })
      .authorization_response_iss_parameter_supported === true
  ) {
    throw new ConnectorOAuthError("issuer_mismatch");
  }
}

/** The code exchange with the verifier and `resource`, through the guard. */
export async function exchangeCode(
  egress: Egress,
  d: DiscoveredAuth,
  client: ClientChoice,
  p: { code: string; codeVerifier: string; redirectUri: string; scope?: string },
): Promise<TokenBundle> {
  assertSameIssuer(d, client);
  const info = clientInformation(client);
  let tokens: OAuthTokens;
  try {
    tokens = await exchangeAuthorization(d.issuer, {
      metadata: d.metadata,
      clientInformation: info,
      authorizationCode: p.code,
      codeVerifier: p.codeVerifier,
      redirectUri: p.redirectUri,
      resource: d.resource,
      fetchFn: egress.bound(oauthPolicy(d.sameOrigin)),
    });
  } catch (err) {
    throw tokenError(err);
  }
  return bundleFrom(
    tokens,
    {
      issuer: d.issuer,
      clientId: client.clientId,
      resource: d.resource,
      tokenEndpoint: d.metadata.token_endpoint,
      revocationEndpoint: revocationEndpointOf(d.metadata) ?? null,
      authMethod: selectClientAuthMethod(info, d.metadata.token_endpoint_auth_methods_supported ?? []),
    },
    p.scope ? p.scope.split(/\s+/u).filter(Boolean) : [],
    accountLabelOf(tokens.id_token),
  );
}

// ---------------------------------------------------------------- refresh and revocation

/** The resource's origin and `host:port` (the OAuth calls' only private / plain-http target). */
function resourceOrigin(bundle: TokenBundle): { origin: string; sameOrigin: string } | null {
  try {
    const url = new URL(bundle.resource);
    return { origin: url.origin, sameOrigin: hostPortOf(url) };
  } catch {
    return null;
  }
}

/**
 * Refresh (rotation-aware), resending `resource` (RFC 8707) with the client authentication chosen at the exchange.
 * The caller serializes refreshes per connection and passes the client secret of confidential clients. Terminal
 * errors (`invalid_grant`, …) mean reconnect; everything else (5xx, network) is transient.
 */
export async function refreshTokens(
  egress: Egress,
  bundle: TokenBundle,
  clientSecret?: string,
): Promise<TokenBundle> {
  if (!bundle.refreshToken) throw new ConnectorOAuthError("needs_reconnect", { terminal: true });
  const where = resourceOrigin(bundle);
  if (!where || !trusted(bundle.tokenEndpoint, where.origin)) {
    throw new ConnectorOAuthError("token_exchange_failed");
  }
  if (bundle.authMethod !== "none" && !clientSecret)
    throw new ConnectorOAuthError("needs_client", { terminal: true });
  // Only what the SDK's token request reads: the endpoint and the auth method chosen at the code exchange.
  const metadata: OAuthMetadata = {
    issuer: bundle.issuer,
    authorization_endpoint: bundle.tokenEndpoint,
    token_endpoint: bundle.tokenEndpoint,
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: [bundle.authMethod],
  };
  let tokens: OAuthTokens;
  try {
    tokens = await refreshAuthorization(bundle.issuer, {
      metadata,
      clientInformation: clientInformation({ clientId: bundle.clientId, clientSecret }),
      refreshToken: bundle.refreshToken,
      resource: bundle.resource,
      fetchFn: egress.bound(oauthPolicy(where.sameOrigin)),
    });
  } catch (err) {
    throw tokenError(err);
  }
  return bundleFrom(
    tokens,
    {
      issuer: bundle.issuer,
      clientId: bundle.clientId,
      resource: bundle.resource,
      tokenEndpoint: bundle.tokenEndpoint,
      revocationEndpoint: bundle.revocationEndpoint,
      authMethod: bundle.authMethod,
    },
    bundle.scopes,
    accountLabelOf(tokens.id_token) ?? bundle.accountLabel,
  );
}

/**
 * RFC 7009 revocation of the refresh token (else the access token) through the guard. Best effort: false on any
 * failure, never a throw (a disconnect must not depend on the authorization server being up).
 */
export async function revokeToken(
  egress: Egress,
  bundle: TokenBundle,
  clientSecret?: string,
): Promise<boolean> {
  try {
    const endpoint = bundle.revocationEndpoint;
    const where = resourceOrigin(bundle);
    if (!endpoint || !where || !trusted(endpoint, where.origin)) return false;
    const form = new URLSearchParams(
      bundle.refreshToken
        ? { token: bundle.refreshToken, token_type_hint: "refresh_token" }
        : { token: bundle.accessToken, token_type_hint: "access_token" },
    );
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    });
    if (bundle.authMethod === "client_secret_basic" && clientSecret) {
      const pair = `${encodeURIComponent(bundle.clientId)}:${encodeURIComponent(clientSecret)}`;
      headers.set("authorization", `Basic ${Buffer.from(pair).toString("base64")}`);
    } else {
      form.set("client_id", bundle.clientId);
      if (bundle.authMethod === "client_secret_post" && clientSecret) form.set("client_secret", clientSecret);
    }
    const res = await egress.fetch(
      endpoint,
      { method: "POST", headers, body: form },
      oauthPolicy(where.sameOrigin),
    );
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}
