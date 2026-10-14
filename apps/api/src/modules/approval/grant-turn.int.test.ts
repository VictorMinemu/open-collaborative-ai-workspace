import { randomUUID } from "node:crypto";
import { AgentCard, AgentCardActionEvent } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack } from "../../testing-ai";
import { invite } from "../../testing-workzone";
import type { ApprovalKind, ApprovalService } from "./index";

/**
 * 07.5-06 (APPROVE-02, D-04, P-06, P-07, UI-SPEC R1/R6/R7/R9): the 07.2 primitive's requester-bound re-run for grant
 * kinds and the optional kind hooks, on a real PostgreSQL + Redis through the real routes. The cell stream
 * (`app.stream_events`, `cell:<org>`) is the delivery ledger, so no cell needs to run.
 *
 * Cast: Víctor (admin) sets up; Sam Lee (standard) is the human the requests are made for (his bot Keeper asks);
 * Marta Gil (standard) is the only decider of the test kinds (a stand-in for a lead or a named approver).
 */

const CELL_TOKEN = "ocw-test-cell-token-grant-turn-0123456789abcdef";
const GRANT_TOOL = "m1a2b3c4d__write_note";
const GRANT_ARGS = '{"a":1}';

let stack: AiStack;
let su: pg.Client;
let approvals: ApprovalService;
let victor: TestClient;
let sam: TestClient;
let marta: TestClient;
let samId: string;
let martaId: string;
let orgId: string;
let keeperId: string;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

/** Per request (resource id): the stored target and what the kind reports about the requesting turn's taint. */
const stored = new Map<string, { target: string; sourceTainted?: boolean }>();

/** The use window a grant kind reports: 15 minutes after the decision (P-05). */
const useByOf = (decidedAt: string | null) =>
  new Date(Date.parse(decidedAt ?? new Date().toISOString()) + 15 * 60_000).toISOString();

function baseKind(kind: string, mode: "grant" | "server_apply", title: string): ApprovalKind {
  return {
    kind,
    mode,
    resourceType: "test_action",
    ttlMs: 60 * 60 * 1000,
    async hashInput(_tx, row) {
      const a = stored.get(row.resourceId);
      if (!a) throw new Error("no stored action");
      return [a.target];
    },
    async canDecide(_tx, userId) {
      return userId === martaId;
    },
    async audience() {
      return [martaId];
    },
    async view(_tx, row) {
      return {
        type: "fields",
        title,
        fields: [{ label: "Target", value: stored.get(row.resourceId)?.target ?? "gone" }],
      };
    },
    async card(_tx, row) {
      return {
        card: {
          kind: "approval",
          title,
          fields: [{ label: "Target", value: stored.get(row.resourceId)?.target ?? "gone" }],
          status: "pending",
          actions: [{ kind: "open", label: "Open", target: `/approvals/${row.id}` }],
          summary: `Keeper asks: ${title}`,
        },
      };
    },
  };
}

const grantTurnKind = (): ApprovalKind => ({
  ...baseKind("test.grant_turn", "grant", "Write a note"),
  async cardTurn(_tx, row) {
    const s = stored.get(row.resourceId);
    return {
      grant: { tool: GRANT_TOOL, arguments: GRANT_ARGS, useBy: useByOf(row.decidedAt) },
      ...(s?.sourceTainted === undefined ? {} : { sourceTainted: s.sourceTainted }),
    };
  },
});

const applyTurnKind = (): ApprovalKind => ({
  ...baseKind("test.apply_turn", "server_apply", "Apply a setting"),
  async apply() {
    return { ok: true };
  },
  // Ignored for server_apply kinds: the decider stays the turn's human and nothing is tainted by the kind.
  async cardTurn() {
    return { grant: { tool: GRANT_TOOL, arguments: GRANT_ARGS, useBy: useByOf(null) }, sourceTainted: true };
  },
});

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

