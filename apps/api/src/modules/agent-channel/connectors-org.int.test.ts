import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoGlobalFetch,
  auditRows,
  CC_SECRET,
  type ConnectorsStack,
  connectOrgOAuth,
  fakeStats,
  type Json,
  ok,
  orgBundleOf,
  orgConnectionRow,
  PRE_REGISTERED_CC,
  type Res,
  registerCcConnector,
  registerOrgConnector,
  saveCc,
  startConnectorsStack,
} from "../../testing-connectors";
import { markNeedsReconnect, orgConnectionAad } from "../connectors";

/**
 * 07.14-08 (D-04, D-05, D-07, D-08, D-13; COA-01, COA-03, COA-05): the connector proxy with the organization's account.
 * An admin connects an `org_oauth` server once (07's real route); every member's bot then calls its tools through
 * `POST /agent-channel/v1/connectors/call` with the ORGANIZATION's token, chosen from the server's stored mode (never a
 * body field, never a member's own credential), audited `credential: "organization"`, and the token never reaches the
 * cell. Real PostgreSQL + Redis; the fake OAuth-protected MCP server in-process, reached only through the egress guard
 * (the global fetch is a tripwire, WINDOWS #175).
 */

const CELL_TOKEN = "ocw-test-cell-token-connectors-org-0123456789abcd";

let s: ConnectorsStack;
let server: Json;
let safe = "";
let scoutId = "";
let opsId = "";
let alexDm = "";

