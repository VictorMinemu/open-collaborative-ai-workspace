import { type ConnectorOAuthUrls, connectorOAuthUrls } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEgress, type Egress, type EgressPolicy, EgressRefusedError } from "../../lib/egress";
import { clientMetadataDocument } from "./client-metadata";
import {
  type AuthServerMetadata,
  buildAuthorization,
  CC_DEFAULT_TTL_S,
  CC_TERMINAL_OAUTH_ERRORS,
  ConnectorOAuthError,
  checkCallbackIssuer,
  chooseClient,
  chooseScope,
  clientCredentialsGrant,
  type DiscoveredAuth,
  discover,
  exchangeCode,
  previewClient,
  refreshTokens,
  revokeToken,
  type TokenBundle,
} from "./oauth";

/**
 * Unit tests of the connector OAuth client's refusals and choices (D-02, D-07). A stub `Egress` answers the stubbed
 * hosts from a table and hands every other URL to a real guard with no DNS, so the refusals of literal private
 * addresses are the guard's own. The global fetch throws and must never be called.
 */

const MCP = "https://mcp.test/mcp";
const AS = "https://as.test";
const STUBBED_HOSTS = new Set(["mcp.test", "as.test", "other.test"]);

interface StaticReply {
  status?: number;
  json?: unknown;
  text?: string;
}
type Reply = StaticReply | ((req: Request) => StaticReply);

interface Stub {
  egress: Egress;
  routes: Map<string, Reply>;
  /** Every request: method, URL, the policy it was made under, and the request itself. */
  calls: Array<{ method: string; url: string; policy: EgressPolicy | undefined; body: string }>;
}