/** A pending request of `kind` for Sam, asked by Keeper, mirrored as a card replying to `asked` in `conversationId`. */
async function request(
  kind: string,
  target: { conversationId: string; asked: string },
  opts: { sourceTainted?: boolean } = {},
) {
  const resourceId = randomUUID();
  stored.set(resourceId, {
    target: `target-${resourceId.slice(0, 8)}`,
    ...(opts.sourceTainted === undefined ? {} : { sourceTainted: opts.sourceTainted }),
  });
  const out = await stack.built.core.db.withTenant({ organizationId: orgId, userId: samId }, (tx) =>
    approvals.request(tx, {
      kind,
      resourceId,
      requestedByAgentId: keeperId,
      requestedForUserId: samId,
      eventId: null,
      card: {
        agentId: keeperId,
        conversationId: target.conversationId,
        inReplyToMessageId: target.asked,
        threadRootMessageId: null,
      },
    }),
  );
  if (!out.cardMessageId) throw new Error("no card posted");
  return { ...out, cardMessageId: out.cardMessageId, resourceId };
}

const decide = (as: TestClient, id: string, body: Json) =>
  as.request("POST", `/api/v1/approvals/${id}/decision`, body);

const decideCard = (as: TestClient, messageId: string, body: Json) =>
  as.request("POST", `/api/v1/cards/${messageId}/decision`, body);

const cardFor = async (as: TestClient, messageId: string) =>
  AgentCard.parse(await ok(as.request("GET", `/api/v1/cards/${messageId}`)));

/** Every `agent.card_action.v1` appended for one card. */
const cardActionsOf = async (messageId: string) =>
  (
    await su.query(
      "select seq, payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${orgId}`, messageId],
    )
  ).rows.map((r) => AgentCardActionEvent.parse({ ...r.payload, seq: Number(r.seq) }));

const turnOf = async (eventId: string) =>
  (await su.query("select user_id, tainted from app.agent_turns where event_id = $1", [eventId])).rows[0] as
    | { user_id: string; tainted: boolean }
    | undefined;

const turnsToday = async () =>
  (
    await su.query(
      "select coalesce(sum(turns), 0)::int as n from app.agent_usage_daily where agent_id = $1",
      [keeperId],
    )
  ).rows[0].n as number;

const rowOf = async (id: string) =>
  (await su.query("select * from app.approval_requests where id = $1", [id])).rows[0] as Json;

const cardRow = async (messageId: string) =>
  (await su.query("select * from app.message_cards where message_id = $1", [messageId])).rows[0] as Json;

/** A message Sam posts (no mention, so it wakes nobody) that the request's card replies to. */
const say = async (conversationId: string, body: string) =>
  (await ok(sam.request("POST", `/api/v1/conversations/${conversationId}/messages`, { body }))).id as string;

let dm: string;
let room: string;

beforeAll(async () => {
  stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
  approvals = stack.built.approvals;
  approvals.register(grantTurnKind());
  approvals.register(applyTurnKind());
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
  await meId(victor);
  ({ client: sam, userId: samId } = await invite(stack, victor, "sam@example.test", "Sam Lee", "standard"));
  ({ client: marta, userId: martaId } = await invite(
    stack,
    victor,
    "marta@example.test",
    "Marta Gil",
    "standard",
  ));
  await seedPlan(victor);
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
  dm = (await ok(sam.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: keeperId }] })))
    .id as string;
  room = (await ok(victor.request("POST", "/api/v1/channels", { name: "grants" }))).id as string;
  for (const member of [
    { kind: "user", id: samId },
    { kind: "user", id: martaId },
    { kind: "agent", id: keeperId },
  ]) {
    await ok(victor.request("POST", `/api/v1/channels/${room}/members`, member));
  }
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

