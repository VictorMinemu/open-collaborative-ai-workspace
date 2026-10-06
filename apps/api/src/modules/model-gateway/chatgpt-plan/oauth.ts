import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";

/**
 * OAuth client of "Sign in with ChatGPT – ChatGPT plan usage" (D-02, 05-RESEARCH.md §1a-alt), run by the API alone:
 * PKCE S256 + state + nonce, the loopback redirect relayed by paste, ID-token validation against the issuer's JWKS,
 * refresh with rotation and best-effort revocation. Every URL comes from OIDC discovery on
 * `OCW_CHATGPT_AUTH_BASE_URL ?? https://auth.openai.com`. The code, the verifier and every token stay server-side:
 * no function here puts one in an error message, and callers never log the values they pass in.
 */

export const CHATGPT_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/** Without this granted scope plan usage is disabled for the account. */
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const DEFAULT_CHATGPT_AUTH_BASE_URL = "https://auth.openai.com";
/** First sign-in registers a per-user client through dynamic registration (an `oaiapp_…` id comes back). */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME_HINT = "Open Collaborative AI Workspace";

const HTTP_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 3_600_000;
const CLOCK_TOLERANCE_S = 30;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/u;

export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint: string | null;
}

export interface TokenResponse {
  accessToken: string;
  /** Absent on a refresh that does not rotate (then the old one stays valid). */
  refreshToken: string | null;
  idToken: string | null;
  expiresIn: number;
  /** Granted scopes; null when the server omitted `scope` (RFC 6749: then it equals the request). */
  scopes: string[] | null;
  /** The issued client id when the token response carries it. */
  clientId: string | null;
}

/** `terminal`: the grant is dead (reconnect); otherwise a transient outage (keep the tokens, retry later). */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
    readonly terminal: boolean,
  ) {
    super(`chatgpt sign-in: ${code}${status ? ` (${status})` : ""}`);
    this.name = "OAuthError";
  }
}

const TERMINAL_CODES = new Set([
  "invalid_grant",
  "refresh_token_reused",
  "invalid_client",
  "access_denied",
  "unauthorized_client",
]);

const b64url = (buf: Buffer) => buf.toString("base64url");
const random = (bytes: number) => b64url(randomBytes(bytes));

// ---------------------------------------------------------------- discovery

const DiscoveryDoc = z
  .object({
    issuer: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    jwks_uri: z.string().url(),
    revocation_endpoint: z.string().url().optional(),
  })
  .loose();

const discoveryCache = new Map<string, { at: number; value: Discovery }>();

/** An endpoint must be HTTPS or on the operator-configured base's own origin (no SSRF through discovery). */
function trusted(endpoint: string, baseOrigin: string): boolean {
  const u = new URL(endpoint);
  return u.protocol === "https:" || u.origin === baseOrigin;
}

