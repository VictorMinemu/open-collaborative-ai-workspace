import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import {
  assertNoGlobalFetch,
  type ConnectorsStack,
  connectOAuth,
  fakeStats,
  type Json,
  ok,
  type Res,
  registerConnector,
  startConnectorsStack,
} from "../../testing-connectors";
import { invite } from "../../testing-workzone";

/**
 * 07.5-16 Task 1 (D-04, P-05; Pitfalls 2 and 4; APPROVE-02; T-07.5-16-01/02): approvals hold under concurrency, retries,
 * replay and time, through the real agent-action routes wired in 07.5-11 (`POST /tool-calls`, `/connectors/call`,
 * `/http-requests`). Concurrent calls are separate HTTP requests fired with `Promise.all`, so each runs in its own
 * transaction on its own pool connection; time windows are moved with the superuser client. WINDOWS #219: the approval
 * card is posted inside the claim transaction, so a channel with concurrent human traffic and concurrent approval calls
 * must neither deadlock nor lose or duplicate a stream event.
 *
 * Real PostgreSQL + Redis; the fake OAuth-protected MCP server (and its /kc keychain targets) runs in-process and is
 * reached only through the egress guard.
 */

const CELL_TOKEN = "ocw-test-cell-token-approvals-race-0123456789abcdef";
const NOTES = "m5e6f7a8b";
const WRITE = `${NOTES}__write_note`;

let s: ConnectorsStack;
let marta: TestClient;
let martaId = "";
let dana: TestClient;
let danaId = "";
let keeperId = "";
let scribeId = "";
let notesId = "";
let crm: Json;
let crmSafe = "";
let samDm = "";
let danaDm = "";
let trio = "";
let ops = "";

async function cell(path: string, body: unknown): Promise<Res> {
  const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CELL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
}

const codeOf = (r: Res) => (r.body?.error as Json | undefined)?.code;

