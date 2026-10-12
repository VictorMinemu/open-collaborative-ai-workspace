import { randomUUID } from "node:crypto";
import { BoardCard, EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestStack, TEST_SETUP_TOKEN, TestClient, type TestStack } from "../../testing";

/**
 * 07.1-10 (BOARD-02, BOARD-04, D-07, C-01, P-03): agents work a board only through the Agent Channel API, bound to the
 * delivered turn (`agent_turns`). In a card's thread the team bot opens a follow-up card in the same board, moves it and
 * sets its waiting state; the conversation and the human always come from the turn, never from the request. Each call
 * is decided as the agent acting for the turn's human (`channel.post`, agent ∩ human), counted against the turn's tool
 * budget, refused once the turn is tainted, and audited with the agent and the human. Real PostgreSQL + Redis; the cell
 * is a plain bearer client (no OpenClaw, no model).
 *
 * Cast: Víctor (admin, owns the boards), Alex (developer); team bots @clerk (member of the boards) and @other.
 */

const CELL_TOKEN = "ocw-test-cell-token-agent-board-0123456789abcd";

let stack: TestStack;
let su: pg.Client;
let victor: TestClient;
let alex: TestClient;
let orgId: string;
let victorId: string;
let clerkId: string;
let otherId: string;
let opsId: string;
let generalId: string;
let columns: { backlog: string; inProgress: string; done: string };

// biome-ignore lint/suspicious/noExplicitAny: loose JSON access keeps the assertions readable
type Json = Record<string, any>;
type Res = { status: number; body: Json };

