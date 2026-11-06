// Fake OAuth-protected MCP server + its authorization server (07.4-04). Test-only: 07.4's connector tests point a
// `per_member_oauth` MCP server at `<fake>/mcp-oauth/mcp`; nothing here ever talks to a real provider. No
// dependencies. It follows the MCP authorization spec closely enough that a client passing against it is
// spec-correct: it refuses what the spec forbids a client to omit (PKCE S256, `resource`, exact redirect URIs).
//
// Every URL is built from the request's own origin (Host header): http://127.0.0.1:<port> in tests,
// http://fake-mcp:4291 in a compose network.
//
//   GET  /.well-known/oauth-protected-resource/mcp-oauth/mcp   protected resource metadata (RFC 9728)
//   GET  /.well-known/oauth-authorization-server/mcp-oauth     AS metadata (RFC 8414, path insertion)
//   GET  /mcp-oauth/authorize    auto-approves; 302 to the exact registered redirect with code, state and iss
//                                (RFC 9207). Unknown client or redirect → 400, never a redirect. A client_id that
//                                is an https URL is a client ID metadata document, read through `cimdFetch`
//   POST /mcp-oauth/token        authorization_code (single-use 5-minute codes, PKCE S256, `resource` must match,
//                                an unsigned `id_token` whose email is `<subject>@fake-mcp.test`) and refresh_token
//                                (`resource` required, rotation; a rotated token → invalid_grant + family revoked)
//                                and client_credentials (RFC 6749 §4.4, 07.14-03: pre-registered confidential clients
//                                only, Basic or post auth, `resource` required, no refresh token, subject
//                                `sub_cc_<client_id>`)
//   POST /mcp-oauth/revoke       RFC 7009: always 200; an access or refresh token revokes its whole grant
//   POST /mcp-oauth/register     RFC 7591 dynamic client registration
//   POST /mcp-oauth/mcp          streamable HTTP MCP behind a bearer (401 + WWW-Authenticate resource_metadata);
//                                tools whoami (→ {subject, scopes}), create_record (needs records:write), echo_auth
//   POST /mcp-oauth/__scenario   test knobs (see FakeMcpOAuthScenario in the .d.mts); each call replaces the last
//   GET  /mcp-oauth/__stats      counters + sha256 hashes of issued access tokens (never a token)
//   /mcp-oauth/alt/*             a second authorization server (issuer `<base>/mcp-oauth/alt`, metadata at
//                                `/.well-known/oauth-authorization-server/mcp-oauth/alt`): `different_issuer` and
//                                `wrong_iss` point at it
//
// Keychain targets (07.4 keychain tests), never MCP:
//   GET|HEAD|POST /kc/whoami   200 {authorized, method} for `Bearer <kcToken>`, Basic kcuser:kcpass or a
//                              /kc/token bearer; 401 otherwise
//   ANY  /kc/echo              200 {method, headers}: the request headers it received
//   GET  /kc/redirect          302 to the cloud metadata address
//   GET  /kc/big               200, a 512 KB text body
//   POST /kc/token             client_credentials for kc-client / kc-secret → a 60 s bearer
//
// Tokens are `fakeat_…` / `fakert_…` / `fakekc_…`; every grant gets its own random subject `sub_…`.
import { createHash, randomBytes, randomUUID } from "node:crypto";

