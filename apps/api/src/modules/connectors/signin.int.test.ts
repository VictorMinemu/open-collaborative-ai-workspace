import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  authorize,
  type ConnectorsStack,
  callback,
  connectionRow,
  connectOAuth,
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
