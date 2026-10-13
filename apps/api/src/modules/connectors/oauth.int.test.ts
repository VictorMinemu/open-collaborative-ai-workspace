import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ConnectorOAuthUrls, connectorOAuthUrls } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFakeMcpOAuth,
  type FakeMcpOAuth,
  type FakeMcpOAuthStats,
} from "../../../../../infra/fake-model/fake-mcp-oauth.mjs";
import { createEgress, type Egress } from "../../lib/egress";
import { clientMetadataDocument } from "./client-metadata";
import { callTool } from "./mcp-client";
import {
  buildAuthorization,
  type ClientChoice,
  ConnectorOAuthError,
  checkCallbackIssuer,
  chooseClient,
  chooseScope,
  type DiscoveredAuth,
  discover,
  exchangeCode,
  refreshTokens,
  revokeToken,
  type TokenBundle,
} from "./oauth";

/**
 * The connector OAuth client and MCP client against the in-process fake OAuth-protected MCP server (07.4-04).
 *
 * `fake-mcp` is a test host mapped to 127.0.0.1, so the egress guard admits it; everything else is refused as in
 * production. `globalThis.fetch` is replaced by a recording function that throws for the whole file: an SDK helper or
 * transport called without the guard's bound fetch falls back to the global one, and every test then fails in
 * `afterEach` even when the SDK swallowed the throw (RFC 9728 discovery does).
 */

const REDIRECT = "http://127.0.0.1:4290/api/v1/connectors/oauth/callback";
const PRE_REGISTERED = "ocw-test";

const globalFetch = vi.fn((..._args: unknown[]): Promise<Response> => {
  throw new Error("global fetch called: an outbound call skipped the egress guard");
});

let server: Server;
let port: number;
let base: string;
let serverUrl: string;
let fake: FakeMcpOAuth;
let egress: Egress;
let loopbackUrls: ConnectorOAuthUrls;
/** Client ID metadata documents the fake's authorization server can read (its injected `cimdFetch`). */
const cimdDocs = new Map<string, unknown>();

