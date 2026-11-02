import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { startTestStorage, type TestStorage } from "../../testing-storage";

/**
 * 07.6-21 (AUTO-02; D-02, D-07, P-09, P-11; Pattern 6, Pitfalls 2 and 3): inbound items. Every webhook or mail item
 * becomes a deterministic post by the platform (a thread, a DM message or a board card) and, when asked, a read-only
 * (tainted) turn for the automation's bot; storms are capped and outside content is purged after 30 days. The
 * automations, mailboxes and endpoints are written directly (10 and 11 own their routes), like 06's tests. Real
 * PostgreSQL + Redis + pg-boss, the in-memory sandboxd and Garage (the side-effecting share reaches its taint check).
 */

let s: SandboxStack;
let storage: TestStorage;
let purchasingId: string;

const core = () => s.stack.built.core;
const drainInbound = () => core().jobs.drain("automation.inbound", { max: 200 });
const drainFire = () => core().jobs.drain("automation.fire", { max: 200 });

type Target =
  | { kind: "channel"; conversationId: string }
  | { kind: "thread"; conversationId: string; threadRootMessageId: string }
  | { kind: "dm" }
  | { kind: "board"; conversationId: string; columnId: string };

interface Source {
  automationId: string;
  kind: "mail" | "webhook";
  /** The mailbox or the webhook endpoint. */
  id: string;
}

const publicId = () =>
  Array.from({ length: 26 }, () => "0123456789abcdefghjkmnpqrstvwxyz"[Math.floor(Math.random() * 32)]).join(
    "",
  );

