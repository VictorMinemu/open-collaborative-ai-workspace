import { randomUUID } from "node:crypto";
import { AgentCard, AgentCardActionEvent, ApprovalDetail } from "@ocw/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import {
  approvalRow,
  callFor,
  clearRequests,
  decideAs,
  type Fixture,
  type Json,
  ok,
  requiredId,
  SAFE,
  seedTurn,
  setRule,
  startToolApprovalFixture,
  stopToolApprovalFixture,
  storedAction,
  TOOL,
} from "../../testing-tool-approvals";
import { HIDDEN_WARNING, MASKED_WARNING, TAINT_WARNING, TRUNCATED_WARNING } from "./card";
import { NO_APPROVER } from "./view";

/**
 * The `tool.call` kind (07.5-07, D-04, P-07, P-09, UI-SPEC R3, R7): who decides (live, through the real decision
 * route), who sees the request, and what the card shows to whom, on a real PostgreSQL + Redis. Cast and seeding:
 * `testing-tool-approvals.ts`. Extra here: Sam and Luis hold the Lead role; Sam also belongs to Sales East (led by
 * Luis) and leads Marketing.
 */

let f: Fixture;
let channel: string;
let group: string;

const get = (as: TestClient, id: string) => as.request("GET", `/api/v1/approvals/${id}`);
const cardOf = async (as: TestClient, messageId: string) =>
  AgentCard.parse(await ok(as.request("GET", `/api/v1/cards/${messageId}`)));
const viewerCan = async (as: TestClient, id: string) => ((await ok(get(as, id))).viewerCan as string[]) ?? [];

async function expectStatus(
  res: Promise<{ status: number; body: Json | null }>,
  status: number,
  code?: string,
): Promise<void> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (code) expect(r.body?.error?.code).toBe(code);
}

/** A pending request for Sam from a fresh turn (DM by default). */
async function requestFor(
  args: Record<string, unknown> = { text: "hi" },
  turn: Parameters<typeof seedTurn>[1] = {},
): Promise<{ id: string; cardMessageId: string; eventId: string }> {
  const t = await seedTurn(f, turn);
  const id = requiredId(await callFor(f, t, args));
  const row = await approvalRow(f, id);
  return { id, cardMessageId: row.card_message_id as string, eventId: t.eventId };
}

/** Every place a value could leak to the readers of a conversation or to the logs: cards, bodies, streams, audit. */
async function leaks(sentinel: string): Promise<string[]> {
  const found: string[] = [];
  const probes: Array<[string, string]> = [
    ["message_cards", "select 1 from app.message_cards c where c::text like $1"],
    ["messages", "select 1 from app.messages m where m.body like $1"],
    ["stream_events", "select 1 from app.stream_events e where e.payload::text like $1"],
    ["audit_events", "select 1 from app.audit_events a where a.metadata::text like $1"],
    ["approval_requests", "select 1 from app.approval_requests r where r::text like $1"],
  ];
  for (const [name, q] of probes) {
    if ((await f.su.query(q, [`%${sentinel}%`])).rowCount) found.push(name);
  }
  if (f.stack.logs.some((l) => l.includes(sentinel))) found.push("logs");
  return found;
}

beforeAll(async () => {
  f = await startToolApprovalFixture();
  // Leading a unit needs the Lead (or Admin) role.
  await f.su.query("update app.org_members set role = 'lead' where user_id = any($1)", [[f.samId, f.luisId]]);
  await ok(f.victor.request("POST", `/api/v1/units/${f.salesEast}/members`, { userId: f.samId }));
  await ok(
    f.victor.request("POST", `/api/v1/units/${f.salesEast}/members`, { userId: f.luisId, role: "lead" }),
  );
  await ok(
    f.victor.request("POST", `/api/v1/units/${f.marketing}/members`, { userId: f.samId, role: "lead" }),
  );
  channel = (await ok(f.victor.request("POST", "/api/v1/channels", { name: "ops" }))).id as string;
  for (const member of [
    { kind: "user", id: f.samId },
    { kind: "user", id: f.martaId },
    { kind: "agent", id: f.keeperId },
  ]) {
    await ok(f.victor.request("POST", `/api/v1/channels/${channel}/members`, member));
  }
  group = (
    await ok(
      f.sam.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "agent", id: f.keeperId },
          { kind: "user", id: f.danaId },
        ],
      }),
    )
  ).id as string;
}, 180_000);