/** `who` writes in `conversationId` (mentioning `agentId` when asked); returns that agent's delivered event. */
async function turnOf(
  who: TestClient,
  conversationId: string,
  opts: { agentId?: string; mention?: boolean } = {},
): Promise<Json> {
  const agentId = opts.agentId ?? keeperId;
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `${opts.mention ? `@${agentId === scribeId ? "scribe" : "keeper"} ` : ""}please do it ${randomUUID().slice(0, 6)}`,
      ...(opts.mention ? { mentions: [{ kind: "agent", id: agentId }] } : {}),
    }),
  );
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${s.orgA}`, msg.id, agentId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

/** The gate's question for a ruled MCP tool, with its arguments. */
const ask = (ev: Json, args: Json, toolCallId: string = randomUUID(), agentId = keeperId) =>
  cell("/tool-calls", {
    eventId: ev.eventId,
    agentId,
    tool: WRITE,
    toolCallId,
    params: {},
    arguments: args,
  });

async function rule(p: { pattern: string; mode: "always" | "when_tainted" }): Promise<string> {
  const { rows } = await s.su.query(
    `insert into app.tool_approval_policies
       (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
     values ($1, null, $2, $3, 'requester', '{}', $4, $4) returning id`,
    [s.orgA, p.pattern, p.mode, s.victorId],
  );
  return rows[0].id as string;
}

const clearRules = () =>
  s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);

/** Ends every pending request of earlier cases (expired), so the 5-pending cap never couples two cases. */
const expirePending = () =>
  s.su.query(
    "update app.approval_requests set expires_at = now() - interval '1 second' where organization_id = $1 and status = 'pending'",
    [s.orgA],
  );

const approvalRow = async (id: string) =>
  (await s.su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

const count = async (sql: string, params: unknown[]) =>
  (await s.su.query(`select count(*)::int as n from (${sql}) q`, params)).rows[0].n as number;

const storedActions = () =>
  count("select 1 from app.tool_call_approvals where organization_id = $1", [s.orgA]);
const approvalCards = (conversationId: string) =>
  count("select 1 from app.message_cards where conversation_id = $1 and kind = 'approval'", [conversationId]);
const consumedAudits = (approvalId: string) =>
  count("select 1 from app.audit_events where action = 'approval.grant_consumed' and resource_id = $1", [
    approvalId,
  ]);

const callsOf = async (eventId: string) =>
  (
    await s.su.query(
      "select tool, decision, reason, approval_id from app.agent_tool_calls where event_id = $1 order by created_at",
      [eventId],
    )
  ).rows as Json[];

/** Decides through the inbox route with the hash the request carries. */
async function decide(who: TestClient, id: string, outcome: "approved" | "denied", note?: string) {
  const row = await approvalRow(id);
  const r = await who.request("POST", `/api/v1/approvals/${id}/decision`, {
    outcome,
    actionHash: row.action_hash,
    ...(note ? { note } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** The one `agent.card_action.v1` of the approval's card (the re-run turn, delivered for the requester). */
async function rerunOf(approvalId: string): Promise<Json> {
  const row = await approvalRow(approvalId);
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${s.orgA}`, row.card_message_id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

/** Asks for `args` in Sam's DM and approves it as Sam; returns the approval and its re-run turn. */
async function approvedInSamDm(args: Json): Promise<{ id: string; rerun: Json }> {
  const asked = await ask(await turnOf(s.sam, samDm), args);
  expect(asked.body).toMatchObject({ allowed: false, reason: "approval_required" });
  const id = asked.body?.approval.id as string;
  await decide(s.sam, id, "approved");
  return { id, rerun: await rerunOf(id) };
}

/** Moves a request's clock back (created, expires and decided together, so their order holds). */
const ageBy = (id: string, interval: string) =>
  s.su.query(
    `update app.approval_requests
        set created_at = created_at - $2::interval,
            expires_at = expires_at - $2::interval,
            decided_at = decided_at - $2::interval
      where id = $1`,
    [id, interval],
  );

beforeAll(async () => {
  s = await startConnectorsStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  ({ client: marta, userId: martaId } = await invite(
    s.stack,
    s.victor,
    "marta@example.test",
    "Marta Gil",
    "standard",
  ));
  ({ client: dana, userId: danaId } = await invite(
    s.stack,
    s.victor,
    "dana@example.test",
    "Dana Cole",
    "standard",
  ));
  const agent = async (name: string) =>
    (
      await ok(
        s.victor.request("POST", "/api/v1/agents", {
          name,
          username: name.toLowerCase(),
          instructions: `You are ${name}.`,
          modelProvider: "mock",
          modelId: "mock-1",
        }),
      )
    ).id as string;
  keeperId = await agent("Keeper");
  scribeId = await agent("Scribe");

  // Notes: an org MCP server whose write_note changes things.
  notesId = randomUUID();
  await s.su.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
     values ($1, $2, 'Notes', $3, 'streamable-http', 'https://notes.example.test/mcp', 'ready', 'org_secret')`,
    [notesId, s.orgA, NOTES],
  );
  await s.su.query(
    `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
     values ($1, $2, 'write_note', $3, false)`,
    [s.orgA, notesId, WRITE],
  );
  // Acme CRM: a per-member connector Sam connects with his own account.
  crm = await registerConnector(s, { name: "Acme CRM" });
  crmSafe = crm.safeName as string;
  expect((await connectOAuth(s, s.sam, crm.id)).status).toBe(302);

  for (const id of [keeperId, scribeId]) {
    await ok(
      s.victor.request("PATCH", `/api/v1/agents/${id}/capabilities`, {
        internet: true,
        tools: [
          { sourceKind: "mcp", sourceId: notesId, tool: WRITE },
          { sourceKind: "mcp", sourceId: crm.id, tool: `${crmSafe}__create_record` },
        ],
      }),
    );
  }
  const dm = async (who: TestClient, agents: string[]) =>
    (
      await ok(
        who.request("POST", "/api/v1/dms", {
          participants: agents.map((id) => ({ kind: "agent", id })),
        }),
      )
    ).id as string;
  samDm = await dm(s.sam, [keeperId]);
  danaDm = await dm(dana, [keeperId]);
  // A group DM whose single human is Sam, with two bots.
  trio = await dm(s.sam, [keeperId, scribeId]);
  // #ops: Sam, Marta and Keeper.
  ops = (await ok(s.victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }))).id;
  for (const member of [
    { kind: "user", id: s.samId },
    { kind: "user", id: martaId },
    { kind: "agent", id: keeperId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${ops}/members`, member));
  }
}, 240_000);

