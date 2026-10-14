import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import {
  assertNoGlobalFetch,
  type ConnectorsStack,
  connectOAuth,
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

// ---------------------------------------------------------------- Task 2: taint and mid-turn changes

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
