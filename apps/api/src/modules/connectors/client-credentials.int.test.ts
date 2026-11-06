import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { egressFor } from "../../lib/egress";
import {
  assertNoGlobalFetch,
  auditRows,
  CC_SECRET,
  type ConnectorsStack,
  fakeStats,
  type Json,
  ok,
  orgBundleOf,
  orgConnectionRow,
  PRE_REGISTERED_CC,
  registerCcConnector,
  saveCc,
  startConnectorsStack,
} from "../../testing-connectors";
import { accessTokenFor } from "./index";
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

afterEach(() => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
  s.setDown(false);
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
