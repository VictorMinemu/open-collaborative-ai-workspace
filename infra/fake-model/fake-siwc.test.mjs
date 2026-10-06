// node --test infra/fake-model/
// The fake "Sign in with ChatGPT – ChatGPT plan usage" server (05-05): OIDC discovery, authorize (302 to the
// loopback redirect), the token endpoint (PKCE, rotation, reuse detection, scenarios), JWKS, revocation and the
// test-only scenario/stats endpoints. Never the real auth.openai.com.
import assert from "node:assert/strict";
import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakeModelServer } from "./server.mjs";

let server;
let base;

before(async () => {
  server = createFakeModelServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/siwc`;
});
after(() => new Promise((resolve) => server.close(resolve)));
beforeEach(async () => {
  await scenario({});
});

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const challengeOf = (verifier) => b64url(createHash("sha256").update(verifier).digest());
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REDIRECT = "http://127.0.0.1:1455/auth/callback";

async function scenario(s) {
  const res = await fetch(`${base}/__scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });
  assert.equal(res.status, 200);
}

const stats = async () => (await fetch(`${base}/__stats`)).json();

function decodeJwt(token) {
  const [h, p, s] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, "base64url"),
  };
}

/** Runs authorize for `clientId` and returns the redirect Location plus the PKCE material. */
async function authorize({ clientId = "dynamic_agent_client", nonce = "n-1", state = "s-1" } = {}) {
  const verifier = b64url(randomBytes(32));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: SCOPES,
    resource: "https://api.openai.com/v1",
    state,
    nonce,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
  });
  if (clientId === "dynamic_agent_client") {
    q.set("agent_name_hint", "Open Collaborative AI Workspace");
    q.set("ext_agent_host_id", "urn:uuid:00000000-0000-4000-8000-000000000001");
  }
  const res = await fetch(`${base}/api/accounts/authorize?${q}`, { redirect: "manual" });
  return { res, location: res.headers.get("location"), verifier };
}

const form = (path, fields) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

/** A full sign-in: returns the token response and the issued client id. */
async function signIn(opts = {}) {
  const { location, verifier } = await authorize(opts);
  const url = new URL(location);
  const clientId = url.searchParams.get("client_id");
  const res = await form("/oauth/token", {
    grant_type: "authorization_code",
    code: url.searchParams.get("code"),
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
  });
  assert.equal(res.status, 200);
  return { tokens: await res.json(), clientId };
}

describe("fake SIWC: discovery and JWKS", () => {
  it("discovery returns the five endpoints under the request's own base", async () => {
    const d = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
    assert.equal(d.issuer, base);
    assert.equal(d.authorization_endpoint, `${base}/api/accounts/authorize`);
    assert.equal(d.token_endpoint, `${base}/oauth/token`);
    assert.equal(d.jwks_uri, `${base}/.well-known/jwks.json`);
    assert.equal(d.revocation_endpoint, `${base}/oauth/revoke`);
  });

  it("serves one RS256 public key", async () => {
    const jwks = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0].kty, "RSA");
    assert.equal(jwks.keys[0].alg, "RS256");
    assert.ok(jwks.keys[0].kid);
    assert.equal(jwks.keys[0].d, undefined, "never the private part");
  });
});

describe("fake SIWC: authorize", () => {
  it("302s to the loopback redirect with code, state and an issued oaiapp_fake_ client id", async () => {
    const { res, location } = await authorize({ state: "st-42" });
    assert.equal(res.status, 302);
    const url = new URL(location);
    assert.equal(`${url.origin}${url.pathname}`, REDIRECT);
    assert.equal(url.searchParams.get("state"), "st-42");
    assert.match(url.searchParams.get("code"), /^fake-code-/);
    assert.match(url.searchParams.get("client_id"), /^oaiapp_fake_/);
  });

  it("refuses a non-loopback or localhost redirect and a missing PKCE challenge", async () => {
    const q = (over) =>
      new URLSearchParams({
        response_type: "code",
        client_id: "dynamic_agent_client",
        agent_name_hint: "x",
        ext_agent_host_id: "urn:uuid:1",
        redirect_uri: REDIRECT,
        scope: SCOPES,
        state: "s",
        nonce: "n",
        code_challenge: "c".repeat(43),
        code_challenge_method: "S256",
        ...over,
      });
    for (const over of [
      { redirect_uri: "http://localhost:1455/auth/callback" },
      { redirect_uri: "https://evil.example/auth/callback" },
      { code_challenge_method: "plain" },
      { ext_agent_host_id: "" },
    ]) {
      const res = await fetch(`${base}/api/accounts/authorize?${q(over)}`, { redirect: "manual" });
      assert.equal(res.status, 400, JSON.stringify(over));
    }
  });

  it("scenario deny redirects with error=access_denied", async () => {
    await scenario({ deny: true });
    const { location } = await authorize({ state: "s-deny" });
    const url = new URL(location);
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.get("state"), "s-deny");
    assert.equal(url.searchParams.get("code"), null);
  });
});

