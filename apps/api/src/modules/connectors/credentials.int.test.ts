import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  bundleOf,
  type ConnectorsStack,
  connectionRow,
  connectOAuth,
  fails,
  fakeStats,
  type Json,
  ok,
  PRE_REGISTERED,
  registerConnector,
  startConnectorsStack,
} from "../../testing-connectors";
import {
  accessTokenFor,
  ConnectorTokenUnavailableError,
  connectionAad,
  forceRefresh,
  markNeedsReconnect,
} from "./index";

/**
 * Custody of a member's connector credential (07.4-10 Task 2; D-01, CONN-02, C-02): serialized refresh under races,
 * terminal vs transient failures, an issuer change, forced refresh, the secret mode, disconnect with revocation, and
 * isolation between members (API, owner-only RLS, WINDOWS #170) and organizations (WINDOWS #169).
 */

let s: ConnectorsStack;
let oauth: Json;
let keyServer: Json;
const KEY_CANARY = "MEMBER-KEY-CANARY";

const key = (userId: string, serverId: string, organizationId = s.orgA) => ({
  organizationId,
  userId,
  serverId,
});
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const refreshes = async () => (await fakeStats(s)).tokenRequests.refresh_token;
const listOf = async (c = s.victor) =>
  (await ok(c.request("GET", "/api/v1/connectors"))).connectors as Json[];
const rowFor = async (serverId: string, c = s.victor) =>
  (await listOf(c)).find((r) => r.serverId === serverId);

/** Rewrites Víctor's sealed bundle (test-only), e.g. to drop the refresh token or age the access token. */
async function rewriteBundle(userId: string, serverId: string, change: (b: Json) => Json) {
  const { core } = s.stack.built;
  const row = await connectionRow(s, userId, serverId);
  const b = await bundleOf(s, s.orgA, userId, serverId);
  if (!row || !b) throw new Error("no bundle");
  await core.db.withTenant({ organizationId: s.orgA }, (tx) =>
    core.secrets.replaceSealed(
      tx,
      row.secret_id,
      JSON.stringify(change(b)),
      connectionAad(s.orgA, userId, serverId),
    ),
  );
}