beforeAll(async () => {
  fake = createFakeMcpOAuth({
    preRegistered: [{ client_id: PRE_REGISTERED, redirect_uris: [REDIRECT] }],
    cimdFetch: async (url) => {
      const doc = cimdDocs.get(url);
      if (!doc) throw new Error("no such client metadata document");
      return doc;
    },
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-mcp");
    if (!fake.handle(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://fake-mcp:${port}`;
  serverUrl = `${base}/mcp-oauth/mcp`;
  egress = createEgress({ platformHosts: [], testHosts: new Map([["fake-mcp", "127.0.0.1"]]) });
  loopbackUrls = connectorOAuthUrls("http://127.0.0.1:4290");
  vi.stubGlobal("fetch", globalFetch);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  fake.reset();
  cimdDocs.clear();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function stats(): Promise<FakeMcpOAuthStats> {
  const res = await egress.fetch(`${base}/mcp-oauth/__stats`);
  return (await res.json()) as FakeMcpOAuthStats;
}

/** Plays the browser: follows the authorization URL once and returns the redirect's query. */
async function followAuthorization(authorizationUrl: string): Promise<URLSearchParams> {
  const res = await egress.fetch(authorizationUrl, {}, { privateAllow: [`fake-mcp:${port}`] });
  expect(res.status).toBe(302);
  await res.body?.cancel();
  return new URL(res.headers.get("location") ?? "").searchParams;
}

const preRegistered = (d: DiscoveredAuth) => [{ issuer: d.issuer, clientId: PRE_REGISTERED }];

/** discover → pre-registered client → authorize → iss check → code exchange. */
async function connect(
  urls: ConnectorOAuthUrls = loopbackUrls,
): Promise<{ d: DiscoveredAuth; client: ClientChoice; bundle: TokenBundle }> {
  const d = await discover(egress, serverUrl);
  const client = await chooseClient(egress, d, {
    preRegistered: preRegistered(d),
    stored: [],
    urls,
    clientName: "OCW test",
  });
  const auth = await buildAuthorization(d, client, urls, undefined);
  const back = await followAuthorization(auth.authorizationUrl);
  expect(back.get("state")).toBe(auth.state);
  checkCallbackIssuer(d.metadata, d.issuer, back.get("iss"));
  const bundle = await exchangeCode(egress, d, client, {
    code: back.get("code") ?? "",
    codeVerifier: auth.codeVerifier,
    redirectUri: urls.redirectUri,
  });
  return { d, client, bundle };
}

const target = () => ({ url: serverUrl, transport: "streamable-http" as const });
const bearer = (bundle: TokenBundle) => ({
  headerName: "Authorization",
  headerValue: `Bearer ${bundle.accessToken}`,
});

describe("connector OAuth against the fake: the tracer", () => {
  it("discovers, authorizes with PKCE and resource, checks iss, exchanges the code and calls whoami", async () => {
    const d = await discover(egress, serverUrl);
    expect(d.issuer).toBe(`${base}/mcp-oauth`);
    expect(d.resource).toBe(`${base}/mcp-oauth/mcp`);
    expect(d.sameOrigin).toBe(`fake-mcp:${port}`);

    const client = await chooseClient(egress, d, {
      preRegistered: preRegistered(d),
      stored: [],
      urls: loopbackUrls,
      clientName: "OCW test",
    });
    expect(client).toMatchObject({ method: "pre_registered", clientId: PRE_REGISTERED, issuer: d.issuer });

    const auth = await buildAuthorization(d, client, loopbackUrls, undefined);
    const authorize = new URL(auth.authorizationUrl);
    expect(authorize.origin).toBe(base);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("resource")).toBe(d.resource);
    expect(authorize.searchParams.get("state")).toBe(auth.state);
    expect(authorize.searchParams.get("redirect_uri")).toBe(REDIRECT);

    const back = await followAuthorization(auth.authorizationUrl);
    expect(back.get("state")).toBe(auth.state);
    expect(back.get("iss")).toBe(d.issuer);
    expect(() => checkCallbackIssuer(d.metadata, d.issuer, back.get("iss"))).not.toThrow();

    const bundle = await exchangeCode(egress, d, client, {
      code: back.get("code") ?? "",
      codeVerifier: auth.codeVerifier,
      redirectUri: REDIRECT,
    });
    expect(bundle).toMatchObject({
      issuer: d.issuer,
      clientId: PRE_REGISTERED,
      resource: d.resource,
      tokenEndpoint: `${base}/mcp-oauth/token`,
      revocationEndpoint: `${base}/mcp-oauth/revoke`,
      authMethod: "none",
    });
    expect(bundle.accessToken).toMatch(/^fakeat_/);
    expect(bundle.refreshToken).toMatch(/^fakert_/);
    expect(bundle.expiresAt).toBeGreaterThan(Date.now());
    expect(bundle.accountLabel).toMatch(/^sub_[\w-]+@fake-mcp\.test$/);

    const out = await callTool(
      egress,
      target(),
      bearer(bundle),
      { name: "whoami", arguments: {} },
      {
        redact: [bundle.accessToken],
      },
    );
    const subject = (bundle.accountLabel ?? "").split("@")[0] ?? "";
    expect(out.isError).toBe(false);
    expect(out.truncated).toBe(false);
    expect(out.content).toContain(subject);

    const s = await stats();
    expect(s.lastResource.authorize).toBe(d.resource);
    expect(s.lastResource.token).toBe(d.resource);
    expect(s.mcpCalls).toBe(1);
  });

  it("labels the connection null when the token endpoint returns no id_token", async () => {
    fake.setScenario({ no_id_token: true });
    const { bundle } = await connect();
    expect(bundle.accountLabel).toBeNull();
  });

  it("two grants call whoami as two different subjects", async () => {
    const a = await connect();
    const b = await connect();
    const whoA = await callTool(
      egress,
      target(),
      bearer(a.bundle),
      { name: "whoami", arguments: {} },
      {
        redact: [],
      },
    );
    const whoB = await callTool(
      egress,
      target(),
      bearer(b.bundle),
      { name: "whoami", arguments: {} },
      {
        redact: [],
      },
    );
    expect(whoA.content).not.toBe(whoB.content);
  });
});

/** discover → client → authorization URL only (no browser step). */
async function authorizeOnly(urls: ConnectorOAuthUrls = loopbackUrls) {
  const d = await discover(egress, serverUrl);
  const client = await chooseClient(egress, d, {
    preRegistered: preRegistered(d),
    stored: [],
    urls,
    clientName: "OCW test",
  });
  const auth = await buildAuthorization(d, client, urls, undefined);
  return { d, client, auth };
}

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}

describe("connector OAuth against the fake: spec refusals", () => {
  it("no_pkce_meta: discovery refuses before any authorization URL exists", async () => {
    fake.setScenario({ no_pkce_meta: true });
    await expect(discover(egress, serverUrl)).rejects.toMatchObject({ code: "pkce_unsupported" });
    expect((await stats()).lastResource.authorize).toBeNull();
  });

  it("wrong_iss: a callback naming the other issuer is refused", async () => {
    fake.setScenario({ wrong_iss: true });
    const { d, auth } = await authorizeOnly();
    const back = await followAuthorization(auth.authorizationUrl);
    expect(back.get("iss")).toBe(`${base}/mcp-oauth/alt`);
    expect(() => checkCallbackIssuer(d.metadata, d.issuer, back.get("iss"))).toThrow(
      expect.objectContaining({ code: "issuer_mismatch" }),
    );
  });

  it("no_iss: a missing iss is refused because the server advertises it", async () => {
    fake.setScenario({ no_iss: true });
    const { d, auth } = await authorizeOnly();
    const back = await followAuthorization(auth.authorizationUrl);
    expect(back.get("iss")).toBeNull();
    expect(back.get("code")).toBeTruthy();
    expect(() => checkCallbackIssuer(d.metadata, d.issuer, back.get("iss"))).toThrow(
      expect.objectContaining({ code: "issuer_mismatch" }),
    );
  });

  it("refresh sends the resource and rotates; presenting the rotated token again is terminal", async () => {
    const { bundle } = await connect();
    const next = await refreshTokens(egress, bundle);
    expect(next.accessToken).not.toBe(bundle.accessToken);
    expect(next.refreshToken).toBeTruthy();
    expect(next.refreshToken).not.toBe(bundle.refreshToken);
    expect(next).toMatchObject({
      issuer: bundle.issuer,
      clientId: bundle.clientId,
      resource: bundle.resource,
    });
    expect(next.accountLabel).toBe(bundle.accountLabel);
    let s = await stats();
    expect(s.lastResource.refresh).toBe(bundle.resource);
    expect(s.tokenRequests.refresh_token).toBe(1);

    const who = await callTool(
      egress,
      target(),
      bearer(next),
      { name: "whoami", arguments: {} },
      { redact: [] },
    );
    expect(who.content).toContain((bundle.accountLabel ?? "").split("@")[0]);

    const reused = await refreshTokens(egress, bundle).then(
      () => null,
      (e: unknown) => e,
    );
    expect(reused).toBeInstanceOf(ConnectorOAuthError);
    expect(reused).toMatchObject({
      code: "token_exchange_failed",
      terminal: true,
      oauthError: "invalid_grant",
    });
    s = await stats();
    expect(s.refreshReuse).toBe(1);
  });

  it("fail_token_5xx: a refresh failure is transient", async () => {
    const { bundle } = await connect();
    fake.setScenario({ fail_token_5xx: true });
    const err = await refreshTokens(egress, bundle).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "token_exchange_failed", terminal: false });
  });

  it("revokeToken is counted by the fake and kills the grant; false (never a throw) when the server is down", async () => {
    const { bundle } = await connect();
    expect(await revokeToken(egress, bundle)).toBe(true);
    expect((await stats()).revocations).toBe(1);
    await expect(refreshTokens(egress, bundle)).rejects.toMatchObject({ terminal: true });

    const dead = await deadPort();
    const down = {
      ...bundle,
      resource: `http://fake-mcp:${dead}/mcp-oauth/mcp`,
      revocationEndpoint: `http://fake-mcp:${dead}/mcp-oauth/revoke`,
    };
    expect(await revokeToken(egress, down)).toBe(false);
    expect((await stats()).revocations).toBe(1);
  });
});

describe("connector OAuth against the fake: client registration", () => {
  it("DCR: registers a confidential web client, then authorizes, exchanges and refreshes with it", async () => {
    const d = await discover(egress, serverUrl);
    const client = await chooseClient(egress, d, {
      preRegistered: [],
      stored: [],
      urls: loopbackUrls,
      clientName: "OCW test",
    });
    expect(client).toMatchObject({ method: "dcr", isNew: true, issuer: d.issuer });
    const secret = client.method === "dcr" ? client.clientSecret : undefined;
    expect(secret).toBeTruthy();
    expect((await stats()).registrations).toBe(1);

    const scope = chooseScope(d, undefined, null);
    const auth = await buildAuthorization(d, client, loopbackUrls, scope);
    const back = await followAuthorization(auth.authorizationUrl);
    checkCallbackIssuer(d.metadata, d.issuer, back.get("iss"));
    const bundle = await exchangeCode(egress, d, client, {
      code: back.get("code") ?? "",
      codeVerifier: auth.codeVerifier,
      redirectUri: loopbackUrls.redirectUri,
      ...(scope ? { scope } : {}),
    });
    expect(bundle).toMatchObject({ clientId: client.clientId, authMethod: "client_secret_basic" });
    expect(bundle.scopes).toEqual(expect.arrayContaining(["records:read", "records:write"]));

    await expect(refreshTokens(egress, bundle)).rejects.toMatchObject({
      code: "needs_client",
      terminal: true,
    });
    const next = await refreshTokens(egress, bundle, secret);
    expect(next.accessToken).not.toBe(bundle.accessToken);
  });

  it("CIMD: the fake reads the instance's client metadata document and accepts the public client", async () => {
    const urls = connectorOAuthUrls("https://ocw.example.test");
    const metadataUrl = urls.clientMetadataUrl ?? "";
    cimdDocs.set(metadataUrl, clientMetadataDocument(urls, "OCW test"));
    const d = await discover(egress, serverUrl);
    const client = await chooseClient(egress, d, {
      preRegistered: [],
      stored: [],
      urls,
      clientName: "OCW test",
    });
    expect(client).toEqual({ method: "cimd", issuer: d.issuer, clientId: metadataUrl });

    const auth = await buildAuthorization(d, client, urls, chooseScope(d, undefined, null));
    const back = await followAuthorization(auth.authorizationUrl);
    checkCallbackIssuer(d.metadata, d.issuer, back.get("iss"));
    const bundle = await exchangeCode(egress, d, client, {
      code: back.get("code") ?? "",
      codeVerifier: auth.codeVerifier,
      redirectUri: urls.redirectUri,
    });
    expect(bundle).toMatchObject({ clientId: metadataUrl, authMethod: "none" });
    expect((await stats()).registrations).toBe(0);
  });

  it("different_issuer: the discovered issuer changes and no client of the old issuer is reused", async () => {
    const first = await connect();
    const dcrMain = await chooseClient(egress, first.d, {
      preRegistered: [],
      stored: [],
      urls: loopbackUrls,
      clientName: "OCW test",
    });
    expect(dcrMain.method).toBe("dcr");

    fake.setScenario({ different_issuer: true });
    const d = await discover(egress, serverUrl);
    expect(d.issuer).toBe(`${base}/mcp-oauth/alt`);
    expect(d.issuer).not.toBe(first.bundle.issuer);
    expect(d.resource).toBe(first.bundle.resource);

    const client = await chooseClient(egress, d, {
      preRegistered: [{ issuer: first.d.issuer, clientId: PRE_REGISTERED }],
      stored: [
        {
          issuer: first.d.issuer,
          clientId: dcrMain.clientId,
          ...(dcrMain.method === "dcr" && dcrMain.clientSecret ? { clientSecret: dcrMain.clientSecret } : {}),
          method: "dcr",
        },
      ],
      urls: loopbackUrls,
      clientName: "OCW test",
    });
    expect(client).toMatchObject({ method: "dcr", isNew: true, issuer: d.issuer });
    expect([PRE_REGISTERED, dcrMain.clientId]).not.toContain(client.clientId);

    // A client of the old issuer cannot be carried into the new issuer's flow either.
    await expect(buildAuthorization(d, first.client, loopbackUrls, undefined)).rejects.toMatchObject({
      code: "issuer_mismatch",
    });
    await expect(
      exchangeCode(egress, d, first.client, { code: "x", codeVerifier: "y", redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: "issuer_mismatch" });

    const auth = await buildAuthorization(d, client, loopbackUrls, undefined);
    const back = await followAuthorization(auth.authorizationUrl);
    checkCallbackIssuer(d.metadata, d.issuer, back.get("iss"));
    const bundle = await exchangeCode(egress, d, client, {
      code: back.get("code") ?? "",
      codeVerifier: auth.codeVerifier,
      redirectUri: REDIRECT,
    });
    expect(bundle.issuer).toBe(d.issuer);
  });
});