/** Víctor's mail or webhook automation as 05 stores it (run as him), with its mailbox or endpoint (11, 10). */
async function inboundAutomation(
  p: {
    kind?: "mail" | "webhook";
    name?: string;
    target?: Target;
    action?: "post" | "board_card";
    askBot?: boolean;
    config?: Json;
  } = {},
): Promise<Source> {
  const kind = p.kind ?? "mail";
  const target = p.target ?? { kind: "channel", conversationId: purchasingId };
  const automationId = (
    await s.su.query(
      `insert into app.automations (organization_id, name, agent_id, run_as_user_id, created_by, instructions,
         trigger_kind, target_kind, conversation_id, thread_root_message_id, board_column_id, inbound_action,
         inbound_ask_bot, inbound_config)
       values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [
        s.orgA,
        p.name ?? "Supplier inbox",
        s.scoutId,
        s.victorId,
        "Read new supplier orders and tell me what needs doing today.",
        kind,
        target.kind,
        target.kind === "dm" ? null : target.conversationId,
        target.kind === "thread" ? target.threadRootMessageId : null,
        target.kind === "board" ? target.columnId : null,
        p.action ?? "post",
        p.askBot ?? true,
        JSON.stringify(p.config ?? {}),
      ],
    )
  ).rows[0].id as string;
  const id =
    kind === "mail"
      ? ((
          await s.su.query(
            `insert into app.mailboxes (organization_id, automation_id, owner_user_id, host)
             values ($1, $2, $3, 'imap.shop.example') returning id`,
            [s.orgA, automationId, s.victorId],
          )
        ).rows[0].id as string)
      : ((
          await s.su.query(
            `insert into app.webhook_endpoints (organization_id, automation_id, public_id)
             values ($1, $2, $3) returning id`,
            [s.orgA, automationId, publicId()],
          )
        ).rows[0].id as string);
  return { automationId, kind, id };
}

/** What 10/11 store for an accepted item, and its ids-only `automation.inbound` job (same transaction there). */
async function receive(
  src: Source,
  e: {
    externalId?: string;
    threadKey?: string | null;
    subject?: string | null;
    sender?: string | null;
    bodyText?: string | null;
    bodyJson?: unknown;
    receivedAt?: string;
  } = {},
): Promise<string> {
  const eventId = (
    await s.su.query(
      `insert into app.automation_events (organization_id, source, webhook_endpoint_id, mailbox_id, external_id,
         thread_key, subject, sender, body_text, body_json, result, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'accepted', coalesce($11::timestamptz, now()))
       returning id`,
      [
        s.orgA,
        src.kind,
        src.kind === "webhook" ? src.id : null,
        src.kind === "mail" ? src.id : null,
        e.externalId ?? (src.kind === "mail" ? `<${randomUUID()}@shop.example>` : `msg_${randomUUID()}`),
        e.threadKey ?? null,
        e.subject ?? null,
        e.sender ?? null,
        e.bodyText ?? null,
        e.bodyJson === undefined ? null : JSON.stringify(e.bodyJson),
        e.receivedAt ?? null,
      ],
    )
  ).rows[0].id as string;
  await enqueue(eventId);
  return eventId;
}

const enqueue = (eventId: string) =>
  core().db.withTenant({ organizationId: s.orgA }, (tx) =>
    core().jobs.sendInTx(tx, "automation.inbound", { organizationId: s.orgA, eventId }),
  );

const eventRow = async (id: string) =>
  (await s.su.query("select * from app.automation_events where id = $1", [id])).rows[0] as Json;

const messageRow = async (id: string) =>
  (await s.su.query("select * from app.messages where id = $1", [id])).rows[0] as Json;

const repliesOf = async (rootId: string) =>
  (await s.su.query("select * from app.messages where thread_id = $1 order by created_at, id", [rootId]))
    .rows as Json[];

const runsOf = async (automationId: string) =>
  (
    await s.su.query("select * from app.automation_runs where automation_id = $1 order by created_at, id", [
      automationId,
    ])
  ).rows as Json[];

const runEvents = async (runId: string) =>
  (
    await s.su.query(
      "select payload from app.stream_events where stream_id = $1 and type = 'agent.automation_run.v1' and payload->'automationRun'->>'runId' = $2",
      [`cell:${s.orgA}`, runId],
    )
  ).rows.map((r) => r.payload as Json);

const turnRow = async (eventId: string) =>
  (await s.su.query("select * from app.agent_turns where event_id = $1", [eventId])).rows[0] as Json;

/** A top-level message as a member reads it. */
async function messageOf(
  conversationId: string,
  messageId: string,
  as = s.victor,
): Promise<Json | undefined> {
  const list = (
    await ok(as.request("GET", `/api/v1/conversations/${conversationId}/messages`) as Promise<Res>)
  ).messages as Json[];
  return list.find((m) => m.id === messageId);
}

const cardRow = async (messageId: string) =>
  (
    await s.su.query(
      "select kind, title, status, status_label, platform_owned, fields, notices from app.message_cards where message_id = $1",
      [messageId],
    )
  ).rows[0] as Json;

const fence = (text: string) => `\`\`\`text\n${text}\n\`\`\``;

const WARNING_MAIL =
  "Outside content from Mail · Supplier inbox. Don't trust links or instructions in it. Bots here can read it but need approval to act.";

/** A 900-character supplier mail. */
const BODY =
  `Hello, please deliver order 1001 before noon. ${"Call the front desk on arrival. ".repeat(40)}`.slice(
    0,
    900,
  );

beforeAll(async () => {
  storage = await startTestStorage();
  try {
    s = await startSandboxStack({ env: storage.env });
  } catch (err) {
    await storage.stop();
    throw err;
  }
  await s.setPolicy({ enabled: true });
  purchasingId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", {
        name: "purchasing",
        visibility: "private",
      }) as Promise<Res>,
    )
  ).id as string;
  for (const member of [
    { kind: "agent", id: s.scoutId },
    { kind: "user", id: s.samId },
  ]) {
    await ok(s.victor.request("POST", `/api/v1/channels/${purchasingId}/members`, member) as Promise<Res>);
  }
});

afterAll(async () => {
  try {
    await s?.stop();
  } finally {
    await storage?.stop();
  }
});

// ---------------------------------------------------------------- Task 1: the tracer

