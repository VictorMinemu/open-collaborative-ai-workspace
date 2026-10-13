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
import { callTool } from "./mcp-client";
import {
  buildAuthorization,
  type ClientChoice,
  checkCallbackIssuer,
  chooseClient,
  type DiscoveredAuth,
  discover,
  exchangeCode,
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

beforeAll(async () => {
  fake = createFakeMcpOAuth({
    preRegistered: [{ client_id: PRE_REGISTERED, redirect_uris: [REDIRECT] }],
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
