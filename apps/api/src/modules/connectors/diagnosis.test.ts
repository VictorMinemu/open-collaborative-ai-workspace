import {
  type AuthTestStep,
  ConnectorAuthFailure,
  ConnectorErrorCode,
  connectorOAuthUrls,
  OAuthTestResponse,
} from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Egress } from "../../lib/egress";
import { authFailureOf, type DiagnoseInput, diagnose } from "./diagnosis";
import { ConnectorOAuthError } from "./oauth";

/**
 * Unit tests of the D-10 failure mapping and the Test sign-in run (07.14-04). The stub `Egress` answers a table of
 * URLs and records every request; the global fetch throws and must never be called.
 */

const MCP = "https://mcp.test/mcp";
const AS = "https://as.test";
const PRM_URL = "https://mcp.test/.well-known/oauth-protected-resource/mcp";
const AS_META_URL = "https://as.test/.well-known/oauth-authorization-server";

function stub(routes: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const handle = async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = new Request(input, init);
    calls.push(`${req.method} ${req.url}`);
    const json = routes[`${req.method} ${req.url}`];
    if (json === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } });
  };
  const egress: Egress = {
    fetch: (input, init) => handle(input, init),
    bound: () => ((input: string | URL | Request, init?: RequestInit) => handle(input, init)) as typeof fetch,
  };
  return { egress, calls };
}

const prm = { resource: MCP, authorization_servers: [AS], scopes_supported: ["records:read"] };
const asMeta = (over: Record<string, unknown> = {}) => ({
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  client_id_metadata_document_supported: true,
  ...over,
});
const metadataRoutes = (over: Record<string, unknown> = {}) => ({
  [`GET ${PRM_URL}`]: prm,
  [`GET ${AS_META_URL}`]: asMeta(over),
});

const httpsUrls = connectorOAuthUrls("https://ocw.example.test");
const input = (over: Partial<DiagnoseInput> = {}): DiagnoseInput => ({
  serverUrl: MCP,
  mode: "org_oauth",
  urls: httpsUrls,
  preRegistered: [],
  storedClients: [],
  allowCimd: true,
  scopes: [],
  ...over,
});
const statuses = (r: OAuthTestResponse) =>
  Object.fromEntries(r.steps.map((s) => [s.step, s.status])) as Record<AuthTestStep, string>;

const globalFetch = vi.fn((..._args: unknown[]): Promise<Response> => {
  throw new Error("global fetch called");
});
beforeAll(() => {
  vi.stubGlobal("fetch", globalFetch);
});
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("authFailureOf (07.14 D-10)", () => {
  it("the member codes stay exactly the 07.4 set (COA-05)", () => {
    expect(ConnectorErrorCode.options).toEqual([
      "https_required",
      "discovery_failed",
      "pkce_unsupported",
      "needs_client",
      "egress_refused",
      "flow_expired",
      "session_mismatch",
      "access_denied",
      "issuer_mismatch",
      "token_exchange_failed",
      "not_connected",
      "needs_reconnect",
    ]);
  });

  it("a step wins over the code", () => {
    for (const step of ConnectorAuthFailure.options) {
      expect(authFailureOf(new ConnectorOAuthError("discovery_failed", { step }))).toBe(step);
    }
    expect(authFailureOf(new ConnectorOAuthError("egress_refused", { step: "discovery_failed" }))).toBe(
      "discovery_failed",
    );
  });

  it("without a step, the code decides", () => {
    const rows: Array<[ConnectorErrorCode, ConnectorAuthFailure]> = [
      ["https_required", "https_required"],
      ["discovery_failed", "discovery_failed"],
      ["pkce_unsupported", "pkce_unsupported"],
      ["issuer_mismatch", "issuer_mismatch"],
      ["token_exchange_failed", "token_exchange_failed"],
      ["needs_client", "client_registration_unavailable"],
      ["egress_refused", "token_endpoint_untrusted"],
      ["needs_reconnect", "token_exchange_failed"],
      ["access_denied", "token_exchange_failed"],
    ];
    for (const [code, failure] of rows) expect(authFailureOf(new ConnectorOAuthError(code))).toBe(failure);
  });

  it("anything that is not a ConnectorOAuthError is token_exchange_failed, its text never read", () => {
    for (const err of [
      new Error("discovery_failed"),
      new TypeError("x"),
      "pkce_unsupported",
      null,
      undefined,
    ]) {
      expect(authFailureOf(err)).toBe("token_exchange_failed");
    }
  });
});