async function ok(res: Promise<{ status: number; body: unknown }>, status = 200) {
  const r = await res;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** The cell's bearer call on `/agent-channel/v1`. */
async function cell(method: string, path: string, body: unknown, token = CELL_TOKEN): Promise<Res> {
  const res = await fetch(`${stack.baseUrl}/agent-channel/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

async function invite(email: string, name: string): Promise<{ client: TestClient; id: string }> {
  const inv = await ok(victor.request("POST", "/api/v1/invitations", { email, role: "developer" }));
  const client = new TestClient(stack.baseUrl);
  const accepted = await ok(
    client.request("POST", `/api/v1/invitations/${inv.id}/accept`, {
      name,
      password: "another-long-password",
    }),
  );
  return { client, id: accepted.user.id };
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

const createBoard = async (as: TestClient, name: string, extra: Json = {}) =>
  (await ok(as.request("POST", "/api/v1/channels", { name, layout: "board", ...extra }))).id as string;
const snapshot = (as: TestClient, id: string) => ok(as.request("GET", `/api/v1/boards/${id}`));
const addAgent = (boardId: string, agentId: string) =>
  ok(victor.request("POST", `/api/v1/channels/${boardId}/members`, { kind: "agent", id: agentId }));

/** A human card (`POST /boards/:id/cards`). */
const humanCard = (as: TestClient, boardId: string, description: string) =>
  ok(as.request("POST", `/api/v1/boards/${boardId}/cards`, { description, clientMessageId: randomUUID() }));

/** The `agent.mention.v1` delivered to `agentId` for `messageId` (appended in the message's transaction). */
async function deliveredFor(agentId: string, messageId: string): Promise<Json> {
  const rows = (
    await su.query(
      `select payload from app.stream_events
        where stream_id = $1 and type = 'agent.mention.v1' and payload->'agent'->>'id' = $2
          and payload->'message'->>'id' = $3 order by seq`,
      [`cell:${orgId}`, agentId, messageId],
    )
  ).rows.map((r) => r.payload as Json);
  expect(rows, `one delivery of ${messageId}`).toHaveLength(1);
  return rows[0] as Json;
}

/** A card by `as` on `boardId` that mentions @clerk; returns the card and the delivered turn's event. */
async function cardTurn(as: TestClient, boardId: string, text = "Pump 3 leaks\n@clerk open a follow-up") {
  const card = await humanCard(as, boardId, text);
  return { card, ev: await deliveredFor(clerkId, card.messageId as string) };
}

const createCard = (eventId: string, extra: Json = {}, token?: string) =>
  cell(
    "POST",
    "/board/cards",
    {
      eventId,
      agentId: clerkId,
      idempotencyKey: `${eventId}:board:${randomUUID()}`,
      description: "Order spare valve",
      ...extra,
    },
    token,
  );
const patchCard = (eventId: string, messageId: string, body: Json, token?: string) =>
  cell("PATCH", `/board/cards/${messageId}`, { eventId, agentId: clerkId, ...body }, token);
const readBoard = (eventId: string, extra: Json = {}, token?: string) =>
  cell("POST", "/board/read", { eventId, agentId: clerkId, ...extra }, token);

const toolCalls = async (eventId: string) =>
  (await su.query("select tool_calls from app.agent_turns where event_id = $1", [eventId])).rows[0]
    ?.tool_calls as number;

const audits = async (action: string) =>
  (
    await su.query(
      `select actor_kind, actor_id, agent_id, user_id, resource_id, result, metadata from app.audit_events
        where action = $1 and organization_id = $2 order by occurred_at`,
      [action, orgId],
    )
  ).rows as Json[];

beforeAll(async () => {
  stack = await startTestStack({ env: { OCW_CELL_TOKEN: CELL_TOKEN, OCW_MODEL_PROVIDER: "mock" } });
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
  orgId = setup.organization.id;
  victorId = setup.user.id;
  ({ client: alex } = await invite("alex@example.test", "Alex Kim"));
  clerkId = await teamBot("Clerk", "clerk");
  otherId = await teamBot("Other", "other");

  opsId = await createBoard(victor, "ops", { visibility: "public" });
  await addAgent(opsId, clerkId);
  await addAgent(opsId, otherId);
  const snap = await snapshot(victor, opsId);
  const col = (name: string) => (snap.columns as Json[]).find((c) => c.name === name)?.id as string;
  columns = { backlog: col("Backlog"), inProgress: col("In progress"), done: col("Done") };

  generalId = (await ok(victor.request("POST", "/api/v1/channels", { name: "general" }))).id as string;
  await ok(victor.request("POST", `/api/v1/channels/${generalId}/members`, { kind: "agent", id: clerkId }));
}, 180_000);

afterAll(async () => {
  await su?.end();
  await stack?.stop();
});

// ---------------------------------------------------------------------------------------------------- Task 1

describe("tracer: in a card's thread @clerk opens a follow-up card and moves it to In progress (Task 1)", () => {
  let ev: Json;
  let victorsCard: Json;
  let followUp: Json;
  let fromSeq: number;
  let callsBefore: number;
  const key = () => `${ev.eventId}:board:1`;

  it("a card mentioning @clerk delivers a turn that offers ocw_board_card (side-effecting, trusted output)", async () => {
    fromSeq = Number(
      (
        await su.query("select coalesce(max(seq), 0) as s from app.stream_events where stream_id = $1", [
          `conv:${opsId}`,
        ])
      ).rows[0].s,
    );
    ({ card: victorsCard, ev } = await cardTurn(victor, opsId));
    expect(ev.conversation).toMatchObject({ id: opsId, kind: "channel" });
    expect(ev.thread.rootMessageId).toBe(victorsCard.messageId);
    expect(ev.turn.tools).toContain("ocw_board_card");
    expect(ev.turn.toolFlags.ocw_board_card).toEqual({ untrustedOutput: false, sideEffecting: true });
    const row = (
      await su.query("select tools, tool_flags, user_id from app.agent_turns where event_id = $1", [
        ev.eventId,
      ])
    ).rows[0];
    expect(row.tools).toContain("ocw_board_card");
    expect(row.user_id).toBe(victorId);
    callsBefore = await toolCalls(ev.eventId);
  });

  it("POST /board/cards → 201: a card authored by @clerk in the same board's Backlog; the same key → 200, the same card", async () => {
    const res = await createCard(ev.eventId, { idempotencyKey: key() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    followUp = BoardCard.parse(res.body.card);
    expect(followUp).toMatchObject({
      conversationId: opsId,
      columnId: columns.backlog,
      authorKind: "agent",
      authorId: clerkId,
      title: "Order spare valve",
      description: "Order spare valve",
      version: 1,
    });
    const msg = (
      await su.query(
        "select conversation_id, author_kind, author_id, thread_id, client_message_id from app.messages where id = $1",
        [followUp.messageId],
      )
    ).rows[0];
    expect(msg).toEqual({
      conversation_id: opsId,
      author_kind: "agent",
      author_id: clerkId,
      thread_id: null,
      // Agent keys live in their own namespace, so a board card never collides with a reply or an Agent Card.
      client_message_id: `board:${key()}`,
    });

    const again = await createCard(ev.eventId, { idempotencyKey: key() });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.card).toEqual(followUp);
    const n = (
      await su.query("select count(*)::int as n from app.board_cards where conversation_id = $1", [opsId])
    ).rows[0].n;
    expect(n).toBe(2);
  });

  it("PATCH moves it to In progress, then sets waiting on customer, each naming the version it saw", async () => {
    const moved = await patchCard(ev.eventId, followUp.messageId, {
      expectedVersion: 1,
      move: { columnId: columns.inProgress, afterCardId: null },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.card).toMatchObject({ columnId: columns.inProgress, version: 2 });

    const waiting = await patchCard(ev.eventId, followUp.messageId, {
      expectedVersion: 2,
      waitingOn: "customer",
    });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);
    expect(waiting.body.card).toMatchObject({
      columnId: columns.inProgress,
      waitingOn: "customer",
      version: 3,
    });
    const snap = await snapshot(alex, opsId);
    const inProgress = (snap.cards as Json[]).find((c) => c.columnId === columns.inProgress) as Json;
    expect(inProgress.cards).toEqual([waiting.body.card]);
  });

  it("POST /board/read → the board, its columns and the card of the turn's thread (Víctor's card)", async () => {
    const res = await readBoard(ev.eventId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.board).toMatchObject({ conversationId: opsId });
    expect((res.body.columns as Json[]).map((c) => c.id)).toEqual(
      expect.arrayContaining([columns.backlog, columns.inProgress, columns.done]),
    );
    expect(res.body.card).toMatchObject({
      messageId: victorsCard.messageId,
      authorKind: "user",
      authorId: victorId,
    });
  });

  it("the conv: stream carries the agent card's message.created and three board.card_upserted", async () => {
    const frames = (
      await su.query(
        "select type, payload from app.stream_events where stream_id = $1 and seq > $2 order by seq",
        [`conv:${opsId}`, fromSeq],
      )
    ).rows as Json[];
    const created = frames.filter(
      (f) => f.type === EventTypes.messageCreated && f.payload.message?.id === followUp.messageId,
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.payload.message.author).toMatchObject({ kind: "agent", id: clerkId });
    const upserts = frames.filter(
      (f) => f.type === EventTypes.boardCardUpserted && f.payload.card?.messageId === followUp.messageId,
    );
    expect(upserts.map((f) => f.payload.card.version)).toEqual([1, 2, 3]);
  });

  it("audits board.card.created / moved / updated as @clerk acting for Víctor, with no card text", async () => {
    const rows = [
      ...(await audits("board.card.created")),
      ...(await audits("board.card.moved")),
      ...(await audits("board.card.updated")),
    ].filter((a) => a.resource_id === followUp.messageId);
    expect(rows).toHaveLength(3);
    for (const a of rows) {
      expect(a).toMatchObject({
        actor_kind: "agent",
        actor_id: clerkId,
        agent_id: clerkId,
        user_id: victorId,
        result: "success",
      });
      const text = JSON.stringify(a.metadata);
      for (const secret of ["Order spare", "valve", "Pump", "leaks"]) expect(text).not.toContain(secret);
    }
  });

  it("every board call counted against the turn's budget (create, its retry, two patches, the read)", async () => {
    expect((await toolCalls(ev.eventId)) - callsBefore).toBe(5);
  });

  it("the same bot mentioned in a text channel is not offered ocw_board_card; its list is the board turn's minus it", async () => {
    const msg = await ok(
      victor.request("POST", `/api/v1/conversations/${generalId}/messages`, { body: "@clerk any news?" }),
    );
    const text = await deliveredFor(clerkId, msg.id as string);
    expect(text.turn.tools).not.toContain("ocw_board_card");
    expect(text.turn.toolFlags.ocw_board_card).toBeUndefined();
    expect(text.turn.tools).toEqual((ev.turn.tools as string[]).filter((t) => t !== "ocw_board_card"));
  });
});
