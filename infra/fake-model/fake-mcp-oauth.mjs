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
//                                (RFC 9207). Unknown client or redirect → 400, never a redirect
//   POST /mcp-oauth/token        authorization_code: single-use 5-minute codes, PKCE S256, `resource` must match
//   POST /mcp-oauth/mcp          streamable HTTP MCP behind a bearer (401 + WWW-Authenticate resource_metadata);
//                                tools whoami (→ {subject, scopes}), create_record, echo_auth
//   POST /mcp-oauth/__scenario   test knobs; each call replaces the previous scenario
//   GET  /mcp-oauth/__stats      counters + sha256 hashes of issued access tokens (never a token)
//
// Tokens are `fakeat_…` / `fakert_…`; every grant gets its own random subject `sub_…`.
import { createHash, randomBytes, randomUUID } from "node:crypto";

const PREFIX = "/mcp-oauth";
const PRM_PATH = "/.well-known/oauth-protected-resource/mcp-oauth/mcp";
const AS_META_PATH = "/.well-known/oauth-authorization-server/mcp-oauth";
const CODE_TTL_MS = 5 * 60_000;
const RESOURCE_SCOPES = ["records:read", "records:write"];
const DEFAULT_SCOPE = "records:read";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "ocw-fake-mcp-oauth", title: "OCW fake OAuth MCP server", version: "1.0.0" };

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

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const toolResult = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(typeof value === "string" ? {} : { structuredContent: value }),
});

function freshStats() {
  return {
    tokenRequests: { authorization_code: 0, refresh_token: 0 },
    lastResource: { authorize: null, token: null, refresh: null },
    mcpRequests: 0,
    mcpCalls: 0,
    accessTokenHashes: [],
  };
}

