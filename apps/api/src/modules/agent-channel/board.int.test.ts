import { randomUUID } from "node:crypto";
import { BoardCard, EventTypes } from "@ocw/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/crypto";
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
let alexId: string;
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

const codeOf = (r: Res) => (r.body.error as Json | undefined)?.code as string | undefined;

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
  ({ client: alex, id: alexId } = await invite("alex@example.test", "Alex Kim"));
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

// ---------------------------------------------------------------------------------------------------- Task 2

/** Sign `client`'s user into a brand-new organization B as its admin (the 07.1-05 helper). */
async function moveToOtherOrg(client: TestClient, userId: string): Promise<string> {
  const orgB = randomUUID();
  await su.query("insert into auth.organization (id, name, slug) values ($1, 'Evil', $2)", [
    orgB,
    `evil-${orgB}`,
  ]);
  await su.query("delete from auth.member where user_id = $1", [userId]);
  await su.query("delete from app.org_members where user_id = $1", [userId]);
  await su.query("insert into auth.member (organization_id, user_id, role) values ($1, $2, 'owner')", [
    orgB,
    userId,
  ]);
  await su.query(
    "insert into app.org_members (organization_id, user_id, display_name, role) values ($1, $2, 'Eve', 'admin')",
    [orgB, userId],
  );
  await su.query("update auth.session set active_organization_id = $1 where user_id = $2", [orgB, userId]);
  expect((await ok(client.request("GET", "/api/v1/me/permissions"))).role).toBe("admin");
  return orgB;
}

/** Every row an agent board call could touch on `boardId`, to prove a refused call changed nothing. */
async function boardRows(boardId: string) {
  const q = async (text: string) => (await su.query(text, [boardId])).rows;
  return {
    cards: await q("select * from app.board_cards where conversation_id = $1 order by message_id"),
    messages: await q(
      "select id, body, author_kind, author_id from app.messages where conversation_id = $1 order by id",
    ),
    boards: await q("select * from app.boards where conversation_id = $1"),
  };
}

/** The latest `agent.board.refused` audit for `reason`. */
async function refusedAudit(reason: string): Promise<Json | undefined> {
  return (await audits("agent.board.refused")).filter((a) => a.metadata.reason === reason).at(-1);
}

const firstColumn = async (boardId: string) =>
  ((await snapshot(victor, boardId)).columns as Json[])[0]?.id as string;