async function cell(method: "GET" | "POST", path: string, body?: unknown): Promise<Res> {
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

/** `who` writes in `conversationId` (mentioning Scout when asked); returns Scout's delivered event (its turn). */
async function turnOf(
  who: { request: ConnectorsStack["victor"]["request"] },
  conversationId: string,
  mention = false,
  text = "who are we on the drive?",
): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: mention ? `@scout ${text}` : text,
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
  cell("POST", "/connectors/call", {
    eventId: ev.eventId,
    agentId: scoutId,
    connector,
    tool,
    arguments: args,
  });

const codeOf = (r: Res) => (r.body?.error as Json | undefined)?.code;

/** The subject the fake issued to the organization's grant: its account label is `<subject>@fake-mcp.test`. */
async function orgSubjectOf(serverId: string): Promise<string> {
  const row = await orgConnectionRow(s, s.orgA, serverId);
  return String(row?.account_label ?? "").replace(/@fake-mcp\.test$/u, "");
}

const memberConnectionsOf = async (serverId: string) =>
  (
    await s.su.query("select count(*)::int as n from app.connector_connections where server_id = $1", [
      serverId,
    ])
  ).rows[0].n as number;

/** The granted tools of Scout, plus `extra` (a PATCH replaces the whole set). */
async function grant(extra: { sourceId: string; tool: string }[]): Promise<void> {
  const caps = await ok(s.victor.request("GET", `/api/v1/agents/${scoutId}/capabilities`));
  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${scoutId}/capabilities`, {
      tools: [
        ...caps.tools
          .filter((t: Json) => t.granted)
          .map((t: Json) => ({ sourceKind: t.sourceKind, sourceId: t.sourceId, tool: t.tool })),
        ...extra.map((t) => ({ sourceKind: "mcp", ...t })),
      ],
    }),
  );
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
  // Víctor (admin) registers the organization's sign-in server and connects it once: the probe fills the catalog
  // with the organization's token.
  server = await registerOrgConnector(s, { name: "Acme Drive" });
  safe = server.safeName;
  expect((await connectOrgOAuth(s, s.victor, server.id)).status).toBe(302);
  await grant(
    ["whoami", "create_record", "echo_auth"].map((t) => ({ sourceId: server.id, tool: `${safe}__${t}` })),
  );

  opsId = (await ok(s.victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }))).id;
  for (const id of [s.samId, s.alexId]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "user", id }));
  }
  await ok(s.victor.request("POST", `/api/v1/channels/${opsId}/members`, { kind: "agent", id: scoutId }));
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

describe("tracer: every member's bot uses the organization's account", () => {
  let samEv: Json;
  let alexEv: Json;

  it("Sam asks Scout in #ops (three readers): the turn carries the logical tool and ocw_connector_call", async () => {
    samEv = await turnOf(s.sam, opsId, true);
    expect(samEv.turn.tools).toEqual(expect.arrayContaining([`${safe}__whoami`, "ocw_connector_call"]));
    expect(JSON.stringify(samEv.turn.withheld ?? [])).not.toContain("member_account");
  });

  it("the call runs with the organization's grant, for Sam in #ops and for Alex in his DM", async () => {
    const before = await fakeStats(s);
    const samAnswer = await call(samEv);
    expect(samAnswer.status, JSON.stringify(samAnswer.body)).toBe(200);
    expect(samAnswer.body).toMatchObject({ isError: false, truncated: false });
    const orgSubject = await orgSubjectOf(server.id);
    expect(orgSubject).not.toBe("");
    expect(JSON.parse(samAnswer.body?.content as string).subject).toBe(orgSubject);

    alexEv = await turnOf(s.alex, alexDm);
    const alexAnswer = await call(alexEv);
    expect(alexAnswer.status, JSON.stringify(alexAnswer.body)).toBe(200);
    expect(JSON.parse(alexAnswer.body?.content as string).subject).toBe(orgSubject);
    expect((await fakeStats(s)).mcpCalls).toBe(before.mcpCalls + 2);
    // No member's own credential exists for, or was made for, an org-mode server.
    expect(await memberConnectionsOf(server.id)).toBe(0);
  });

  it("records one allowed mcp call per turn, for the member who asked", async () => {
    for (const [ev, userId] of [
      [samEv, s.samId],
      [alexEv, s.alexId],
    ] as const) {
      const rows = (await s.su.query("select * from app.agent_tool_calls where event_id = $1", [ev.eventId]))
        .rows as Json[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tool: `${safe}__whoami`,
        source_kind: "mcp",
        source_id: server.id,
        decision: "allowed",
        status: "ok",
        user_id: userId,
      });
    }
  });

  it("audits bot.tool_call and bot.tool_call.completed with credential organization, no arguments or results", async () => {
    const calls = (await auditRows(s, s.orgA, ["bot.tool_call"])).filter(
      (r) => r.metadata.tool === `${safe}__whoami`,
    );
    expect(calls.map((r) => r.user_id).sort()).toEqual([s.samId, s.alexId].sort());
    for (const r of calls) {
      expect(r.metadata).toMatchObject({
        credential: "organization",
        sourceKind: "mcp",
        sourceId: server.id,
      });
    }
    const done = (await auditRows(s, s.orgA, ["bot.tool_call.completed"])).filter(
      (r) => r.metadata.tool === `${safe}__whoami`,
    );
    expect(done).toHaveLength(2);
    for (const r of done) expect(r.metadata).toMatchObject({ status: "ok", credential: "organization" });
    const text = JSON.stringify([...calls, ...done]);
    expect(text).not.toContain(await orgSubjectOf(server.id));
    expect(text).not.toContain("arguments");
    expect(text).not.toMatch(/fakeat_|fakert_|Bearer/u);
  });

  it("stamps the organization connection as used", async () => {
    expect((await orgConnectionRow(s, s.orgA, server.id))?.last_used_at).not.toBeNull();
  });

  it("the cell never sees the organization's server or token", async () => {
    const snapshot = await cell("GET", "/cell");
    expect(snapshot.status).toBe(200);
    expect(((snapshot.body?.mcpServers ?? []) as Json[]).map((m) => m.id)).not.toContain(server.id);
    const scout = ((snapshot.body?.agents ?? []) as Json[]).find((a) => a.id === scoutId);
    const tools = scout?.capabilities.tools as string[];
    expect(tools).toEqual(expect.arrayContaining(["ocw_connector_call", "ocw_connector_list"]));
    expect(tools.filter((t) => t.startsWith(`${safe}__`))).toEqual([]);
    const bundle = await orgBundleOf(s, s.orgA, server.id);
    expect(bundle?.accessToken).toEqual(expect.any(String));
    const text = JSON.stringify(snapshot.body);
    expect(text).not.toContain(bundle?.accessToken);
    if (bundle?.refreshToken) expect(text).not.toContain(bundle.refreshToken);
    expect(text).not.toMatch(/fakeat_|fakert_/u);
  });
});

// ---------------------------------------------------------------- Task 2: the list and per-tool approvals

const list = (ev: Json) => cell("POST", "/connectors/list", { eventId: ev.eventId, agentId: scoutId });
const listed = (r: Res) => (r.body?.connectors as Json[] | undefined)?.find((c) => c.connector === safe);

describe("ocw_connector_list and per-tool approvals on the organization's account", () => {
  it("ocw_connector_list lists the organization connector as connected for every asker", async () => {
    for (const [who, conversation, mention] of [
      [s.sam, opsId, true],
      [s.alex, alexDm, false],
    ] as const) {
      const r = await list(await turnOf(who, conversation, mention));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(listed(r)).toMatchObject({ name: "Acme Drive", status: "connected" });
      expect(((listed(r)?.tools ?? []) as Json[]).map((t) => t.name).sort()).toEqual([
        "create_record",
        "echo_auth",
        "whoami",
      ]);
      expect(JSON.stringify(r.body)).not.toMatch(/fakeat_|fakert_|Bearer/u);
    }
  });

  it("a per-tool approval rule asks before any token is read or anything is sent", async () => {
    await s.su.query(
      `insert into app.tool_approval_policies
         (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
       values ($1, null, $2, 'always', 'requester', '{}', $3, $3)`,
      [s.orgA, `${safe}__*`, s.victorId],
    );
    try {
      const ev = await turnOf(s.sam, opsId, true);
      expect(ev.turn.toolFlags[`${safe}__whoami`]).toMatchObject({ approval: "always" });
      const usedBefore = (await orgConnectionRow(s, s.orgA, server.id))?.last_used_at;
      const before = await fakeStats(s);
      const r = await call(ev);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(codeOf(r)).toBe("approval_required");
      const after = await fakeStats(s);
      expect(after.mcpRequests).toBe(before.mcpRequests);
      expect(after.tokenRequests).toEqual(before.tokenRequests);
      expect((await orgConnectionRow(s, s.orgA, server.id))?.last_used_at).toEqual(usedBefore);
      // The organization's MCP tool, never "your account".
      const id = r.body?.error.details.approval.id as string;
      const detail = await ok(s.sam.request("GET", `/api/v1/approvals/${id}`));
      expect(detail.view.source).toMatchObject({ kind: "mcp", account: "org" });
    } finally {
      await s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);
    }
  });

  it("after Disconnect the list says not_connected; connecting again lists it connected", async () => {
    await ok(s.victor.request("DELETE", `/api/v1/connectors/${server.id}/org-connection`), 204);
    const r = await list(await turnOf(s.alex, alexDm));
    expect(r.status).toBe(200);
    expect(listed(r)).toMatchObject({ status: "not_connected" });
    expect((await connectOrgOAuth(s, s.victor, server.id)).status).toBe(302);
    expect(listed(await list(await turnOf(s.alex, alexDm)))).toMatchObject({ status: "connected" });
  });
});

// ---------------------------------------------------------------- Task 3: the organization's failure paths

/** Every card Scout posted in a conversation (a member's connect card would be one). */
const cardCount = async (conversationId: string) =>
  (
    await s.su.query(
      `select count(*)::int as n from app.message_cards c join app.messages m on m.id = c.message_id
        where m.conversation_id = $1 and c.agent_id = $2`,
      [conversationId, scoutId],
    )
  ).rows[0].n as number;

const toolCallsOf = async (eventId: string) =>
  (
    await s.su.query(
      "select decision, reason, status from app.agent_tool_calls where event_id = $1 order by created_at",
      [eventId],
    )
  ).rows as Json[];

const NEEDS_RECONNECT = "The organization's connection to Acme Drive needs to be reconnected by an admin.";

/** Replaces the organization's sealed access token with one the provider never issued (expiry unchanged). */
async function staleOrgAccessToken(): Promise<string> {
  const row = await orgConnectionRow(s, s.orgA, server.id);
  const bundle = await orgBundleOf(s, s.orgA, server.id);
  if (!row?.secret_id || !bundle) throw new Error("no organization bundle");
  const stale = `fakeat_stale_${randomUUID()}`;
  const { core } = s.stack.built;
  await core.db.withTenant({ organizationId: s.orgA }, (tx) =>
    core.secrets.replaceSealed(
      tx,
      row.secret_id,
      JSON.stringify({ ...bundle, accessToken: stale }),
      orgConnectionAad(s.orgA, server.id),
    ),
  );
  return stale;
}

describe("the organization's failures: the admin's sentence, never a connect card", () => {
  it("an org server never connected: 409 not_connected with the organization sentence, no card, nothing sent", async () => {
    const lone = await registerOrgConnector(s, { name: "Team Wiki" });
    // Probed by hand (a probe needs the organization's token): the catalog and a ready server.
    await s.su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only) values ($1, $2, 'whoami', $3, true)`,
      [s.orgA, lone.id, `${lone.safeName}__whoami`],
    );
    await s.su.query("update app.mcp_servers set status = 'ready' where id = $1", [lone.id]);
    await grant([{ sourceId: lone.id, tool: `${lone.safeName}__whoami` }]);

    const ev = await turnOf(s.alex, alexDm);
    expect(ev.turn.tools).toContain(`${lone.safeName}__whoami`);
    const cards = await cardCount(alexDm);
    const before = await fakeStats(s);
    const r = await call(ev, "whoami", {}, lone.safeName);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body?.error).toMatchObject({
      code: "not_connected",
      message:
        "The organization hasn't connected Team Wiki yet. An admin can connect it in Settings › MCP servers.",
    });
    expect(await cardCount(alexDm)).toBe(cards);
    const after = await fakeStats(s);
    expect(after.mcpRequests).toBe(before.mcpRequests);
    expect(after.tokenRequests).toEqual(before.tokenRequests);
    expect(await toolCallsOf(ev.eventId)).toEqual([
      expect.objectContaining({ decision: "denied", reason: "not_connected" }),
    ]);
    const turn = (
      await s.su.query("select tainted, tool_calls from app.agent_turns where event_id = $1", [ev.eventId])
    ).rows[0];
    expect(turn).toEqual({ tainted: false, tool_calls: 0 });
    expect((await auditRows(s, s.orgA, ["bot.tool_call"])).at(-1)).toMatchObject({
      user_id: s.alexId,
      metadata: { reason: "not_connected", credential: "organization" },
    });
    expect(await memberConnectionsOf(lone.id)).toBe(0);
  });

  it("an organization connection marked needs_reconnect: 409 with the admin sentence, no card, nothing sent", async () => {
    await markNeedsReconnect(s.stack.built.core, {
      organizationId: s.orgA,
      serverId: server.id,
      principal: "organization",
      actingUserId: s.victorId,
      code: "invalid_grant",
    });
    const ev = await turnOf(s.sam, opsId, true);
    const cards = await cardCount(opsId);
    const before = await fakeStats(s);
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body?.error).toMatchObject({ code: "needs_reconnect", message: NEEDS_RECONNECT });
    expect(await cardCount(opsId)).toBe(cards);
    expect((await fakeStats(s)).mcpRequests).toBe(before.mcpRequests);
    expect((await connectOrgOAuth(s, s.victor, server.id)).status).toBe(302);
  });

  it("a dead grant: one refresh attempt, then needs_reconnect for the organization, audited, no card", async () => {
    const ev = await turnOf(s.alex, alexDm);
    const cards = await cardCount(alexDm);
    s.fake.setScenario({ revoke_all: true });
    const before = await fakeStats(s);
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body?.error).toMatchObject({ code: "needs_reconnect", message: NEEDS_RECONNECT });
    expect((await fakeStats(s)).tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token + 1);
    expect((await orgConnectionRow(s, s.orgA, server.id))?.status).toBe("needs_reconnect");
    expect((await auditRows(s, s.orgA, ["connector.org_needs_reconnect"])).at(-1)).toMatchObject({
      metadata: { serverId: server.id },
    });
    expect(await cardCount(alexDm)).toBe(cards);
    expect(await toolCallsOf(ev.eventId)).toEqual([
      expect.objectContaining({ decision: "allowed", status: "blocked" }),
    ]);
    expect((await auditRows(s, s.orgA, ["bot.tool_call.completed"])).at(-1)?.metadata).toMatchObject({
      status: "blocked",
      reason: "needs_reconnect",
      credential: "organization",
    });
    s.fake.setScenario({});
    expect((await connectOrgOAuth(s, s.victor, server.id)).status).toBe(302);
  });

  it("a 401 again after the forced refresh: needs_reconnect (upstream_unauthorized), audited, the admin sentence", async () => {
    const ev = await turnOf(s.alex, alexDm);
    s.fake.setScenario({ reject_access_tokens: true });
    const before = await fakeStats(s);
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body?.error).toMatchObject({ code: "needs_reconnect", message: NEEDS_RECONNECT });
    expect((await fakeStats(s)).tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token + 1);
    expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({
      status: "needs_reconnect",
      last_error: "upstream_unauthorized",
    });
    expect((await auditRows(s, s.orgA, ["connector.org_needs_reconnect"])).at(-1)).toMatchObject({
      metadata: { serverId: server.id, code: "upstream_unauthorized" },
    });
    s.fake.setScenario({});
    expect((await connectOrgOAuth(s, s.victor, server.id)).status).toBe(302);
  });

  it("a token the provider rejects once: one forced refresh, one retry, success with the organization's grant", async () => {
    const stale = await staleOrgAccessToken();
    const ev = await turnOf(s.alex, alexDm);
    const before = await fakeStats(s);
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.parse(r.body?.content as string).subject).toBe(await orgSubjectOf(server.id));
    const after = await fakeStats(s);
    expect(after.tokenRequests.refresh_token).toBe(before.tokenRequests.refresh_token + 1);
    expect(after.mcpCalls).toBe(before.mcpCalls + 1);
    expect((await orgBundleOf(s, s.orgA, server.id))?.accessToken).not.toBe(stale);
    expect((await orgConnectionRow(s, s.orgA, server.id))?.status).toBe("connected");
  });

  it("insufficient_scope: an error result with the organization copy, never a token", async () => {
    const ev = await turnOf(s.alex, alexDm);
    s.fake.setScenario({ insufficient_scope: true });
    const r = await call(ev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ isError: true, truncated: false });
    const content = r.body?.content as string;
    expect(content).toContain("the organization's account is missing a permission it needs");
    expect(content).toContain("records:write");
    expect(content).toContain("An admin can reconnect it in Settings › MCP servers.");
    expect(content).not.toContain("Settings › Connections");
    expect(content).not.toMatch(/fakeat_|fakert_|Bearer/u);
    expect((await auditRows(s, s.orgA, ["bot.tool_call.completed"])).at(-1)?.metadata).toMatchObject({
      status: "error",
      reason: "insufficient_scope",
      credential: "organization",
    });
  });
});