/** OIDC discovery of `authBase`, cached for an hour per base. */
export async function discovery(authBase: string, fetchFn: typeof fetch = fetch): Promise<Discovery> {
  const base = authBase.replace(/\/+$/u, "");
  const hit = discoveryCache.get(base);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.value;
  let res: Response;
  try {
    res = await fetchFn(`${base}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError("unavailable", null, false);
  }
  if (!res.ok) throw new OAuthError("unavailable", res.status, false);
  const parsed = DiscoveryDoc.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new OAuthError("discovery_invalid", res.status, false);
  const doc = parsed.data;
  const origin = new URL(base).origin;
  const endpoints = [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri, doc.revocation_endpoint];
  if (!endpoints.every((e) => e === undefined || trusted(e, origin)))
    throw new OAuthError("discovery_invalid", null, false);
  const value: Discovery = {
    issuer: doc.issuer,
    authorizationEndpoint: doc.authorization_endpoint,
    tokenEndpoint: doc.token_endpoint,
    jwksUri: doc.jwks_uri,
    revocationEndpoint: doc.revocation_endpoint ?? null,
  };
  discoveryCache.set(base, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- authorize

export const redirectUriFor = (port: number) => `http://127.0.0.1:${port}/auth/callback`;

/** A fresh authorize URL with its PKCE verifier, state and nonce (the caller keeps all three server-side). */
export function startSignIn(
  d: Discovery,
  i: { clientId: string; hostId: string; redirectPort: number },
): { authorizeUrl: string; verifier: string; state: string; nonce: string; redirectUri: string } {
  const verifier = random(48);
  const state = random(24);
  const nonce = random(24);
  const redirectUri = redirectUriFor(i.redirectPort);
  const url = new URL(d.authorizationEndpoint);
  const q = url.searchParams;
  q.set("response_type", "code");
  q.set("client_id", i.clientId);
  q.set("redirect_uri", redirectUri);
  q.set("scope", CHATGPT_SCOPES);
  q.set("resource", CHATGPT_RESOURCE);
  q.set("state", state);
  q.set("nonce", nonce);
  q.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  q.set("code_challenge_method", "S256");
  if (i.clientId === DYNAMIC_CLIENT_ID) {
    q.set("agent_name_hint", AGENT_NAME_HINT);
    q.set("ext_agent_host_id", i.hostId);
  }
  return { authorizeUrl: url.toString(), verifier, state, nonce, redirectUri };
}

export type RedirectError = "signin_cancelled" | "state_mismatch" | "invalid_redirect";

/**
 * The address the browser landed on after authorize, pasted by the member: the full
 * `http://127.0.0.1:<port>/auth/callback?…` URL (only the expected port; never `localhost`) or its bare query.
 * Shape errors come first (`invalid_redirect`), then `error=` (`signin_cancelled`), then the state.
 */
export function parseRedirect(
  raw: string,
  expected: { redirectPort: number; state: string },
): { code: string; issuedClientId: string | null } | { error: RedirectError } {
  const text = raw.trim();
  if (!text) return { error: "invalid_redirect" };
  let params: URLSearchParams;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { error: "invalid_redirect" };
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== String(expected.redirectPort) ||
      url.pathname !== "/auth/callback" ||
      url.username ||
      url.password
    )
      return { error: "invalid_redirect" };
    params = url.searchParams;
  } else if (/^\??[\w.-]+=/u.test(text) && !/\s/u.test(text)) {
    params = new URLSearchParams(text.startsWith("?") ? text.slice(1) : text);
  } else {
    return { error: "invalid_redirect" };
  }
  const clientId = params.get("client_id");
  if (clientId !== null && !CLIENT_ID_RE.test(clientId)) return { error: "invalid_redirect" };
  if (params.has("error")) return { error: "signin_cancelled" };
  const code = params.get("code");
  if (!code) return { error: "invalid_redirect" };
  if (params.get("state") !== expected.state) return { error: "state_mismatch" };
  return { code, issuedClientId: clientId };
}

// ---------------------------------------------------------------- token endpoint

const TokenDoc = z
  .object({
    access_token: z.string().min(1).max(20_000),
    refresh_token: z.string().min(1).max(20_000).optional(),
    id_token: z.string().min(1).max(20_000).optional(),
    expires_in: z.coerce.number().int().positive().max(31_536_000),
    scope: z.string().max(2_000).optional(),
    client_id: z.string().regex(CLIENT_ID_RE).optional(),
    token_type: z.string().optional(),
  })
  .loose();

const ErrorDoc = z.object({ error: z.string().max(100) }).loose();

/** Form-encoded POST to the token endpoint; OAuth errors become `OAuthError` (codes and status only). */
async function tokenRequest(d: Discovery, fields: Record<string, string>, fetchFn: typeof fetch) {
  let res: Response;
  try {
    res = await fetchFn(d.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError("unavailable", null, false);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorDoc.safeParse(body);
    const code = err.success && /^[a-z_]+$/u.test(err.data.error) ? err.data.error : "unavailable";
    const terminal = TERMINAL_CODES.has(code) || (res.status === 401 && code !== "unavailable");
    throw new OAuthError(code, res.status, terminal && res.status < 500);
  }
  const parsed = TokenDoc.safeParse(body);
  if (!parsed.success) throw new OAuthError("invalid_token_response", res.status, false);
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    idToken: t.id_token ?? null,
    expiresIn: t.expires_in,
    scopes: t.scope === undefined ? null : t.scope.split(/\s+/u).filter(Boolean),
    clientId: t.client_id ?? null,
  } satisfies TokenResponse;
}

export async function exchangeCode(
  d: Discovery,
  i: { code: string; verifier: string; redirectUri: string; clientId: string },
  fetchFn: typeof fetch = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    d,
    {
      grant_type: "authorization_code",
      code: i.code,
      code_verifier: i.verifier,
      redirect_uri: i.redirectUri,
      client_id: i.clientId,
    },
    fetchFn,
  );
}

export async function refreshTokens(
  d: Discovery,
  i: { refreshToken: string; clientId: string },
  fetchFn: typeof fetch = fetch,
): Promise<TokenResponse> {
  return tokenRequest(
    d,
    {
      grant_type: "refresh_token",
      refresh_token: i.refreshToken,
      client_id: i.clientId,
      resource: CHATGPT_RESOURCE,
    },
    fetchFn,
  );
}

/** RFC 7009 revocation, best effort: never throws (a disconnect always erases the local tokens). */
export async function revokeTokens(
  d: Discovery,
  i: { token: string; clientId: string },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!d.revocationEndpoint) return;
  try {
    await fetchFn(d.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: i.token, client_id: i.clientId }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------- ID token

const jwksCache = new Map<string, JWTVerifyGetKey>();

function remoteKeys(jwksUri: string): JWTVerifyGetKey {
  let keys = jwksCache.get(jwksUri);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: HTTP_TIMEOUT_MS });
    jwksCache.set(jwksUri, keys);
  }
  return keys;
}

const PLAN_CLAIM = "https://api.openai.com/auth";

/**
 * Verifies the ID token's signature against the issuer's JWKS, its issuer, audience (the client id the tokens were
 * issued to), expiry and nonce. `keys` is a test seam (a local JWKS).
 */
export async function validateIdToken(
  d: Discovery,
  idToken: string,
  i: { audience: string; nonce: string },
  keys: JWTVerifyGetKey = remoteKeys(d.jwksUri),
): Promise<{ subject: string; email: string | null; planType: string | null }> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: d.issuer,
      audience: i.audience,
      algorithms: ["RS256", "ES256", "PS256"],
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ["sub", "exp", "iat"],
    });
    if (payload.nonce !== i.nonce || typeof payload.sub !== "string" || !payload.sub)
      throw new Error("claims");
    const auth = payload[PLAN_CLAIM];
    const plan =
      auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_plan_type : undefined;
    return {
      subject: payload.sub.slice(0, 200),
      email: typeof payload.email === "string" ? payload.email.slice(0, 320) : null,
      planType: typeof plan === "string" && plan ? plan.slice(0, 40) : null,
    };
  } catch {
    throw new OAuthError("id_token_invalid", null, true);
  }
}
