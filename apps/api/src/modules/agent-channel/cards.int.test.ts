import { randomUUID } from "node:crypto";
import { AgentCard, AgentCardActionEvent, EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeCellPlugin } from "../../../../../e2e/support/fake-cell-plugin";
import { sha256Hex } from "../../lib/crypto";
import { TEST_SETUP_TOKEN, TestClient } from "../../testing";
import { type AiStack, seedPlan, startAiStack, subscribeConv } from "../../testing-ai";
import { errorCode, invite } from "../../testing-workzone";

/**
 * 06-13 (AGENT-04, D-07, P-11): Agent Cards on the server. An agent posts a typed card through the Agent Channel API
 * (here a fake OpenClaw cell holding the cell token), the message body is the card's plain-text summary, every reader
 * sees the card live and in place (`message.created`, then `message.updated` on each change), only the posting agent
 * updates it with an optimistic version, readers follow it and get `card_updated` when its status changes, and one
 * allowed reader decides an approval once; the decision reaches the agent as `agent.card_action.v1`. Real PostgreSQL +
 * Redis, the in-process fake model; no real provider and no OpenClaw container.
 *
 * Cast: Víctor (admin, owns #backend), Alex (developer), Sam Lee (standard), Riley (developer); bots @deploy (member of
 * #backend) and @other.
 */

const CELL_TOKEN = "ocw-test-cell-token-agent-cards-0123456789abcdef";
const PLAN_MODEL = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" } as const;

let stack: AiStack;
let su: pg.Client;
let victor: TestClient;
let alex: TestClient;
let sam: TestClient;
let riley: TestClient;
let victorId: string;
let alexId: string;
let samId: string;
let rileyId: string;
let orgId: string;
let backendId: string;
let deployId: string;
let otherId: string;
let cell: FakeCellPlugin;
const plugins: FakeCellPlugin[] = [];

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;