afterAll(async () => {
  await stopToolApprovalFixture(f);
});

beforeEach(async () => {
  await clearRequests(f);
  await f.su.query("update app.org_members set role = 'lead' where user_id = any($1)", [[f.samId, f.luisId]]);
  await f.su.query("update app.org_members set deactivated_at = null where user_id = $1", [f.luisId]);
});

describe("who decides, decided live at decision time (D-04, UI-SPEC R3)", () => {
  it("users [Marta]: Marta decides; Sam (the requester, not named) gets 403 not_approver", async () => {
    await setRule(f, { mode: "always", approverKind: "users", approverUserIds: [f.martaId] });
    const { id } = await requestFor();
    await expectStatus(decideAs(f, f.sam, id, "approved"), 403, "not_approver");
    expect(await viewerCan(f.marta, id)).toEqual(["decide"]);
    await expectStatus(decideAs(f, f.marta, id, "approved"), 200);
  });

  it("unit_leads on Sales East: its lead and a lead of its parent decide; Sam does not, though he leads Marketing", async () => {
    await setRule(f, { mode: "always", approverKind: "unit_leads", scopeUnitId: f.salesEast });
    const { id } = await requestFor();
    expect(await viewerCan(f.luis, id)).toEqual(["decide"]);
    expect(await viewerCan(f.marta, id)).toEqual(["decide"]);
    await expectStatus(decideAs(f, f.sam, id, "approved"), 403, "not_approver");
    await expectStatus(get(f.dana, id), 404);
    await expectStatus(decideAs(f, f.marta, id, "approved"), 200);
  });

  it("admins: a current admin decides; an admin demoted before deciding no longer can (the request hides as 404)", async () => {
    await setRule(f, { mode: "always", approverKind: "admins" });
    const { id } = await requestFor();
    await f.su.query("update app.org_members set role = 'admin' where user_id = $1", [f.luisId]);
    expect(await viewerCan(f.luis, id)).toEqual(["decide"]);
    await f.su.query("update app.org_members set role = 'lead' where user_id = $1", [f.luisId]);
    await expectStatus(decideAs(f, f.luis, id, "approved"), 404);
    await expectStatus(decideAs(f, f.victor, id, "approved"), 200);
  });

  it("the decision right decides, not who asked (ADR-0023 §15 amended): an admin requester decides under admins, audited selfApproved", async () => {
    await setRule(f, { mode: "always", approverKind: "admins" });
    await f.su.query("update app.org_members set role = 'admin' where user_id = $1", [f.samId]);
    const { id } = await requestFor();
    await expectStatus(decideAs(f, f.sam, id, "approved"), 200);
    const audit = (
      await f.su.query(
        "select metadata from app.audit_events where action = 'approval.decided' and resource_id = $1",
        [id],
      )
    ).rows[0]?.metadata;
    expect(audit).toMatchObject({ outcome: "approved", selfApproved: true });
  });

  it("requester: only Sam decides; an admin cannot even see it", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const { id } = await requestFor();
    await expectStatus(get(f.victor, id), 404);
    await expectStatus(decideAs(f, f.victor, id, "approved"), 404);
    await expectStatus(decideAs(f, f.sam, id, "approved"), 200);
  });

  it("the rule tightened to users [Luis] after the request: Marta no longer decides, Luis does", async () => {
    const policyId = await setRule(f, {
      mode: "always",
      approverKind: "users",
      approverUserIds: [f.martaId],
    });
    const { id } = await requestFor();
    await f.su.query("update app.tool_approval_policies set approver_user_ids = $1 where id = $2", [
      [f.luisId],
      policyId,
    ]);
    await expectStatus(decideAs(f, f.marta, id, "approved"), 404);
    await expectStatus(decideAs(f, f.luis, id, "approved"), 200);
  });

  it("the rule deleted after the request: the requester decides", async () => {
    await setRule(f, { mode: "always", approverKind: "users", approverUserIds: [f.martaId] });
    const { id } = await requestFor();
    await f.su.query("delete from app.tool_approval_policies where organization_id = $1", [f.orgA]);
    await expectStatus(decideAs(f, f.marta, id, "approved"), 404);
    await expectStatus(decideAs(f, f.sam, id, "approved"), 200);
  });

  it("a users rule whose people are gone has no approver: nobody decides and the card says so", async () => {
    for (const gone of ["deactivated", "never a member"] as const) {
      await clearRequests(f);
      const named = gone === "deactivated" ? f.luisId : randomUUID();
      await setRule(f, { mode: "always", approverKind: "users", approverUserIds: [named] });
      if (gone === "deactivated") {
        await f.su.query("update app.org_members set deactivated_at = now() where user_id = $1", [f.luisId]);
      }
      const t = await seedTurn(f);
      const out = await callFor(f, t, { text: gone });
      expect(out).toMatchObject({ kind: "required", waitingFor: NO_APPROVER });
      const id = requiredId(out);
      await expectStatus(decideAs(f, f.sam, id, "approved"), 403, "not_approver");
      await expectStatus(decideAs(f, f.victor, id, "approved"), 404);
      const card = await cardOf(f.sam, (await approvalRow(f, id)).card_message_id);
      expect(card.approval?.waitingFor).toBe(NO_APPROVER);
      expect(card.viewerCan ?? []).not.toContain("decide");
      await f.su.query("update app.org_members set deactivated_at = null where user_id = $1", [f.luisId]);
    }
  });
});

