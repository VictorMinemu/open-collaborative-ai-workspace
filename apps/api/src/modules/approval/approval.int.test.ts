import { randomUUID } from "node:crypto";
import {
  AgentCard,
  AgentCardActionEvent,
  ApprovalDetail,
  ApprovalList,
  ApprovalSummary,
} from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { errorCode, invite } from "../../testing-workzone";
import type { ApprovalKind, ApprovalService } from "./index";

/**
 * 07.2-06 (MEM-06, D-05, D-08, ADR-0023): the approve-and-apply primitive on a real PostgreSQL + Redis, through the
 * real routes. Test-only kinds stand in for 07.2's memory proposals and 07.5's tool grants: their "stored action" is an
 * in-memory map keyed by resource id, so a test can change it between view and decision.
 *
 * Cast: Víctor (admin) and Alex (developer) are the deciders of the test kinds; Sam Lee (standard) is the human the
 * requests are made for; Riley (developer) is an outsider.
 */

const CELL_TOKEN = "ocw-test-cell-token-approvals-0123456789abcdef";

let stack: AiStack;
let su: pg.Client;
let approvals: ApprovalService;
let victor: TestClient;
let alex: TestClient;
let sam: TestClient;
let riley: TestClient;
let victorId: string;
let alexId: string;
let samId: string;
let rileyId: string;
let orgId: string;
let keeperId: string;
let cell: FakeCellPlugin;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

/** The stored action of each test request, keyed by resource id (what `hashInput` reads). */
const stored = new Map<string, { target: string; version: number }>();
/** Resource ids whose `apply` writes and then reports a conflict. */
const failing = new Set<string>();
/** Who may decide the test kinds (live: tests add and remove people). */
const deciders = new Set<string>();
let applyCalls = 0;

function testKind(
  kind: string,
  mode: "server_apply" | "grant",
  extra: Partial<ApprovalKind> = {},
): ApprovalKind {
  return {
    kind,
    mode,
    resourceType: "test_action",
    ttlMs: 60 * 60 * 1000,
    async hashInput(_tx, row) {
      const a = stored.get(row.resourceId);
      if (!a) throw new Error("no stored action");
      return [a.target, a.version];
    },
    async canDecide(_tx, userId) {
      return deciders.has(userId);
    },
    async audience() {
      return [...deciders];
    },
    async view(_tx, row) {
      return {
        type: "fields",
        title: "Test action",
        fields: [{ label: "Target", value: stored.get(row.resourceId)?.target ?? "gone" }],
      };
    },
    ...(mode === "server_apply"
      ? {
          async apply(tx, row) {
            applyCalls += 1;
            await stack.built.core.audit.record(tx, {
              action: "test.applied",
              resourceType: "test_action",
              resourceId: row.resourceId,
              metadata: { approvalId: row.id },
            });
            return failing.has(row.resourceId) ? { ok: false, code: "test_conflict" } : { ok: true };
          },
        }
      : {}),
    ...extra,
  };
}

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

/** A pending request of `kind` made for `forUserId`, whose stored action targets `target`. */
async function request(
  kind: string,
  opts: {
    forUserId?: string | null;
    target?: string;
    card?: { conversationId: string; inReplyToMessageId: string };
  } = {},
) {
  const resourceId = randomUUID();
  stored.set(resourceId, { target: opts.target ?? `target-${resourceId.slice(0, 8)}`, version: 1 });
  const forUserId = opts.forUserId === undefined ? samId : opts.forUserId;
  const out = await stack.built.core.db.withTenant({ organizationId: orgId, userId: forUserId }, (tx) =>
    approvals.request(tx, {
      kind,
      resourceId,
      requestedByAgentId: opts.card ? keeperId : null,
      requestedForUserId: forUserId,
      eventId: null,
      ...(opts.card
        ? {
            card: {
              agentId: keeperId,
              conversationId: opts.card.conversationId,
              inReplyToMessageId: opts.card.inReplyToMessageId,
              threadRootMessageId: null,
            },
          }
        : {}),
    }),
  );
  return { ...out, resourceId };
}

const decide = (as: TestClient, id: string, body: Json) =>
  as.request("POST", `/api/v1/approvals/${id}/decision`, body);

const rowOf = async (id: string) =>
  (await su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

const auditsFor = async (action: string, resourceId: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, metadata, result from app.audit_events where action = $1 and resource_id = $2 order by occurred_at",
      [action, resourceId],
    )
  ).rows as Json[];

/** Every `approval_request.updated` appended for one request: the stream it went to and its payload. */
const updatesOf = async (id: string) =>
  (
    await su.query(
      "select stream_id, payload from app.stream_events where type = 'approval_request.updated' and payload->>'id' = $1 order by stream_id, seq",
      [id],
    )
  ).rows as Array<{ stream_id: string; payload: Json }>;

