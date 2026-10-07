import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  type Discovery,
  discovery,
  exchangeCode,
  OAuthError,
  PLAN_SCOPE,
  parseRedirect,
  refreshTokens,
  revokeTokens,
  startSignIn,
  validateIdToken,
} from "./oauth";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

/** Unit tests of the SIWC OAuth client (05-05): no network, local JWKS, stubbed fetch. */

const BASE = "https://auth.example.test";
const D: Discovery = {
  issuer: BASE,
  authorizationEndpoint: `${BASE}/api/accounts/authorize`,
  tokenEndpoint: `${BASE}/oauth/token`,
  jwksUri: `${BASE}/.well-known/jwks.json`,
  revocationEndpoint: `${BASE}/oauth/revoke`,
};
const HOST = "urn:uuid:4b1d6f3e-0000-4000-8000-000000000001";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("startSignIn", () => {
  it("builds the authorize URL with PKCE S256, state, nonce, the six scopes and the resource", () => {
    const s = startSignIn(D, { clientId: "dynamic_agent_client", hostId: HOST, redirectPort: 1455 });
    const url = new URL(s.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(D.authorizationEndpoint);
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(s.redirectUri).toBe("http://127.0.0.1:1455/auth/callback");
    expect(q.get("scope")).toBe(CHATGPT_SCOPES);
    expect(CHATGPT_SCOPES.split(" ")).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      PLAN_SCOPE,
    ]);
    expect(q.get("resource")).toBe(CHATGPT_RESOURCE);
    expect(q.get("state")).toBe(s.state);
    expect(q.get("nonce")).toBe(s.nonce);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(s.verifier).digest("base64url"));
    expect(s.verifier.length).toBeGreaterThanOrEqual(43);
    expect(s.verifier.length).toBeLessThanOrEqual(128);
    expect(s.state).not.toBe(s.nonce);
    expect(q.get("agent_name_hint")).toBe("Open Collaborative AI Workspace");
    expect(q.get("ext_agent_host_id")).toBe(HOST);
  });

  it("sends the registration hints only for dynamic_agent_client and fresh secrets each time", () => {
    const a = startSignIn(D, { clientId: "oaiapp_123", hostId: HOST, redirectPort: 5555 });
    const q = new URL(a.authorizeUrl).searchParams;
    expect(q.get("client_id")).toBe("oaiapp_123");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:5555/auth/callback");
    expect(q.has("agent_name_hint")).toBe(false);
    expect(q.has("ext_agent_host_id")).toBe(false);
    const b = startSignIn(D, { clientId: "oaiapp_123", hostId: HOST, redirectPort: 5555 });
    expect(b.state).not.toBe(a.state);
    expect(b.verifier).not.toBe(a.verifier);
    expect(b.nonce).not.toBe(a.nonce);
  });
});

describe("parseRedirect", () => {
  const exp = { redirectPort: 1455, state: "st-1" };

  it("accepts the full loopback URL and returns the issued client id", () => {
    expect(
      parseRedirect("http://127.0.0.1:1455/auth/callback?code=c-1&state=st-1&client_id=oaiapp_9", exp),
    ).toEqual({ code: "c-1", issuedClientId: "oaiapp_9" });
    expect(parseRedirect("  http://127.0.0.1:1455/auth/callback?state=st-1&code=c-2  ", exp)).toEqual({
      code: "c-2",
      issuedClientId: null,
    });
  });

  it("accepts a bare query", () => {
    expect(parseRedirect("?code=c-3&state=st-1", exp)).toEqual({ code: "c-3", issuedClientId: null });
    expect(parseRedirect("code=c-4&state=st-1", exp)).toEqual({ code: "c-4", issuedClientId: null });
  });

  it("rejects localhost, other hosts, ports, paths and schemes as invalid_redirect", () => {
    for (const raw of [
      "http://localhost:1455/auth/callback?code=c&state=st-1",
      "http://evil.example:1455/auth/callback?code=c&state=st-1",
      "http://127.0.0.2:1455/auth/callback?code=c&state=st-1",
      "http://127.0.0.1:1456/auth/callback?code=c&state=st-1",
      "http://127.0.0.1:1455/other?code=c&state=st-1",
      "https://127.0.0.1:1455/auth/callback?code=c&state=st-1",
      "http://user@127.0.0.1:1455/auth/callback?code=c&state=st-1",
      "http://127.0.0.1:1455/auth/callback?state=st-1",
      "http://127.0.0.1:1455/auth/callback?code=c&state=st-1&client_id=bad%20id",
      "not a url at all",
      "",
    ]) {
      expect(parseRedirect(raw, exp), raw).toEqual({ error: "invalid_redirect" });
    }
  });

  it("rejects another state and maps error=access_denied to signin_cancelled", () => {
    expect(parseRedirect("http://127.0.0.1:1455/auth/callback?code=c&state=other", exp)).toEqual({
      error: "state_mismatch",
    });
    expect(parseRedirect("http://127.0.0.1:1455/auth/callback?code=c", exp)).toEqual({
      error: "state_mismatch",
    });
    expect(parseRedirect("http://127.0.0.1:1455/auth/callback?error=access_denied&state=st-1", exp)).toEqual({
      error: "signin_cancelled",
    });
  });
});