describe("07.14 review CR-01: the organization's token goes only to the URL it was granted for", () => {
  it("a URL moved behind the registry: the call fails needs_reconnect and the new origin never gets the token", async () => {
    const hits: Array<{ authorization: string | undefined; body: string }> = [];
    const canary = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += String(c);
      });
      req.on("end", () => {
        hits.push({ authorization: req.headers.authorization, body });
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => canary.listen(0, "127.0.0.1", resolve));
    const canaryUrl = `http://fake-mcp:${(canary.address() as AddressInfo).port}/mcp-oauth/mcp`;
    try {
      const token = (await orgBundleOf(s, s.orgA, server.id))?.accessToken as string;
      expect(token).toMatch(/^fakeat_/u);
      // The race the registry's confirm-and-destroy closes: the URL changes after the credential was stored.
      await s.su.query("update app.mcp_servers set url = $2 where id = $1", [server.id, canaryUrl]);
      const ev = await turnOf(s.alex, alexDm);
      const r = await call(ev);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(codeOf(r)).toBe("needs_reconnect");
      expect(hits).toEqual([]);
      expect(JSON.stringify(hits)).not.toContain(token);
      expect(await orgConnectionRow(s, s.orgA, server.id)).toMatchObject({
        status: "needs_reconnect",
        last_error: "url_changed",
        secret_id: null,
      });
    } finally {
      await s.su.query("update app.mcp_servers set url = $2 where id = $1", [
        server.id,
        `${s.fakeBase}/mcp-oauth/mcp`,
      ]);
      canary.closeAllConnections();
      await new Promise<void>((resolve) => canary.close(() => resolve()));
    }
    expect((await connectOrgOAuth(s, s.victor, server.id)).status).toBe(302);
  });
});

