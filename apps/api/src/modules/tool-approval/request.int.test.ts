import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvalRow,
  callFor,
  clearRequests,
  clearRules,
  countRows,
  decideAs,
  type Fixture,
  ok,
  requiredId,
  seedTurn,
  setRule,
  startToolApprovalFixture,
  stopToolApprovalFixture,
  storedAction,
  TOOL,
} from "../../testing-tool-approvals";
import { actionHash } from "../approval";

/**
 * `approvalForCall` (07.5-07, APPROVE-02, APPROVE-04, D-01, D-02, D-04, P-05): the one decision of an agent action
 * that needs a person, on a real PostgreSQL + Redis with the 07.2 primitive, called the way the agent-action routes
 * call it (one transaction opened as the turn's human, 07.5-11). Cast and seeding: `testing-tool-approvals.ts`.
 */

let f: Fixture;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => {
  f = await startToolApprovalFixture();
}, 180_000);

afterAll(async () => {
  await stopToolApprovalFixture(f);
});

beforeEach(async () => {
  await clearRequests(f);
});

describe("tracer: a call that needs approval becomes one request with its card, and its grant is used once (Task 1)", () => {
  it("required → one stored action and card → Sam approves → the same call in a new turn consumes the grant once", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const turn = await seedTurn(f);

    const first = await callFor(f, turn, { text: "hi", n: 1 }, { toolCallId: "c1" });
    expect(first).toEqual({
      kind: "required",
      approvalId: expect.any(String),
      created: true,
      waitingFor: "Waiting for Sam Lee to approve",
      requesterName: "Sam Lee",
    });
    const id = requiredId(first);

    // The stored action: canonical arguments, their hash, the turn's taint and the action hash over the tuple.
    const action = await storedAction(f, id);
    expect(action.arguments_canonical).toBe('{"n":1,"text":"hi"}');
    expect(action.arguments_sha256).toBe(sha256('{"n":1,"text":"hi"}'));
    expect(action.tainted).toBe(false);
    expect(action.tool).toBe(TOOL);
    expect(action.tool_call_id).toBe("c1");
    expect(action.event_id).toBe(turn.eventId);
    expect(action.source_kind).toBe("mcp");
    const expected = actionHash("tool.call", [
      f.keeperId,
      f.samId,
      f.dm,
      TOOL,
      sha256('{"n":1,"text":"hi"}'),
    ]);
    expect(action.action_hash).toBe(expected);

    // One pending request, 24 h, with its platform-owned card in Sam's DM.
    const row = await approvalRow(f, id);
    expect(row).toMatchObject({
      kind: "tool.call",
      mode: "grant",
      status: "pending",
      action_hash: expected,
      requested_by_agent_id: f.keeperId,
      requested_for_user_id: f.samId,
      event_id: turn.eventId,
    });
    const ttl = Date.parse(row.expires_at) - Date.parse(row.created_at);
    expect(Math.abs(ttl - 24 * 3600_000)).toBeLessThan(5_000);
    expect(row.card_message_id).toEqual(expect.any(String));
    const card = (
      await f.su.query(
        "select m.conversation_id, m.author_kind, m.author_id, c.platform_owned from app.messages m join app.message_cards c on c.message_id = m.id where m.id = $1",
        [row.card_message_id],
      )
    ).rows[0];
    expect(card).toEqual({
      conversation_id: f.dm,
      author_kind: "agent",
      author_id: f.keeperId,
      platform_owned: true,
    });
    const requested = (
      await f.su.query(
        "select metadata from app.audit_events where action = 'approval.requested' and resource_id = $1",
        [id],
      )
    ).rows;
    expect(requested).toHaveLength(1);
    expect(Object.keys(requested[0].metadata).sort()).toEqual([
      "approvalId",
      "kind",
      "mode",
      "resourceId",
      "resourceType",
    ]);

    // The same call again (same or another tool call id): the same request, no new row or card.
    for (const toolCallId of ["c1", "c2"]) {
      expect(await callFor(f, turn, { text: "hi", n: 1 }, { toolCallId })).toMatchObject({
        kind: "required",
        approvalId: id,
        created: false,
      });
    }
    expect(await countRows(f, "tool_call_approvals")).toBe(1);
    expect(await countRows(f, "approval_requests")).toBe(1);

    // Sam approves: a grant, not yet used.
    const decided = await decideAs(f, f.sam, id, "approved");
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(await approvalRow(f, id)).toMatchObject({ status: "approved", consumed_at: null });

    // The re-run: a new turn, the same values in another key order → the grant, consumed once.
    const rerun = await seedTurn(f);
    expect(await callFor(f, rerun, { n: 1, text: "hi" })).toEqual({ kind: "grant", approvalId: id });
    const used = await approvalRow(f, id);
    expect(used.status).toBe("applied");
    expect(used.consumed_at).not.toBeNull();
    const consumed = (
      await f.su.query(
        "select count(*)::int as n from app.audit_events where action = 'approval.grant_consumed' and resource_id = $1",
        [id],
      )
    ).rows[0].n;
    expect(consumed).toBe(1);

    // The claim of 07.5-11 records the call with its approval; the same call again in that turn is approval_used.
    await f.su.query(
      `insert into app.agent_tool_calls (organization_id, event_id, agent_id, user_id, tool, source_kind, decision, approval_id)
       values ($1, $2, $3, $4, $5, 'mcp', 'allowed', $6)`,
      [f.orgA, rerun.eventId, f.keeperId, f.samId, TOOL, id],
    );
    expect(await callFor(f, rerun, { text: "hi", n: 1 })).toEqual({
      kind: "refused",
      reason: "approval_used",
    });
    // Any changed value is another action: a new request.
    expect(await callFor(f, rerun, { n: 2, text: "hi" })).toMatchObject({ kind: "required", created: true });
  });

  it("stores the request turn's taint: a request from a tainted turn reads tainted", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const clean = await seedTurn(f);
    const tainted = await seedTurn(f, { tainted: true });
    const a = requiredId(await callFor(f, clean, { text: "clean" }));
    const b = requiredId(await callFor(f, tainted, { text: "tainted" }));
    expect((await storedAction(f, a)).tainted).toBe(false);
    expect((await storedAction(f, b)).tainted).toBe(true);
  });
});

