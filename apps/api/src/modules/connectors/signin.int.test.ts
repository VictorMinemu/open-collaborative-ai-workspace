import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  authorize,
  type ConnectorsStack,
  callback,
  connectionRow,
  connectOAuth,
  fails,
  fakeStats,
  type Json,
  ok,
  registerConnector,
  startConnectorsStack,
} from "../../testing-connectors";
import { accessTokenFor } from "./index";

/**
 * A member connects their own account to a per-member OAuth connector over the real HTTP routes (07.4-10, D-01, D-02,
 * CONN-01): start → the fake's authorize → the API callback with the member's own session → a sealed connection → the
 * API-side probe fills the organization's tool catalog. Real PostgreSQL + Redis; the fake OAuth-protected MCP server
 * runs in-process and is reached only through the egress guard.
 */

let s: ConnectorsStack;
const WEB = "http://localhost:3999/settings/connections";

/** Runs with another public API URL (read per request by the connector routes); restored afterwards. */
async function withPublicApiUrl(url: string, fn: () => Promise<void>) {
  const env = s.stack.built.core.env as { OCW_PUBLIC_API_URL: string };
  const previous = env.OCW_PUBLIC_API_URL;
  env.OCW_PUBLIC_API_URL = url;
  try {
    await fn();
  } finally {
    env.OCW_PUBLIC_API_URL = previous;
  }
}

const rowOf = async (serverId: string): Promise<Json> =>
  (await ok(s.victor.request("GET", "/api/v1/connectors"))).connectors.find(
    (c: Json) => c.serverId === serverId,
  );

beforeAll(async () => {
  s = await startConnectorsStack();
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
});

afterAll(async () => {
  await s?.stop();
});