const cid = () => `cm-${randomUUID()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ok(res: Promise<{ status: number; body: Record<string, unknown> | null }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

async function meId(client: TestClient): Promise<string> {
  return ((await ok(client.request("GET", "/api/v1/me"))).user as Json).id as string;
}

function newCell(token = CELL_TOKEN) {
  const p = new FakeCellPlugin({ apiUrl: stack.baseUrl, token });
  plugins.push(p);
  return p;
}

async function teamBot(name: string, username: string): Promise<string> {
  const bot = await ok(
    victor.request("POST", "/api/v1/agents", {
      name,
      username,
      instructions: `You are ${name}.`,
      modelProvider: "mock",
      modelId: "mock-1",
    }),
  );
  return bot.id as string;
}

const deployCard = (over: Json = {}): Json => ({
  kind: "deployment",
  title: "Deploy api v2.3",
  fields: [
    { label: "Environment", value: "production" },
    { label: "Commit", value: "abc123" },
  ],
  status: "running",
  actions: [
    { kind: "open", label: "Open", target: "/work-zone" },
    { kind: "follow", label: "Follow" },
    { kind: "approve", label: "Approve" },
  ],
  summary: "Deploying api v2.3 to production",
  ...over,
});

const postCard = (
  conversationId: string,
  card: Json = deployCard(),
  extra: Json = {},
  p: FakeCellPlugin = cell,
) =>
  p.request<Json>("POST", "/cards", {
    agentId: deployId,
    conversationId,
    threadRootId: null,
    idempotencyKey: `card-${randomUUID()}`,
    card,
    ...extra,
  });

const patchCard = (messageId: string, patch: Json, agentId = deployId, p: FakeCellPlugin = cell) =>
  p.request<Json>("PATCH", `/cards/${messageId}`, { agentId, patch });

const pageOf = async (as: TestClient, conversationId: string) =>
  (await ok(as.request("GET", `/api/v1/conversations/${conversationId}/messages`))).messages as Json[];

const audits = async (action: string) =>
  (
    await su.query(
      "select actor_kind, actor_id, agent_id, resource_id, metadata from app.audit_events where action = $1 and organization_id = $2 order by occurred_at",
      [action, orgId],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startAiStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN } });
  su = new pg.Client({ connectionString: stack.db.superuserUrl });
  await su.connect();
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
  backendId = (await ok(victor.request("POST", "/api/v1/channels", { name: "backend" }))).id as string;
  for (const c of [alex, sam, riley]) await ok(c.request("POST", `/api/v1/channels/${backendId}/join`));
  deployId = await teamBot("Deploy", "deploy");
  otherId = await teamBot("Other", "other");
  await ok(victor.request("POST", `/api/v1/channels/${backendId}/members`, { kind: "agent", id: deployId }));
  cell = newCell();
}, 180_000);

afterAll(async () => {
  for (const p of plugins) await p.stop();
  await su?.end();
  await stack?.stop();
});

describe("tracer: @deploy posts a deployment card in #backend and updates it in place (Task 1)", () => {
  let cardId: string;
  const key = `card-${randomUUID()}`;

  it("POST /cards → 201 {messageId, created, version 1}; message.created carries the summary body and the card", async () => {
    const sub = await subscribeConv(stack.baseUrl, alex, backendId);
    const res = await postCard(backendId, deployCard(), { idempotencyKey: key });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ created: true, version: 1 });
    cardId = res.body.messageId as string;

    await sub.waitFor(() =>
      sub.durable(EventTypes.messageCreated).some((f) => ((f.data as Json).message as Json).id === cardId),
    );
    const created = sub
      .durable(EventTypes.messageCreated)
      .map((f) => (f.data as Json).message as Json)
      .find((m) => m.id === cardId) as Json;
    sub.close();
    expect(created.body).toBe("Deploying api v2.3 to production");
    expect(created.author).toMatchObject({ kind: "agent", id: deployId });
    const card = AgentCard.parse(created.card);
    expect(card).toMatchObject({
      kind: "deployment",
      title: "Deploy api v2.3",
      status: "running",
      version: 1,
    });
    expect(card.decision).toBeNull();
    // Realtime events never carry viewer-specific fields.
    expect(created.card.following).toBeUndefined();
    expect(created.card.viewerCan).toBeUndefined();
  });

  it("the same idempotency key → 200 created: false, the same message, no second card", async () => {
    const again = await postCard(backendId, deployCard(), { idempotencyKey: key });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ messageId: cardId, created: false, version: 1 });
    const n = (
      await su.query("select count(*)::int as n from app.message_cards where conversation_id = $1", [
        backendId,
      ])
    ).rows[0].n;
    expect(n).toBe(1);
  });

  it("GET /conversations/:id/messages shows the card to a member: following false, viewerCan follow + decide", async () => {
    const shown = (await pageOf(alex, backendId)).find((m) => m.id === cardId) as Json;
    expect(shown.body).toBe("Deploying api v2.3 to production");
    expect(shown.card).toMatchObject({
      kind: "deployment",
      title: "Deploy api v2.3",
      status: "running",
      version: 1,
      decision: null,
      following: false,
      viewerCan: ["follow", "decide"],
    });
    expect(shown.card.fields).toEqual([
      { label: "Environment", value: "production" },
      { label: "Commit", value: "abc123" },
    ]);
  });

  it("PATCH by @deploy → 200 version 2; message.updated carries the new status on the same message", async () => {
    const sub = await subscribeConv(stack.baseUrl, sam, backendId);
    const before = (await su.query("select count(*)::int as n from app.messages")).rows[0].n;
    const res = await patchCard(cardId, { expectedVersion: 1, status: "succeeded" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ messageId: cardId, version: 2 });
    await sub.waitFor(() =>
      sub.durable(EventTypes.messageUpdated).some((f) => ((f.data as Json).message as Json).id === cardId),
    );
    const updated = sub
      .durable(EventTypes.messageUpdated)
      .map((f) => (f.data as Json).message as Json)
      .find((m) => m.id === cardId) as Json;
    sub.close();
    expect(AgentCard.parse(updated.card)).toMatchObject({ status: "succeeded", version: 2 });
    expect(updated.body).toBe("Deploying api v2.3 to production");
    expect((await su.query("select count(*)::int as n from app.messages")).rows[0].n).toBe(before);
    const shown = (await pageOf(victor, backendId)).find((m) => m.id === cardId) as Json;
    expect(shown.card).toMatchObject({ status: "succeeded", version: 2 });
  });

  it("a new summary replaces the body (edited); a stale version is 409; another agent is 403; an external Open is 400", async () => {
    const res = await patchCard(cardId, { expectedVersion: 2, summary: "Deployed api v2.3 to production" });
    expect(res.status).toBe(200);
    const row = (await su.query("select body, edited_at from app.messages where id = $1", [cardId])).rows[0];
    expect(row.body).toBe("Deployed api v2.3 to production");
    expect(row.edited_at).not.toBeNull();

    const stale = await patchCard(cardId, { expectedVersion: 1, status: "failed" });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe("card_version_conflict");

    const foreign = await patchCard(cardId, { expectedVersion: 3, status: "failed" }, otherId);
    expect(foreign.status).toBe(403);
    expect(errorCode(foreign)).toBe("not_card_author");

    const evil = await postCard(
      backendId,
      deployCard({ actions: [{ kind: "open", label: "Open", target: "https://evil.example" }] }),
    );
    expect(evil.status).toBe(400);
    const unknown = await patchCard(randomUUID(), { expectedVersion: 1, status: "failed" });
    expect(unknown.status).toBe(404);
    const card = (
      await su.query("select status, version from app.message_cards where message_id = $1", [cardId])
    ).rows[0];
    expect(card).toEqual({ status: "succeeded", version: 3 });
  });

  it("a non-member agent cannot post a card (403, as /messages)", async () => {
    const res = await postCard(backendId, deployCard(), { agentId: otherId });
    expect(res.status).toBe(403);
  });

  it("the body is the summary only: a field value is not searchable, the summary is", async () => {
    const field = await ok(alex.request("GET", "/api/v1/search/messages?q=abc123"));
    expect(field.hits).toEqual([]);
    const summary = await ok(alex.request("GET", "/api/v1/search/messages?q=Deployed"));
    expect((summary.hits as Json[]).map((h) => h.messageId)).toContain(cardId);
    const row = (await su.query("select body from app.messages where id = $1", [cardId])).rows[0];
    expect(row.body).not.toContain("abc123");
    expect(row.body).not.toContain("{");
  });

  it("audits agent_card.posted / agent_card.updated with ids, kind and status only", async () => {
    const posted = (await audits("agent_card.posted")).find((a) => a.resource_id === cardId) as Json;
    expect(posted).toMatchObject({
      actor_kind: "agent",
      actor_id: deployId,
      agent_id: deployId,
      metadata: {
        messageId: cardId,
        conversationId: backendId,
        agentId: deployId,
        kind: "deployment",
        status: "running",
      },
    });
    const updated = (await audits("agent_card.updated")).filter((a) => a.resource_id === cardId);
    expect(updated).toHaveLength(2);
    expect(updated[0]).toMatchObject({
      actor_kind: "agent",
      actor_id: deployId,
      metadata: { messageId: cardId, agentId: deployId, kind: "deployment", status: "succeeded", version: 2 },
    });
    for (const a of [posted, ...updated]) {
      const text = JSON.stringify(a.metadata);
      for (const secret of ["Deploy api", "production", "abc123", "Deploying", "Deployed"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("cards land wherever the agent posts (Task 1)", () => {
  it("a thread reply in #backend: the card is a reply and shows in the thread", async () => {
    const root = await ok(
      victor.request("POST", `/api/v1/conversations/${backendId}/messages`, { body: "Ship v2.3 today?" }),
    );
    const res = await postCard(backendId, deployCard({ title: "Deploy api v2.4" }), {
      threadRootId: root.id,
      inReplyToMessageId: root.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = (await su.query("select thread_id from app.messages where id = $1", [res.body.messageId]))
      .rows[0];
    expect(row.thread_id).toBe(root.id);
    const thread = await ok(alex.request("GET", `/api/v1/messages/${root.id}/thread`));
    const reply = (thread.replies as Json[]).find((m) => m.id === res.body.messageId) as Json;
    expect(reply.card).toMatchObject({ title: "Deploy api v2.4", viewerCan: ["follow", "decide"] });
  });

  it("a DM with @deploy and a group DM: flat, in each snapshot", async () => {
    const dm = await ok(
      victor.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: deployId }] }),
    );
    const group = await ok(
      victor.request("POST", "/api/v1/dms", {
        participants: [
          { kind: "user", id: alexId },
          { kind: "agent", id: deployId },
        ],
      }),
    );
    for (const conv of [dm, group]) {
      const anyRoot = await ok(
        victor.request("POST", `/api/v1/conversations/${conv.id}/messages`, { body: "status please" }),
      );
      const res = await postCard(conv.id as string, deployCard(), { threadRootId: anyRoot.id });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = (await su.query("select thread_id from app.messages where id = $1", [res.body.messageId]))
        .rows[0];
      expect(row.thread_id).toBeNull();
      const shown = (await pageOf(victor, conv.id as string)).find(
        (m) => m.id === res.body.messageId,
      ) as Json;
      expect(shown.card).toMatchObject({ kind: "deployment", following: false });
    }
    const groupCard = (await pageOf(alex, group.id as string)).find((m) => m.card) as Json;
    expect(groupCard.card.viewerCan).toEqual(["follow", "decide"]);
  });

  it("an AI chat with @deploy as a persona: flat, in the AI chat snapshot through withCards", async () => {
    const created = await ok(
      victor.request("POST", "/api/v1/ai-chats", {
        clientMessageId: cid(),
        body: "Track the release",
        model: PLAN_MODEL,
      }),
      201,
    );
    const chatId = (created.chat as Json).id as string;
    await ok(victor.request("POST", `/api/v1/ai-chats/${chatId}/agents`, { agentId: deployId }), 201);
    const res = await postCard(chatId, deployCard({ kind: "report", title: "Release report" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const snap = await ok(victor.request("GET", `/api/v1/ai-chats/${chatId}`));
    const shown = (snap.messages as Json[]).find((m) => m.id === res.body.messageId) as Json;
    expect(shown.threadId).toBeNull();
    expect(shown.author).toMatchObject({ kind: "agent", id: deployId });
    expect(shown.card).toMatchObject({ kind: "report", title: "Release report", following: false });
    // Sam has no access to Víctor's AI chat.
    expect((await sam.request("GET", `/api/v1/ai-chats/${chatId}`)).status).toBe(404);
    await sleep(50);
  });
});

describe("tenant isolation and agent ownership (Task 1, security review)", () => {
  let orgB: string;
  let b: FakeCellPlugin;
  let foreignAgentId: string;
  let card: { message_id: string; version: number };

  beforeAll(async () => {
    orgB = randomUUID();
    const tokenB = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await su.query(
      "insert into auth.organization (id, name, slug, created_at) values ($1, 'Other Org', $2, now())",
      [orgB, `other-${orgB.slice(0, 8)}`],
    );
    await su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [orgB, sha256Hex(tokenB)],
    );
    // A bot of org B (served by org B's cell).
    foreignAgentId = randomUUID();
    await su.query(
      `insert into app.agents (id, organization_id, name, username, instructions, model_provider, model_id, status)
       values ($1, $2, 'Intruder', 'intruder', 'x', 'mock', 'mock-1', 'ready')`,
      [foreignAgentId, orgB],
    );
    b = newCell(tokenB);
    card = (
      await su.query(
        "select message_id, version from app.message_cards where organization_id = $1 and agent_id = $2 limit 1",
        [orgId, deployId],
      )
    ).rows[0] as { message_id: string; version: number };
  });

  const unchanged = async () => {
    const after = (
      await su.query("select version, status from app.message_cards where message_id = $1", [card.message_id])
    ).rows[0];
    expect(after.version).toBe(card.version);
  };

  it("an org-B cell token cannot post or patch into org A, even naming org A's agent (404 agent_not_found)", async () => {
    const posted = await postCard(backendId, deployCard(), {}, b);
    expect(posted.status).toBe(404);
    expect(errorCode(posted)).toBe("agent_not_found");
    const patched = await patchCard(
      card.message_id,
      { expectedVersion: card.version, status: "failed" },
      deployId,
      b,
    );
    expect(patched.status).toBe(404);
    expect(errorCode(patched)).toBe("agent_not_found");
    // Its own bot does not reach org A's conversation or card either.
    const ownPost = await postCard(backendId, deployCard(), { agentId: foreignAgentId }, b);
    expect(ownPost.status).toBe(404);
    const ownPatch = await patchCard(
      card.message_id,
      { expectedVersion: card.version, status: "failed" },
      foreignAgentId,
      b,
    );
    expect(ownPatch.status).toBe(404);
    expect(errorCode(ownPatch)).toBe("card_not_found");
    await unchanged();
  });

  it("org A's cell cannot act as another cell's (org B's) agent or an unknown agent (404 agent_not_found)", async () => {
    for (const agentId of [foreignAgentId, randomUUID()]) {
      const posted = await postCard(backendId, deployCard(), { agentId });
      expect(posted.status).toBe(404);
      expect(errorCode(posted)).toBe("agent_not_found");
      const patched = await patchCard(
        card.message_id,
        { expectedVersion: card.version, status: "failed" },
        agentId,
      );
      expect(patched.status).toBe(404);
      expect(errorCode(patched)).toBe("agent_not_found");
    }
    const n = (
      await su.query("select count(*)::int as n from app.message_cards where agent_id = $1", [foreignAgentId])
    ).rows[0].n;
    expect(n).toBe(0);
    await unchanged();
  });

  it("a card of a different agent of the same cell is refused (403 not_card_author)", async () => {
    const patched = await patchCard(
      card.message_id,
      { expectedVersion: card.version, status: "failed" },
      otherId,
    );
    expect(patched.status).toBe(403);
    expect(errorCode(patched)).toBe("not_card_author");
    await unchanged();
  });
});

// ---------------------------------------------------------------- Task 2: follow, notifications, decisions

const follow = (as: TestClient, messageId: string) => as.request("POST", `/api/v1/cards/${messageId}/follow`);
const unfollow = (as: TestClient, messageId: string) =>
  as.request("DELETE", `/api/v1/cards/${messageId}/follow`);
const decide = (as: TestClient, messageId: string, outcome: "approved" | "denied" = "approved") =>
  as.request("POST", `/api/v1/cards/${messageId}/decision`, { outcome });

const notificationsOf = async (messageId: string) =>
  (
    await su.query(
      "select user_id, kind, actor_kind, actor_id from app.notifications where message_id = $1 order by user_id",
      [messageId],
    )
  ).rows as Json[];

/** Every `agent.card_action.v1` the API appended for one card (the cell stream is the delivery ledger). */
const cardActionsOf = async (messageId: string) =>
  (
    await su.query(
      "select seq, payload from app.stream_events where stream_id = $1 and type = 'agent.card_action.v1' and payload->'cardAction'->>'messageId' = $2 order by seq",
      [`cell:${orgId}`, messageId],
    )
  ).rows as Array<{ seq: number; payload: Json }>;

async function newCard(
  conversationId: string,
  card: Json = deployCard(),
  agentId = deployId,
): Promise<string> {
  const res = await postCard(conversationId, card, { agentId });
  if (res.status !== 201) throw new Error(`card post failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.messageId as string;
}

