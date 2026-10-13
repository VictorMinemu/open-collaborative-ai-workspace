// node --test infra/fake-model/
// The fake OAuth-protected MCP server and its authorization server (07.4-04): protected resource metadata, AS
// metadata, authorize (PKCE S256, `resource`, exact redirect, `iss`), token, the bearer-protected MCP endpoint and
// its per-grant subject. The client below is plain fetch + node:crypto, written from the MCP authorization spec,
// so a pass here means the fake asks for what the spec asks of a client. Never a real provider.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
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