const PREFIX = "/mcp-oauth";
const ALT = "/alt";
const PRM_PATH = "/.well-known/oauth-protected-resource/mcp-oauth/mcp";
const AS_META_PATH = "/.well-known/oauth-authorization-server/mcp-oauth";
const KC = "/kc";
const CODE_TTL_MS = 5 * 60_000;
const RESOURCE_SCOPES = ["records:read", "records:write"];
const DEFAULT_SCOPE = "records:read";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "ocw-fake-mcp-oauth", title: "OCW fake OAuth MCP server", version: "1.0.0" };
const AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"];
const DEFAULT_KC_TOKEN = "fake-kc-token";
const KC_BASIC = { user: "kcuser", pass: "kcpass" };
const KC_CLIENT = { id: "kc-client", secret: "kc-secret" };
const KC_TOKEN_TTL_S = 60;
const KC_BIG_BYTES = 512 * 1024;
const METADATA_ADDRESS = "http://169.254.169.254/latest/meta-data/";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const FAKE_MCP_OAUTH_TOOLS = [
  {
    name: "whoami",
    title: "Who am I",
    description: "Returns the subject and scopes of the bearer that made this call. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "create_record",
    title: "Create record",
    description: "Creates a record. Has side effects; needs records:write.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "echo_auth",
    title: "Echo Authorization",
    description: "Returns the Authorization header this call carried (redaction tests). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
];

const rand = (n = 18) => randomBytes(n).toString("base64url");
const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
const s256 = (verifier) => createHash("sha256").update(verifier).digest("base64url");
const b64url = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(res, status, body, headers = {}) {
  if (body === undefined) {
    res.writeHead(status, { "cache-control": "no-store", ...headers });
    return void res.end();
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readText(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** `Authorization: Basic …` → {id, secret} (RFC 6749 §2.3.1 form-encodes both), or null. */
function basicCredentials(req) {
  const m = /^Basic\s+(\S+)$/iu.exec(req.headers.authorization ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  try {
    return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
  } catch {
    return null;
  }
}

/** A URL a client ID metadata document can live at: https with a path (spec: client-registration). */
function isCimdUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.pathname !== "/" && !u.hash;
  } catch {
    return false;
  }
}

/** Redirect URIs the spec allows: https, or http on a loopback host. */
function allowedRedirect(value) {
  try {
    const u = new URL(value);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

async function defaultCimdFetch(url) {
  const res = await fetch(url, {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`client metadata document: HTTP ${res.status}`);
  return res.json();
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const toolResult = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(typeof value === "string" ? {} : { structuredContent: value }),
});

function freshStats() {
  return {
    tokenRequests: { authorization_code: 0, refresh_token: 0, client_credentials: 0 },
    refreshReuse: 0,
    revocations: 0,
    registrations: 0,
    lastResource: { authorize: null, token: null, refresh: null, cc: null },
    /** How the last token request authenticated the client: "basic" | "post" | "none" (never the secret). */
    lastClientAuth: null,
    mcpRequests: 0,
    mcpCalls: 0,
    accessTokenHashes: [],
    kc: { tokenRequests: 0, authorized: 0, rejected: 0 },
  };
}

export function createFakeMcpOAuth(opts = {}) {
  const preRegistered = (opts.preRegistered ?? []).map((c) => ({
    client_id: c.client_id,
    client_secret: c.client_secret,
    redirect_uris: [...c.redirect_uris],
  }));
  const cimdFetch = opts.cimdFetch ?? defaultCimdFetch;
  const kcToken = opts.kcToken || DEFAULT_KC_TOKEN;
  // The Basic pair and the client-credentials client /kc accepts (leak sweeps pass canaries; 07.4-12).
  const kcBasic = opts.kcBasic ?? KC_BASIC;
  const kcClient = opts.kcClient ?? KC_CLIENT;

  let scenario = {};
  let stats = freshStats();
  /** client_id → { client_id, client_secret?, redirect_uris } */
  let clients = new Map();
  /** code → { clientId, redirectUri, challenge, resource, scope, issuer, exp, used, familyId } */
  let codes = new Map();
  /** familyId → { subject, clientId, scope, resource, issuer, revoked } */
  let families = new Map();
  /** access token → { familyId, exp } */
  let accessTokens = new Map();
  /** refresh token → { familyId, state: "active" | "rotated" | "revoked" } */
  let refreshTokens = new Map();
  /** MCP session id → subject (a session is bound to the grant that opened it) */
  let sessions = new Map();
  /** /kc/token bearer → expiry (ms) */
  let kcTokens = new Map();
  let records = 0;

  function reset() {
    scenario = {};
    stats = freshStats();
    clients = new Map(preRegistered.map((c) => [c.client_id, c]));
    codes = new Map();
    families = new Map();
    accessTokens = new Map();
    refreshTokens = new Map();
    sessions = new Map();
    kcTokens = new Map();
    records = 0;
  }
  reset();

  /** The URLs of one authorization server (`alt` = the second one) as seen from this request's origin. */
  const origins = (req, alt = false) => {
    const origin = `http://${req.headers.host}`;
    const main = `${origin}${PREFIX}`;
    const other = `${origin}${PREFIX}${ALT}`;
    return {
      origin,
      issuer: alt ? other : main,
      otherIssuer: alt ? main : other,
      resource: `${origin}${PREFIX}/mcp`,
      prmUrl: `${origin}${PRM_PATH}`,
    };
  };

  function prm(o) {
    return {
      resource: o.resource,
      authorization_servers: [
        scenario.different_issuer ? `${o.origin}${PREFIX}${ALT}` : `${o.origin}${PREFIX}`,
      ],
      scopes_supported: RESOURCE_SCOPES,
      bearer_methods_supported: ["header"],
    };
  }

  function asMetadata(o) {
    const meta = {
      issuer: o.issuer,
      authorization_endpoint: `${o.issuer}/authorize`,
      token_endpoint: `${o.issuer}/token`,
      revocation_endpoint: `${o.issuer}/revoke`,
      registration_endpoint: `${o.issuer}/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [...RESOURCE_SCOPES, "offline_access"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
    };
    if (scenario.no_pkce_meta) delete meta.code_challenge_methods_supported;
    if (scenario.no_registration) {
      delete meta.registration_endpoint;
      delete meta.client_id_metadata_document_supported;
    }
    return meta;
  }

  /** Unsigned (alg none) id_token: only a display label for the connection, never verified by anyone. */
  function idToken(fam) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: fam.issuer,
      sub: fam.subject,
      aud: fam.clientId,
      email: `${fam.subject}@fake-mcp.test`,
      email_verified: true,
      iat: now,
      exp: now + 3600,
    };
    return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.`;
  }

  function issue(familyId, { withIdToken, withRefresh = true }) {
    const fam = families.get(familyId);
    const accessToken = `fakeat_${rand()}`;
    const expiresIn = typeof scenario.expires_in === "number" ? scenario.expires_in : 3600;
    accessTokens.set(accessToken, { familyId, exp: Date.now() + expiresIn * 1000 });
    stats.accessTokenHashes.push(sha256Hex(accessToken));
    let refreshToken;
    if (withRefresh) {
      refreshToken = `fakert_${rand()}`;
      refreshTokens.set(refreshToken, { familyId, state: "active" });
    }
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: fam.scope,
      ...(withIdToken && !scenario.no_id_token ? { id_token: idToken(fam) } : {}),
    };
  }

  function revokeFamily(familyId) {
    const fam = families.get(familyId);
    if (fam) fam.revoked = true;
    for (const rt of refreshTokens.values()) if (rt.familyId === familyId) rt.state = "revoked";
  }

  /** The grant behind a bearer for this resource, or null when unknown, expired, revoked or for another one. */
  function grantOf(token, o) {
    if (scenario.revoke_all) return null;
    const at = accessTokens.get(token);
    if (!at || at.exp <= Date.now()) return null;
    const fam = families.get(at.familyId);
    return fam && !fam.revoked && fam.resource === o.resource ? fam : null;
  }

  /**
   * The client for an authorize request. A pre-registered or registered client_id is looked up; an https URL is a
   * client ID metadata document, fetched each time and accepted only when it names itself and the redirect URI.
   */
  async function resolveClient(clientId, redirectUri) {
    if (!isCimdUrl(clientId)) return clients.get(clientId) ?? null;
    let doc;
    try {
      doc = await cimdFetch(clientId);
    } catch {
      return null;
    }
    if (!doc || typeof doc !== "object" || doc.client_id !== clientId) return null;
    const uris = Array.isArray(doc.redirect_uris)
      ? doc.redirect_uris.filter((u) => typeof u === "string")
      : [];
    if (!uris.includes(redirectUri)) return null;
    // Public clients only (no private_key_jwt here); a document asking for a secret method is refused.
    if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none")
      return null;
    const client = { client_id: clientId, redirect_uris: uris };
    clients.set(clientId, client);
    return client;
  }

  async function authorize(res, url, o) {
    const q = url.searchParams;
    stats.lastResource.authorize = q.get("resource");
    // Client and redirect URI problems are answered here, never by redirecting (RFC 6749 §4.1.2.1).
    const redirectUri = q.get("redirect_uri") ?? "";
    const client = await resolveClient(q.get("client_id") ?? "", redirectUri);
    if (!client) return send(res, 400, { error: "invalid_client", error_description: "unknown client_id" });
    if (!client.redirect_uris.includes(redirectUri))
      return send(res, 400, {
        error: "invalid_request",
        error_description: "redirect_uri is not registered",
      });

    const target = new URL(redirectUri);
    const state = q.get("state");
    const back = (params) => {
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
      if (state !== null) target.searchParams.set("state", state);
      if (!scenario.no_iss) target.searchParams.set("iss", scenario.wrong_iss ? o.otherIssuer : o.issuer);
      return send(res, 302, undefined, { location: target.toString() });
    };
    const fail = (error, why) => back({ error, error_description: why });

    if (q.get("response_type") !== "code")
      return fail("unsupported_response_type", "response_type must be code");
    if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256")
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    if (!state) return fail("invalid_request", "state is required");
    if (q.get("resource") !== o.resource)
      return fail("invalid_target", "resource must be the protected resource");
    const requested = (q.get("scope") ?? "").split(/\s+/u).filter(Boolean);
    const known = [...RESOURCE_SCOPES, "offline_access"];
    if (requested.some((s) => !known.includes(s))) return fail("invalid_scope", "unknown scope");
    if (scenario.deny) return fail("access_denied", "the user denied the request");
    const scope = requested.filter((s) => s !== "offline_access").join(" ") || DEFAULT_SCOPE;

    const code = `fakecode_${rand()}`;
    codes.set(code, {
      clientId: client.client_id,
      redirectUri,
      challenge: q.get("code_challenge"),
      resource: o.resource,
      scope,
      issuer: o.issuer,
      exp: Date.now() + CODE_TTL_MS,
      used: false,
      familyId: null,
    });
    return back({ code });
  }

  /** Client authentication at the token endpoint: Basic, client_secret_post, or none for public clients. */
  function authenticateClient(req, form) {
    const basic = basicCredentials(req);
    const id = basic ? basic.id : form.get("client_id");
    const secret = basic ? basic.secret : form.get("client_secret");
    const client = clients.get(id ?? "");
    if (!client) return null;
    if (client.client_secret !== undefined && client.client_secret !== secret) return null;
    return client;
  }

  /** How a token request presents client credentials (stats only, never the secret). */
  function clientAuthMethod(req, form) {
    if (/^Basic\s/iu.test(req.headers.authorization ?? "")) return "basic";
    return form.has("client_secret") ? "post" : "none";
  }

  /**
   * RFC 6749 §4.4 for pre-registered confidential clients (07.14-03). Strict like a real server: a public client is
   * `unauthorized_client`, `resource` must name this MCP (RFC 8707), unknown scopes are `invalid_scope`. Every grant
   * of one client has the same subject; there is no refresh token, so renewing means a new grant.
   */
  function clientCredentials(req, res, form, o, err) {
    const basic = basicCredentials(req);
    const known = clients.get((basic ? basic.id : form.get("client_id")) ?? "");
    if (!known) return err("invalid_client", 401);
    if (known.client_secret === undefined) return err("unauthorized_client");
    const client = authenticateClient(req, form);
    if (!client) return err("invalid_client", 401);
    if (form.get("resource") !== o.resource) return err("invalid_target");
    const requested = (form.get("scope") ?? "").split(/\s+/u).filter(Boolean);
    const supported = [...RESOURCE_SCOPES, "offline_access"];
    if (requested.some((s) => !supported.includes(s))) return err("invalid_scope");
    const scope = requested.filter((s) => s !== "offline_access").join(" ") || DEFAULT_SCOPE;
    const familyId = randomUUID();
    families.set(familyId, {
      subject: `sub_cc_${client.client_id}`,
      clientId: client.client_id,
      scope,
      resource: o.resource,
      issuer: o.issuer,
      revoked: false,
    });
    return send(res, 200, issue(familyId, { withIdToken: false, withRefresh: false }));
  }

  async function token(req, res, o) {
    const form = new URLSearchParams(await readText(req));
    const err = (error, status = 400) => send(res, status, { error, error_description: `fake: ${error}` });
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      stats.tokenRequests.authorization_code += 1;
      stats.lastResource.token = form.get("resource");
    } else if (grantType === "refresh_token") {
      stats.tokenRequests.refresh_token += 1;
      stats.lastResource.refresh = form.get("resource");
    } else if (grantType === "client_credentials") {
      stats.tokenRequests.client_credentials += 1;
      stats.lastResource.cc = form.get("resource");
    } else {
      return err("unsupported_grant_type");
    }
    stats.lastClientAuth = clientAuthMethod(req, form);
    if (scenario.fail_token_5xx) return err("temporarily_unavailable", 503);
    if (grantType === "client_credentials") return clientCredentials(req, res, form, o, err);
    const client = authenticateClient(req, form);
    if (!client) return err("invalid_client", 401);

    if (grantType === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      if (!code || code.exp < Date.now() || code.issuer !== o.issuer) return err("invalid_grant");
      if (code.used) {
        // RFC 6749 §4.1.2: a replayed code revokes what it bought.
        if (code.familyId) revokeFamily(code.familyId);
        return err("invalid_grant");
      }
      code.used = true;
      if (code.clientId !== client.client_id) return err("invalid_grant");
      if (form.get("redirect_uri") !== code.redirectUri) return err("invalid_grant");
      const verifier = form.get("code_verifier") ?? "";
      if (!verifier || s256(verifier) !== code.challenge) return err("invalid_grant");
      if (form.get("resource") !== code.resource) return err("invalid_target");
      const familyId = randomUUID();
      code.familyId = familyId;
      families.set(familyId, {
        subject: `sub_${rand(9)}`,
        clientId: client.client_id,
        scope: code.scope,
        resource: code.resource,
        issuer: code.issuer,
        revoked: false,
      });
      return send(res, 200, issue(familyId, { withIdToken: true }));
    }

    // refresh_token: rotation, and reuse of a rotated token revokes the whole family (like fake-siwc).
    const rt = refreshTokens.get(form.get("refresh_token") ?? "");
    const fam = rt ? families.get(rt.familyId) : null;
    if (!rt || !fam || fam.issuer !== o.issuer) return err("invalid_grant");
    if (rt.state === "rotated") {
      stats.refreshReuse += 1;
      revokeFamily(rt.familyId);
      return err("invalid_grant");
    }
    if (rt.state === "revoked" || fam.revoked || scenario.revoke_all) return err("invalid_grant");
    if (fam.clientId !== client.client_id) return err("invalid_grant");
    if (form.get("resource") !== fam.resource) return err("invalid_target");
    rt.state = "rotated";
    return send(res, 200, issue(rt.familyId, { withIdToken: false }));
  }

  async function revoke(req, res) {
    const form = new URLSearchParams(await readText(req));
    stats.revocations += 1;
    const t = form.get("token") ?? "";
    const familyId = refreshTokens.get(t)?.familyId ?? accessTokens.get(t)?.familyId;
    if (familyId) revokeFamily(familyId);
    return send(res, 200);
  }

  async function register(req, res) {
    let body;
    try {
      body = JSON.parse(await readText(req));
    } catch {
      return send(res, 400, { error: "invalid_client_metadata", error_description: "body must be JSON" });
    }
    const uris = body?.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      !uris.every((u) => typeof u === "string" && allowedRedirect(u))
    )
      return send(res, 400, {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be https or loopback http",
      });
    const method = body.token_endpoint_auth_method ?? "client_secret_basic";
    if (!AUTH_METHODS.includes(method))
      return send(res, 400, {
        error: "invalid_client_metadata",
        error_description: "unsupported auth method",
      });
    const client = {
      client_id: `dcr_${rand(9)}`,
      ...(method === "none" ? {} : { client_secret: `dcrs_${rand()}` }),
      redirect_uris: [...uris],
    };
    clients.set(client.client_id, client);
    stats.registrations += 1;
    return send(res, 201, {
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(client.client_secret ? { client_secret_expires_at: 0 } : {}),
      token_endpoint_auth_method: method,
      grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: body.response_types ?? ["code"],
      ...(body.application_type ? { application_type: body.application_type } : {}),
      ...(body.client_name ? { client_name: body.client_name } : {}),
      ...(body.scope ? { scope: body.scope } : {}),
    });
  }

  // ── MCP (streamable HTTP, single JSON responses) ────────────────────────────────────────────────────────

  function bearerChallenge(o, extra = "") {
    return `Bearer ${extra}resource_metadata="${o.prmUrl}", scope="${DEFAULT_SCOPE}"`;
  }

  function insufficientScope(res, o) {
    return send(
      res,
      403,
      { error: "insufficient_scope" },
      {
        "www-authenticate": `Bearer error="insufficient_scope", scope="${RESOURCE_SCOPES.join(" ")}", resource_metadata="${o.prmUrl}"`,
      },
    );
  }

  function callTool(params, grant, req) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "whoami")
      return { result: toolResult({ subject: grant.subject, scopes: grant.scope.split(" ") }) };
    if (name === "echo_auth") return { result: toolResult(req.headers.authorization ?? "") };
    if (name === "create_record") {
      if (!grant.scope.split(" ").includes("records:write")) return { insufficientScope: true };
      if (typeof args.title !== "string" || !args.title)
        return {
          result: { ...toolResult("create_record: `title` must be a non-empty string"), isError: true },
        };
      records += 1;
      return { result: toolResult({ id: `rec_${records}`, title: args.title }) };
    }
    return null;
  }

  async function mcpEndpoint(req, res, o) {
    stats.mcpRequests += 1;
    const m = /^Bearer\s+(\S+)$/u.exec(req.headers.authorization ?? "");
    if (!m) return send(res, 401, { error: "unauthorized" }, { "www-authenticate": bearerChallenge(o) });
    const grant = grantOf(m[1], o);
    if (!grant) {
      return send(
        res,
        401,
        { error: "invalid_token" },
        { "www-authenticate": bearerChallenge(o, 'error="invalid_token", ') },
      );
    }
    if (scenario.insufficient_scope) return insufficientScope(res, o);
    if (req.method === "DELETE") {
      const id = req.headers["mcp-session-id"];
      if (!id || sessions.get(id) !== grant.subject)
        return send(res, 404, rpcError(null, -32001, "Session not found"));
      sessions.delete(id);
      return send(res, 204);
    }
    if (req.method !== "POST")
      return send(res, 405, rpcError(null, -32000, "Method not allowed"), { allow: "POST, DELETE" });

    let msg;
    try {
      msg = JSON.parse(await readText(req));
    } catch {
      return send(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0")
      return send(res, 400, rpcError(msg?.id, -32600, "Invalid request"));
    const isRequest = typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;

    if (msg.method === "initialize") {
      if (!isRequest) return send(res, 400, rpcError(null, -32600, "initialize needs an id"));
      const requested = msg.params?.protocolVersion;
      const sessionId = randomUUID();
      sessions.set(sessionId, grant.subject);
      return send(
        res,
        200,
        rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
        { "mcp-session-id": sessionId },
      );
    }
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId)
      return send(res, 400, rpcError(msg.id, -32000, "Bad Request: Mcp-Session-Id header is required"));
    // A session belongs to the grant that opened it: another member's bearer cannot ride it.
    if (sessions.get(sessionId) !== grant.subject)
      return send(res, 404, rpcError(msg.id, -32001, "Session not found"));
    if (!isRequest) return send(res, 202);

    switch (msg.method) {
      case "ping":
        return send(res, 200, rpcResult(msg.id, {}));
      case "tools/list":
        return send(res, 200, rpcResult(msg.id, { tools: FAKE_MCP_OAUTH_TOOLS }));
      case "tools/call": {
        stats.mcpCalls += 1;
        if (typeof scenario.slow_mcp_ms === "number" && scenario.slow_mcp_ms > 0)
          await sleep(scenario.slow_mcp_ms);
        const out = callTool(msg.params, grant, req);
        if (!out) return send(res, 200, rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`));
        if (out.insufficientScope) return insufficientScope(res, o);
        return send(res, 200, rpcResult(msg.id, out.result));
      }
      default:
        return send(res, 200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
    }
  }

  // ── Keychain targets (/kc) ──────────────────────────────────────────────────────────────────────────────

  /** How a /kc request authenticated: "bearer" | "basic" | "client_credentials", or null. */
  function kcMethod(req) {
    const header = req.headers.authorization ?? "";
    const bearer = /^Bearer\s+(\S+)$/u.exec(header);
    if (bearer) {
      if (bearer[1] === kcToken) return "bearer";
      const exp = kcTokens.get(bearer[1]);
      return exp !== undefined && exp > Date.now() ? "client_credentials" : null;
    }
    const basic = basicCredentials(req);
    return basic && basic.id === kcBasic.user && basic.secret === kcBasic.pass ? "basic" : null;
  }

  async function keychain(req, res, p) {
    if (p === `${KC}/whoami`) {
      if (!["GET", "HEAD", "POST"].includes(req.method ?? ""))
        return send(res, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD, POST" });
      await readText(req);
      const method = kcMethod(req);
      const head = req.method === "HEAD";
      if (!method) {
        stats.kc.rejected += 1;
        const headers = { "www-authenticate": 'Bearer realm="fake-kc"' };
        return head ? send(res, 401, undefined, headers) : send(res, 401, { authorized: false }, headers);
      }
      stats.kc.authorized += 1;
      return head
        ? send(res, 200, undefined, { "content-type": "application/json" })
        : send(res, 200, { authorized: true, method });
    }
    if (p === `${KC}/echo`) {
      await readText(req);
      return send(res, 200, { method: req.method, headers: { ...req.headers } });
    }
    if (req.method === "GET" && p === `${KC}/redirect`)
      return send(res, 302, undefined, { location: METADATA_ADDRESS });
    if (req.method === "GET" && p === `${KC}/big`) {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(KC_BIG_BYTES),
      });
      return void res.end("x".repeat(KC_BIG_BYTES));
    }
    if (req.method === "POST" && p === `${KC}/token`) {
      stats.kc.tokenRequests += 1;
      const form = new URLSearchParams(await readText(req));
      const basic = basicCredentials(req);
      const id = basic ? basic.id : form.get("client_id");
      const secret = basic ? basic.secret : form.get("client_secret");
      if (id !== kcClient.id || secret !== kcClient.secret)
        return send(res, 401, { error: "invalid_client", error_description: "fake: invalid_client" });
      if (form.get("grant_type") !== "client_credentials")
        return send(res, 400, {
          error: "unsupported_grant_type",
          error_description: "fake: client_credentials only",
        });
      const accessToken = `fakekc_${rand()}`;
      kcTokens.set(accessToken, Date.now() + KC_TOKEN_TTL_S * 1000);
      return send(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: KC_TOKEN_TTL_S });
    }
    return send(res, 404, { error: "not_found" });
  }

  // ── Routing ──────────────────────────────────────────────────────────────────────────────────────────────

  function owns(p) {
    return (
      p === PREFIX ||
      p.startsWith(`${PREFIX}/`) ||
      p === "/.well-known/oauth-protected-resource/mcp-oauth" ||
      p.startsWith("/.well-known/oauth-protected-resource/mcp-oauth/") ||
      p === AS_META_PATH ||
      p.startsWith(`${AS_META_PATH}/`) ||
      p.startsWith(`${KC}/`)
    );
  }

  /** The four authorization server endpoints, for the main issuer or the alternate one. */
  function asEndpoint(req, res, url, sub, o) {
    if (req.method === "GET" && sub === "/authorize") return authorize(res, url, o);
    if (req.method === "POST" && sub === "/token") return token(req, res, o);
    if (req.method === "POST" && sub === "/revoke") return revoke(req, res);
    if (req.method === "POST" && sub === "/register") return register(req, res);
    return null;
  }

  async function route(req, res, url) {
    const p = url.pathname;
    if (p.startsWith(`${KC}/`)) return keychain(req, res, p);
    const o = origins(req);
    const get = req.method === "GET";
    const post = req.method === "POST";
    if (get && p === PRM_PATH) return send(res, 200, prm(o));
    if (get && p === AS_META_PATH) return send(res, 200, asMetadata(o));
    if (get && p === `${AS_META_PATH}${ALT}`) return send(res, 200, asMetadata(origins(req, true)));
    if (p === `${PREFIX}/mcp`) return mcpEndpoint(req, res, o);
    if (post && p === `${PREFIX}/__scenario`) {
      const text = await readText(req);
      setScenario(text ? JSON.parse(text) : {});
      return send(res, 200, { scenario });
    }
    if (get && p === `${PREFIX}/__stats`) return send(res, 200, stats);
    const handled = p.startsWith(`${PREFIX}${ALT}/`)
      ? asEndpoint(req, res, url, p.slice(`${PREFIX}${ALT}`.length), origins(req, true))
      : asEndpoint(req, res, url, p.slice(PREFIX.length), o);
    if (handled) return handled;
    return send(res, 404, { error: "not_found" });
  }

  /** Replaces the scenario. `revoke_all` also revokes every grant issued so far, for good. */
  function setScenario(s) {
    scenario = s && typeof s === "object" ? { ...s } : {};
    if (scenario.revoke_all) for (const id of families.keys()) revokeFamily(id);
  }

  /** Handles the routes above; returns false for any other path. */
  function handle(req, res, url) {
    if (!owns(url.pathname)) return false;
    route(req, res, url).catch((error) => {
      if (res.headersSent) return void res.end();
      send(res, 400, { error: "invalid_request", error_description: String(error?.message ?? error) });
    });
    return true;
  }

  /** In-process only (leak sweeps): every raw token and code issued so far. Never served over HTTP. */
  function issuedTokens() {
    return {
      access: [...accessTokens.keys(), ...kcTokens.keys()],
      refresh: [...refreshTokens.keys()],
      codes: [...codes.keys()],
    };
  }

  return { handle, issuedTokens, setScenario, reset };
}