describe("who sees the request (P-09, 404-hiding)", () => {
  it("another member and another organization's admin get 404; the requester and the deciders get the full view", async () => {
    await setRule(f, { mode: "always", approverKind: "admins" });
    const { id, cardMessageId } = await requestFor({
      to: "billing@globex.example",
      amount: 1250,
      note: "a\nb",
    });
    await expectStatus(get(f.dana, id), 404);
    await expectStatus(get(f.eve, id), 404);

    const mine = ApprovalDetail.parse(await ok(get(f.sam, id)));
    expect(mine.view.type).toBe("tool_call");
    if (mine.view.type !== "tool_call") throw new Error("not a tool_call view");
    expect(mine.view).toMatchObject({
      title: "Run write_note on Notes",
      tool: TOOL,
      source: { kind: "mcp", name: "Notes", account: "org", keyName: null },
      // WINDOWS #221: the internal server name never reaches a person (it is the tool's own `<safe>__` prefix).
      target: null,
      truncated: false,
      argumentsJson: '{\n  "amount": 1250,\n  "note": "a\\nb",\n  "to": "billing@globex.example"\n}',
      tainted: false,
      agent: { id: f.keeperId, displayName: "Keeper" },
      requestedFor: { id: f.samId, displayName: "Sam Lee" },
      approverLabel: "Waiting for an admin",
      policy: {
        scopeUnitId: null,
        scopeLabel: "Organization",
        mode: "always",
        pattern: TOOL,
        viewerCanManage: false,
      },
      useBy: null,
      usedAt: null,
    });
    expect(mine.view.preview.map((p) => p.label)).toEqual(["To", "Amount", "Note"]);
    // Sam reads his DM: one reader; the request: Sam and the one admin.
    expect(mine.view.audience).toEqual({
      origin: { kind: "dm", name: null },
      conversationReaders: 1,
      detailReaders: 2,
      messageRoute: `/chat/dm/${f.dm}?m=${cardMessageId}`,
    });

    const admin = ApprovalDetail.parse(await ok(get(f.victor, id)));
    if (admin.view.type !== "tool_call") throw new Error("not a tool_call view");
    expect(admin.viewerCan).toEqual(["decide"]);
    expect(admin.view.policy?.viewerCanManage).toBe(true);
    // Víctor cannot read Sam's DM: no permalink.
    expect(admin.view.audience.messageRoute).toBeNull();
  });
});

