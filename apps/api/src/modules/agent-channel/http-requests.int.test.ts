import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { MAX_TOOL_CALLS_PER_TURN } from "@ocw/contracts";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeMcpOAuth } from "../../../../../infra/fake-model/fake-mcp-oauth.mjs";
import { sha256Hex } from "../../lib/crypto";
import { classifyAddress } from "../../lib/egress";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * Names the egress guard resolves to a chosen address (07.4-03 resolves inside undici's connector with
 * `node:dns/promises`): a public-looking name that answers with a private address, and a LAN ERP name. Every other name
 * resolves as usual.
 */
const dnsStub = vi.hoisted(() => new Map<string, string>());
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = ((host: string, opts?: unknown) => {
    const address = dnsStub.get(host);
    if (address) return Promise.resolve([{ address, family: address.includes(":") ? 6 : 4 }]);
    return (real.lookup as (h: string, o?: unknown) => Promise<unknown>)(host, opts);
  }) as typeof real.lookup;
  return { ...real, default: { ...real, lookup }, lookup };
});

/**
 * 07.4-11 (D-04, D-06, D-07; CONN-05, SC3): the keychain proxy `POST /agent-channel/v1/http-requests`. A bot sends a
 * request with a key named by its handle; the API resolves the key for the turn's bot acting for the turn's human (never
 * a body field), injects it towards an allowed host only through the egress guard, redacts it from the answer and audits
 * `secret.used` without the value, the path or the query. The /kc targets of the fake OAuth server (07.4-04) run
 * in-process on loopback as the test host `fake-kc`. Real PostgreSQL + Redis; no real provider.
 */

const CELL_TOKEN = "ocw-test-cell-token-http-requests-0123456789ab";
const KC_TOKEN = "fake-kc-token";
const SAM_CANARY = "SAM-KC-CANARY-0711";
const QUERY_CANARY = "QUERY-CANARY-0711";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json | null };

let stack: TestStack;
let su: pg.Client;
let fake: Server;
let kcHost = "";
/** Every request the fake received: method and path (the query is kept for the canary checks). */
const hits: Array<{ method: string; path: string }> = [];
/** A private address of this host standing in for a LAN service (the unit-key private-host case). */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal && classifyAddress(a.address) === "private")?.address;
let lan: Server | null = null;
let lanPort = 0;
let lanHits = 0;
/** Every API log line (LOG_LEVEL debug). */
const logs: string[] = [];
/**
 * WINDOWS 175 (the 07.4-05 spy): every outbound request of the proxy goes through the egress guard (undici), never the
 * process-wide `fetch`. The test's own calls to the API under test pass through; any other global `fetch` is recorded,
 * refused, and fails the test that made it.
 */
const realFetch = globalThis.fetch;
const strayFetches: string[] = [];

let victor: TestClient;
let orgId = "";
let victorId = "";
let victorBot = "";
let victorDm = "";
let sam: TestClient;
let samId = "";
let samBot = "";
let scoutId = "";
let samScoutDm = "";

