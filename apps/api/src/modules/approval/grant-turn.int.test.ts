import { randomUUID } from "node:crypto";
import { AgentCard, AgentCardActionEvent, ApprovalList } from "@ocw/contracts";
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

describe("WINDOWS #204: a server_apply decision by someone who cannot read the conversation starts no bot turn", () => {
  it("Marta decides from /approvals a request whose card is in a private channel she is not in → applied, no card action, no turn, nothing metered", async () => {
    const priv = (
      await ok(victor.request("POST", "/api/v1/channels", { name: "apply-private", visibility: "private" }))
    ).id as string;
    for (const member of [
      { kind: "user", id: samId },
      { kind: "agent", id: keeperId },
    ]) {
      await ok(victor.request("POST", `/api/v1/channels/${priv}/members`, member));
    }
    const asked = await say(priv, "apply the private setting");
    const r = await request("test.apply_turn", { conversationId: priv, asked });
    const before = await turnsToday();
    const res = await decide(marta, r.id, { outcome: "approved", actionHash: r.actionHash });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The decision stands and the action is applied: the kind decides who may approve, not who reads the card.
    expect((await rowOf(r.id)).status).toBe("applied");
    expect(await cardRow(r.cardMessageId)).toMatchObject({ decision: "approved", decided_by: martaId });
    // No bot turn for a human who cannot read where it would answer (its reply would be refused anyway, D-05).
    expect(await cardActionsOf(r.cardMessageId)).toHaveLength(0);
    const turns = await su.query("select count(*)::int as n from app.agent_turns where message_id = $1", [
      r.cardMessageId,
    ]);
    expect(turns.rows[0].n).toBe(0);
    expect(await turnsToday()).toBe(before);
  });

  it("the same decision where Marta reads the channel still delivers her turn (unchanged)", async () => {
    const asked = await say(room, "apply the shared setting");
    const r = await request("test.apply_turn", { conversationId: room, asked });
    expect((await decide(marta, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
    const [ev] = await cardActionsOf(r.cardMessageId);
    expect(ev?.message.author.id).toBe(martaId);
    expect(await turnOf(ev?.eventId as string)).toEqual({ user_id: martaId, tainted: false });
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

// ---------------------------------------------------------------- Task 2: kind hooks for cards and inboxes

/** People besides Marta who may decide the inbox test kinds (the org B test adds and removes its admin). */
const listDeciders = new Set<string>();
const DEVICE_ID = randomUUID();

/** A kind whose card is a summary with link extras, no in-card decision and an Open labelled "Review" (P-07). */
const linkKind = (): ApprovalKind => ({
  ...grantTurnKind(),
  kind: "test.link",
  async card(_tx, row) {
    return {
      card: {
        kind: "approval",
        title: "Send the invoice",
        fields: [{ label: "Tool", value: "invoices__send" }],
        status: "pending",
        actions: [{ kind: "open", label: "Open", target: `/approvals/${row.id}` }],
        summary: "Keeper asks to send the invoice",
      },
      inlineDecision: false,
      labels: { open: "Review" },
    };
  },
  async link(_tx, row) {
    return {
      display: "summary",
      waitingFor: "Waiting for an admin",
      actionFields: 2,
      useBy: row.decidedAt ? useByOf(row.decidedAt) : null,
      deviceId: DEVICE_ID,
      resultRoute: `/work-zone/${row.resourceId}`,
      blocked: null,
    };
  },
});

/** A kind that keeps the in-card decision but names its buttons (a Work Zone proposal's Start session / Dismiss). */
const labelsKind = (): ApprovalKind => ({
  ...applyTurnKind(),
  kind: "test.labels",
  async card(_tx, row) {
    return {
      card: {
        kind: "approval",
        title: "Start a session",
        fields: [{ label: "Project", value: stored.get(row.resourceId)?.target ?? "gone" }],
        status: "pending",
        actions: [{ kind: "open", label: "Open", target: `/approvals/${row.id}` }],
        summary: "Keeper proposes a session",
      },
      labels: { approve: "Start session", deny: "Dismiss" },
    };
  },
});

/**
 * A kind whose `link()` says `exact` but breaks the contract (a `waitingFor` past 200 characters): the link must not
 * lose its display and let the card approve; it reads as `review_only` (I-1, fail closed).
 */
const badLinkKind = (): ApprovalKind => ({
  ...linkKind(),
  kind: "test.bad_link",
  async link() {
    return { display: "exact", waitingFor: "x".repeat(201), actionFields: 2, useBy: null };
  },
});

/** Inbox kinds without cards: `test.ka` has a viewer-aware headline, `test.kb` and `test.kc` have none. */
const inboxKind = (kind: string, withHeadline: boolean): ApprovalKind => ({
  ...baseKind(kind, "grant", `Inbox ${kind}`),
  async canDecide(_tx, userId) {
    return userId === martaId || listDeciders.has(userId);
  },
  ...(withHeadline
    ? {
        async headline(_tx, _row, viewerUserId) {
          return {
            title: `Run ${kind}`,
            context: null,
            requester: "Keeper for Sam Lee",
            tags: [],
            ...(viewerUserId === martaId ? { origin: { kind: "dm", name: null } } : {}),
          };
        },
      }
    : {}),
});

/** A pending request of `kind` for Sam with no card. */
async function requestBare(kind: string) {
  const resourceId = randomUUID();
  stored.set(resourceId, { target: `target-${resourceId.slice(0, 8)}` });
  const out = await stack.built.core.db.withTenant({ organizationId: orgId, userId: samId }, (tx) =>
    approvals.request(tx, {
      kind,
      resourceId,
      requestedByAgentId: keeperId,
      requestedForUserId: samId,
      eventId: null,
    }),
  );
  return { ...out, resourceId };
}

/** A client whose membership moved to a fresh organization B, as its admin (approval.int.test.ts). */
async function otherOrgAdmin(): Promise<{ client: TestClient; userB: string }> {
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
  return { client, userB };
}

const list = async (as: TestClient, query: string) =>
  ApprovalList.parse(await ok(as.request("GET", `/api/v1/approvals?${query}`)));

describe("card link extras, inline decision and labels (Task 2, UI-SPEC R6, R7, R9, P-07)", () => {
  beforeAll(() => {
    approvals.register(linkKind());
    approvals.register(labelsKind());
    approvals.register(badLinkKind());
  });

  it("a kind whose link() fails validation reads as review_only: the card refuses Approve (409 review_required), Deny works", async () => {
    const asked = await say(room, "send it anyway");
    const r = await request("test.bad_link", { conversationId: room, asked });
    const card = await cardFor(marta, r.cardMessageId);
    expect(card.approval).toMatchObject({ kind: "test.bad_link", display: "review_only" });
    expect(card.approval).not.toHaveProperty("waitingFor");
    const refused = await decideCard(marta, r.cardMessageId, {
      outcome: "approved",
      actionHash: r.actionHash,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect((refused.body as Json).error.code).toBe("review_required");
    expect((await rowOf(r.id)).status).toBe("pending");
    const denied = await decideCard(marta, r.cardMessageId, { outcome: "denied", actionHash: r.actionHash });
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);
    expect((await rowOf(r.id)).status).toBe("denied");
  });

  it("a kind with link() → the snapshot's approval carries its extras plus kind, expiresAt and usedAt (set once used)", async () => {
    const asked = await say(room, "send the invoice");
    const r = await request("test.link", { conversationId: room, asked });
    const row = await rowOf(r.id);
    const pending = await cardFor(sam, r.cardMessageId);
    expect(pending.approval).toEqual({
      id: r.id,
      actionHash: r.actionHash,
      status: "pending",
      requestedForUserId: samId,
      warnings: [],
      resultCode: null,
      kind: "test.link",
      expiresAt: row.expires_at.toISOString(),
      usedAt: null,
      display: "summary",
      waitingFor: "Waiting for an admin",
      actionFields: 2,
      useBy: null,
      deviceId: DEVICE_ID,
      resultRoute: `/work-zone/${r.resourceId}`,
      blocked: null,
    });
    // The in-card decision is off: only the Open action, labelled by the kind. Deciding is still the kind's rule.
    expect(pending.actions).toEqual([{ kind: "open", label: "Review", target: `/approvals/${r.id}` }]);
    expect((await cardFor(marta, r.cardMessageId)).viewerCan).toEqual(["follow", "decide"]);

    expect((await decide(marta, r.id, { outcome: "approved", actionHash: r.actionHash })).status).toBe(200);
    const decided = await rowOf(r.id);
    expect((await cardFor(sam, r.cardMessageId)).approval).toMatchObject({
      status: "approved",
      useBy: useByOf(decided.decided_at.toISOString()),
      usedAt: null,
    });
    await stack.built.core.db.withTenant({ organizationId: orgId, userId: null }, (tx) =>
      approvals.consumeGrant(tx, { id: r.id, kind: "test.link", actionHash: r.actionHash }),
    );
    const used = await rowOf(r.id);
    expect((await cardFor(sam, r.cardMessageId)).approval).toMatchObject({
      status: "applied",
      usedAt: used.consumed_at.toISOString(),
    });

    // Realtime frames carry the link, never a viewer-specific field (07.2 rule).
    const frames = (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'message.updated' and payload->'message'->>'id' = $2 order by seq",
        [`conv:${room}`, r.cardMessageId],
      )
    ).rows.map((u) => u.payload.message.card as Json);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const card of frames) {
      expect(card).not.toHaveProperty("following");
      expect(card).not.toHaveProperty("viewerCan");
      expect(card.approval).toMatchObject({ kind: "test.link", display: "summary" });
    }
    expect(frames.at(-1)?.approval.usedAt).toBe(used.consumed_at.toISOString());
  });

  it("labels rename the in-card buttons; a kind without labels or link() keeps the exact 07.2 card and link", async () => {
    const asked = await say(dm, "start a session");
    const r = await request("test.labels", { conversationId: dm, asked });
    const card = await cardFor(sam, r.cardMessageId);
    expect(card.actions).toEqual([
      { kind: "approve", label: "Start session", denyLabel: "Dismiss" },
      { kind: "open", label: "Open", target: `/approvals/${r.id}` },
    ]);

    const asked2 = await say(dm, "apply it");
    const plain = await request("test.apply_turn", { conversationId: dm, asked: asked2 });
    const plainCard = await cardFor(sam, plain.cardMessageId);
    expect(plainCard.actions).toEqual([
      { kind: "approve", label: "Approve", denyLabel: "Deny" },
      { kind: "open", label: "Open", target: `/approvals/${plain.id}` },
    ]);
    expect(plainCard.approval).toEqual({
      id: plain.id,
      actionHash: plain.actionHash,
      status: "pending",
      requestedForUserId: samId,
      warnings: [],
      resultCode: null,
    });
  });
});

describe("the inbox: kinds filter, headlines and the pending total (Task 2, UI-SPEC R1)", () => {
  const ids: Record<string, string[]> = { "test.ka": [], "test.kb": [], "test.kc": [] };

  beforeAll(async () => {
    approvals.register(inboxKind("test.ka", true));
    approvals.register(inboxKind("test.kb", false));
    approvals.register(inboxKind("test.kc", false));
    for (const kind of ["test.ka", "test.ka", "test.kb", "test.kc"]) {
      ids[kind]?.push((await requestBare(kind)).id);
    }
  });

  it("kinds=test.ka,test.kb lists only those kinds, with the kind's headline or null, and total = their pending count", async () => {
    const res = await list(marta, "role=decider&status=pending&kinds=test.ka,test.kb");
    expect(res.items.map((i) => i.id).sort()).toEqual(
      [...(ids["test.ka"] ?? []), ...(ids["test.kb"] ?? [])].sort(),
    );
    expect(res.total).toBe(3);
    expect(res.nextCursor).toBeNull();
    for (const item of res.items) {
      if (item.kind === "test.ka") {
        expect(item.headline).toEqual({
          title: "Run test.ka",
          context: null,
          requester: "Keeper for Sam Lee",
          tags: [],
          origin: { kind: "dm", name: null },
        });
      } else {
        expect(item.headline).toBeNull();
      }
    }
  });

  it("the total counts pending requests only, whatever the status filter; without kinds the 07.2 shape has no total", async () => {
    const first = ids["test.ka"]?.[0] as string;
    const hash = (await rowOf(first)).action_hash as string;
    expect((await decide(marta, first, { outcome: "denied", actionHash: hash })).status).toBe(200);
    const all = await list(marta, "role=decider&kinds=test.ka,test.kb");
    expect(all.items).toHaveLength(3);
    expect(all.total).toBe(2);
    const denied = await list(marta, "role=decider&status=denied&kinds=test.ka");
    expect(denied.items.map((i) => i.id)).toEqual([first]);
    expect(denied.total).toBe(1);
    // Sam asked for all of them but decides none: his requester inbox counts what is pending for him.
    expect((await list(sam, "role=requester&kinds=test.ka,test.kb,test.kc")).total).toBe(3);
    expect((await list(sam, "role=decider&kinds=test.ka,test.kb,test.kc")).total).toBe(0);
    const legacy = await list(marta, "role=decider&status=pending");
    expect(legacy).not.toHaveProperty("total");
  });

  it("an invalid kinds value is 400", async () => {
    for (const bad of ["bad%20id", "test.ka,", "Test.ka", "a,b,c,d,e"]) {
      const res = await marta.request("GET", `/api/v1/approvals?role=decider&kinds=${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });

  it("an organization B decider never receives organization A items, for any kinds value", async () => {
    const { client: eve, userB } = await otherOrgAdmin();
    listDeciders.add(userB);
    try {
      for (const kinds of ["test.ka", "test.ka,test.kb", "test.kc,test.link,test.grant_turn"]) {
        for (const role of ["decider", "requester"]) {
          expect(await list(eve, `role=${role}&kinds=${kinds}`), `${role} ${kinds}`).toEqual({
            items: [],
            nextCursor: null,
            total: 0,
          });
        }
      }
    } finally {
      listDeciders.delete(userB);
    }
  });
});