describe("what the card shows to whom (P-07, Pitfall 7, UI-SPEC Surface 1)", () => {
  it("Sam's DM (he is its single human): the exact action, Approve/Deny and Review", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const { id, cardMessageId } = await requestFor({ to: "ana@example.test", text: "hello" });
    const card = await cardOf(f.sam, cardMessageId);
    expect(card.title).toBe("Run write_note on Notes");
    expect(card.fields).toEqual([
      { label: "Tool", value: "write_note" },
      { label: "Source", value: "Notes · MCP server" },
      { label: "To", value: "ana@example.test" },
      { label: "Text", value: "hello" },
    ]);
    // WINDOWS #221: the internal MCP server name is nowhere on the card.
    expect(JSON.stringify(card)).not.toContain(SAFE);
    expect(card.actions).toEqual([
      { kind: "approve", label: "Approve", denyLabel: "Deny" },
      { kind: "open", label: "Review", target: `/approvals/${id}` },
    ]);
    expect(card.approval).toMatchObject({
      kind: "tool.call",
      display: "exact",
      actionFields: 2,
      waitingFor: "Waiting for Sam Lee to approve",
      useBy: null,
      warnings: [],
    });
    expect(card.viewerCan).toContain("decide");
  });

  it("a 600-character value: review_only, still decidable, with the truncated warning; hidden characters and secrets warn", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const long = await requestFor({ text: "x".repeat(600) });
    const card = await cardOf(f.sam, long.cardMessageId);
    expect(card.approval?.display).toBe("review_only");
    expect(card.actions.map((a) => a.kind)).toEqual(["approve", "open"]);
    expect(card.approval?.warnings).toEqual([TRUNCATED_WARNING]);
    expect(card.fields.find((x) => x.label === "Text")?.value).toHaveLength(500);

    const odd = await requestFor({ to: "pay‮to", key: `sk-ant-api03-${"Ab3_".repeat(10)}9f2c` });
    const shown = await cardOf(f.sam, odd.cardMessageId);
    expect(shown.approval?.display).toBe("exact");
    expect(shown.approval?.warnings).toEqual([HIDDEN_WARNING, MASKED_WARNING]);
    expect(shown.fields.find((x) => x.label === "To")?.value).toBe("pay⟨U+202E⟩to");
    expect(shown.fields.find((x) => x.label === "Key")?.value).toBe("sk-ant-•••• 9f2c");
  });

  it("a tainted request carries the taint warning", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    const { cardMessageId } = await requestFor({ text: "t" }, { tainted: true });
    expect((await cardOf(f.sam, cardMessageId)).approval?.warnings).toEqual([TAINT_WARNING("Keeper")]);
  });

  for (const where of ["channel", "thread", "group DM"] as const) {
    it(`in a ${where}: a summary with Tool and Source only, no Approve, and no value anywhere a reader or log sees`, async () => {
      await setRule(f, { mode: "always", approverKind: "users", approverUserIds: [f.martaId] });
      const sentinel = `SENTINEL-${randomUUID()}`;
      let turn: Parameters<typeof seedTurn>[1];
      if (where === "channel") turn = { conversationId: channel, conversationKind: "channel" };
      else if (where === "group DM") turn = { conversationId: group, conversationKind: "group" };
      else {
        const root = await ok(
          f.sam.request("POST", `/api/v1/conversations/${channel}/messages`, { body: "root" }),
        );
        turn = { conversationId: channel, conversationKind: "channel", threadRootId: root.id as string };
      }
      const { id, cardMessageId } = await requestFor(
        { text: sentinel, to: sentinel },
        { ...turn, tainted: true },
      );
      const card = await cardOf(f.sam, cardMessageId);
      expect(card.title).toBe("Keeper wants to run write_note for Sam Lee");
      expect(card.fields).toEqual([
        { label: "Tool", value: "write_note" },
        { label: "Source", value: "Notes" },
      ]);
      expect(card.actions).toEqual([{ kind: "open", label: "Review", target: `/approvals/${id}` }]);
      expect(card.approval).toMatchObject({
        display: "summary",
        actionFields: 2,
        waitingFor: "Waiting for Marta Gil",
        warnings: [TAINT_WARNING("Keeper")],
      });
      if (where === "thread") {
        const msg = (await f.su.query("select thread_id from app.messages where id = $1", [cardMessageId]))
          .rows[0];
        expect(msg.thread_id).toEqual(expect.any(String));
      }
      // The values are only in the stored action, readable through the review by Sam and Marta.
      expect(await leaks(sentinel)).toEqual([]);
      expect((await storedAction(f, id)).arguments_canonical).toContain(sentinel);
      const view = ApprovalDetail.parse(await ok(get(f.marta, id)));
      if (view.view.type !== "tool_call") throw new Error("not a tool_call view");
      expect(view.view.audience.origin.kind).toBe(where === "group DM" ? "group" : where);
    });
  }
});