describe("agents cannot leave their turn, their tenant or their budget (Task 2)", () => {
  let ev: Json;
  let target: Json;
  let eve: TestClient;
  let orgBToken: string;
  let orgBCard: Json;

  beforeAll(async () => {
    ({ ev } = await cardTurn(victor, opsId, "Valve 9 rattles\n@clerk please track it"));
    target = await humanCard(victor, opsId, "Replace gasket on line 2");
    // Org B: Eve's own organization with a board and a card, and its own cell token.
    const invited = await invite("eve@example.test", "Eve");
    eve = invited.client;
    const orgB = await moveToOtherOrg(eve, invited.id);
    orgBToken = `ocw_cell_${randomUUID()}${randomUUID()}`;
    await su.query(
      "insert into app.agent_credentials (organization_id, kind, token_hash) values ($1, 'channel_plugin', $2)",
      [orgB, sha256Hex(orgBToken)],
    );
    const evilBoard = await createBoard(eve, "evil-ops", { visibility: "public" });
    orgBCard = await humanCard(eve, evilBoard, "Org B's own card");
  });

  /**
   * Every agent board route, called with org B's cell token and org A's turn and card (07.1-14's route-coverage guard
   * mirrors this table): the turn does not exist for org B (RLS), so each call answers no turn.
   */
  const AGENT_BOARD_CROSS_TENANT_ROUTES: ReadonlyArray<{
    name: string;
    call: (token: string, ids: { eventId: string; messageId: string; columnId: string }) => Promise<Res>;
  }> = [
    { name: "POST /agent-channel/v1/board/read", call: (t, i) => readBoard(i.eventId, {}, t) },
    { name: "POST /agent-channel/v1/board/cards", call: (t, i) => createCard(i.eventId, {}, t) },
    {
      name: "PATCH /agent-channel/v1/board/cards/:messageId",
      call: (t, i) =>
        patchCard(
          i.eventId,
          i.messageId,
          { expectedVersion: 1, move: { columnId: i.columnId, afterCardId: null } },
          t,
        ),
    },
  ];

  it.each(AGENT_BOARD_CROSS_TENANT_ROUTES)(
    "org B's cell token with org A's turn: 403 no_trigger on $name, nothing changes, the turn is not counted",
    async (route) => {
      const before = await boardRows(opsId);
      const calls = await toolCalls(ev.eventId);
      const res = await route.call(orgBToken, {
        eventId: ev.eventId,
        messageId: target.messageId,
        columnId: columns.done,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(codeOf(res)).toBe("no_trigger");
      expect(await boardRows(opsId)).toEqual(before);
      expect(await toolCalls(ev.eventId)).toBe(calls);
    },
  );

  it("an unknown event id, or another bot naming @clerk's turn, is no trigger (403 no_trigger), audited without a turn", async () => {
    const before = await boardRows(opsId);
    for (const res of [
      await createCard(randomUUID()),
      await readBoard(randomUUID()),
      await patchCard(randomUUID(), target.messageId, { expectedVersion: 1, waitingOn: "us" }),
      await createCard(ev.eventId, { agentId: otherId }),
      await readBoard(ev.eventId, { agentId: otherId }),
      await patchCard(ev.eventId, target.messageId, {
        agentId: otherId,
        expectedVersion: 1,
        waitingOn: "us",
      }),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(codeOf(res)).toBe("no_trigger");
    }
    expect(await boardRows(opsId)).toEqual(before);
    expect(await refusedAudit("no_trigger")).toMatchObject({
      actor_kind: "system",
      agent_id: null,
      user_id: null,
      result: "denied",
      metadata: { route: "update", reason: "no_trigger" },
    });
  });

  it("a text channel's turn: 403 not_in_turn on every route, uncounted; a forged board tool on a text turn is 400 not_a_board", async () => {
    const msg = await ok(
      victor.request("POST", `/api/v1/conversations/${generalId}/messages`, {
        body: "@clerk add a card please",
      }),
    );
    const text = await deliveredFor(clerkId, msg.id as string);
    const before = await boardRows(opsId);
    for (const res of [
      await createCard(text.eventId),
      await readBoard(text.eventId),
      await patchCard(text.eventId, target.messageId, { expectedVersion: 1, waitingOn: "us" }),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(codeOf(res)).toBe("not_in_turn");
    }
    expect(await toolCalls(text.eventId)).toBe(0);
    expect(await refusedAudit("not_in_turn")).toMatchObject({
      actor_kind: "agent",
      agent_id: clerkId,
      user_id: victorId,
      resource_id: generalId,
    });

    // Defence in depth: even a turn row listing the tool cannot act outside a board.
    const forged = randomUUID();
    await su.query(
      `insert into app.agent_turns (event_id, organization_id, agent_id, user_id, conversation_id, conversation_kind, message_id, tools)
       values ($1, $2, $3, $4, $5, 'channel', $6, $7)`,
      [forged, orgId, clerkId, victorId, generalId, msg.id, ["ocw_board_card"]],
    );
    const res = await createCard(forged);
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe("not_a_board");
    // Refused by the turn gate, before the call is counted.
    expect(await toolCalls(forged)).toBe(0);
    expect(await boardRows(opsId)).toEqual(before);
    expect(await refusedAudit("not_a_board")).toMatchObject({ result: "denied", resource_id: generalId });
  });

  it("a turn that read web output (tainted through /tool-calls) can no longer change the board: 403 tainted", async () => {
    await ok(victor.request("PATCH", `/api/v1/agents/${clerkId}/capabilities`, { internet: true }));
    try {
      const { ev: webTurn } = await cardTurn(victor, opsId, "Supplier price list?\n@clerk look it up");
      expect(webTurn.turn.tools).toContain("web_search");
      const gated = await cell("POST", "/tool-calls", {
        eventId: webTurn.eventId,
        agentId: clerkId,
        tool: "web_search",
        params: { query: "valve supplier" },
      });
      expect(gated.body).toMatchObject({ allowed: true });
      const before = await boardRows(opsId);
      for (const res of [
        await createCard(webTurn.eventId),
        await patchCard(webTurn.eventId, target.messageId, { expectedVersion: 1, waitingOn: "us" }),
        await readBoard(webTurn.eventId),
      ]) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(codeOf(res)).toBe("tainted");
      }
      expect(await boardRows(opsId)).toEqual(before);
      expect(await refusedAudit("tainted")).toMatchObject({ agent_id: clerkId, user_id: victorId });
    } finally {
      await ok(victor.request("PATCH", `/api/v1/agents/${clerkId}/capabilities`, { internet: false }));
    }
  });

  it("07.16 D-20: a turn that read a Work Zone session's output can no longer change the board: 403 tainted", async () => {
    const { ev } = await cardTurn(victor, opsId, "Valve order\n@clerk check the session");
    await su.query("update app.agent_turns set session_output_read = true where event_id = $1", [ev.eventId]);
    const before = await boardRows(opsId);
    for (const res of [
      await createCard(ev.eventId),
      await patchCard(ev.eventId, target.messageId, { expectedVersion: 1, waitingOn: "us" }),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(codeOf(res)).toBe("tainted");
    }
    expect(await boardRows(opsId)).toEqual(before);
    expect(await toolCalls(ev.eventId)).toBe(0);
  });

  it("the ninth counted call of a turn is refused (403 cap_reached) and creates nothing", async () => {
    const { ev: busy } = await cardTurn(victor, opsId, "Inventory count\n@clerk keep an eye on it");
    for (let i = 0; i < 8; i++) expect((await readBoard(busy.eventId)).status).toBe(200);
    const before = await boardRows(opsId);
    const res = await createCard(busy.eventId);
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe("cap_reached");
    expect(await toolCalls(busy.eventId)).toBe(8);
    expect(await boardRows(opsId)).toEqual(before);
    expect(await refusedAudit("cap_reached")).toMatchObject({ agent_id: clerkId, user_id: victorId });
  });

  it("an archived board: create and move are 410 channel_archived and change nothing; the board still reads", async () => {
    const shelf = await createBoard(victor, "shelf", { visibility: "public" });
    await addAgent(shelf, clerkId);
    const { card, ev: shelfTurn } = await cardTurn(victor, shelf, "Old order\n@clerk archive check");
    await ok(victor.request("POST", `/api/v1/channels/${shelf}/archive`));
    const before = await boardRows(shelf);
    for (const res of [
      await createCard(shelfTurn.eventId),
      await patchCard(shelfTurn.eventId, card.messageId, { expectedVersion: 1, waitingOn: "us" }),
    ]) {
      expect(res.status, JSON.stringify(res.body)).toBe(410);
      expect(codeOf(res)).toBe("channel_archived");
    }
    expect(await boardRows(shelf)).toEqual(before);
    expect((await readBoard(shelfTurn.eventId)).status).toBe(200);
    expect(await refusedAudit("channel_archived")).toMatchObject({ result: "denied", resource_id: shelf });
  });

  it("a stale expectedVersion is 409 board_card_version_conflict carrying the current card", async () => {
    const moved = await ok(
      victor.request("PATCH", `/api/v1/boards/${opsId}/cards/${target.messageId}`, {
        expectedVersion: target.version,
        waitingOn: "both",
      }),
    );
    const before = await boardRows(opsId);
    const res = await patchCard(ev.eventId, target.messageId, {
      expectedVersion: target.version,
      move: { columnId: columns.done, afterCardId: null },
    });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("board_card_version_conflict");
    expect(res.body.error.details.card).toEqual(moved);
    expect(await boardRows(opsId)).toEqual(before);
    expect(await refusedAudit("board_card_version_conflict")).toMatchObject({
      metadata: { route: "update", messageId: target.messageId },
    });
  });

  it("a card of another board, a text-channel message or org B's card: 404 card_not_in_board; nothing changes", async () => {
    const elsewhere = await createBoard(victor, "elsewhere", { visibility: "public" });
    const foreignCard = await humanCard(victor, elsewhere, "Card on another board");
    const message = await ok(
      victor.request("POST", `/api/v1/conversations/${generalId}/messages`, { body: "plain message" }),
    );
    const before = { ops: await boardRows(opsId), elsewhere: await boardRows(elsewhere) };
    for (const messageId of [foreignCard.messageId, message.id, orgBCard.messageId, randomUUID()]) {
      const res = await patchCard(ev.eventId, messageId, { expectedVersion: 1, waitingOn: "customer" });
      expect(res.status, messageId).toBe(404);
      expect(codeOf(res)).toBe("card_not_in_board");
    }
    expect({ ops: await boardRows(opsId), elsewhere: await boardRows(elsewhere) }).toEqual(before);
    const orgB = (
      await su.query("select version, waiting_on from app.board_cards where message_id = $1", [
        orgBCard.messageId,
      ])
    ).rows[0];
    expect(orgB).toEqual({ version: 1, waiting_on: "none" });
    expect(await refusedAudit("card_not_in_board")).toMatchObject({ result: "denied" });
  });

  it("a column of another board is 400 invalid_column on create and move", async () => {
    const elsewhere = await createBoard(victor, "elsewhere-2", { visibility: "public" });
    const columnId = await firstColumn(elsewhere);
    const before = await boardRows(opsId);
    const created = await createCard(ev.eventId, { columnId });
    const current = (await snapshot(victor, opsId)).cards
      .flatMap((c: Json) => c.cards as Json[])
      .find((c: Json) => c.messageId === target.messageId) as Json;
    const moved = await patchCard(ev.eventId, target.messageId, {
      expectedVersion: current.version,
      move: { columnId, afterCardId: null },
    });
    for (const res of [created, moved]) {
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(codeOf(res)).toBe("invalid_column");
    }
    expect(await boardRows(opsId)).toEqual(before);
  });

  it("an agent body naming card text is 403 not_author (P-03); agents only move and set the waiting state", async () => {
    const { ev: editTurn } = await cardTurn(victor, opsId, "Label printer jams\n@clerk retitle it");
    const before = await boardRows(opsId);
    for (const text of [{ title: "Renamed" }, { description: "New text" }, { fields: {} }] as Json[]) {
      const res = await patchCard(editTurn.eventId, target.messageId, {
        expectedVersion: 99,
        waitingOn: "us",
        ...text,
      });
      expect(res.status, JSON.stringify(text)).toBe(403);
      expect(codeOf(res)).toBe("not_author");
    }
    expect(await boardRows(opsId)).toEqual(before);
    expect(await refusedAudit("not_author")).toMatchObject({ agent_id: clerkId, user_id: victorId });
  });

  it("confused deputy: once the turn's human left a private board, the agent can neither read, create nor move there", async () => {
    const hr = await createBoard(victor, "hr-cases", { visibility: "private" });
    await addAgent(hr, clerkId);
    await ok(victor.request("POST", `/api/v1/channels/${hr}/members`, { kind: "user", id: alexId }));
    const { card, ev: alexTurn } = await cardTurn(alex, hr, "Laptop request\n@clerk order it");
    expect(alexTurn.turn.tools).toContain("ocw_board_card");
    await ok(victor.request("DELETE", `/api/v1/channels/${hr}/members/user/${alexId}`));
    const before = await boardRows(hr);
    const writes = [
      await createCard(alexTurn.eventId),
      await patchCard(alexTurn.eventId, card.messageId, { expectedVersion: 1, waitingOn: "us" }),
    ];
    for (const res of writes) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      // Alex no longer may post there, so neither may the agent acting for him.
      expect(res.body.error.details).toMatchObject({
        permission: "channel.post",
        layer: "resource",
        reason: "not_a_member",
      });
    }
    const read = await readBoard(alexTurn.eventId);
    expect(read.status).toBe(403);
    expect(read.body.error.details).toMatchObject({
      permission: "channel.read",
      layer: "resource",
      reason: "private_channel",
    });
    expect(await boardRows(hr)).toEqual(before);
    // Each is audited as the resolver's denial, with the agent as actor.
    const denied = (
      await su.query(
        `select actor_kind, metadata from app.audit_events where action = 'authz.denied' and organization_id = $1
          and resource_id like '/agent-channel/v1/board%' order by occurred_at desc limit 3`,
        [orgId],
      )
    ).rows as Json[];
    expect(denied).toHaveLength(3);
    for (const row of denied)
      expect(row).toMatchObject({ actor_kind: "agent", metadata: { layer: "resource" } });
  });

  it("a rule denying @clerk channel.post is 403 although the human could post; the board still reads", async () => {
    const ruleId = randomUUID();
    await su.query(
      `insert into app.permission_rules (id, organization_id, subject_kind, subject_id, permission, effect)
       values ($1, $2, 'agent', $3, 'channel.post', 'deny')`,
      [ruleId, orgId, clerkId],
    );
    try {
      const { ev: denied } = await cardTurn(victor, opsId, "Belt worn\n@clerk follow up");
      const before = await boardRows(opsId);
      const current = (await snapshot(victor, opsId)).cards
        .flatMap((c: Json) => c.cards as Json[])
        .find((c: Json) => c.messageId === target.messageId) as Json;
      for (const res of [
        await createCard(denied.eventId),
        await patchCard(denied.eventId, target.messageId, {
          expectedVersion: current.version,
          waitingOn: "us",
        }),
      ]) {
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error.details).toMatchObject({ permission: "channel.post", ruleId });
      }
      expect(await boardRows(opsId)).toEqual(before);
      expect((await readBoard(denied.eventId)).status).toBe(200);
      // The human's own rights are untouched.
      await humanCard(victor, opsId, "Víctor can still post");
    } finally {
      await su.query("delete from app.permission_rules where id = $1", [ruleId]);
    }
  });

  it("every refusal above is audited as denied, with ids and reasons only", async () => {
    const rows = await audits("agent.board.refused");
    const reasons = new Set(rows.map((a) => a.metadata.reason as string));
    for (const reason of [
      "no_trigger",
      "not_in_turn",
      "not_a_board",
      "tainted",
      "cap_reached",
      "channel_archived",
      "board_card_version_conflict",
      "card_not_in_board",
      "invalid_column",
      "not_author",
    ]) {
      expect(reasons, reason).toContain(reason);
    }
    for (const a of rows) {
      expect(a.result).toBe("denied");
      const text = JSON.stringify(a.metadata);
      for (const secret of ["Order spare", "Renamed", "New text", "valve supplier"])
        expect(text).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------------------------------- 07.17-08

/**
 * Phase 07.17 D-06 / D-12 (PD-11, ADR-0039, AFO-03): a bot moves and sets waiting on the card its automation opened, from
 * a turn in that card's thread, after outside content only when an admin set its Work Zone profile's
 * `actOnOutsideContent`. Seeded with the superuser: Víctor's device, @clerk's and @other's profiles, their fan-out
 * automations on #ops and the `automation_conversations` rows naming the cards they opened.
 */
const cardRow = async (messageId: string) =>
  (
    await su.query("select column_id, waiting_on, version from app.board_cards where message_id = $1", [
      messageId,
    ])
  ).rows[0] as { column_id: string; waiting_on: string; version: number };

const setOutsideContent = (agentId: string, on: boolean) =>
  su.query(
    `update app.bot_work_zone_profiles
        set act_on_outside_content = $2,
            act_on_outside_content_by = case when $2 then $3::uuid end,
            act_on_outside_content_at = case when $2 then now() end
      where agent_id = $1`,
    [agentId, on, victorId],
  );

type FanOut = { automationId: string; runId: string };

/** A fan-out automation of `agentId` on #ops (Backlog) and one Run now, both seeded. */
async function seedFanOut(agentId: string, name: string): Promise<FanOut> {
  const automationId = randomUUID();
  await su.query(
    `insert into app.automations (id, organization_id, name, agent_id, run_as_user_id, created_by, trigger_kind,
       schedule_cron, time_zone, target_kind, conversation_id, board_column_id, fan_out_enabled)
     values ($1, $2, $3, $4, $5, $5, 'schedule', '*/10 * * * *', 'Europe/Madrid', 'board', $6, $7, true)`,
    [automationId, orgId, name, agentId, victorId, opsId, columns.backlog],
  );
  const runId = randomUUID();
  await su.query(
    "insert into app.automation_runs (id, organization_id, automation_id, trigger) values ($1, $2, $3, 'manual')",
    [runId, orgId, automationId],
  );
  return { automationId, runId };
}

/** The `automation_conversations` row saying `fanOut`'s run opened `messageId` (the item key stored as a hash). */
const opened = (fanOut: FanOut, messageId: string) =>
  su.query(
    `insert into app.automation_conversations (organization_id, automation_id, run_id, external_key_hash, conversation_id,
       root_message_id, status) values ($1, $2, $3, $4, $5, $6, 'delivered')`,
    [orgId, fanOut.automationId, fanOut.runId, sha256Hex(randomUUID()), opsId, messageId],
  );

/** A reply by Víctor in `rootId`'s thread mentioning @clerk, and the turn it delivered. */
async function threadTurn(rootId: string, text = "@clerk the order shipped, move it"): Promise<Json> {
  const reply = await ok(
    victor.request("POST", `/api/v1/conversations/${opsId}/messages`, { body: text, threadRootId: rootId }),
  );
  return deliveredFor(clerkId, reply.id as string);
}

const taint = (eventId: string) =>
  su.query("update app.agent_turns set tainted = true where event_id = $1", [eventId]);

/** The latest `action` audit row of `messageId`. */
const cardAudit = async (action: string, messageId: string) =>
  (await audits(action)).filter((a) => a.metadata.messageId === messageId).at(-1);

const moveTo = async (eventId: string, messageId: string, columnId: string, extra: Json = {}) =>
  patchCard(eventId, messageId, {
    expectedVersion: (await cardRow(messageId)).version,
    move: { columnId, afterCardId: null },
    ...extra,
  });

let clerkFanOut: FanOut;
/** Card C: opened by @clerk's automation. */
let order: Json;

describe("07.17 D-06: a tainted turn moves the card its automation opened, with the profile's flag (Task 1)", () => {
  beforeAll(async () => {
    // Bot turns of every suite above count against @clerk's daily limit, which is not what this suite tests.
    await su.query("delete from app.agent_usage_daily");
    const deviceId = randomUUID();
    await su.query(
      "insert into app.devices (id, organization_id, owner_user_id, name, platform, token_hash) values ($1, $2, $3, 'mac', 'darwin', $4)",
      [deviceId, orgId, victorId, sha256Hex(randomUUID())],
    );
    for (const agentId of [clerkId, otherId]) {
      await su.query(
        "insert into app.bot_work_zone_profiles (organization_id, agent_id, sponsor_user_id, device_id, runtime, updated_by) values ($1, $2, $3, $4, 'claude-code', $3)",
        [orgId, agentId, victorId, deviceId],
      );
    }
    clerkFanOut = await seedFanOut(clerkId, "Open new orders");
    order = await humanCard(victor, opsId, "Order #1042: brake pads");
    await opened(clerkFanOut, order.messageId as string);
  });

  it("with actOnOutsideContent: move to In progress → 200, waiting on us → 200, both counted, audited outsideContent: true", async () => {
    await setOutsideContent(clerkId, true);
    const ev = await threadTurn(order.messageId as string);
    await taint(ev.eventId);
    const calls = await toolCalls(ev.eventId);

    const moved = await moveTo(ev.eventId, order.messageId, columns.inProgress);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.card).toMatchObject({ messageId: order.messageId, columnId: columns.inProgress });
    const waiting = await patchCard(ev.eventId, order.messageId, {
      expectedVersion: moved.body.card.version,
      waitingOn: "us",
    });
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(200);
    expect(await cardRow(order.messageId)).toMatchObject({ column_id: columns.inProgress, waiting_on: "us" });
    expect(await toolCalls(ev.eventId)).toBe(calls + 2);

    expect(await cardAudit("board.card.moved", order.messageId)).toMatchObject({
      actor_kind: "agent",
      agent_id: clerkId,
      user_id: victorId,
      metadata: { outsideContent: true, toColumnId: columns.inProgress },
    });
    expect(await cardAudit("board.card.updated", order.messageId)).toMatchObject({
      agent_id: clerkId,
      metadata: { outsideContent: true, waitingOnChanged: true },
    });
  });

  it("without actOnOutsideContent the same move is 403 tainted, the card unchanged and the call uncounted", async () => {
    await setOutsideContent(clerkId, false);
    const ev = await threadTurn(order.messageId as string, "@clerk it is delivered");
    await taint(ev.eventId);
    const before = await cardRow(order.messageId);
    const res = await moveTo(ev.eventId, order.messageId, columns.done);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res)).toBe("tainted");
    expect(await cardRow(order.messageId)).toEqual(before);
    expect(await toolCalls(ev.eventId)).toBe(0);
    expect(await refusedAudit("tainted")).toMatchObject({
      agent_id: clerkId,
      metadata: { route: "update", messageId: order.messageId },
    });
  });
});