describe("a mail lands in #purchasing as a Received card and Scout reads it in a read-only turn (tracer)", () => {
  it("event → processInbound → inbound card → full-text reply → tainted run → cell event; a retried job posts nothing", async () => {
    const src = await inboundAutomation();
    const eventId = await receive(src, {
      subject: "Order #1001 · deliver before noon",
      sender: "orders@shop.example",
      bodyText: BODY,
    });
    expect(await drainInbound()).toBeGreaterThanOrEqual(1);

    const event = await eventRow(eventId);
    expect(event).toMatchObject({ result: "accepted", reason: null });
    const cardId = event.message_id as string;
    expect(cardId).toBeTruthy();

    // The platform's post: a top-level card by Scout in #purchasing.
    const root = await messageRow(cardId);
    expect(root).toMatchObject({
      conversation_id: purchasingId,
      thread_id: null,
      author_kind: "agent",
      author_id: s.scoutId,
    });
    const message = await messageOf(purchasingId, cardId);
    expect(message?.body).toBe(
      "Outside content received from Mail · Supplier inbox: Order #1001 · deliver before noon.",
    );
    const card = message?.card as Json;
    expect(card).toMatchObject({
      kind: "automation",
      platformOwned: true,
      title: "Order #1001 · deliver before noon",
      status: "info",
      statusLabel: "Received",
    });
    expect(card.notices[0]).toEqual({ tone: "warning", text: WARNING_MAIL });
    expect(card.fields.map((f: Json) => f.label)).toEqual(["From", "Received", "Via", "Message"]);
    expect(card.fields).toContainEqual({ label: "From", value: "orders@shop.example" });
    expect(card.fields).toContainEqual({ label: "Via", value: "Mail · Supplier inbox" });
    expect(card.fields).toContainEqual({ label: "Message", value: BODY.slice(0, 500).trim() });

    // The full text, fenced plain text, as the first reply.
    const replies = await repliesOf(cardId);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ author_kind: "agent", author_id: s.scoutId });
    expect(replies[0]?.body).toBe(`Full message\n\n${fence(BODY)}`);

    // One tainted run anchored on the card, fired by the runner like any run.
    const [run] = (await runsOf(src.automationId)) as [Json];
    expect(run).toMatchObject({
      trigger: "mail",
      status: "queued",
      tainted: true,
      inbound_event_id: eventId,
      anchor_message_id: cardId,
    });
    expect(await drainFire()).toBeGreaterThanOrEqual(1);
    const events = await runEvents(run.id);
    expect(events).toHaveLength(1);
    const ev = events[0] as Json;
    expect(ev.message).toMatchObject({
      id: cardId,
      text: "Task “Supplier inbox” for Víctor Ruiz, started by a mail.",
      author: { kind: "user", id: s.victorId },
    });
    expect(ev.thread.rootMessageId).toBe(cardId);
    expect(ev.automationRun).toMatchObject({
      automationId: src.automationId,
      runId: run.id,
      trigger: "mail",
      inbound: {
        source: "mail",
        title: "Order #1001 · deliver before noon",
        text: BODY,
        from: "orders@shop.example",
      },
    });
    expect((await turnRow(ev.eventId)).tainted).toBe(true);
    expect(((await runsOf(src.automationId))[0] as Json).status).toBe("delivered");

    // A retried job finds the item handled: nothing new is posted and no second run exists.
    await enqueue(eventId);
    expect(await drainInbound()).toBeGreaterThanOrEqual(1);
    const posted = (
      await s.su.query("select count(*)::int as n from app.messages where client_message_id in ($1, $2)", [
        `card:inbound:${eventId}`,
        `inbound:${eventId}:full`,
      ])
    ).rows[0] as Json;
    expect(posted.n).toBe(2);
    expect(await runsOf(src.automationId)).toHaveLength(1);
    expect((await eventRow(eventId)).message_id).toBe(cardId);
  });
});

// ---------------------------------------------------------------- Task 2: every action and follow-up

/** A private board channel with Scout in it and an `Intake` column; its id and the column's. */
async function intakeBoard(name: string): Promise<{ boardId: string; intake: string }> {
  const boardId = (
    await ok(
      s.victor.request("POST", "/api/v1/channels", {
        name,
        visibility: "private",
        layout: "board",
      }) as Promise<Res>,
    )
  ).id as string;
  await ok(
    s.victor.request("POST", `/api/v1/channels/${boardId}/members`, {
      kind: "agent",
      id: s.scoutId,
    }) as Promise<Res>,
  );
  const created = await s.victor.request("POST", `/api/v1/boards/${boardId}/columns`, {
    name: "Intake",
    category: "backlog",
  });
  expect([200, 201], JSON.stringify(created.body)).toContain(created.status);
  const columns = (await ok(s.victor.request("GET", `/api/v1/boards/${boardId}`) as Promise<Res>))
    .columns as Json[];
  const intake = columns.find((c) => c.name === "Intake")?.id as string;
  expect(intake).toBeTruthy();
  return { boardId, intake };
}