describe("fake SIWC: token endpoint", () => {
  it("refuses a wrong verifier with invalid_grant", async () => {
    const { location } = await authorize();
    const url = new URL(location);
    const res = await form("/oauth/token", {
      grant_type: "authorization_code",
      code: url.searchParams.get("code"),
      redirect_uri: REDIRECT,
      client_id: url.searchParams.get("client_id"),
      code_verifier: b64url(randomBytes(32)),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_grant");
  });

  it("issues plan tokens and a signed id_token whose nonce and audience match; codes are single use", async () => {
    const { location, verifier } = await authorize({ nonce: "nonce-xyz" });
    const url = new URL(location);
    const clientId = url.searchParams.get("client_id");
    const fields = {
      grant_type: "authorization_code",
      code: url.searchParams.get("code"),
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    };
    const res = await form("/oauth/token", fields);
    assert.equal(res.status, 200);
    const t = await res.json();
    assert.match(t.access_token, /^fake-plan-/);
    assert.match(t.refresh_token, /^fake-refresh-/);
    assert.equal(t.token_type, "Bearer");
    assert.equal(t.expires_in, 3600);
    assert.equal(t.scope, SCOPES);
    const jwt = decodeJwt(t.id_token);
    assert.equal(jwt.header.alg, "RS256");
    assert.equal(jwt.payload.iss, base);
    assert.equal(jwt.payload.aud, clientId);
    assert.equal(jwt.payload.nonce, "nonce-xyz");
    assert.ok(jwt.payload.sub);
    assert.ok(jwt.payload.email);
    assert.equal(jwt.payload["https://api.openai.com/auth"].chatgpt_plan_type, "plus");
    const jwks = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    const key = createPublicKey({ key: jwks.keys[0], format: "jwk" });
    const ok = createVerify("RSA-SHA256").update(jwt.signingInput).verify(key, jwt.signature);
    assert.equal(ok, true, "signature verifies with the JWKS key");

    const again = await form("/oauth/token", fields);
    assert.equal(again.status, 400);
    assert.equal((await again.json()).error, "invalid_grant");
  });

  it("honours no_plan_scope, expires_in and token_unavailable", async () => {
    await scenario({ no_plan_scope: true, expires_in: 1 });
    const { tokens } = await signIn();
    assert.equal(tokens.expires_in, 1);
    assert.ok(!tokens.scope.split(" ").includes("chatgpt.tokens.use.direct"));
    assert.ok(tokens.scope.split(" ").includes("openid"));

    await scenario({ token_unavailable: true });
    const { location, verifier } = await authorize();
    const url = new URL(location);
    const res = await form("/oauth/token", {
      grant_type: "authorization_code",
      code: url.searchParams.get("code"),
      redirect_uri: REDIRECT,
      client_id: url.searchParams.get("client_id"),
      code_verifier: verifier,
    });
    assert.equal(res.status, 503);
  });

  it("rotates refresh tokens and answers reuse of a rotated one with refresh_token_reused", async () => {
    const before = await stats();
    const { tokens, clientId } = await signIn();
    const refresh = (token) =>
      form("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: clientId,
        resource: "https://api.openai.com/v1",
      });
    const r1 = await refresh(tokens.refresh_token);
    assert.equal(r1.status, 200);
    const t1 = await r1.json();
    assert.match(t1.access_token, /^fake-plan-/);
    assert.notEqual(t1.access_token, tokens.access_token);
    assert.notEqual(t1.refresh_token, tokens.refresh_token);

    const reused = await refresh(tokens.refresh_token);
    assert.equal(reused.status, 400);
    assert.equal((await reused.json()).error, "refresh_token_reused");

    const unknown = await refresh("fake-refresh-never-issued");
    assert.equal((await unknown.json()).error, "invalid_grant");

    const s = await stats();
    assert.equal(s.refresh - before.refresh, 3);
    const hash = createHash("sha256").update(t1.access_token).digest("hex");
    assert.ok(s.accessTokenHashes.includes(hash), "stats list issued access tokens by hash only");
    assert.ok(!JSON.stringify(s).includes(t1.access_token), "stats never carry a token");
  });

  it("revokes refresh and access tokens and counts them", async () => {
    const before = await stats();
    const { tokens, clientId } = await signIn();
    for (const token of [tokens.refresh_token, tokens.access_token]) {
      const res = await form("/oauth/revoke", { token, client_id: clientId });
      assert.equal(res.status, 200);
    }
    const s = await stats();
    assert.equal(s.revoke - before.revoke, 2);
    assert.equal(s.revokedRefreshTokens - before.revokedRefreshTokens, 1);
    assert.equal(s.revokedAccessTokens - before.revokedAccessTokens, 1);
    const res = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    assert.equal((await res.json()).error, "invalid_grant");
  });

  it("an issued client id signs in again without a new registration", async () => {
    const { clientId } = await signIn();
    const { location } = await authorize({ clientId });
    const url = new URL(location);
    assert.ok(url.searchParams.get("code"));
    assert.equal(url.searchParams.get("client_id"), null);
  });
});
