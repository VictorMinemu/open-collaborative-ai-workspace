import { randomUUID } from "node:crypto";
import { WS_AUTH_PROTOCOL_PREFIX, WS_PROTOCOL } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { WEB_ORIGIN } from "../../testing";
import {
  assertNoGlobalFetch,
  authorize,
  bundleOf,
  CC_SECRET,
  CONFIDENTIAL_SECRET,
  type ConnectorsStack,
  callback,
  connectionRow,
  fails,
  fakeStats,
  type Json,
  ok,
  orgBundleOf,
  orgConnectionRow,
  PRE_REGISTERED_CC,
  PRE_REGISTERED_CONFIDENTIAL,
  type Res,
  registerCcConnector,
  registerOrgConnector,
  saveCc,
  startConnectorsStack,
} from "../../testing-connectors";
import { connectionAad, orgConnectionAad } from "./index";
import { connectFlowKey } from "./routes";

/**
 * 07.4-12 Task 3 (D-06, CONN-05, principle 8; T-07.4-12-06): the phase-wide leak sweep. One scenario on one stack runs
 * every credential path of Phase 07.4 with canary values and real tokens from the fake provider:
 *
 *   an admin registers a per-member OAuth connector with a confidential client (client secret canary) and a per-member
 *   key connector; Víctor signs in through the fake (code, PKCE verifier, state, access and refresh tokens) and pastes a
 *   member key (canary); he creates personal api_key, basic and client-credentials keychain items (canaries) and grants
 *   them to Scout; DM turns call the connector (whoami, echo_auth), force a refresh (a token the provider no longer
 *   accepts), send the member key upstream (refused), make http requests with every key (whoami and the /kc/echo
 *   mirror), list the turn's connectors and keys; every member, admin, keychain and template endpoint of the phase is
 *   read; the cell snapshot is read; Víctor disconnects (revocation).
 *
 * 07.14-13 (D-09, COA-03) adds the organization's credentials: Víctor connects an `org_oauth` server for the
 * organization (its flow's verifier and state kept) and saves client credentials with the `CC_SECRET` canary on an
 * `org_client_credentials` server; Sam's channel turn calls both through the proxy; one forced refresh and one forced
 * re-grant run; a Test sign-in grants with the secret; Víctor disconnects the sign-in (revoked at the provider) and a
 * confirmed mode switch destroys the client credentials. Every token and code the fake issued to those flows, the
 * verifier, the state and the client secret join the canaries below.
 *
 * Then no secret (nor its base64 forms) may appear in any text, varchar, array or jsonb column of any app or auth table
 * (sealed secrets are bytea), any API response body or header, any WebSocket frame Víctor's or Sam's sockets received,
 * any audit row, any Redis key or value left, any API log line (LOG_LEVEL debug) or the cell snapshot. A finding is fixed
 * at its source; no check is weakened.
 */

const CELL_TOKEN = "ocw-test-cell-token-security-sweep-0123456789abcdef";
const rand = () => randomUUID().replaceAll("-", "");
const KC_TOKEN = `KCAPIKEY${rand()}`;
const KC_BASIC = { user: `kcuser${rand().slice(0, 8)}`, pass: `KCPASS${rand()}` };
const KC_CLIENT = { id: `kc-client-${rand().slice(0, 8)}`, secret: `KCCLIENTSECRET${rand()}` };
const MEMBER_KEY = `MEMBERKEY${rand()}`;

let s: ConnectorsStack;
let oauthServer: Json;
let keyServer: Json;
let scoutId = "";
let victorDm = "";
let samDm = "";
let flowSecrets: string[] = [];
/** The organization sign-in flow's state and PKCE verifier (07.14-13). */
let orgFlowSecrets: string[] = [];
/** The organization's servers: sign-in (`org_oauth`) and client credentials (07.14-13). */
let orgServer: Json;
let ccServer: Json;
let salesId = "";
let cellSnapshot = "";
const keys: Record<"api" | "basic" | "client", Json> = {} as Record<"api" | "basic" | "client", Json>;

/** Every response of the API under test (status line, headers and body), as text. */
const responses: string[] = [];
let sockets: Array<{ who: string; ws: WebSocket; frames: string[] }> = [];

