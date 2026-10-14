import { randomUUID } from "node:crypto";
import { AgentCardRoute, MAX_TOOL_CALLS_PER_TURN } from "@ocw/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
import {
  assertNoGlobalFetch,
  auditRows,
  bundleOf,
  type ConnectorsStack,
  connectionRow,
  connectOAuth,
  fakeStats,
  type Json,
  ok,
  type Res,
  registerConnector,
  startConnectorsStack,
} from "../../testing-connectors";
import { connectionAad, markNeedsReconnect } from "../connectors";

/**
 * 07.4-12 (D-01, D-02, D-03, D-07; CONN-02 … CONN-04, SC2): the connector proxy `POST /agent-channel/v1/connectors/call`
 * and `/connectors/list`. A shared bot acts with the account of the person who asked: the API claims the call against
 * the turn, opens THAT member's token (never the bot owner's, another member's or an org secret) and calls the
 * member's MCP server through the egress guard. Real PostgreSQL + Redis; the fake OAuth-protected MCP server runs
 * in-process and is reached only through the guard (the global fetch is a tripwire, WINDOWS #175).
 */

const CELL_TOKEN = "ocw-test-cell-token-connectors-0123456789abcdef";

let s: ConnectorsStack;
let server: Json;
let safe = "";
let scoutId = "";
let victorDm = "";
let samDm = "";
let alexDm = "";

async function cell(path: string, body: unknown, token = CELL_TOKEN): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

/** `who` writes in `conversationId`; returns Scout's delivered event (its turn). */
async function turnOf(
  who: { request: ConnectorsStack["victor"]["request"] },
  conversationId: string,
  text = "who am I on the CRM?",
  mention = false,
): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: text,
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

const call = (ev: Json, tool = "whoami", args: Json = {}, connector = safe) =>
  cell("/connectors/call", { eventId: ev.eventId, agentId: scoutId, connector, tool, arguments: args });

/** The subject the fake issued to a member's grant: their account label is `<subject>@fake-mcp.test`. */
async function subjectOf(userId: string): Promise<string> {
  const row = await connectionRow(s, userId, server.id);
  return String(row?.account_label ?? "").replace(/@fake-mcp\.test$/u, "");
}

beforeAll(async () => {
  s = await startConnectorsStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
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
  server = await registerConnector(s, { name: "Acme CRM" });
  safe = server.safeName;
  // Víctor connects first: the API-side probe fills the catalog (whoami, create_record, echo_auth).
  expect((await connectOAuth(s, s.victor, server.id)).status).toBe(302);
  expect((await connectOAuth(s, s.sam, server.id)).status).toBe(302);
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
      tools: ["whoami", "create_record", "echo_auth"].map((t) => ({
        sourceKind: "mcp",
        sourceId: server.id,
        tool: `${safe}__${t}`,
      })),
    }),
  );
  victorDm = (
    await ok(s.victor.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] }))
  ).id;
  samDm = (await ok(s.sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] })))
    .id;
  alexDm = (
    await ok(s.alex.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: scoutId }] }))
  ).id;
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
});

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1 (tracer)