const approvalCard = (approve: Json = {}): Json =>
  deployCard({
    kind: "approval",
    status: "pending",
    actions: [
      { kind: "follow", label: "Follow" },
      { kind: "approve", label: "Approve", denyLabel: "Deny", ...approve },
    ],
  });

describe("follow: followers get card_updated when the status changes (Task 2)", () => {
  let cardId: string;

  it("Alex follows (204, following true in his snapshot); Riley follows and unfollows", async () => {
    cardId = await newCard(backendId);
    expect((await follow(alex, cardId)).status).toBe(204);
    expect((await follow(alex, cardId)).status).toBe(204);
    const shown = (await pageOf(alex, backendId)).find((m) => m.id === cardId) as Json;
    expect(shown.card.following).toBe(true);
    expect(((await pageOf(sam, backendId)).find((m) => m.id === cardId) as Json).card.following).toBe(false);
    expect((await follow(riley, cardId)).status).toBe(204);
    expect((await unfollow(riley, cardId)).status).toBe(204);
    expect(((await pageOf(riley, backendId)).find((m) => m.id === cardId) as Json).card.following).toBe(
      false,
    );
    const rows = (
      await su.query("select user_id from app.message_card_follows where message_id = $1", [cardId])
    ).rows;
    expect(rows).toEqual([{ user_id: alexId }]);
    expect(rows.map((r) => r.user_id)).not.toContain(rileyId);
  });

  it("a status change notifies the follower once (the agent as actor); non-followers and the unfollower get nothing", async () => {
    const res = await patchCard(cardId, { expectedVersion: 1, status: "failed" });
    expect(res.status).toBe(200);
    expect(await notificationsOf(cardId)).toEqual([
      { user_id: alexId, kind: "card_updated", actor_kind: "agent", actor_id: deployId },
    ]);
  });

  it("a patch that changes only fields (or the same status) notifies nobody", async () => {
    const quiet = await newCard(backendId);
    expect((await follow(alex, quiet)).status).toBe(204);
    expect(
      (await patchCard(quiet, { expectedVersion: 1, fields: [{ label: "Commit", value: "def456" }] })).status,
    ).toBe(200);
    expect((await patchCard(quiet, { expectedVersion: 2, status: "running" })).status).toBe(200);
    expect(await notificationsOf(quiet)).toEqual([]);
  });

  it("unknown cards and non-readers get 404 on follow", async () => {
    expect((await follow(alex, randomUUID())).status).toBe(404);
    const ops = await ok(victor.request("POST", "/api/v1/channels", { name: "ops", visibility: "private" }));
    await ok(victor.request("POST", `/api/v1/channels/${ops.id}/members`, { kind: "agent", id: deployId }));
    const hidden = await newCard(ops.id as string, approvalCard());
    expect((await follow(sam, hidden)).status).toBe(404);
    expect((await unfollow(sam, hidden)).status).toBe(404);
    expect((await decide(sam, hidden)).status).toBe(404);
    // Víctor (a member) can.
    expect((await follow(victor, hidden)).status).toBe(204);
  });
});

