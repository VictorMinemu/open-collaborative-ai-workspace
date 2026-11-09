import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { egressFor } from "../../lib/egress";
import {
  assertNoGlobalFetch,
  auditRows,
  CC_SECRET,
  type ConnectorsStack,
  fails,
  fakeStats,
  type Json,
  ok,
  orgBundleOf,
  orgConnectionRow,
  PRE_REGISTERED,
  PRE_REGISTERED_CC,
  registerCcConnector,
  resetConnectorRateLimits,
  saveCc,
  startConnectorsStack,
} from "../../testing-connectors";
import {
  accessTokenFor,
  ConnectorTokenUnavailableError,
  forceRefresh,
  markNeedsReconnect,
  orgConnectionAad,
} from "./index";
import { callTool } from "./mcp-client";

/**
 * Client credentials for an organization connector over the real HTTP routes (07.14-09, D-03, D-05, D-06; COA-02): an
 * admin saves a client id and secret, the API discovers the token endpoint, gets a token from the fake, seals one
 * `client_credentials` bundle for the organization and probes the tools with it; afterwards it keeps the token fresh by
 * itself. Real PostgreSQL + Redis; the fake runs in-process and is reached only through the egress guard.
 */

let s: ConnectorsStack;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const ccRequests = async () => (await fakeStats(s)).tokenRequests.client_credentials;
const orgKey = (serverId: string, organizationId = s.orgA, actingUserId: string | null = s.victorId) => ({
  organizationId,
  serverId,
  principal: "organization" as const,
  actingUserId,
});

beforeAll(async () => {
  s = await startConnectorsStack();
}, 240_000);

afterEach(async () => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
  s.setDown(false);
  // The save is limited per admin (WR-01); this file saves more often than that within a minute.
  await resetConnectorRateLimits(s);
});

afterAll(async () => {
  await s?.stop();
});

describe("tracer: an admin saves client credentials", () => {
  let server: Json;
  let saved: Json;
  let ccBefore: number;

  it("Víctor registers an org_client_credentials server with no scopes: pending, no connection", async () => {
    server = await registerCcConnector(s);
    expect(server).toMatchObject({
      authMode: "org_client_credentials",
      status: "pending",
      orgConnection: null,
      authFailure: null,
    });
  });

  it("PUT client-credentials (Token URL empty) → 200: ready, tools listed, the connection shown without its secret", async () => {
    ccBefore = await ccRequests();
    saved = await ok(saveCc(s, s.victor, server.id));
    expect(saved).toMatchObject({
      id: server.id,
      status: "ready",
      authFailure: null,
      orgConnection: {
        method: "client_credentials",
        status: "connected",
        clientId: PRE_REGISTERED_CC,
        tokenEndpoint: `${s.fakeBase}/mcp-oauth/token`,
        hasSecret: true,
        connectedBy: { id: s.victorId, name: "Víctor Ruiz" },
        reconnectReason: null,
      },
    });
    expect(saved.tools.map((t: Json) => t.name).sort()).toEqual(["create_record", "echo_auth", "whoami"]);
  });

  it("the fake saw one client-credentials grant with resource and Basic; no scope was asked for", async () => {
    const st = await fakeStats(s);
    expect(st.tokenRequests.client_credentials).toBe(ccBefore + 1);
    expect(st.lastResource.cc).toBe(`${s.fakeBase}/mcp-oauth/mcp`);
    expect(st.lastClientAuth).toBe("basic");
    // The fake's default scope: nothing was requested.
    expect((await orgConnectionRow(s, s.orgA, server.id))?.scopes).toEqual(["records:read"]);
  });

  it("one organization row (client_credentials, connected_by Víctor) whose sealed bundle holds the secret and token", async () => {
    const row = await orgConnectionRow(s, s.orgA, server.id);
    expect(row).toMatchObject({
      method: "client_credentials",
      status: "connected",
      client_id: PRE_REGISTERED_CC,
      token_endpoint: `${s.fakeBase}/mcp-oauth/token`,
      issuer: `${s.fakeBase}/mcp-oauth`,
      connected_by: s.victorId,
      last_error: null,
    });
    expect(Date.parse(row?.access_expires_at)).toBeGreaterThan(Date.now() + 3_000_000);
    const b = await orgBundleOf(s, s.orgA, server.id);
    expect(b).toMatchObject({
      kind: "client_credentials",
      clientId: PRE_REGISTERED_CC,
      clientSecret: CC_SECRET,
      tokenEndpoint: `${s.fakeBase}/mcp-oauth/token`,
      issuer: `${s.fakeBase}/mcp-oauth`,
      resource: `${s.fakeBase}/mcp-oauth/mcp`,
      revocationEndpoint: `${s.fakeBase}/mcp-oauth/revoke`,
      authMethod: "client_secret_basic",
      scopes: [],
    });
    expect(b?.accessToken).toMatch(/^fakeat_/u);
    expect((await fakeStats(s)).accessTokenHashes).toContain(sha(b?.accessToken));
  });

  it("neither the secret nor the token appears in the response, the audit rows or the API logs", async () => {
    const b = await orgBundleOf(s, s.orgA, server.id);
    const token = b?.accessToken as string;
    const audits = await auditRows(s, s.orgA, [
      "connector.org_connected",
      "mcp.server.probed",
      "mcp.server.created",
    ]);
    const connected = audits.filter((a) => a.action === "connector.org_connected").at(-1);
    expect(connected).toMatchObject({
      user_id: s.victorId,
      metadata: { serverId: server.id, method: "client_credentials", issuer: `${s.fakeBase}/mcp-oauth` },
    });
    for (const text of [JSON.stringify(saved), JSON.stringify(audits), s.logs.join("\n")]) {
      expect(text).not.toContain(CC_SECRET);
      expect(text).not.toContain(token);
    }
  });

  it("accessTokenFor → the organization's bearer, which the fake's whoami accepts as sub_cc_ocw-test-cc", async () => {
    const { core } = s.stack.built;
    const t = await accessTokenFor(core, orgKey(server.id));
    if (!t.ok) throw new Error(`expected a token, got ${t.reason}`);
    expect(t.headerName).toBe("Authorization");
    expect(t.headerValue).toMatch(/^Bearer fakeat_/u);
    // The secret is redacted from whatever comes back too.
    expect(t.secretParts).toEqual(expect.arrayContaining([t.headerValue.slice(7), t.headerValue, CC_SECRET]));
    const out = await callTool(
      egressFor(core.env),
      { url: `${s.fakeBase}/mcp-oauth/mcp`, transport: "streamable-http" },
      { headerName: t.headerName, headerValue: t.headerValue },
      { name: "whoami", arguments: {} },
      { redact: t.secretParts },
    );
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.content)).toMatchObject({ subject: "sub_cc_ocw-test-cc" });
  });
});

