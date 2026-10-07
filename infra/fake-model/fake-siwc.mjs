// Fake "Sign in with ChatGPT – ChatGPT plan usage" authorization server (Phase 5, 05-05). Test-only: the API points
// OCW_CHATGPT_AUTH_BASE_URL at `<fake>/siwc`; nothing here ever talks to auth.openai.com. No dependencies.
//
//   GET  /siwc/.well-known/openid-configuration  discovery, every endpoint under the request's own base
//   GET  /siwc/.well-known/jwks.json             the RSA public key (generated at start) that signs id_tokens
//   GET  /siwc/api/accounts/authorize            no login page: approves at once and 302s to the loopback
//                                                redirect with `code`, `state` and, for `dynamic_agent_client`,
//                                                the issued `client_id` (`oaiapp_fake_…`)
//   POST /siwc/oauth/token                       authorization_code (single-use 5-minute codes, PKCE S256) and
//                                                refresh_token (rotation; a rotated token → refresh_token_reused)
//   POST /siwc/oauth/revoke                      RFC 7009, always 200
//   POST /siwc/__scenario                        {deny, no_plan_scope, expires_in, token_unavailable, email,
//                                                plan_type, sub}; each call replaces the previous scenario
//   GET  /siwc/__stats                           counters + sha256 hashes of issued access tokens (never a token)
//
// Tokens are `fake-plan-…` (the fake Responses API accepts them as plan bearers) and `fake-refresh-…`.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

const PREFIX = "/siwc";
const CODE_TTL_MS = 5 * 60_000;
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:(\d{2,5})\/auth\/callback$/u;
const DEFAULT_EMAIL = "member@fake-chatgpt.test";