describe("tracer: two members ask the same bot and each call uses their own account", () => {
  let victorEv: Json;
  let samEv: Json;
  let victorAnswer: Res;
  let samAnswer: Res;

  it("each member's DM turn offers the logical tool and ocw_connector_call", async () => {
    victorEv = await turnOf(s.victor, victorDm);
    samEv = await turnOf(s.sam, samDm);
    for (const ev of [victorEv, samEv]) {
      expect(ev.turn.tools).toEqual(expect.arrayContaining([`${safe}__whoami`, "ocw_connector_call"]));
    }
  });

  it("POST /connectors/call answers each member with the subject of their own grant", async () => {
    const before = await fakeStats(s);
    victorAnswer = await call(victorEv);
    samAnswer = await call(samEv);
    expect(victorAnswer.status, JSON.stringify(victorAnswer.body)).toBe(200);
    expect(samAnswer.status, JSON.stringify(samAnswer.body)).toBe(200);
    const v = JSON.parse(victorAnswer.body?.content as string);
    const m = JSON.parse(samAnswer.body?.content as string);
    expect(victorAnswer.body).toMatchObject({ isError: false, truncated: false });
    expect(v.subject).toBe(await subjectOf(s.victorId));
    expect(m.subject).toBe(await subjectOf(s.samId));
    expect(v.subject).not.toBe(m.subject);
    expect((await fakeStats(s)).mcpCalls).toBe(before.mcpCalls + 2);
  });

  it("records one allowed mcp call per member, for that member", async () => {
    for (const [ev, userId] of [
      [victorEv, s.victorId],
      [samEv, s.samId],
    ] as const) {
      const rows = (await s.su.query("select * from app.agent_tool_calls where event_id = $1", [ev.eventId]))
        .rows as Json[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tool: `${safe}__whoami`,
        source_kind: "mcp",
        source_id: server.id,
        target: safe,
        decision: "allowed",
        reason: null,
        status: "ok",
        user_id: userId,
        agent_id: scoutId,
      });
    }
  });

  it("audits bot.tool_call (credential member) and bot.tool_call.completed, without arguments or results", async () => {
    const calls = (await auditRows(s, s.orgA, ["bot.tool_call"])).filter(
      (r) => r.metadata.tool === `${safe}__whoami`,
    );
    expect(calls.map((r) => r.user_id).sort()).toEqual([s.victorId, s.samId].sort());
    for (const r of calls) {
      expect(r.metadata).toMatchObject({ credential: "member", sourceKind: "mcp", sourceId: server.id });
    }
    const done = (await auditRows(s, s.orgA, ["bot.tool_call.completed"])).filter(
      (r) => r.metadata.tool === `${safe}__whoami`,
    );
    expect(done).toHaveLength(2);
    for (const r of done) {
      expect(r.metadata).toMatchObject({
        status: "ok",
        durationMs: expect.any(Number),
        credential: "member",
      });
    }
    const text = JSON.stringify([...calls, ...done]);
    expect(text).not.toContain(await subjectOf(s.victorId));
    expect(text).not.toContain(await subjectOf(s.samId));
    expect(text).not.toContain("arguments");
  });

  it("stamps each member's connection as used and taints each turn", async () => {
    expect((await connectionRow(s, s.victorId, server.id))?.last_used_at).not.toBeNull();
    expect((await connectionRow(s, s.samId, server.id))?.last_used_at).not.toBeNull();
    for (const ev of [victorEv, samEv]) {
      const turn = (
        await s.su.query("select tainted, tool_calls from app.agent_turns where event_id = $1", [ev.eventId])
      ).rows[0];
      expect(turn).toEqual({ tainted: true, tool_calls: 1 });
    }
  });

  it("the authz registry declares the route as a cell route", () => {
    expect(s.stack.built.authz.routes.get("POST /agent-channel/v1/connectors/call")).toBe("cell");
  });
});

// ---------------------------------------------------------------- Task 2: refusals, the connect card, refresh, list

const codeOf = (r: Res) => (r.body?.error as Json | undefined)?.code;

const toolCallsOf = async (eventId: string) =>
  (
    await s.su.query(
      "select tool, decision, reason, status, user_id from app.agent_tool_calls where event_id = $1 order by created_at",
      [eventId],
    )
  ).rows as Json[];

/** The cards Scout posted in a conversation (message id, title), oldest first. */
const cardsIn = async (conversationId: string) =>
  (
    await s.su.query(
      `select c.message_id, c.title, c.platform_owned, m.body from app.message_cards c
         join app.messages m on m.id = c.message_id
        where m.conversation_id = $1 and c.agent_id = $2 order by m.created_at`,
      [conversationId, scoutId],
    )
  ).rows as Json[];

/** Replaces the member's sealed access token with one the provider never issued (expiry unchanged): a 401 upstream. */
async function staleAccessToken(userId: string): Promise<string> {
  const row = await connectionRow(s, userId, server.id);
  const bundle = await bundleOf(s, s.orgA, userId, server.id);
  if (!row?.secret_id || !bundle) throw new Error("no bundle");
  const stale = `fakeat_stale_${randomUUID()}`;
  const { core } = s.stack.built;
  await core.db.withTenant({ organizationId: s.orgA, userId }, (tx) =>
    core.secrets.replaceSealed(
      tx,
      row.secret_id,
      JSON.stringify({ ...bundle, accessToken: stale }),
      connectionAad(s.orgA, userId, server.id),
    ),
  );
  return stale;
}