describe("07.14 review WR-03: a resource server's 401 never destroys the organization's client secret", () => {
  it("client credentials, 401 after the one re-grant: an upstream error, the secret kept, the next call re-grants", async () => {
    const ledger = await registerCcConnector(s, { name: "Acme Ledger" });
    await ok(saveCc(s, s.victor, ledger.id));
    await grant(["whoami"].map((t) => ({ sourceId: ledger.id, tool: `${ledger.safeName}__${t}` })));
    const secretId = (await orgConnectionRow(s, s.orgA, ledger.id))?.secret_id;
    const ledgerCall = (ev: Json) => call(ev, "whoami", {}, ledger.safeName);

    s.fake.setScenario({ reject_access_tokens: true });
    const before = await fakeStats(s);
    const refused = await ledgerCall(await turnOf(s.alex, alexDm));
    expect(refused.status, JSON.stringify(refused.body)).toBe(502);
    expect(codeOf(refused)).toBe("upstream_error");
    expect((await fakeStats(s)).tokenRequests.client_credentials).toBe(
      before.tokenRequests.client_credentials + 1,
    );
    expect(await orgConnectionRow(s, s.orgA, ledger.id)).toMatchObject({
      status: "connected",
      secret_id: secretId,
      last_error: "upstream_unauthorized",
    });
    expect((await orgBundleOf(s, s.orgA, ledger.id))?.clientSecret).toBe(CC_SECRET);

    s.fake.setScenario({});
    const okCall = await ledgerCall(await turnOf(s.sam, opsId, true));
    expect(okCall.status, JSON.stringify(okCall.body)).toBe(200);
    expect(JSON.parse(okCall.body?.content as string).subject).toBe(`sub_cc_${PRE_REGISTERED_CC}`);
    expect((await orgConnectionRow(s, s.orgA, ledger.id))?.last_error).toBeNull();
  });
});