describe("decision: one audited, server-decided outcome, delivered to the agent (Task 2)", () => {
  let p: FakeCellPlugin;
  let cardId: string;

  beforeAll(async () => {
    p = newCell();
    await p.start();
  });

  it("Sam approves an approval card: 200 with the decision, message.updated, audit, one agent.card_action.v1 for Sam", async () => {
    cardId = await newCard(backendId, approvalCard());
    const sub = await subscribeConv(stack.baseUrl, alex, backendId);
    const res = await decide(sam, cardId, "approved");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = AgentCard.parse(res.body);
    expect(card.decision).toMatchObject({
      outcome: "approved",
      by: { kind: "user", id: samId, displayName: "Sam Lee" },
    });
    expect(card.viewerCan).toEqual(["follow"]);

    await sub.waitFor(() =>
      sub
        .durable(EventTypes.messageUpdated)
        .some(
          (f) => ((f.data as Json).message as Json).id === cardId && (f.data as Json).message.card?.decision,
        ),
    );
    sub.close();

    const audit = (await audits("agent_card.decided")).find((a) => a.resource_id === cardId) as Json;
    expect(audit).toMatchObject({
      actor_id: samId,
      metadata: { messageId: cardId, agentId: deployId, outcome: "approved" },
    });

    const ev = await p.waitFor(
      (e) => e.type === "agent.card_action.v1" && (e.data as Json).cardAction?.messageId === cardId,
    );
    const action = AgentCardActionEvent.parse(ev.data);
    expect(action.message.text).toBe("Sam Lee approved “Deploy api v2.3”");
    expect(action.message.author).toEqual({ kind: "user", id: samId, displayName: "Sam Lee" });
    expect(action.agent).toMatchObject({ id: deployId, handle: "deploy" });
    expect(action.conversation).toMatchObject({ id: backendId, kind: "channel" });
    expect(action.thread.rootMessageId).toBe(cardId);
    expect(action.cardAction).toEqual({
      messageId: cardId,
      kind: "approval",
      title: "Deploy api v2.3",
      outcome: "approved",
    });
    expect(action.turn).toBeDefined();
    const turn = (
      await su.query("select user_id, agent_id from app.agent_turns where event_id = $1", [action.eventId])
    ).rows[0];
    expect(turn).toEqual({ user_id: samId, agent_id: deployId });
    expect(await cardActionsOf(cardId)).toHaveLength(1);
  });

  it("a second decision is 409 card_already_decided and changes nothing", async () => {
    const again = await decide(alex, cardId, "denied");
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe("card_already_decided");
    const row = (
      await su.query("select decision, decided_by from app.message_cards where message_id = $1", [cardId])
    ).rows[0];
    expect(row).toEqual({ decision: "approved", decided_by: samId });
    expect(await cardActionsOf(cardId)).toHaveLength(1);
    const shown = (await pageOf(alex, backendId)).find((m) => m.id === cardId) as Json;
    expect(shown.card.viewerCan).toEqual(["follow"]);
    expect(shown.card.decision).toMatchObject({ outcome: "approved", by: { id: samId } });
  });

  it("named approvers: Sam is 403 not_card_approver (no decide offered), Víctor denies", async () => {
    const named = await newCard(backendId, approvalCard({ approverIds: [victorId] }));
    expect(((await pageOf(sam, backendId)).find((m) => m.id === named) as Json).card.viewerCan).toEqual([
      "follow",
    ]);
    const refused = await decide(sam, named);
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe("not_card_approver");
    expect(((await pageOf(victor, backendId)).find((m) => m.id === named) as Json).card.viewerCan).toEqual([
      "follow",
      "decide",
    ]);
    const res = await decide(victor, named, "denied");
    expect(res.status).toBe(200);
    const [ev] = await cardActionsOf(named);
    expect(ev?.payload.message.text).toBe("Víctor Ruiz denied “Deploy api v2.3”");
    expect(ev?.payload.cardAction.outcome).toBe("denied");
  });

  it("a deny rule on agent_card.approve for Víctor → 403 and no decide offered", async () => {
    const named = await newCard(backendId, approvalCard({ approverIds: [victorId] }));
    const ruleId = randomUUID();
    await su.query(
      `insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, effect)
       values ($1, $2, 'user', $3, 'agent_card.approve', 'deny')`,
      [ruleId, orgId, victorId],
    );
    try {
      expect(((await pageOf(victor, backendId)).find((m) => m.id === named) as Json).card.viewerCan).toEqual([
        "follow",
      ]);
      expect((await decide(victor, named)).status).toBe(403);
    } finally {
      await su.query("delete from app.permission_rules where id = $1", [ruleId]);
    }
    expect(await cardActionsOf(named)).toHaveLength(0);
  });

  it("a card without an approve action is 409 card_not_decidable", async () => {
    const withoutApprove = await newCard(
      backendId,
      deployCard({ actions: [{ kind: "follow", label: "Follow" }] }),
    );
    const res = await decide(sam, withoutApprove);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("card_not_decidable");
    expect(
      ((await pageOf(sam, backendId)).find((m) => m.id === withoutApprove) as Json).card.viewerCan,
    ).toEqual(["follow"]);
  });

  it("an AI chat without a grant: 404 on follow and decision", async () => {
    const created = await ok(
      victor.request("POST", "/api/v1/ai-chats", {
        clientMessageId: cid(),
        body: "Approvals",
        model: PLAN_MODEL,
      }),
      201,
    );
    const chatId = (created.chat as Json).id as string;
    await ok(victor.request("POST", `/api/v1/ai-chats/${chatId}/agents`, { agentId: deployId }), 201);
    const inChat = await newCard(chatId, approvalCard());
    for (const c of [sam, alex]) {
      expect((await follow(c, inChat)).status).toBe(404);
      expect((await decide(c, inChat)).status).toBe(404);
    }
    // The owner decides; the delivery is flat in the AI chat.
    expect((await decide(victor, inChat)).status).toBe(200);
    const [ev] = await cardActionsOf(inChat);
    expect(ev?.payload.conversation).toMatchObject({ id: chatId, kind: "ai_chat" });
  });

  it("a disabled agent or one at its daily limit gets no event; the decision still stands", async () => {
    const opsBot = await teamBot("Ops", "opsbot");
    await ok(victor.request("POST", `/api/v1/channels/${backendId}/members`, { kind: "agent", id: opsBot }));
    const off = await newCard(backendId, approvalCard(), opsBot);
    await ok(victor.request("PATCH", `/api/v1/agents/${opsBot}`, { enabled: false }));
    expect((await decide(sam, off)).status).toBe(200);
    expect(await cardActionsOf(off)).toHaveLength(0);

    const limBot = await teamBot("Limited", "limited");
    await ok(victor.request("PATCH", `/api/v1/agents/${limBot}/capabilities`, { dailyLimit: 1 }));
    await ok(victor.request("POST", `/api/v1/channels/${backendId}/members`, { kind: "agent", id: limBot }));
    await ok(
      victor.request("POST", `/api/v1/conversations/${backendId}/messages`, {
        body: "@limited are you there?",
        mentions: [{ kind: "agent", id: limBot }],
      }),
    );
    const limited = await newCard(backendId, approvalCard(), limBot);
    expect((await decide(sam, limited)).status).toBe(200);
    expect(await cardActionsOf(limited)).toHaveLength(0);
    const rows = (
      await su.query("select decision from app.message_cards where message_id = any($1::uuid[])", [
        [off, limited],
      ])
    ).rows;
    expect(rows).toEqual([{ decision: "approved" }, { decision: "approved" }]);
    await sleep(200);
  });
});

