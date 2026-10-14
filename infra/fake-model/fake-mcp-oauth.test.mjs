// node --test infra/fake-model/
// The fake OAuth-protected MCP server and its authorization server (07.4-04): protected resource metadata, AS
// metadata, authorize (PKCE S256, `resource`, exact redirect, `iss`), token, the bearer-protected MCP endpoint and
// its per-grant subject. The client below is plain fetch + node:crypto, written from the MCP authorization spec,
// so a pass here means the fake asks for what the spec asks of a client. Never a real provider.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakeMcpOAuth } from "./fake-mcp-oauth.mjs";
import { createFakeModelServer } from "./server.mjs";

const E2E_CLIENT = "ocw-e2e";
const E2E_REDIRECT = "http://127.0.0.1:4290/api/v1/connectors/oauth/callback";

let server;
let base;

before(async () => {
  server = createFakeModelServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(async () => {
  await scenario(base, {});
});

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const challengeOf = (verifier) => b64url(createHash("sha256").update(verifier).digest());

async function scenario(origin, s) {
  const res = await fetch(`${origin}/mcp-oauth/__scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });
  assert.equal(res.status, 200);
}

const statsOf = async (origin) => (await fetch(`${origin}/mcp-oauth/__stats`)).json();

/** Reads the PRM URL out of a `WWW-Authenticate: Bearer resource_metadata="…"` challenge. */
function challengeParam(header, name) {
  const m = new RegExp(`${name}="([^"]*)"`, "u").exec(header ?? "");
  return m ? m[1] : null;
}

/** Discovery the way the spec describes it: 401 challenge → PRM → AS metadata (RFC 8414 path insertion). */
async function discover(origin) {
  const challenge = await fetch(`${origin}/mcp-oauth/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(challenge.status, 401);
  const www = challenge.headers.get("www-authenticate");
  const prmUrl = challengeParam(www, "resource_metadata");
  const prm = await (await fetch(prmUrl)).json();
  const issuer = new URL(prm.authorization_servers[0]);
  const asUrl = `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`;
  const asRes = await fetch(asUrl);
  assert.equal(asRes.status, 200);
  return { www, prmUrl, prm, as: await asRes.json() };
}

/** GET authorize without following the redirect; returns the response and the PKCE verifier. */
async function authorizeRaw(origin, overrides = {}, { as } = {}) {
  const meta = as ?? (await discover(origin)).as;
  const verifier = b64url(randomBytes(32));
  const params = {
    response_type: "code",
    client_id: E2E_CLIENT,
    redirect_uri: E2E_REDIRECT,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
    resource: `${origin}/mcp-oauth/mcp`,
    scope: "records:read",
    state: `st-${b64url(randomBytes(6))}`,
    ...overrides,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const res = await fetch(`${meta.authorization_endpoint}?${q}`, { redirect: "manual" });
  return { res, verifier, params, meta };
}

/** Authorize and return the redirect's query parameters. */
async function authorize(origin, overrides = {}, opts = {}) {
  const out = await authorizeRaw(origin, overrides, opts);
  assert.equal(out.res.status, 302, await out.res.clone().text());
  const location = new URL(out.res.headers.get("location"));
  return { ...out, location, query: location.searchParams };
}

async function tokenRequest(meta, form, headers = {}) {
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form),
  });
  return { status: res.status, body: await res.json() };
}

/** A full grant: authorize → code exchange. Returns the token response and the metadata used. */
async function grant(origin, overrides = {}) {
  const { query, verifier, params, meta } = await authorize(origin, overrides);
  const out = await tokenRequest(meta, {
    grant_type: "authorization_code",
    code: query.get("code"),
    redirect_uri: params.redirect_uri,
    client_id: params.client_id,
    code_verifier: verifier,
    resource: params.resource,
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return { tokens: out.body, meta, params };
}

/** One MCP JSON-RPC request against the protected endpoint. */
async function mcp(origin, bearer, body, sessionId) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${origin}/mcp-oauth/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

/** initialize + tools/call `name` with a bearer; returns the tool result. */
async function callTool(origin, bearer, name, args = {}) {
  const init = await mcp(origin, bearer, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  assert.equal(init.res.status, 200, JSON.stringify(init.body));
  const session = init.res.headers.get("mcp-session-id");
  const call = await mcp(
    origin,
    bearer,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    session,
  );
  return { ...call, session };
}

describe("fake MCP OAuth: discovery → authorize → token → whoami (tracer)", () => {
  it("an unauthenticated MCP request is challenged with the protected resource metadata URL", async () => {
    const { www, prmUrl, prm, as } = await discover(base);
    assert.match(www, /^Bearer /u);
    assert.equal(prmUrl, `${base}/.well-known/oauth-protected-resource/mcp-oauth/mcp`);
    assert.equal(challengeParam(www, "scope"), "records:read");
    assert.equal(prm.resource, `${base}/mcp-oauth/mcp`);
    assert.deepEqual(prm.authorization_servers, [`${base}/mcp-oauth`]);
    assert.deepEqual(prm.bearer_methods_supported, ["header"]);
    assert.equal(as.issuer, `${base}/mcp-oauth`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.ok(as.scopes_supported.includes("offline_access"));
    for (const k of [
      "authorization_endpoint",
      "token_endpoint",
      "revocation_endpoint",
      "registration_endpoint",
    ])
      assert.ok(as[k].startsWith(`${base}/mcp-oauth/`), k);
  });

  it("authorize redirects with the code, the same state and iss; the code buys a bearer that whoami accepts", async () => {
    const { query, params } = await authorize(base);
    assert.ok(query.get("code"));
    assert.equal(query.get("state"), params.state);
    assert.equal(query.get("iss"), `${base}/mcp-oauth`);

    const { tokens } = await grant(base);
    assert.equal(tokens.token_type, "Bearer");
    assert.match(tokens.access_token, /^fakeat_/u);
    assert.match(tokens.refresh_token, /^fakert_/u);
    assert.equal(typeof tokens.expires_in, "number");

    const { res, body } = await callTool(base, tokens.access_token, "whoami");
    assert.equal(res.status, 200);
    const who = body.result.structuredContent;
    assert.match(who.subject, /^sub_/u);
    assert.deepEqual(who.scopes, ["records:read"]);
    assert.deepEqual(JSON.parse(body.result.content[0].text), who);
  });

  it("each grant has its own subject, so whoami proves whose token a call used", async () => {
    const a = await grant(base);
    const b = await grant(base);
    const whoA = (await callTool(base, a.tokens.access_token, "whoami")).body.result.structuredContent;
    const whoB = (await callTool(base, b.tokens.access_token, "whoami")).body.result.structuredContent;
    assert.notEqual(whoA.subject, whoB.subject);
  });

  it("tools/list offers whoami and echo_auth (read-only) and create_record (destructive)", async () => {
    const { tokens } = await grant(base, { scope: "records:read records:write" });
    const init = await mcp(base, tokens.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const list = await mcp(
      base,
      tokens.access_token,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      init.res.headers.get("mcp-session-id"),
    );
    const byName = Object.fromEntries(list.body.result.tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ["create_record", "echo_auth", "whoami"]);
    assert.equal(byName.whoami.annotations.readOnlyHint, true);
    assert.equal(byName.echo_auth.annotations.readOnlyHint, true);
    assert.equal(byName.create_record.annotations.destructiveHint, true);

    const created = await callTool(base, tokens.access_token, "create_record", { title: "Q3 plan" });
    assert.match(created.body.result.structuredContent.id, /^rec_/u);
    const echoed = await callTool(base, tokens.access_token, "echo_auth");
    assert.equal(echoed.body.result.content[0].text, `Bearer ${tokens.access_token}`);
  });

  it("__stats records the resource sent on authorize and token, as hashes and counts only", async () => {
    const { tokens } = await grant(base);
    const s = await statsOf(base);
    assert.equal(s.lastResource.authorize, `${base}/mcp-oauth/mcp`);
    assert.equal(s.lastResource.token, `${base}/mcp-oauth/mcp`);
    assert.ok(s.tokenRequests.authorization_code >= 1);
    assert.ok(s.accessTokenHashes.includes(createHash("sha256").update(tokens.access_token).digest("hex")));
    assert.ok(!JSON.stringify(s).includes(tokens.access_token));
  });

  it("a bearer that is not one it issued is refused with a 401 challenge", async () => {
    const { res } = await mcp(base, "fakeat_forged", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal(res.status, 401);
    const www = res.headers.get("www-authenticate");
    assert.match(www, /error="invalid_token"/u);
    assert.equal(
      challengeParam(www, "resource_metadata"),
      `${base}/.well-known/oauth-protected-resource/mcp-oauth/mcp`,
    );
  });
});

describe("fake MCP OAuth: refusals on the happy path's inputs", () => {
  it("authorize without a code_challenge redirects with error=invalid_request and no code", async () => {
    const { query, params } = await authorize(base, {
      code_challenge: undefined,
      code_challenge_method: undefined,
    });
    assert.equal(query.get("error"), "invalid_request");
    assert.equal(query.get("code"), null);
    assert.equal(query.get("state"), params.state);
  });

  it("authorize with the plain method is refused (S256 only)", async () => {
    const { query } = await authorize(base, { code_challenge_method: "plain" });
    assert.equal(query.get("error"), "invalid_request");
  });

  it("authorize without resource, or with another resource, redirects with error=invalid_target", async () => {
    assert.equal((await authorize(base, { resource: undefined })).query.get("error"), "invalid_target");
    assert.equal(
      (await authorize(base, { resource: "https://elsewhere.example/mcp" })).query.get("error"),
      "invalid_target",
    );
  });

  it("an unregistered redirect_uri is a 400 that never redirects", async () => {
    const { res } = await authorizeRaw(base, { redirect_uri: "http://127.0.0.1:4290/api/v1/elsewhere" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
    const prefixed = await authorizeRaw(base, { redirect_uri: `${E2E_REDIRECT}/extra` });
    assert.equal(prefixed.res.status, 400);
  });

  it("an unknown client_id is a 400 invalid_client that never redirects", async () => {
    const { res } = await authorizeRaw(base, { client_id: "nobody" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_client");
    assert.equal(res.headers.get("location"), null);
  });

  it("a wrong code_verifier is invalid_grant", async () => {
    const { query, params, meta } = await authorize(base);
    const out = await tokenRequest(meta, {
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: params.redirect_uri,
      client_id: params.client_id,
      code_verifier: b64url(randomBytes(32)),
      resource: params.resource,
    });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "invalid_grant");
  });

  it("a code works once; reusing it is invalid_grant and revokes what it bought", async () => {
    const { query, verifier, params, meta } = await authorize(base);
    const form = {
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: params.redirect_uri,
      client_id: params.client_id,
      code_verifier: verifier,
      resource: params.resource,
    };
    const first = await tokenRequest(meta, form);
    assert.equal(first.status, 200);
    const again = await tokenRequest(meta, form);
    assert.equal(again.status, 400);
    assert.equal(again.body.error, "invalid_grant");
    const { res } = await mcp(base, first.body.access_token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(res.status, 401);
  });

  it("a different resource on the token request is invalid_target", async () => {
    const { query, verifier, params, meta } = await authorize(base);
    const out = await tokenRequest(meta, {
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: params.redirect_uri,
      client_id: params.client_id,
      code_verifier: verifier,
      resource: "https://elsewhere.example/mcp",
    });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "invalid_target");
  });

  it("a token request without resource is invalid_target", async () => {
    const { query, verifier, params, meta } = await authorize(base);
    const out = await tokenRequest(meta, {
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: params.redirect_uri,
      client_id: params.client_id,
      code_verifier: verifier,
    });
    assert.equal(out.body.error, "invalid_target");
  });
});

// ── Task 2: refresh, revocation, registration, CIMD, id_token, scenarios, stats, keychain ────────────────

const refreshWith = (meta, refreshToken, extra = {}) =>
  tokenRequest(meta, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: E2E_CLIENT,
    resource: `${new URL(meta.issuer).origin}/mcp-oauth/mcp`,
    ...extra,
  });

const whoami = async (origin, bearer) =>
  (await callTool(origin, bearer, "whoami")).body.result.structuredContent;

async function initStatus(origin, bearer) {
  const { res } = await mcp(origin, bearer, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  return res.status;
}

function decodeJwt(token) {
  const [h, p, s] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
    signature: s,
  };
}

describe("fake MCP OAuth: refresh rotation and reuse detection", () => {
  it("a refresh with resource rotates both tokens and keeps the grant's subject", async () => {
    const { tokens, meta } = await grant(base);
    const before = await statsOf(base);
    const out = await refreshWith(meta, tokens.refresh_token);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.notEqual(out.body.access_token, tokens.access_token);
    assert.notEqual(out.body.refresh_token, tokens.refresh_token);
    assert.equal(
      (await whoami(base, out.body.access_token)).subject,
      (await whoami(base, tokens.access_token)).subject,
    );
    const after = await statsOf(base);
    assert.equal(after.tokenRequests.refresh_token, before.tokenRequests.refresh_token + 1);
    assert.equal(after.lastResource.refresh, `${base}/mcp-oauth/mcp`);
  });

  it("presenting a rotated refresh token is invalid_grant and revokes the whole family", async () => {
    const { tokens, meta } = await grant(base);
    const rotated = (await refreshWith(meta, tokens.refresh_token)).body;
    const reuseBefore = (await statsOf(base)).refreshReuse;

    const reuse = await refreshWith(meta, tokens.refresh_token);
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, "invalid_grant");
    assert.equal((await statsOf(base)).refreshReuse, reuseBefore + 1);

    const latest = await refreshWith(meta, rotated.refresh_token);
    assert.equal(latest.body.error, "invalid_grant");
    assert.equal(await initStatus(base, rotated.access_token), 401);
  });

  it("a refresh without resource is invalid_target and does not spend the token", async () => {
    const { tokens, meta } = await grant(base);
    const before = (await statsOf(base)).tokenRequests.refresh_token;
    const out = await refreshWith(meta, tokens.refresh_token, { resource: "" });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "invalid_target");
    assert.equal((await statsOf(base)).tokenRequests.refresh_token, before + 1);
    assert.equal((await refreshWith(meta, tokens.refresh_token)).status, 200);
  });

  it("a refresh token presented by another client is invalid_grant", async () => {
    const { tokens, meta } = await grant(base);
    const reg = await register(base, { redirect_uris: [E2E_REDIRECT], token_endpoint_auth_method: "none" });
    const out = await refreshWith(meta, tokens.refresh_token, { client_id: reg.body.client_id });
    assert.equal(out.body.error, "invalid_grant");
  });
});

describe("fake MCP OAuth: revocation (RFC 7009)", () => {
  const revoke = (meta, token) =>
    fetch(meta.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: E2E_CLIENT }),
    });

  it("revoking a refresh token kills the grant: refresh is invalid_grant, its access token is 401", async () => {
    const { tokens, meta } = await grant(base);
    const before = (await statsOf(base)).revocations;
    assert.equal((await revoke(meta, tokens.refresh_token)).status, 200);
    assert.equal((await statsOf(base)).revocations, before + 1);
    assert.equal((await refreshWith(meta, tokens.refresh_token)).body.error, "invalid_grant");
    assert.equal(await initStatus(base, tokens.access_token), 401);
  });

  it("revoking an access token revokes its family too", async () => {
    const { tokens, meta } = await grant(base);
    assert.equal((await revoke(meta, tokens.access_token)).status, 200);
    assert.equal(await initStatus(base, tokens.access_token), 401);
    assert.equal((await refreshWith(meta, tokens.refresh_token)).body.error, "invalid_grant");
  });

  it("an unknown token still answers 200", async () => {
    const { meta } = await grant(base);
    assert.equal((await revoke(meta, "fakert_unknown")).status, 200);
  });
});

async function register(origin, body) {
  const res = await fetch(`${origin}/mcp-oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("fake MCP OAuth: dynamic client registration (RFC 7591)", () => {
  const REDIRECT = "https://ocw.example/api/v1/connectors/oauth/callback";

  it("a public web client registers and completes a grant with its client_id", async () => {
    const before = (await statsOf(base)).registrations;
    const reg = await register(base, {
      redirect_uris: [REDIRECT],
      application_type: "web",
      token_endpoint_auth_method: "none",
      client_name: "OCW",
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.match(reg.body.client_id, /^dcr_/u);
    assert.equal(reg.body.client_secret, undefined);
    assert.deepEqual(reg.body.redirect_uris, [REDIRECT]);
    assert.equal(reg.body.application_type, "web");
    assert.equal((await statsOf(base)).registrations, before + 1);

    const { query, verifier, params, meta } = await authorize(base, {
      client_id: reg.body.client_id,
      redirect_uri: REDIRECT,
    });
    const out = await tokenRequest(meta, {
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: REDIRECT,
      client_id: reg.body.client_id,
      code_verifier: verifier,
      resource: params.resource,
    });
    assert.equal(out.status, 200);
  });

  it("a confidential client gets a secret and must authenticate at the token endpoint", async () => {
    const reg = await register(base, { redirect_uris: [REDIRECT], application_type: "web" });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.token_endpoint_auth_method, "client_secret_basic");
    assert.match(reg.body.client_secret, /^dcrs_/u);
    const exchange = async (headers, extra = {}) => {
      const { query, verifier, params, meta } = await authorize(base, {
        client_id: reg.body.client_id,
        redirect_uri: REDIRECT,
      });
      return tokenRequest(
        meta,
        {
          grant_type: "authorization_code",
          code: query.get("code"),
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: params.resource,
          ...extra,
        },
        headers,
      );
    };
    const unauthenticated = await exchange({}, { client_id: reg.body.client_id });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error, "invalid_client");
    const basic = Buffer.from(`${reg.body.client_id}:${reg.body.client_secret}`).toString("base64");
    assert.equal((await exchange({ authorization: `Basic ${basic}` })).status, 200);
    const post = await exchange({}, { client_id: reg.body.client_id, client_secret: reg.body.client_secret });
    assert.equal(post.status, 200);
  });

  it("refuses a registration without redirect URIs or with a plain-http non-loopback one", async () => {
    assert.equal((await register(base, { application_type: "web" })).body.error, "invalid_redirect_uri");
    assert.equal(
      (await register(base, { redirect_uris: ["http://ocw.example/cb"] })).body.error,
      "invalid_redirect_uri",
    );
    assert.equal((await register(base, { redirect_uris: ["http://localhost:4290/cb"] })).status, 201);
  });
});

describe("fake MCP OAuth: id_token label", () => {
  it("the code exchange carries an unsigned id_token whose email names the grant's subject", async () => {
    const { tokens } = await grant(base);
    const { header, payload, signature } = decodeJwt(tokens.id_token);
    assert.equal(header.alg, "none");
    assert.equal(signature, "");
    const { subject } = await whoami(base, tokens.access_token);
    assert.equal(payload.sub, subject);
    assert.equal(payload.email, `${subject}@fake-mcp.test`);
    assert.equal(payload.iss, `${base}/mcp-oauth`);
    assert.equal(payload.aud, E2E_CLIENT);
  });

  it("no_id_token leaves it out", async () => {
    await scenario(base, { no_id_token: true });
    const { tokens } = await grant(base);
    assert.equal(tokens.id_token, undefined);
  });
});

describe("fake MCP OAuth: scenarios", () => {
  it("deny redirects with error=access_denied and no code", async () => {
    await scenario(base, { deny: true });
    const { query, params } = await authorize(base);
    assert.equal(query.get("error"), "access_denied");
    assert.equal(query.get("code"), null);
    assert.equal(query.get("state"), params.state);
    assert.equal(query.get("iss"), `${base}/mcp-oauth`);
  });

  it("no_pkce_meta drops code_challenge_methods_supported from the AS metadata", async () => {
    await scenario(base, { no_pkce_meta: true });
    const { as } = await discover(base);
    assert.equal("code_challenge_methods_supported" in as, false);
  });

  it("no_registration drops registration_endpoint and CIMD support from the AS metadata", async () => {
    await scenario(base, { no_registration: true });
    const { as } = await discover(base);
    assert.equal("registration_endpoint" in as, false);
    assert.equal("client_id_metadata_document_supported" in as, false);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });

  it("no_iss leaves iss off the redirect; wrong_iss names another issuer", async () => {
    await scenario(base, { no_iss: true });
    const a = await authorize(base);
    assert.ok(a.query.get("code"));
    assert.equal(a.query.has("iss"), false);
    await scenario(base, { wrong_iss: true });
    const b = await authorize(base);
    assert.ok(b.query.get("iss"));
    assert.notEqual(b.query.get("iss"), `${base}/mcp-oauth`);
  });

  it("insufficient_scope answers MCP requests 403 with an insufficient_scope challenge", async () => {
    const { tokens } = await grant(base);
    await scenario(base, { insufficient_scope: true });
    const { res } = await mcp(base, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize" });
    assert.equal(res.status, 403);
    const www = res.headers.get("www-authenticate");
    assert.match(www, /error="insufficient_scope"/u);
    assert.match(www, /scope="records:read records:write"/u);
    assert.equal(
      challengeParam(www, "resource_metadata"),
      `${base}/.well-known/oauth-protected-resource/mcp-oauth/mcp`,
    );
  });

  it("without the scenario, a read-only grant calling create_record is a 403 insufficient_scope", async () => {
    const { tokens } = await grant(base);
    const { res } = await callTool(base, tokens.access_token, "create_record", { title: "x" });
    assert.equal(res.status, 403);
    assert.match(res.headers.get("www-authenticate"), /error="insufficient_scope"/u);
  });

  it("expires_in 1 issues a token the MCP refuses a second later", async () => {
    await scenario(base, { expires_in: 1 });
    const { tokens } = await grant(base);
    assert.equal(tokens.expires_in, 1);
    assert.equal(await initStatus(base, tokens.access_token), 200);
    await new Promise((r) => setTimeout(r, 1_100));
    assert.equal(await initStatus(base, tokens.access_token), 401);
  });

  it("revoke_all rejects every token, existing and new", async () => {
    const { tokens, meta } = await grant(base);
    await scenario(base, { revoke_all: true });
    assert.equal(await initStatus(base, tokens.access_token), 401);
    assert.equal((await refreshWith(meta, tokens.refresh_token)).body.error, "invalid_grant");
    const fresh = await grant(base);
    assert.equal(await initStatus(base, fresh.tokens.access_token), 401);
  });

  it("slow_mcp_ms delays tools/call", async () => {
    const { tokens } = await grant(base);
    await scenario(base, { slow_mcp_ms: 300 });
    const started = Date.now();
    const { res } = await callTool(base, tokens.access_token, "whoami");
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started >= 290);
  });

  it("different_issuer makes the PRM name another authorization server that works on its own", async () => {
    await scenario(base, { different_issuer: true });
    const { prm, as } = await discover(base);
    assert.deepEqual(prm.authorization_servers, [`${base}/mcp-oauth/alt`]);
    assert.equal(as.issuer, `${base}/mcp-oauth/alt`);
    assert.equal(as.token_endpoint, `${base}/mcp-oauth/alt/token`);
    const { query, verifier, params } = await authorize(base, {}, { as });
    assert.equal(query.get("iss"), `${base}/mcp-oauth/alt`);
    const form = {
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: params.redirect_uri,
      client_id: params.client_id,
      code_verifier: verifier,
      resource: params.resource,
    };
    // A code from one issuer is not redeemable at the other.
    const main = await tokenRequest({ token_endpoint: `${base}/mcp-oauth/token` }, form);
    assert.equal(main.body.error, "invalid_grant");
  });

  it("different_issuer: a grant from the other server is accepted by the MCP", async () => {
    await scenario(base, { different_issuer: true });
    const { as } = await discover(base);
    assert.equal(as.issuer, `${base}/mcp-oauth/alt`);
    const { query, verifier, params, meta } = await authorize(base, {}, { as });
    const out = await tokenRequest(meta, {
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: params.redirect_uri,
      client_id: params.client_id,
      code_verifier: verifier,
      resource: params.resource,
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.match((await whoami(base, out.body.access_token)).subject, /^sub_/u);
  });

  it("fail_token_5xx makes the token endpoint answer 503 and still counts the attempt", async () => {
    const { tokens, meta } = await grant(base);
    await scenario(base, { fail_token_5xx: true });
    const before = (await statsOf(base)).tokenRequests.refresh_token;
    const out = await refreshWith(meta, tokens.refresh_token);
    assert.equal(out.status, 503);
    assert.equal(out.body.error, "temporarily_unavailable");
    assert.equal((await statsOf(base)).tokenRequests.refresh_token, before + 1);
    await scenario(base, {});
    assert.equal((await refreshWith(meta, tokens.refresh_token)).status, 200);
  });
});

// ── Direct construction: CIMD (injected fetch), confidential pre-registered clients, the in-process API ──

async function mountDirect(opts) {
  const fake = createFakeMcpOAuth(opts);
  const srv = createServer((req, res) => {
    if (!fake.handle(req, res, new URL(req.url ?? "/", "http://localhost"))) res.writeHead(404).end();
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return { fake, srv, origin: `http://127.0.0.1:${srv.address().port}` };
}

describe("fake MCP OAuth: client ID metadata documents", () => {
  const CIMD = "https://ocw.example/api/v1/connectors/oauth/client-metadata.json";
  const REDIRECT = "https://ocw.example/api/v1/connectors/oauth/callback";
  let direct;
  let docs;
  const fetched = [];

  before(async () => {
    direct = await mountDirect({
      cimdFetch: async (url) => {
        fetched.push(url);
        if (!(url in docs)) throw new Error("unreachable");
        return docs[url];
      },
    });
  });
  after(() => new Promise((resolve) => direct.srv.close(resolve)));
  beforeEach(() => {
    docs = {
      [CIMD]: {
        client_id: CIMD,
        client_name: "OCW",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
      },
    };
    fetched.length = 0;
    direct.fake.reset();
  });

  it("an https client_id is accepted when its document names itself and the redirect, and the grant completes", async () => {
    const { query, verifier, params, meta } = await authorize(direct.origin, {
      client_id: CIMD,
      redirect_uri: REDIRECT,
    });
    assert.deepEqual(fetched, [CIMD]);
    const out = await tokenRequest(meta, {
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: REDIRECT,
      client_id: CIMD,
      code_verifier: verifier,
      resource: params.resource,
    });
    assert.equal(out.status, 200, JSON.stringify(out.body));
  });

  for (const [why, mutate, redirect] of [
    [
      "the document names another client_id",
      (d) => ({ ...d, client_id: "https://evil.example/doc.json" }),
      REDIRECT,
    ],
    ["the redirect is not in the document", (d) => d, "https://ocw.example/other"],
    ["the document is not reachable", () => undefined, REDIRECT],
  ]) {
    it(`is invalid_client, without redirecting, when ${why}`, async () => {
      const doc = mutate(docs[CIMD]);
      if (doc === undefined) delete docs[CIMD];
      else docs[CIMD] = doc;
      const { res } = await authorizeRaw(direct.origin, { client_id: CIMD, redirect_uri: redirect });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "invalid_client");
      assert.equal(res.headers.get("location"), null);
    });
  }

  it("a plain-http client_id is never fetched", async () => {
    const { res } = await authorizeRaw(direct.origin, {
      client_id: "http://ocw.example/doc.json",
      redirect_uri: REDIRECT,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(fetched, []);
  });
});

describe("fake MCP OAuth: in-process API and the no-token rule of __stats", () => {
  let direct;
  before(async () => {
    direct = await mountDirect({
      preRegistered: [{ client_id: "conf", client_secret: "conf-secret", redirect_uris: [E2E_REDIRECT] }],
      kcToken: "kc-direct-token",
    });
  });
  after(() => new Promise((resolve) => direct.srv.close(resolve)));

  it("stats never contain a token, code or secret it issued", async () => {
    const basic = `Basic ${Buffer.from("conf:conf-secret").toString("base64")}`;
    const { query, verifier, params, meta } = await authorize(direct.origin, { client_id: "conf" });
    const first = await tokenRequest(
      meta,
      {
        grant_type: "authorization_code",
        code: query.get("code"),
        redirect_uri: params.redirect_uri,
        code_verifier: verifier,
        resource: params.resource,
      },
      { authorization: basic },
    );
    assert.equal(first.status, 200);
    const second = await tokenRequest(
      meta,
      { grant_type: "refresh_token", refresh_token: first.body.refresh_token, resource: params.resource },
      { authorization: basic },
    );
    assert.equal(second.status, 200);
    await callTool(direct.origin, second.body.access_token, "whoami");
    const kc = await fetch(`${direct.origin}/kc/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "kc-client",
        client_secret: "kc-secret",
      }),
    });
    assert.equal(kc.status, 200);

    const issued = direct.fake.issuedTokens();
    assert.ok(issued.access.length >= 3 && issued.refresh.length >= 2 && issued.codes.length >= 1);
    const json = JSON.stringify(await statsOf(direct.origin));
    for (const t of [...issued.access, ...issued.refresh, ...issued.codes, "conf-secret", "kc-direct-token"])
      assert.ok(!json.includes(t), "stats leaked a token");
    // Every MCP access token is hashed; /kc/token bearers are listed in-process for sweeps but never hashed.
    const mcpAccess = issued.access.filter((t) => t.startsWith("fakeat_"));
    assert.ok(issued.access.some((t) => t.startsWith("fakekc_")));
    assert.equal(JSON.parse(json).accessTokenHashes.length, mcpAccess.length);
  });

  it("setScenario and reset work in-process", async () => {
    direct.fake.setScenario({ deny: true });
    assert.equal((await authorize(direct.origin, { client_id: "conf" })).query.get("error"), "access_denied");
    direct.fake.reset();
    assert.ok((await authorize(direct.origin, { client_id: "conf" })).query.get("code"));
    const issued = direct.fake.issuedTokens();
    assert.deepEqual([issued.access.length, issued.refresh.length, issued.codes.length], [0, 0, 1]);
    assert.equal((await statsOf(direct.origin)).tokenRequests.authorization_code, 0);
  });
});

describe("fake MCP OAuth: keychain targets under /kc", () => {
  const KC_DEFAULT = "fake-kc-token";
  const kcWhoami = (headers = {}, method = "GET") => fetch(`${base}/kc/whoami`, { method, headers });

  it("whoami accepts the bearer on GET, HEAD and POST and refuses anything else", async () => {
    const ok = await kcWhoami({ authorization: `Bearer ${KC_DEFAULT}` });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { authorized: true, method: "bearer" });
    const head = await kcWhoami({ authorization: `Bearer ${KC_DEFAULT}` }, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await kcWhoami({ authorization: `Bearer ${KC_DEFAULT}` }, "POST")).status, 200);
    assert.equal((await kcWhoami()).status, 401);
    assert.equal((await kcWhoami({ authorization: "Bearer nope" })).status, 401);
    assert.equal((await kcWhoami({ authorization: `Bearer ${KC_DEFAULT}` }, "PUT")).status, 405);
  });

  it("whoami accepts Basic kcuser:kcpass and refuses a wrong password", async () => {
    const good = `Basic ${Buffer.from("kcuser:kcpass").toString("base64")}`;
    const bad = `Basic ${Buffer.from("kcuser:nope").toString("base64")}`;
    assert.deepEqual(await (await kcWhoami({ authorization: good })).json(), {
      authorized: true,
      method: "basic",
    });
    assert.equal((await kcWhoami({ authorization: bad })).status, 401);
  });

  it("token issues a 60 s client-credentials bearer that whoami accepts", async () => {
    const res = await fetch(`${base}/kc/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from("kc-client:kc-secret").toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.expires_in, 60);
    assert.equal(body.token_type, "Bearer");
    const who = await kcWhoami({ authorization: `Bearer ${body.access_token}` });
    assert.deepEqual(await who.json(), { authorized: true, method: "client_credentials" });
  });

  it("token refuses a wrong secret and other grant types", async () => {
    const post = (form) =>
      fetch(`${base}/kc/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
    const wrong = await post({
      grant_type: "client_credentials",
      client_id: "kc-client",
      client_secret: "x",
    });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error, "invalid_client");
    const other = await post({ grant_type: "password", client_id: "kc-client", client_secret: "kc-secret" });
    assert.equal(other.status, 400);
    assert.equal((await other.json()).error, "unsupported_grant_type");
  });

  it("echo returns the headers it received", async () => {
    const res = await fetch(`${base}/kc/echo`, {
      method: "PATCH",
      headers: { "x-api-key": "k-123" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.method, "PATCH");
    assert.equal(body.headers["x-api-key"], "k-123");
  });

  it("redirect points at the cloud metadata address", async () => {
    const res = await fetch(`${base}/kc/redirect`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "http://169.254.169.254/latest/meta-data/");
  });

  it("big is a 512 KB body", async () => {
    const res = await fetch(`${base}/kc/big`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 512 * 1024);
  });
});

describe("fake MCP OAuth: /kc credentials are configurable (07.4-12 leak sweep canaries)", () => {
  let direct;
  before(async () => {
    direct = await mountDirect({
      kcBasic: { user: "canary-user", pass: "canary-pass" },
      kcClient: { id: "canary-client", secret: "canary-secret" },
    });
  });
  after(() => new Promise((resolve) => direct.srv.close(resolve)));

  it("accepts the configured Basic pair and client, and no longer the defaults", async () => {
    const whoami = (user, pass) =>
      fetch(`${direct.origin}/kc/whoami`, {
        headers: { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` },
      });
    assert.equal((await whoami("canary-user", "canary-pass")).status, 200);
    assert.equal((await whoami("kcuser", "kcpass")).status, 401);
    const token = (id, secret) =>
      fetch(`${direct.origin}/kc/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
      });
    assert.equal((await token("canary-client", "canary-secret")).status, 200);
    assert.equal((await token("kc-client", "kc-secret")).status, 401);
  });
});