/** Presents a stored refresh token at the main issuer's token endpoint (out of band): 200 while its grant lives. */
async function refreshStatus(b: Json | null): Promise<number> {
  const res = await s.browser.fetch(
    `${s.fakeBase}/mcp-oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: b?.refreshToken,
        client_id: b?.clientId,
        resource: b?.resource,
      }),
    },
    { privateAllow: [`fake-mcp:${s.fakePort}`] },
  );
  await res.body?.cancel();
  return res.status;
}
const revocations = async () => (await fakeStats(s)).revocations;

async function reconnect(c = s.victor) {
  expect((await connectOAuth(s, c, oauth.id)).status).toBe(302);
}

beforeAll(async () => {
  s = await startConnectorsStack();
  oauth = await registerConnector(s);
  keyServer = await ok(
    s.victor.request("POST", "/api/v1/mcp-servers", {
      name: "ERP",
      transport: "streamable-http",
      url: `${s.fakeBase}/keyed/mcp`,
      authMode: "per_member_secret",
      memberHeaderName: "X-Api-Key",
    }),
  );
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
  s.setDown(false);
});

afterAll(async () => {
  await s?.stop();
});

describe("serialized refresh", () => {
  it("two racing callers on an expired token make exactly one refresh and get the same new token", async () => {
    s.fake.setScenario({ expires_in: 1 });
    await reconnect();
    s.fake.setScenario({});
    const before = await refreshes();
    const [a, b] = await Promise.all([
      accessTokenFor(s.stack.built.core, key(s.victorId, oauth.id)),
      accessTokenFor(s.stack.built.core, key(s.victorId, oauth.id)),
    ]);
    if (!a.ok || !b.ok) throw new Error("expected tokens");
    expect(a.headerValue).toBe(b.headerValue);
    expect(await refreshes()).toBe(before + 1);
    const c = await accessTokenFor(s.stack.built.core, key(s.victorId, oauth.id));
    expect(c).toMatchObject({ ok: true, headerValue: a.headerValue });
    expect(await refreshes()).toBe(before + 1);
    // The new token is the fake's, and the row's expiry moved forward.
    expect((await fakeStats(s)).accessTokenHashes).toContain(sha(a.headerValue.slice(7)));
    expect(Date.parse((await connectionRow(s, s.victorId, oauth.id))?.access_expires_at)).toBeGreaterThan(
      Date.now() + 3_000_000,
    );
  });

  it("forceRefresh after an upstream 401 refreshes once, shared by concurrent and immediate callers", async () => {
    // A fresh grant: the previous test's refresh is still inside the lock window (which would be reused).
    await reconnect();
    const before = await refreshes();
    const old = await accessTokenFor(s.stack.built.core, key(s.victorId, oauth.id));
    const [a, b] = await Promise.all([
      forceRefresh(s.stack.built.core, key(s.victorId, oauth.id)),
      forceRefresh(s.stack.built.core, key(s.victorId, oauth.id)),
    ]);
    if (!a.ok || !b.ok || !old.ok) throw new Error("expected tokens");
    expect(a.headerValue).toBe(b.headerValue);
    expect(a.headerValue).not.toBe(old.headerValue);
    expect(await refreshes()).toBe(before + 1);
    // Within the lock window a third forced refresh reuses the result.
    expect(await forceRefresh(s.stack.built.core, key(s.victorId, oauth.id))).toMatchObject({
      headerValue: a.headerValue,
    });
    expect(await refreshes()).toBe(before + 1);
  });
});

describe("terminal and transient failures", () => {
  it("a reused refresh token (rotated elsewhere) → needs_reconnect, audited, reason revoked, committed", async () => {
    await reconnect();
    const b = await bundleOf(s, s.orgA, s.victorId, oauth.id);
    // Someone spends the stored refresh token out of band: the API's next refresh presents a rotated one.
    const res = await s.browser.fetch(
      `${s.fakeBase}/mcp-oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: b?.refreshToken,
          client_id: PRE_REGISTERED,
          resource: b?.resource,
        }),
      },
      { privateAllow: [`fake-mcp:${s.fakePort}`] },
    );
    expect(res.status).toBe(200);
    await res.body?.cancel();
    const secretId = (await connectionRow(s, s.victorId, oauth.id))?.secret_id;
    const revoked = await revocations();
    expect(await forceRefresh(s.stack.built.core, key(s.victorId, oauth.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expect((await fakeStats(s)).refreshReuse).toBeGreaterThan(0);
    // WINDOWS #193: the refused grant's access token is revoked at its issuer before the credential is dropped.
    expect(await revocations()).toBe(revoked + 1);
    const row = await connectionRow(s, s.victorId, oauth.id);
    expect(row).toMatchObject({ status: "needs_reconnect", last_error: "invalid_grant", secret_id: null });
    expect((await s.su.query("select 1 from app.secrets where id = $1", [secretId])).rowCount).toBe(0);
    const audits = await auditRows(s, s.orgA, ["connector.needs_reconnect"]);
    expect(audits.at(-1)).toMatchObject({
      user_id: s.victorId,
      metadata: { serverId: oauth.id, code: "invalid_grant", revokeAtIssuer: true },
    });
    expect(await rowFor(oauth.id)).toMatchObject({
      status: "needs_reconnect",
      reconnectReason: "revoked",
      accountLabel: null,
      scopes: [],
    });
    expect(await accessTokenFor(s.stack.built.core, key(s.victorId, oauth.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
  });

  it("revoke_all at the provider → needs_reconnect (revoked); reconnecting restores the connection", async () => {
    await reconnect();
    expect(await rowFor(oauth.id)).toMatchObject({ status: "connected", reconnectReason: null });
    s.fake.setScenario({ revoke_all: true });
    expect(await forceRefresh(s.stack.built.core, key(s.victorId, oauth.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expect(await rowFor(oauth.id)).toMatchObject({ status: "needs_reconnect", reconnectReason: "revoked" });
  });

  it("an expired access token without a refresh token → needs_reconnect (expired)", async () => {
    await reconnect();
    await rewriteBundle(s.victorId, oauth.id, ({ refreshToken: _drop, ...b }) => ({
      ...b,
      expiresAt: Date.now() - 1000,
    }));
    const before = await refreshes();
    const revoked = await revocations();
    expect(await accessTokenFor(s.stack.built.core, key(s.victorId, oauth.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expect(await refreshes()).toBe(before);
    expect(await revocations()).toBe(revoked + 1);
    expect(await connectionRow(s, s.victorId, oauth.id)).toMatchObject({
      status: "needs_reconnect",
      last_error: "expired_no_refresh",
    });
    expect(await rowFor(oauth.id)).toMatchObject({ reconnectReason: "expired" });
  });

  it("a 5xx at the token endpoint is transient: the call fails, the connection stays connected, nothing audited", async () => {
    await reconnect();
    const audits = (await auditRows(s, s.orgA, ["connector.needs_reconnect"])).length;
    const revoked = await revocations();
    s.fake.setScenario({ fail_token_5xx: true });
    await expect(forceRefresh(s.stack.built.core, key(s.victorId, oauth.id))).rejects.toBeInstanceOf(
      ConnectorTokenUnavailableError,
    );
    expect(await revocations()).toBe(revoked);
    expect(await connectionRow(s, s.victorId, oauth.id)).toMatchObject({
      status: "connected",
      last_error: null,
    });
    expect(await auditRows(s, s.orgA, ["connector.needs_reconnect"])).toHaveLength(audits);
    s.fake.setScenario({});
    expect(await accessTokenFor(s.stack.built.core, key(s.victorId, oauth.id))).toMatchObject({ ok: true });
  });

  it("an issuer change → needs_reconnect (provider_changed), no token request to either issuer, the grant revoked at the OLD issuer (#193)", async () => {
    await reconnect();
    const b = await bundleOf(s, s.orgA, s.victorId, oauth.id);
    const before = (await fakeStats(s)).tokenRequests;
    const revoked = await revocations();
    s.fake.setScenario({ different_issuer: true });
    expect(await forceRefresh(s.stack.built.core, key(s.victorId, oauth.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expect((await fakeStats(s)).tokenRequests).toEqual(before);
    expect(await revocations()).toBe(revoked + 1);
    expect(await connectionRow(s, s.victorId, oauth.id)).toMatchObject({ last_error: "issuer_changed" });
    expect(await rowFor(oauth.id)).toMatchObject({ reconnectReason: "provider_changed" });
    // The old grant is dead at the issuer that granted it, not merely forgotten here.
    s.fake.setScenario({});
    expect(await refreshStatus(b)).toBe(400);
  });

  it("markNeedsReconnect (the proxy, after a refreshed token still got a 401) commits, maps to revoked and revokes the grant (#193)", async () => {
    await reconnect();
    const b = await bundleOf(s, s.orgA, s.victorId, oauth.id);
    const revoked = await revocations();
    await markNeedsReconnect(s.stack.built.core, {
      ...key(s.victorId, oauth.id),
      code: "upstream_unauthorized",
    });
    expect(await rowFor(oauth.id)).toMatchObject({ status: "needs_reconnect", reconnectReason: "revoked" });
    expect(await revocations()).toBe(revoked + 1);
    expect(await refreshStatus(b)).toBe(400);
    expect((await auditRows(s, s.orgA, ["connector.needs_reconnect"])).at(-1)).toMatchObject({
      metadata: { serverId: oauth.id, code: "upstream_unauthorized", revokeAtIssuer: true },
    });
  });
});

describe("the secret mode", () => {
  it("PUT /connectors/:id/secret stores the member's key once; it is never returned", async () => {
    const res = await s.victor.request("PUT", `/api/v1/connectors/${keyServer.id}/secret`, {
      value: KEY_CANARY,
    });
    const body = await ok(res);
    expect(body).toMatchObject({
      serverId: keyServer.id,
      authMode: "per_member_secret",
      status: "connected",
      accountLabel: null,
      secretHeaderName: "X-Api-Key",
      secretHeaderPrefix: null,
    });
    expect(JSON.stringify(body)).not.toContain(KEY_CANARY);
    expect(JSON.stringify(await listOf())).not.toContain(KEY_CANARY);
    expect(await accessTokenFor(s.stack.built.core, key(s.victorId, keyServer.id))).toEqual({
      ok: true,
      headerName: "X-Api-Key",
      headerValue: KEY_CANARY,
      secretParts: [KEY_CANARY],
    });
    // The probe of a server that refuses the key failed, but the connection stands.
    expect((await ok(s.victor.request("GET", `/api/v1/mcp-servers/${keyServer.id}`))).status).toBe("error");
    expect(await connectionRow(s, s.victorId, keyServer.id)).toMatchObject({ status: "connected" });
    const audits = await auditRows(s, s.orgA, ["connector.connected"]);
    expect(audits.at(-1)?.metadata).toEqual({ serverId: keyServer.id, method: "secret" });
    expect(s.logs.join("\n")).not.toContain(KEY_CANARY);
  });

  it("a key with a line break is refused; PUT on an OAuth connector is 409; connect on a key connector is 409", async () => {
    await fails(
      s.victor.request("PUT", `/api/v1/connectors/${keyServer.id}/secret`, { value: "a\r\nX-Evil: 1" }),
      400,
      "invalid_key",
    );
    await fails(
      s.victor.request("PUT", `/api/v1/connectors/${oauth.id}/secret`, { value: KEY_CANARY }),
      409,
      "wrong_auth_mode",
    );
    await fails(
      s.victor.request("POST", `/api/v1/connectors/${keyServer.id}/connect`),
      409,
      "wrong_auth_mode",
    );
  });
});

describe("disconnect", () => {
  it("revokes at the provider, deletes the secret and the row, audits connector.disconnected", async () => {
    await reconnect();
    const secretId = (await connectionRow(s, s.victorId, oauth.id))?.secret_id;
    const before = (await fakeStats(s)).revocations;
    const res = await s.victor.request("DELETE", `/api/v1/connectors/${oauth.id}/connection`);
    expect(res.status).toBe(204);
    expect((await fakeStats(s)).revocations).toBe(before + 1);
    expect(await connectionRow(s, s.victorId, oauth.id)).toBeUndefined();
    expect((await s.su.query("select 1 from app.secrets where id = $1", [secretId])).rowCount).toBe(0);
    const audits = await auditRows(s, s.orgA, ["connector.disconnected"]);
    expect(audits.at(-1)).toMatchObject({ metadata: { serverId: oauth.id, revoked: true } });
    expect(await rowFor(oauth.id)).toMatchObject({ status: "not_connected" });
    await fails(
      s.victor.request("DELETE", `/api/v1/connectors/${oauth.id}/connection`),
      404,
      "not_connected",
    );
  });

  it("with the provider down the connection is still deleted (revoked false)", async () => {
    await reconnect();
    s.setDown(true);
    expect((await s.victor.request("DELETE", `/api/v1/connectors/${oauth.id}/connection`)).status).toBe(204);
    expect(await connectionRow(s, s.victorId, oauth.id)).toBeUndefined();
    const audits = await auditRows(s, s.orgA, ["connector.disconnected"]);
    expect(audits.at(-1)).toMatchObject({ metadata: { serverId: oauth.id, revoked: false } });
  });

  it("a confidential client's secret is sent with the refresh and the revocation", async () => {
    const conf = await registerConnector(s, {
      oauthClient: {
        issuer: `${s.fakeBase}/mcp-oauth`,
        clientId: "ocw-test-confidential",
        clientSecret: "CONFIDENTIAL-CLIENT-SECRET-CANARY",
      },
    });
    expect((await connectOAuth(s, s.victor, conf.id)).status).toBe(302);
    const b = await bundleOf(s, s.orgA, s.victorId, conf.id);
    expect(b?.authMethod).toMatch(/^client_secret_(basic|post)$/u);
    const before = await fakeStats(s);
    // The fake refuses a refresh or a revocation without the client's secret (invalid_client).
    const forced = await forceRefresh(s.stack.built.core, key(s.victorId, conf.id));
    expect(forced).toMatchObject({ ok: true });
    expect((await fakeStats(s)).tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token + 1);
    expect((await s.victor.request("DELETE", `/api/v1/connectors/${conf.id}/connection`)).status).toBe(204);
    expect((await auditRows(s, s.orgA, ["connector.disconnected"])).at(-1)).toMatchObject({
      metadata: { serverId: conf.id, revoked: true },
    });
    expect(s.logs.join("\n")).not.toContain("CONFIDENTIAL-CLIENT-SECRET-CANARY");
  });

  it("a terminal failure whose confidential client is no longer known drops the credential and sends nothing (#193)", async () => {
    const conf = await registerConnector(s, {
      oauthClient: {
        issuer: `${s.fakeBase}/mcp-oauth`,
        clientId: "ocw-test-confidential",
        clientSecret: "CONFIDENTIAL-CLIENT-SECRET-CANARY",
      },
    });
    expect((await connectOAuth(s, s.victor, conf.id)).status).toBe(302);
    await s.su.query("delete from app.connector_oauth_clients where server_id = $1", [conf.id]);
    const revoked = await revocations();
    await markNeedsReconnect(s.stack.built.core, {
      ...key(s.victorId, conf.id),
      code: "upstream_unauthorized",
    });
    expect(await revocations()).toBe(revoked);
    expect(await connectionRow(s, s.victorId, conf.id)).toMatchObject({
      status: "needs_reconnect",
      secret_id: null,
    });
    expect((await auditRows(s, s.orgA, ["connector.needs_reconnect"])).at(-1)).toMatchObject({
      metadata: { serverId: conf.id, code: "upstream_unauthorized", revokeAtIssuer: false },
    });
  });
});

describe("member and tenant isolation", () => {
  it("Sam never gets or deletes Víctor's connection; a sealed bundle swapped onto Sam's row fails closed", async () => {
    await reconnect();
    await reconnect(s.sam);
    const victorRow = await connectionRow(s, s.victorId, oauth.id);
    const samRow = await connectionRow(s, s.samId, oauth.id);
    const v = await accessTokenFor(s.stack.built.core, key(s.victorId, oauth.id));
    const sam = await accessTokenFor(s.stack.built.core, key(s.samId, oauth.id));
    if (!v.ok || !sam.ok) throw new Error("expected tokens");
    expect(sam.headerValue).not.toBe(v.headerValue);

    // AAD: Víctor's secret on Sam's row does not open for Sam.
    await s.su.query("update app.connector_connections set secret_id = $1 where id = $2", [
      victorRow?.secret_id,
      samRow?.id,
    ]);
    expect(await accessTokenFor(s.stack.built.core, key(s.samId, oauth.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    // Víctor's credential was not destroyed by Sam's failed open.
    expect(
      (await s.su.query("select 1 from app.secrets where id = $1", [victorRow?.secret_id])).rowCount,
    ).toBe(1);
    await s.su.query("update app.connector_connections set secret_id = $1 where id = $2", [
      samRow?.secret_id,
      samRow?.id,
    ]);

    // Sam's DELETE only ever touches Sam's row.
    expect((await s.sam.request("DELETE", `/api/v1/connectors/${oauth.id}/connection`)).status).toBe(204);
    await fails(s.sam.request("DELETE", `/api/v1/connectors/${oauth.id}/connection`), 404, "not_connected");
    expect(await connectionRow(s, s.victorId, oauth.id)).toMatchObject({
      id: victorRow?.id,
      status: "connected",
    });
    expect(await rowFor(oauth.id, s.sam)).toMatchObject({ status: "not_connected" });
  });

  it("owner-only RLS (#170): as the app role an admin reads, changes and forges no other member's connection", async () => {
    await reconnect(s.sam);
    const samRow = await connectionRow(s, s.samId, oauth.id);
    const asUser = async <T>(userId: string | null, fn: () => Promise<T>) => {
      await s.appRole.query("begin");
      try {
        await s.appRole.query("select set_config('app.organization_id', $1, true)", [s.orgA]);
        await s.appRole.query("select set_config('app.user_id', $1, true)", [userId ?? ""]);
        return await fn();
      } finally {
        await s.appRole.query("rollback");
      }
    };
    await asUser(s.victorId, async () => {
      const rows = (await s.appRole.query("select user_id from app.connector_connections")).rows;
      expect(rows.every((r) => r.user_id === s.victorId)).toBe(true);
      expect(
        (await s.appRole.query("select * from app.connector_connections where id = $1", [samRow?.id]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await s.appRole.query(
            "update app.connector_connections set status = 'needs_reconnect' where id = $1",
            [samRow?.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await s.appRole.query("delete from app.connector_connections where id = $1", [samRow?.id])).rowCount,
      ).toBe(0);
    });
    await asUser(null, async () => {
      expect(
        (await s.appRole.query("select count(*)::int as n from app.connector_connections")).rows[0].n,
      ).toBe(0);
    });
    await expect(
      asUser(s.victorId, () =>
        s.appRole.query(
          "insert into app.connector_connections (organization_id, user_id, server_id, status) values ($1, $2, $3, 'connected')",
          [s.orgA, s.alexId, oauth.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/u);
    expect(await connectionRow(s, s.samId, oauth.id)).toMatchObject({ status: "connected" });
  });

  it("the admin count and the clearing still reach every member's connection (#170 / #186)", async () => {
    const svc = await registerConnector(s);
    await connectOAuth(s, s.victor, svc.id);
    await connectOAuth(s, s.sam, svc.id);
    await connectOAuth(s, s.alex, svc.id);
    expect((await ok(s.victor.request("GET", `/api/v1/mcp-servers/${svc.id}`))).memberConnections).toBe(3);
    const listed = (await ok(s.victor.request("GET", "/api/v1/mcp-servers"))).servers.find(
      (x: Json) => x.id === svc.id,
    );
    expect(listed.memberConnections).toBe(3);
    // Neither the count nor any admin route exposes a member's credential.
    const all = JSON.stringify(await ok(s.victor.request("GET", `/api/v1/mcp-servers/${svc.id}`)));
    for (const u of [s.samId, s.alexId]) {
      const b = await bundleOf(s, s.orgA, u, svc.id);
      expect(all).not.toContain(b?.accessToken);
      expect(all).not.toContain(b?.refreshToken);
    }
    const secrets = (
      await s.su.query("select secret_id from app.connector_connections where server_id = $1", [svc.id])
    ).rows.map((r) => r.secret_id);
    await fails(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, { authMode: "org_secret" }),
      409,
      "connections_exist",
    );
    await ok(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${svc.id}`, {
        authMode: "org_secret",
        clearConnections: true,
      }),
    );
    expect(
      (
        await s.su.query("select count(*)::int as n from app.connector_connections where server_id = $1", [
          svc.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await s.su.query("select count(*)::int as n from app.secrets where id = any($1)", [secrets])).rows[0]
        .n,
    ).toBe(0);
    expect((await auditRows(s, s.orgA, ["connector.connections_cleared"])).at(-1)).toMatchObject({
      metadata: { serverId: svc.id, count: 3, reason: "mode_changed" },
    });

    const del = await registerConnector(s);
    await connectOAuth(s, s.sam, del.id);
    await connectOAuth(s, s.alex, del.id);
    await fails(s.victor.request("DELETE", `/api/v1/mcp-servers/${del.id}`), 409, "connections_exist");
    await ok(s.victor.request("DELETE", `/api/v1/mcp-servers/${del.id}?clearConnections=true`));
    expect(
      (
        await s.su.query("select count(*)::int as n from app.connector_connections where server_id = $1", [
          del.id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it("org B: lists nothing of org A, and a row of org B pointing at org A's server is never read, refreshed or used (#169)", async () => {
    expect(await listOf(s.eve)).toEqual([]);
    const { core } = s.stack.built;
    const canary = "ORG-B-FORGED-TOKEN";
    const secretId = await core.db.withTenant({ organizationId: s.orgB, userId: s.eveId }, (tx) =>
      core.secrets.putSealed(tx, {
        name: "forged",
        kind: "connector_credential",
        value: JSON.stringify({ kind: "secret", value: canary }),
        aad: connectionAad(s.orgB, s.eveId, oauth.id),
      }),
    );
    await s.su.query(
      "insert into app.connector_connections (organization_id, user_id, server_id, status, secret_id) values ($1, $2, $3, 'connected', $4)",
      [s.orgB, s.eveId, oauth.id, secretId],
    );
    const eve = key(s.eveId, oauth.id, s.orgB);
    expect(await accessTokenFor(core, eve)).toEqual({ ok: false, reason: "not_connected" });
    expect(await forceRefresh(core, eve)).toEqual({ ok: false, reason: "not_connected" });
    expect(await listOf(s.eve)).toEqual([]);
    await fails(s.eve.request("DELETE", `/api/v1/connectors/${oauth.id}/connection`), 404);
    await fails(s.eve.request("POST", `/api/v1/connectors/${oauth.id}/connect`), 404);
    await fails(s.eve.request("PUT", `/api/v1/connectors/${oauth.id}/secret`, { value: "x" }), 404);
    await fails(s.eve.request("POST", `/api/v1/connectors/${oauth.id}/probe`), 404);
    // Org A never counts or lists it either.
    const a = await ok(s.victor.request("GET", `/api/v1/mcp-servers/${oauth.id}`));
    const counted = (
      await s.su.query(
        "select count(*)::int as n from app.connector_connections where server_id = $1 and organization_id = $2",
        [oauth.id, s.orgA],
      )
    ).rows[0].n;
    expect(a.memberConnections).toBe(counted);
    expect(JSON.stringify(await listOf())).not.toContain(canary);
    await s.su.query("delete from app.connector_connections where organization_id = $1", [s.orgB]);
  });

  it("a member denied connector.connect gets 403 on the connect routes, still lists and disconnects their own connections (#196)", async () => {
    await ok(s.alex.request("PUT", `/api/v1/connectors/${keyServer.id}/secret`, { value: "alex-key" }));
    const full = await ok(s.alex.request("GET", "/api/v1/connectors"));
    expect(full.canConnect).toBe(true);
    expect((full.connectors as Json[]).map((c) => c.serverId)).toEqual(
      expect.arrayContaining([oauth.id, keyServer.id]),
    );
    const rule = await ok(
      s.victor.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: s.alexId,
        permission: "connector.connect",
        effect: "deny",
      }),
    );
    try {
      // The withdrawal view: only the member's own connections, and the web offers Disconnect only.
      const own = await ok(s.alex.request("GET", "/api/v1/connectors"));
      expect(own.canConnect).toBe(false);
      expect((own.connectors as Json[]).map((c) => [c.serverId, c.status])).toEqual([
        [keyServer.id, "connected"],
      ]);
      await fails(s.alex.request("POST", `/api/v1/connectors/${oauth.id}/connect`), 403);
      await fails(s.alex.request("PUT", `/api/v1/connectors/${keyServer.id}/secret`, { value: "k" }), 403);
      // Withdrawing is always allowed: a denied member can still delete their own connection.
      await fails(
        s.alex.request("DELETE", `/api/v1/connectors/${oauth.id}/connection`),
        404,
        "not_connected",
      );
      expect((await s.alex.request("DELETE", `/api/v1/connectors/${keyServer.id}/connection`)).status).toBe(
        204,
      );
      expect((await ok(s.alex.request("GET", "/api/v1/connectors"))).connectors).toEqual([]);
    } finally {
      await ok(s.victor.request("DELETE", `/api/v1/permission-rules/${rule.id}`));
    }
  });
});