async function ok(res: Promise<Res>, status = 200): Promise<Json> {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function cell(path: string, body: unknown, token = CELL_TOKEN): Promise<Res> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** `who` writes in `conversationId` (mentioning `mention`); returns the delivered event of `agentId` (its turn). */
async function turnOf(
  who: TestClient,
  conversationId: string,
  agentId: string,
  text: string,
  mention: string | null = null,
): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: text,
      ...(mention ? { mentions: [{ kind: "agent", id: mention }] } : {}),
    }),
  );
  const rows = (
    await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${orgId}`, msg.id, agentId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, agent_id, user_id, resource_type, resource_id, result, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

beforeAll(async () => {
  const oauth = createFakeMcpOAuth({ kcToken: KC_TOKEN });
  const serve = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake-kc");
    if (!oauth.handle(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  };
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-kc");
    hits.push({ method: req.method ?? "GET", path: `${url.pathname}${url.search}` });
    serve(req, res);
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  kcHost = `fake-kc:${(fake.address() as AddressInfo).port}`;
  if (lanAddress) {
    const server = createServer((req, res) => {
      lanHits += 1;
      serve(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, lanAddress, resolve));
    lanPort = (server.address() as AddressInfo).port;
    lan = server;
  }

  stack = await startTestStack({
    env: {
      OCW_CELL_TOKEN: CELL_TOKEN,
      OCW_MODEL_PROVIDER: "mock",
      OCW_EGRESS_TEST_HOSTS: "fake-kc=127.0.0.1",
      LOG_LEVEL: "debug",
    },
    logStream: { write: (line: string) => void logs.push(line) },
  });
  const apiBase = stack.baseUrl;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(apiBase)) return realFetch(input, init);
    strayFetches.push(new URL(url).host);
    return Promise.reject(new Error("global fetch called for an outbound request"));
  }) as typeof fetch;
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  victor = new TestClient(stack.baseUrl);
  const setup = await ok(
    victor.request("POST", "/api/v1/setup", {
      token: TEST_SETUP_TOKEN,
      name: "Víctor Ruiz",
      email: "victor@example.test",
      password: "correct-horse-battery",
      orgName: "Autofy Labs",
    }),
  );
  orgId = setup.organization.id;
  victorId = setup.user.id;
  const personal = await ok(victor.request("POST", "/api/v1/agents/personal", {}));
  victorBot = personal.agent.id;
  victorDm = personal.dmId;

  const inv = await ok(
    victor.request("POST", "/api/v1/invitations", { email: "sam@example.test", role: "standard" }),
  );
  sam = new TestClient(stack.baseUrl);
  samId = (
    await ok(
      sam.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
        name: "Sam Lee",
        password: "another-long-password",
      }),
    )
  ).user.id;
  samBot = (await ok(sam.request("POST", "/api/v1/agents/personal", {}))).agent.id;
  scoutId = (
    await ok(
      victor.request("POST", "/api/v1/agents", {
        name: "Scout",
        username: "scout",
        instructions: "You are Scout.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id;
  samScoutDm = (
    await ok(sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] }))
  ).id;
}, 240_000);

afterEach(() => {
  expect(strayFetches, "global fetch used for an outbound request").toEqual([]);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await su?.end();
  await stack?.stop();
  await new Promise<void>((resolve) => (fake ? fake.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (lan ? lan.close(() => resolve()) : resolve()));
});

// ---------------------------------------------------------------- Task 1 (tracer)

describe("tracer: Víctor's bot uses his key by handle in their DM, without ever seeing it", () => {
  let key: Json;
  let ev: Json;
  let answer: Res;

  it("a DM turn offers ocw_http_request once the owner grants his personal key to his bot", async () => {
    key = await ok(
      victor.request("POST", "/api/v1/keychain", {
        scope: "personal",
        kind: "api_key",
        name: "KC whoami",
        value: KC_TOKEN,
        allowedHosts: [kcHost],
      }),
      201,
    );
    await ok(victor.request("PUT", `/api/v1/keychain/${key.id}/agents`, { agentIds: [victorBot] }));
    ev = await turnOf(victor, victorDm, victorBot, "who am I on the CRM?");
    expect(ev.turn.tools).toEqual(expect.arrayContaining(["ocw_http_request", "ocw_connector_list"]));
    expect(ev.turn.toolFlags.ocw_http_request).toEqual({ untrustedOutput: true, sideEffecting: true });
    expect(JSON.stringify(ev)).not.toContain(KC_TOKEN);
  });

  it("POST /http-requests resolves the key for the turn's human, injects it through the guard and answers", async () => {
    answer = await cell("/http-requests", {
      eventId: ev.eventId,
      agentId: victorBot,
      handle: key.handle,
      method: "GET",
      url: `http://${kcHost}/kc/whoami`,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toMatchObject({ status: 200, redirectHost: null, truncated: false });
    expect(JSON.parse(answer.body?.body as string)).toEqual({ authorized: true, method: "bearer" });
    expect(JSON.stringify(answer.body)).not.toContain(KC_TOKEN);
  });

  it("records one allowed vault call and audits secret.used with ids, host and sizes, never value, path or query", async () => {
    const calls = (
      await su.query("select * from app.agent_tool_calls where event_id = $1 order by created_at", [
        ev.eventId,
      ])
    ).rows as Json[];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "ocw_http_request",
      source_kind: "vault",
      source_id: key.id,
      target: kcHost,
      decision: "allowed",
      reason: null,
      status: "ok",
      user_id: victorId,
      agent_id: victorBot,
    });
    const used = (await audits("secret.used")).at(-1);
    expect(used).toMatchObject({
      actor_kind: "agent",
      actor_id: victorBot,
      agent_id: victorBot,
      user_id: victorId,
      resource_type: "vault_item",
      resource_id: key.id,
      result: "success",
      metadata: {
        vaultItemId: key.id,
        handle: key.handle,
        eventId: ev.eventId,
        host: kcHost,
        method: "GET",
        status: 200,
        bytes: expect.any(Number),
        durationMs: expect.any(Number),
      },
    });
    const text = JSON.stringify(await audits("secret.used")) + JSON.stringify(await audits("bot.tool_call"));
    expect(text).not.toContain(KC_TOKEN);
    expect(text).not.toContain("/kc/whoami");
    const completed = (await audits("bot.tool_call.completed")).at(-1);
    expect(completed).toMatchObject({
      result: "success",
      metadata: { tool: "ocw_http_request", status: "ok" },
    });
    expect(JSON.stringify(completed)).not.toContain("/kc/");
  });

  it("the turn is tainted afterwards (the answer is third-party content)", async () => {
    const turn = (
      await su.query("select tainted, tool_calls from app.agent_turns where event_id = $1", [ev.eventId])
    ).rows[0];
    expect(turn).toEqual({ tainted: true, tool_calls: 1 });
  });

  it("the authz registry declares the route as a cell route", () => {
    expect(stack.built.authz.routes.get("POST /agent-channel/v1/http-requests")).toBe("cell");
  });
});

