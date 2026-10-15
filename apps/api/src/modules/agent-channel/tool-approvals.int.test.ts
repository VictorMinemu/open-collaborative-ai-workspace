import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import {
  assertNoGlobalFetch,
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
import { invite } from "../../testing-workzone";

/**
 * 07.5-11 (D-01, D-02, D-04; APPROVE-01, APPROVE-02, APPROVE-04): the approval decision through the three real
 * agent-action routes. A tool with a rule is flagged on the delivered turn; the cell sends its arguments; the route asks
 * `approvalForCall` inside its claim transaction and before any outbound call; a person approves; the card-action turn
 * for the requester re-runs the same call; the grant is consumed in the claim and the call runs once, with the
 * requester's own credential. Tools without a rule keep today's path exactly. Real PostgreSQL + Redis; the fake
 * OAuth-protected MCP server (and its /kc keychain targets) runs in-process and is reached only through the egress guard.
 *
 * Races, replay, time windows, the leak sweep and tenant isolation through these routes are plan 16.
 */

const CELL_TOKEN = "ocw-test-cell-token-tool-approvals-0123456789abc";
const NOTES = "m1a2b3c4d";
const WRITE = `${NOTES}__write_note`;
const ECHO = `${NOTES}__echo`;
const DELETE = `${NOTES}__delete_note`;

let s: ConnectorsStack;
let marta: TestClient;
let martaId = "";
let dana: TestClient;
let sales = "";
let keeperId = "";
let notesId = "";
let crm: Json;
let crmSafe = "";
let samDm = "";
let danaDm = "";
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

/** `who` writes in `conversationId` (mentioning Keeper outside a DM); returns Keeper's delivered event (its turn). */
async function turnOf(who: TestClient, conversationId: string, mention = false): Promise<Json> {
  const msg = await ok(
    who.request("POST", `/api/v1/conversations/${conversationId}/messages`, {
      body: `${mention ? "@keeper " : ""}please do it ${randomUUID().slice(0, 6)}`,
      ...(mention ? { mentions: [{ kind: "agent", id: keeperId }] } : {}),
    }),
  );
  const rows = (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 and payload->'agent'->>'id' = $3",
      [`cell:${s.orgA}`, msg.id, keeperId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  return rows[0].payload as Json;
}

/** The gate's question for a native tool (an MCP tool of Notes, a web tool). */
const ask = (ev: Json, tool: string, extra: Json = {}) =>
  cell("/tool-calls", { eventId: ev.eventId, agentId: keeperId, tool, toolCallId: randomUUID(), ...extra });

async function rule(p: {
  pattern: string;
  mode: "always" | "when_tainted";
  scopeUnitId?: string | null;
  approverKind?: "requester" | "unit_leads";
}): Promise<string> {
  const { rows } = await s.su.query(
    `insert into app.tool_approval_policies
       (organization_id, scope_unit_id, tool_pattern, mode, approver_kind, approver_user_ids, created_by, updated_by)
     values ($1, $2, $3, $4, $5, '{}', $6, $6) returning id`,
    [s.orgA, p.scopeUnitId ?? null, p.pattern, p.mode, p.approverKind ?? "requester", s.victorId],
  );
  return rows[0].id as string;
}

const clearRules = () =>
  s.su.query("delete from app.tool_approval_policies where organization_id = $1", [s.orgA]);

const approvalRow = async (id: string) =>
  (await s.su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

const countApprovals = async () =>
  (
    await s.su.query("select count(*)::int as n from app.tool_call_approvals where organization_id = $1", [
      s.orgA,
    ])
  ).rows[0].n as number;

const callRow = async (callId: string) =>
  (await s.su.query("select * from app.agent_tool_calls where id = $1", [callId])).rows[0] as Json;

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
  return who.request("POST", `/api/v1/approvals/${id}/decision`, {
    outcome,
    actionHash: row.action_hash,
    ...(note ? { note } : {}),
  });
}

/** The one `agent.card_action.v1` of the approval's card (the re-run turn). */
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

const turnRow = async (eventId: string) =>
  (await s.su.query("select * from app.agent_turns where event_id = $1", [eventId])).rows[0] as Json;

beforeAll(async () => {
  s = await startConnectorsStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  ({ client: marta, userId: martaId } = await invite(
    s.stack,
    s.victor,
    "marta@example.test",
    "Marta Gil",
    "lead",
  ));
  ({ client: dana } = await invite(s.stack, s.victor, "dana@example.test", "Dana Cole", "standard"));
  const unit = async (name: string) =>
    (await ok(s.victor.request("POST", "/api/v1/units", { kind: "department", name, parentId: null })))
      .id as string;
  sales = await unit("Sales");
  const marketing = await unit("Marketing");
  await ok(s.victor.request("POST", `/api/v1/units/${sales}/members`, { userId: martaId, role: "lead" }));
  await ok(s.victor.request("POST", `/api/v1/units/${sales}/members`, { userId: s.samId }));
  const danaId = (await s.su.query("select user_id from app.org_members where display_name = 'Dana Cole'"))
    .rows[0].user_id as string;
  await ok(s.victor.request("POST", `/api/v1/units/${marketing}/members`, { userId: danaId }));

  keeperId = (
    await ok(
      s.victor.request("POST", "/api/v1/agents", {
        name: "Keeper",
        username: "keeper",
        instructions: "You are Keeper.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;

  // Notes: an org MCP server whose write_note and delete_note change things and whose echo only reads.
  notesId = randomUUID();
  await s.su.query(
    `insert into app.mcp_servers (id, organization_id, name, safe_name, transport, url, status, auth_mode)
     values ($1, $2, 'Notes', $3, 'streamable-http', 'https://notes.example.test/mcp', 'ready', 'org_secret')`,
    [notesId, s.orgA, NOTES],
  );
  for (const [name, readOnly] of [
    ["write_note", false],
    ["echo", true],
    ["delete_note", false],
  ] as const) {
    await s.su.query(
      `insert into app.mcp_server_tools (organization_id, server_id, name, openclaw_name, read_only)
       values ($1, $2, $3, $4, $5)`,
      [s.orgA, notesId, name, `${NOTES}__${name}`, readOnly],
    );
  }
  // Acme CRM: a per-member connector; Sam and Marta each connect their own account (the first connect probes it).
  crm = await registerConnector(s, { name: "Acme CRM" });
  crmSafe = crm.safeName as string;
  expect((await connectOAuth(s, s.sam, crm.id)).status).toBe(302);
  expect((await connectOAuth(s, marta, crm.id)).status).toBe(302);

  await ok(
    s.victor.request("PATCH", `/api/v1/agents/${keeperId}/capabilities`, {
      internet: true,
      tools: [
        ...[WRITE, ECHO, DELETE].map((tool) => ({ sourceKind: "mcp", sourceId: notesId, tool })),
        ...["whoami", "create_record", "echo_auth"].map((t) => ({
          sourceKind: "mcp",
          sourceId: crm.id,
          tool: `${crmSafe}__${t}`,
        })),
      ],
    }),
  );
  samDm = (
    await ok(s.sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] }))
  ).id as string;
  danaDm = (
    await ok(dana.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] }))
  ).id as string;
  // #ops: Sam, Marta and Keeper; Sam lets Keeper use his CRM account there (07.4-12 share).
  ops = (await ok(s.victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }))).id;
  for (const member of [
    { kind: "user", id: s.samId },
    { kind: "user", id: martaId },
    { kind: "agent", id: keeperId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${ops}/members`, member));
  }
  await ok(
    s.sam.request("POST", "/api/v1/member-account-shares", {
      conversationId: ops,
      resourceKind: "connector",
      resourceId: crm.id,
    }),
    201,
  );
}, 240_000);

afterEach(async () => {
  assertNoGlobalFetch(s);
  s.fake.setScenario({});
});

afterAll(async () => {
  await s?.stop();
});

// ---------------------------------------------------------------- Task 1 (tracer): /tool-calls

describe("tracer: a side-effecting MCP call after approval runs exactly once, for the person who asked", () => {
  let ev: Json;
  let approvalId = "";
  let rerun: Json;

  beforeAll(async () => {
    await clearRules();
    await rule({ pattern: WRITE, mode: "always" });
  });

  it("the delivered turn flags write_note; the call with its arguments → approval_required with a card, at once", async () => {
    ev = await turnOf(s.sam, samDm);
    expect(ev.turn.toolFlags[WRITE]).toEqual({
      untrustedOutput: true,
      sideEffecting: true,
      approval: "always",
    });

    const started = Date.now();
    const r = await cell("/tool-calls", {
      eventId: ev.eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: "c1",
      params: {},
      arguments: { text: "hi", n: 1 },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      callId: expect.any(String),
      allowed: false,
      reason: "approval_required",
      approval: {
        id: expect.any(String),
        created: true,
        waitingFor: "Waiting for Sam Lee to approve",
        requesterName: "Sam Lee",
      },
    });
    approvalId = r.body?.approval.id;

    // A denied ledger row, audited with the approval's id and no argument.
    expect(await callRow(r.body?.callId)).toMatchObject({
      tool: WRITE,
      decision: "denied",
      reason: "approval_required",
      approval_id: null,
      user_id: s.samId,
    });
    const audit = (
      await s.su.query(
        "select metadata from app.audit_events where action = 'bot.tool_call' and organization_id = $1 and metadata->>'approvalId' = $2",
        [s.orgA, approvalId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ tool: WRITE, reason: "approval_required", approvalId });
    expect(JSON.stringify(audit[0].metadata)).not.toContain('"hi"');

    // A platform-owned card in Sam's DM that shows the exact action (Sam is its only human).
    const row = await approvalRow(approvalId);
    const card = (
      await s.su.query(
        "select m.conversation_id, c.platform_owned, c.fields from app.messages m join app.message_cards c on c.message_id = m.id where m.id = $1",
        [row.card_message_id],
      )
    ).rows[0];
    expect(card).toMatchObject({ conversation_id: samDm, platform_owned: true });
    expect(card.fields).toEqual(expect.arrayContaining([expect.objectContaining({ value: "hi" })]));
  });

  it("Sam approves on the card: one agent.card_action.v1 delivered for Sam, with the grant", async () => {
    const row = await approvalRow(approvalId);
    const decided = await s.sam.request("POST", `/api/v1/cards/${row.card_message_id}/decision`, {
      outcome: "approved",
      actionHash: row.action_hash,
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    rerun = await rerunOf(approvalId);
    expect(rerun.message.author.id).toBe(s.samId);
    expect(rerun.cardAction.grant).toEqual({
      tool: WRITE,
      arguments: '{"n":1,"text":"hi"}',
      useBy: expect.any(String),
    });
    expect((await turnRow(rerun.eventId)).user_id).toBe(s.samId);
    expect(rerun.cardAction).not.toHaveProperty("note");
    expect(rerun.cardAction).not.toHaveProperty("resultCode");
  });

  it("the re-run sends the same call (keys in another order): allowed once, the grant consumed in the claim", async () => {
    const r = await cell("/tool-calls", {
      eventId: rerun.eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: "c2",
      params: {},
      arguments: { n: 1, text: "hi" },
    });
    expect(r.body).toEqual({ callId: expect.any(String), allowed: true, reason: null });
    expect(await callRow(r.body?.callId)).toMatchObject({
      decision: "allowed",
      approval_id: approvalId,
      user_id: s.samId,
    });
    const audit = (
      await s.su.query(
        "select metadata from app.audit_events where action = 'bot.tool_call' and organization_id = $1 and resource_id = $2 and metadata->>'grant' = 'true'",
        [s.orgA, WRITE],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ tool: WRITE, approvalId, grant: true, reason: null });
    expect(JSON.stringify(audit[0].metadata)).not.toContain('"hi"');
    const detail = await ok(s.sam.request("GET", `/api/v1/approvals/${approvalId}`));
    expect(detail.status).toBe("applied");
    expect(detail.view.usedAt).toEqual(expect.any(String));
  });

  it("the same call again in that turn → approval_used; different arguments → a new card", async () => {
    const again = await cell("/tool-calls", {
      eventId: rerun.eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: "c3",
      params: {},
      arguments: { n: 1, text: "hi" },
    });
    expect(again.body).toMatchObject({ allowed: false, reason: "approval_used" });
    const other = await cell("/tool-calls", {
      eventId: rerun.eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: "c4",
      params: {},
      arguments: { n: 2, text: "hi" },
    });
    expect(other.body).toMatchObject({
      allowed: false,
      reason: "approval_required",
      approval: { created: true },
    });
    expect(other.body?.approval.id).not.toBe(approvalId);

    // Sam denies that one with a note: the same call again is refused with who denied it and the note.
    expect((await decide(s.sam, other.body?.approval.id, "denied", "Not twice")).status).toBe(200);
    const denied = await cell("/tool-calls", {
      eventId: rerun.eventId,
      agentId: keeperId,
      tool: WRITE,
      toolCallId: "c5",
      params: {},
      arguments: { n: 2, text: "hi" },
    });
    expect(denied.body).toEqual({
      callId: expect.any(String),
      allowed: false,
      reason: "approval_denied",
      denial: { deciderName: "Sam Lee", note: "Not twice" },
    });
  });

  it("a tool without a rule (echo, for Dana) with arguments sent anyway: allowed exactly as today, nothing stored", async () => {
    const before = await countApprovals();
    const danaEv = await turnOf(dana, danaDm);
    expect(danaEv.turn.toolFlags[ECHO]).toEqual({ untrustedOutput: true, sideEffecting: false });
    const r = await ask(danaEv, ECHO, { params: {}, arguments: { text: "SENTINEL-ECHO" } });
    expect(r.body).toEqual({ callId: expect.any(String), allowed: true, reason: null });
    expect(await callRow(r.body?.callId)).toMatchObject({ decision: "allowed", approval_id: null });
    expect(await countApprovals()).toBe(before);
  });
});

// ---------------------------------------------------------------- Task 2: connectors, keys, taint, mid-turn

describe("a connector write cannot bypass the rule, and a lead's approval acts with the member's own account", () => {
  let ev: Json;
  let approvalId = "";

  beforeAll(async () => {
    await clearRules();
    await rule({ pattern: `${crmSafe}__*`, mode: "always", scopeUnitId: sales, approverKind: "unit_leads" });
  });

  it("Sam asks in #ops → 409 approval_required naming the Sales leads, no MCP call, a summary card", async () => {
    ev = await turnOf(s.sam, ops, true);
    expect(ev.turn.toolFlags[`${crmSafe}__whoami`]).toMatchObject({ approval: "always" });
    const before = await fakeStats(s);
    const r = await cell("/connectors/call", {
      eventId: ev.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "whoami",
      arguments: { detail: "SENTINEL-WHOAMI" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(codeOf(r)).toBe("approval_required");
    expect(r.body?.error.details).toEqual({
      approval: {
        id: expect.any(String),
        created: true,
        waitingFor: "Waiting for a lead of Sales",
        requesterName: "Sam Lee",
      },
    });
    approvalId = r.body?.error.details.approval.id;
    const after = await fakeStats(s);
    expect(after.mcpRequests).toBe(before.mcpRequests);
    expect(after.mcpCalls).toBe(before.mcpCalls);
    // A summary card in the channel: tool and source, never the arguments.
    const card = (
      await s.su.query(
        "select m.conversation_id, c.fields, m.body from app.messages m join app.message_cards c on c.message_id = m.id where m.id = $1",
        [(await approvalRow(approvalId)).card_message_id],
      )
    ).rows[0];
    expect(card.conversation_id).toBe(ops);
    expect(JSON.stringify(card)).not.toContain("SENTINEL-WHOAMI");
  });

  it("Marta (lead of Sales) approves; the re-run turn is Sam's; the call runs once with Sam's token, never Marta's", async () => {
    const decided = await decide(marta, approvalId, "approved");
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const rerun = await rerunOf(approvalId);
    expect(rerun.message.author.id).toBe(s.samId);
    expect(rerun.cardAction.decidedBy).toEqual({ id: martaId, displayName: "Marta Gil" });
    expect((await turnRow(rerun.eventId)).user_id).toBe(s.samId);

    const before = await fakeStats(s);
    const r = await cell("/connectors/call", {
      eventId: rerun.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "whoami",
      arguments: { detail: "SENTINEL-WHOAMI" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // The member's own grant answered: Sam's subject, never Marta's (07.4: the account label is `<subject>@fake-mcp.test`).
    const subjectOf = async (userId: string) =>
      String((await connectionRow(s, userId, crm.id))?.account_label ?? "").replace(/@fake-mcp\.test$/u, "");
    const subject = JSON.parse(r.body?.content as string).subject as string;
    expect(subject).toBe(await subjectOf(s.samId));
    expect(subject).not.toBe(await subjectOf(martaId));
    expect((await fakeStats(s)).mcpCalls).toBe(before.mcpCalls + 1);
    const calls = await callsOf(rerun.eventId);
    expect(calls).toEqual([
      { tool: `${crmSafe}__whoami`, decision: "allowed", reason: null, approval_id: approvalId },
    ]);
    expect((await connectionRow(s, s.samId, crm.id))?.last_used_at).not.toBeNull();
    expect((await connectionRow(s, martaId, crm.id))?.last_used_at).toBeNull();
    expect((await approvalRow(approvalId)).status).toBe("applied");
  });

  it("a failure after consumption keeps the approval used: the same call again → approval_used", async () => {
    const first = await turnOf(s.sam, ops, true);
    const args = { title: "Invoice 42" };
    const asked = await cell("/connectors/call", {
      eventId: first.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "create_record",
      arguments: args,
    });
    expect(codeOf(asked)).toBe("approval_required");
    const id = asked.body?.error.details.approval.id as string;
    expect((await decide(marta, id, "approved")).status).toBe(200);
    const rerun = await rerunOf(id);
    s.fake.setScenario({ insufficient_scope: true });
    const failed = await cell("/connectors/call", {
      eventId: rerun.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "create_record",
      arguments: args,
    });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body?.isError).toBe(true);
    expect((await approvalRow(id)).status).toBe("applied");
    s.fake.setScenario({});
    const again = await cell("/connectors/call", {
      eventId: rerun.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "create_record",
      arguments: args,
    });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe("approval_used");
  });

  it("a denial with a note: the same call again → 409 approval_denied naming the decider and the note", async () => {
    const first = await turnOf(s.sam, ops, true);
    const args = { title: "Refund 7" };
    const body = {
      eventId: first.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "create_record",
      arguments: args,
    };
    const asked = await cell("/connectors/call", body);
    expect(codeOf(asked)).toBe("approval_required");
    const id = asked.body?.error.details.approval.id as string;
    expect((await decide(marta, id, "denied", "Duplicate invoice")).status).toBe(200);
    // The denial's turn (Sam's) carries the note as a field and no grant (07.5-11: no sentence parsing in the cell).
    const told = await rerunOf(id);
    expect(told.message.author.id).toBe(s.samId);
    expect(told.cardAction).toMatchObject({
      outcome: "denied",
      note: "Duplicate invoice",
      decidedBy: { id: martaId, displayName: "Marta Gil" },
    });
    expect(told.cardAction).not.toHaveProperty("grant");
    expect(told.cardAction).not.toHaveProperty("resultCode");
    const again = await cell("/connectors/call", body);
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe("approval_denied");
    expect(again.body?.error.details).toEqual({
      denial: { deciderName: "Marta Gil", note: "Duplicate invoice" },
    });
  });

  it("the cell-wide view (GET /cell) carries static tool names only: no per-member logical name, no flag", async () => {
    const res = await fetch(`${s.stack.baseUrl}/agent-channel/v1/cell`, {
      headers: { authorization: `Bearer ${CELL_TOKEN}` },
    });
    const snap = (await res.json()) as Json;
    const tools = (snap.agents as Json[]).find((a) => a.id === keeperId)?.capabilities.tools as string[];
    expect(tools).toEqual(expect.arrayContaining([WRITE, "ocw_connector_call"]));
    expect(tools.some((t) => t.startsWith(`${crmSafe}__`))).toBe(false);
    expect(tools.every((t) => typeof t === "string")).toBe(true);
    expect(JSON.stringify(snap)).not.toContain('"approval"');
  });

  it("without a rule the connector call is exactly today's (07.4): allowed, no approval stored", async () => {
    await clearRules();
    const before = await countApprovals();
    const plain = await turnOf(s.sam, ops, true);
    expect(plain.turn.toolFlags[`${crmSafe}__whoami`]).not.toHaveProperty("approval");
    const r = await cell("/connectors/call", {
      eventId: plain.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "whoami",
      arguments: {},
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await countApprovals()).toBe(before);
  });
});

describe("a card that does not show the exact action cannot be approved from the card (WINDOWS #211)", () => {
  const cardDecision = async (who: TestClient, approvalId: string, outcome: "approved" | "denied") => {
    const row = await approvalRow(approvalId);
    return who.request("POST", `/api/v1/cards/${row.card_message_id}/decision`, {
      outcome,
      actionHash: row.action_hash,
    });
  };
  const displayOf = async (who: TestClient, approvalId: string) =>
    (await ok(who.request("GET", `/api/v1/cards/${(await approvalRow(approvalId)).card_message_id}`)))
      .approval?.display as string;

  it("review_only (a value cut for the card): the card route refuses Approve (409 review_required), Deny works", async () => {
    await clearRules();
    await rule({ pattern: WRITE, mode: "always" });
    const ev = await turnOf(s.sam, samDm);
    const long = await ask(ev, WRITE, { arguments: { text: "x".repeat(600) } });
    const id = long.body?.approval.id as string;
    expect(await displayOf(s.sam, id)).toBe("review_only");
    const refused = await cardDecision(s.sam, id, "approved");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(codeOf(refused)).toBe("review_required");
    expect((await approvalRow(id)).status).toBe("pending");
    // The review route still decides it (the decider saw the whole action there).
    expect((await decide(s.sam, id, "approved")).status).toBe(200);

    const other = await ask(ev, WRITE, { arguments: { text: "y".repeat(600) } });
    const otherId = other.body?.approval.id as string;
    expect((await cardDecision(s.sam, otherId, "denied")).status).toBe(200);
    expect((await approvalRow(otherId)).status).toBe("denied");
  });

  it("summary (a channel): the card route refuses Approve even for a decider; the review route decides", async () => {
    await clearRules();
    await rule({ pattern: `${crmSafe}__*`, mode: "always", scopeUnitId: sales, approverKind: "unit_leads" });
    const ev = await turnOf(s.sam, ops, true);
    const asked = await cell("/connectors/call", {
      eventId: ev.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "whoami",
      arguments: { detail: "summary-card" },
    });
    const id = asked.body?.error.details.approval.id as string;
    expect(await displayOf(marta, id)).toBe("summary");
    const refused = await cardDecision(marta, id, "approved");
    expect(refused.status).toBe(409);
    expect(codeOf(refused)).toBe("review_required");
    expect((await approvalRow(id)).status).toBe("pending");
    expect((await decide(marta, id, "approved")).status).toBe(200);
  });

  it("exact (Sam's own DM, values as they are): the card route still approves", async () => {
    await clearRules();
    await rule({ pattern: WRITE, mode: "always" });
    const ev = await turnOf(s.sam, samDm);
    const asked = await ask(ev, WRITE, { arguments: { text: "short" } });
    const id = asked.body?.approval.id as string;
    expect(await displayOf(s.sam, id)).toBe("exact");
    expect((await cardDecision(s.sam, id, "approved")).status).toBe(200);
    expect((await approvalRow(id)).status).toBe("approved");
  });
});

describe("a decision note stays with the people who may see the action (W-1, ADR-0026 amended 2026-10-15)", () => {
  const NOTE_SUMMARY = "NOTE-SENTINEL-summary-refund-4411";
  const NOTE_REVIEW = "NOTE-SENTINEL-review-approved-7720";
  const NOTE_EXACT = "NOTE-SENTINEL-exact-dm-3108";

  const cardOfApproval = async (who: TestClient, approvalId: string) =>
    ok(who.request("GET", `/api/v1/cards/${(await approvalRow(approvalId)).card_message_id}`));
  const decidedAudit = async (approvalId: string) =>
    (
      await s.su.query(
        "select metadata from app.audit_events where action = 'approval.decided' and resource_id = $1",
        [approvalId],
      )
    ).rows.map((r) => r.metadata as Json);
  const auditsWith = async (needle: string) =>
    (await s.su.query("select action from app.audit_events where strpos(metadata::text, $1) > 0", [needle]))
      .rows;
  const convEventsWith = async (conversationId: string, needle: string) =>
    (
      await s.su.query(
        "select type from app.stream_events where stream_id = $1 and strpos(payload::text, $2) > 0",
        [`conv:${conversationId}`, needle],
      )
    ).rows;
  async function summaryAsk(detail: string): Promise<string> {
    await clearRules();
    await rule({ pattern: `${crmSafe}__*`, mode: "always", scopeUnitId: sales, approverKind: "unit_leads" });
    const ev = await turnOf(s.sam, ops, true);
    const asked = await cell("/connectors/call", {
      eventId: ev.eventId,
      agentId: keeperId,
      connector: crmSafe,
      tool: "whoami",
      arguments: { detail },
    });
    expect(codeOf(asked)).toBe("approval_required");
    return asked.body?.error.details.approval.id as string;
  }

  it("a summary card in #ops denied on the card with a note: the card, its row and #ops's stream never hold it", async () => {
    const id = await summaryAsk("note-on-summary");
    expect((await cardOfApproval(marta, id)).approval?.display).toBe("summary");
    const row = await approvalRow(id);
    const denied = await marta.request("POST", `/api/v1/cards/${row.card_message_id}/decision`, {
      outcome: "denied",
      actionHash: row.action_hash,
      note: NOTE_SUMMARY,
    });
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);
    // The card the decider gets back and every reader's card: the decision without its note.
    expect(denied.body?.decision).toMatchObject({ outcome: "denied" });
    expect(denied.body?.decision).not.toHaveProperty("note");
    for (const who of [marta, s.sam]) {
      const card = await cardOfApproval(who, id);
      expect(card.decision).toMatchObject({ outcome: "denied", by: { id: martaId } });
      expect(JSON.stringify(card)).not.toContain(NOTE_SUMMARY);
    }
    expect(
      (
        await s.su.query("select decision_note from app.message_cards where message_id = $1", [
          row.card_message_id,
        ])
      ).rows[0].decision_note,
    ).toBeNull();
    expect(await convEventsWith(ops, NOTE_SUMMARY)).toEqual([]);
    expect(
      JSON.stringify(await ok(s.sam.request("GET", `/api/v1/conversations/${ops}/messages`))),
    ).not.toContain(NOTE_SUMMARY);
    // The bot hears it, in the requester's own turn; the requester's next try quotes it.
    const told = await rerunOf(id);
    expect(told.message.author.id).toBe(s.samId);
    expect(told.cardAction).toMatchObject({ outcome: "denied", note: NOTE_SUMMARY });
    // The review shows it to the people who may see the action.
    expect((await ok(marta.request("GET", `/api/v1/approvals/${id}`))).decisionNote).toBe(NOTE_SUMMARY);
    expect((await ok(s.sam.request("GET", `/api/v1/approvals/${id}`))).decisionNote).toBe(NOTE_SUMMARY);
    // Audit: the note's length, never its text (tool.call is private, like memory).
    const [meta] = await decidedAudit(id);
    expect(meta).toMatchObject({ outcome: "denied", noteChars: NOTE_SUMMARY.length });
    expect(meta).not.toHaveProperty("note");
    expect(await auditsWith(NOTE_SUMMARY)).toEqual([]);
  });

  it("a summary request approved on the review with a note: the card shows no note, the re-run turn carries it", async () => {
    const id = await summaryAsk("note-on-review");
    expect((await decide(marta, id, "approved", NOTE_REVIEW)).status).toBe(200);
    const card = await cardOfApproval(s.sam, id);
    expect(card.decision).toMatchObject({ outcome: "approved" });
    expect(JSON.stringify(card)).not.toContain(NOTE_REVIEW);
    expect(await convEventsWith(ops, NOTE_REVIEW)).toEqual([]);
    const told = await rerunOf(id);
    expect(told.message.author.id).toBe(s.samId);
    expect(told.cardAction).toMatchObject({ outcome: "approved", note: NOTE_REVIEW });
    expect(told.cardAction.grant).toBeDefined();
    const [meta] = await decidedAudit(id);
    expect(meta).toMatchObject({ outcome: "approved", noteChars: NOTE_REVIEW.length });
    expect(await auditsWith(NOTE_REVIEW)).toEqual([]);
  });

  it("an exact card in the requester's own DM keeps the note on the card and in the turn; audit has its length only", async () => {
    await clearRules();
    await rule({ pattern: WRITE, mode: "always" });
    const ev = await turnOf(s.sam, samDm);
    const asked = await ask(ev, WRITE, { arguments: { text: "note-on-exact" } });
    const id = asked.body?.approval.id as string;
    expect((await cardOfApproval(s.sam, id)).approval?.display).toBe("exact");
    const row = await approvalRow(id);
    const decided = await s.sam.request("POST", `/api/v1/cards/${row.card_message_id}/decision`, {
      outcome: "approved",
      actionHash: row.action_hash,
      note: NOTE_EXACT,
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body?.decision).toMatchObject({ outcome: "approved", note: NOTE_EXACT });
    expect((await cardOfApproval(s.sam, id)).decision).toMatchObject({ note: NOTE_EXACT });
    expect((await convEventsWith(samDm, NOTE_EXACT)).length).toBeGreaterThan(0);
    expect((await rerunOf(id)).cardAction).toMatchObject({ outcome: "approved", note: NOTE_EXACT });
    const [meta] = await decidedAudit(id);
    expect(meta).toMatchObject({ noteChars: NOTE_EXACT.length, selfApproved: true });
    expect(await auditsWith(NOTE_EXACT)).toEqual([]);
  });
});

describe("a keychain request cannot bypass the rule", () => {
  let key: Json;
  let kcHost = "";

  beforeAll(async () => {
    kcHost = `fake-mcp:${s.fakePort}`;
    key = await ok(
      s.sam.request("POST", "/api/v1/keychain", {
        scope: "personal",
        kind: "api_key",
        name: "KC whoami",
        value: "fake-kc-token",
        allowedHosts: [kcHost],
      }),
      201,
    );
    await ok(s.sam.request("PUT", `/api/v1/keychain/${key.id}/agents`, { agentIds: [keeperId] }));
  });

  const send = (ev: Json, url: string) =>
    cell("/http-requests", {
      eventId: ev.eventId,
      agentId: keeperId,
      handle: key.handle,
      method: "POST",
      url,
      body: "ping",
    });

  it("a POST → 409 approval_required and no outbound request; after approval the re-run reaches the target once", async () => {
    await clearRules();
    await rule({ pattern: "ocw_http_request", mode: "always" });
    const ev = await turnOf(s.sam, samDm);
    expect(ev.turn.toolFlags.ocw_http_request).toEqual({
      untrustedOutput: true,
      sideEffecting: true,
      approval: "always",
    });
    const url = `http://${kcHost}/kc/whoami`;
    const before = await fakeStats(s);
    const r = await send(ev, url);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(codeOf(r)).toBe("approval_required");
    expect(r.body?.error.details.approval).toMatchObject({ created: true, requesterName: "Sam Lee" });
    const after = await fakeStats(s);
    expect(after.kc.authorized + after.kc.rejected).toBe(before.kc.authorized + before.kc.rejected);

    const id = r.body?.error.details.approval.id as string;
    expect((await decide(s.sam, id, "approved")).status).toBe(200);
    const rerun = await rerunOf(id);
    const done = await send(rerun, url);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(JSON.parse(done.body?.body as string)).toEqual({ authorized: true, method: "bearer" });
    expect((await fakeStats(s)).kc.authorized).toBe(after.kc.authorized + 1);
    expect(await callsOf(rerun.eventId)).toEqual([
      { tool: "ocw_http_request", decision: "allowed", reason: null, approval_id: id },
    ]);

    // The same request to another URL is another action: a new approval.
    const other = await send(rerun, `${url}?again=1`);
    expect(codeOf(other)).toBe("approval_required");
    expect(other.body?.error.details.approval.id).not.toBe(id);
  });
});