describe("not connected: 409 and one connect card per turn and connector", () => {
  let ev: Json;
  let card: Json;

  it("Alex never connected: 409 not_connected, nothing reaches the connector, nothing claimed", async () => {
    ev = await turnOf(s.alex, alexDm);
    expect(ev.turn.tools).toContain(`${safe}__whoami`);
    const before = await fakeStats(s);
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(codeOf(r)).toBe("not_connected");
    const after = await fakeStats(s);
    expect(after.mcpRequests).toBe(before.mcpRequests);
    expect(after.tokenRequests).toEqual(before.tokenRequests);
    expect(await toolCallsOf(ev.eventId)).toEqual([
      expect.objectContaining({ decision: "denied", reason: "not_connected", user_id: s.alexId }),
    ]);
    const turn = (
      await s.su.query("select tainted, tool_calls from app.agent_turns where event_id = $1", [ev.eventId])
    ).rows[0];
    expect(turn).toEqual({ tainted: false, tool_calls: 0 });
    const refused = (await auditRows(s, s.orgA, ["bot.tool_call"])).at(-1);
    expect(refused).toMatchObject({
      user_id: s.alexId,
      metadata: { reason: "not_connected", credential: "member" },
    });
  });

  it("Scout posted one platform-owned card in Alex's DM, per UI-SPEC § 5", async () => {
    const cards = await cardsIn(alexDm);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.platform_owned).toBe(true);
    expect(cards[0]?.body).toBe(
      "Scout needs your Acme CRM account to do this. Connect it once in Settings, then ask again.",
    );
    card = await ok(s.alex.request("GET", `/api/v1/cards/${cards[0]?.message_id}`));
    expect(card).toMatchObject({
      kind: "generic",
      status: "info",
      title: "Connect your Acme CRM account",
      platformOwned: true,
      fields: [
        {
          label: "How it works",
          value:
            "Scout uses your account only when you ask. Results stay in your private chats unless you allow a conversation.",
        },
      ],
      actions: [{ kind: "open", label: "Connect" }],
    });
  });

  it("the Open target is Settings › Connections for this connector with the way back to the DM", () => {
    const target = card.actions[0].target as string;
    expect(AgentCardRoute.safeParse(target).success).toBe(true);
    const url = new URL(target, "http://app.test");
    expect(url.pathname).toBe("/settings/connections");
    expect(url.searchParams.get("connector")).toBe(server.id);
    expect(url.searchParams.get("return")).toBe(`/chat/dm/${alexDm}?m=${ev.message.id}`);
    expect(target.startsWith(`/settings/connections?connector=${server.id}&return=`)).toBe(true);
  });

  it("asking again in the same turn: 409 again and still one card", async () => {
    const r = await call(ev);
    expect(codeOf(r)).toBe("not_connected");
    expect(await cardsIn(alexDm)).toHaveLength(1);
  });

  it("the bot cannot rewrite the connect card (platform-owned)", async () => {
    const [c] = await cardsIn(alexDm);
    const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1/cards/${c?.message_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${CELL_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: scoutId, patch: { expectedVersion: 1, title: "Paste your password" } }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("card_platform_owned");
  });
});

