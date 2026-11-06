import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  authorize,
  type ConnectorsStack,
  callback,
  fakeStats,
  type Json,
  ok,
  orgBundleOf,
  orgConnectionRow,
  registerOrgConnector,
  startConnectorsStack,
} from "../../testing-connectors";
import { accessTokenFor } from "./index";

/**
 * An admin connects the organization's own account to an `org_oauth` server over the real HTTP routes (07.14-07, D-02,
 * D-05, D-06; COA-01, COA-03): org-connection/connect → the fake's authorize → the one API callback with the admin's
 * session → the bundle sealed for the organization → the API-side probe with the organization's token. Real
 * PostgreSQL + Redis; the fake OAuth-protected MCP server runs in-process and is reached only through the egress guard.
 */

let s: ConnectorsStack;
const MCP_WEB = "http://localhost:3999/settings/mcp-servers";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

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

describe("tracer: an admin connects the organization's account", () => {
  let server: Json;

  it("Víctor registers an org_oauth server: pending, no organization connection yet", async () => {
    server = await registerOrgConnector(s);
    expect(server).toMatchObject({ authMode: "org_oauth", status: "pending", orgConnection: null });
  });

  it("connect → authorize (S256, resource) → callback with Víctor's session → 302 back to MCP servers", async () => {
    const start = await ok(
      s.victor.request("POST", `/api/v1/connectors/${server.id}/org-connection/connect`),
    );
    expect(Object.keys(start)).toEqual(["authorizeUrl"]);
    const url = new URL(start.authorizeUrl);
    expect(url.origin).toBe(s.fakeBase);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(`${s.fakeBase}/mcp-oauth/mcp`);
    const location = await authorize(s, start.authorizeUrl);
    expect(location.startsWith("http://localhost:4999/api/v1/connectors/oauth/callback?")).toBe(true);
    expect(await callback(s, location, s.victor)).toEqual({
      status: 302,
      location: `${MCP_WEB}?connected=${server.id}`,
    });
  });

  it("one organization row, connected by Víctor; its secret opens with the organization AAD only", async () => {
    const row = await orgConnectionRow(s, s.orgA, server.id);
    expect(row).toMatchObject({
      status: "connected",
      method: "oauth",
      connected_by: s.victorId,
      issuer: `${s.fakeBase}/mcp-oauth`,
      last_error: null,
    });
    expect(row?.scopes.length).toBeGreaterThan(0);
    expect(row?.account_label).toMatch(/^sub_[A-Za-z0-9_-]+@fake-mcp\.test$/u);
    const rows = await s.su.query(
      "select count(*)::int as n from app.connector_org_connections where server_id = $1",
      [server.id],
    );
    expect(rows.rows[0].n).toBe(1);
    expect((await orgBundleOf(s, s.orgA, server.id))?.accessToken).toMatch(/^fakeat_/u);
    // Nobody holds it as a member: no member row, and Víctor's member AAD does not open it.
    const member = await s.su.query("select 1 from app.connector_connections where server_id = $1", [
      server.id,
    ]);
    expect(member.rowCount).toBe(0);
    const { core } = s.stack.built;
    await expect(
      core.db.withTenant({ organizationId: s.orgA }, (tx) =>
        core.secrets.revealSealed(tx, row?.secret_id, `${s.orgA}:${s.victorId}:connector:${server.id}`),
      ),
    ).rejects.toThrow();
    const kind = await s.su.query("select kind from app.secrets where id = $1", [row?.secret_id]);
    expect(kind.rows[0].kind).toBe("connector_credential");
  });

  it("the probe listed the tools with the organization's token; the server is ready and shows who connected it", async () => {
    const dto = await ok(s.victor.request("GET", `/api/v1/mcp-servers/${server.id}`));
    expect(dto.status).toBe("ready");
    expect(dto.tools.map((t: Json) => t.name).sort()).toEqual(["create_record", "echo_auth", "whoami"]);
    expect(dto.orgConnection).toMatchObject({
      method: "oauth",
      status: "connected",
      connectedBy: { id: s.victorId, name: "Víctor Ruiz" },
      reconnectReason: null,
      hasSecret: true,
    });
    expect(dto.authFailure).toBeNull();
  });

  it("audits connector.org_connected with ids only; no token in any audit row", async () => {
    const rows = await auditRows(s, s.orgA, ["connector.org_connected"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: s.victorId,
      metadata: { serverId: server.id, method: "oauth", issuer: `${s.fakeBase}/mcp-oauth` },
    });
    const b = await orgBundleOf(s, s.orgA, server.id);
    const all = await s.su.query(
      "select metadata::text as m from app.audit_events where organization_id = $1",
      [s.orgA],
    );
    const text = all.rows.map((r) => r.m).join("\n");
    expect(text).not.toContain(b?.accessToken);
    if (b?.refreshToken) expect(text).not.toContain(b.refreshToken);
  });

  it("accessTokenFor with the organization key returns a Bearer the fake issued", async () => {
    const t = await accessTokenFor(s.stack.built.core, {
      organizationId: s.orgA,
      serverId: server.id,
      principal: "organization",
      actingUserId: null,
    });
    if (!t.ok) throw new Error(`expected a token, got ${t.reason}`);
    expect(t.headerName).toBe("Authorization");
    expect(t.headerValue).toMatch(/^Bearer fakeat_/u);
    expect((await fakeStats(s)).accessTokenHashes).toContain(sha(t.headerValue.slice(7)));
  });
});