describe("taint is lifted for the approved call only, and never laundered through the re-run", () => {
  const webFetch = (ev: Json) => ask(ev, "web_fetch", { params: { url: "https://example.com/page" } });

  it("when_tainted: a tainted turn asks; the re-run (tainted by a web call first) runs it once; other writes stay `tainted`", async () => {
    await clearRules();
    await rule({ pattern: WRITE, mode: "when_tainted" });
    const ev = await turnOf(s.sam, samDm);
    expect((await webFetch(ev)).body).toMatchObject({ allowed: true });
    const asked = await ask(ev, WRITE, { arguments: { text: "after web" } });
    expect(asked.body).toMatchObject({ allowed: false, reason: "approval_required" });
    // A tool with no rule after taint: refused exactly as today.
    expect((await ask(ev, DELETE)).body).toMatchObject({ allowed: false, reason: "tainted" });

    const id = asked.body?.approval.id as string;
    expect((await decide(s.sam, id, "approved")).status).toBe(200);
    const rerun = await rerunOf(id);
    expect((await webFetch(rerun)).body).toMatchObject({ allowed: true });
    expect((await ask(rerun, WRITE, { arguments: { text: "after web" } })).body).toMatchObject({
      allowed: true,
      reason: null,
    });
    expect((await ask(rerun, DELETE)).body).toMatchObject({ allowed: false, reason: "tainted" });
    expect((await turnRow(rerun.eventId)).tainted).toBe(true);
  });

  it("inherited taint: a request from a tainted turn re-runs tainted; the approved call once, an unruled write `tainted`", async () => {
    await clearRules();
    await rule({ pattern: WRITE, mode: "always" });
    const ev = await turnOf(s.sam, samDm);
    expect((await webFetch(ev)).body).toMatchObject({ allowed: true });
    const asked = await ask(ev, WRITE, { arguments: { text: "inherited" } });
    expect(asked.body).toMatchObject({ reason: "approval_required" });
    const id = asked.body?.approval.id as string;
    expect((await decide(s.sam, id, "approved")).status).toBe(200);

    const rerun = await rerunOf(id);
    expect((await turnRow(rerun.eventId)).tainted).toBe(true);
    expect((await ask(rerun, WRITE, { arguments: { text: "inherited" } })).body).toMatchObject({
      allowed: true,
    });
    expect((await approvalRow(id)).status).toBe("applied");
    expect((await ask(rerun, DELETE)).body).toMatchObject({ allowed: false, reason: "tainted" });
  });
});