const rand = (n = 18) => randomBytes(n).toString("base64url");
const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readText(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export function createFakeSiwc() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `fake-${rand(6)}`;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };

  let scenario = {};
  const codes = new Map(); // code → {clientId, redirectUri, challenge, nonce, scope, exp, used}
  const refreshTokens = new Map(); // token → {clientId, scope, state: "active" | "rotated" | "revoked"}
  const accessTokens = new Map(); // token → {revoked}
  const clients = new Set(); // issued client ids
  const stats = {
    authorize: 0,
    codeExchanges: 0,
    refresh: 0,
    revoke: 0,
    revokedRefreshTokens: 0,
    revokedAccessTokens: 0,
    accessTokenHashes: [],
  };

  function signJwt(claims) {
    const input = `${b64url({ alg: "RS256", typ: "JWT", kid })}.${b64url(claims)}`;
    const sig = createSign("RSA-SHA256").update(input).sign(privateKey);
    return `${input}.${sig.toString("base64url")}`;
  }

  function issue(issuer, { clientId, scope, nonce }) {
    const accessToken = `fake-plan-${rand()}`;
    const refreshToken = `fake-refresh-${rand()}`;
    accessTokens.set(accessToken, { revoked: false });
    refreshTokens.set(refreshToken, { clientId, scope, state: "active" });
    stats.accessTokenHashes.push(sha256Hex(accessToken));
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt({
      iss: issuer,
      aud: clientId,
      sub: scenario.sub ?? "fake-chatgpt-user-1",
      email: scenario.email ?? DEFAULT_EMAIL,
      email_verified: true,
      ...(nonce ? { nonce } : {}),
      iat: now,
      exp: now + 3600,
      "https://api.openai.com/auth": {
        chatgpt_plan_type: scenario.plan_type ?? "plus",
        chatgpt_account_id: "fake-account-1",
      },
    });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: typeof scenario.expires_in === "number" ? scenario.expires_in : 3600,
      scope,
    };
  }

  function grantedScope(requested) {
    const parts = requested.split(/\s+/u).filter(Boolean);
    return (scenario.no_plan_scope ? parts.filter((s) => s !== PLAN_SCOPE) : parts).join(" ");
  }

  function authorize(res, url) {
    stats.authorize += 1;
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const bad = (why) => send(res, 400, { error: "invalid_request", error_description: why });
    if (!LOOPBACK_REDIRECT.test(redirectUri))
      return bad("redirect_uri must be http://127.0.0.1:<port>/auth/callback");
    if (q.get("response_type") !== "code") return bad("response_type must be code");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
      return bad("PKCE S256 required");
    if (!q.get("state") || !q.get("nonce")) return bad("state and nonce required");
    const scope = q.get("scope") ?? "";
    if (!scope.split(/\s+/u).includes("openid")) return bad("openid scope required");
    let issued = null;
    if (clientId === "dynamic_agent_client") {
      if (!q.get("agent_name_hint") || !q.get("ext_agent_host_id"))
        return bad("agent_name_hint and ext_agent_host_id required");
      issued = `oaiapp_fake_${rand(9)}`;
      clients.add(issued);
    } else if (!clients.has(clientId)) {
      return bad("unknown client_id");
    }
    const target = new URL(redirectUri);
    target.searchParams.set("state", q.get("state"));
    if (scenario.deny) {
      target.searchParams.set("error", "access_denied");
      return send(res, 302, {}, { location: target.toString() });
    }
    const code = `fake-code-${rand()}`;
    codes.set(code, {
      clientId: issued ?? clientId,
      redirectUri,
      challenge: q.get("code_challenge"),
      nonce: q.get("nonce"),
      scope,
      resource: q.get("resource"),
      exp: Date.now() + CODE_TTL_MS,
      used: false,
    });
    target.searchParams.set("code", code);
    if (issued) target.searchParams.set("client_id", issued);
    return send(res, 302, {}, { location: target.toString() });
  }

  async function token(req, res, issuer) {
    const f = new URLSearchParams(await readText(req));
    if (scenario.token_unavailable)
      return send(res, 503, { error: "temporarily_unavailable", error_description: "fake outage" });
    const err = (error, status = 400) => send(res, status, { error, error_description: `fake: ${error}` });
    const grant = f.get("grant_type");
    if (grant === "authorization_code") {
      stats.codeExchanges += 1;
      const code = codes.get(f.get("code") ?? "");
      if (!code || code.used || code.exp < Date.now()) return err("invalid_grant");
      code.used = true;
      if (f.get("client_id") !== code.clientId) return err("invalid_client", 401);
      if (f.get("redirect_uri") !== code.redirectUri) return err("invalid_grant");
      // The real server binds the code to the authorize request's resource (SIWC sign-in step 3).
      if (f.get("resource") !== code.resource) return err("invalid_grant");
      const verifier = f.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || challenge !== code.challenge) return err("invalid_grant");
      return send(
        res,
        200,
        issue(issuer, { clientId: code.clientId, scope: grantedScope(code.scope), nonce: code.nonce }),
      );
    }
    if (grant === "refresh_token") {
      stats.refresh += 1;
      const rt = refreshTokens.get(f.get("refresh_token") ?? "");
      if (!rt || rt.state === "revoked") return err("invalid_grant");
      if (rt.state === "rotated") return err("refresh_token_reused");
      if (f.get("client_id") !== rt.clientId) return err("invalid_client", 401);
      if (f.get("resource") !== "https://api.openai.com/v1") return err("invalid_grant");
      rt.state = "rotated";
      const out = issue(issuer, { clientId: rt.clientId, scope: rt.scope, nonce: null });
      return send(res, 200, out);
    }
    return err("unsupported_grant_type");
  }

  async function revoke(req, res) {
    const f = new URLSearchParams(await readText(req));
    stats.revoke += 1;
    const t = f.get("token") ?? "";
    const rt = refreshTokens.get(t);
    if (rt && rt.state !== "revoked") {
      rt.state = "revoked";
      stats.revokedRefreshTokens += 1;
    }
    const at = accessTokens.get(t);
    if (at && !at.revoked) {
      at.revoked = true;
      stats.revokedAccessTokens += 1;
    }
    res.writeHead(200).end();
  }

  /** Handles everything under /siwc; returns false for any other path. */
  function handler(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const issuer = `http://${req.headers.host}${PREFIX}`;
    const path = url.pathname.slice(PREFIX.length);
    const run = async () => {
      if (req.method === "GET" && path === "/.well-known/openid-configuration") {
        return send(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/api/accounts/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          revocation_endpoint: `${issuer}/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      if (req.method === "GET" && path === "/.well-known/jwks.json") return send(res, 200, { keys: [jwk] });
      if (req.method === "GET" && path === "/api/accounts/authorize") return authorize(res, url);
      if (req.method === "POST" && path === "/oauth/token") return token(req, res, issuer);
      if (req.method === "POST" && path === "/oauth/revoke") return revoke(req, res);
      if (req.method === "POST" && path === "/__scenario") {
        const text = await readText(req);
        scenario = text ? JSON.parse(text) : {};
        return send(res, 200, { scenario });
      }
      if (req.method === "GET" && path === "/__stats") return send(res, 200, stats);
      return send(res, 404, { error: "not_found" });
    };
    run().catch((error) => {
      if (res.headersSent) return void res.end();
      send(res, 400, { error: "invalid_request", error_description: String(error?.message ?? error) });
    });
    return true;
  }
  return handler;
}