const dmsWith = async (userId: string, agentId: string) =>
  (
    await s.su.query(
      `select c.id from app.conversations c
       where c.kind = 'dm'
         and exists (select 1 from app.conversation_members m where m.conversation_id = c.id and m.member_kind = 'user' and m.member_id = $1)
         and exists (select 1 from app.conversation_members m where m.conversation_id = c.id and m.member_kind = 'agent' and m.member_id = $2)`,
      [userId, agentId],
    )
  ).rows.map((r) => r.id as string);

const ORDER_CONFIG = {
  titlePointer: "/order/name",
  bodyPointer: "/order/note",
  threadKeyPointer: "/order/id",
};
const order = (note: string) => ({ order: { name: "#1001", id: 450789, note } });

describe("every action lands right and follow-ups keep their conversation (P-11, R2)", () => {
  it("board: a card “#1001” in Intake by Scout for Víctor, the inbound card its first reply, Scout's turn in its thread; the same /order/id follows up in it", async () => {
    const { boardId, intake } = await intakeBoard("orders");
    const src = await inboundAutomation({
      kind: "webhook",
      name: "Shop orders",
      target: { kind: "board", conversationId: boardId, columnId: intake },
      action: "board_card",
      config: ORDER_CONFIG,
    });
    const first = await receive(src, { bodyJson: order("Deliver before noon") });
    await drainInbound();
    const event = await eventRow(first);
    const boardCardId = event.board_card_message_id as string;
    expect(boardCardId).toBeTruthy();
    expect(event).toMatchObject({ result: "accepted", thread_key: "450789" });

    const boardCard = (
      await s.su.query(
        "select column_id, title, description, external_ref from app.board_cards where message_id = $1",
        [boardCardId],
      )
    ).rows[0] as Json;
    expect(boardCard).toEqual({
      column_id: intake,
      title: "#1001",
      description: fence("Deliver before noon"),
      external_ref: "450789",
    });
    expect(await messageRow(boardCardId)).toMatchObject({
      author_kind: "agent",
      author_id: s.scoutId,
      thread_id: null,
    });
    const created = (
      await s.su.query(
        "select actor_kind, actor_id, user_id from app.audit_events where action = 'board.card.created' and resource_id = $1",
        [boardCardId],
      )
    ).rows as Json[];
    expect(created).toEqual([{ actor_kind: "agent", actor_id: s.scoutId, user_id: s.victorId }]);

    // The inbound card is the card's first (and, for a short text, only) reply.
    const replies = await repliesOf(boardCardId);
    expect(replies.map((r) => r.id)).toEqual([event.message_id]);
    expect(await cardRow(event.message_id)).toMatchObject({
      kind: "automation",
      title: "#1001",
      status_label: "Received",
      platform_owned: true,
    });
    const [run] = (await runsOf(src.automationId)) as [Json];
    expect(run).toMatchObject({ trigger: "webhook", tainted: true, board_card_message_id: boardCardId });
    await drainFire();
    const [ev] = (await runEvents(run.id)) as [Json];
    expect(ev.thread.rootMessageId).toBe(boardCardId);
    expect(ev.message.id).toBe(event.message_id);
    expect(ev.automationRun.inbound).toMatchObject({ source: "webhook", title: "#1001", from: null });
    expect((await turnRow(ev.eventId)).tainted).toBe(true);

    // The same /order/id again: a Follow-up card in the same card thread, no second board card.
    const second = await receive(src, { bodyJson: order("Actually, deliver after 3 PM") });
    await drainInbound();
    const followUp = await eventRow(second);
    expect(followUp).toMatchObject({ result: "accepted", board_card_message_id: boardCardId });
    expect(await messageRow(followUp.message_id)).toMatchObject({ thread_id: boardCardId });
    expect((await cardRow(followUp.message_id)).title).toBe("Follow-up: #1001");
    const cards = (
      await s.su.query("select count(*)::int as n from app.board_cards where conversation_id = $1", [boardId])
    ).rows[0] as Json;
    expect(cards.n).toBe(1);
  });

  it("mail follow-up: a mail whose References names the first mail continues its thread", async () => {
    const src = await inboundAutomation({ askBot: false });
    const first = await receive(src, {
      externalId: "<m1@shop.example>",
      threadKey: "<m1@shop.example>",
      subject: "Order #1002",
      sender: "orders@shop.example",
      bodyText: "Two boxes, please.",
    });
    await drainInbound();
    const rootId = (await eventRow(first)).message_id as string;
    expect(await messageRow(rootId)).toMatchObject({ conversation_id: purchasingId, thread_id: null });

    // 11 stores the first References id as the key.
    const reply = await receive(src, {
      externalId: "<m2@shop.example>",
      threadKey: "<m1@shop.example>",
      subject: "Re: Order #1002",
      sender: "orders@shop.example",
      bodyText: "Make it three.",
    });
    await drainInbound();
    const followUp = await eventRow(reply);
    expect(await messageRow(followUp.message_id)).toMatchObject({
      conversation_id: purchasingId,
      thread_id: rootId,
    });
    expect((await cardRow(followUp.message_id)).title).toBe("Follow-up: Re: Order #1002");

    // An unrelated mail starts its own thread.
    const other = await receive(src, {
      externalId: "<m3@shop.example>",
      threadKey: "<m3@shop.example>",
      subject: "Order #1003",
      bodyText: "One box.",
    });
    await drainInbound();
    expect(await messageRow((await eventRow(other)).message_id)).toMatchObject({ thread_id: null });
  });

  it("DM target: the card is a message in Víctor's DM with Scout, the full text flat after it, the turn in the DM", async () => {
    const src = await inboundAutomation({ target: { kind: "dm" } });
    const eventId = await receive(src, {
      subject: "Invoice 77",
      sender: "billing@vendor.example",
      bodyText: BODY,
    });
    await drainInbound();
    const dms = await dmsWith(s.victorId, s.scoutId);
    expect(dms).toHaveLength(1);
    const cardId = (await eventRow(eventId)).message_id as string;
    expect(await messageRow(cardId)).toMatchObject({ conversation_id: dms[0], thread_id: null });
    const after = (
      await s.su.query("select body, thread_id from app.messages where client_message_id = $1", [
        `inbound:${eventId}:full`,
      ])
    ).rows[0] as Json;
    expect(after).toEqual({ body: `Full message\n\n${fence(BODY)}`, thread_id: null });
    const [run] = (await runsOf(src.automationId)) as [Json];
    await drainFire();
    const [ev] = (await runEvents(run.id)) as [Json];
    expect(ev.conversation).toMatchObject({ id: dms[0], kind: "dm" });
    expect((await turnRow(ev.eventId)).tainted).toBe(true);
  });

  it("thread target: the card is a reply in the chosen thread", async () => {
    const root = (
      await ok(
        s.victor.request("POST", `/api/v1/conversations/${purchasingId}/messages`, {
          body: "Supplier mail goes here",
        }) as Promise<Res>,
      )
    ).id as string;
    const src = await inboundAutomation({
      target: { kind: "thread", conversationId: purchasingId, threadRootMessageId: root },
      askBot: false,
    });
    const eventId = await receive(src, { subject: "Order #1004", bodyText: "Pallets." });
    await drainInbound();
    expect(await messageRow((await eventRow(eventId)).message_id)).toMatchObject({ thread_id: root });
  });

  it("askBot off: the item is posted, and there is no run and no cell event", async () => {
    const src = await inboundAutomation({ askBot: false });
    const eventId = await receive(src, { subject: "FYI", bodyText: "Prices go up in November." });
    await drainInbound();
    const event = await eventRow(eventId);
    expect(event.message_id).toBeTruthy();
    expect(await runsOf(src.automationId)).toEqual([]);
    const cellEvents = (
      await s.su.query(
        "select count(*)::int as n from app.stream_events where stream_id = $1 and payload->'automationRun'->>'automationId' = $2",
        [`cell:${s.orgA}`, src.automationId],
      )
    ).rows[0] as Json;
    expect(cellEvents.n).toBe(0);
  });
});
