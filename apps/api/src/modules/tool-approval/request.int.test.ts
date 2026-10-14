import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvalRow,
  callFor,
  clearRequests,
  countRows,
  decideAs,
  type Fixture,
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