describe("tracer: a member connects through OAuth and the catalog learns the tools", () => {
  let server: Json;

  it("the admin registers a per-member connector; Víctor sees it not connected", async () => {
    server = await registerConnector(s);
    const list = await ok(s.victor.request("GET", "/api/v1/connectors"));
    expect(list.oauth).toMatchObject({ oauthAvailable: true });
    expect(list.connectors).toEqual([
      expect.objectContaining({
        serverId: server.id,
        authMode: "per_member_oauth",
        status: "not_connected",
        connectedAt: null,
        accountLabel: null,
        reconnectReason: null,
        oauthStatus: "ready",
      }),
    ]);
  });

  it("connect → authorize on the fake → callback with Víctor's session → 302 back to Connections", async () => {
    const start = await ok(s.victor.request("POST", `/api/v1/connectors/${server.id}/connect`));
    expect(Object.keys(start)).toEqual(["authorizeUrl"]);
    expect(new URL(start.authorizeUrl).origin).toBe(s.fakeBase);
    const location = await authorize(s, start.authorizeUrl);
    expect(location.startsWith("http://localhost:4999/api/v1/connectors/oauth/callback?")).toBe(true);
    const done = await callback(s, location, s.victor);
    expect(done).toEqual({ status: 302, location: `${WEB}?connected=${server.id}` });
  });

  it("GET /connectors shows the connection with its scopes and account; one sealed credential exists", async () => {
    const list = await ok(s.victor.request("GET", "/api/v1/connectors"));
    const row = list.connectors.find((c: Json) => c.serverId === server.id);
    expect(row).toMatchObject({ status: "connected", reconnectReason: null });
    expect(row.connectedAt).toEqual(expect.any(String));
    expect(row.scopes.length).toBeGreaterThan(0);
    expect(row.accountLabel).toMatch(/^sub_[A-Za-z0-9_-]+@fake-mcp\.test$/u);
    const secrets = await s.su.query(
      "select count(*)::int as n from app.secrets where organization_id = $1 and kind = 'connector_credential'",
      [s.orgA],
    );
    expect(secrets.rows[0].n).toBe(1);
    expect((await connectionRow(s, s.victorId, server.id))?.status).toBe("connected");
  });

  it("the API-side probe filled the tools with their input schemas and marked the server ready", async () => {
    const dto = await ok(s.victor.request("GET", `/api/v1/mcp-servers/${server.id}`));
    expect(dto.status).toBe("ready");
    expect(dto.tools.map((t: Json) => t.name).sort()).toEqual(["create_record", "echo_auth", "whoami"]);
    for (const t of dto.tools) expect(t.inputSchema).toMatchObject({ type: "object" });
  });

  it("audits connector.connected with ids only", async () => {
    const rows = await auditRows(s, s.orgA, ["connector.connected"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: s.victorId,
      metadata: { serverId: server.id, method: "oauth", issuer: `${s.fakeBase}/mcp-oauth` },
    });
  });

  it("accessTokenFor returns a Bearer the fake accepts", async () => {
    const t = await accessTokenFor(s.stack.built.core, {
      organizationId: s.orgA,
      userId: s.victorId,
      serverId: server.id,
    });
    if (!t.ok) throw new Error(`expected a token, got ${t.reason}`);
    expect(t.headerName).toBe("Authorization");
    expect(t.headerValue).toMatch(/^Bearer fakeat_/u);
    expect(t.secretParts).toContain(t.headerValue.slice("Bearer ".length));
    const hashes = (await fakeStats(s)).accessTokenHashes;
    const { createHash } = await import("node:crypto");
    expect(hashes).toContain(createHash("sha256").update(t.headerValue.slice(7)).digest("hex"));
  });

  it("a reconnect without an ID token keeps the connection and clears the account label (R1)", async () => {
    s.fake.setScenario({ no_id_token: true });
    expect(await connectOAuth(s, s.victor, server.id)).toEqual({
      status: 302,
      location: `${WEB}?connected=${server.id}`,
    });
    const list = await ok(s.victor.request("GET", "/api/v1/connectors"));
    expect(list.connectors.find((c: Json) => c.serverId === server.id)).toMatchObject({
      status: "connected",
      accountLabel: null,
    });
    // Still one credential: the reconnect re-sealed in place.
    const secrets = await s.su.query(
      "select count(*)::int as n from app.secrets where organization_id = $1 and kind = 'connector_credential'",
      [s.orgA],
    );
    expect(secrets.rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------- Task 3: the callback cannot be abused

describe("callback hardening", () => {
  let hard: Json;
  const seen: string[] = [];

  /** Starts Víctor's flow and plays the authorization server; returns the callback location. */
  async function started(as = s.victor, serverId = hard.id): Promise<string> {
    const start = await ok(as.request("POST", `/api/v1/connectors/${serverId}/connect`));
    const location = await authorize(s, start.authorizeUrl);
    const q = new URL(location).searchParams;
    for (const k of ["code", "state"]) {
      const v = q.get(k);
      if (v) seen.push(v);
    }
    return location;
  }
  const failedWith = (code: string, serverId = hard.id) => `${WEB}?error=${code}&connector=${serverId}`;
  const flowKeys = () => s.stack.built.core.bus.pub.keys("ocw:conn:oauth:*");

  beforeAll(async () => {
    hard = await registerConnector(s);
  });

  it("Sam's session on Víctor's flow → session_mismatch, nobody connected, the flow consumed, audited", async () => {
    const location = await started();
    expect(await callback(s, location, s.sam)).toEqual({
      status: 302,
      location: failedWith("session_mismatch"),
    });
    expect(await connectionRow(s, s.victorId, hard.id)).toBeUndefined();
    expect(await connectionRow(s, s.samId, hard.id)).toBeUndefined();
    // Single use: Víctor himself can no longer complete it.
    expect(await callback(s, location, s.victor)).toEqual({
      status: 302,
      location: `${WEB}?error=flow_expired`,
    });
    expect((await auditRows(s, s.orgA, ["connector.connect_failed"])).at(-1)).toMatchObject({
      metadata: { serverId: hard.id, code: "session_mismatch" },
    });
  });

  it("no session, or an org B session with org A's state → session_mismatch", async () => {
    expect(await callback(s, await started(), null)).toMatchObject({
      location: failedWith("session_mismatch"),
    });
    expect(await callback(s, await started(), s.eve)).toMatchObject({
      location: failedWith("session_mismatch"),
    });
    expect(await connectionRow(s, s.eveId, hard.id)).toBeUndefined();
  });

  it("a replayed state → flow_expired; an unknown or malformed state → flow_expired", async () => {
    const location = await started();
    expect(await callback(s, location, s.victor)).toEqual({
      status: 302,
      location: `${WEB}?connected=${hard.id}`,
    });
    expect(await callback(s, location, s.victor)).toEqual({
      status: 302,
      location: `${WEB}?error=flow_expired`,
    });
    const bogus = new URL(location);
    bogus.searchParams.set("state", "x".repeat(43));
    expect((await callback(s, bogus.href, s.victor)).location).toBe(`${WEB}?error=flow_expired`);
    bogus.searchParams.set("state", "../../etc");
    expect((await callback(s, bogus.href, s.victor)).location).toBe(`${WEB}?error=flow_expired`);
    expect(await flowKeys()).toEqual([]);
  });

  it("a wrong or missing iss → issuer_mismatch (the AS advertises RFC 9207)", async () => {
    s.fake.setScenario({ wrong_iss: true });
    expect((await callback(s, await started(), s.victor)).location).toBe(failedWith("issuer_mismatch"));
    s.fake.setScenario({ no_iss: true });
    expect((await callback(s, await started(), s.victor)).location).toBe(failedWith("issuer_mismatch"));
  });

  it("a denied consent → access_denied, never the provider's text", async () => {
    s.fake.setScenario({ deny: true });
    const location = await started();
    expect(new URL(location).searchParams.get("error_description")).toBeTruthy();
    const done = await callback(s, location, s.victor);
    expect(done.location).toBe(failedWith("access_denied"));
    expect(done.location).not.toContain("denied the request");
  });

  it("an AS without S256 → 409 pkce_unsupported, and the admin sees a sign-in error", async () => {
    s.fake.setScenario({ no_pkce_meta: true });
    await fails(s.victor.request("POST", `/api/v1/connectors/${hard.id}/connect`), 409, "pkce_unsupported");
    expect((await ok(s.victor.request("GET", `/api/v1/mcp-servers/${hard.id}`))).oauthStatus).toBe("error");
    // A later successful sign-in clears it.
    s.fake.setScenario({});
    expect((await callback(s, await started(), s.victor)).location).toBe(`${WEB}?connected=${hard.id}`);
    expect((await ok(s.victor.request("GET", `/api/v1/mcp-servers/${hard.id}`))).oauthStatus).toBe("ready");
  });

  it("a server without RFC 9728 metadata → 409 discovery_failed and a sign-in error for the admin (#179)", async () => {
    const plain = await registerConnector(s, { url: `${s.fakeBase}/plain/mcp`, oauthClient: undefined });
    await fails(s.victor.request("POST", `/api/v1/connectors/${plain.id}/connect`), 409, "discovery_failed");
    expect((await ok(s.victor.request("GET", `/api/v1/mcp-servers/${plain.id}`))).oauthStatus).toBe("error");
  });

  it("over plain http on a LAN name → 409 https_required, and the list says so", async () => {
    await withPublicApiUrl("http://ocw.lan", async () => {
      await fails(s.victor.request("POST", `/api/v1/connectors/${hard.id}/connect`), 409, "https_required");
      const list = await ok(s.victor.request("GET", "/api/v1/connectors"));
      expect(list.oauth.oauthAvailable).toBe(false);
      expect(list.connectors.find((c: Json) => c.serverId === hard.id).oauthStatus).toBe("https_required");
    });
  });

  it("no pre-registered client, no https, no registration endpoint → 409 needs_client, shown to the admin", async () => {
    const bare = await registerConnector(s, { oauthClient: undefined });
    s.fake.setScenario({ no_registration: true });
    await fails(s.victor.request("POST", `/api/v1/connectors/${bare.id}/connect`), 409, "needs_client");
    expect((await ok(s.victor.request("GET", `/api/v1/mcp-servers/${bare.id}`))).oauthStatus).toBe(
      "needs_client",
    );
    expect((await rowOf(bare.id)).oauthStatus).toBe("needs_client");
    // With registration back, OCW registers once per issuer and every member reuses that client.
    s.fake.setScenario({});
    const before = (await fakeStats(s)).registrations;
    expect((await callback(s, await started(s.victor, bare.id), s.victor)).location).toBe(
      `${WEB}?connected=${bare.id}`,
    );
    expect((await callback(s, await started(s.sam, bare.id), s.sam)).location).toBe(
      `${WEB}?connected=${bare.id}`,
    );
    expect((await fakeStats(s)).registrations).toBe(before + 1);
    const clients = await s.su.query(
      "select issuer, method, client_secret_id is not null as secret from app.connector_oauth_clients where server_id = $1",
      [bare.id],
    );
    expect(clients.rows).toEqual([{ issuer: `${s.fakeBase}/mcp-oauth`, method: "dcr", secret: true }]);
    expect((await ok(s.victor.request("GET", `/api/v1/mcp-servers/${bare.id}`))).oauthStatus).toBe("ready");
  });

  it("the CIMD document is served only over https, its client_id being its own URL", async () => {
    expect((await fetch(`${s.stack.baseUrl}/api/v1/connectors/oauth/client-metadata.json`)).status).toBe(404);
    await withPublicApiUrl("https://ocw.example.com", async () => {
      const res = await fetch(`${s.stack.baseUrl}/api/v1/connectors/oauth/client-metadata.json`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as Json;
      expect(doc.client_id).toBe("https://ocw.example.com/api/v1/connectors/oauth/client-metadata.json");
      expect(doc.redirect_uris).toEqual(["https://ocw.example.com/api/v1/connectors/oauth/callback"]);
      expect(doc.token_endpoint_auth_method).toBe("none");
    });
  });

  it("the admin's scopes are the ones requested (R11), plus offline_access when the AS lists it", async () => {
    const scoped = await registerConnector(s, { oauthScopes: ["records:read"] });
    const start = await ok(s.victor.request("POST", `/api/v1/connectors/${scoped.id}/connect`));
    expect(new URL(start.authorizeUrl).searchParams.get("scope")).toBe("records:read offline_access");
  });

  it("Re-probe (mcp.manage) uses the admin's own connection: 409 not_connected without one", async () => {
    const other = await registerConnector(s);
    await fails(s.victor.request("POST", `/api/v1/connectors/${other.id}/probe`), 409, "not_connected");
    await fails(s.sam.request("POST", `/api/v1/connectors/${other.id}/probe`), 403);
    expect((await connectOAuth(s, s.victor, other.id)).status).toBe(302);
    const dto = await ok(s.victor.request("POST", `/api/v1/connectors/${other.id}/probe`));
    expect(dto.tools.map((t: Json) => t.name).sort()).toEqual(["create_record", "echo_auth", "whoami"]);
  });

  it("no completed flow's key survives; an abandoned one expires within 10 minutes; no code or state was logged", async () => {
    const redis = s.stack.built.core.bus.pub;
    const states = seen.filter((v) => /^[A-Za-z0-9_-]{43}$/u.test(v));
    for (const state of states) expect(await redis.exists(`ocw:conn:oauth:${state}`)).toBe(0);
    // The R11 case started a flow and never came back: it lives on with its TTL only.
    const left = await flowKeys();
    expect(left).toHaveLength(1);
    const ttl = await redis.ttl(left[0] as string);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
    const logs = s.logs.join("\n");
    expect(seen.length).toBeGreaterThan(10);
    for (const v of seen) expect(logs).not.toContain(v);
    expect(logs).not.toMatch(/[?&](code|state)=/u);
  });
});
