import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import {
  assertNoGlobalFetch,
  auditRows,
  authorize,
  type ConnectorsStack,
  callback,
  connectionRow,
  connectOrgOAuth,
  fails,
  fakeStats,
  type Json,
  join,
  ok,
  orgBundleOf,
  orgConnectionRow,
  registerConnector,
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

// ---------------------------------------------------------------- Task 2: binding, failures and the recorded step

describe("organization callback binding and failures", () => {
  const CONN_WEB = "http://localhost:3999/settings/connections";
  let srv: Json;
  let ada: TestClient;
  let adaId: string;

  const failedWith = (code: string, id = srv.id) => `${MCP_WEB}?error=${code}&connector=${id}`;
  async function started(as = s.victor, id = srv.id): Promise<string> {
    const start = await ok(as.request("POST", `/api/v1/connectors/${id}/org-connection/connect`));
    return authorize(s, start.authorizeUrl);
  }
  const orgRows = async (id = srv.id) =>
    (
      await s.su.query("select count(*)::int as n from app.connector_org_connections where server_id = $1", [
        id,
      ])
    ).rows[0].n as number;
  const dtoOf = async (id: string) => ok(s.victor.request("GET", `/api/v1/mcp-servers/${id}`));
  const setRole = (userId: string, role: string) =>
    s.su.query("update app.org_members set role = $1 where user_id = $2", [role, userId]);

  beforeAll(async () => {
    srv = await registerOrgConnector(s);
    [ada, adaId] = await join(s, "ada@example.test", "Ada Admin");
    await setRole(adaId, "admin");
    expect((await ok(ada.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
  });

  it("Sam's session on Víctor's flow → session_mismatch on MCP servers; nobody connected; the flow consumed; audited", async () => {
    const location = await started();
    expect(await callback(s, location, s.sam)).toEqual({
      status: 302,
      location: failedWith("session_mismatch"),
    });
    expect(await orgRows()).toBe(0);
    expect(await connectionRow(s, s.samId, srv.id)).toBeUndefined();
    // Single use: Víctor himself can no longer complete it (an unknown state names no flow: the member page).
    expect(await callback(s, location, s.victor)).toEqual({
      status: 302,
      location: `${CONN_WEB}?error=flow_expired`,
    });
    expect((await auditRows(s, s.orgA, ["connector.connect_failed"])).at(-1)).toMatchObject({
      metadata: { serverId: srv.id, code: "session_mismatch", principal: "organization" },
    });
    // Never recorded as the server's sign-in failure: it says nothing about the provider.
    expect((await dtoOf(srv.id)).authFailure).toBeNull();
  });

  it("another admin's session, an org B session or no session → session_mismatch", async () => {
    for (const as of [ada, s.eve, null]) {
      expect((await callback(s, await started(), as)).location).toBe(failedWith("session_mismatch"));
    }
    expect(await orgRows()).toBe(0);
  });

  it("the starting admin demoted between connect and callback → session_mismatch, nothing stored", async () => {
    const location = await started(ada);
    await setRole(adaId, "standard");
    try {
      expect((await callback(s, location, ada)).location).toBe(failedWith("session_mismatch"));
    } finally {
      await setRole(adaId, "admin");
    }
    expect(await orgRows()).toBe(0);
  });

  it("a replayed state → flow_expired; a server switched to organization headers or deleted first stores nothing", async () => {
    const location = await started();
    expect((await callback(s, location, s.victor)).location).toBe(`${MCP_WEB}?connected=${srv.id}`);
    expect((await callback(s, location, s.victor)).location).toBe(`${CONN_WEB}?error=flow_expired`);

    const switched = await registerOrgConnector(s);
    const pending = await started(s.victor, switched.id);
    await ok(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${switched.id}`, {
        authMode: "org_secret",
        clearConnections: true,
      }),
    );
    expect((await callback(s, pending, s.victor)).location).toBe(failedWith("flow_expired", switched.id));
    expect(await orgRows(switched.id)).toBe(0);

    const deleted = await registerOrgConnector(s);
    const gone = await started(s.victor, deleted.id);
    await ok(s.victor.request("DELETE", `/api/v1/mcp-servers/${deleted.id}`));
    expect((await callback(s, gone, s.victor)).location).toBe(failedWith("flow_expired", deleted.id));
    expect(await orgRows(deleted.id)).toBe(0);
    const secrets = await s.su.query(
      "select count(*)::int as n from app.secrets where kind = 'connector_credential' and provider = any($1)",
      [[switched.id, deleted.id]],
    );
    expect(secrets.rows[0].n).toBe(0);
  });

  it("two completed connects leave one row with the second token and the same sealed secret", async () => {
    const twice = await registerOrgConnector(s);
    expect((await connectOrgOAuth(s, s.victor, twice.id)).location).toBe(`${MCP_WEB}?connected=${twice.id}`);
    const first = await orgConnectionRow(s, s.orgA, twice.id);
    const firstToken = (await orgBundleOf(s, s.orgA, twice.id))?.accessToken;
    expect((await connectOrgOAuth(s, s.victor, twice.id)).location).toBe(`${MCP_WEB}?connected=${twice.id}`);
    expect(await orgRows(twice.id)).toBe(1);
    const second = await orgConnectionRow(s, s.orgA, twice.id);
    expect(second?.id).toBe(first?.id);
    expect(second?.secret_id).toBe(first?.secret_id);
    const secondToken = (await orgBundleOf(s, s.orgA, twice.id))?.accessToken;
    expect(secondToken).toMatch(/^fakeat_/u);
    expect(secondToken).not.toBe(firstToken);
  });

  it("error=invalid_scope → scope_rejected on the row; a denial → access_denied without changing it; members keep token_exchange_failed", async () => {
    const scoped = await registerOrgConnector(s);
    s.fake.setScenario({ invalid_scope_at_authorize: true });
    expect((await callback(s, await started(s.victor, scoped.id), s.victor)).location).toBe(
      failedWith("scope_rejected", scoped.id),
    );
    expect((await dtoOf(scoped.id)).authFailure).toBe("scope_rejected");

    s.fake.setScenario({ deny: true });
    const denied = await callback(s, await started(s.victor, scoped.id), s.victor);
    expect(denied.location).toBe(failedWith("access_denied", scoped.id));
    expect(denied.location).not.toContain("denied the request");
    expect((await dtoOf(scoped.id)).authFailure).toBe("scope_rejected");

    const member = await registerConnector(s);
    s.fake.setScenario({ invalid_scope_at_authorize: true });
    const start = await ok(s.victor.request("POST", `/api/v1/connectors/${member.id}/connect`));
    expect((await callback(s, await authorize(s, start.authorizeUrl), s.victor)).location).toBe(
      `${CONN_WEB}?error=token_exchange_failed&connector=${member.id}`,
    );
    expect((await dtoOf(member.id)).authFailure).toBeNull();
  });

  it("connect start failures answer the 07.4 409 and record the failing step; a successful connect clears it; members never write it", async () => {
    const pkce = await registerOrgConnector(s);
    s.fake.setScenario({ no_pkce_meta: true });
    await fails(
      s.victor.request("POST", `/api/v1/connectors/${pkce.id}/org-connection/connect`),
      409,
      "pkce_unsupported",
    );
    expect(await dtoOf(pkce.id)).toMatchObject({ authFailure: "pkce_unsupported", oauthStatus: "error" });

    const bare = await registerOrgConnector(s, { oauthClient: undefined });
    s.fake.setScenario({ no_registration: true });
    await fails(
      s.victor.request("POST", `/api/v1/connectors/${bare.id}/org-connection/connect`),
      409,
      "needs_client",
    );
    expect(await dtoOf(bare.id)).toMatchObject({
      authFailure: "client_registration_unavailable",
      oauthStatus: "needs_client",
    });

    s.fake.setScenario({});
    expect((await connectOrgOAuth(s, s.victor, pkce.id)).location).toBe(`${MCP_WEB}?connected=${pkce.id}`);
    expect(await dtoOf(pkce.id)).toMatchObject({ authFailure: null, oauthStatus: "ready" });

    const member = await registerConnector(s);
    s.fake.setScenario({ no_pkce_meta: true });
    await fails(s.victor.request("POST", `/api/v1/connectors/${member.id}/connect`), 409, "pkce_unsupported");
    expect(await dtoOf(member.id)).toMatchObject({ authFailure: null, oauthStatus: "error" });
  });

  it("without mcp.manage → 403; org B's admin with org A's id → 404; a member-mode id → 404; client credentials → 409", async () => {
    await fails(s.sam.request("POST", `/api/v1/connectors/${srv.id}/org-connection/connect`), 403);
    await fails(s.eve.request("POST", `/api/v1/connectors/${srv.id}/org-connection/connect`), 404);
    const member = await registerConnector(s);
    await fails(s.victor.request("POST", `/api/v1/connectors/${member.id}/org-connection/connect`), 404);
    const cc = await registerConnector(s, { authMode: "org_client_credentials", oauthClient: undefined });
    await fails(
      s.victor.request("POST", `/api/v1/connectors/${cc.id}/org-connection/connect`),
      409,
      "wrong_auth_mode",
    );
  });

  it("a flow record without principal (written before 07.14) completes as a member flow", async () => {
    const member = await registerConnector(s);
    const start = await ok(s.victor.request("POST", `/api/v1/connectors/${member.id}/connect`));
    const state = new URL(start.authorizeUrl).searchParams.get("state") ?? "";
    const redis = s.stack.built.core.bus.pub;
    const record = JSON.parse((await redis.get(`ocw:conn:oauth:${state}`)) ?? "{}") as Json;
    expect(record.principal).toBe("member");
    delete record.principal;
    await redis.set(`ocw:conn:oauth:${state}`, JSON.stringify(record), {
      expiration: { type: "EX", value: 600 },
    });
    expect((await callback(s, await authorize(s, start.authorizeUrl), s.victor)).location).toBe(
      `${CONN_WEB}?connected=${member.id}`,
    );
    expect(await connectionRow(s, s.victorId, member.id)).toMatchObject({ status: "connected" });
    expect(await orgRows(member.id)).toBe(0);
  });

  it("the account label has control characters stripped and at most 200 UTF-16 code units", async () => {
    const labelled = await registerOrgConnector(s);
    const raw = `ops\u0000\u001b[31m\u0085${"é".repeat(300)}`;
    s.fake.setScenario({ id_token_email: raw });
    expect((await connectOrgOAuth(s, s.victor, labelled.id)).status).toBe(302);
    const label = (await orgConnectionRow(s, s.orgA, labelled.id))?.account_label as string;
    expect(label).toBe(`ops[31m${"é".repeat(300)}`.slice(0, 200));
    expect(label).toHaveLength(200);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting that none are left
    expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it("GET /connectors (Settings › Connections) lists no organization-account server for any member", async () => {
    const cc = await registerConnector(s, { authMode: "org_client_credentials", oauthClient: undefined });
    for (const as of [s.victor, s.sam, ada]) {
      const list = (await ok(as.request("GET", "/api/v1/connectors"))).connectors as Json[];
      expect(list.map((c) => c.serverId)).not.toContain(srv.id);
      expect(list.map((c) => c.serverId)).not.toContain(cc.id);
      for (const c of list) expect(["per_member_oauth", "per_member_secret"]).toContain(c.authMode);
    }
  });
});