export function createFakeMcpOAuth(opts = {}) {
  const preRegistered = (opts.preRegistered ?? []).map((c) => ({
    client_id: c.client_id,
    client_secret: c.client_secret,
    redirect_uris: [...c.redirect_uris],
  }));

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
    records = 0;
  }
  reset();

  const origins = (req) => {
    const origin = `http://${req.headers.host}`;
    return {
      origin,
      issuer: `${origin}${PREFIX}`,
      resource: `${origin}${PREFIX}/mcp`,
      prmUrl: `${origin}${PRM_PATH}`,
    };
  };

  function prm(o) {
    return {
      resource: o.resource,
      authorization_servers: [o.issuer],
      scopes_supported: RESOURCE_SCOPES,
      bearer_methods_supported: ["header"],
    };
  }

  function asMetadata(o) {
    return {
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
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    };
  }

  function issue(familyId) {
    const fam = families.get(familyId);
    const accessToken = `fakeat_${rand()}`;
    const refreshToken = `fakert_${rand()}`;
    const expiresIn = typeof scenario.expires_in === "number" ? scenario.expires_in : 3600;
    accessTokens.set(accessToken, { familyId, exp: Date.now() + expiresIn * 1000 });
    refreshTokens.set(refreshToken, { familyId, state: "active" });
    stats.accessTokenHashes.push(sha256Hex(accessToken));
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: fam.scope,
    };
  }

  function revokeFamily(familyId) {
    const fam = families.get(familyId);
    if (fam) fam.revoked = true;
    for (const rt of refreshTokens.values()) if (rt.familyId === familyId) rt.state = "revoked";
  }

  /** The grant behind a bearer, or null when it is unknown, expired or revoked. */
  function grantOf(token) {
    const at = accessTokens.get(token);
    if (!at || at.exp <= Date.now()) return null;
    const fam = families.get(at.familyId);
    return fam && !fam.revoked ? fam : null;
  }

  async function authorize(res, url, o) {
    const q = url.searchParams;
    stats.lastResource.authorize = q.get("resource");
    // Client and redirect URI problems are answered here, never by redirecting (RFC 6749 §4.1.2.1).
    const client = clients.get(q.get("client_id") ?? "");
    if (!client) return send(res, 400, { error: "invalid_client", error_description: "unknown client_id" });
    const redirectUri = q.get("redirect_uri") ?? "";
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
      target.searchParams.set("iss", o.issuer);
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
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    const basic = /^Basic\s+(.+)$/iu.exec(req.headers.authorization ?? "");
    if (basic) {
      const decoded = Buffer.from(basic[1], "base64").toString("utf8");
      const i = decoded.indexOf(":");
      id = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    const client = clients.get(id ?? "");
    if (!client) return null;
    if (client.client_secret !== undefined && client.client_secret !== secret) return null;
    return client;
  }

  async function token(req, res, o) {
    const form = new URLSearchParams(await readText(req));
    const err = (error, status = 400) => send(res, status, { error, error_description: `fake: ${error}` });
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      stats.tokenRequests.authorization_code += 1;
      stats.lastResource.token = form.get("resource");
      const client = authenticateClient(req, form);
      if (!client) return err("invalid_client", 401);
      const codeValue = form.get("code") ?? "";
      const code = codes.get(codeValue);
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
      return send(res, 200, issue(familyId));
    }
    return err("unsupported_grant_type");
  }

  // ── MCP (streamable HTTP, single JSON responses) ────────────────────────────────────────────────────────

  function bearerChallenge(o, extra = "") {
    return `Bearer ${extra}resource_metadata="${o.prmUrl}", scope="${DEFAULT_SCOPE}"`;
  }

  function callTool(params, grant, req) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "whoami")
      return { result: toolResult({ subject: grant.subject, scopes: grant.scope.split(" ") }) };
    if (name === "echo_auth") return { result: toolResult(req.headers.authorization ?? "") };
    if (name === "create_record") {
      if (!grant.scope.split(" ").includes("records:write")) return { insufficientScope: "records:write" };
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
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(\S+)$/u.exec(header);
    if (!m) {
      return send(res, 401, { error: "unauthorized" }, { "www-authenticate": bearerChallenge(o) });
    }
    const grant = grantOf(m[1]);
    if (!grant) {
      return send(
        res,
        401,
        { error: "invalid_token" },
        { "www-authenticate": bearerChallenge(o, 'error="invalid_token", ') },
      );
    }
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
        const out = callTool(msg.params, grant, req);
        if (!out) return send(res, 200, rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`));
        if (out.insufficientScope) {
          return send(
            res,
            403,
            { error: "insufficient_scope" },
            {
              "www-authenticate": `Bearer error="insufficient_scope", scope="${RESOURCE_SCOPES.join(" ")}", resource_metadata="${o.prmUrl}"`,
            },
          );
        }
        return send(res, 200, rpcResult(msg.id, out.result));
      }
      default:
        return send(res, 200, rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
    }
  }

  // ── Routing ──────────────────────────────────────────────────────────────────────────────────────────────

  function owns(p) {
    return (
      p === PREFIX ||
      p.startsWith(`${PREFIX}/`) ||
      p === "/.well-known/oauth-protected-resource/mcp-oauth" ||
      p.startsWith("/.well-known/oauth-protected-resource/mcp-oauth/") ||
      p === AS_META_PATH ||
      p.startsWith(`${AS_META_PATH}/`)
    );
  }

  async function route(req, res, url) {
    const o = origins(req);
    const p = url.pathname;
    const get = req.method === "GET";
    const post = req.method === "POST";
    if (get && p === PRM_PATH) return send(res, 200, prm(o));
    if (get && p === AS_META_PATH) return send(res, 200, asMetadata(o));
    if (get && p === `${PREFIX}/authorize`) return authorize(res, url, o);
    if (post && p === `${PREFIX}/token`) return token(req, res, o);
    if (p === `${PREFIX}/mcp`) return mcpEndpoint(req, res, o);
    if (post && p === `${PREFIX}/__scenario`) {
      const text = await readText(req);
      setScenario(text ? JSON.parse(text) : {});
      return send(res, 200, { scenario });
    }
    if (get && p === `${PREFIX}/__stats`) return send(res, 200, stats);
    return send(res, 404, { error: "not_found" });
  }

  function setScenario(s) {
    scenario = s && typeof s === "object" ? { ...s } : {};
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
    return { access: [...accessTokens.keys()], refresh: [...refreshTokens.keys()], codes: [...codes.keys()] };
  }

  return { handle, issuedTokens, setScenario, reset };
}