// ---------------------------------------------------------------- Task 3: every refusal

describe("the proxy refuses everything it must", () => {
  let victorKey: Json;
  let samKey: Json;
  let orgKey: Json;
  let channelId = "";

  /** A fresh delivered turn of `agentId` for `who` in `conversationId`. */
  const freshTurn = (who: TestClient, conversationId: string, agentId: string, mention = true) =>
    turnOf(who, conversationId, agentId, mention ? "@scout check it" : "check it", mention ? agentId : null);

  const request = (ev: Json, agentId: string, handle: string, path: string, extra: Json = {}) =>
    cell("/http-requests", {
      eventId: ev.eventId,
      agentId,
      handle,
      method: "GET",
      url: `http://${kcHost}${path}`,
      ...extra,
    });

  const codeOf = (r: Res) => (r.body?.error as Json | undefined)?.code;
  const toolCallsOf = async (eventId: string) =>
    (
      await su.query(
        "select decision, reason, status, source_id from app.agent_tool_calls where event_id = $1",
        [eventId],
      )
    ).rows as Json[];

  beforeAll(async () => {
    victorKey = (await ok(victor.request("GET", "/api/v1/keychain"))).personal.find(
      (k: Json) => k.name === "KC whoami",
    );
    await ok(
      victor.request("PUT", `/api/v1/keychain/${victorKey.id}/agents`, { agentIds: [victorBot, scoutId] }),
    );
    samKey = await ok(
      sam.request("POST", "/api/v1/keychain", {
        scope: "personal",
        kind: "api_key",
        name: "Sam's KC",
        value: SAM_CANARY,
        allowedHosts: [kcHost],
      }),
      201,
    );
    await ok(sam.request("PUT", `/api/v1/keychain/${samKey.id}/agents`, { agentIds: [samBot, scoutId] }));
    orgKey = await ok(
      victor.request("POST", "/api/v1/keychain", {
        scope: "unit",
        unitId: null,
        kind: "api_key",
        name: "Org KC",
        value: KC_TOKEN,
        allowedHosts: [kcHost],
      }),
      201,
    );
    await ok(victor.request("PUT", `/api/v1/keychain/${orgKey.id}/agents`, { agentIds: [scoutId] }));
    channelId = (await ok(victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" })))
      .id;
    await ok(victor.request("POST", `/api/v1/channels/${channelId}/members`, { kind: "user", id: samId }));
    await ok(victor.request("POST", `/api/v1/channels/${channelId}/members`, { kind: "agent", id: scoutId }));
  });

  describe("identity: the turn's human, never the body", () => {
    it("Sam's handle on Víctor's turn: handle_not_allowed (another member's personal key)", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      const before = hits.length;
      const r = await request(ev, victorBot, samKey.handle, "/kc/whoami");
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe("handle_not_allowed");
      expect(hits.length).toBe(before);
      expect(await toolCallsOf(ev.eventId)).toEqual([
        { decision: "denied", reason: "handle_not_allowed", status: null, source_id: null },
      ]);
    });

    it("Víctor's handle on Sam's turn with the same bot: handle_not_allowed", async () => {
      const ev = await freshTurn(sam, samScoutDm, scoutId, false);
      expect(ev.turn.tools).toContain("ocw_http_request");
      const r = await request(ev, scoutId, victorKey.handle, "/kc/whoami");
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe("handle_not_allowed");
      // And Sam's own key works on his turn, as Sam's.
      const own = await request(ev, scoutId, samKey.handle, "/kc/echo");
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body?.body).not.toContain(SAM_CANARY);
      const used = (await audits("secret.used")).at(-1);
      expect(used).toMatchObject({ user_id: samId, agent_id: scoutId, resource_id: samKey.id });
    });

    it("an unknown event or another bot's turn: 403 no_trigger, audited without a human", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      for (const [eventId, agentId] of [
        [randomUUID(), victorBot],
        [ev.eventId, samBot],
      ] as const) {
        const r = await cell("/http-requests", {
          eventId,
          agentId,
          handle: victorKey.handle,
          method: "GET",
          url: `http://${kcHost}/kc/whoami`,
        });
        expect(r.status).toBe(403);
        expect(codeOf(r)).toBe("no_trigger");
      }
      const refused = (await audits("bot.tool_call")).filter((a) => a.metadata.reason === "no_trigger");
      expect(refused.length).toBeGreaterThanOrEqual(2);
      expect(refused.at(-1)).toMatchObject({ actor_kind: "system", user_id: null, result: "denied" });
      expect(await toolCallsOf(ev.eventId)).toEqual([]);
    });

    it("org B's cell token with org A's turn: 403 no_trigger, no call recorded, nothing sent", async () => {
      const orgB = randomUUID();
      await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
        orgB,
        `evil-${orgB}`,
      ]);
      const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
      await su.query(
        "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
        [orgB, sha256Hex(tokenB)],
      );
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      const before = hits.length;
      const r = await cell(
        "/http-requests",
        {
          eventId: ev.eventId,
          agentId: victorBot,
          handle: victorKey.handle,
          method: "GET",
          url: `http://${kcHost}/kc/whoami`,
        },
        tokenB,
      );
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe("no_trigger");
      expect(hits.length).toBe(before);
      expect(await toolCallsOf(ev.eventId)).toEqual([]);
      const orgBAudit = (
        await su.query("select count(*)::int as n from app.audit_events where organization_id = $1", [orgB])
      ).rows[0].n;
      expect(orgBAudit).toBe(1);
    });

    it("once the turn's human no longer reads the conversation: 403 no_trigger", async () => {
      const roomId = (
        await ok(victor.request("POST", "/api/v1/channels", { name: "short-lived", visibility: "private" }))
      ).id;
      await ok(victor.request("POST", `/api/v1/channels/${roomId}/members`, { kind: "user", id: samId }));
      await ok(victor.request("POST", `/api/v1/channels/${roomId}/members`, { kind: "agent", id: scoutId }));
      const ev = await freshTurn(sam, roomId, scoutId);
      expect(ev.turn.tools).toContain("ocw_http_request");
      expect((await request(ev, scoutId, orgKey.handle, "/kc/whoami")).status).toBe(200);
      await su.query("delete from app.conversation_members where conversation_id = $1 and member_id = $2", [
        roomId,
        samId,
      ]);
      const r = await request(ev, scoutId, orgKey.handle, "/kc/whoami");
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe("no_trigger");
    });
  });

  describe("audience: a member's own key only where they alone read the answer, or where they shared it", () => {
    it("Víctor's personal key in a channel turn: 409 member_account; after his share for the channel: 200", async () => {
      const ev = await freshTurn(victor, channelId, scoutId);
      // Offered for the organization key; Víctor's own key is withheld here by name.
      expect(ev.turn.tools).toContain("ocw_http_request");
      expect(ev.turn.withheld).toEqual([
        {
          tool: "ocw_http_request",
          reason: "member_account",
          resource: { kind: "vault_item", id: victorKey.id, name: "KC whoami" },
        },
      ]);
      const before = hits.length;
      const refused = await request(ev, scoutId, victorKey.handle, "/kc/whoami");
      expect(refused.status).toBe(409);
      expect(codeOf(refused)).toBe("member_account");
      expect(hits.length).toBe(before);
      await su.query(
        `insert into app.member_account_shares (organization_id, user_id, conversation_id, resource_kind, resource_id, readers_at_grant)
         values ($1, $2, $3, 'vault_item', $4, 2)`,
        [orgId, victorId, channelId, victorKey.id],
      );
      const allowed = await request(ev, scoutId, victorKey.handle, "/kc/whoami");
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect(JSON.parse(allowed.body?.body as string)).toEqual({ authorized: true, method: "bearer" });
    });
  });

  describe("hosts: only the key's allowed hosts and paths, never a private or platform address it may not reach", () => {
    it("a host outside the key's list: host_not_allowed, nothing sent", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      const before = hits.length;
      const r = await cell("/http-requests", {
        eventId: ev.eventId,
        agentId: victorBot,
        handle: victorKey.handle,
        method: "GET",
        url: "https://attacker.example/collect",
      });
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe("host_not_allowed");
      expect(hits.length).toBe(before);
    });

    it("a path outside the key's prefix: host_not_allowed", async () => {
      await su.query("update app.vault_items set allowed_path_prefix = '/kc/whoami' where id = $1", [
        victorKey.id,
      ]);
      try {
        const ev = await freshTurn(victor, victorDm, victorBot, false);
        const before = hits.length;
        const r = await request(ev, victorBot, victorKey.handle, "/kc/echo");
        expect(r.status).toBe(409);
        expect(codeOf(r)).toBe("host_not_allowed");
        expect(hits.length).toBe(before);
        expect((await request(ev, victorBot, victorKey.handle, "/kc/whoami")).status).toBe(200);
      } finally {
        await su.query("update app.vault_items set allowed_path_prefix = null where id = $1", [victorKey.id]);
      }
    });

    it("a personal key whose host resolves to a private address: 502 egress_refused, audited denied", async () => {
      dnsStub.set("intranet-crm.example", "10.0.0.5");
      const key = await ok(
        victor.request("POST", "/api/v1/keychain", {
          scope: "personal",
          kind: "api_key",
          name: "Rebinding",
          value: "REBIND-CANARY",
          allowedHosts: ["intranet-crm.example"],
        }),
        201,
      );
      await ok(victor.request("PUT", `/api/v1/keychain/${key.id}/agents`, { agentIds: [victorBot] }));
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      const r = await cell("/http-requests", {
        eventId: ev.eventId,
        agentId: victorBot,
        handle: key.handle,
        method: "GET",
        url: "https://intranet-crm.example/api/me",
      });
      expect(r.status).toBe(502);
      expect(codeOf(r)).toBe("egress_refused");
      expect(await toolCallsOf(ev.eventId)).toEqual([
        { decision: "allowed", reason: null, status: "blocked", source_id: key.id },
      ]);
      expect((await audits("secret.used")).at(-1)).toMatchObject({
        resource_id: key.id,
        result: "denied",
        metadata: { host: "intranet-crm.example", status: null },
      });
    });

    it("a unit key on a private host: refused until the admin lists that host, then reached", async () => {
      if (!lanAddress)
        throw new Error("this host has no private IPv4 interface to stand in for a LAN service");
      dnsStub.set("erp.test", lanAddress);
      const erpHost = `erp.test:${lanPort}`;
      const key = await ok(
        victor.request("POST", "/api/v1/keychain", {
          scope: "unit",
          unitId: null,
          kind: "api_key",
          name: "LAN ERP",
          value: KC_TOKEN,
          allowedHosts: [erpHost],
        }),
        201,
      );
      await ok(victor.request("PUT", `/api/v1/keychain/${key.id}/agents`, { agentIds: [scoutId] }));
      const ask = async () => {
        const ev = await freshTurn(victor, channelId, scoutId);
        return cell("/http-requests", {
          eventId: ev.eventId,
          agentId: scoutId,
          handle: key.handle,
          method: "GET",
          url: `http://${erpHost}/kc/whoami`,
        });
      };
      const lanBefore = lanHits;
      const refused = await ask();
      expect(refused.status).toBe(502);
      expect(codeOf(refused)).toBe("egress_refused");
      expect(lanHits).toBe(lanBefore);
      await ok(victor.request("PUT", "/api/v1/keychain/private-hosts", { hosts: [erpHost] }));
      try {
        const reached = await ask();
        expect(reached.status, JSON.stringify(reached.body)).toBe(200);
        expect(JSON.parse(reached.body?.body as string)).toEqual({ authorized: true, method: "bearer" });
        expect(lanHits).toBe(lanBefore + 1);
      } finally {
        await ok(victor.request("PUT", "/api/v1/keychain/private-hosts", { hosts: [] }));
      }
    });

    it("platform hosts (the database by service name and by its test address) are refused even when listed", async () => {
      const db = new URL(stack.built.core.env.DATABASE_URL);
      const testDb = `${db.hostname}:${db.port || "5432"}`;
      const service = "postgres:5432";
      // Listed on the key AND on the admin's private-host list (written directly: the API refuses to list them).
      await su.query("update app.vault_items set allowed_hosts = array[$1, $2] where id = $3", [
        service,
        testDb,
        orgKey.id,
      ]);
      await su.query(
        "update app.bot_policies set egress_private_hosts = array[$1, $2] where organization_id = $3",
        [service, testDb, orgId],
      );
      try {
        for (const target of [service, testDb]) {
          const ev = await freshTurn(victor, channelId, scoutId);
          const r = await cell("/http-requests", {
            eventId: ev.eventId,
            agentId: scoutId,
            handle: orgKey.handle,
            method: "GET",
            url: `http://${target}/`,
          });
          expect(r.status, target).toBe(502);
          expect(codeOf(r), target).toBe("egress_refused");
        }
      } finally {
        await su.query("update app.vault_items set allowed_hosts = array[$1] where id = $2", [
          kcHost,
          orgKey.id,
        ]);
        await su.query("update app.bot_policies set egress_private_hosts = '{}' where organization_id = $1", [
          orgId,
        ]);
      }
    });
  });

  describe("answers: no redirect followed, no header smuggled, no secret echoed, 256 KB at most", () => {
    it("a redirect to the cloud metadata address comes back as its host only and is never followed", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      const before = hits.length;
      const r = await request(ev, victorBot, victorKey.handle, "/kc/redirect");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 302, redirectHost: "169.254.169.254" });
      expect(hits.slice(before)).toEqual([{ method: "GET", path: "/kc/redirect" }]);
    });

    it("model headers that could carry credentials are dropped; the injected key is redacted from the echo", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      const r = await request(ev, victorBot, victorKey.handle, "/kc/echo", {
        headers: { Authorization: "x", Cookie: "y", Accept: "text/plain" },
      });
      expect(r.status).toBe(200);
      expect(r.body?.body).not.toContain(KC_TOKEN);
      const echoed = JSON.parse(r.body?.body as string) as Json;
      expect(echoed.headers.authorization).toBe("[redacted]");
      expect(echoed.headers.cookie).toBeUndefined();
      expect(echoed.headers.accept).toBe("text/plain");
      expect(r.body?.contentType).toMatch(/^application\/json/);
    });

    it("a client-credentials key: the token is fetched through the guard, sent, and redacted with the client secret", async () => {
      const key = await ok(
        victor.request("POST", "/api/v1/keychain", {
          scope: "unit",
          unitId: null,
          kind: "oauth",
          name: "KC client",
          tokenUrl: `https://${kcHost}/kc/token`,
          clientId: "kc-client",
          clientSecret: "kc-secret",
          allowedHosts: [kcHost],
        }),
        201,
      );
      // The fake speaks plain http on loopback; the contract only takes https token URLs (WINDOWS 181).
      await su.query("update app.vault_items set token_url = $1 where id = $2", [
        `http://${kcHost}/kc/token`,
        key.id,
      ]);
      await ok(victor.request("PUT", `/api/v1/keychain/${key.id}/agents`, { agentIds: [scoutId] }));
      const ev = await freshTurn(victor, channelId, scoutId);
      const who = await request(ev, scoutId, key.handle, "/kc/whoami");
      expect(who.status, JSON.stringify(who.body)).toBe(200);
      expect(JSON.parse(who.body?.body as string)).toEqual({
        authorized: true,
        method: "client_credentials",
      });
      const echo = await request(ev, scoutId, key.handle, "/kc/echo");
      const echoed = JSON.parse(echo.body?.body as string) as Json;
      expect(echoed.headers.authorization).toBe("[redacted]");
      expect(echo.body?.body).not.toMatch(/fakekc_|kc-secret/);
    });

    it("a 512 KB body comes back cut at 256 KB, flagged truncated", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      const r = await request(ev, victorBot, victorKey.handle, "/kc/big");
      expect(r.status).toBe(200);
      expect(r.body?.truncated).toBe(true);
      expect(Buffer.byteLength(r.body?.body as string, "utf8")).toBe(256 * 1024);
    });
  });

  describe("taint and caps, claimed like every tool call", () => {
    it("after a GET the turn is tainted: a POST is refused and never sent; reads stay allowed", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      expect((await request(ev, victorBot, victorKey.handle, "/kc/whoami")).status).toBe(200);
      const before = hits.length;
      const r = await request(ev, victorBot, victorKey.handle, "/kc/whoami", { method: "POST", body: "{}" });
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe("tainted");
      expect(hits.length).toBe(before);
      // GET and HEAD change nothing: still allowed on the tainted turn.
      expect((await request(ev, victorBot, victorKey.handle, "/kc/whoami")).status).toBe(200);
      const head = await request(ev, victorBot, victorKey.handle, "/kc/whoami", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.body).toMatchObject({ status: 200, body: "" });
    });

    it("the turn's tool cap: cap_reached", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      await su.query("update app.agent_turns set tool_calls = $1 where event_id = $2", [
        MAX_TOOL_CALLS_PER_TURN,
        ev.eventId,
      ]);
      const r = await request(ev, victorBot, victorKey.handle, "/kc/whoami");
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe("cap_reached");
    });
  });

  describe("records: every use audited without the value, the path or the query; logs carry none of it", () => {
    it("audit rows, tool-call rows and log lines hold no key, no /kc path and no query canary", async () => {
      const ev = await freshTurn(victor, victorDm, victorBot, false);
      const r = await request(ev, victorBot, victorKey.handle, `/kc/whoami?q=${QUERY_CANARY}`);
      expect(r.status).toBe(200);
      const rows = JSON.stringify(
        (
          await su.query(
            "select action, metadata from app.audit_events where organization_id = $1 and action in ('secret.used', 'bot.tool_call', 'bot.tool_call.completed')",
            [orgId],
          )
        ).rows,
      );
      const calls = JSON.stringify((await su.query("select * from app.agent_tool_calls")).rows);
      for (const text of [rows, calls, logs.join("")]) {
        expect(text).not.toContain(KC_TOKEN);
        expect(text).not.toContain(SAM_CANARY);
        expect(text).not.toContain(QUERY_CANARY);
        expect(text).not.toContain("/kc/");
      }
      // Every denial above was recorded too.
      const reasons = new Set(
        (
          await su.query(
            "select metadata->>'reason' as reason from app.audit_events where organization_id = $1 and action = 'bot.tool_call' and result = 'denied'",
            [orgId],
          )
        ).rows.map((x) => x.reason as string),
      );
      for (const reason of [
        "handle_not_allowed",
        "no_trigger",
        "member_account",
        "host_not_allowed",
        "tainted",
        "cap_reached",
      ]) {
        expect(reasons, reason).toContain(reason);
      }
      expect(logs.length).toBeGreaterThan(0);
    });
  });
});
