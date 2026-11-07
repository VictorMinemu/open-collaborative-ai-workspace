import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  authorize,
  bundleOf,
  CC_SECRET,
  type ConnectorsStack,
  callback,
  connectionRow,
  connectOAuth,
  connectOrgOAuth,
  fails,
  fakeStats,
  ok,
  orgBundleOf,
  orgConnectionRow,
  registerCcConnector,
  registerConnector,
  registerOrgConnector,
  saveCc,
  startConnectorsStack,
} from "../../testing-connectors";
import { accessTokenFor, forceRefresh } from "./index";

/**
 * 07.14 review CR-01: a stored credential belongs to the server URL it was granted for. Changing a proxied server's URL
 * is a credential change (the same 409 + `clearConnections` confirmation as a mode switch, the credentials destroyed on
 * confirm), and at use time a credential whose `resource` (or stored server URL) no longer covers the server's current
 * URL is never sent: the call fails closed with a reconnect reason. A sign-in that started on another URL stores
 * nothing. The canary is a second server at another origin (same test host, another port) that records every request
 * it gets: it must get none.
 */

let s: ConnectorsStack;
let canary: Server;
let canaryUrl = "";
const canaryHits: Array<{ url: string; authorization: string | undefined; body: string }> = [];

const WEB_MCP = "http://localhost:3999/settings/mcp-servers";
const WEB_CONN = "http://localhost:3999/settings/connections";
const KEY_CANARY = "MEMBER-KEY-URL-CHANGE-CANARY";

/** Moves a server's URL behind the registry's back: the race the use-time binding must still catch. */
const moveUrl = (serverId: string, url: string) =>
  s.su.query("update app.mcp_servers set url = $2 where id = $1", [serverId, url]);

const secretExists = async (id: string) =>
  (await s.su.query("select 1 from app.secrets where id = $1", [id])).rowCount === 1;

const orgKey = (serverId: string) => ({
  organizationId: s.orgA,
  serverId,
  principal: "organization" as const,
  actingUserId: s.victorId,
});

/** Nothing reached the canary: no request at all, so neither a token nor a client secret. */
function expectCanaryUntouched(secrets: string[] = []): void {
  expect(canaryHits).toEqual([]);
  for (const v of secrets) expect(JSON.stringify(canaryHits)).not.toContain(v);
}

beforeAll(async () => {
  s = await startConnectorsStack();
  canary = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += String(c);
    });
    req.on("end", () => {
      canaryHits.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
  canaryUrl = `http://fake-mcp:${(canary.address() as AddressInfo).port}/mcp-oauth/mcp`;
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
  canaryHits.length = 0;
});

afterAll(async () => {
  canary?.closeAllConnections();
  await new Promise<void>((resolve) => (canary ? canary.close(() => resolve()) : resolve()));
  await s?.stop();
});

