import { connectorOAuthUrls } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  CALLBACK_URL,
  CC_SECRET,
  type ConnectorsStack,
  fails,
  fakeStats,
  type Json,
  ok,
  PRE_REGISTERED,
  PRE_REGISTERED_CC,
  PUBLIC_API_URL,
  type Res,
  registerCcConnector,
  registerOrgConnector,
  saveCc,
  startConnectorsStack,
} from "../../testing-connectors";

/**
 * The Test sign-in route (07.14-09 Task 3, D-10, D-18; COA-04): `POST /connectors/oauth-test` dry-runs a sign-in for
 * unsaved form values or a saved server and answers the ordered steps and the first failure. It never registers a
 * client, never writes a row, a secret, `auth_failure` or `oauth_status`, and never returns a token, a secret or
 * provider text. `mcp.manage` only, 10 per minute per user. Real PostgreSQL + Redis; the fake is in-process.
 */

let s: ConnectorsStack;
const STEPS = ["public_url", "discovery", "issuer", "endpoints", "pkce", "client_registration", "token"];
const urls = () => connectorOAuthUrls(PUBLIC_API_URL);
const mcpUrl = () => `${s.fakeBase}/mcp-oauth/mcp`;
const issuer = () => `${s.fakeBase}/mcp-oauth`;

/** Everything the Test sign-in must never write (D-18). */
async function snapshot(): Promise<Json> {
  const q = async (sql: string) => (await s.su.query(sql)).rows;
  return {
    orgConnections: await q("select * from app.connector_org_connections order by id"),
    clients: await q("select * from app.connector_oauth_clients order by id"),
    secrets: await q("select * from app.secrets order by id"),
    servers: await q("select id, auth_failure, oauth_status, status from app.mcp_servers order by id"),
  };
}

/** Forgets every Test sign-in rate-limit counter (the 429 case counts its own). */
async function resetLimit(): Promise<void> {
  const redis = s.stack.built.core.bus.pub;
  const keys = await redis.keys("ocw:rl:*oauth-test*");
  if (keys.length > 0) await redis.del(keys);
}

const test = (body: Json, as = s.victor): Promise<Res> =>
  as.request("POST", "/api/v1/connectors/oauth-test", body);

const stepsOf = (r: Json) => Object.fromEntries((r.steps as Json[]).map((x) => [x.step, x.status]));

/** The answer carries no token, secret or provider text. */
function clean(r: Json): void {
  const text = JSON.stringify(r);
  expect(text).not.toContain(CC_SECRET);
  expect(text).not.toMatch(/fakeat_|fakert_|fake: /u);
  expect(text).not.toContain("error_description");
}

let before: Json;

beforeAll(async () => {
  s = await startConnectorsStack();
}, 240_000);

beforeEach(async () => {
  await resetLimit();
  before = await snapshot();
});

afterEach(async () => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
  expect(await snapshot()).toEqual(before);
  expect((await fakeStats(s)).registrations).toBe(0);
});

afterAll(async () => {
  await s?.stop();
});