describe("inbox row, card link and the re-run's grant (06 hooks)", () => {
  it("headline names the action, the bot, where it was asked and its chips", async () => {
    await setRule(f, { mode: "always", approverKind: "requester" });
    await requestFor({ text: "plain" });
    await requestFor({ text: "outside" }, { tainted: true });
    const list = await ok(f.sam.request("GET", "/api/v1/approvals?role=requester&kinds=tool.call"));
    const heads = (list.items as Json[]).map((i) => i.headline);
    expect(heads).toHaveLength(2);
    const [tainted, plain] = heads;
    expect(plain).toEqual({
      title: "Run write_note on Notes",
      context: "DM",
      requester: "Keeper for Sam Lee",
      tags: [],
      agent: { id: f.keeperId, displayName: "Keeper" },
      origin: { kind: "dm", name: null },
      chips: [{ kind: "source", label: "Notes", icon: "plug" }],
      useBy: null,
    });
    expect(tainted.chips).toEqual([
      { kind: "source", label: "Notes", icon: "plug" },
      { kind: "tainted", label: "Outside content" },
    ]);
    expect(tainted.tags).toEqual([{ label: "Outside content", tone: "warning" }]);
  });

  for (const tainted of [false, true]) {
    it(`approved (${tainted ? "tainted" : "clean"} request): useBy is the decision + 15 min, the re-run carries the grant and ${tainted ? "starts tainted" : "starts clean"}`, async () => {
      await setRule(f, { mode: "always", approverKind: "requester" });
      const { id, cardMessageId } = await requestFor({ n: 1, text: "go" }, { tainted });
      await expectStatus(decideAs(f, f.sam, id, "approved"), 200);
      const row = await approvalRow(f, id);
      const useBy = new Date(new Date(row.decided_at).getTime() + 15 * 60_000).toISOString();
      expect((await cardOf(f.sam, cardMessageId)).approval).toMatchObject({ status: "approved", useBy });
      const events = (
        await f.su.query(
          "select payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2",
          [`cell:${f.orgA}`, cardMessageId],
        )
      ).rows.map((r) => AgentCardActionEvent.parse({ ...r.payload, seq: 1 }));
      expect(events).toHaveLength(1);
      const ev = events[0] as AgentCardActionEvent;
      expect(ev.cardAction.grant).toEqual({ tool: TOOL, arguments: '{"n":1,"text":"go"}', useBy });
      const rerun = (
        await f.su.query("select user_id, tainted from app.agent_turns where event_id = $1", [ev.eventId])
      ).rows[0];
      expect(rerun).toEqual({ user_id: f.samId, tainted });
    });
  }
});