describe("needs reconnect, an upstream 401 and a dead grant", () => {
  it("a connection marked needs_reconnect: 409 and a Reconnect card", async () => {
    await markNeedsReconnect(s.stack.built.core, {
      organizationId: s.orgA,
      userId: s.victorId,
      serverId: server.id,
      code: "invalid_grant",
    });
    const ev = await turnOf(s.victor, victorDm);
    const r = await call(ev);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("needs_reconnect");
    const last = (await cardsIn(victorDm)).at(-1);
    const card = await ok(s.victor.request("GET", `/api/v1/cards/${last?.message_id}`));
    expect(card).toMatchObject({
      title: "Reconnect your Acme CRM account",
      status: "info",
      fields: [
        {
          label: "What happened",
          value: "Your Acme CRM sign-in stopped working. Reconnect, then ask again.",
        },
      ],
      actions: [{ kind: "open", label: "Reconnect" }],
    });
    expect((await connectOAuth(s, s.victor, server.id)).status).toBe(302);
  });

  it("a dead grant: one refresh attempt, then needs_reconnect (revoked) and the Reconnect card", async () => {
    const ev = await turnOf(s.victor, victorDm);
    s.fake.setScenario({ revoke_all: true });
    const before = await fakeStats(s);
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(codeOf(r)).toBe("needs_reconnect");
    expect((await fakeStats(s)).tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token + 1);
    expect((await connectionRow(s, s.victorId, server.id))?.status).toBe("needs_reconnect");
    const mine = (await ok(s.victor.request("GET", "/api/v1/connectors"))).connectors.find(
      (c: Json) => c.serverId === server.id,
    );
    expect(mine).toMatchObject({ status: "needs_reconnect", reconnectReason: "revoked" });
    const last = (await cardsIn(victorDm)).at(-1);
    expect(last?.title).toBe("Reconnect your Acme CRM account");
    expect(await toolCallsOf(ev.eventId)).toEqual([
      expect.objectContaining({ decision: "allowed", status: "blocked" }),
    ]);
    s.fake.setScenario({});
    // revoke_all ended every grant: both members sign in again for the cases below.
    expect((await connectOAuth(s, s.victor, server.id)).status).toBe(302);
    expect((await connectOAuth(s, s.sam, server.id)).status).toBe(302);
  });

  it("a 401 on a token that still looks valid: one forced refresh, one retry, success", async () => {
    const stale = await staleAccessToken(s.victorId);
    const ev = await turnOf(s.victor, victorDm);
    const before = await fakeStats(s);
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.parse(r.body?.content as string).subject).toBe(await subjectOf(s.victorId));
    const after = await fakeStats(s);
    expect(after.tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token + 1);
    expect(after.mcpCalls).toBe(before.mcpCalls + 1);
    expect((await bundleOf(s, s.orgA, s.victorId, server.id))?.accessToken).not.toBe(stale);
    expect(await toolCallsOf(ev.eventId)).toEqual([
      expect.objectContaining({ decision: "allowed", status: "ok" }),
    ]);
  });

  it("a member key the server refuses: the retry gets 401 again → needs_reconnect (upstream_unauthorized)", async () => {
    const keyed = await ok(
      s.victor.request("POST", "/api/v1/mcp-servers", {
        name: "Notes",
        transport: "streamable-http",
        url: `${s.fakeBase}/mcp-oauth/mcp`,
        authMode: "per_member_secret",
        memberHeaderName: "Authorization",
        memberHeaderPrefix: "Bearer ",
      }),
    );
    // Catalog filled by hand (a probe with this key would fail), so the tool can be granted and offered.
    await s.su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only) values ($1, $2, 'whoami', $3, true)`,
      [s.orgA, keyed.id, `${keyed.safeName}__whoami`],
    );
    await s.su.query("update app.mcp_servers set status = 'ready' where id = $1", [keyed.id]);
    await ok(
      s.victor.request("PUT", `/api/v1/connectors/${keyed.id}/secret`, { value: `bad-key-${randomUUID()}` }),
    );
    const caps = await ok(s.victor.request("GET", `/api/v1/agents/${scoutId}/capabilities`));
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
        tools: [
          ...caps.tools
            .filter((t: Json) => t.granted)
            .map((t: Json) => ({
              sourceKind: t.sourceKind,
              sourceId: t.sourceId,
              tool: t.tool,
            })),
          { sourceKind: "mcp", sourceId: keyed.id, tool: `${keyed.safeName}__whoami` },
        ],
      }),
    );
    const ev = await turnOf(s.victor, victorDm);
    expect(ev.turn.tools).toContain(`${keyed.safeName}__whoami`);
    const before = await fakeStats(s);
    const r = await call(ev, "whoami", {}, keyed.safeName);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(codeOf(r)).toBe("needs_reconnect");
    expect((await fakeStats(s)).tokenRequests).toEqual(before.tokenRequests);
    expect(await connectionRow(s, s.victorId, keyed.id)).toMatchObject({
      status: "needs_reconnect",
      last_error: "upstream_unauthorized",
    });
    const mine = (await ok(s.victor.request("GET", "/api/v1/connectors"))).connectors.find(
      (c: Json) => c.serverId === keyed.id,
    );
    expect(mine).toMatchObject({ reconnectReason: "revoked" });
    const last = (await cardsIn(victorDm)).at(-1);
    expect(last?.title).toBe("Reconnect your Notes account");
  });

  it("insufficient_scope: an error result naming the missing permissions, never a token", async () => {
    const ev = await turnOf(s.victor, victorDm);
    s.fake.setScenario({ insufficient_scope: true });
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ isError: true, truncated: false });
    expect(r.body?.content).toContain("missing a permission");
    expect(r.body?.content).toContain("records:write");
    expect(r.body?.content).not.toMatch(/fakeat_|fakert_|Bearer/u);
    expect((await auditRows(s, s.orgA, ["bot.tool_call.completed"])).at(-1)?.metadata).toMatchObject({
      status: "error",
      reason: "insufficient_scope",
    });
    expect(await toolCallsOf(ev.eventId)).toEqual([
      expect.objectContaining({ decision: "allowed", status: "error" }),
    ]);
  });
});

describe("the audience rule and the re-decision at call time", () => {
  let channelId = "";
  let shareId = "";
  let sharedEv: Json;

  it("a channel turn withholds Víctor's connector; a forged call is refused member_account", async () => {
    channelId = (
      await ok(s.victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }))
    ).id;
    await ok(
      s.victor.request("POST", `/api/v1/channels/${channelId}/members`, { kind: "user", id: s.samId }),
    );
    await ok(
      s.victor.request("POST", `/api/v1/channels/${channelId}/members`, { kind: "agent", id: scoutId }),
    );
    const ev = await turnOf(s.victor, channelId, "@scout who am I on the CRM?", true);
    expect(ev.turn.tools).not.toContain(`${safe}__whoami`);
    expect(ev.turn.withheld).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "member_account",
          resource: expect.objectContaining({ id: server.id }),
        }),
      ]),
    );
    const before = await fakeStats(s);
    const r = await call(ev);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("member_account");
    expect((await fakeStats(s)).mcpRequests).toBe(before.mcpRequests);
    // A member-account refusal posts no card (UI-SPEC § 5: the persona explains it).
    expect(await cardsIn(channelId)).toEqual([]);
  });

  it("once Víctor allows his account in #ops, a new turn there calls it with his account", async () => {
    shareId = (
      await ok(
        s.victor.request("POST", "/api/v1/member-account-shares", {
          conversationId: channelId,
          resourceKind: "connector",
          resourceId: server.id,
        }),
        201,
      )
    ).id;
    sharedEv = await turnOf(s.victor, channelId, "@scout who am I on the CRM?", true);
    expect(sharedEv.turn.tools).toContain(`${safe}__whoami`);
    const r = await call(sharedEv);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.parse(r.body?.content as string).subject).toBe(await subjectOf(s.victorId));
  });

  it("revoking the share bites within the same turn: policy_changed", async () => {
    await ok(s.victor.request("DELETE", `/api/v1/member-account-shares/${shareId}`), 204);
    const r = await call(sharedEv);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("policy_changed");
  });

  it("removing the bot's grant after delivery: policy_changed; the cap: cap_reached", async () => {
    const ev = await turnOf(s.victor, victorDm);
    const caps = await ok(s.victor.request("GET", `/api/v1/agents/${scoutId}/capabilities`));
    const granted = caps.tools
      .filter((t: Json) => t.granted)
      .map((t: Json) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool }));
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
        tools: granted.filter((t: Json) => t.tool !== `${safe}__whoami`),
      }),
    );
    const r = await call(ev);
    expect(codeOf(r)).toBe("policy_changed");
    await ok(s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, { tools: granted }));

    const capped = await turnOf(s.victor, victorDm);
    await s.su.query("update app.agent_turns set tool_calls = $2 where event_id = $1", [
      capped.eventId,
      MAX_TOOL_CALLS_PER_TURN,
    ]);
    const c = await call(capped);
    expect(c.status).toBe(409);
    expect(codeOf(c)).toBe("cap_reached");
  });

  it("a side-effecting tool after the turn read untrusted content: tainted, and nothing is sent", async () => {
    const ev = await turnOf(s.victor, victorDm);
    expect((await call(ev)).status).toBe(200);
    const before = await fakeStats(s);
    const r = await call(ev, "create_record", { title: "From a tainted turn" });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("tainted");
    expect((await fakeStats(s)).mcpRequests).toBe(before.mcpRequests);
  });
});

describe("identity: the turn decides, never the body", () => {
  it("an unknown event, another bot or an unknown tool: refused and audited", async () => {
    const ev = await turnOf(s.victor, victorDm);
    const victorBot = (await ok(s.victor.request("POST", "/api/v1/agents/personal", {}))).agent.id;
    for (const [eventId, agentId] of [
      [randomUUID(), scoutId],
      [ev.eventId, victorBot],
    ] as const) {
      const r = await cell("/connectors/call", {
        eventId,
        agentId,
        connector: safe,
        tool: "whoami",
        arguments: {},
      });
      expect(r.status).toBe(403);
      expect(codeOf(r)).toBe("no_trigger");
    }
    const unknownTool = await call(ev, "drop_tables");
    expect(codeOf(unknownTool)).toBe("not_in_turn");
    const refused = (await auditRows(s, s.orgA, ["bot.tool_call"])).filter(
      (a) => a.metadata.reason === "no_trigger",
    );
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(await toolCallsOf(ev.eventId)).toEqual([
      expect.objectContaining({ decision: "denied", reason: "not_in_turn" }),
    ]);
  });

  it("org B's cell token with org A's turn: 403, nothing recorded in org A, nothing sent", async () => {
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await s.su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [s.orgB, sha256Hex(tokenB)],
    );
    const ev = await turnOf(s.victor, victorDm);
    const before = await fakeStats(s);
    for (const path of ["/connectors/call", "/connectors/list"]) {
      const r = await cell(
        path,
        { eventId: ev.eventId, agentId: scoutId, connector: safe, tool: "whoami", arguments: {} },
        tokenB,
      );
      expect(r.status, path).toBe(403);
      expect(codeOf(r)).toBe("no_trigger");
    }
    expect((await fakeStats(s)).mcpRequests).toBe(before.mcpRequests);
    expect(await toolCallsOf(ev.eventId)).toEqual([]);
    const orgBAudit = (
      await s.su.query("select count(*)::int as n from app.audit_events where organization_id = $1", [s.orgB])
    ).rows[0].n;
    expect(orgBAudit).toBeGreaterThanOrEqual(2);
  });
});

describe("POST /connectors/list", () => {
  it("lists the asker's connectors, tools with schemas and status, and the bot's keys; never a credential", async () => {
    const key = await ok(
      s.victor.request("POST", "/api/v1/keychain", {
        scope: "personal",
        kind: "api_key",
        name: "Victor KC",
        value: `kc-canary-${randomUUID()}`,
        allowedHosts: [`fake-mcp:${s.fakePort}`],
      }),
      201,
    );
    await ok(s.victor.request("PUT", `/api/v1/keychain/${key.id}/agents`, { agentIds: [scoutId] }));
    const ev = await turnOf(s.victor, victorDm);
    const r = await cell("/connectors/list", { eventId: ev.eventId, agentId: scoutId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const crm = r.body?.connectors.find((c: Json) => c.connector === safe);
    expect(crm).toMatchObject({ name: "Acme CRM", status: "connected" });
    expect(crm.tools.map((t: Json) => t.name).sort()).toEqual(["create_record", "echo_auth", "whoami"]);
    for (const t of crm.tools) expect(t.inputSchema).toMatchObject({ type: "object" });
    expect(r.body?.keys).toEqual([
      { handle: key.handle, name: "Victor KC", allowedHosts: [`fake-mcp:${s.fakePort}`] },
    ]);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/fakeat_|fakert_|kc-canary-|Bearer/u);
    // Claimed like a tool: listing third-party descriptions taints the turn.
    expect(await toolCallsOf(ev.eventId)).toEqual([
      expect.objectContaining({ tool: "ocw_connector_list", decision: "allowed", status: "ok" }),
    ]);
    const turn = (await s.su.query("select tainted from app.agent_turns where event_id = $1", [ev.eventId]))
      .rows[0];
    expect(turn.tainted).toBe(true);
  });

  it("Alex's turn lists the connector as not connected", async () => {
    const ev = await turnOf(s.alex, alexDm);
    const r = await cell("/connectors/list", { eventId: ev.eventId, agentId: scoutId });
    expect(r.status).toBe(200);
    expect(r.body?.connectors.find((c: Json) => c.connector === safe)).toMatchObject({
      status: "not_connected",
    });
    expect(r.body?.keys).toEqual([]);
  });

  it("the authz registry declares the route as a cell route", () => {
    expect(s.stack.built.authz.routes.get("POST /agent-channel/v1/connectors/list")).toBe("cell");
  });
});

// ---------------------------------------------------------------- unit keys follow the audience rule (WINDOWS #191)

describe("unit keys: only where every reader is inside the unit; organization keys everywhere", () => {
  let unitKey: Json;
  let orgKey: Json;
  let salesRoom = "";
  let general = "";
  const kcUrl = () => `http://fake-mcp:${s.fakePort}/kc/whoami`;
  const httpCall = (ev: Json, handle: string) =>
    cell("/http-requests", { eventId: ev.eventId, agentId: scoutId, handle, method: "GET", url: kcUrl() });
  const listKeys = async (ev: Json) =>
    ((await ok(cell("/connectors/list", { eventId: ev.eventId, agentId: scoutId }))).keys as Json[]).map(
      (k) => k.handle,
    );

  beforeAll(async () => {
    const sales = (
      await ok(
        s.victor.request("POST", "/api/v1/units", { kind: "department", name: "Sales", parentId: null }),
      )
    ).id as string;
    await ok(s.victor.request("POST", `/api/v1/units/${sales}/members`, { userId: s.samId }));
    const key = (name: string, unitId: string | null) =>
      ok(
        s.victor.request("POST", "/api/v1/keychain", {
          scope: "unit",
          unitId,
          kind: "api_key",
          name,
          value: "fake-kc-token",
          allowedHosts: [`fake-mcp:${s.fakePort}`],
        }),
        201,
      );
    unitKey = await key("Sales ERP", sales);
    orgKey = await key("Company ERP", null);
    for (const k of [unitKey, orgKey]) {
      await ok(s.victor.request("PUT", `/api/v1/keychain/${k.id}/agents`, { agentIds: [scoutId] }));
    }
    // #sales-room: Sam (Sales) and Víctor (an admin: in every unit's audience). #general: public, Alex reads it.
    salesRoom = (
      await ok(s.victor.request("POST", "/api/v1/channels", { name: "sales-room", visibility: "private" }))
    ).id;
    general = (
      await ok(s.victor.request("POST", "/api/v1/channels", { name: "general", visibility: "public" }))
    ).id;
    for (const ch of [salesRoom, general]) {
      await ok(s.victor.request("POST", `/api/v1/channels/${ch}/members`, { kind: "user", id: s.samId }));
      await ok(s.victor.request("POST", `/api/v1/channels/${ch}/members`, { kind: "agent", id: scoutId }));
    }
    await ok(s.victor.request("POST", `/api/v1/channels/${general}/members`, { kind: "user", id: s.alexId }));
  });

  it("Sam's DM with Scout: the unit key is listed and used", async () => {
    const ev = await turnOf(s.sam, samDm);
    expect(await listKeys(ev)).toEqual(expect.arrayContaining([unitKey.handle, orgKey.handle]));
    const r = await httpCall(ev, unitKey.handle);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.parse(r.body?.body as string)).toEqual({ authorized: true, method: "bearer" });
  });

  it("a private channel whose readers are all inside Sales: allowed", async () => {
    const ev = await turnOf(s.sam, salesRoom, "@scout check the ERP", true);
    expect(await listKeys(ev)).toContain(unitKey.handle);
    expect((await httpCall(ev, unitKey.handle)).status).toBe(200);
  });

  it("a public channel (Alex, outside Sales, reads it): refused unit_audience; the org key still works", async () => {
    const ev = await turnOf(s.sam, general, "@scout check the ERP", true);
    const keys = await listKeys(ev);
    expect(keys).not.toContain(unitKey.handle);
    expect(keys).toContain(orgKey.handle);
    const r = await httpCall(ev, unitKey.handle);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("unit_audience");
    expect((await httpCall(ev, orgKey.handle)).status).toBe(200);
    const refused = (await auditRows(s, s.orgA, ["bot.tool_call"])).at(-2);
    expect(refused?.metadata).toMatchObject({ reason: "unit_audience", sourceId: unitKey.id });
  });

  it("an outsider joining the private channel mid-turn: the next call is refused unit_audience", async () => {
    const ev = await turnOf(s.sam, salesRoom, "@scout check the ERP", true);
    await ok(
      s.victor.request("POST", `/api/v1/channels/${salesRoom}/members`, { kind: "user", id: s.alexId }),
    );
    const r = await httpCall(ev, unitKey.handle);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("unit_audience");
  });
});