describe("diagnose (07.14 D-10, D-18): ordered, registration-free, storage-free", () => {
  it("lists the seven steps in order and passes a CIMD-capable sign-in without the token step", async () => {
    const s = stub(metadataRoutes());
    const r = await diagnose(s.egress, input());
    expect(OAuthTestResponse.parse(r)).toEqual(r);
    expect(r.steps.map((x) => x.step)).toEqual([
      "public_url",
      "discovery",
      "issuer",
      "endpoints",
      "pkce",
      "client_registration",
      "token",
    ]);
    expect(statuses(r)).toEqual({
      public_url: "ok",
      discovery: "ok",
      issuer: "ok",
      endpoints: "ok",
      pkce: "ok",
      client_registration: "ok",
      token: "skipped",
    });
    expect(r).toMatchObject({
      ok: true,
      failure: null,
      clientMethod: "cimd",
      issuer: AS,
      tokenEndpoint: `${AS}/token`,
      redirectUri: httpsUrls.redirectUri,
      clientMetadataUrl: httpsUrls.clientMetadataUrl,
    });
    // A dry run: nothing but the two metadata reads, never a registration.
    expect(s.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("public_url: no usable redirect URI, or a loopback one while the page is elsewhere, fails before any request", async () => {
    const lan = stub(metadataRoutes());
    const r = await diagnose(lan.egress, input({ urls: connectorOAuthUrls("http://ocw.lan:4290") }));
    expect(r).toMatchObject({ ok: false, failure: "https_required" });
    expect(statuses(r).public_url).toBe("failed");
    expect(r.steps.slice(1).every((x) => x.status === "skipped")).toBe(true);
    expect(lan.calls).toHaveLength(0);

    const tunnel = stub(metadataRoutes());
    const loopback = connectorOAuthUrls("http://localhost:4000");
    const behind = await diagnose(
      tunnel.egress,
      input({ urls: loopback, pageOrigin: "https://ocw.example.com" }),
    );
    expect(behind.failure).toBe("https_required");
    expect(tunnel.calls).toHaveLength(0);

    const local = stub(metadataRoutes());
    const both = await diagnose(local.egress, input({ urls: loopback, pageOrigin: "http://127.0.0.1:3000" }));
    expect(statuses(both).public_url).toBe("ok");
    expect(both.clientMethod).toBe("dcr");
  });

  it("the first failure stops the run and later steps are skipped", async () => {
    const cases: Array<[Record<string, unknown>, AuthTestStep, ConnectorAuthFailure]> = [
      [{ issuer: "https://other.test" }, "issuer", "issuer_mismatch"],
      [{ token_endpoint: "http://other.test/token" }, "endpoints", "token_endpoint_untrusted"],
      [{ code_challenge_methods_supported: undefined }, "pkce", "pkce_unsupported"],
      [
        { registration_endpoint: undefined, client_id_metadata_document_supported: undefined },
        "client_registration",
        "client_registration_unavailable",
      ],
    ];
    for (const [over, step, failure] of cases) {
      const r = await diagnose(stub(metadataRoutes(over)).egress, input());
      expect(r).toMatchObject({ ok: false, failure });
      const order = r.steps.map((x) => x.step);
      const at = order.indexOf(step);
      expect(r.steps[at]?.status).toBe("failed");
      expect(r.steps.slice(0, at).every((x) => x.status === "ok")).toBe(true);
      expect(r.steps.slice(at + 1).every((x) => x.status === "skipped")).toBe(true);
    }
    const none = await diagnose(stub().egress, input());
    expect(statuses(none)).toMatchObject({ public_url: "ok", discovery: "failed", issuer: "skipped" });
    expect(none.failure).toBe("discovery_failed");
  });

  it("client credentials: skips public_url, pkce and client_registration, runs a real grant and returns no token", async () => {
    const s = stub({
      ...metadataRoutes(),
      [`POST ${AS}/token`]: { token_type: "Bearer", access_token: "at-canary-1", expires_in: 60 },
    });
    const r = await diagnose(
      s.egress,
      input({ mode: "org_client_credentials", cc: { clientId: "cc", clientSecret: "secret-canary-1" } }),
    );
    expect(statuses(r)).toEqual({
      public_url: "skipped",
      discovery: "ok",
      issuer: "ok",
      endpoints: "ok",
      pkce: "skipped",
      client_registration: "skipped",
      token: "ok",
    });
    expect(r).toMatchObject({ ok: true, failure: null, clientMethod: null, tokenEndpoint: `${AS}/token` });
    expect(JSON.stringify(r)).not.toContain("at-canary-1");
    expect(JSON.stringify(r)).not.toContain("secret-canary-1");
    expect(s.calls.filter((c) => c === `POST ${AS}/token`)).toHaveLength(1);
  });

  it("client credentials without metadata: the admin's Token URL is required and checked before the grant", async () => {
    const cc = { clientId: "cc", clientSecret: "s" };
    const missing = await diagnose(stub().egress, input({ mode: "org_client_credentials", cc }));
    expect(missing).toMatchObject({ ok: false, failure: "discovery_failed" });
    expect(statuses(missing).discovery).toBe("failed");

    const s = stub();
    const untrusted = await diagnose(
      s.egress,
      input({ mode: "org_client_credentials", cc: { ...cc, tokenEndpoint: "http://other.test/token" } }),
    );
    expect(untrusted).toMatchObject({ ok: false, failure: "token_endpoint_untrusted" });
    expect(statuses(untrusted)).toMatchObject({ discovery: "ok", endpoints: "failed", token: "skipped" });
    expect(s.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });
});