// ---------------------------------------------------------------- Task 2: the API keeps the token fresh by itself

/** A new org_client_credentials server, saved with the fake's client (under `scenario` when given). */
async function savedServer(opts: { extra?: Json; body?: Json; scenario?: Json } = {}): Promise<Json> {
  const server = await registerCcConnector(s, opts.extra ?? {});
  if (opts.scenario) s.fake.setScenario(opts.scenario);
  await ok(saveCc(s, s.victor, server.id, opts.body));
  return server;
}
const tokenOf = async (serverId: string, actingUserId: string | null = s.victorId) => {
  const t = await accessTokenFor(s.stack.built.core, orgKey(serverId, s.orgA, actingUserId));
  if (!t.ok) throw new Error(`expected a token, got ${t.reason}`);
  return t.headerValue.slice("Bearer ".length);
};
const dtoOf = (serverId: string) => ok(s.victor.request("GET", `/api/v1/mcp-servers/${serverId}`));
const revocations = async () => (await fakeStats(s)).revocations;

/** Rewrites the organization's sealed bundle (test-only), e.g. a secret the provider has since rotated. */
async function rewriteOrgBundle(serverId: string, change: (b: Json) => Json) {
  const { core } = s.stack.built;
  const row = await orgConnectionRow(s, s.orgA, serverId);
  const b = await orgBundleOf(s, s.orgA, serverId);
  if (!row || !b) throw new Error("no organization bundle");
  await core.db.withTenant({ organizationId: s.orgA }, (tx) =>
    core.secrets.replaceSealed(
      tx,
      row.secret_id,
      JSON.stringify(change(b)),
      orgConnectionAad(s.orgA, serverId),
    ),
  );
}

/** Moves the organization's token `ms` into its life (its issue and expiry instants shift back by `ms`). */
const ageOrgToken = (serverId: string, ms: number) =>
  rewriteOrgBundle(serverId, (b) => ({
    ...b,
    expiresAt: b.expiresAt - ms,
    ...(b.issuedAt !== undefined ? { issuedAt: b.issuedAt - ms } : {}),
  }));