afterEach(async () => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
});

afterAll(async () => {
  // The stack's own stop() skips the containers when the app's close throws (WINDOWS #213): stop them here too.
  try {
    await s?.stop();
  } finally {
    if (s) await Promise.allSettled([s.stack.redis.stop(), s.stack.db.stop()]);
  }
});

// ---------------------------------------------------------------- concurrent identical calls

describe("identical calls at once make one approval and one card", () => {
  beforeAll(async () => {
    await clearRules();
    await expirePending();
    await rule({ pattern: WRITE, mode: "always" });
  });

  it("two identical calls at once in one turn → one approval_required (created) and one approval_pending", async () => {
    const ev = await turnOf(s.sam, samDm);
    const args = { text: "race one turn", n: 1 };
    const [actions, cards] = [await storedActions(), await approvalCards(samDm)];
    const results = await Promise.all([ask(ev, args), ask(ev, args)]);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const reasons = results.map((r) => r.body?.reason).sort();
    expect(reasons).toEqual(["approval_pending", "approval_required"]);
    const created = results.find((r) => r.body?.reason === "approval_required")?.body?.approval;
    const pending = results.find((r) => r.body?.reason === "approval_pending")?.body?.approval;
    expect(created).toMatchObject({ created: true });
    expect(pending).toMatchObject({ created: false });
    expect(pending.id).toBe(created.id);
    expect(results.every((r) => r.body?.allowed === false)).toBe(true);
    expect(await storedActions()).toBe(actions + 1);
    expect(await approvalCards(samDm)).toBe(cards + 1);
    expect(
      await count("select 1 from app.approval_requests where kind = 'tool.call' and action_hash = $1", [
        (await approvalRow(created.id)).action_hash,
      ]),
    ).toBe(1);
  });

  it("the same call from two turns of Sam at once → still one approval and one card", async () => {
    const [a, b] = [await turnOf(s.sam, samDm), await turnOf(s.sam, samDm)];
    const args = { text: "race two turns" };
    const [actions, cards] = [await storedActions(), await approvalCards(samDm)];
    const results = await Promise.all([ask(a, args), ask(b, args), ask(a, args), ask(b, args)]);
    const ids = new Set(results.map((r) => r.body?.approval?.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body?.approval?.created === true)).toHaveLength(1);
    expect(results.filter((r) => r.body?.reason === "approval_pending")).toHaveLength(3);
    expect(await storedActions()).toBe(actions + 1);
    expect(await approvalCards(samDm)).toBe(cards + 1);
  });

  it("after approval, two re-runs at once → one allowed, one approval_used; consumed and audited once", async () => {
    const args = { text: "race rerun" };
    const { id, rerun } = await approvedInSamDm(args);
    const results = await Promise.all([ask(rerun, args), ask(rerun, args)]);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(results.map((r) => `${r.body?.allowed}:${r.body?.reason}`).sort()).toEqual([
      "false:approval_used",
      "true:null",
    ]);
    expect(await consumedAudits(id)).toBe(1);
    const calls = await callsOf(rerun.eventId);
    expect(calls.filter((c) => c.decision === "allowed")).toEqual([
      { tool: WRITE, decision: "allowed", reason: null, approval_id: id },
    ]);
    expect(calls.filter((c) => c.decision === "denied")).toEqual([
      { tool: WRITE, decision: "denied", reason: "approval_used", approval_id: null },
    ]);
    expect((await approvalRow(id)).status).toBe("applied");
  });

  it("a re-run turn and Sam's next turn racing for one grant → still one execution", async () => {
    const args = { text: "race two turns for one grant" };
    const { id, rerun } = await approvedInSamDm(args);
    const other = await turnOf(s.sam, samDm);
    const results = await Promise.all([
      ask(rerun, args),
      ask(other, args),
      ask(rerun, args),
      ask(other, args),
    ]);
    expect(results.filter((r) => r.body?.allowed === true)).toHaveLength(1);
    expect(results.filter((r) => r.body?.reason === "approval_used")).toHaveLength(3);
    expect(await consumedAudits(id)).toBe(1);
    expect(
      await count("select 1 from app.agent_tool_calls where approval_id = $1 and decision = 'allowed'", [id]),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------- the plugin's retry

describe("the plugin's retry (same eventId and toolCallId) is answered by the same approval", () => {
  beforeAll(async () => {
    await clearRules();
    await expirePending();
    await rule({ pattern: WRITE, mode: "always" });
  });

  it("sent twice, one after the other → the same approval id; no second card", async () => {
    const ev = await turnOf(s.sam, samDm);
    const toolCallId = `call-${randomUUID()}`;
    const first = await ask(ev, { text: "retry me" }, toolCallId);
    const cards = await approvalCards(samDm);
    const second = await ask(ev, { text: "retry me" }, toolCallId);
    expect(first.body).toMatchObject({ reason: "approval_required", approval: { created: true } });
    expect(second.body).toMatchObject({ reason: "approval_pending", approval: { created: false } });
    expect(second.body?.approval.id).toBe(first.body?.approval.id);
    expect(await approvalCards(samDm)).toBe(cards);
  });

  it("sent twice at once → one approval id, one created", async () => {
    const ev = await turnOf(s.sam, samDm);
    const toolCallId = `call-${randomUUID()}`;
    const actions = await storedActions();
    const results = await Promise.all([
      ask(ev, { text: "retry at once" }, toolCallId),
      ask(ev, { text: "retry at once" }, toolCallId),
    ]);
    expect(new Set(results.map((r) => r.body?.approval?.id)).size).toBe(1);
    expect(results.filter((r) => r.body?.approval?.created === true)).toHaveLength(1);
    expect(await storedActions()).toBe(actions + 1);
  });
});

// ---------------------------------------------------------------- replay across members, conversations and bots

describe("an approved hash is never usable by another member, conversation or bot", () => {
  const args = { text: "replay me", amount: 10 };
  let grantId = "";
  let rerun: Json;

  beforeAll(async () => {
    await clearRules();
    await expirePending();
    await rule({ pattern: WRITE, mode: "always" });
    // Sam asks Keeper in the group DM (Sam, Keeper, Scribe) and approves it; the grant is left unused.
    const asked = await ask(await turnOf(s.sam, trio, { mention: true }), args);
    expect(asked.body).toMatchObject({ reason: "approval_required" });
    grantId = asked.body?.approval.id as string;
    await decide(s.sam, grantId, "approved");
    rerun = await rerunOf(grantId);
    expect((await approvalRow(grantId)).status).toBe("approved");
  });

  const expectNewApproval = (r: Res) => {
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      allowed: false,
      reason: "approval_required",
      approval: { created: true },
    });
    expect(r.body?.approval.id).not.toBe(grantId);
  };

  it("another member's turn with the same bot (Dana, in her DM with Keeper) → a new approval, never allowed", async () => {
    const r = await ask(await turnOf(dana, danaDm), args);
    expectNewApproval(r);
    expect((await approvalRow(r.body?.approval.id)).requested_for_user_id).toBe(danaId);
  });

  it("Sam in another conversation with the same bot (his DM with Keeper) → a new approval", async () => {
    expectNewApproval(await ask(await turnOf(s.sam, samDm), args));
  });

  it("another bot in the same DM (Scribe, for Sam, in the group DM) → a new approval", async () => {
    const ev = await turnOf(s.sam, trio, { agentId: scribeId, mention: true });
    expectNewApproval(await ask(ev, args, randomUUID(), scribeId));
  });

  it("another bot naming Keeper's re-run turn → unknown_turn, nothing consumed", async () => {
    const r = await ask(rerun, args, randomUUID(), scribeId);
    expect(r.body).toMatchObject({ allowed: false, reason: "unknown_turn" });
  });

  it("none of them touched the grant: still unused, and Sam's re-run uses it once", async () => {
    const row = await approvalRow(grantId);
    expect(row).toMatchObject({ status: "approved", consumed_at: null });
    expect(await consumedAudits(grantId)).toBe(0);
    expect((await ask(rerun, args)).body).toMatchObject({ allowed: true, reason: null });
    expect(await consumedAudits(grantId)).toBe(1);
    expect(await callsOf(rerun.eventId)).toEqual([
      { tool: WRITE, decision: "allowed", reason: null, approval_id: grantId },
    ]);
  });
});

// ---------------------------------------------------------------- time windows

describe("time: 24 h pending, 15 min use window, 24 h denial", () => {
  beforeAll(async () => {
    await clearRules();
    await expirePending();
    await rule({ pattern: WRITE, mode: "always" });
  });

  it("a pending request 25 h old → the same call creates a new one", async () => {
    const args = { text: "old pending" };
    const first = await ask(await turnOf(s.sam, samDm), args);
    const oldId = first.body?.approval.id as string;
    // Same call while live: the same request.
    expect((await ask(await turnOf(s.sam, samDm), args)).body).toMatchObject({
      reason: "approval_pending",
      approval: { id: oldId },
    });
    await ageBy(oldId, "25 hours");
    const again = await ask(await turnOf(s.sam, samDm), args);
    expect(again.body).toMatchObject({ reason: "approval_required", approval: { created: true } });
    expect(again.body?.approval.id).not.toBe(oldId);
  });

  it("a grant decided 16 minutes ago → a new approval; the old one is not used", async () => {
    const args = { text: "stale grant" };
    const { id, rerun } = await approvedInSamDm(args);
    await s.su.query(
      "update app.approval_requests set decided_at = now() - interval '16 minutes' where id = $1",
      [id],
    );
    const r = await ask(rerun, args);
    expect(r.body).toMatchObject({
      allowed: false,
      reason: "approval_required",
      approval: { created: true },
    });
    expect(r.body?.approval.id).not.toBe(id);
    expect(await approvalRow(id)).toMatchObject({ status: "approved", consumed_at: null });
    expect(await consumedAudits(id)).toBe(0);
    expect(await callsOf(rerun.eventId)).toEqual([
      { tool: WRITE, decision: "denied", reason: "approval_required", approval_id: null },
    ]);
  });

  it("a grant at 14 minutes is still used (the window's other side)", async () => {
    const args = { text: "fresh grant" };
    const { id, rerun } = await approvedInSamDm(args);
    await s.su.query(
      "update app.approval_requests set decided_at = now() - interval '14 minutes' where id = $1",
      [id],
    );
    expect((await ask(rerun, args)).body).toMatchObject({ allowed: true, reason: null });
    expect(await consumedAudits(id)).toBe(1);
  });

  it("a denial within 24 h → approval_denied and no card; the same denial 25 h back → a new approval", async () => {
    const args = { text: "deny me" };
    const asked = await ask(await turnOf(s.sam, samDm), args);
    const id = asked.body?.approval.id as string;
    await decide(s.sam, id, "denied", "No");
    const [actions, cards] = [await storedActions(), await approvalCards(samDm)];
    const refused = await ask(await turnOf(s.sam, samDm), args);
    expect(refused.body).toEqual({
      callId: expect.any(String),
      allowed: false,
      reason: "approval_denied",
      denial: { deciderName: "Sam Lee", note: "No" },
    });
    expect(await storedActions()).toBe(actions);
    expect(await approvalCards(samDm)).toBe(cards);

    await ageBy(id, "25 hours");
    const again = await ask(await turnOf(s.sam, samDm), args);
    expect(again.body).toMatchObject({ reason: "approval_required", approval: { created: true } });
    expect(again.body?.approval.id).not.toBe(id);
    expect(await approvalCards(samDm)).toBe(cards + 1);
  });
});

// ---------------------------------------------------------------- the proxy routes

describe("concurrent re-runs through the proxy routes execute once", () => {
  it("connectors: two re-runs of one approved create_record at once → the fake MCP records exactly one call", async () => {
    await clearRules();
    await expirePending();
    await rule({ pattern: `${crmSafe}__create_record`, mode: "always" });
    const body = (ev: Json) => ({
      eventId: ev.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "create_record",
      arguments: { title: "Invoice race" },
    });
    const asked = await cell("/connectors/call", body(await turnOf(s.sam, samDm)));
    expect(asked.status, JSON.stringify(asked.body)).toBe(409);
    expect(codeOf(asked)).toBe("approval_required");
    const id = asked.body?.error.details.approval.id as string;
    await decide(s.sam, id, "approved");
    const rerun = await rerunOf(id);

    const before = await fakeStats(s);
    const results = await Promise.all([
      cell("/connectors/call", body(rerun)),
      cell("/connectors/call", body(rerun)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(codeOf(results.find((r) => r.status === 409) as Res)).toBe("approval_used");
    expect((await fakeStats(s)).mcpCalls).toBe(before.mcpCalls + 1);
    expect(await consumedAudits(id)).toBe(1);
  });

  it("keychain: two re-runs of one approved POST at once → one outbound request", async () => {
    await clearRules();
    await expirePending();
    await rule({ pattern: "ocw_http_request", mode: "always" });
    const kcHost = `fake-mcp:${s.fakePort}`;
    const key = await ok(
      s.sam.request("POST", "/api/v1/keychain", {
        scope: "personal",
        kind: "api_key",
        name: "KC race",
        value: "fake-kc-token",
        allowedHosts: [kcHost],
      }),
      201,
    );
    await ok(s.sam.request("PUT", `/api/v1/keychain/${key.id}/agents`, { agentIds: [keeperId] }));
    const body = (ev: Json) => ({
      eventId: ev.eventId,
      agentId: keeperId,
      handle: key.handle,
      method: "POST",
      url: `http://${kcHost}/kc/whoami`,
      body: "race",
    });
    const asked = await cell("/http-requests", body(await turnOf(s.sam, samDm)));
    expect(codeOf(asked)).toBe("approval_required");
    const id = asked.body?.error.details.approval.id as string;
    await decide(s.sam, id, "approved");
    const rerun = await rerunOf(id);

    const before = await fakeStats(s);
    const results = await Promise.all([
      cell("/http-requests", body(rerun)),
      cell("/http-requests", body(rerun)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(codeOf(results.find((r) => r.status === 409) as Res)).toBe("approval_used");
    const after = await fakeStats(s);
    expect(after.kc.authorized + after.kc.rejected).toBe(before.kc.authorized + before.kc.rejected + 1);
    expect(await consumedAudits(id)).toBe(1);
  });
});

// ---------------------------------------------------------------- WINDOWS #219: cards posted under channel contention

describe("approval cards posted inside the claim transaction under concurrent channel traffic (WINDOWS #219)", () => {
  it("human messages, mentions, decisions and approval calls at once in #ops: every request answers, one card per approval, the stream stays gapless", async () => {
    await clearRules();
    await expirePending();
    await rule({ pattern: WRITE, mode: "always" });
    // Two requests waiting to be decided during the burst.
    const waiting: string[] = [];
    for (const n of [1, 2]) {
      const r = await ask(await turnOf(s.sam, ops, { mention: true }), { text: `decide during burst ${n}` });
      waiting.push(r.body?.approval.id as string);
    }
    const turns = [
      await turnOf(s.sam, ops, { mention: true }),
      await turnOf(s.sam, ops, { mention: true }),
      await turnOf(s.sam, ops, { mention: true }),
    ];
    const lastSeqBefore = Number(
      (await s.su.query("select last_seq from app.streams where id = $1", [`conv:${ops}`])).rows[0]
        ?.last_seq ?? 0,
    );
    const cardsBefore = await approvalCards(ops);

    const started = Date.now();
    const asks = [
      ask(turns[0] as Json, { text: "burst a" }),
      ask(turns[1] as Json, { text: "burst b" }),
      ask(turns[2] as Json, { text: "burst c" }),
      // Identical to burst a, from another turn: the same approval.
      ask(turns[1] as Json, { text: "burst a" }),
    ];
    const posts = Array.from({ length: 24 }, (_, i) =>
      (i % 2 === 0 ? s.sam : marta).request("POST", `/api/v1/conversations/${ops}/messages`, {
        body: `${i % 6 === 0 ? "@keeper " : ""}chatter ${i}`,
        ...(i % 6 === 0 ? { mentions: [{ kind: "agent", id: keeperId }] } : {}),
      }),
    );
    const decisions = waiting.map(async (id) => {
      const row = await approvalRow(id);
      return s.sam.request("POST", `/api/v1/approvals/${id}/decision`, {
        outcome: "denied",
        actionHash: row.action_hash,
      });
    });
    const [asked, posted, decided] = await Promise.all([
      Promise.all(asks),
      Promise.all(posts),
      Promise.all(decisions),
    ]);
    const elapsed = Date.now() - started;

    for (const r of asked) expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const r of posted) expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const r of decided) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(elapsed).toBeLessThan(15_000);

    // Three actions, three approvals (the duplicate joined burst a's), three cards, each in #ops.
    const ids = asked.map((r) => r.body?.approval?.id as string);
    expect(ids[3]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
    expect(asked.filter((r) => r.body?.approval?.created === true)).toHaveLength(3);
    expect(await approvalCards(ops)).toBe(cardsBefore + 3);
    for (const id of new Set(ids)) {
      const row = await approvalRow(id);
      const [card] = (
        await s.su.query("select conversation_id from app.messages where id = $1", [row.card_message_id])
      ).rows;
      expect(card?.conversation_id).toBe(ops);
    }
    for (const id of waiting) expect((await approvalRow(id)).status).toBe("denied");

    // #ops's stream: every seq after the burst exactly once, no gap, and one created-message event per new message.
    const seqs = (
      await s.su.query(
        "select seq::int as seq from app.stream_events where stream_id = $1 and seq > $2 order by seq",
        [`conv:${ops}`, lastSeqBefore],
      )
    ).rows.map((r) => r.seq as number);
    const lastSeqAfter = Number(
      (await s.su.query("select last_seq from app.streams where id = $1", [`conv:${ops}`])).rows[0]?.last_seq,
    );
    expect(seqs).toEqual(
      Array.from({ length: lastSeqAfter - lastSeqBefore }, (_, i) => lastSeqBefore + i + 1),
    );
    const messageIds = [...posted.map((r) => r.body?.id as string)];
    for (const id of messageIds) {
      expect(
        await count(
          "select 1 from app.stream_events where stream_id = $1 and seq > $2 and payload::text like '%' || $3 || '%'",
          [`conv:${ops}`, lastSeqBefore, id],
        ),
      ).toBeGreaterThanOrEqual(1);
    }
  });
});
