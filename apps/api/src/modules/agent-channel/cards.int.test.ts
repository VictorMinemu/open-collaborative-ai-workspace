import { randomUUID } from "node:crypto";
import { AgentCard, EventTypes } from "@ocw/contracts";
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