describe("tracer: Test sign-in on unsaved values", () => {
  it("org_oauth with the pre-registered client → ok: seven steps (token skipped), pre_registered, the instance URLs", async () => {
    const r = await ok(
      test({
        url: mcpUrl(),
        transport: "streamable-http",
        authMode: "org_oauth",
        oauthClient: { issuer: issuer(), clientId: PRE_REGISTERED },
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      failure: null,
      clientMethod: "pre_registered",
      issuer: issuer(),
      tokenEndpoint: `${issuer()}/token`,
      redirectUri: CALLBACK_URL,
      clientMetadataUrl: urls().clientMetadataUrl,
    });
    expect((r.steps as Json[]).map((x) => x.step)).toEqual(STEPS);
    expect(stepsOf(r)).toEqual({
      public_url: "ok",
      discovery: "ok",
      issuer: "ok",
      endpoints: "ok",
      pkce: "ok",
      client_registration: "ok",
      token: "skipped",
    });
    clean(r);
  });

  it("per_member_oauth with no_registration and no client → client_registration_unavailable, nothing registered", async () => {
    s.fake.setScenario({ no_registration: true });
    const r = await ok(test({ url: mcpUrl(), authMode: "per_member_oauth" }));
    expect(r).toMatchObject({ ok: false, failure: "client_registration_unavailable" });
    expect(stepsOf(r).client_registration).toBe("failed");
  });

  it("the provider's setup: no PKCE, a mismatched issuer, no metadata → their step, later steps skipped", async () => {
    const cases: Array<[Json, string, string]> = [
      [{ no_pkce_meta: true }, "pkce_unsupported", "pkce"],
      [{ issuer_mismatch_meta: true }, "issuer_mismatch", "issuer"],
      [{ no_prm: true }, "discovery_failed", "discovery"],
    ];
    for (const [scenario, failure, step] of cases) {
      s.fake.setScenario(scenario);
      const r = await ok(
        test({
          url: mcpUrl(),
          authMode: "org_oauth",
          oauthClient: { issuer: issuer(), clientId: PRE_REGISTERED },
        }),
      );
      expect(r, failure).toMatchObject({ ok: false, failure });
      const st = stepsOf(r);
      expect(st[step], failure).toBe("failed");
      expect(st.client_registration, failure).toBe("skipped");
      clean(r);
    }
  });

  it("a URL the registry would refuse → 400 before any request", async () => {
    const mcp = (await fakeStats(s)).mcpRequests;
    await fails(test({ url: `http://127.0.0.1:${s.fakePort}/mcp-oauth/mcp`, authMode: "org_oauth" }), 400);
    await fails(test({ url: "not a url", authMode: "org_oauth" }), 400);
    expect((await fakeStats(s)).mcpRequests).toBe(mcp);
  });

  it("a page origin that is not the loopback redirect URI's → https_required at public_url, nothing sent", async () => {
    const r = await ok(
      test({
        url: mcpUrl(),
        authMode: "org_oauth",
        oauthClient: { issuer: issuer(), clientId: PRE_REGISTERED },
        pageOrigin: "https://ocw.example.com",
      }),
    );
    expect(r).toMatchObject({ ok: false, failure: "https_required" });
    expect(stepsOf(r)).toMatchObject({ public_url: "failed", discovery: "skipped" });
  });
});

describe("client credentials", () => {
  const cc = (over: Json = {}) => ({
    url: mcpUrl(),
    authMode: "org_client_credentials",
    clientCredentials: { clientId: PRE_REGISTERED_CC, clientSecret: CC_SECRET },
    ...over,
  });

  it("unsaved client credentials with an empty Token URL → a real grant, token ok; the token is not returned", async () => {
    const grants = (await fakeStats(s)).tokenRequests.client_credentials;
    const r = await ok(test(cc()));
    expect(r).toMatchObject({ ok: true, failure: null, tokenEndpoint: `${issuer()}/token` });
    expect(stepsOf(r)).toMatchObject({
      public_url: "skipped",
      discovery: "ok",
      issuer: "ok",
      endpoints: "ok",
      pkce: "skipped",
      client_registration: "skipped",
      token: "ok",
    });
    expect((await fakeStats(s)).tokenRequests.client_credentials).toBe(grants + 1);
    clean(r);
  });

  it("a wrong secret → token_exchange_failed; unknown scopes → scope_rejected", async () => {
    const wrong = await ok(
      test(cc({ clientCredentials: { clientId: PRE_REGISTERED_CC, clientSecret: "WRONG-SECRET" } })),
    );
    expect(wrong).toMatchObject({ ok: false, failure: "token_exchange_failed" });
    clean(wrong);
    const scoped = await ok(test(cc({ oauthScopes: ["unknown"] })));
    expect(scoped).toMatchObject({ ok: false, failure: "scope_rejected" });
    expect(stepsOf(scoped).token).toBe("failed");
    clean(scoped);
  });
});

describe("saved servers", () => {
  let saved: Json;
  let signIn: Json;

  beforeAll(async () => {
    saved = await registerCcConnector(s);
    await ok(saveCc(s, s.victor, saved.id));
    signIn = await registerOrgConnector(s);
  });

  it("a saved client-credentials server with the secret omitted uses the stored one", async () => {
    const r = await ok(
      test({
        serverId: saved.id,
        authMode: "org_client_credentials",
        clientCredentials: { clientId: PRE_REGISTERED_CC },
      }),
    );
    expect(r).toMatchObject({ ok: true, failure: null });
    clean(r);
    // Nothing at all from the form: the stored client too.
    expect(await ok(test({ serverId: saved.id, authMode: "org_client_credentials" }))).toMatchObject({
      ok: true,
    });
  });

  it("a saved sign-in server uses its stored pre-registered client", async () => {
    const r = await ok(test({ serverId: signIn.id, authMode: "org_oauth" }));
    expect(r).toMatchObject({ ok: true, clientMethod: "pre_registered" });
  });

  it("org B's admin naming org A's server → 404, nothing of org A used", async () => {
    const grants = (await fakeStats(s)).tokenRequests.client_credentials;
    await fails(test({ serverId: saved.id, authMode: "org_client_credentials" }, s.eve), 404);
    await fails(
      test(
        {
          serverId: saved.id,
          authMode: "org_client_credentials",
          clientCredentials: { clientId: PRE_REGISTERED_CC },
        },
        s.eve,
      ),
      404,
    );
    expect((await fakeStats(s)).tokenRequests.client_credentials).toBe(grants);
  });
});

describe("who may test, and how often", () => {
  it("a member without mcp.manage → 403", async () => {
    await fails(test({ url: mcpUrl(), authMode: "org_oauth" }, s.sam), 403);
  });

  it("the 11th call within a minute by one admin → 429; another admin and the other routes are not limited by it", async () => {
    const other = await registerCcConnector(s);
    before = await snapshot();
    const refused = { url: `http://127.0.0.1:${s.fakePort}/mcp`, authMode: "org_oauth" };
    for (let i = 0; i < 10; i++) await fails(test(refused), 400);
    await fails(test(refused), 429);
    await fails(test(refused, s.eve), 400);
    // The limit is the Test route's own: the organization-connection routes beside it keep answering.
    for (let i = 0; i < 12; i++) {
      await fails(saveCc(s, s.victor, other.id, { clientId: PRE_REGISTERED_CC }), 400, "secret_required");
    }
  });
});
