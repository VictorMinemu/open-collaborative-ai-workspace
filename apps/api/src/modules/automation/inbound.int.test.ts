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

const _cardRow = async (messageId: string) =>
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
