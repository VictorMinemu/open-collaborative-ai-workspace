import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type GreenMail, type GreenMailUser, startGreenMail } from "../../testing-mail";
import { type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { mailboxTick } from "./mailboxes";

/**
 * Names the egress guard resolves to a chosen address (it resolves with `node:dns/promises`, like the 07.4 keychain
 * proxy tests): `mail-tls.ocw.test` stands for a mail server on a private network, answered with a non-loopback
 * private address of this machine where GreenMail's ports are published. It is NOT an `OCW_EGRESS_TEST_HOSTS` name, so
 * it takes the production path: private refusal unless an admin allows the exact host:port, then implicit TLS.
 */
const dnsStub = vi.hoisted(() => new Map<string, string>());
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  const lookup = ((host: string, opts?: unknown) => {
    const address = dnsStub.get(host);
    if (address) return Promise.resolve([{ address, family: address.includes(":") ? 6 : 4 }]);
    return (real.lookup as (h: string, o?: unknown) => Promise<unknown>)(host, opts);
  }) as typeof real.lookup;
  return { ...real, default: { ...real, lookup }, lookup };
});

/**
 * 07.6-11 (AUTO-02; D-02, D-07, R3, R8, P-09, P-17; research Pattern 5, A3): IMAP mail as an automation trigger against
 * a disposable GreenMail (no real mail server). A mail automation signs in with a Keychain `Username & password` item
 * only, connects to the address the egress guard pinned, reads only new mail read-only, stores each mail once and hands
 * it to 21's inbound worker. Real PostgreSQL + Redis + pg-boss; jobs are drained in-process.
 */

let s: SandboxStack;
let gm: GreenMail;
let purchasingId: string;

const ADDRESSES = [
  "ops@acme.test",
  "dupes@acme.test",
  "threads@acme.test",
  "loops@acme.test",
  "noid@acme.test",
  "validity@acme.test",
  "tester@acme.test",
  "status@acme.test",
  "unreach@acme.test",
  "paused@acme.test",
  "gone@acme.test",
];

const core = () => s.stack.built.core;
const user = (address: string): GreenMailUser => {
  const u = gm.users.find((x) => x.address === address);
  if (!u) throw new Error(`no GreenMail user ${address}`);
  return u;
};

const audits = async (action: string, resourceId?: string) =>
  (
    await s.su.query(
      `select resource_id, user_id, actor_kind, result, metadata from app.audit_events
       where action = $1 and organization_id = $2 ${resourceId ? "and resource_id = $3" : ""} order by occurred_at`,
      resourceId ? [action, s.orgA, resourceId] : [action, s.orgA],
    )
  ).rows as Json[];

const mailboxRow = async (automationId: string) =>
  (await s.su.query("select * from app.mailboxes where automation_id = $1", [automationId])).rows[0] as
    | Json
    | undefined;

const eventsOf = async (mailboxId: string) =>
  (
    await s.su.query("select * from app.automation_events where mailbox_id = $1 order by created_at, id", [
      mailboxId,
    ])
  ).rows as Json[];

/** A personal `Username & password` key of `as` for a GreenMail account (allowed host `greenmail:<imap port>`). */
async function mailKey(
  address: string,
  p: { as?: SandboxStack["victor"]; name?: string; hosts?: string[]; password?: string } = {},
): Promise<string> {
  const u = user(address);
  return (
    await ok(
      (p.as ?? s.victor).request("POST", "/api/v1/keychain", {
        scope: "personal",
        kind: "basic",
        name: p.name ?? `Mailbox ${address}`,
        allowedHosts: p.hosts ?? [`greenmail:${gm.imapPort}`],
        username: u.login,
        password: p.password ?? u.password,
      }) as Promise<Res>,
      201,
    )
  ).id as string;
}

const mailbox = (vaultItemId: string, extra: Json = {}) => ({
  vaultItemId,
  host: "greenmail",
  port: gm.imapPort,
  folder: "INBOX",
  pollIntervalMinutes: 5,
  ...extra,
});

/** Víctor's mail automation into #purchasing (the Received card and a read-only turn for Scout). */
function createMailAutomation(vaultItemId: string, extra: Json = {}, as = s.victor) {
  return as.request("POST", "/api/v1/automations", {
    name: `Supplier inbox ${randomUUID().slice(0, 6)}`,
    agentId: s.scoutId,
    instructions: "Read new supplier orders and tell me what needs doing today.",
    trigger: { kind: "mail", mailbox: mailbox(vaultItemId, extra) },
    target: { kind: "channel", conversationId: purchasingId },
    inbound: { action: "post", askBot: true, config: {} },
  }) as Promise<Res>;
}