beforeAll(async () => {
  stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  approvals = stack.built.approvals;
  approvals.register(testKind("test.apply", "server_apply"));
  approvals.register(testKind("test.grant", "grant"));
  approvals.register(
    testKind("test.private", "server_apply", {
      async canDecide(_tx, userId, row) {
        return userId === row.requestedForUserId;
      },
      async audience(_tx, row) {
        return row.requestedForUserId ? [row.requestedForUserId] : [];
      },
      async isPrivate() {
        return true;
      },
    }),
  );
  // A personal-like kind mirrored as a card: only the human it was requested for decides (07.2's personal proposals).
  approvals.register(
    testKind("test.card", "server_apply", {
      async canDecide(_tx, userId, row) {
        return userId === row.requestedForUserId;
      },
      async audience(_tx, row) {
        return row.requestedForUserId ? [row.requestedForUserId] : [];
      },
      async card(_tx, row) {
        return {
          card: {
            kind: "approval",
            title: "Apply test action",
            fields: [{ label: "Target", value: stored.get(row.resourceId)?.target ?? "gone" }],
            status: "pending",
            actions: [{ kind: "open", label: "Review", target: `/memory/proposals/${row.id}` }],
            summary: "Keeper asks to apply a test action",
          },
          warnings: ["Keeper read web or tool content in this turn."],
        };
      },
    }),
  );
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
  orgId = (setup.organization as Json).id as string;
  victorId = await meId(victor);
  ({ client: alex, userId: alexId } = await invite(
    stack,
    victor,
    "alex@example.test",
    "Alex Kim",
    "developer",
  ));
  ({ client: sam, userId: samId } = await invite(stack, victor, "sam@example.test", "Sam Lee", "standard"));
  ({ client: riley, userId: rileyId } = await invite(
    stack,
    victor,
    "riley@example.test",
    "Riley Park",
    "developer",
  ));
  await seedPlan(victor);
  deciders.add(victorId).add(alexId);
  keeperId = (
    await ok(
      victor.request("POST", "/api/v1/agents", {
        name: "Keeper",
        username: "keeper",
        instructions: "You are Keeper.",
        modelProvider: "mock",
        modelId: "mock-1",
      }),
    )
  ).id as string;
  cell = new FakeCellPlugin({ apiUrl: stack.baseUrl, token: CELL_TOKEN });
}, 180_000);

afterAll(async () => {
  await cell?.stop();
  await su?.end();
  await stack?.stop();
});

describe("registry", () => {
  it("refuses a duplicate kind, a server_apply kind without apply, a grant with apply and a bad id", () => {
    expect(() => approvals.register(testKind("test.apply", "server_apply"))).toThrow(/already registered/);
    expect(() =>
      approvals.register({ ...testKind("test.noapply", "server_apply"), apply: undefined }),
    ).toThrow(/no apply hook/);
    expect(() =>
      approvals.register({
        ...testKind("test.grantapply", "grant"),
        apply: async () => ({ ok: true }),
      }),
    ).toThrow(/must not have an apply hook/);
    expect(() => approvals.register(testKind("Bad Kind", "grant"))).toThrow(/invalid approval kind id/);
    expect(() => approvals.register({ ...testKind("test.nottl", "grant"), ttlMs: 0 })).toThrow(/ttlMs/);
  });
});