describe("re-grant before expiry, serialized (D-03, D-07; COA-02 concurrency, COA-03 adjacency)", () => {
  it("a token expiring within the 60 s window is re-granted on next use; one expiring in an hour is not", async () => {
    const short = await savedServer({ scenario: { expires_in: 120 } });
    s.fake.setScenario({});
    // Two minutes long, 70 s in: 50 s left, inside the 60 s window.
    await ageOrgToken(short.id, 70_000);
    const old = (await orgBundleOf(s, s.orgA, short.id))?.accessToken;
    const before = await ccRequests();
    const renewed = await tokenOf(short.id);
    expect(renewed).not.toBe(old);
    expect(await ccRequests()).toBe(before + 1);
    expect((await orgBundleOf(s, s.orgA, short.id))?.accessToken).toBe(renewed);
    expect(Date.parse((await orgConnectionRow(s, s.orgA, short.id))?.access_expires_at)).toBeGreaterThan(
      Date.now() + 3_000_000,
    );

    const long = await savedServer();
    const kept = (await orgBundleOf(s, s.orgA, long.id))?.accessToken;
    const mid = await ccRequests();
    expect(await tokenOf(long.id)).toBe(kept);
    expect(await ccRequests()).toBe(mid);
  });

  it("a token response without expires_in lasts 300 s", async () => {
    const server = await registerCcConnector(s);
    s.fake.setScenario({ omit_expires_in: true });
    const t0 = Date.now();
    await ok(saveCc(s, s.victor, server.id));
    const t1 = Date.now();
    const expires = Date.parse((await orgConnectionRow(s, s.orgA, server.id))?.access_expires_at);
    expect(expires).toBeGreaterThanOrEqual(t0 + 300_000 - 1_000);
    expect(expires).toBeLessThanOrEqual(t1 + 300_000 + 1_000);
    // The row keeps whole seconds; the sealed bundle the exact instant.
    expect(Math.abs((await orgBundleOf(s, s.orgA, server.id))?.expiresAt - expires)).toBeLessThan(1_000);
  });

  it("WR-04: a 30 s token is reused for the first half of its life, by every caller, with no new grant", async () => {
    const server = await savedServer({ scenario: { expires_in: 30 } });
    s.fake.setScenario({});
    const saved = (await orgBundleOf(s, s.orgA, server.id))?.accessToken;
    const before = await ccRequests();
    const tokens = await Promise.all(
      [s.victorId, s.samId, null, s.victorId, s.samId].map((u) => tokenOf(server.id, u)),
    );
    expect(new Set(tokens)).toEqual(new Set([saved]));
    expect(await tokenOf(server.id)).toBe(saved);
    expect(await ccRequests()).toBe(before);
  });

  it("three racing callers on an expiring token cause exactly one token request and get the same new token", async () => {
    const server = await savedServer({ scenario: { expires_in: 30 } });
    // 20 s into its 30 s life: past the half-life window (15 s), so it is re-granted.
    await ageOrgToken(server.id, 20_000);
    s.fake.setScenario({});
    const before = await ccRequests();
    const tokens = await Promise.all([
      tokenOf(server.id, s.victorId),
      tokenOf(server.id, s.samId),
      tokenOf(server.id, null),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(await ccRequests()).toBe(before + 1);
    expect((await fakeStats(s)).accessTokenHashes).toContain(sha(tokens[0] as string));
  });

  it("forceRefresh after a 401 makes one new grant, shared by concurrent callers", async () => {
    const server = await savedServer();
    const old = await tokenOf(server.id);
    const before = await ccRequests();
    const { core } = s.stack.built;
    const [a, b] = await Promise.all([
      forceRefresh(core, orgKey(server.id)),
      forceRefresh(core, orgKey(server.id, s.orgA, s.samId)),
    ]);
    if (!a.ok || !b.ok) throw new Error("expected tokens");
    expect(a.headerValue).toBe(b.headerValue);
    expect(a.headerValue).not.toBe(`Bearer ${old}`);
    expect(await ccRequests()).toBe(before + 1);
  });

  it("a 5xx at the token endpoint is transient: nothing is cleared, nothing audited", async () => {
    const server = await savedServer();
    const audits = (await auditRows(s, s.orgA, ["connector.org_needs_reconnect"])).length;
    s.fake.setScenario({ fail_token_5xx: true });
    await expect(forceRefresh(s.stack.built.core, orgKey(server.id))).rejects.toBeInstanceOf(
      ConnectorTokenUnavailableError,
    );
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({
      status: "connected",
      last_error: null,
    });
    expect((await auditRows(s, s.orgA, ["connector.org_needs_reconnect"])).length).toBe(audits);
  });
});

describe("terminal re-grants and the issuer pin (D-03, D-07, D-08)", () => {
  it("invalid_client (the secret rotated at the provider) → needs_reconnect, audited, nothing revoked", async () => {
    const server = await savedServer();
    await rewriteOrgBundle(server.id, (b) => ({ ...b, clientSecret: "ROTATED-AT-THE-PROVIDER" }));
    const revoked = await revocations();
    expect(await forceRefresh(s.stack.built.core, orgKey(server.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    const row = await orgConnectionRow(s, s.orgA, server.id);
    expect(row).toMatchObject({ status: "needs_reconnect", last_error: "invalid_client" });
    // WR-03: the sealed client secret stays (an admin can retry with Update credentials); only the token goes.
    expect(row?.secret_id).not.toBeNull();
    const kept = await orgBundleOf(s, s.orgA, server.id);
    expect(kept).toMatchObject({ kind: "client_credentials", clientSecret: "ROTATED-AT-THE-PROVIDER" });
    expect(kept?.accessToken).toBeUndefined();
    expect(await revocations()).toBe(revoked);
    expect((await auditRows(s, s.orgA, ["connector.org_needs_reconnect"])).at(-1)).toMatchObject({
      user_id: s.victorId,
      metadata: { serverId: server.id, code: "invalid_client", revokeAtIssuer: false },
    });
    expect((await dtoOf(server.id)).orgConnection).toMatchObject({
      status: "needs_reconnect",
      reconnectReason: "revoked",
      hasSecret: true,
    });
    // Nothing is sent while it needs reconnecting.
    const before = await ccRequests();
    expect(await accessTokenFor(s.stack.built.core, orgKey(server.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expect(await ccRequests()).toBe(before);
  });

  it("invalid_scope (the server's scopes changed to an unknown one) → needs_reconnect; fixed, a save without the secret recovers", async () => {
    const server = await savedServer();
    await ok(s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { oauthScopes: ["unknown"] }));
    expect(await forceRefresh(s.stack.built.core, orgKey(server.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({
      status: "needs_reconnect",
      last_error: "invalid_scope",
    });
    // WR-03: the admin fixes the scopes and retries with the stored secret (never typed again).
    await ok(s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { oauthScopes: [] }));
    const saved = await ok(saveCc(s, s.victor, server.id, { clientId: PRE_REGISTERED_CC }));
    expect(saved.orgConnection).toMatchObject({ status: "connected", hasSecret: true });
  });

  it("WR-03: a 401 on a fresh grant drops only the access token; the next use re-grants with the kept secret", async () => {
    const server = await savedServer();
    const secretId = (await orgConnectionRow(s, s.orgA, server.id))?.secret_id;
    const { core } = s.stack.built;
    expect(await markNeedsReconnect(core, { ...orgKey(server.id), code: "upstream_unauthorized" })).toBe(
      "token_dropped",
    );
    const row = await orgConnectionRow(s, s.orgA, server.id);
    expect(row).toMatchObject({
      status: "connected",
      secret_id: secretId,
      last_error: "upstream_unauthorized",
    });
    const b = await orgBundleOf(s, s.orgA, server.id);
    expect(b).toMatchObject({ kind: "client_credentials", clientSecret: CC_SECRET });
    expect(b?.accessToken).toBeUndefined();
    expect(
      (await auditRows(s, s.orgA, ["connector.org_needs_reconnect"])).map((a) => a.resource_id),
    ).not.toContain(row?.id);
    const before = await ccRequests();
    const t = await accessTokenFor(core, orgKey(server.id));
    expect(t).toMatchObject({ ok: true, headerName: "Authorization" });
    expect(await ccRequests()).toBe(before + 1);
    expect((await orgConnectionRow(s, s.orgA, server.id))?.last_error).toBeNull();
  });

  it("an issuer change → needs_reconnect issuer_changed; the secret is sent to neither issuer", async () => {
    const server = await savedServer();
    const before = (await fakeStats(s)).tokenRequests;
    s.fake.setScenario({ different_issuer: true });
    expect(await forceRefresh(s.stack.built.core, orgKey(server.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expect((await fakeStats(s)).tokenRequests).toEqual(before);
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({
      status: "needs_reconnect",
      last_error: "issuer_changed",
    });
    s.fake.setScenario({});
    expect((await dtoOf(server.id)).orgConnection).toMatchObject({ reconnectReason: "provider_changed" });
  });

  it("a re-discovery that fails is transient: no token request, the connection stays", async () => {
    const server = await savedServer();
    const before = await ccRequests();
    s.fake.setScenario({ issuer_mismatch_meta: true });
    await expect(forceRefresh(s.stack.built.core, orgKey(server.id))).rejects.toBeInstanceOf(
      ConnectorTokenUnavailableError,
    );
    expect(await ccRequests()).toBe(before);
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({ status: "connected" });
  });
});

describe("auth methods, the admin-entered Token URL and refused saves (D-03, D-10, D-15, D-17)", () => {
  it("cc_post_only → saved and re-granted with client_secret_post", async () => {
    const server = await savedServer({ scenario: { cc_post_only: true } });
    expect((await fakeStats(s)).lastClientAuth).toBe("post");
    expect((await orgBundleOf(s, s.orgA, server.id))?.authMethod).toBe("client_secret_post");
    const r = await forceRefresh(s.stack.built.core, orgKey(server.id));
    expect(r.ok).toBe(true);
    expect((await fakeStats(s)).lastClientAuth).toBe("post");
  });

  it("no_authorization_endpoint → saved through the lenient metadata, issuer pinned", async () => {
    const server = await savedServer({ scenario: { no_authorization_endpoint: true } });
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({
      status: "connected",
      issuer: `${s.fakeBase}/mcp-oauth`,
    });
  });

  it("no metadata + the admin's Token URL on the MCP origin → saved with issuer null; re-granted without discovery", async () => {
    const server = await registerCcConnector(s);
    s.fake.setScenario({ no_prm: true });
    const dto = await ok(
      saveCc(s, s.victor, server.id, {
        clientId: PRE_REGISTERED_CC,
        clientSecret: CC_SECRET,
        tokenEndpoint: `${s.fakeBase}/mcp-oauth/token`,
      }),
    );
    expect(dto).toMatchObject({
      status: "ready",
      orgConnection: { tokenEndpoint: `${s.fakeBase}/mcp-oauth/token`, hasSecret: true },
    });
    expect((await fakeStats(s)).lastResource.cc).toBe(`${s.fakeBase}/mcp-oauth/mcp`);
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({ issuer: null });
    expect(await orgBundleOf(s, s.orgA, server.id)).toMatchObject({ issuer: null, revocationEndpoint: null });
    const before = await ccRequests();
    expect((await forceRefresh(s.stack.built.core, orgKey(server.id))).ok).toBe(true);
    expect(await ccRequests()).toBe(before + 1);
  });

  it("no metadata and no Token URL → 409 discovery_failed, recorded as auth_failure; a later save clears it", async () => {
    const server = await registerCcConnector(s);
    s.fake.setScenario({ no_prm: true });
    await fails(saveCc(s, s.victor, server.id), 409, "discovery_failed");
    expect(await orgConnectionRow(s, s.orgA, server.id)).toBeUndefined();
    expect((await dtoOf(server.id)).authFailure).toBe("discovery_failed");
    expect((await auditRows(s, s.orgA, ["connector.connect_failed"])).at(-1)).toMatchObject({
      metadata: { serverId: server.id, code: "discovery_failed", principal: "organization" },
    });
    s.fake.setScenario({});
    expect((await ok(saveCc(s, s.victor, server.id))).authFailure).toBeNull();
  });

  it("an admin Token URL on another origin over http → 409 token_endpoint_untrusted, before any token request", async () => {
    const server = await registerCcConnector(s);
    s.fake.setScenario({ no_prm: true });
    const before = await ccRequests();
    await fails(
      saveCc(s, s.victor, server.id, {
        clientId: PRE_REGISTERED_CC,
        clientSecret: CC_SECRET,
        tokenEndpoint: `http://127.0.0.1:${s.fakePort}/mcp-oauth/token`,
      }),
      409,
      "token_endpoint_untrusted",
    );
    expect(await ccRequests()).toBe(before);
    expect((await dtoOf(server.id)).authFailure).toBe("token_endpoint_untrusted");
  });

  it("a refused grant (wrong secret, a public client) stores nothing new and keeps the connection there was", async () => {
    const server = await savedServer();
    const row = await orgConnectionRow(s, s.orgA, server.id);
    const b = await orgBundleOf(s, s.orgA, server.id);
    await fails(
      saveCc(s, s.victor, server.id, { clientId: PRE_REGISTERED_CC, clientSecret: "WRONG-SECRET" }),
      409,
      "token_exchange_failed",
    );
    await fails(
      saveCc(s, s.victor, server.id, { clientId: PRE_REGISTERED, clientSecret: "WRONG-SECRET" }),
      409,
      "token_exchange_failed",
    );
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({
      status: "connected",
      secret_id: row?.secret_id,
      client_id: PRE_REGISTERED_CC,
    });
    expect(await orgBundleOf(s, s.orgA, server.id)).toEqual(b);
    expect((await dtoOf(server.id)).authFailure).toBe("token_exchange_failed");
    expect(s.logs.join("\n")).not.toContain("WRONG-SECRET");
  });

  it("saving again with only the client id keeps the secret; another client id without one → 400 secret_required", async () => {
    const server = await savedServer();
    const before = await ccRequests();
    await ok(saveCc(s, s.victor, server.id, { clientId: PRE_REGISTERED_CC }));
    expect(await ccRequests()).toBe(before + 1);
    expect((await orgBundleOf(s, s.orgA, server.id))?.clientSecret).toBe(CC_SECRET);
    await fails(saveCc(s, s.victor, server.id, { clientId: "another-client" }), 400, "secret_required");
    expect(await ccRequests()).toBe(before + 1);
    // Never saved: a client id alone needs its secret.
    const fresh = await registerCcConnector(s);
    await fails(saveCc(s, s.victor, fresh.id, { clientId: PRE_REGISTERED_CC }), 400, "secret_required");
  });

  it("PUT on an org_oauth server → 409 wrong_auth_mode", async () => {
    const server = await registerCcConnector(s, {
      authMode: "org_oauth",
      oauthClient: { issuer: `${s.fakeBase}/mcp-oauth`, clientId: PRE_REGISTERED },
    });
    await fails(saveCc(s, s.victor, server.id), 409, "wrong_auth_mode");
  });
});

describe("security: a kept secret only goes where it was saved for (write-only secrets, ADR-0025)", () => {
  it("the issuer changed since the save: saving without the secret → 400 secret_required, nothing sent", async () => {
    const server = await savedServer();
    s.fake.setScenario({ different_issuer: true });
    const before = await ccRequests();
    await fails(saveCc(s, s.victor, server.id, { clientId: PRE_REGISTERED_CC }), 400, "secret_required");
    expect(await ccRequests()).toBe(before);
  });

  it("another Token URL without the secret → 400 secret_required, nothing sent; with the secret typed again it saves", async () => {
    const server = await registerCcConnector(s);
    s.fake.setScenario({ no_prm: true });
    await ok(
      saveCc(s, s.victor, server.id, {
        clientId: PRE_REGISTERED_CC,
        clientSecret: CC_SECRET,
        tokenEndpoint: `${s.fakeBase}/mcp-oauth/token`,
      }),
    );
    const before = await ccRequests();
    const moved = { clientId: PRE_REGISTERED_CC, tokenEndpoint: `${s.fakeBase}/mcp-oauth/alt/token` };
    await fails(saveCc(s, s.victor, server.id, moved), 400, "secret_required");
    expect(await ccRequests()).toBe(before);
    // The saved Token URL (omitted or repeated) keeps the secret.
    await ok(saveCc(s, s.victor, server.id, { clientId: PRE_REGISTERED_CC }));
    await ok(
      saveCc(s, s.victor, server.id, {
        clientId: PRE_REGISTERED_CC,
        tokenEndpoint: `${s.fakeBase}/mcp-oauth/token`,
      }),
    );
    await ok(saveCc(s, s.victor, server.id, { ...moved, clientSecret: CC_SECRET }));
    expect(await ccRequests()).toBe(before + 3);
  });

  it("a Token URL the registry would refuse (cloud metadata, loopback) → 409 token_endpoint_untrusted before any request", async () => {
    const server = await registerCcConnector(s);
    s.fake.setScenario({ no_prm: true });
    const before = await ccRequests();
    for (const tokenEndpoint of ["https://169.254.169.254/latest/token", "https://localhost/token"]) {
      await fails(
        saveCc(s, s.victor, server.id, {
          clientId: PRE_REGISTERED_CC,
          clientSecret: CC_SECRET,
          tokenEndpoint,
        }),
        409,
        "token_endpoint_untrusted",
      );
    }
    expect(await ccRequests()).toBe(before);
  });
});

describe("Disconnect and tenant isolation (D-08)", () => {
  it("Disconnect revokes the access token, then deletes the row and its secret", async () => {
    const server = await savedServer();
    const row = await orgConnectionRow(s, s.orgA, server.id);
    const revoked = await revocations();
    await ok(s.victor.request("DELETE", `/api/v1/connectors/${server.id}/org-connection`), 204);
    expect(await revocations()).toBe(revoked + 1);
    expect(await orgConnectionRow(s, s.orgA, server.id)).toBeUndefined();
    expect((await s.su.query("select 1 from app.secrets where id = $1", [row?.secret_id])).rowCount).toBe(0);
    expect((await auditRows(s, s.orgA, ["connector.org_disconnected"])).at(-1)).toMatchObject({
      metadata: { serverId: server.id, method: "client_credentials", revoked: true, reason: "admin" },
    });
  });

  it("WR-02: a grant stored while Disconnect revokes is revoked too before it is deleted; the audit is truthful", async () => {
    const server = await savedServer();
    const first = (await orgBundleOf(s, s.orgA, server.id))?.accessToken as string;
    const revoked = await revocations();
    s.fake.setScenario({ slow_revoke_ms: 1_500 });
    const disconnecting = s.victor.request("DELETE", `/api/v1/connectors/${server.id}/org-connection`);
    // The first revocation is in flight (outside any transaction): another admin saves again meanwhile.
    await new Promise((r) => setTimeout(r, 300));
    await ok(saveCc(s, s.victor, server.id));
    const second = (await orgBundleOf(s, s.orgA, server.id))?.accessToken as string;
    expect(second).not.toBe(first);
    await ok(disconnecting, 204);
    s.fake.setScenario({});
    // Both grants were revoked at the provider: the second one is not left live behind a deleted row.
    expect(await revocations()).toBe(revoked + 2);
    await expect(
      callTool(
        egressFor(s.stack.built.core.env),
        { url: server.url, transport: "streamable-http" },
        { headerName: "Authorization", headerValue: `Bearer ${second}` },
        { name: "whoami", arguments: {} },
        { redact: [second] },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(await orgConnectionRow(s, s.orgA, server.id)).toBeUndefined();
    const audits = (await auditRows(s, s.orgA, ["connector.org_disconnected"])).filter(
      (a) => a.metadata.serverId === server.id,
    );
    expect(audits).toEqual([
      expect.objectContaining({
        metadata: { serverId: server.id, method: "client_credentials", revoked: true, reason: "admin" },
      }),
    ]);
  });

  it("without a revocation endpoint Disconnect still deletes (revoked false)", async () => {
    const server = await registerCcConnector(s);
    s.fake.setScenario({ no_prm: true });
    await ok(
      saveCc(s, s.victor, server.id, {
        clientId: PRE_REGISTERED_CC,
        clientSecret: CC_SECRET,
        tokenEndpoint: `${s.fakeBase}/mcp-oauth/token`,
      }),
    );
    const revoked = await revocations();
    await ok(s.victor.request("DELETE", `/api/v1/connectors/${server.id}/org-connection`), 204);
    expect(await revocations()).toBe(revoked);
    expect(await orgConnectionRow(s, s.orgA, server.id)).toBeUndefined();
    expect((await auditRows(s, s.orgA, ["connector.org_disconnected"])).at(-1)).toMatchObject({
      metadata: { serverId: server.id, method: "client_credentials", revoked: false },
    });
  });

  it("org B's admin can neither save on nor disconnect org A's server", async () => {
    const server = await savedServer();
    const row = await orgConnectionRow(s, s.orgA, server.id);
    const before = await ccRequests();
    await fails(saveCc(s, s.eve, server.id), 404);
    await fails(saveCc(s, s.eve, server.id, { clientId: PRE_REGISTERED_CC }), 404);
    await fails(s.eve.request("DELETE", `/api/v1/connectors/${server.id}/org-connection`), 404);
    expect(await ccRequests()).toBe(before);
    expect(await orgConnectionRow(s, s.orgA, server.id)).toEqual(row);
  });
});