async function cell(path: string, body?: unknown, method = "POST"): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${CELL_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

async function socketOf(client: ConnectorsStack["victor"], topics: string[]) {
  const ws = new WebSocket(
    `${s.stack.baseUrl.replace("http", "ws")}/ws`,
    [WS_PROTOCOL, `${WS_AUTH_PROTOCOL_PREFIX}${await client.token()}`],
    { headers: { origin: WEB_ORIGIN } },
  );
  const frames: string[] = [];
  ws.on("message", (m) => frames.push(String(m)));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  for (const topic of topics) await subscribe({ ws, frames }, topic);
  return { ws, frames };
}

/** Subscribes an open socket to one more topic and waits for the server's confirmation. */
async function subscribe(sock: { ws: WebSocket; frames: string[] }, topic: string) {
  sock.ws.send(JSON.stringify({ op: "sub", topic }));
  const until = Date.now() + 5000;
  while (!sock.frames.some((f) => f.includes('"subscribed"') && f.includes(`"${topic}"`))) {
    if (Date.now() > until) throw new Error(`no subscribed frame for ${topic}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function turnOf(
  who: ConnectorsStack["victor"],
  conversationId: string,
  mention = false,
): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: mention ? "@scout use the organization's accounts" : "use my accounts",
      ...(mention ? { mentions: [{ kind: "agent", id: scoutId }] } : {}),
    }),
  );
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${s.orgA}`, msg.id, scoutId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

/** Every form a secret can leak as: itself, its long parts, base64 / base64url, and percent-encoded. */
function formsOf(secret: string): string[] {
  const forms = new Set<string>([secret, encodeURIComponent(secret)]);
  for (const part of [secret, ...secret.split(/\s+/u)].filter((p) => p.length >= 8)) {
    const b64 = Buffer.from(part).toString("base64");
    forms.add(part);
    forms.add(b64);
    forms.add(b64.replace(/=+$/u, ""));
    forms.add(Buffer.from(part).toString("base64url"));
  }
  return [...forms].filter((f) => f.length >= 8);
}

/** The secret names found in a text (never the secret itself: the failure message must not leak either). */
function leaks(text: string, secrets: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [name, secret] of secrets) {
    if (formsOf(secret).some((f) => text.includes(f))) found.push(name);
  }
  return found;
}

/** Every text, varchar, array, json and jsonb value of every app and auth table, as `table.column: value` lines. */
async function scanDb(): Promise<string> {
  const cols = (
    await s.su.query(
      `select table_schema, table_name, column_name from information_schema.columns
        where table_schema in ('app','auth')
          and data_type in ('text','character varying','jsonb','json','ARRAY')
          and table_name in (select table_name from information_schema.tables
                              where table_schema = columns.table_schema and table_type = 'BASE TABLE')`,
    )
  ).rows as Array<{ table_schema: string; table_name: string; column_name: string }>;
  const out: string[] = [];
  for (const c of cols) {
    const rows = (
      await s.su.query(
        `select "${c.column_name}"::text as v from "${c.table_schema}"."${c.table_name}" where "${c.column_name}" is not null`,
      )
    ).rows as Array<{ v: string }>;
    for (const r of rows) out.push(`${c.table_schema}.${c.table_name}.${c.column_name}: ${r.v}`);
  }
  return out.join("\n");
}

/** Every Redis key and its value (strings, hashes, lists, sets, sorted sets, streams). */
async function scanRedis(): Promise<string> {
  const redis = s.stack.built.core.bus.pub;
  const out: string[] = [];
  for await (const batch of redis.scanIterator({ COUNT: 500 })) {
    for (const key of Array.isArray(batch) ? batch : [batch]) {
      const type = await redis.type(key);
      let value: unknown = null;
      if (type === "string") value = await redis.get(key);
      else if (type === "hash") value = await redis.hGetAll(key);
      else if (type === "list") value = await redis.lRange(key, 0, -1);
      else if (type === "set") value = await redis.sMembers(key);
      else if (type === "zset") value = await redis.zRange(key, 0, -1);
      else if (type === "stream") value = await redis.xRange(key, "-", "+");
      out.push(`${key} (${type}): ${JSON.stringify(value)}`);
    }
  }
  return out.join("\n");
}

beforeAll(async () => {
  s = await startConnectorsStack({
    env: { OCW_CELL_TOKEN: CELL_TOKEN },
    logLevel: "debug",
    fake: { kcToken: KC_TOKEN, kcBasic: KC_BASIC, kcClient: KC_CLIENT },
  });
  // Record every response of the API under test (the fixture's own fetch stub stays underneath).
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    const href = input instanceof Request ? input.url : String(input);
    if (href.startsWith(s.stack.baseUrl)) {
      const text = await res.clone().text();
      // The answer only: the test's own request URL (the callback's code and state) is not the API's output.
      responses.push(`${res.status} ${new URL(href).pathname}\n${JSON.stringify([...res.headers])}\n${text}`);
    }
    return res;
  });
  scoutId = (
    await ok(
      s.victor.request("POST", "/api/v1/agents", {
        name: "Scout",
        username: "scout",
        instructions: "You are Scout.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;
  victorDm = (
    await ok(s.victor.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] }))
  ).id;
  samDm = (await ok(s.sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] })))
    .id;
  sockets = [
    {
      who: "Víctor",
      ...(await socketOf(s.victor, [`user:${s.victorId}`, `org:${s.orgA}`, `conv:${victorDm}`])),
    },
    { who: "Sam", ...(await socketOf(s.sam, [`user:${s.samId}`, `org:${s.orgA}`, `conv:${samDm}`])) },
  ];
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
});