describe("validateIdToken", () => {
  let keys: ReturnType<typeof createLocalJWKSet>;
  let good: PrivateKey;
  let other: PrivateKey;

  beforeAll(async () => {
    const a = await generateKeyPair("RS256");
    const b = await generateKeyPair("RS256");
    good = a.privateKey;
    other = b.privateKey;
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(a.publicKey)), kid: "k1", alg: "RS256" }] });
  });

  const sign = (
    claims: Record<string, unknown>,
    opts: { key?: PrivateKey; aud?: string; iss?: string; exp?: number } = {},
  ) =>
    new SignJWT({ nonce: "n-1", email: "sam@chatgpt.test", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.iss ?? BASE)
      .setAudience(opts.aud ?? "oaiapp_1")
      .setSubject("user-sub-1")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 600)
      .sign(opts.key ?? good);

  it("accepts the right issuer, audience and nonce and extracts subject, email and plan type", async () => {
    const t = await sign({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } });
    await expect(validateIdToken(D, t, { audience: "oaiapp_1", nonce: "n-1" }, keys)).resolves.toEqual({
      subject: "user-sub-1",
      email: "sam@chatgpt.test",
      planType: "pro",
    });
    const plain = await sign({ email: undefined });
    await expect(validateIdToken(D, plain, { audience: "oaiapp_1", nonce: "n-1" }, keys)).resolves.toEqual({
      subject: "user-sub-1",
      email: null,
      planType: null,
    });
  });

  it("rejects a wrong nonce, audience, issuer, an expired token and another key", async () => {
    const cases = [
      await sign({ nonce: "n-2" }),
      await sign({}, { aud: "oaiapp_other" }),
      await sign({}, { iss: "https://evil.example" }),
      await sign({}, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      await sign({}, { key: other }),
      "not.a.jwt",
    ];
    for (const t of cases) {
      const err = await validateIdToken(D, t, { audience: "oaiapp_1", nonce: "n-1" }, keys).catch((e) => e);
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("id_token_invalid");
    }
  });
});

describe("discovery", () => {
  it("reads the five endpoints once per base and caches them", async () => {
    const base = "https://auth.cache.test";
    const fetchFn = vi.fn(async () =>
      json(200, {
        issuer: base,
        authorization_endpoint: `${base}/api/accounts/authorize`,
        token_endpoint: `${base}/oauth/token`,
        jwks_uri: `${base}/.well-known/jwks.json`,
        revocation_endpoint: `${base}/oauth/revoke`,
      }),
    );
    const a = await discovery(`${base}/`, fetchFn);
    const b = await discovery(base, fetchFn);
    expect(a).toEqual(b);
    expect(a.tokenEndpoint).toBe(`${base}/oauth/token`);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe(`${base}/.well-known/openid-configuration`);
  });

  it("refuses plain-http endpoints on another origin and fails transiently when unreachable", async () => {
    const base = "https://auth.ssrf.test";
    const bad = vi.fn(async () =>
      json(200, {
        issuer: base,
        authorization_endpoint: `${base}/a`,
        token_endpoint: "http://169.254.169.254/latest",
        jwks_uri: `${base}/j`,
      }),
    );
    await expect(discovery(base, bad)).rejects.toMatchObject({ code: "discovery_invalid" });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(discovery("https://auth.down.test", down)).rejects.toMatchObject({
      code: "unavailable",
      terminal: false,
    });
  });
});