// ---------------------------------------------------------------- 06-14: the persona's ocw_agent_card tool

describe("06-14: every delivered turn offers ocw_agent_card, gated like any tool, bound to the turn's conversation", () => {
  const CARD_FLAGS = { untrustedOutput: false, sideEffecting: false };

  const mentionsOf = async (messageId: string) =>
    (
      await su.query(
        "select payload from app.stream_events where stream_id = $1 and type = 'agent.mention.v1' and payload->'message'->>'id' = $2 order by seq",
        [`cell:${orgId}`, messageId],
      )
    ).rows.map((r) => r.payload as Json);

  async function deliveredFor(messageId: string): Promise<Json> {
    for (let i = 0; i < 100; i++) {
      const [ev] = await mentionsOf(messageId);
      if (ev) return ev;
      await sleep(50);
    }
    throw new Error(`no agent.mention.v1 for ${messageId}`);
  }

  const gate = (eventId: string, agentId = deployId) =>
    cell.request<Json>("POST", "/tool-calls", { eventId, agentId, tool: "ocw_agent_card", params: {} });

  let channelEvent: Json;

  it("a channel mention, a DM and an AI chat mention each list ocw_agent_card with flags {false, false}", async () => {
    const inChannel = await ok(
      victor.request("POST", `/api/v1/conversations/${backendId}/messages`, {
        body: "@deploy post the release card",
        mentions: [{ kind: "agent", id: deployId }],
      }),
    );
    channelEvent = await deliveredFor(inChannel.id as string);

    const dm = await ok(
      alex.request("POST", "/api/v1/dms", { participants: [{ kind: "agent", id: deployId }] }),
    );
    const inDm = await ok(
      alex.request("POST", `/api/v1/conversations/${dm.id}/messages`, { body: "card please" }),
    );
    const dmEvent = await deliveredFor(inDm.id as string);

    const created = await ok(
      victor.request("POST", "/api/v1/ai-chats", {
        clientMessageId: cid(),
        body: "Release planning",
        model: PLAN_MODEL,
      }),
      201,
    );
    const chatId = (created.chat as Json).id as string;
    await ok(victor.request("POST", `/api/v1/ai-chats/${chatId}/agents`, { agentId: deployId }), 201);
    const sent = await victor.request("POST", `/api/v1/ai-chats/${chatId}/messages`, {
      clientMessageId: cid(),
      body: "@deploy track this release",
      model: PLAN_MODEL,
    });
    expect([201, 202]).toContain(sent.status);
    const aiEvent = await deliveredFor(((sent.body as Json).userMessage as Json).id as string);

    for (const [ev, kind] of [
      [channelEvent, "channel"],
      [dmEvent, "dm"],
      [aiEvent, "ai_chat"],
    ] as const) {
      expect(ev.conversation.kind, kind).toBe(kind);
      expect(ev.turn.tools, kind).toContain("ocw_agent_card");
      expect(ev.turn.toolFlags.ocw_agent_card, kind).toEqual(CARD_FLAGS);
      const row = (
        await su.query("select tools, tool_flags from app.agent_turns where event_id = $1", [ev.eventId])
      ).rows[0];
      expect(row.tools, kind).toContain("ocw_agent_card");
      expect(row.tool_flags.ocw_agent_card, kind).toEqual(CARD_FLAGS);
    }
  });

  it("GET /cell lists ocw_agent_card among the bot's possible tools (its alsoAllow)", async () => {
    const snap = await cell.fetchCell();
    const bot = (snap.agents as unknown as Json[]).find((a) => a.id === deployId) as Json;
    expect(bot.capabilities.tools).toContain("ocw_agent_card");
  });

  it("the tool gate allows it on the delivered turn (audited as a builtin) and refuses a forged turn id", async () => {
    const allowed = await gate(channelEvent.eventId as string);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ allowed: true, reason: null });
    const audit = (await audits("bot.tool_call")).find(
      (a) => a.metadata?.tool === "ocw_agent_card" && a.metadata?.reason === null,
    ) as Json;
    expect(audit).toMatchObject({
      actor_kind: "agent",
      actor_id: deployId,
      metadata: { sourceKind: "builtin", tool: "ocw_agent_card" },
    });

    const forged = await gate(randomUUID());
    expect(forged.body).toMatchObject({ allowed: false, reason: "unknown_turn" });
    // Another bot of the cell cannot use this turn either.
    expect((await gate(channelEvent.eventId as string, otherId)).body).toMatchObject({
      allowed: false,
      reason: "unknown_turn",
    });
  });

  it("a card the cell posts with the turn's ids lands in that conversation and thread", async () => {
    const res = await postCard(
      channelEvent.conversation.id as string,
      deployCard({ title: "Release v2.5" }),
      {
        threadRootId: channelEvent.thread.rootMessageId,
        inReplyToMessageId: channelEvent.message.id,
        idempotencyKey: `${channelEvent.eventId}:card:0`,
      },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = (
      await su.query("select conversation_id, thread_id, author_id from app.messages where id = $1", [
        res.body.messageId,
      ])
    ).rows[0];
    expect(row).toEqual({
      conversation_id: backendId,
      thread_id: channelEvent.thread.rootMessageId,
      author_id: deployId,
    });
  });

  it("a decision's agent.card_action.v1 turn offers ocw_agent_card too, so the persona can update its card", async () => {
    const approval = await newCard(backendId, approvalCard());
    expect((await decide(alex, approval)).status).toBe(200);
    let ev: Json | undefined;
    for (let i = 0; i < 100 && !ev; i++) {
      ev = (await cardActionsOf(approval))[0]?.payload;
      if (!ev) await sleep(50);
    }
    expect(ev?.turn.tools).toContain("ocw_agent_card");
    expect(ev?.turn.toolFlags.ocw_agent_card).toEqual(CARD_FLAGS);
  });
});