describe("a URL change on a proxied server is a credential change (confirm, then destroy)", () => {
  it("org client credentials: 409 org_connection_exists, nothing changed; confirmed, the row and its bundle go", async () => {
    const server = await registerCcConnector(s);
    await ok(saveCc(s, s.victor, server.id));
    const before = await orgConnectionRow(s, s.orgA, server.id);
    expect(before?.secret_id).toBeTruthy();

    const refused = await fails(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { url: canaryUrl }),
      409,
      "org_connection_exists",
    );
    expect(refused.error.details).toEqual({ method: "client_credentials" });
    const unchanged = await ok(s.victor.request("GET", `/api/v1/mcp-servers/${server.id}`));
    expect(unchanged.url).toBe(server.url);
    expect(unchanged.orgConnection).toMatchObject({ status: "connected" });

    const moved = await ok(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, {
        url: canaryUrl,
        clearConnections: true,
      }),
    );
    expect(moved).toMatchObject({ url: canaryUrl, orgConnection: null, status: "pending" });
    expect(await orgConnectionRow(s, s.orgA, server.id)).toBeUndefined();
    expect(await secretExists(before?.secret_id)).toBe(false);
    expect(
      (await auditRows(s, s.orgA, ["connector.org_disconnected"])).filter(
        (a) => a.metadata.serverId === server.id,
      ),
    ).toEqual([
      expect.objectContaining({
        metadata: {
          serverId: server.id,
          method: "client_credentials",
          revoked: false,
          reason: "url_changed",
        },
      }),
    ]);
    // Nothing was sent anywhere for the new URL: the bots wait for the organization to connect again.
    await fails(s.victor.request("POST", `/api/v1/connectors/${server.id}/probe`), 409, "not_connected");
    expectCanaryUntouched([CC_SECRET]);
  });

  it("org sign-in: the same confirmation", async () => {
    const server = await registerOrgConnector(s);
    expect((await connectOrgOAuth(s, s.victor, server.id)).location).toBe(
      `${WEB_MCP}?connected=${server.id}`,
    );
    await fails(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { url: canaryUrl }),
      409,
      "org_connection_exists",
    );
    const moved = await ok(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, {
        url: canaryUrl,
        clearConnections: true,
      }),
    );
    expect(moved.orgConnection).toBeNull();
    expect(await orgConnectionRow(s, s.orgA, server.id)).toBeUndefined();
    expectCanaryUntouched();
  });

  it("member sign-in: 409 connections_exist with the count; confirmed, every member's credential goes", async () => {
    const server = await registerConnector(s);
    expect((await connectOAuth(s, s.sam, server.id)).location).toBe(`${WEB_CONN}?connected=${server.id}`);
    const secretId = (await connectionRow(s, s.samId, server.id))?.secret_id as string;

    const refused = await fails(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { url: canaryUrl }),
      409,
      "connections_exist",
    );
    expect(refused.error.details).toEqual({ count: 1 });
    expect(await connectionRow(s, s.samId, server.id)).toBeDefined();

    await ok(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, {
        url: canaryUrl,
        clearConnections: true,
      }),
    );
    expect(await connectionRow(s, s.samId, server.id)).toBeUndefined();
    expect(await secretExists(secretId)).toBe(false);
    expect((await auditRows(s, s.orgA, ["connector.connections_cleared"])).at(-1)).toMatchObject({
      metadata: { serverId: server.id, count: 1, reason: "url_changed" },
    });
    expectCanaryUntouched();
  });

  it("a rename, or the same URL sent again, needs no confirmation and keeps the credential", async () => {
    const server = await registerCcConnector(s);
    await ok(saveCc(s, s.victor, server.id));
    await ok(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, {
        name: "Ledger renamed",
        url: server.url,
      }),
    );
    expect((await orgConnectionRow(s, s.orgA, server.id))?.status).toBe("connected");
  });
});

