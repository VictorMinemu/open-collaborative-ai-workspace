import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { type ConnectorOAuthUrls, connectorOAuthUrls } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFakeMcpOAuth,
  type FakeMcpOAuth,
  type FakeMcpOAuthStats,
} from "../../../../../infra/fake-model/fake-mcp-oauth.mjs";
import { createEgress, type Egress } from "../../lib/egress";
import { CC_SECRET, PRE_REGISTERED_CC } from "../../testing-connectors";
import { clientMetadataDocument } from "./client-metadata";
import { callTool, listTools, McpUpstreamError } from "./mcp-client";
import {
  buildAuthorization,
  type ClientChoice,
  ConnectorOAuthError,
  checkCallbackIssuer,
  chooseClient,
  chooseScope,
  clientCredentialsGrant,
  type DiscoveredAuth,
  discover,
  discoverTokenEndpoint,
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
    preRegistered: [
      { client_id: PRE_REGISTERED, redirect_uris: [REDIRECT] },
      { client_id: PRE_REGISTERED_CC, client_secret: CC_SECRET, redirect_uris: [] },
    ],
    cimdFetch: async (url) => {
      const doc = cimdDocs.get(url);
      if (!doc) throw new Error("no such client metadata document");
      return doc;
    },
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-mcp");
    // A careless MCP server that echoes the caller's credential in its error body and challenge.
    if (url.pathname === "/leaky/500" || url.pathname === "/leaky/401") {
      const auth = req.headers.authorization ?? "";
      const status = url.pathname.endsWith("401") ? 401 : 500;
      res.writeHead(status, {
        "content-type": "text/plain",
        "www-authenticate": `Bearer error="invalid_token", error_description="bad ${auth}"`,
      });
      res.end(`refused credential: ${auth}`);
      return;
    }
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

/** Every way an error could carry a credential: message, string form, stack and the cause chain. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur; depth++) {
    parts.push(String(cur));
    if (cur instanceof Error) parts.push(cur.message, cur.stack ?? "");
    const www = (cur as { wwwAuthenticate?: unknown }).wwwAuthenticate;
    if (typeof www === "string") parts.push(www);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

async function upstreamError(promise: Promise<unknown>): Promise<McpUpstreamError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(McpUpstreamError);
  return err as McpUpstreamError;
}

describe("MCP client against the fake: results and errors", () => {
  it("lists the tools with their schemas and read-only / destructive flags", async () => {
    const { bundle } = await connect();
    const tools = await listTools(egress, target(), bearer(bundle));
    expect(tools.map((t) => t.name)).toEqual(["whoami", "create_record", "echo_auth"]);
    expect(tools[0]).toMatchObject({ readOnly: true, destructive: false });
    expect(tools[1]).toMatchObject({ readOnly: false, destructive: true });
    expect(tools[1]?.inputSchema).toMatchObject({ type: "object", required: ["title"] });
    expect(tools[2]?.description).toContain("Authorization");
  });

  it("redacts the bearer a server echoes back, listed or not", async () => {
    const { bundle } = await connect();
    for (const redact of [[bundle.accessToken], []]) {
      const out = await callTool(
        egress,
        target(),
        bearer(bundle),
        { name: "echo_auth", arguments: {} },
        { redact },
      );
      expect(out.content).not.toContain(bundle.accessToken);
      expect(out.content).toContain("[redacted]");
    }
  });

  it("a call without a bearer is unauthorized, with the server's challenge", async () => {
    const err = await upstreamError(
      callTool(
        egress,
        target(),
        { headerName: "X-Not-Auth", headerValue: "nothing" },
        { name: "whoami", arguments: {} },
        {
          redact: [],
        },
      ),
    );
    expect(err.code).toBe("unauthorized");
    expect(err.wwwAuthenticate).toContain("resource_metadata=");
    expect(err.cause).toBeUndefined();
  });

  it("an unknown bearer is unauthorized and never appears in the error", async () => {
    const canary = "fakeat_canary_unknown_bearer_9c1f";
    const err = await upstreamError(
      listTools(egress, target(), { headerName: "Authorization", headerValue: `Bearer ${canary}` }),
    );
    expect(err.code).toBe("unauthorized");
    expect(errorText(err)).not.toContain(canary);
  });

  it("insufficient_scope is its own code", async () => {
    const { bundle } = await connect();
    fake.setScenario({ insufficient_scope: true });
    const err = await upstreamError(
      callTool(egress, target(), bearer(bundle), { name: "whoami", arguments: {} }, { redact: [] }),
    );
    expect(err.code).toBe("insufficient_scope");
    expect(err.wwwAuthenticate).toContain('error="insufficient_scope"');
  });

  it("a slow server times out at the call's timeout", async () => {
    const { bundle } = await connect();
    fake.setScenario({ slow_mcp_ms: 3000 });
    const started = Date.now();
    const err = await upstreamError(
      callTool(
        egress,
        target(),
        bearer(bundle),
        { name: "whoami", arguments: {} },
        { redact: [], timeoutMs: 1000 },
      ),
    );
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("a target on a refused address is egress_refused, even though its own host:port is allowed", async () => {
    for (const url of ["http://169.254.169.254/mcp", "http://localhost:3999/mcp", "http://[::1]:3999/mcp"]) {
      const err = await upstreamError(
        callTool(
          egress,
          { url, transport: "streamable-http" },
          { headerName: "Authorization", headerValue: "Bearer x" },
          {
            name: "whoami",
            arguments: {},
          },
          { redact: [] },
        ),
      );
      expect(err.code).toBe("egress_refused");
    }
  });

  it("no error message, challenge or cause carries the bearer, even when the server echoes it", async () => {
    const { bundle } = await connect();
    const leaky = { url: `${base}/leaky/500`, transport: "streamable-http" as const };
    const err500 = await upstreamError(
      callTool(
        egress,
        leaky,
        bearer(bundle),
        { name: "whoami", arguments: {} },
        { redact: [bundle.accessToken] },
      ),
    );
    expect(err500.code).toBe("upstream_error");
    expect(errorText(err500)).not.toContain(bundle.accessToken);

    const leaky401 = { url: `${base}/leaky/401`, transport: "streamable-http" as const };
    const err401 = await upstreamError(listTools(egress, leaky401, bearer(bundle)));
    expect(err401.code).toBe("unauthorized");
    expect(err401.wwwAuthenticate).toContain("[redacted]");
    expect(errorText(err401)).not.toContain(bundle.accessToken);
  });

  it("an SSE target is reached through the guard too (refused before connecting)", async () => {
    const err = await upstreamError(
      listTools(
        egress,
        { url: "http://169.254.169.254/sse", transport: "sse" },
        { headerName: "Authorization", headerValue: "Bearer x" },
      ),
    );
    expect(err.code).toBe("egress_refused");
  });
});

describe("client credentials against the fake (07.14 D-03, D-17)", () => {
  /** The grant's inputs from a discovery, with the fake's pre-registered client-credentials client. */
  const grantInput = (
    disc: Awaited<ReturnType<typeof discoverTokenEndpoint>>,
    over: Partial<Parameters<typeof clientCredentialsGrant>[1]> = {},
  ): Parameters<typeof clientCredentialsGrant>[1] => ({
    tokenEndpoint: disc.tokenEndpoint ?? "",
    issuer: disc.issuer,
    resource: disc.resource,
    sameOrigin: disc.sameOrigin,
    mcpOrigin: disc.mcpOrigin,
    clientId: PRE_REGISTERED_CC,
    clientSecret: CC_SECRET,
    scopes: [],
    authMethods: disc.authMethods,
    ...over,
  });
  const bearerOf = (accessToken: string) => ({
    headerName: "Authorization",
    headerValue: `Bearer ${accessToken}`,
  });

  it("finds the token endpoint through RFC 9728 → RFC 8414, grants with Basic and resource, and lists tools", async () => {
    const disc = await discoverTokenEndpoint(egress, serverUrl);
    expect(disc).toMatchObject({
      resource: serverUrl,
      issuer: `${base}/mcp-oauth`,
      tokenEndpoint: `${base}/mcp-oauth/token`,
      revocationEndpoint: `${base}/mcp-oauth/revoke`,
      sameOrigin: `fake-mcp:${port}`,
      mcpOrigin: base,
    });
    expect(disc.authMethods).toContain("client_secret_basic");

    const before = Date.now();
    const token = await clientCredentialsGrant(egress, grantInput(disc));
    expect(token.accessToken).toMatch(/^fakeat_/);
    expect(token.authMethod).toBe("client_secret_basic");
    expect(token.expiresAt).toBeGreaterThan(before);

    const tools = await listTools(egress, target(), bearerOf(token.accessToken));
    expect(tools.map((t) => t.name)).toContain("whoami");

    const s = await stats();
    expect(s.tokenRequests.client_credentials).toBe(1);
    expect(s.lastResource.cc).toBe(serverUrl);
    expect(s.lastClientAuth).toBe("basic");
  });

  it("cc_post_only: picks client_secret_post from the metadata", async () => {
    fake.setScenario({ cc_post_only: true });
    const disc = await discoverTokenEndpoint(egress, serverUrl);
    expect(disc.authMethods).toEqual(["client_secret_post"]);
    const token = await clientCredentialsGrant(egress, grantInput(disc));
    expect(token.authMethod).toBe("client_secret_post");
    expect((await stats()).lastClientAuth).toBe("post");
  });

  it("no_authorization_endpoint: the lenient metadata read still finds the token endpoint and the issuer", async () => {
    fake.setScenario({ no_authorization_endpoint: true });
    await expect(discover(egress, serverUrl)).rejects.toBeInstanceOf(ConnectorOAuthError);
    const disc = await discoverTokenEndpoint(egress, serverUrl);
    expect(disc).toMatchObject({
      issuer: `${base}/mcp-oauth`,
      tokenEndpoint: `${base}/mcp-oauth/token`,
      revocationEndpoint: `${base}/mcp-oauth/revoke`,
    });
    const token = await clientCredentialsGrant(egress, grantInput(disc));
    expect(token.accessToken).toMatch(/^fakeat_/);
  });

  it("no metadata: answers nulls, and an admin-entered endpoint on the MCP URL's own origin works", async () => {
    const bare = `${base}/no-prm/mcp`;
    const disc = await discoverTokenEndpoint(egress, bare);
    expect(disc).toEqual({
      resource: resourceUrlFromServerUrl(bare).href,
      issuer: null,
      tokenEndpoint: null,
      revocationEndpoint: null,
      authMethods: [],
      scopes: undefined,
      sameOrigin: `fake-mcp:${port}`,
      mcpOrigin: base,
    });
    // The fake's own MCP resource, with the token URL an admin typed in (no metadata to pin an issuer).
    const token = await clientCredentialsGrant(
      egress,
      grantInput(disc, { tokenEndpoint: `${base}/mcp-oauth/token`, issuer: null, resource: serverUrl }),
    );
    expect(token.authMethod).toBe("client_secret_basic");
    const tools = await listTools(egress, target(), bearerOf(token.accessToken));
    expect(tools.length).toBeGreaterThan(0);
  });

  it("an admin token endpoint on another port or host over http is refused before any request", async () => {
    const disc = await discoverTokenEndpoint(egress, serverUrl);
    for (const tokenEndpoint of [
      `http://fake-mcp:${port + 1}/mcp-oauth/token`,
      `http://127.0.0.1:${port}/mcp-oauth/token`,
      `http://user:pw@fake-mcp:${port}/mcp-oauth/token`,
    ]) {
      await expect(clientCredentialsGrant(egress, grantInput(disc, { tokenEndpoint }))).rejects.toMatchObject(
        {
          step: "token_endpoint_untrusted",
        },
      );
    }
    expect((await stats()).tokenRequests.client_credentials).toBe(0);
  });

  it("a wrong secret is terminal (invalid_client); an unknown scope is terminal scope_rejected", async () => {
    const disc = await discoverTokenEndpoint(egress, serverUrl);
    await expect(
      clientCredentialsGrant(egress, grantInput(disc, { clientSecret: "wrong-secret" })),
    ).rejects.toMatchObject({
      code: "token_exchange_failed",
      terminal: true,
      oauthError: "invalid_client",
      step: "token_exchange_failed",
    });
    await expect(
      clientCredentialsGrant(egress, grantInput(disc, { scopes: ["unknown"] })),
    ).rejects.toMatchObject({
      code: "token_exchange_failed",
      terminal: true,
      oauthError: "invalid_scope",
      step: "scope_rejected",
    });
  });

  it("issuer_mismatch_meta: the metadata's issuer is not its URL", async () => {
    fake.setScenario({ issuer_mismatch_meta: true });
    await expect(discoverTokenEndpoint(egress, serverUrl)).rejects.toMatchObject({
      code: "discovery_failed",
      step: "issuer_mismatch",
    });
  });
});