describe("tracer: a test kind is requested, viewed, decided and applied in one audited transaction (Task 1)", () => {
  let id: string;
  let hash: string;
  let resourceId: string;

  it("request → pending row with the stored hash, audited, announced to the deciders and the requester", async () => {
    ({ id, actionHash: hash, resourceId } = await request("test.apply"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const row = await rowOf(id);
    expect(row).toMatchObject({
      kind: "test.apply",
      mode: "server_apply",
      resource_type: "test_action",
      resource_id: resourceId,
      action_hash: hash,
      status: "pending",
      requested_for_user_id: samId,
      consumed_at: null,
    });
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    const [audit] = await auditsFor("approval.requested", id);
    expect(audit?.metadata).toEqual({
      approvalId: id,
      kind: "test.apply",
      mode: "server_apply",
      resourceType: "test_action",
      resourceId,
    });
    expect((await updatesOf(id)).map((u) => u.stream_id).sort()).toEqual(
      [`user:${alexId}`, `user:${samId}`, `user:${victorId}`].sort(),
    );
  });

  it("GET /approvals?role=decider lists it for a decider, not for an outsider; role=requester lists it for Sam", async () => {
    const forVictor = ApprovalList.parse(await ok(victor.request("GET", "/api/v1/approvals?role=decider")));
    const mine = forVictor.items.find((i) => i.id === id);
    expect(mine).toMatchObject({ status: "pending", actionHash: hash, viewerCan: ["decide"] });
    expect(mine?.requestedBy).toEqual({ agentId: null, userId: samId, displayName: "Sam Lee" });
    const forRiley = ApprovalList.parse(await ok(riley.request("GET", "/api/v1/approvals?role=decider")));
    expect(forRiley.items.map((i) => i.id)).not.toContain(id);
    const forSam = ApprovalList.parse(await ok(sam.request("GET", "/api/v1/approvals?role=requester")));
    expect(forSam.items.find((i) => i.id === id)).toMatchObject({ viewerCan: [] });
    const samAsDecider = ApprovalList.parse(await ok(sam.request("GET", "/api/v1/approvals?role=decider")));
    expect(samAsDecider.items.map((i) => i.id)).not.toContain(id);
  });

  it("GET /approvals/:id returns the kind's view and the action hash", async () => {
    const detail = ApprovalDetail.parse(await ok(alex.request("GET", `/api/v1/approvals/${id}`)));
    expect(detail).toMatchObject({ id, kind: "test.apply", actionHash: hash, viewerCan: ["decide"] });
    expect(detail.view).toEqual({
      type: "fields",
      title: "Test action",
      fields: [{ label: "Target", value: stored.get(resourceId)?.target }],
    });
    expect(deciders.has(rileyId)).toBe(false);
    const hidden = await riley.request("GET", `/api/v1/approvals/${id}`);
    expect(hidden.status).toBe(404);
    expect(errorCode(hidden)).toBe("approval_not_found");
  });

  it("POST …/decision approved → 200 applied; consumed and applied once; audits with ids only; user: streams only", async () => {
    const before = applyCalls;
    const res = await decide(victor, id, { outcome: "approved", actionHash: hash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const summary = ApprovalSummary.parse(res.body);
    expect(summary).toMatchObject({
      status: "applied",
      decidedBy: { id: victorId, displayName: "Víctor Ruiz" },
      decisionNote: null,
      resultCode: null,
      viewerCan: [],
    });
    expect(applyCalls).toBe(before + 1);
    const row = await rowOf(id);
    expect(row.status).toBe("applied");
    expect(row.consumed_at).not.toBeNull();
    expect(row.applied_at).not.toBeNull();
    expect(row.decided_by).toBe(victorId);
    expect(await auditsFor("test.applied", resourceId)).toHaveLength(1);
    const [decided] = await auditsFor("approval.decided", id);
    expect(decided).toMatchObject({
      actor_kind: "user",
      actor_id: victorId,
      metadata: { approvalId: id, kind: "test.apply", mode: "server_apply", outcome: "approved" },
    });
    // Víctor decided a request made for Sam: not a self-approval.
    expect(decided?.metadata).not.toHaveProperty("selfApproved");
    const [applied] = await auditsFor("approval.applied", id);
    expect(applied?.metadata).toEqual({ approvalId: id, kind: "test.apply", mode: "server_apply" });
    const updates = await updatesOf(id);
    expect(updates.every((u) => u.stream_id.startsWith("user:"))).toBe(true);
    expect(
      updates
        .filter((u) => u.payload.status === "applied")
        .map((u) => u.stream_id)
        .sort(),
    ).toEqual([`user:${alexId}`, `user:${samId}`, `user:${victorId}`].sort());
    for (const u of updates) expect(Object.keys(u.payload).sort()).toEqual(["id", "status"]);
    const onOrg = await su.query(
      "select count(*)::int as n from app.stream_events where stream_id like 'org:%' and payload::text like $1",
      [`%${id}%`],
    );
    expect(onOrg.rows[0].n).toBe(0);
  });

  it("denied → status denied, apply never called, the grant never consumed", async () => {
    const r = await request("test.apply");
    const before = applyCalls;
    const res = await decide(alex, r.id, { outcome: "denied", actionHash: r.actionHash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ApprovalSummary.parse(res.body).status).toBe("denied");
    expect(applyCalls).toBe(before);
    expect(await rowOf(r.id)).toMatchObject({ status: "denied", consumed_at: null, applied_at: null });
    expect(await auditsFor("test.applied", r.resourceId)).toHaveLength(0);
  });

  it("a note is stored and audited as text; a private kind audits only its length; 281 characters → 400", async () => {
    const r = await request("test.apply");
    const note = "Duplicate of the CRM entry";
    const res = await decide(victor, r.id, { outcome: "denied", actionHash: r.actionHash, note });
    expect(res.status).toBe(200);
    expect(
      ApprovalDetail.parse(await ok(victor.request("GET", `/api/v1/approvals/${r.id}`))).decisionNote,
    ).toBe(note);
    expect((await auditsFor("approval.decided", r.id))[0]?.metadata).toMatchObject({ note });

    // test.private: only the human it was requested for decides (Sam, as a personal-scope owner would).
    const p = await request("test.private");
    const secret = "Mentions my medical appointment";
    const pres = await decide(sam, p.id, { outcome: "approved", actionHash: p.actionHash, note: secret });
    expect(pres.status, JSON.stringify(pres.body)).toBe(200);
    const meta = (await auditsFor("approval.decided", p.id))[0]?.metadata as Json;
    expect(meta.noteChars).toBe(secret.length);
    // Sam decided his own request: the audit records it as a flag (owner decision 2026-10-13).
    expect(meta.selfApproved).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("medical");

    const long = await request("test.apply");
    const tooLong = await decide(victor, long.id, {
      outcome: "approved",
      actionHash: long.actionHash,
      note: "x".repeat(281),
    });
    expect(tooLong.status).toBe(400);
    expect((await rowOf(long.id)).status).toBe("pending");
  });

  it("apply not ok → failed with its result code; its writes rolled back (savepoint); approval.apply_failed", async () => {
    const r = await request("test.apply");
    failing.add(r.resourceId);
    const res = await decide(victor, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ApprovalSummary.parse(res.body)).toMatchObject({ status: "failed", resultCode: "test_conflict" });
    expect(await rowOf(r.id)).toMatchObject({
      status: "failed",
      result_code: "test_conflict",
      applied_at: null,
    });
    expect(await auditsFor("test.applied", r.resourceId)).toHaveLength(0);
    const [failed] = await auditsFor("approval.apply_failed", r.id);
    expect(failed).toMatchObject({
      result: "error",
      metadata: { approvalId: r.id, resultCode: "test_conflict" },
    });
  });

  it("the routes authenticate first: anonymous → 401", async () => {
    const anon = new TestClient(stack.baseUrl);
    expect((await anon.request("GET", "/api/v1/approvals?role=decider")).status).toBe(401);
    expect((await anon.request("GET", `/api/v1/approvals/${randomUUID()}`)).status).toBe(401);
    const post = await anon.request("POST", `/api/v1/approvals/${randomUUID()}/decision`, {});
    expect(post.status).toBe(401);
    expect(errorCode(post)).toBeDefined();
  });
});

/** Every `agent.card_action.v1` the API appended for one card (the cell stream is the delivery ledger). */
const cardActionsOf = async (messageId: string) =>
  (
    await su.query(
      "select seq, payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${orgId}`, messageId],
    )
  ).rows.map((r) => AgentCardActionEvent.parse({ ...r.payload, seq: Number(r.seq) }));

const cardRow = async (messageId: string) =>
  (await su.query("select * from app.message_cards where message_id = $1", [messageId])).rows[0] as Json;

const cardFor = async (as: TestClient, messageId: string) =>
  AgentCard.parse(await ok(as.request("GET", `/api/v1/cards/${messageId}`)));

const decideCard = (as: TestClient, messageId: string, body: Json) =>
  as.request("POST", `/api/v1/cards/${messageId}/decision`, body);

describe("platform-owned card mirror: the agent cannot edit it, deciding it goes through the primitive (Task 2)", () => {
  let dm: string;
  let asked: string;
  let group: string;
  let groupAsked: string;

  beforeAll(async () => {
    dm = (await ok(sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] })))
      .id as string;
    asked = (await ok(sam.request("POST", `/api/v1/conversations/${dm}/messages`, { body: "remember this" })))
      .id as string;
    group = (
      await ok(
        sam.request("POST", "/api/v1/dms", {
          participants: [
            { kind: "user", id: rileyId },
            { kind: "agent", id: keeperId },
          ],
        }),
      )
    ).id as string;
    groupAsked = (
      await ok(
        sam.request("POST", `/api/v1/conversations/${group}/messages`, { body: "@keeper remember this" }),
      )
    ).id as string;
  });

  it("request with a card target posts one platform-owned approval card replying in the DM; the snapshot links the approval", async () => {
    const r = await request("test.card", { card: { conversationId: dm, inReplyToMessageId: asked } });
    expect(r.cardMessageId).toBeTruthy();
    const messageId = r.cardMessageId as string;
    expect((await rowOf(r.id)).card_message_id).toBe(messageId);
    expect((await rowOf(r.id)).card_warnings).toEqual(["Keeper read web or tool content in this turn."]);
    expect(await cardRow(messageId)).toMatchObject({
      platform_owned: true,
      kind: "approval",
      status: "pending",
      agent_id: keeperId,
      conversation_id: dm,
    });
    const card = await cardFor(sam, messageId);
    expect(card).toMatchObject({
      kind: "approval",
      title: "Apply test action",
      status: "pending",
      platformOwned: true,
      viewerCan: ["follow", "decide"],
      approval: {
        id: r.id,
        actionHash: r.actionHash,
        status: "pending",
        requestedForUserId: samId,
        warnings: ["Keeper read web or tool content in this turn."],
        resultCode: null,
      },
    });
    expect(card.actions.map((a) => a.kind).sort()).toEqual(["approve", "open"]);
    expect(card.actions.find((a) => a.kind === "approve")).not.toHaveProperty("approverIds");
    expect(card.actions.find((a) => a.kind === "open")).toMatchObject({
      target: `/memory/proposals/${r.id}`,
    });
    const msg = (
      await su.query("select author_kind, author_id, body from app.messages where id = $1", [messageId])
    ).rows[0];
    expect(msg).toEqual({
      author_kind: "agent",
      author_id: keeperId,
      body: "Keeper asks to apply a test action",
    });
  });

  it("the agent's PATCH of a platform-owned card is 403 card_platform_owned and changes nothing", async () => {
    const r = await request("test.card", { card: { conversationId: dm, inReplyToMessageId: asked } });
    const messageId = r.cardMessageId as string;
    const before = await cardRow(messageId);
    const res = await cell.request<Json>("PATCH", `/cards/${messageId}`, {
      agentId: keeperId,
      patch: { expectedVersion: 1, status: "succeeded", title: "Approved already" },
    });
    expect(res.status).toBe(403);
    expect(errorCode(res as { body: Record<string, unknown> | null })).toBe("card_platform_owned");
    const after = await cardRow(messageId);
    expect(after).toMatchObject({ version: before.version, status: "pending", title: "Apply test action" });
  });

  it("a linked card decision needs the action hash (400 action_hash_required)", async () => {
    const r = await request("test.card", { card: { conversationId: dm, inReplyToMessageId: asked } });
    const res = await decideCard(sam, r.cardMessageId as string, { outcome: "approved" });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("action_hash_required");
    expect((await rowOf(r.id)).status).toBe("pending");
  });

  it("a reader who fails canDecide is offered no decide and gets 403 not_approver; nothing changes", async () => {
    const r = await request("test.card", { card: { conversationId: group, inReplyToMessageId: groupAsked } });
    const messageId = r.cardMessageId as string;
    expect((await cardFor(riley, messageId)).viewerCan).toEqual(["follow"]);
    expect((await cardFor(sam, messageId)).viewerCan).toEqual(["follow", "decide"]);
    const res = await decideCard(riley, messageId, { outcome: "approved", actionHash: r.actionHash });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("not_approver");
    expect((await rowOf(r.id)).status).toBe("pending");
    expect(await cardRow(messageId)).toMatchObject({ decision: null, status: "pending" });
    expect(await cardActionsOf(messageId)).toHaveLength(0);
  });

  it("deciding on the card applies the approval, mirrors it with the note and the agent hears it once", async () => {
    const r = await request("test.card", { card: { conversationId: dm, inReplyToMessageId: asked } });
    const messageId = r.cardMessageId as string;
    const res = await decideCard(sam, messageId, {
      outcome: "approved",
      actionHash: r.actionHash,
      note: "Looks right",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = AgentCard.parse(res.body);
    expect(card).toMatchObject({
      status: "succeeded",
      decision: {
        outcome: "approved",
        by: { kind: "user", id: samId, displayName: "Sam Lee" },
        note: "Looks right",
      },
      approval: { id: r.id, status: "applied" },
      viewerCan: ["follow"],
    });
    expect(card.version).toBe(2);
    expect((await rowOf(r.id)).status).toBe("applied");
    expect(await auditsFor("test.applied", r.resourceId)).toHaveLength(1);
    const updated = await su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'message.updated' and payload->'message'->>'id' = $2",
      [`conv:${dm}`, messageId],
    );
    expect(updated.rows.some((u) => u.payload.message.card?.decision?.note === "Looks right")).toBe(true);
    const actions = await cardActionsOf(messageId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.message.text).toBe("Sam Lee approved “Apply test action”: “Looks right”");
    expect(actions[0]?.cardAction).toMatchObject({ messageId, kind: "approval", outcome: "approved" });
    // A second decision on the card is the primitive's 409.
    const again = await decideCard(sam, messageId, { outcome: "denied", actionHash: r.actionHash });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe("approval_already_decided");
    expect(await cardActionsOf(messageId)).toHaveLength(1);
  });

  it("deciding through the approvals route mirrors the card too: denied → cancelled, no note → the plain sentence", async () => {
    const r = await request("test.card", { card: { conversationId: dm, inReplyToMessageId: asked } });
    const messageId = r.cardMessageId as string;
    const res = await decide(sam, r.id, { outcome: "denied", actionHash: r.actionHash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = await cardFor(sam, messageId);
    expect(card).toMatchObject({ status: "cancelled", approval: { status: "denied" } });
    expect(card.decision).toMatchObject({ outcome: "denied", by: { id: samId } });
    expect(card.decision).not.toHaveProperty("note");
    const actions = await cardActionsOf(messageId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.message.text).toBe("Sam Lee denied “Apply test action”");
  });

  it("a failed apply mirrors as a failed card", async () => {
    const r = await request("test.card", { card: { conversationId: dm, inReplyToMessageId: asked } });
    failing.add(r.resourceId);
    const res = await decide(sam, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(res.status).toBe(200);
    // The kind's result code travels on the card, so the mirror can say why in words (07.2-17).
    expect(await cardFor(sam, r.cardMessageId as string)).toMatchObject({
      status: "failed",
      approval: { status: "failed", resultCode: "test_conflict" },
    });
  });
});

/** A client whose membership moved to a fresh organization B, as its admin (module-access.int.test.ts). */
async function otherOrgAdmin(): Promise<{ client: TestClient; orgB: string; userB: string }> {
  const { client, userId: userB } = await invite(
    stack,
    victor,
    `eve-${randomUUID().slice(0, 8)}@example.test`,
    "Eve",
    "standard",
  );
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userB]);
  await su.query("delete from app.org_members where user_id = $1", [userB]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userB,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userB],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userB]);
  return { client, orgB, userB };
}

describe("list visibility: only what the caller may decide, asked for or decided, whatever the query (review fix)", () => {
  it("an omitted or unknown role is refused (400) by the route and by the service itself", async () => {
    for (const path of ["/api/v1/approvals", "/api/v1/approvals?role=everyone", "/api/v1/approvals?role="]) {
      const res = await riley.request("GET", path);
      expect(res.status, path).toBe(400);
    }
    // Defence in depth: a caller that bypasses the route schema still gets nothing.
    await expect(
      stack.built.core.db.withTenant({ organizationId: orgId, userId: rileyId }, (tx) =>
        approvals.list(tx, rileyId, { role: "everyone" } as never),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a same-organization member, an admin included, never lists another member's personal approval", async () => {
    const p = await request("test.private");
    for (const [who, client] of [
      ["victor", victor],
      ["alex", alex],
      ["riley", riley],
    ] as const) {
      for (const role of ["decider", "requester"]) {
        const list = ApprovalList.parse(await ok(client.request("GET", `/api/v1/approvals?role=${role}`)));
        expect(
          list.items.map((i) => i.id),
          `${who} ${role}`,
        ).not.toContain(p.id);
      }
      expect((await client.request("GET", `/api/v1/approvals/${p.id}`)).status, who).toBe(404);
    }
    const mine = ApprovalList.parse(await ok(sam.request("GET", "/api/v1/approvals?role=decider")));
    expect(mine.items.map((i) => i.id)).toContain(p.id);
  });

  it("a cross-tenant decider lists nothing of this organization", async () => {
    await request("test.apply");
    const { client: eve, userB } = await otherOrgAdmin();
    deciders.add(userB);
    try {
      for (const role of ["decider", "requester"]) {
        const list = ApprovalList.parse(await ok(eve.request("GET", `/api/v1/approvals?role=${role}`)));
        expect(list).toEqual({ items: [], nextCursor: null });
      }
    } finally {
      deciders.delete(userB);
    }
  });
});

const consume = (id: string, actionHash: string, kind = "test.grant") =>
  stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
    approvals.consumeGrant(tx, { id, kind, actionHash }),
  );

describe("integrity under concurrency and replay (Task 3)", () => {
  it("two deciders approve at once: exactly one 200 and one 409 approval_already_decided; applied once", async () => {
    const r = await request("test.apply");
    const results = await Promise.all([
      decide(victor, r.id, { outcome: "approved", actionHash: r.actionHash }),
      decide(alex, r.id, { outcome: "approved", actionHash: r.actionHash }),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(errorCode(results.find((x) => x.status === 409) as (typeof results)[number])).toBe(
      "approval_already_decided",
    );
    expect(await auditsFor("test.applied", r.resourceId)).toHaveLength(1);
    expect(await auditsFor("approval.decided", r.id)).toHaveLength(1);
    expect((await rowOf(r.id)).status).toBe("applied");
  });

  it("approve then deny: the second decision is 409 and the request stays applied", async () => {
    const r = await request("test.apply");
    expect((await decide(victor, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
    const again = await decide(alex, r.id, { outcome: "denied", actionHash: r.actionHash });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe("approval_already_decided");
    expect((await rowOf(r.id)).status).toBe("applied");
  });

  it("the stored action changes between view and decision: 409 approval_action_changed, never re-targeted", async () => {
    const r = await request("test.apply");
    const seen = ApprovalDetail.parse(await ok(alex.request("GET", `/api/v1/approvals/${r.id}`)));
    const action = stored.get(r.resourceId);
    if (!action) throw new Error("missing stored action");
    action.version = 2;
    const before = applyCalls;
    const res = await decide(alex, r.id, { outcome: "approved", actionHash: seen.actionHash });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("approval_action_changed");
    // A fresh read still shows the hash of the action as requested; deciding with it fails the same way.
    const fresh = ApprovalDetail.parse(await ok(alex.request("GET", `/api/v1/approvals/${r.id}`)));
    expect(fresh.actionHash).toBe(seen.actionHash);
    const retry = await decide(alex, r.id, { outcome: "approved", actionHash: fresh.actionHash });
    expect(retry.status).toBe(409);
    expect(errorCode(retry)).toBe("approval_action_changed");
    expect(applyCalls).toBe(before);
    expect(await rowOf(r.id)).toMatchObject({ status: "pending", decided_by: null, consumed_at: null });
  });

  it("a hash the client never saw (random hex) is 409 approval_action_changed", async () => {
    const r = await request("test.apply");
    const res = await decide(victor, r.id, {
      outcome: "approved",
      actionHash: randomUUID().replaceAll("-", "").repeat(2),
    });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("approval_action_changed");
    expect((await rowOf(r.id)).status).toBe("pending");
  });

  it("a request past its expiry reads as expired in list and get, and its decision is 409 approval_expired", async () => {
    const r = await request("test.apply");
    await su.query(
      "update app.approval_requests set expires_at = now() - interval '1 minute' where id = $1",
      [r.id],
    );
    const expired = ApprovalList.parse(
      await ok(victor.request("GET", "/api/v1/approvals?role=decider&status=expired")),
    );
    expect(expired.items.find((i) => i.id === r.id)).toMatchObject({ status: "expired", viewerCan: [] });
    const pending = ApprovalList.parse(
      await ok(victor.request("GET", "/api/v1/approvals?role=decider&status=pending")),
    );
    expect(pending.items.map((i) => i.id)).not.toContain(r.id);
    expect(ApprovalDetail.parse(await ok(victor.request("GET", `/api/v1/approvals/${r.id}`))).status).toBe(
      "expired",
    );
    const res = await decide(victor, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("approval_expired");
    expect((await rowOf(r.id)).status).toBe("pending");
  });

  it("404-hiding: an outsider gets 404 on GET and POST; the requester who cannot decide gets 403 not_approver", async () => {
    const r = await request("test.apply");
    for (const res of [
      await riley.request("GET", `/api/v1/approvals/${r.id}`),
      await decide(riley, r.id, { outcome: "approved", actionHash: r.actionHash }),
    ]) {
      expect(res.status).toBe(404);
      expect(errorCode(res)).toBe("approval_not_found");
    }
    expect(ApprovalDetail.parse(await ok(sam.request("GET", `/api/v1/approvals/${r.id}`))).viewerCan).toEqual(
      [],
    );
    const own = await decide(sam, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(own.status).toBe(403);
    expect(errorCode(own)).toBe("not_approver");
    expect((await rowOf(r.id)).status).toBe("pending");
  });

  it("cross-tenant: a decider of another organization gets 404 for this organization's request", async () => {
    const r = await request("test.apply");
    const { client: eve, userB } = await otherOrgAdmin();
    deciders.add(userB);
    try {
      expect((await eve.request("GET", `/api/v1/approvals/${r.id}`)).status).toBe(404);
      const res = await decide(eve, r.id, { outcome: "approved", actionHash: r.actionHash });
      expect(res.status).toBe(404);
      expect(errorCode(res)).toBe("approval_not_found");
    } finally {
      deciders.delete(userB);
    }
    expect((await rowOf(r.id)).status).toBe("pending");
  });
});

describe("grant mode: one use, the matching hash, before expiry (Task 3)", () => {
  it("before approval → not_approved; approved leaves the grant unconsumed; a wrong hash or kind is refused; one use", async () => {
    const r = await request("test.grant");
    expect(await consume(r.id, r.actionHash)).toEqual({ ok: false, code: "not_approved" });
    const res = await decide(victor, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(ApprovalSummary.parse(res.body).status).toBe("approved");
    expect(await rowOf(r.id)).toMatchObject({ status: "approved", consumed_at: null, applied_at: null });
    expect(await consume(r.id, "a".repeat(64))).toEqual({ ok: false, code: "approval_action_changed" });
    expect(await consume(r.id, r.actionHash, "test.apply")).toEqual({
      ok: false,
      code: "approval_not_found",
    });
    expect(await consume(randomUUID(), r.actionHash)).toEqual({ ok: false, code: "approval_not_found" });
    expect(await consume(r.id, r.actionHash)).toEqual({ ok: true });
    const row = await rowOf(r.id);
    expect(row.status).toBe("applied");
    expect(row.consumed_at).not.toBeNull();
    expect(await auditsFor("approval.grant_consumed", r.id)).toHaveLength(1);
    expect(await consume(r.id, r.actionHash)).toEqual({ ok: false, code: "already_used" });
  });

  it("the stored action changed after approval → approval_action_changed", async () => {
    const r = await request("test.grant");
    expect((await decide(alex, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
    const action = stored.get(r.resourceId);
    if (!action) throw new Error("missing stored action");
    action.target = "somewhere else";
    expect(await consume(r.id, r.actionHash)).toEqual({ ok: false, code: "approval_action_changed" });
    expect((await rowOf(r.id)).consumed_at).toBeNull();
  });

  it("an approved grant past its expiry → approval_expired; a denied one → not_approved", async () => {
    const r = await request("test.grant");
    expect((await decide(victor, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
    await su.query(
      "update app.approval_requests set expires_at = now() - interval '1 second' where id = $1",
      [r.id],
    );
    expect(await consume(r.id, r.actionHash)).toEqual({ ok: false, code: "approval_expired" });
    const d = await request("test.grant");
    expect((await decide(victor, d.id, { outcome: "denied", actionHash: d.actionHash })).status).toBe(200);
    expect(await consume(d.id, d.actionHash)).toEqual({ ok: false, code: "not_approved" });
  });

  it("two concurrent uses: exactly one succeeds", async () => {
    const r = await request("test.grant");
    expect((await decide(victor, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
    const results = await Promise.all([consume(r.id, r.actionHash), consume(r.id, r.actionHash)]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok)).toEqual([{ ok: false, code: "already_used" }]);
    expect(await auditsFor("approval.grant_consumed", r.id)).toHaveLength(1);
  });
});

describe("the gone path: a request whose action vanished closes as failed, card included (WINDOWS 144)", () => {
  let dm: string;
  let asked: string;

  beforeAll(async () => {
    // test.card's card, plus a `gone` hook: gone once its stored action is removed.
    approvals.register(
      testKind("test.gone", "server_apply", {
        async canDecide(_tx, userId, row) {
          return stored.has(row.resourceId) && userId === row.requestedForUserId;
        },
        async audience(_tx, row) {
          return row.requestedForUserId ? [row.requestedForUserId] : [];
        },
        async card(_tx, row) {
          return {
            card: {
              kind: "approval",
              title: "Apply test action",
              fields: [{ label: "Target", value: stored.get(row.resourceId)?.target ?? "gone" }],
              status: "pending",
              actions: [{ kind: "open", label: "Review", target: `/memory/proposals/${row.id}` }],
              summary: "Keeper asks to apply a test action",
            },
          };
        },
        async gone(_tx, row) {
          return stored.has(row.resourceId) ? null : "test_gone";
        },
      }),
    );
    dm = (await ok(sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] })))
      .id as string;
    asked = (await ok(sam.request("POST", `/api/v1/conversations/${dm}/messages`, { body: "keep it" })))
      .id as string;
  });

  const close = (which: { ids: string[] } | { requestedByAgentId: string }) =>
    stack.built.core.db.withTenant({ organizationId: orgId, userId: victorId }, (tx) =>
      approvals.closeGone(tx, which),
    );

  it("closes only what is pending and gone: failed with the kind's code, audited by id, announced, card failed", async () => {
    const gone = await request("test.gone", { card: { conversationId: dm, inReplyToMessageId: asked } });
    const alive = await request("test.gone", { card: { conversationId: dm, inReplyToMessageId: asked } });
    const noHook = await request("test.apply");
    stored.delete(gone.resourceId);
    stored.delete(noHook.resourceId);
    const version = (
      await su.query("select version from app.message_cards where message_id = $1", [gone.cardMessageId])
    ).rows[0].version as number;

    expect(await close({ ids: [gone.id, alive.id, noHook.id, randomUUID()] })).toEqual([gone.id]);

    expect(await rowOf(gone.id)).toMatchObject({
      status: "failed",
      result_code: "test_gone",
      decided_by: null,
      decided_at: null,
    });
    expect((await rowOf(alive.id)).status).toBe("pending");
    expect((await rowOf(noHook.id)).status).toBe("pending");
    const [audit] = await auditsFor("approval.closed", gone.id);
    expect(audit).toMatchObject({ result: "error" });
    expect(audit?.metadata).toEqual({
      approvalId: gone.id,
      kind: "test.gone",
      mode: "server_apply",
      resultCode: "test_gone",
    });
    expect((await updatesOf(gone.id)).map((u) => [u.stream_id, u.payload.status])).toContainEqual([
      `user:${samId}`,
      "failed",
    ]);
    const cardRow = (
      await su.query("select status, decision, version from app.message_cards where message_id = $1", [
        gone.cardMessageId,
      ])
    ).rows[0];
    expect(cardRow).toEqual({ status: "failed", decision: null, version: version + 1 });
    const card = AgentCard.parse(await ok(sam.request("GET", `/api/v1/cards/${gone.cardMessageId}`)));
    expect(card.approval).toMatchObject({ status: "failed", resultCode: "test_gone" });

    // Once: closing again changes nothing; a decision on it is already decided.
    expect(await close({ ids: [gone.id] })).toEqual([]);
    expect(await auditsFor("approval.closed", gone.id)).toHaveLength(1);
    const res = await decide(sam, gone.id, { outcome: "approved", actionHash: gone.actionHash });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("approval_already_decided");
  });

  it("by requesting agent: every pending request it asked for, nothing else", async () => {
    const asKeeper = await request("test.gone", { card: { conversationId: dm, inReplyToMessageId: asked } });
    const decided = await request("test.gone", { card: { conversationId: dm, inReplyToMessageId: asked } });
    await ok(decide(sam, decided.id, { outcome: "denied", actionHash: decided.actionHash }));
    stored.delete(asKeeper.resourceId);
    stored.delete(decided.resourceId);
    expect(await close({ requestedByAgentId: keeperId })).toEqual([asKeeper.id]);
    expect((await rowOf(decided.id)).status).toBe("denied");
  });
});