describe("at use time a credential is sent only to the URL it was granted for", () => {
  it("org client credentials, URL moved: Re-probe 409 needs_reconnect, the canary gets nothing, the credential is dropped", async () => {
    const server = await registerCcConnector(s);
    await ok(saveCc(s, s.victor, server.id));
    const token = (await orgBundleOf(s, s.orgA, server.id))?.accessToken as string;
    await moveUrl(server.id, canaryUrl);
    const ccBefore = (await fakeStats(s)).tokenRequests.client_credentials;

    await fails(s.victor.request("POST", `/api/v1/connectors/${server.id}/probe`), 409, "needs_reconnect");
    expect(await accessTokenFor(s.stack.built.core, orgKey(server.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expect(await forceRefresh(s.stack.built.core, orgKey(server.id))).toEqual({
      ok: false,
      reason: "needs_reconnect",
    });
    expectCanaryUntouched([token, CC_SECRET]);
    // No re-grant either: the secret was not sent to the token endpoint for a token the new URL would get.
    expect((await fakeStats(s)).tokenRequests.client_credentials).toBe(ccBefore);
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({
      status: "needs_reconnect",
      last_error: "url_changed",
      secret_id: null,
    });
    const dto = await ok(s.victor.request("GET", `/api/v1/mcp-servers/${server.id}`));
    expect(dto.orgConnection).toMatchObject({
      status: "needs_reconnect",
      reconnectReason: "provider_changed",
    });
  });

  it("org sign-in, URL moved: the token is refused and never sent, nor refreshed", async () => {
    const server = await registerOrgConnector(s);
    expect((await connectOrgOAuth(s, s.victor, server.id)).location).toBe(
      `${WEB_MCP}?connected=${server.id}`,
    );
    const b = await orgBundleOf(s, s.orgA, server.id);
    await moveUrl(server.id, canaryUrl);
    const before = await fakeStats(s);
    await fails(s.victor.request("POST", `/api/v1/connectors/${server.id}/probe`), 409, "needs_reconnect");
    expectCanaryUntouched([b?.accessToken, b?.refreshToken]);
    expect((await fakeStats(s)).tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token);
    expect((await orgConnectionRow(s, s.orgA, server.id))?.last_error).toBe("url_changed");
  });

  it("a member's key, URL moved: refused needs_reconnect, the key is never sent", async () => {
    const server = await registerConnector(s, {
      authMode: "per_member_secret",
      memberHeaderName: "X-Api-Key",
      oauthClient: undefined,
    });
    await ok(s.sam.request("PUT", `/api/v1/connectors/${server.id}/secret`, { value: KEY_CANARY }));
    expect(await bundleOf(s, s.orgA, s.samId, server.id)).toMatchObject({
      kind: "secret",
      serverUrl: server.url,
    });
    await moveUrl(server.id, canaryUrl);
    expect(
      await accessTokenFor(s.stack.built.core, {
        organizationId: s.orgA,
        userId: s.samId,
        serverId: server.id,
      }),
    ).toEqual({ ok: false, reason: "needs_reconnect" });
    expectCanaryUntouched([KEY_CANARY]);
    expect(await connectionRow(s, s.samId, server.id)).toMatchObject({
      status: "needs_reconnect",
      last_error: "url_changed",
    });
  });

  it("an unmoved credential still works (the binding is not a false positive)", async () => {
    const server = await registerCcConnector(s);
    await ok(saveCc(s, s.victor, server.id));
    const token = await accessTokenFor(s.stack.built.core, orgKey(server.id));
    expect(token).toMatchObject({ ok: true, headerName: "Authorization", url: server.url });
    await ok(s.victor.request("POST", `/api/v1/connectors/${server.id}/probe`));
  });
});

describe("a sign-in that started on another URL stores nothing", () => {
  it("organization: the URL changes between authorize and callback → flow_expired, no code redeemed, no row", async () => {
    const server = await registerOrgConnector(s);
    const start = await ok(
      s.victor.request("POST", `/api/v1/connectors/${server.id}/org-connection/connect`),
    );
    const location = await authorize(s, start.authorizeUrl);
    // No connection yet: the URL change needs no confirmation.
    await ok(s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { url: canaryUrl }));
    const before = await fakeStats(s);
    expect((await callback(s, location, s.victor)).location).toBe(
      `${WEB_MCP}?error=flow_expired&connector=${server.id}`,
    );
    expect((await fakeStats(s)).tokenRequests.authorization_code).toBe(
      before.tokenRequests.authorization_code,
    );
    expect(await orgConnectionRow(s, s.orgA, server.id)).toBeUndefined();
    expectCanaryUntouched();
  });

  it("member: the same → flow_expired, nothing stored", async () => {
    const server = await registerConnector(s);
    const start = await ok(s.sam.request("POST", `/api/v1/connectors/${server.id}/connect`));
    const location = await authorize(s, start.authorizeUrl);
    await ok(s.victor.request("PATCH", `/api/v1/mcp-servers/${server.id}`, { url: canaryUrl }));
    const before = await fakeStats(s);
    expect((await callback(s, location, s.sam)).location).toBe(
      `${WEB_CONN}?error=flow_expired&connector=${server.id}`,
    );
    expect((await fakeStats(s)).tokenRequests.authorization_code).toBe(
      before.tokenRequests.authorization_code,
    );
    expect(await connectionRow(s, s.samId, server.id)).toBeUndefined();
    expectCanaryUntouched();
  });
});