describe("token endpoint errors", () => {
  const SECRET = "fake-refresh-SECRET-VALUE";

  it("maps OAuth error codes to terminal and transient failures without echoing secrets", async () => {
    const cases: Array<[Response | Error, string, boolean]> = [
      [json(400, { error: "invalid_grant", error_description: `bad ${SECRET}` }), "invalid_grant", true],
      [json(400, { error: "refresh_token_reused" }), "refresh_token_reused", true],
      [json(401, { error: "invalid_client" }), "invalid_client", true],
      [json(400, { error: "unauthorized_client" }), "unauthorized_client", true],
      [json(400, { error: "access_denied" }), "access_denied", true],
      [json(503, { error: "temporarily_unavailable" }), "temporarily_unavailable", false],
      [new Response("<html>bad gateway</html>", { status: 502 }), "unavailable", false],
      [new TypeError("fetch failed"), "unavailable", false],
    ];
    for (const [answer, code, terminal] of cases) {
      const fetchFn = vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer.clone();
      });
      const err = await refreshTokens(D, { refreshToken: SECRET, clientId: "oaiapp_1" }, fetchFn).catch(
        (e) => e,
      );
      expect(err, code).toBeInstanceOf(OAuthError);
      expect(err.code, code).toBe(code);
      expect(err.terminal, code).toBe(terminal);
      expect(String(err.message)).not.toContain(SECRET);
      expect(JSON.stringify(err)).not.toContain(SECRET);
    }
  });

  it("refresh sends the refresh grant with the issued client id and the resource, form-encoded", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, {
        access_token: "a-2",
        refresh_token: "r-2",
        expires_in: 3600,
        token_type: "Bearer",
        scope: CHATGPT_SCOPES,
      }),
    );
    const t = await refreshTokens(D, { refreshToken: "r-1", clientId: "oaiapp_1" }, fetchFn);
    expect(t).toEqual({
      accessToken: "a-2",
      refreshToken: "r-2",
      idToken: null,
      expiresIn: 3600,
      scopes: CHATGPT_SCOPES.split(" "),
      clientId: null,
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(D.tokenEndpoint);
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r-1",
      client_id: "oaiapp_1",
      resource: CHATGPT_RESOURCE,
    });
  });

  it("exchangeCode posts the code, verifier and redirect and rejects a malformed response", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, { access_token: "a-1", refresh_token: "r-1", id_token: "x.y.z", expires_in: 60 }),
    );
    const t = await exchangeCode(
      D,
      {
        code: "c-1",
        verifier: "v-1",
        redirectUri: "http://127.0.0.1:1455/auth/callback",
        clientId: "oaiapp_1",
      },
      fetchFn,
    );
    expect(t.idToken).toBe("x.y.z");
    expect(t.scopes).toBeNull();
    const body = new URLSearchParams(String((fetchFn.mock.calls[0] as [string, RequestInit])[1].body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "c-1",
      code_verifier: "v-1",
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      client_id: "oaiapp_1",
      resource: CHATGPT_RESOURCE,
    });
    const malformed = vi.fn(async () => json(200, { token_type: "Bearer" }));
    await expect(
      exchangeCode(D, { code: "c", verifier: "v", redirectUri: "r", clientId: "c" }, malformed),
    ).rejects.toMatchObject({ code: "invalid_token_response" });
  });

  it("revoke is best effort: it never throws and skips when there is no endpoint", async () => {
    const fail = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(revokeTokens(D, { token: "t", clientId: "c" }, fail)).resolves.toBeUndefined();
    const none = vi.fn(async () => json(200, {}));
    await revokeTokens({ ...D, revocationEndpoint: null }, { token: "t", clientId: "c" }, none);
    expect(none).not.toHaveBeenCalled();
    const ok = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    await revokeTokens(D, { token: "t-1", clientId: "c-1" }, ok);
    const body = new URLSearchParams(String((ok.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.get("token")).toBe("t-1");
    expect(body.get("client_id")).toBe("c-1");
  });
});