describe("rules changed in the middle of a turn", () => {
  it("a rule added after delivery: the unflagged call without arguments → policy_changed; the next delivery is flagged", async () => {
    await clearRules();
    const ev = await turnOf(s.sam, samDm);
    expect(ev.turn.toolFlags[WRITE]).not.toHaveProperty("approval");
    await rule({ pattern: WRITE, mode: "always" });
    const r = await ask(ev, WRITE);
    expect(r.body).toMatchObject({ allowed: false, reason: "policy_changed" });
    expect(await callRow(r.body?.callId)).toMatchObject({ decision: "denied", reason: "policy_changed" });
    const next = await turnOf(s.sam, samDm);
    expect(next.turn.toolFlags[WRITE]).toMatchObject({ approval: "always" });
  });

  it("a rule removed after delivery: the flagged call with arguments is allowed, its arguments discarded unread", async () => {
    await clearRules();
    const id = await rule({ pattern: WRITE, mode: "always" });
    const ev = await turnOf(s.sam, samDm);
    expect(ev.turn.toolFlags[WRITE]).toMatchObject({ approval: "always" });
    await s.su.query("delete from app.tool_approval_policies where id = $1", [id]);
    const before = await countApprovals();
    const r = await ask(ev, WRITE, { arguments: { text: "SENTINEL-REMOVED" } });
    expect(r.body).toEqual({ callId: expect.any(String), allowed: true, reason: null });
    expect(await callRow(r.body?.callId)).toMatchObject({ decision: "allowed", approval_id: null });
    expect(await countApprovals()).toBe(before);
  });
});