/** Makes the mailbox due, runs one tick and drains its poll job. */
async function pollNow(mailboxId: string): Promise<number> {
  await s.su.query("update app.mailboxes set next_poll_at = now() - interval '1 second' where id = $1", [
    mailboxId,
  ]);
  const queued = await mailboxTick(core());
  await core().jobs.drain("mailbox.poll", { max: 50 });
  return queued;
}

const drainInbound = () => core().jobs.drain("automation.inbound", { max: 100 });

/** The test's own IMAP session as `address` (plain IMAP to the container; never the product's code path). */
async function asMailUser<T>(address: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const u = user(address);
  const client = new ImapFlow({
    host: gm.host,
    port: gm.imapPort,
    secure: false,
    doSTARTTLS: false,
    auth: { user: u.login, pass: u.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

/** Flags of every message of `address`'s INBOX, read over raw IMAP by the test (EXAMINE: the read changes nothing). */
const flagsOf = (address: string): Promise<string[][]> =>
  asMailUser(address, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const out: string[][] = [];
      for await (const m of client.fetch("1:*", { flags: true })) out.push([...(m.flags ?? [])]);
      return out;
    } finally {
      lock.release();
    }
  });

/** A raw RFC 5322 message (lets a test leave out the Message-ID, which SMTP clients always add). */
const rawMail = (headers: Record<string, string>, body: string) =>
  `${Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

const appendTo = (address: string, folder: string, raw: string) =>
  asMailUser(address, async (client) => {
    await client.append(folder, raw);
  });

const send = (
  to: string,
  m: { subject?: string; text?: string; messageId?: string; headers?: Record<string, string> },
) =>
  gm.sendMail({
    from: "Shop Orders <orders@shop.example>",
    to,
    subject: m.subject ?? "Order 1001 · deliver before noon",
    text: m.text ?? "Hello, please deliver order 1001 before noon.",
    ...(m.messageId ? { messageId: m.messageId } : {}),
    ...(m.headers ? { headers: m.headers } : {}),
  });

beforeAll(async () => {
  gm = await startGreenMail({ users: ADDRESSES });
  try {
    s = await startSandboxStack({ env: { OCW_EGRESS_TEST_HOSTS: "greenmail=127.0.0.1" } });
  } catch (err) {
    await gm.stop();
    throw err;
  }
  await s.su.query(
    `insert into app.bot_policies (organization_id, max_automations_per_user) values ($1, 100)
     on conflict (organization_id) do update set max_automations_per_user = 100`,
    [s.orgA],
  );
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
    await gm?.stop();
  }
});

// ---------------------------------------------------------------- Task 1: the tracer

describe("a mail to ops@acme.test arrives as one item in #purchasing (tracer)", () => {
  it("Keychain item → mail automation → GreenMail inject → tick → poll → parse → event → inbound card; mail stays unseen", async () => {
    await send("ops@acme.test", { subject: "Old order", messageId: "<old-1@shop.example>" });
    const vaultItemId = await mailKey("ops@acme.test", { name: "Ops mailbox" });

    const created = await ok(createMailAutomation(vaultItemId), 201);
    const automationId = created.automation.id as string;
    expect(created.automation.trigger.mailbox).toMatchObject({
      vaultItemId,
      vaultItemName: "Ops mailbox",
      host: "greenmail",
      port: gm.imapPort,
      folder: "INBOX",
      pollIntervalMinutes: 5,
      status: "active",
    });
    // Only mail that arrives after the save is read: the cursor sits on the newest message (UIDNEXT − 1).
    const row = await mailboxRow(automationId);
    expect(row).toMatchObject({ owner_user_id: s.victorId, vault_item_id: vaultItemId, status: "active" });
    expect(Number(row?.last_uid)).toBe(1);
    expect(Number(row?.uid_validity)).toBeGreaterThan(0);
    const mailboxId = row?.id as string;
    const createdAudit = await audits("mailbox.created", mailboxId);
    expect(createdAudit).toHaveLength(1);
    expect(createdAudit[0]?.metadata).toEqual({
      mailboxId,
      automationId,
      vaultItemId,
      host: "greenmail",
      port: gm.imapPort,
      pollIntervalMinutes: 5,
    });

    await send("ops@acme.test", {
      subject: "Order #1001 · deliver before noon",
      text: "Hello, please deliver order 1001 before noon.",
      messageId: "<order-1001@shop.example>",
    });
    expect(await pollNow(mailboxId)).toBe(1);

    const events = await eventsOf(mailboxId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "mail",
      external_id: "<order-1001@shop.example>",
      thread_key: "<order-1001@shop.example>",
      subject: "Order #1001 · deliver before noon",
      sender: "Shop Orders <orders@shop.example>",
      result: "accepted",
      message_id: null,
    });
    expect(events[0]?.body_text).toContain("please deliver order 1001 before noon");

    expect(await drainInbound()).toBeGreaterThanOrEqual(1);
    const posted = (await eventsOf(mailboxId))[0] as Json;
    expect(posted.message_id).toBeTruthy();
    const card = (await s.su.query("select * from app.messages where id = $1", [posted.message_id]))
      .rows[0] as Json;
    expect(card).toMatchObject({ conversation_id: purchasingId, author_kind: "agent", author_id: s.scoutId });
    expect(card.body).toContain("Order #1001 · deliver before noon");

    const received = await audits("mail.received", mailboxId);
    expect(received.map((a) => a.metadata)).toEqual([
      { mailboxId, automationId, count: 1, skipped: 0, duplicates: 0 },
    ]);
    // Credentials never reach the audit trail.
    expect(JSON.stringify([...createdAudit, ...received])).not.toContain(user("ops@acme.test").password);

    const view = await ok(
      s.victor.request("GET", `/api/v1/automations/${automationId}/mailbox`) as Promise<Res>,
    );
    expect(view).toMatchObject({
      status: "active",
      lastNewCount: 1,
      lastErrorCode: null,
      vaultItemName: "Ops mailbox",
    });
    expect(view.lastPolledAt).toBeTruthy();

    // Read-only toward the mailbox: neither the old nor the new mail was marked seen.
    const flags = await flagsOf("ops@acme.test");
    expect(flags).toHaveLength(2);
    for (const f of flags) expect(f).not.toContain("\\Seen");
  });
});

// ---------------------------------------------------------------- Task 2: parsing, idempotency, threading, loops

describe("each mail is processed once, conversations stay threaded, automated mail cannot loop", () => {
  /** A fresh mail automation on `address` (its own Keychain key); returns the automation and mailbox ids. */
  async function automationOn(address: string, extra: Json = {}) {
    const vaultItemId = await mailKey(address);
    const created = await ok(createMailAutomation(vaultItemId, extra), 201);
    const automationId = created.automation.id as string;
    const row = await mailboxRow(automationId);
    return { automationId, mailboxId: row?.id as string, vaultItemId };
  }

  it("the same mail delivered twice (same Message-ID) is one event; the duplicate is counted", async () => {
    const { automationId, mailboxId } = await automationOn("dupes@acme.test");
    await send("dupes@acme.test", { subject: "Order 2001", messageId: "<order-2001@shop.example>" });
    await send("dupes@acme.test", { subject: "Order 2001", messageId: "<order-2001@shop.example>" });
    await pollNow(mailboxId);
    const events = await eventsOf(mailboxId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ external_id: "<order-2001@shop.example>", duplicate_count: 1 });
    expect((await audits("mail.received", mailboxId)).map((a) => a.metadata)).toEqual([
      { mailboxId, automationId, count: 1, skipped: 0, duplicates: 1 },
    ]);
    // Polling again reads nothing new.
    await pollNow(mailboxId);
    expect(await eventsOf(mailboxId)).toHaveLength(1);
    expect((await mailboxRow(automationId))?.last_new_count).toBe(0);
  });

  it("a reply carries the first mail's thread key and 21 posts it as a follow-up in the same thread", async () => {
    const { mailboxId } = await automationOn("threads@acme.test");
    await send("threads@acme.test", { subject: "Order 3001", messageId: "<order-3001@shop.example>" });
    await pollNow(mailboxId);
    await drainInbound();
    await send("threads@acme.test", {
      subject: "Re: Order 3001",
      text: "Update: the truck is late.",
      messageId: "<order-3001-re@shop.example>",
      headers: { "In-Reply-To": "<order-3001@shop.example>" },
    });
    await pollNow(mailboxId);
    await drainInbound();
    const [first, reply] = await eventsOf(mailboxId);
    expect(first).toMatchObject({ thread_key: "<order-3001@shop.example>" });
    expect(reply).toMatchObject({
      external_id: "<order-3001-re@shop.example>",
      thread_key: "<order-3001@shop.example>",
      result: "accepted",
    });
    const replyMessage = (
      await s.su.query("select thread_id, body from app.messages where id = $1", [reply?.message_id])
    ).rows[0] as Json;
    expect(replyMessage.thread_id).toBe(first?.message_id);
    expect(replyMessage.body).toContain("Follow-up");
  });

  it("auto-replies, bulk mail, mail from the mailbox itself and mail with our own header are skipped and counted", async () => {
    const { automationId, mailboxId } = await automationOn("loops@acme.test");
    await send("loops@acme.test", {
      messageId: "<ooo@shop.example>",
      headers: { "Auto-Submitted": "auto-replied" },
    });
    await send("loops@acme.test", { messageId: "<news@shop.example>", headers: { Precedence: "bulk" } });
    await gm.sendMail({
      from: "Ops <loops@acme.test>",
      to: "loops@acme.test",
      subject: "Sent by this mailbox",
      text: "self",
      messageId: "<self@acme.test>",
    });
    await send("loops@acme.test", {
      messageId: "<own@ocw.example>",
      headers: { "X-OCW-Automation-Run": randomUUID() },
    });
    await send("loops@acme.test", {
      messageId: "<human@shop.example>",
      headers: { "Auto-Submitted": "no" },
    });
    await pollNow(mailboxId);
    const events = await eventsOf(mailboxId);
    expect(events.map((e) => e.external_id)).toEqual(["<human@shop.example>"]);
    expect((await audits("mail.received", mailboxId)).map((a) => a.metadata)).toEqual([
      { mailboxId, automationId, count: 1, skipped: 4, duplicates: 0 },
    ]);
    // The cursor moved past the skipped mail: nothing is read again.
    await pollNow(mailboxId);
    expect(await eventsOf(mailboxId)).toHaveLength(1);
  });

  it("a mail without a Message-ID is keyed by its UIDVALIDITY:UID hash, idempotent across re-polls", async () => {
    const { mailboxId } = await automationOn("noid@acme.test");
    await appendTo(
      "noid@acme.test",
      "INBOX",
      rawMail(
        { From: "orders@shop.example", To: "noid@acme.test", Subject: "No id" },
        "An order without an id.",
      ),
    );
    await pollNow(mailboxId);
    const events = await eventsOf(mailboxId);
    expect(events).toHaveLength(1);
    expect(events[0]?.external_id).toMatch(/^uid:[0-9a-f]{64}$/);
    expect(events[0]?.thread_key).toBeNull();
    // The cursor goes back one message (a crashed poll that stored but did not advance): the same key, no new event.
    await s.su.query("update app.mailboxes set last_uid = last_uid - 1 where id = $1", [mailboxId]);
    await pollNow(mailboxId);
    const again = await eventsOf(mailboxId);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ external_id: events[0]?.external_id, duplicate_count: 1 });
  });

  it("a changed UIDVALIDITY (the folder recreated) resets the cursor to the newest message without reprocessing", async () => {
    await asMailUser("validity@acme.test", async (c) => {
      await c.mailboxCreate("Orders");
    });
    const { automationId, mailboxId } = await automationOn("validity@acme.test", { folder: "Orders" });
    const before = await mailboxRow(automationId);
    expect(before).toMatchObject({ status: "active", last_uid: "0" });
    await appendTo("validity@acme.test", "Orders", rawMail({ "Message-ID": "<v1@shop.example>" }, "first"));
    await pollNow(mailboxId);
    expect((await eventsOf(mailboxId)).map((e) => e.external_id)).toEqual(["<v1@shop.example>"]);
    const validity = (await mailboxRow(automationId))?.uid_validity as string;

    // GreenMail stamps UIDVALIDITY in seconds: the recreated folder must be at least one second younger.
    await new Promise((r) => setTimeout(r, 1_100));
    await asMailUser("validity@acme.test", async (c) => {
      await c.mailboxDelete("Orders");
      await c.mailboxCreate("Orders");
    });
    for (const id of ["v2", "v3"]) {
      await appendTo("validity@acme.test", "Orders", rawMail({ "Message-ID": `<${id}@shop.example>` }, id));
    }
    await pollNow(mailboxId);
    const reset = await mailboxRow(automationId);
    expect(reset?.uid_validity).not.toBe(validity);
    expect(reset).toMatchObject({ status: "active", last_uid: "2" });
    expect((await eventsOf(mailboxId)).map((e) => e.external_id)).toEqual(["<v1@shop.example>"]);

    await appendTo("validity@acme.test", "Orders", rawMail({ "Message-ID": "<v4@shop.example>" }, "fourth"));
    await pollNow(mailboxId);
    expect((await eventsOf(mailboxId)).map((e) => e.external_id)).toEqual([
      "<v1@shop.example>",
      "<v4@shop.example>",
    ]);
  });
});