function stubEgress(): Stub {
  const real = createEgress({
    platformHosts: [],
    lookup: async () => {
      throw new Error("no DNS in unit tests");
    },
  });
  const routes = new Map<string, Reply>();
  const calls: Stub["calls"] = [];
  const handle = async (input: string | URL | Request, init: RequestInit = {}, policy?: EgressPolicy) => {
    const req = new Request(input, init);
    const body = init.body instanceof URLSearchParams ? init.body.toString() : await req.clone().text();
    calls.push({ method: req.method, url: req.url, policy, body });
    const host = new URL(req.url).hostname;
    if (!STUBBED_HOSTS.has(host)) return real.fetch(input, init, policy);
    const route = routes.get(`${req.method} ${req.url}`);
    const reply = typeof route === "function" ? route(req) : route;
    if (!reply) return new Response("not found", { status: 404 });
    if (reply.json !== undefined) {
      return new Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(reply.text ?? "", { status: reply.status ?? 200 });
  };
  const egress: Egress = {
    fetch: handle,
    bound: (policy) =>
      ((input: string | URL | Request, init?: RequestInit) => handle(input, init, policy)) as typeof fetch,
  };
  return { egress, routes, calls };
}

const PRM_URL = "https://mcp.test/.well-known/oauth-protected-resource/mcp";
const AS_META_URL = "https://as.test/.well-known/oauth-authorization-server";

function prm(over: Record<string, unknown> = {}) {
  return { resource: MCP, authorization_servers: [AS], scopes_supported: ["records:read"], ...over };
}

function asMeta(over: Record<string, unknown> = {}) {
  return {
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    revocation_endpoint: `${AS}/revoke`,
    registration_endpoint: `${AS}/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: ["records:read", "records:write", "offline_access"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    ...over,
  };
}

function serve(stub: Stub, p: Record<string, unknown> = prm(), m: Record<string, unknown> = asMeta()) {
  stub.routes.set(`GET ${PRM_URL}`, { json: p });
  stub.routes.set(`GET ${AS_META_URL}`, { json: m });
}

async function codeOf(promise: Promise<unknown>): Promise<ConnectorOAuthError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectorOAuthError);
  return err as ConnectorOAuthError;
}

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

const httpsUrls: ConnectorOAuthUrls = connectorOAuthUrls("https://ocw.example.test");
const loopbackUrls: ConnectorOAuthUrls = connectorOAuthUrls("http://127.0.0.1:4290");

describe("discover: the checks the SDK does not do", () => {
  it("returns issuer, resource, scopes and the MCP origin, every request under the server's policy", async () => {
    const stub = stubEgress();
    serve(stub);
    const d = await discover(stub.egress, MCP);
    expect(d).toMatchObject({
      issuer: AS,
      resource: MCP,
      scopes: ["records:read"],
      sameOrigin: "mcp.test:443",
    });
    expect(stub.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of stub.calls) expect(call.policy?.privateAllow).toEqual(["mcp.test:443"]);
  });

  it("refuses metadata without code_challenge_methods_supported (pkce_unsupported)", async () => {
    const stub = stubEgress();
    serve(stub, prm(), asMeta({ code_challenge_methods_supported: undefined }));
    expect((await codeOf(discover(stub.egress, MCP))).code).toBe("pkce_unsupported");
  });

  it('refuses code_challenge_methods_supported ["plain"] (pkce_unsupported)', async () => {
    const stub = stubEgress();
    serve(stub, prm(), asMeta({ code_challenge_methods_supported: ["plain"] }));
    expect((await codeOf(discover(stub.egress, MCP))).code).toBe("pkce_unsupported");
  });

  it("refuses a plain-http token endpoint on another origin (discovery_failed)", async () => {
    const stub = stubEgress();
    serve(stub, prm(), asMeta({ token_endpoint: "http://other.test/token" }));
    expect((await codeOf(discover(stub.egress, MCP))).code).toBe("discovery_failed");
  });

  it("refuses a plain-http registration or revocation endpoint on another origin", async () => {
    for (const field of ["registration_endpoint", "revocation_endpoint", "authorization_endpoint"]) {
      const stub = stubEgress();
      serve(stub, prm(), asMeta({ [field]: "http://other.test/x" }));
      expect((await codeOf(discover(stub.egress, MCP))).code).toBe("discovery_failed");
    }
  });

  it("refuses a PRM authorization server on a private literal through the guard (egress_refused)", async () => {
    const stub = stubEgress();
    serve(stub, prm({ authorization_servers: ["https://10.0.0.5/as"] }));
    expect((await codeOf(discover(stub.egress, MCP))).code).toBe("egress_refused");
    expect(stub.calls.some((c) => c.url.startsWith("https://10.0.0.5/"))).toBe(true);
  });

  it("refuses a plain-http authorization server on another origin before fetching it", async () => {
    const stub = stubEgress();
    serve(stub, prm({ authorization_servers: ["http://other.test/as"] }));
    expect((await codeOf(discover(stub.egress, MCP))).code).toBe("discovery_failed");
    expect(stub.calls.some((c) => c.url.includes("other.test"))).toBe(false);
  });

  it("refuses metadata whose issuer is not the URL it was discovered at (RFC 8414 §3.3)", async () => {
    const stub = stubEgress();
    serve(stub, prm(), asMeta({ issuer: "https://other.test" }));
    expect((await codeOf(discover(stub.egress, MCP))).code).toBe("discovery_failed");
  });

  it("refuses a PRM resource that is another server", async () => {
    const stub = stubEgress();
    serve(stub, prm({ resource: "https://other.test/mcp" }));
    expect((await codeOf(discover(stub.egress, MCP))).code).toBe("discovery_failed");
  });

  it("refuses a server without protected resource metadata, as a terminal failure (WINDOWS #179)", async () => {
    const stub = stubEgress();
    stub.routes.set(`GET ${AS_META_URL}`, { json: asMeta() });
    const err = await codeOf(discover(stub.egress, MCP));
    expect(err.code).toBe("discovery_failed");
    // The server answered: an admin must act (the member's retry will not help).
    expect(err.terminal).toBe(true);
  });

  it("a guard network failure during discovery stays transient", async () => {
    const stub = stubEgress();
    stub.routes.set(`GET ${PRM_URL}`, () => {
      throw new EgressRefusedError("network_error", "mcp.test");
    });
    const err = await codeOf(discover(stub.egress, MCP));
    expect(err.code).toBe("discovery_failed");
    expect(err.terminal).toBe(false);
  });

  it("follows a trusted resource_metadata from a challenge and refuses an untrusted one", async () => {
    const stub = stubEgress();
    stub.routes.set("GET https://mcp.test/custom-prm", { json: prm() });
    stub.routes.set(`GET ${AS_META_URL}`, { json: asMeta() });
    const d = await discover(stub.egress, MCP, {
      wwwAuthenticate: 'Bearer resource_metadata="https://mcp.test/custom-prm", scope="records:read"',
    });
    expect(d.issuer).toBe(AS);
    expect(stub.calls.some((c) => c.url === PRM_URL)).toBe(false);

    const refused = await codeOf(
      discover(stub.egress, MCP, { wwwAuthenticate: 'Bearer resource_metadata="http://other.test/prm"' }),
    );
    expect(refused.code).toBe("discovery_failed");
  });
});

describe("checkCallbackIssuer (RFC 9207)", () => {
  const advertised = asMeta() as unknown as AuthServerMetadata;
  const silent = asMeta({
    authorization_response_iss_parameter_supported: undefined,
  }) as unknown as AuthServerMetadata;

  it("refuses a missing iss when the server advertises it", () => {
    expect(() => checkCallbackIssuer(advertised, AS, null)).toThrow(
      expect.objectContaining({ code: "issuer_mismatch" }),
    );
  });
  it("refuses a different iss, advertised or not, by plain string comparison", () => {
    for (const meta of [advertised, silent]) {
      expect(() => checkCallbackIssuer(meta, AS, "https://other.test")).toThrow(
        expect.objectContaining({ code: "issuer_mismatch" }),
      );
      expect(() => checkCallbackIssuer(meta, AS, `${AS}/`)).toThrow(
        expect.objectContaining({ code: "issuer_mismatch" }),
      );
    }
  });
  it("accepts an equal iss", () => {
    expect(() => checkCallbackIssuer(advertised, AS, AS)).not.toThrow();
  });
  it("accepts a missing iss when the server does not advertise it", () => {
    expect(() => checkCallbackIssuer(silent, AS, null)).not.toThrow();
  });
});

function discovered(over: Partial<DiscoveredAuth> = {}, meta: Record<string, unknown> = {}): DiscoveredAuth {
  return {
    serverUrl: MCP,
    resource: MCP,
    issuer: AS,
    metadata: asMeta(meta) as unknown as AuthServerMetadata,
    scopes: ["records:read"],
    sameOrigin: "mcp.test:443",
    ...over,
  };
}

describe("chooseScope", () => {
  it("prefers the admin scopes, then the challenge scope, then the PRM scopes", () => {
    const d = discovered({}, { scopes_supported: ["a"] });
    expect(chooseScope(d, "records:write", ["admin:x", "admin:y"])).toBe("admin:x admin:y");
    expect(chooseScope(d, "records:write", [])).toBe("records:write");
    expect(chooseScope(d, "records:write", null)).toBe("records:write");
    expect(chooseScope(d, undefined, null)).toBe("records:read");
    expect(chooseScope(discovered({ scopes: undefined }, { scopes_supported: ["a"] }), undefined, null)).toBe(
      undefined,
    );
  });

  it("adds offline_access only when the authorization server lists it", () => {
    expect(chooseScope(discovered(), undefined, null)).toBe("records:read offline_access");
    expect(chooseScope(discovered(), "offline_access records:read", null)).toBe(
      "offline_access records:read",
    );
    expect(chooseScope(discovered({}, { scopes_supported: ["records:read"] }), undefined, null)).toBe(
      "records:read",
    );
    expect(chooseScope(discovered({ scopes: undefined }), undefined, null)).toBe(undefined);
  });
});

describe("chooseClient: the spec's order, keyed by issuer", () => {
  const register = (stub: Stub, secret = true) => {
    let n = 0;
    stub.routes.set(`POST ${AS}/register`, (req) => {
      n += 1;
      void req;
      return {
        status: 201,
        json: {
          client_id: `dcr_${n}`,
          ...(secret ? { client_secret: `dcrs_secret_${n}` } : {}),
          redirect_uris: [loopbackUrls.redirectUri],
        },
      };
    });
  };
  const opts = (over: Partial<Parameters<typeof chooseClient>[2]> = {}) => ({
    preRegistered: [],
    stored: [],
    urls: httpsUrls,
    clientName: "OCW",
    ...over,
  });

  it("uses a pre-registered client for this exact issuer first", async () => {
    const stub = stubEgress();
    const choice = await chooseClient(
      stub.egress,
      discovered(),
      opts({ preRegistered: [{ issuer: AS, clientId: "pre", clientSecret: "pre-secret" }] }),
    );
    expect(choice).toEqual({
      method: "pre_registered",
      issuer: AS,
      clientId: "pre",
      clientSecret: "pre-secret",
    });
    expect(stub.calls).toHaveLength(0);
  });

  it("ignores a pre-registered client of another issuer and picks CIMD when both sides support it", async () => {
    const stub = stubEgress();
    const choice = await chooseClient(
      stub.egress,
      discovered(),
      opts({ preRegistered: [{ issuer: "https://other.test", clientId: "pre" }] }),
    );
    expect(choice).toEqual({ method: "cimd", issuer: AS, clientId: httpsUrls.clientMetadataUrl });
  });

  it("skips CIMD when the admin turned it off for the server, and registers instead (WINDOWS #179)", async () => {
    const stub = stubEgress();
    register(stub);
    const choice = await chooseClient(stub.egress, discovered(), opts({ allowCimd: false }));
    expect(choice).toMatchObject({ method: "dcr", issuer: AS, clientId: "dcr_1", isNew: true });
    // A pre-registered client still wins over both.
    const pre = await chooseClient(
      stub.egress,
      discovered(),
      opts({ allowCimd: false, preRegistered: [{ issuer: AS, clientId: "pre" }] }),
    );
    expect(pre).toMatchObject({ method: "pre_registered", clientId: "pre" });
  });

  it("registers a web client (DCR) when the instance has no CIMD URL", async () => {
    const stub = stubEgress();
    register(stub);
    const choice = await chooseClient(stub.egress, discovered(), opts({ urls: loopbackUrls }));
    expect(choice).toEqual({
      method: "dcr",
      issuer: AS,
      clientId: "dcr_1",
      clientSecret: "dcrs_secret_1",
      isNew: true,
    });
    const sent = JSON.parse(stub.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent).toMatchObject({
      application_type: "web",
      redirect_uris: [loopbackUrls.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      client_name: "OCW",
    });
    expect(stub.calls[0]?.policy?.privateAllow).toEqual(["mcp.test:443"]);
  });

  it("registers (DCR) when the server does not advertise CIMD", async () => {
    const stub = stubEgress();
    register(stub);
    const choice = await chooseClient(
      stub.egress,
      discovered({}, { client_id_metadata_document_supported: undefined }),
      opts(),
    );
    expect(choice).toMatchObject({ method: "dcr", isNew: true });
  });

  it("reuses a stored DCR client of the same issuer and never one of another issuer", async () => {
    const stub = stubEgress();
    register(stub);
    const same = await chooseClient(
      stub.egress,
      discovered(),
      opts({
        urls: loopbackUrls,
        stored: [{ issuer: AS, clientId: "kept", clientSecret: "kept-s", method: "dcr" }],
      }),
    );
    expect(same).toEqual({
      method: "dcr",
      issuer: AS,
      clientId: "kept",
      clientSecret: "kept-s",
      isNew: false,
    });
    expect(stub.calls).toHaveLength(0);

    const other = await chooseClient(
      stub.egress,
      discovered(),
      opts({
        urls: loopbackUrls,
        stored: [{ issuer: "https://other.test", clientId: "kept", clientSecret: "kept-s", method: "dcr" }],
      }),
    );
    expect(other).toMatchObject({ method: "dcr", clientId: "dcr_1", isNew: true });
  });

  it("answers needs_client without a pre-registered client, CIMD or a registration endpoint", async () => {
    const stub = stubEgress();
    const d = discovered(
      {},
      { registration_endpoint: undefined, client_id_metadata_document_supported: undefined },
    );
    expect((await codeOf(chooseClient(stub.egress, d, opts()))).code).toBe("needs_client");
    const noCimdUrl = discovered({}, { registration_endpoint: undefined });
    expect((await codeOf(chooseClient(stub.egress, noCimdUrl, opts({ urls: loopbackUrls })))).code).toBe(
      "needs_client",
    );
  });

  it("answers needs_client when registration is refused", async () => {
    const stub = stubEgress();
    stub.routes.set(`POST ${AS}/register`, { status: 400, json: { error: "invalid_client_metadata" } });
    const err = await codeOf(chooseClient(stub.egress, discovered(), opts({ urls: loopbackUrls })));
    expect(err.code).toBe("needs_client");
  });

  it("refuses an instance whose redirect URI cannot be used (https_required)", async () => {
    const stub = stubEgress();
    const lan = connectorOAuthUrls("http://ocw.lan:4290");
    expect((await codeOf(chooseClient(stub.egress, discovered(), opts({ urls: lan })))).code).toBe(
      "https_required",
    );
  });
});

describe("clientMetadataDocument", () => {
  it("is null without an https instance", () => {
    expect(clientMetadataDocument(loopbackUrls, "OCW")).toBeNull();
    expect(clientMetadataDocument(connectorOAuthUrls("http://ocw.lan"), "OCW")).toBeNull();
  });
  it("names its own URL as client_id and the callback as its only redirect", () => {
    expect(clientMetadataDocument(httpsUrls, "OCW")).toEqual({
      client_id: "https://ocw.example.test/api/v1/connectors/oauth/client-metadata.json",
      client_name: "OCW",
      client_uri: "https://ocw.example.test",
      redirect_uris: ["https://ocw.example.test/api/v1/connectors/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("token errors carry codes, never credentials", () => {
  const CANARY = {
    code: "canary_code_7f3a",
    verifier: "canary_verifier_91bd",
    secret: "canary_secret_44e0",
    access: "canary_access_c1d2",
    refresh: "canary_refresh_e5f6",
  };
  const leaks = (err: ConnectorOAuthError) => {
    const text = `${String(err)} ${err.message} ${err.stack ?? ""} ${String((err as { cause?: unknown }).cause ?? "")}`;
    return Object.values(CANARY).filter((c) => text.includes(c));
  };
  const client = {
    method: "pre_registered" as const,
    issuer: AS,
    clientId: "pre",
    clientSecret: CANARY.secret,
  };
  const bundle: TokenBundle = {
    accessToken: CANARY.access,
    refreshToken: CANARY.refresh,
    expiresAt: null,
    scopes: [],
    issuer: AS,
    clientId: "pre",
    resource: MCP,
    tokenEndpoint: `${AS}/token`,
    revocationEndpoint: `${AS}/revoke`,
    authMethod: "client_secret_basic",
    accountLabel: null,
  };

  it("an OAuth error whose description echoes the inputs becomes a bare code", async () => {
    const stub = stubEgress();
    stub.routes.set(`POST ${AS}/token`, {
      status: 400,
      json: { error: "invalid_grant", error_description: Object.values(CANARY).join(" ") },
    });
    const err = await codeOf(
      exchangeCode(stub.egress, discovered(), client, {
        code: CANARY.code,
        codeVerifier: CANARY.verifier,
        redirectUri: loopbackUrls.redirectUri,
      }),
    );
    expect(err).toMatchObject({ code: "token_exchange_failed", terminal: true, oauthError: "invalid_grant" });
    expect(leaks(err)).toEqual([]);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("a non-JSON 5xx body (which the SDK copies into its message) never reaches the error", async () => {
    const stub = stubEgress();
    stub.routes.set(`POST ${AS}/token`, {
      status: 502,
      text: `upstream said ${Object.values(CANARY).join(" ")}`,
    });
    const err = await codeOf(refreshTokens(stub.egress, bundle, CANARY.secret));
    expect(err).toMatchObject({ code: "token_exchange_failed", terminal: false });
    expect(leaks(err)).toEqual([]);
  });

  it("an unknown error code is a transient server_error whose text is dropped", async () => {
    const stub = stubEgress();
    stub.routes.set(`POST ${AS}/token`, { status: 400, json: { error: `bad ${CANARY.refresh}` } });
    const err = await codeOf(refreshTokens(stub.egress, bundle, CANARY.secret));
    expect(err).toMatchObject({ code: "token_exchange_failed", terminal: false, oauthError: "server_error" });
    expect(leaks(err)).toEqual([]);
  });

  it("refresh refuses a token endpoint that is neither https nor on the resource's origin", async () => {
    const stub = stubEgress();
    const err = await codeOf(
      refreshTokens(stub.egress, { ...bundle, tokenEndpoint: "http://other.test/token" }),
    );
    expect(err.code).toBe("token_exchange_failed");
    expect(stub.calls).toHaveLength(0);
  });

  it("refresh sends the resource and the refresh token under the server's policy", async () => {
    const stub = stubEgress();
    stub.routes.set(`POST ${AS}/token`, {
      json: {
        access_token: "new_access",
        token_type: "Bearer",
        expires_in: 60,
        refresh_token: "new_refresh",
      },
    });
    const next = await refreshTokens(stub.egress, bundle, CANARY.secret);
    expect(next).toMatchObject({ accessToken: "new_access", refreshToken: "new_refresh", issuer: AS });
    expect(next.expiresAt).toBeGreaterThan(Date.now());
    const form = new URLSearchParams(stub.calls[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("resource")).toBe(MCP);
    expect(stub.calls[0]?.policy?.privateAllow).toEqual(["mcp.test:443"]);
  });

  it("revokeToken never throws: no endpoint, an untrusted endpoint and a refused one are all false", async () => {
    const stub = stubEgress();
    expect(await revokeToken(stub.egress, { ...bundle, revocationEndpoint: null })).toBe(false);
    expect(
      await revokeToken(stub.egress, { ...bundle, revocationEndpoint: "http://other.test/revoke" }),
    ).toBe(false);
    expect(await revokeToken(stub.egress, { ...bundle, revocationEndpoint: "https://10.0.0.9/revoke" })).toBe(
      false,
    );
    stub.routes.set(`POST ${AS}/revoke`, { status: 200, text: "" });
    expect(await revokeToken(stub.egress, bundle, CANARY.secret)).toBe(true);
    const last = stub.calls.at(-1);
    const form = new URLSearchParams(last?.body);
    expect(form.get("token")).toBe(CANARY.refresh);
    expect(form.get("token_type_hint")).toBe("refresh_token");
  });
});

// ---------------------------------------------------------------- 07.14: failure steps, previewClient, client credentials

describe("failure steps (07.14 D-10): the step names the failure, the 07.4 code is unchanged", () => {
  const failure = async (promise: Promise<unknown>) => {
    const err = await codeOf(promise);
    return { code: err.code, step: err.step };
  };

  it("PRM missing, unparsable, another resource or no authorization server: discovery_failed", async () => {
    const missing = stubEgress();
    expect(await failure(discover(missing.egress, MCP))).toEqual({
      code: "discovery_failed",
      step: "discovery_failed",
    });
    for (const p of [
      { resource: 42 },
      prm({ resource: "https://other.test/mcp" }),
      prm({ authorization_servers: [] }),
    ]) {
      const stub = stubEgress();
      serve(stub, p as Record<string, unknown>);
      expect(await failure(discover(stub.egress, MCP))).toEqual({
        code: "discovery_failed",
        step: "discovery_failed",
      });
    }
  });

  it("a guard refusal on the MCP host is discovery_failed; on the authorization server it is untrusted", async () => {
    const prmRefused = stubEgress();
    prmRefused.routes.set(`GET ${PRM_URL}`, () => {
      throw new EgressRefusedError("private_address", "mcp.test");
    });
    expect(await failure(discover(prmRefused.egress, MCP))).toEqual({
      code: "egress_refused",
      step: "discovery_failed",
    });

    const asRefused = stubEgress();
    serve(asRefused, prm({ authorization_servers: ["https://10.0.0.5/as"] }));
    expect(await failure(discover(asRefused.egress, MCP))).toEqual({
      code: "egress_refused",
      step: "token_endpoint_untrusted",
    });
  });

  it("an untrusted authorization server URL or endpoint: token_endpoint_untrusted (code discovery_failed)", async () => {
    const asUrl = stubEgress();
    serve(asUrl, prm({ authorization_servers: ["http://other.test/as"] }));
    expect(await failure(discover(asUrl.egress, MCP))).toEqual({
      code: "discovery_failed",
      step: "token_endpoint_untrusted",
    });
    for (const field of [
      "token_endpoint",
      "authorization_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
    ]) {
      const stub = stubEgress();
      serve(stub, prm(), asMeta({ [field]: "http://other.test/x" }));
      expect(await failure(discover(stub.egress, MCP))).toEqual({
        code: "discovery_failed",
        step: "token_endpoint_untrusted",
      });
    }
  });

  it("a metadata issuer that is not its URL: issuer_mismatch (code discovery_failed)", async () => {
    const stub = stubEgress();
    serve(stub, prm(), asMeta({ issuer: "https://other.test" }));
    expect(await failure(discover(stub.egress, MCP))).toEqual({
      code: "discovery_failed",
      step: "issuer_mismatch",
    });
  });

  it("no S256: pkce_unsupported", async () => {
    const stub = stubEgress();
    serve(stub, prm(), asMeta({ code_challenge_methods_supported: undefined }));
    expect(await failure(discover(stub.egress, MCP))).toEqual({
      code: "pkce_unsupported",
      step: "pkce_unsupported",
    });
  });

  it("client choice: https_required, and no usable client is client_registration_unavailable (code needs_client)", async () => {
    const stub = stubEgress();
    const lan = connectorOAuthUrls("http://ocw.lan:4290");
    const base = { preRegistered: [], stored: [], clientName: "OCW" };
    expect(await failure(chooseClient(stub.egress, discovered(), { ...base, urls: lan }))).toEqual({
      code: "https_required",
      step: "https_required",
    });
    const noReg = discovered(
      {},
      { registration_endpoint: undefined, client_id_metadata_document_supported: undefined },
    );
    expect(await failure(chooseClient(stub.egress, noReg, { ...base, urls: httpsUrls }))).toEqual({
      code: "needs_client",
      step: "client_registration_unavailable",
    });
    stub.routes.set(`POST ${AS}/register`, { status: 400, json: { error: "invalid_client_metadata" } });
    expect(await failure(chooseClient(stub.egress, discovered(), { ...base, urls: loopbackUrls }))).toEqual({
      code: "needs_client",
      step: "client_registration_unavailable",
    });
  });

  it("the callback's iss and a client of another issuer: issuer_mismatch", async () => {
    const meta = asMeta() as unknown as AuthServerMetadata;
    expect(() => checkCallbackIssuer(meta, AS, "https://other.test")).toThrow(
      expect.objectContaining({ code: "issuer_mismatch", step: "issuer_mismatch" }),
    );
    const other = { method: "cimd" as const, issuer: "https://other.test", clientId: "x" };
    expect(await failure(buildAuthorization(discovered(), other, httpsUrls, undefined))).toEqual({
      code: "issuer_mismatch",
      step: "issuer_mismatch",
    });
  });

  it("token endpoint invalid_scope is scope_rejected but stays transient for members; other failures are token_exchange_failed", async () => {
    const client = { method: "pre_registered" as const, issuer: AS, clientId: "pre" };
    const exchange = (stub: Stub) =>
      exchangeCode(stub.egress, discovered(), client, {
        code: "c",
        codeVerifier: "v",
        redirectUri: loopbackUrls.redirectUri,
      });
    const scope = stubEgress();
    scope.routes.set(`POST ${AS}/token`, { status: 400, json: { error: "invalid_scope" } });
    expect(await codeOf(exchange(scope))).toMatchObject({
      code: "token_exchange_failed",
      step: "scope_rejected",
      terminal: false,
    });

    const grant = stubEgress();
    grant.routes.set(`POST ${AS}/token`, { status: 400, json: { error: "invalid_grant" } });
    expect(await codeOf(exchange(grant))).toMatchObject({
      code: "token_exchange_failed",
      step: "token_exchange_failed",
      terminal: true,
    });
  });

  it("an error without a step says null", () => {
    expect(new ConnectorOAuthError("not_connected").step).toBeNull();
  });
});

describe("previewClient (07.14 D-18): the client decision without a request", () => {
  const opts = (over: Partial<Parameters<typeof previewClient>[1]> = {}) => ({
    preRegistered: [],
    stored: [],
    urls: httpsUrls,
    ...over,
  });

  it("pre-registered for this exact issuer, else CIMD, else DCR (stored or not), else needs_client", () => {
    expect(
      previewClient(
        discovered(),
        opts({ preRegistered: [{ issuer: AS, clientId: "pre", clientSecret: "s" }] }),
      ),
    ).toMatchObject({ method: "pre_registered", clientId: "pre" });
    expect(
      previewClient(
        discovered(),
        opts({ preRegistered: [{ issuer: "https://other.test", clientId: "pre" }] }),
      ),
    ).toMatchObject({ method: "cimd", clientId: httpsUrls.clientMetadataUrl });
    expect(previewClient(discovered(), opts({ allowCimd: false }))).toMatchObject({ method: "dcr" });
    expect(previewClient(discovered(), opts({ urls: loopbackUrls }))).toMatchObject({ method: "dcr" });
    expect(
      previewClient(
        discovered(),
        opts({ urls: loopbackUrls, stored: [{ issuer: AS, clientId: "dcr_1", method: "dcr" }] }),
      ),
    ).toMatchObject({ method: "dcr" });
    const noReg = discovered(
      {},
      { registration_endpoint: undefined, client_id_metadata_document_supported: undefined },
    );
    expect(() => previewClient(noReg, opts())).toThrow(
      expect.objectContaining({ code: "needs_client", step: "client_registration_unavailable" }),
    );
    expect(() => previewClient(discovered(), opts({ urls: connectorOAuthUrls("http://ocw.lan") }))).toThrow(
      expect.objectContaining({ code: "https_required", step: "https_required" }),
    );
  });

  it("chooseClient decides through it and registers only for a new DCR client", async () => {
    const stub = stubEgress();
    const stored = await chooseClient(stub.egress, discovered(), {
      preRegistered: [],
      stored: [{ issuer: AS, clientId: "dcr_1", clientSecret: "s1", method: "dcr" }],
      urls: loopbackUrls,
      clientName: "OCW",
    });
    expect(stored).toEqual({
      method: "dcr",
      issuer: AS,
      clientId: "dcr_1",
      clientSecret: "s1",
      isNew: false,
    });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("clientCredentialsGrant (07.14 D-03)", () => {
  const input = (over: Partial<Parameters<typeof clientCredentialsGrant>[1]> = {}) => ({
    tokenEndpoint: `${AS}/token`,
    issuer: AS,
    resource: MCP,
    sameOrigin: "mcp.test:443",
    mcpOrigin: "https://mcp.test",
    clientId: "cc",
    clientSecret: "cc-secret",
    scopes: [],
    authMethods: [],
    ...over,
  });
  const tokenReply = (json: Record<string, unknown>) => ({
    json: { token_type: "Bearer", access_token: "at", ...json },
  });

  it("the terminal set is the member set plus invalid_scope", () => {
    expect([...CC_TERMINAL_OAUTH_ERRORS].sort()).toEqual(
      [
        "access_denied",
        "invalid_client",
        "invalid_grant",
        "invalid_scope",
        "refresh_token_reused",
        "unauthorized_client",
      ].sort(),
    );
  });

  it("without expires_in the token lasts CC_DEFAULT_TTL_S; empty scopes send no scope; resource is sent", async () => {
    const stub = stubEgress();
    stub.routes.set(`POST ${AS}/token`, tokenReply({}));
    const before = Date.now();
    const token = await clientCredentialsGrant(stub.egress, input());
    expect(CC_DEFAULT_TTL_S).toBe(300);
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(token.authMethod).toBe("client_secret_basic");
    const form = new URLSearchParams(stub.calls[0]?.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.has("scope")).toBe(false);
    expect(form.get("resource")).toBe(MCP);
    expect(form.has("client_secret")).toBe(false);
    expect(stub.calls[0]?.policy?.privateAllow).toEqual(["mcp.test:443"]);
  });

  it("scopes are sent space-separated; post when the metadata lists only client_secret_post", async () => {
    const stub = stubEgress();
    stub.routes.set(`POST ${AS}/token`, tokenReply({ expires_in: 60 }));
    const token = await clientCredentialsGrant(
      stub.egress,
      input({ scopes: ["records:read", "records:write"], authMethods: ["client_secret_post"] }),
    );
    expect(token.authMethod).toBe("client_secret_post");
    expect(token.scopes).toEqual(["records:read", "records:write"]);
    const form = new URLSearchParams(stub.calls[0]?.body);
    expect(form.get("scope")).toBe("records:read records:write");
    expect(form.get("client_secret")).toBe("cc-secret");
  });

  it("invalid_client, unauthorized_client and invalid_scope are terminal; invalid_scope is scope_rejected", async () => {
    for (const [error, step] of [
      ["invalid_client", "token_exchange_failed"],
      ["unauthorized_client", "token_exchange_failed"],
      ["invalid_scope", "scope_rejected"],
    ] as const) {
      const stub = stubEgress();
      stub.routes.set(`POST ${AS}/token`, {
        status: 400,
        json: { error, error_description: "cc-secret leaked" },
      });
      const err = await codeOf(clientCredentialsGrant(stub.egress, input()));
      expect(err).toMatchObject({ code: "token_exchange_failed", terminal: true, oauthError: error, step });
      expect(err.message).not.toContain("cc-secret");
    }
  });

  it("a non-Latin-1 secret is token_exchange_failed with no request sent", async () => {
    const stub = stubEgress();
    const err = await codeOf(clientCredentialsGrant(stub.egress, input({ clientSecret: "pässwörd-€" })));
    expect(err).toMatchObject({ code: "token_exchange_failed", step: "token_exchange_failed" });
    expect(stub.calls).toHaveLength(0);
  });

  it("an untrusted endpoint is refused before any request", async () => {
    const stub = stubEgress();
    for (const tokenEndpoint of ["http://other.test/token", "https://u:p@as.test/token", "not a url"]) {
      const err = await codeOf(clientCredentialsGrant(stub.egress, input({ tokenEndpoint })));
      expect(err.step).toBe("token_endpoint_untrusted");
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("a non-bearer answer is token_exchange_failed", async () => {
    const stub = stubEgress();
    stub.routes.set(`POST ${AS}/token`, { json: { token_type: "mac", access_token: "at" } });
    expect((await codeOf(clientCredentialsGrant(stub.egress, input()))).step).toBe("token_exchange_failed");
  });
});