afterAll(async () => {
  for (const sock of sockets) sock.ws.close();
  await s?.stop();
});

describe("the scenario: every credential path of the phase, with canaries", () => {
  it("the admin registers an OAuth connector with a confidential client and a member-key connector", async () => {
    oauthServer = await ok(
      s.victor.request("POST", "/api/v1/mcp-servers", {
        name: "Acme CRM",
        transport: "streamable-http",
        url: `${s.fakeBase}/mcp-oauth/mcp`,
        authMode: "per_member_oauth",
        oauthClient: {
          issuer: `${s.fakeBase}/mcp-oauth`,
          clientId: PRE_REGISTERED_CONFIDENTIAL,
          clientSecret: CONFIDENTIAL_SECRET,
        },
      }),
    );
    keyServer = await ok(
      s.victor.request("POST", "/api/v1/mcp-servers", {
        name: "Notes",
        transport: "streamable-http",
        url: `${s.fakeBase}/mcp-oauth/mcp`,
        authMode: "per_member_secret",
        memberHeaderName: "Authorization",
        memberHeaderPrefix: "Bearer ",
      }),
    );
  });

  it("Víctor signs in through the fake (the flow's verifier and state are kept for the sweep)", async () => {
    const start = await ok(s.victor.request("POST", `/api/v1/connectors/${oauthServer.id}/connect`));
    const state = new URL(start.authorizeUrl).searchParams.get("state") ?? "";
    const flow = JSON.parse((await s.stack.built.core.bus.pub.get(connectFlowKey(state))) ?? "{}") as Json;
    expect(flow.verifier).toEqual(expect.any(String));
    flowSecrets = [state, flow.verifier];
    const done = await callback(s, await authorize(s, start.authorizeUrl), s.victor);
    expect(done.status).toBe(302);
    expect((await connectionRow(s, s.victorId, oauthServer.id))?.status).toBe("connected");
  });

  it("Víctor pastes his member key; the catalog of that connector is filled by hand (its probe is refused)", async () => {
    await ok(s.victor.request("PUT", `/api/v1/connectors/${keyServer.id}/secret`, { value: MEMBER_KEY }));
    await s.su.query("delete from app.mcp_server_tools where server_id = $1", [keyServer.id]);
    await s.su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only) values ($1, $2, 'whoami', $3, true)`,
      [s.orgA, keyServer.id, `${keyServer.safeName}__whoami`],
    );
    await s.su.query("update app.mcp_servers set status = 'ready' where id = $1", [keyServer.id]);
  });

  it("Víctor creates api_key, basic and client-credentials keys and grants them, with the connectors, to Scout", async () => {
    const host = `fake-mcp:${s.fakePort}`;
    const create = (body: Json) =>
      ok(
        s.victor.request("POST", "/api/v1/keychain", { scope: "personal", allowedHosts: [host], ...body }),
        201,
      );
    keys.api = await create({ kind: "api_key", name: "KC api", value: KC_TOKEN });
    keys.basic = await create({
      kind: "basic",
      name: "KC basic",
      username: KC_BASIC.user,
      password: KC_BASIC.pass,
    });
    keys.client = await create({
      kind: "oauth",
      name: "KC client",
      tokenUrl: `https://${host}/kc/token`,
      clientId: KC_CLIENT.id,
      clientSecret: KC_CLIENT.secret,
    });
    // The fake speaks plain http on loopback; the contract only takes https token URLs (WINDOWS 181).
    await s.su.query("update app.vault_items set token_url = $1 where id = $2", [
      `http://${host}/kc/token`,
      keys.client.id,
    ]);
    for (const k of Object.values(keys)) {
      await ok(s.victor.request("PUT", `/api/v1/keychain/${k.id}/agents`, { agentIds: [scoutId] }));
    }
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
        tools: [
          ...["whoami", "echo_auth"].map((t) => ({
            sourceKind: "mcp",
            sourceId: oauthServer.id,
            tool: `${oauthServer.safeName}__${t}`,
          })),
          { sourceKind: "mcp", sourceId: keyServer.id, tool: `${keyServer.safeName}__whoami` },
        ],
      }),
    );
  });

  it("DM turns call the connector, force a refresh, send the member key and use every key", async () => {
    const safe = oauthServer.safeName as string;
    const ev = await turnOf(s.victor, victorDm);
    const connectorCall = (tool: string, connector = safe) =>
      cell("/connectors/call", { eventId: ev.eventId, agentId: scoutId, connector, tool, arguments: {} });

    expect((await cell("/connectors/list", { eventId: ev.eventId, agentId: scoutId })).status).toBe(200);
    expect((await connectorCall("whoami")).status).toBe(200);
    const echoed = await connectorCall("echo_auth");
    expect(echoed.status).toBe(200);
    expect(echoed.body?.content).toContain("[redacted]");

    // A token the provider no longer accepts (expiry unchanged): one forced refresh and one retry.
    const row = await connectionRow(s, s.victorId, oauthServer.id);
    const bundle = await bundleOf(s, s.orgA, s.victorId, oauthServer.id);
    const { core } = s.stack.built;
    await core.db.withTenant({ organizationId: s.orgA, userId: s.victorId }, (tx) =>
      core.secrets.replaceSealed(
        tx,
        row?.secret_id,
        JSON.stringify({ ...bundle, accessToken: `fakeat_stale_${rand()}` }),
        connectionAad(s.orgA, s.victorId, oauthServer.id),
      ),
    );
    const before = await fakeStats(s);
    const refreshed = await cell("/connectors/call", {
      eventId: (await turnOf(s.victor, victorDm)).eventId,
      agentId: scoutId,
      connector: safe,
      tool: "whoami",
      arguments: {},
    });
    expect(refreshed.status).toBe(200);
    expect((await fakeStats(s)).tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token + 1);

    // The member key goes upstream, is refused twice, and the connection asks to reconnect.
    const keyed = await connectorCall("whoami", keyServer.safeName);
    expect(keyed.status).toBe(409);

    // Every key, through the keychain proxy (a fresh turn: the connector output tainted the first).
    const kt = await turnOf(s.victor, victorDm);
    for (const k of Object.values(keys)) {
      for (const path of ["/kc/whoami", "/kc/echo"]) {
        const r = await cell("/http-requests", {
          eventId: kt.eventId,
          agentId: scoutId,
          handle: k.handle,
          method: "GET",
          url: `http://fake-mcp:${s.fakePort}${path}`,
        });
        expect(r.status, `${k.name} ${path}: ${JSON.stringify(r.body)}`).toBe(200);
        if (path === "/kc/whoami") expect(JSON.parse(r.body?.body as string).authorized).toBe(true);
      }
    }
  });

  it("every member, admin, keychain and template endpoint of the phase is read, and the cell snapshot", async () => {
    const reads: Array<[ConnectorsStack["victor"], string]> = [
      [s.victor, "/api/v1/connectors"],
      [s.sam, "/api/v1/connectors"],
      [s.victor, "/api/v1/member-account-shares"],
      [s.victor, `/api/v1/member-account-shares/preview?conversationId=${victorDm}`],
      [s.victor, "/api/v1/mcp-servers"],
      [s.victor, `/api/v1/mcp-servers/${oauthServer.id}`],
      [s.victor, `/api/v1/mcp-servers/${keyServer.id}`],
      [s.victor, "/api/v1/keychain"],
      [s.victor, "/api/v1/keychain/private-hosts"],
      ...Object.values(keys).map((k): [ConnectorsStack["victor"], string] => [
        s.victor,
        `/api/v1/keychain/${k.id}`,
      ]),
      [s.victor, "/api/v1/agent-templates"],
      [s.victor, "/api/v1/agent-templates/options"],
      [s.victor, `/api/v1/agents/${scoutId}/capabilities`],
      [s.victor, `/api/v1/conversations/${victorDm}/messages`],
      [s.victor, "/api/v1/connectors/oauth/client-metadata.json"],
    ];
    for (const [who, path] of reads) {
      const r = await who.request("GET", path);
      expect([200, 404], `${path}: ${r.status}`).toContain(r.status);
    }
    const snapshot = await cell("/cell", undefined, "GET");
    expect(snapshot.status).toBe(200);
    cellSnapshot = JSON.stringify(snapshot.body);
  });

  it("Víctor disconnects: the grant is revoked at the provider", async () => {
    const before = await fakeStats(s);
    expect((await s.victor.request("DELETE", `/api/v1/connectors/${oauthServer.id}/connection`)).status).toBe(
      204,
    );
    expect((await fakeStats(s)).revocations).toBe(before.revocations + 1);
  });

  // ---------------------------------------------------------------- 07.14-13: the organization's credentials

  /** Replaces the organization's sealed access token of a server with one the provider never issued. */
  async function staleOrgToken(serverId: string) {
    const row = await orgConnectionRow(s, s.orgA, serverId);
    const bundle = await orgBundleOf(s, s.orgA, serverId);
    if (!row?.secret_id || !bundle) throw new Error("no organization bundle");
    const { core } = s.stack.built;
    await core.db.withTenant({ organizationId: s.orgA }, (tx) =>
      core.secrets.replaceSealed(
        tx,
        row.secret_id,
        JSON.stringify({ ...bundle, accessToken: `fakeat_stale_${rand()}` }),
        orgConnectionAad(s.orgA, serverId),
      ),
    );
  }

  it("Víctor connects an org_oauth server for the organization (the flow's verifier and state are kept)", async () => {
    orgServer = await registerOrgConnector(s, { name: "Company CRM" });
    const start = await ok(
      s.victor.request("POST", `/api/v1/connectors/${orgServer.id}/org-connection/connect`),
    );
    const state = new URL(start.authorizeUrl).searchParams.get("state") ?? "";
    const flow = JSON.parse((await s.stack.built.core.bus.pub.get(connectFlowKey(state))) ?? "{}") as Json;
    expect(flow).toMatchObject({ principal: "organization", verifier: expect.any(String) });
    orgFlowSecrets = [state, flow.verifier];
    const done = await callback(s, await authorize(s, start.authorizeUrl), s.victor);
    expect(done.status).toBe(302);
    expect(done.location).toContain(`connected=${orgServer.id}`);
    expect((await orgConnectionRow(s, s.orgA, orgServer.id))?.status).toBe("connected");
  });

  it("Víctor saves client credentials with the client-secret canary", async () => {
    ccServer = await registerCcConnector(s, { name: "Billing API" });
    const saved = await ok(saveCc(s, s.victor, ccServer.id));
    expect(JSON.stringify(saved)).not.toContain(CC_SECRET);
    expect((await orgConnectionRow(s, s.orgA, ccServer.id))?.status).toBe("connected");
  });

  it("Sam's channel turn calls both through the proxy; one forced refresh and one forced re-grant", async () => {
    const caps = await ok(s.victor.request("GET", `/api/v1/agents/${scoutId}/capabilities`));
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
        tools: [
          ...caps.tools
            .filter((t: Json) => t.granted)
            .map((t: Json) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool })),
          ...[orgServer, ccServer].flatMap((srv) =>
            ["whoami", "echo_auth"].map((t) => ({
              sourceKind: "mcp",
              sourceId: srv.id,
              tool: `${srv.safeName}__${t}`,
            })),
          ),
        ],
      }),
    );
    salesId = (
      await ok(s.victor.request("POST", "/api/v1/channels", { name: "sales", visibility: "private" }))
    ).id;
    await ok(s.victor.request("POST", `/api/v1/channels/${salesId}/members`, { kind: "user", id: s.samId }));
    await ok(s.victor.request("POST", `/api/v1/channels/${salesId}/members`, { kind: "agent", id: scoutId }));
    for (const sock of sockets) await subscribe(sock, `conv:${salesId}`);

    const call = (ev: Json, srv: Json, tool = "whoami") =>
      cell("/connectors/call", {
        eventId: ev.eventId,
        agentId: scoutId,
        connector: srv.safeName,
        tool,
        arguments: {},
      });
    const ev = await turnOf(s.sam, salesId, true);
    for (const srv of [orgServer, ccServer]) {
      expect(ev.turn.tools).toEqual(
        expect.arrayContaining([`${srv.safeName}__whoami`, "ocw_connector_call"]),
      );
      const who = await call(ev, srv);
      expect(who.status, JSON.stringify(who.body)).toBe(200);
      expect(JSON.parse(who.body?.content as string).subject).toMatch(/^sub_/u);
      // The provider echoes the Authorization header it received: the proxy redacts the organization's token.
      const echoed = await call(ev, srv, "echo_auth");
      expect(echoed.status, JSON.stringify(echoed.body)).toBe(200);
      expect(echoed.body?.content).toContain("[redacted]");
    }

    // A token the provider no longer accepts: one forced refresh (sign-in) and one forced re-grant (client credentials).
    await staleOrgToken(orgServer.id);
    await staleOrgToken(ccServer.id);
    const before = await fakeStats(s);
    const again = await turnOf(s.sam, salesId, true);
    for (const srv of [orgServer, ccServer]) {
      const r = await call(again, srv);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const after = await fakeStats(s);
    expect(after.tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token + 1);
    expect(after.tokenRequests.client_credentials).toBe(before.tokenRequests.client_credentials + 1);
  });

  it("the organization's endpoints and a Test sign-in with the secret are read; the cell snapshot again", async () => {
    const grants = (await fakeStats(s)).tokenRequests.client_credentials;
    const tested = await ok(
      s.victor.request("POST", "/api/v1/connectors/oauth-test", {
        url: `${s.fakeBase}/mcp-oauth/mcp`,
        authMode: "org_client_credentials",
        clientCredentials: { clientId: PRE_REGISTERED_CC, clientSecret: CC_SECRET },
      }),
    );
    expect(tested).toMatchObject({ ok: true, failure: null });
    expect((await fakeStats(s)).tokenRequests.client_credentials).toBe(grants + 1);
    const reads: Array<[ConnectorsStack["victor"], string]> = [
      [s.victor, "/api/v1/mcp-servers"],
      [s.victor, `/api/v1/mcp-servers/${orgServer.id}`],
      [s.victor, `/api/v1/mcp-servers/${ccServer.id}`],
      [s.sam, "/api/v1/mcp-servers"],
      [s.sam, "/api/v1/connectors"],
      [s.victor, `/api/v1/agents/${scoutId}/capabilities`],
      [s.sam, `/api/v1/conversations/${salesId}/messages`],
    ];
    for (const [who, path] of reads) {
      const r = await who.request("GET", path);
      expect([200, 403, 404], `${path}: ${r.status}`).toContain(r.status);
    }
    const snapshot = await cell("/cell", undefined, "GET");
    expect(snapshot.status).toBe(200);
    cellSnapshot += `\n${JSON.stringify(snapshot.body)}`;
  });

  it("Víctor disconnects the organization's sign-in (revoked at the provider); a confirmed switch destroys the client's", async () => {
    const before = await fakeStats(s);
    expect(
      (await s.victor.request("DELETE", `/api/v1/connectors/${orgServer.id}/org-connection`)).status,
    ).toBe(204);
    expect((await fakeStats(s)).revocations).toBe(before.revocations + 1);
    expect(await orgConnectionRow(s, s.orgA, ccServer.id)).toBeDefined();
    await fails(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${ccServer.id}`, { authMode: "org_secret" }),
      409,
      "org_connection_exists",
    );
    await ok(
      s.victor.request("PATCH", `/api/v1/mcp-servers/${ccServer.id}`, {
        authMode: "org_secret",
        clearConnections: true,
      }),
    );
    expect(await orgConnectionRow(s, s.orgA, orgServer.id)).toBeUndefined();
    expect(await orgConnectionRow(s, s.orgA, ccServer.id)).toBeUndefined();
  });
});

describe("the sweep: no secret of this phase anywhere but the sealed store and the wire to its host", () => {
  let secrets: Map<string, string>;

  beforeAll(async () => {
    // Let the last realtime frames and log lines arrive.
    await new Promise((r) => setTimeout(r, 300));
    const issued = s.fake.issuedTokens();
    secrets = new Map<string, string>([
      ["connector client secret", CONFIDENTIAL_SECRET],
      ["member key", MEMBER_KEY],
      ["vault api_key", KC_TOKEN],
      ["vault basic password", KC_BASIC.pass],
      ["vault client secret", KC_CLIENT.secret],
      ["oauth state", flowSecrets[0] ?? ""],
      ["pkce verifier", flowSecrets[1] ?? ""],
      // 07.14-13: the organization's sign-in flow and its client-credentials secret (D-09).
      ["org client-credentials secret", CC_SECRET],
      ["org oauth state", orgFlowSecrets[0] ?? ""],
      ["org pkce verifier", orgFlowSecrets[1] ?? ""],
      ...issued.access.map((t, i): [string, string] => [`access token #${i}`, t]),
      ...issued.refresh.map((t, i): [string, string] => [`refresh token #${i}`, t]),
      ...issued.codes.map((t, i): [string, string] => [`authorization code #${i}`, t]),
    ]);
    // Real tokens were issued: MCP access and refresh tokens, codes and at least one client-credentials token.
    expect(issued.access.length).toBeGreaterThanOrEqual(3);
    expect(issued.refresh.length).toBeGreaterThanOrEqual(2);
    expect(issued.codes.length).toBeGreaterThanOrEqual(1);
    expect(issued.access.some((t) => t.startsWith("fakekc_"))).toBe(true);
    // 07.14-13: both organization flows ran: two codes (member and organization sign-in), the organization's refresh,
    // and three client-credentials grants (save, re-grant, Test sign-in) on top of the member flow's tokens.
    expect(orgFlowSecrets.every((v) => v.length > 0)).toBe(true);
    expect(issued.codes.length).toBeGreaterThanOrEqual(2);
    expect(issued.refresh.length).toBeGreaterThanOrEqual(4);
    expect((await fakeStats(s)).tokenRequests.client_credentials).toBeGreaterThanOrEqual(3);
    expect(issued.access.filter((t) => t.startsWith("fakeat_")).length).toBeGreaterThanOrEqual(7);
  });

  const STATES = ["oauth state", "org oauth state"];
  const withoutState = () => new Map([...secrets].filter(([name]) => !STATES.includes(name)));

  it("no database text, varchar, array or jsonb column holds one (sealed secrets are bytea)", async () => {
    expect(leaks(await scanDb(), secrets)).toEqual([]);
  });

  it("no audit row holds one", async () => {
    const rows = (await s.su.query("select * from app.audit_events")).rows;
    expect(rows.length).toBeGreaterThan(20);
    expect(leaks(JSON.stringify(rows), secrets)).toEqual([]);
  });

  it("no API response body or header holds one (the state is the authorize URL's own, by design)", () => {
    expect(responses.length).toBeGreaterThan(30);
    expect(leaks(responses.join("\n"), withoutState())).toEqual([]);
    // Each state appears only in its own connect answer's authorize URL (the member's and the organization's).
    for (const state of [flowSecrets[0], orgFlowSecrets[0]]) {
      const withState = responses.filter((r) => formsOf(state ?? "").some((f) => r.includes(f)));
      expect(withState).toHaveLength(1);
      expect(withState[0]).toContain("authorizeUrl");
    }
  });

  it("no WebSocket frame holds one", () => {
    for (const sock of sockets) {
      expect(sock.frames.length, `${sock.who} received frames`).toBeGreaterThan(2);
      expect(leaks(sock.frames.join("\n"), secrets), `${sock.who}'s frames`).toEqual([]);
    }
  });

  it("no Redis key or value left holds one", async () => {
    expect(leaks(await scanRedis(), secrets)).toEqual([]);
  });

  it("no API log line holds one", () => {
    expect(s.logs.length).toBeGreaterThan(50);
    expect(leaks(s.logs.join("\n"), secrets)).toEqual([]);
  });

  it("the cell snapshot holds none, and no per-member or organization-credential connector", () => {
    expect(cellSnapshot.length).toBeGreaterThan(0);
    expect(leaks(cellSnapshot, secrets)).toEqual([]);
    expect(cellSnapshot).not.toContain(oauthServer.safeName);
    expect(cellSnapshot).not.toContain(keyServer.safeName);
    // 07.14 D-04: while connected, neither organization-credential server reaches the cell (probe-fallback
    // prohibition); the snapshot was read before the mode switch.
    expect(cellSnapshot).not.toContain(orgServer.safeName);
    expect(cellSnapshot).not.toContain(ccServer.safeName);
  });
});