describe("tracer: a grant approved by a third person reaches the bot as the requester's turn (Task 1)", () => {
  it("Marta approves Sam's grant through /approvals → one card action authored by Sam, decidedBy Marta, with the grant", async () => {
    const asked = await say(dm, "please write the note");
    const r = await request("test.grant_turn", { conversationId: dm, asked });
    const before = await turnsToday();
    const res = await decide(marta, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const actions = await cardActionsOf(r.cardMessageId);
    expect(actions).toHaveLength(1);
    const ev = actions[0] as AgentCardActionEvent;
    expect(ev.message.author).toEqual({ kind: "user", id: samId, displayName: "Sam Lee" });
    expect(ev.message.text).toBe("Marta Gil approved “Write a note”");
    expect(ev.cardAction.decidedBy).toEqual({ id: martaId, displayName: "Marta Gil" });
    expect(ev.cardAction.grant).toEqual({
      tool: GRANT_TOOL,
      arguments: GRANT_ARGS,
      useBy: useByOf((await rowOf(r.id)).decided_at.toISOString()),
    });
    // The turn is Sam's: its ledger row, its tools and the bot's daily counter (the asker pays).
    expect(await turnOf(ev.eventId)).toEqual({ user_id: samId, tainted: false });
    expect(await turnsToday()).toBe(before + 1);
  });

  it("decided on the card in a channel both read (chat card route) → the same author rule", async () => {
    const asked = await say(room, "please write the room note");
    const r = await request("test.grant_turn", { conversationId: room, asked });
    const shown = await cardFor(marta, r.cardMessageId);
    expect(shown.viewerCan).toContain("decide");
    const res = await decideCard(marta, r.cardMessageId, {
      outcome: "approved",
      actionHash: shown.approval?.actionHash,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [ev, ...rest] = await cardActionsOf(r.cardMessageId);
    expect(rest).toHaveLength(0);
    expect(ev?.message.author.id).toBe(samId);
    expect(ev?.cardAction.decidedBy?.id).toBe(martaId);
    expect(ev?.cardAction.grant?.tool).toBe(GRANT_TOOL);
    expect(await turnOf(ev?.eventId as string)).toMatchObject({ user_id: samId });
  });

  it("a denied grant: the turn is still Sam's, decidedBy Marta, and no grant rides it", async () => {
    const asked = await say(dm, "write another note");
    const r = await request("test.grant_turn", { conversationId: dm, asked });
    expect((await decide(marta, r.id, { outcome: "denied", actionHash: r.actionHash })).status).toBe(200);
    const [ev] = await cardActionsOf(r.cardMessageId);
    expect(ev?.message.author.id).toBe(samId);
    expect(ev?.message.text).toBe("Marta Gil denied “Write a note”");
    expect(ev?.cardAction.decidedBy?.id).toBe(martaId);
    expect(ev?.cardAction).not.toHaveProperty("grant");
  });

  it("a server_apply kind decided by Marta keeps the decider as the turn's human: author Marta, no grant, decidedBy Marta", async () => {
    const asked = await say(room, "apply the setting");
    const r = await request("test.apply_turn", { conversationId: room, asked });
    expect((await decide(marta, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
    expect((await rowOf(r.id)).status).toBe("applied");
    const [ev, ...rest] = await cardActionsOf(r.cardMessageId);
    expect(rest).toHaveLength(0);
    expect(ev?.message.author.id).toBe(martaId);
    expect(ev?.message.text).toBe("Marta Gil approved “Apply a setting”");
    expect(ev?.cardAction.decidedBy).toEqual({ id: martaId, displayName: "Marta Gil" });
    expect(ev?.cardAction).not.toHaveProperty("grant");
    // The kind's `cardTurn` is not asked for server_apply kinds: the decider's turn is untouched.
    expect(await turnOf(ev?.eventId as string)).toEqual({ user_id: martaId, tainted: false });
  });
});

describe("taint never escapes through the re-run (T-07.5-06-07)", () => {
  for (const [label, sourceTainted, expected] of [
    ["sourceTainted: true → the re-run turn starts tainted", true, true],
    ["sourceTainted: false → untainted", false, false],
    ["sourceTainted absent → untainted", undefined, false],
  ] as const) {
    it(label, async () => {
      const asked = await say(dm, `taint case ${label}`);
      const r = await request(
        "test.grant_turn",
        { conversationId: dm, asked },
        sourceTainted === undefined ? {} : { sourceTainted },
      );
      expect((await decide(marta, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
      const [ev] = await cardActionsOf(r.cardMessageId);
      // Read right after the decision committed, before any tool call could have tainted it.
      expect(await turnOf(ev?.eventId as string)).toEqual({ user_id: samId, tainted: expected });
    });
  }

  it("a tainted denial re-runs tainted too (the bot read the same content)", async () => {
    const asked = await say(dm, "tainted denial");
    const r = await request("test.grant_turn", { conversationId: dm, asked }, { sourceTainted: true });
    expect((await decide(marta, r.id, { outcome: "denied", actionHash: r.actionHash })).status).toBe(200);
    const [ev] = await cardActionsOf(r.cardMessageId);
    expect(await turnOf(ev?.eventId as string)).toEqual({ user_id: samId, tainted: true });
  });
});

describe("the requester lost access: the decision stands, no turn, no fallback to the decider (P-06)", () => {
  it("Sam removed from a private channel before Marta decides → 200, no card action, no turn row", async () => {
    const priv = (
      await ok(victor.request("POST", "/api/v1/channels", { name: "grants-private", visibility: "private" }))
    ).id as string;
    for (const member of [
      { kind: "user", id: samId },
      { kind: "user", id: martaId },
      { kind: "agent", id: keeperId },
    ]) {
      await ok(victor.request("POST", `/api/v1/channels/${priv}/members`, member));
    }
    const asked = await say(priv, "write the private note");
    const r = await request("test.grant_turn", { conversationId: priv, asked });
    await ok(victor.request("DELETE", `/api/v1/channels/${priv}/members/user/${samId}`));
    const before = await turnsToday();
    const res = await decide(marta, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await rowOf(r.id)).status).toBe("approved");
    expect(await cardRow(r.cardMessageId)).toMatchObject({ decision: "approved", decided_by: martaId });
    expect(await cardActionsOf(r.cardMessageId)).toHaveLength(0);
    const turns = await su.query("select count(*)::int as n from app.agent_turns where message_id = $1", [
      r.cardMessageId,
    ]);
    expect(turns.rows[0].n).toBe(0);
    expect(await turnsToday()).toBe(before);
  });
});

describe("WINDOWS #135: an approved grant's card reads as approved until the grant is used", () => {
  it("approved → card running (not succeeded); consumeGrant → card succeeded, announced live; denied → cancelled", async () => {
    const asked = await say(dm, "write the used note");
    const r = await request("test.grant_turn", { conversationId: dm, asked });
    expect((await decide(marta, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
    const approved = await cardFor(sam, r.cardMessageId);
    expect(approved).toMatchObject({
      status: "running",
      decision: { outcome: "approved", by: { id: martaId } },
      approval: { status: "approved" },
    });
    const used = await stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      approvals.consumeGrant(tx, { id: r.id, kind: "test.grant_turn", actionHash: r.actionHash }),
    );
    expect(used).toEqual({ ok: true });
    const after = await cardFor(sam, r.cardMessageId);
    expect(after).toMatchObject({ status: "succeeded", approval: { status: "applied" } });
    expect(after.version).toBe(approved.version + 1);
    const updates = (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'message.updated' and payload->'message'->>'id' = $2 order by seq",
        [`conv:${dm}`, r.cardMessageId],
      )
    ).rows.map((u) => u.payload.message.card as Json);
    expect(updates.at(-1)).toMatchObject({ status: "succeeded", approval: { status: "applied" } });
    // Using the grant is not a decision: no second card-action turn.
    expect(await cardActionsOf(r.cardMessageId)).toHaveLength(1);

    const asked2 = await say(dm, "write the denied note");
    const d = await request("test.grant_turn", { conversationId: dm, asked: asked2 });
    expect((await decide(marta, d.id, { outcome: "denied", actionHash: d.actionHash })).status).toBe(200);
    expect(await cardFor(sam, d.cardMessageId)).toMatchObject({ status: "cancelled" });
  });
});