/** Moves a request back in time (the database clock decides every window). */
async function ageRequest(
  id: string,
  interval: string,
  column: "decided_at" | "created" = "created",
): Promise<void> {
  if (column === "decided_at") {
    await f.su.query(
      `update app.approval_requests set decided_at = decided_at - $2::interval where id = $1`,
      [id, interval],
    );
    return;
  }
  await f.su.query(
    `update app.approval_requests
       set created_at = created_at - $2::interval, expires_at = expires_at - $2::interval,
           decided_at = decided_at - $2::interval
     where id = $1`,
    [id, interval],
  );
}

const CANARY = "CANARY-0757";

describe("guards under time, repetition and concurrency (Task 3)", () => {
  it("denied: the same values are refused for 24 h with who decided and their note, then may be asked again", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const id = requiredId(await callFor(f, await seedTurn(f), { text: `${CANARY} deny me` }));
    const row = await approvalRow(f, id);
    const denied = await f.sam.request("POST", `/api/v1/approvals/${id}/decision`, {
      outcome: "denied",
      actionHash: row.action_hash,
      note: "Not this week",
    });
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);

    const again = await callFor(f, await seedTurn(f), { text: `${CANARY} deny me` });
    expect(again).toEqual({
      kind: "refused",
      reason: "approval_denied",
      denial: { deciderName: "Sam Lee", note: "Not this week" },
    });
    expect(await countRows(f, "approval_requests")).toBe(1);
    expect(await countRows(f, "tool_call_approvals")).toBe(1);

    await ageRequest(id, "25 hours");
    expect(await callFor(f, await seedTurn(f), { text: `${CANARY} deny me` })).toMatchObject({
      kind: "required",
      created: true,
    });
  });

  it("at most 5 pending per (agent, requester): the 6th distinct call is too_many_pending, with no row or card", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const turn = await seedTurn(f);
    for (let i = 0; i < 5; i++) {
      expect(await callFor(f, turn, { text: `${CANARY} ${i}` })).toMatchObject({
        kind: "required",
        created: true,
      });
    }
    expect(await callFor(f, turn, { text: `${CANARY} 5` })).toEqual({
      kind: "refused",
      reason: "too_many_pending",
    });
    expect(await countRows(f, "approval_requests")).toBe(5);
    // A pending one that expires frees its place.
    const [oldest] = (
      await f.su.query("select id from app.approval_requests where kind = 'tool.call' order by id limit 1")
    ).rows;
    await ageRequest(oldest.id, "25 hours");
    expect(await callFor(f, turn, { text: `${CANARY} 5` })).toMatchObject({
      kind: "required",
      created: true,
    });
  });

  it("a pending request past 24 h reads expired and the same call asks again", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const id = requiredId(await callFor(f, await seedTurn(f), { text: "late" }));
    await ageRequest(id, "25 hours");
    expect((await ok(f.sam.request("GET", `/api/v1/approvals/${id}`))).status).toBe("expired");
    const next = await callFor(f, await seedTurn(f), { text: "late" });
    expect(next).toMatchObject({ kind: "required", created: true });
    expect(requiredId(next)).not.toBe(id);
  });

  it("an approval is usable for 15 minutes: decided 16 minutes ago, the same call asks again and the old card is past useBy", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const id = requiredId(await callFor(f, await seedTurn(f), { text: "slow" }));
    await expectOk(decideAs(f, f.sam, id, "approved"));
    await ageRequest(id, "16 minutes", "decided_at");
    const next = await callFor(f, await seedTurn(f), { text: "slow" });
    expect(next).toMatchObject({ kind: "required", created: true });
    expect(await approvalRow(f, id)).toMatchObject({ status: "approved", consumed_at: null });
    const card = await ok(
      f.sam.request("GET", `/api/v1/cards/${(await approvalRow(f, id)).card_message_id}`),
    );
    expect(Date.parse(card.approval.useBy)).toBeLessThan(Date.now());
  });

  it("two identical calls at once create one request and one card", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const [a, b] = [await seedTurn(f), await seedTurn(f)];
    const outs = await Promise.all([callFor(f, a, { text: "race" }), callFor(f, b, { text: "race" })]);
    expect(outs.map((o) => (o.kind === "required" ? o.created : o.kind)).sort()).toEqual([false, true]);
    expect(new Set(outs.map(requiredId)).size).toBe(1);
    expect(await countRows(f, "approval_requests")).toBe(1);
    expect(
      (
        await f.su.query(
          "select count(*)::int as n from app.approval_requests where card_message_id is not null and kind = 'tool.call'",
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("two re-runs at once against one approval: one grant, one approval_used, one consumption", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const id = requiredId(await callFor(f, await seedTurn(f), { text: "once" }));
    await expectOk(decideAs(f, f.sam, id, "approved"));
    const [a, b] = [await seedTurn(f), await seedTurn(f)];
    const outs = await Promise.all([callFor(f, a, { text: "once" }), callFor(f, b, { text: "once" })]);
    expect(outs).toContainEqual({ kind: "grant", approvalId: id });
    expect(outs).toContainEqual({ kind: "refused", reason: "approval_used" });
    const consumed = (
      await f.su.query(
        "select count(*)::int as n from app.audit_events where action = 'approval.grant_consumed' and resource_id = $1",
        [id],
      )
    ).rows[0].n;
    expect(consumed).toBe(1);
    expect(await countRows(f, "approval_requests")).toBe(1);
  });

  it("a client retry (same event and tool call id) returns the first request, even with other arguments", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const turn = await seedTurn(f);
    const first = requiredId(await callFor(f, turn, { text: "first" }, { toolCallId: "call-1" }));
    expect(await callFor(f, turn, { text: "second" }, { toolCallId: "call-1" })).toMatchObject({
      kind: "required",
      approvalId: first,
      created: false,
    });
    expect(await countRows(f, "tool_call_approvals")).toBe(1);
  });

  it("refuses arguments it cannot bind: invalid, too large, or missing; no rule reads nothing and stores nothing", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const turn = await seedTurn(f);
    expect(await callFor(f, turn, { s: "\ud800" })).toEqual({ kind: "refused", reason: "arguments_invalid" });
    expect(await callFor(f, turn, { s: "x".repeat(40 * 1024) })).toEqual({
      kind: "refused",
      reason: "arguments_too_large",
    });
    expect(await callFor(f, turn, null)).toEqual({ kind: "refused", reason: "policy_changed" });
    await clearRules(f);
    expect(await callFor(f, turn, { text: `${CANARY} no rule` })).toEqual({ kind: "none" });
    expect(await countRows(f, "tool_call_approvals")).toBe(0);
    expect(await countRows(f, "approval_requests")).toBe(0);
  });

  it("when_tainted asks only after outside content; always asks on a clean turn too", async () => {
    await setRule(f, { mode: "when_tainted", approverKind: "requester" });
    const turn = await seedTurn(f);
    expect(await callFor(f, turn, { text: "w" })).toEqual({ kind: "none" });
    await f.su.query("update app.agent_turns set tainted = true where event_id = $1", [turn.eventId]);
    expect(await callFor(f, turn, { text: "w" })).toMatchObject({ kind: "required", created: true });
    await setRule(f, { mode: "always", approverKind: "requester" });
    expect(await callFor(f, await seedTurn(f), { text: "a" })).toMatchObject({
      kind: "required",
      created: true,
    });
  });

  it("tenancy: another organization's turn, a foreign conversation or a removed requester is no turn (nothing stored)", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const foreignConv = randomUUID();
    await f.su.query(
      "insert into app.conversations (id, organization_id, kind, name) values ($1, $2, 'channel', 'evil')",
      [foreignConv, f.orgB],
    );
    const orgBEvent = randomUUID();
    await f.su.query(
      `insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id)
       values ($1, $2, $3, $4, $5, 'channel', $6)`,
      [orgBEvent, f.orgB, f.keeperId, f.eveId, foreignConv, randomUUID()],
    );
    const foreignTurn = { ...(await seedTurn(f)), eventId: orgBEvent };
    expect(await callFor(f, foreignTurn, { text: "x" })).toEqual({
      kind: "refused",
      reason: "policy_changed",
    });

    // An org A turn row naming org B's conversation (no FK on the column: WINDOWS 202).
    const crossed = await seedTurn(f);
    await f.su.query("update app.agent_turns set conversation_id = $2 where event_id = $1", [
      crossed.eventId,
      foreignConv,
    ]);
    expect(await callFor(f, crossed, { text: "x" })).toEqual({ kind: "refused", reason: "policy_changed" });

    // Another agent's turn id.
    const other = await seedTurn(f);
    expect(await callFor(f, { ...other, agentId: randomUUID() }, { text: "x" })).toEqual({
      kind: "refused",
      reason: "policy_changed",
    });

    // A requester deactivated since the turn.
    const gone = await seedTurn(f, { conversationId: f.dm });
    await f.su.query("update app.org_members set deactivated_at = now() where user_id = $1", [f.samId]);
    try {
      expect(await callFor(f, gone, { text: "x" })).toEqual({ kind: "refused", reason: "policy_changed" });
    } finally {
      await f.su.query("update app.org_members set deactivated_at = null where user_id = $1", [f.samId]);
    }
    expect(await countRows(f, "tool_call_approvals")).toBe(0);
    expect((await f.su.query("select count(*)::int as n from app.tool_call_approvals")).rows[0].n).toBe(0);
  });

  it("no argument value ever reaches an audit row, the call ledger or a log line (canary over the whole file)", async () => {
    // This test's own request, decided and used, so the canary is stored now and every audited step ran.
    await setRule(f, { mode: "always", approverKind: "requester" });
    const id = requiredId(await callFor(f, await seedTurn(f), { text: `${CANARY} last` }));
    await expectOk(decideAs(f, f.sam, id, "approved"));
    expect(await callFor(f, await seedTurn(f), { text: `${CANARY} last` })).toEqual({
      kind: "grant",
      approvalId: id,
    });
    const audit = await f.su.query(
      "select count(*)::int as n from app.audit_events where metadata::text like $1",
      [`%${CANARY}%`],
    );
    expect(audit.rows[0].n).toBe(0);
    const ledger = await f.su.query(
      "select count(*)::int as n from app.agent_tool_calls a where a::text like $1",
      [`%${CANARY}%`],
    );
    expect(ledger.rows[0].n).toBe(0);
    expect(f.stack.logs.filter((l) => l.includes(CANARY))).toEqual([]);
    // The canary did reach the one place it belongs, so the search would have found it.
    const stored = await f.su.query(
      "select count(*)::int as n from app.tool_call_approvals where arguments_canonical like $1",
      [`%${CANARY}%`],
    );
    expect(stored.rows[0].n).toBeGreaterThan(0);
  });
});

async function expectOk(res: Promise<{ status: number; body: unknown }>): Promise<void> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
