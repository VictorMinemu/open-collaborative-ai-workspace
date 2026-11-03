import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyAddress } from "../../lib/egress";
import { type GreenMail, type GreenMailUser, startGreenMail } from "../../testing-mail";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
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
 * The real parser, except that a mail whose subject holds `POISON` gets a U+0000 put back into its body after parsing:
 * it stands for any value the database still refuses once the parser has done its part (07.6 review A CR-01).
 */
vi.mock("./mail-parse", async (importOriginal) => {
  const real = await importOriginal<typeof import("./mail-parse")>();
  return {
    ...real,
    parseMail: async (...args: Parameters<typeof real.parseMail>) => {
      const m = await real.parseMail(...args);
      return m.subject.includes("POISON") ? { ...m, text: `${m.text}\u0000` } : m;
    },
  };
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
  "poison@acme.test",
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

/**
 * Víctor's mail automation into #purchasing (the Received card and a read-only turn for Scout). A save answers before
 * its baseline poll ends (MD-04); this waits for it, so a test sees the mailbox as the first poll left it.
 */
async function createMailAutomation(vaultItemId: string, extra: Json = {}, as = s.victor): Promise<Res> {
  const res = (await as.request("POST", "/api/v1/automations", {
    name: `Supplier inbox ${randomUUID().slice(0, 6)}`,
    agentId: s.scoutId,
    instructions: "Read new supplier orders and tell me what needs doing today.",
    trigger: { kind: "mail", mailbox: mailbox(vaultItemId, extra) },
    target: { kind: "channel", conversationId: purchasingId },
    inbound: { action: "post", askBot: true, config: {} },
  })) as Res;
  if (res.status === 201) {
    const automationId = (res.body as Json).automation.id as string;
    await vi.waitFor(async () => expect((await mailboxRow(automationId))?.last_polled_at).toBeTruthy(), {
      timeout: 15_000,
      interval: 50,
    });
  }
  return res;
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

  it("a mail with U+0000 (quoted-printable =00) is stored clean; one the database still refuses is skipped, the cursor advances and the code says so (CR-01)", async () => {
    const { automationId, mailboxId } = await automationOn("poison@acme.test");
    const qp = (subject: string, body: string) =>
      [
        "From: =?utf-8?Q?Sho=00p?= <orders@shop.example>",
        "To: poison@acme.test",
        `Subject: ${subject}`,
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        body,
        "",
      ].join("\r\n");
    await appendTo("poison@acme.test", "INBOX", qp("=?utf-8?Q?Order=00_3001?=", "Deliver=00 order 3001."));
    await appendTo("poison@acme.test", "INBOX", qp("POISON 3002", "Deliver order 3002."));
    await appendTo("poison@acme.test", "INBOX", qp("Order 3003", "Deliver order 3003."));
    await pollNow(mailboxId);

    const events = await eventsOf(mailboxId);
    expect(events.map((e) => e.subject)).toEqual(["Order 3001", "Order 3003"]);
    expect(events[0]).toMatchObject({
      body_text: "Deliver order 3001.",
      sender: "Shop <orders@shop.example>",
    });
    const row = await mailboxRow(automationId);
    // The cursor is past all three: the refused mail never blocks the mailbox again.
    expect(Number(row?.last_uid)).toBe(3);
    expect(row).toMatchObject({ status: "active", last_error_code: "mail_not_stored", last_new_count: 2 });
    expect((await audits("mail.received", mailboxId)).map((a) => a.metadata)).toEqual([
      { mailboxId, automationId, count: 2, skipped: 0, duplicates: 0, notStored: 1 },
    ]);

    // The next good poll clears the code.
    await appendTo("poison@acme.test", "INBOX", qp("Order 3004", "Deliver order 3004."));
    await pollNow(mailboxId);
    expect(await eventsOf(mailboxId)).toHaveLength(3);
    expect(await mailboxRow(automationId)).toMatchObject({ last_error_code: null, status: "active" });
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

// ---------------------------------------------------------------- Task 3: failures are safe and visible

/** A private (RFC 1918) address of this machine where GreenMail's published ports answer (bridge gateway / LAN). */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal && classifyAddress(a.address) === "private")?.address;

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const dueIds = async () =>
  new Set(
    (await s.su.query("select id from app.due_mailboxes(1000, now())")).rows.map((r) => r.id as string),
  );

describe("connections fail safely and visibly: fixed codes, verified TLS, no private hosts, clear statuses", () => {
  const tryIt = (body: Json, as = s.victor) =>
    as.request("POST", "/api/v1/mailboxes/test", body) as Promise<Res>;
  const testBody = (vaultItemId: string, extra: Json = {}) => ({
    vaultItemId,
    host: "greenmail",
    port: gm.imapPort,
    folder: "INBOX",
    ...extra,
  });

  // Each test starts with a fresh per-person budget for the test route (6 a minute, MD-03).
  beforeEach(async () => {
    const redis = core().bus.pub;
    for await (const keys of redis.scanIterator({ MATCH: "ocw:rl:*mbx-test:*", COUNT: 100 })) {
      if (keys.length > 0) await redis.del(keys);
    }
  });

  it("POST /mailboxes/test: 6 a minute per person and one at a time, so it is no port probe or lockout tool (07.6 review A MD-03)", async () => {
    const sockets = new Set<Socket>();
    const silent: Server = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as { port: number }).port;
    const key = await mailKey("tester@acme.test", { hosts: [`greenmail:${port}`] });
    const body = testBody(key, { port });
    // A server that accepts and never greets holds the first test…
    const first = tryIt(body);
    await vi.waitFor(() => expect(sockets.size).toBe(1), { timeout: 5_000, interval: 20 });
    // …and a second one from the same person is refused while it runs.
    const second = await tryIt(body);
    expect(second.status).toBe(409);
    expect(codeOf(second)).toBe("mailbox_test_in_progress");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    expect(await ok(first)).toEqual({ ok: false, code: "unreachable" });
    // Four more (a closed port answers at once) reach the budget of six; the seventh waits for the next minute.
    for (let i = 0; i < 4; i++) expect(await ok(tryIt(body))).toEqual({ ok: false, code: "unreachable" });
    const seventh = await tryIt(body);
    expect(seventh.status).toBe(429);
  });

  it("POST /mailboxes/test: the message count, nothing saved, audited without the password", async () => {
    for (const n of [1, 2]) await send("tester@acme.test", { messageId: `<t${n}@shop.example>` });
    const vaultItemId = await mailKey("tester@acme.test");
    const mailboxesBefore = Number((await s.su.query("select count(*) from app.mailboxes")).rows[0].count);
    expect(await ok(tryIt(testBody(vaultItemId)))).toEqual({ ok: true, messages: 2 });
    expect(Number((await s.su.query("select count(*) from app.mailboxes")).rows[0].count)).toBe(
      mailboxesBefore,
    );
    const tested = await audits("mailbox.tested", vaultItemId);
    expect(tested.at(-1)).toMatchObject({
      user_id: s.victorId,
      result: "success",
      metadata: { vaultItemId, host: "greenmail", port: gm.imapPort, code: null },
    });
    expect(JSON.stringify(tested)).not.toContain(user("tester@acme.test").password);
    const flags = await flagsOf("tester@acme.test");
    expect(flags).toHaveLength(2);
    for (const f of flags) expect(f).not.toContain("\\Seen");
  });

  it("wrong password → auth_failed, missing folder → folder_missing, closed port → unreachable, other port → host_not_allowed", async () => {
    const dead = await closedPort();
    const good = await mailKey("tester@acme.test", {
      hosts: [`greenmail:${gm.imapPort}`, `greenmail:${dead}`],
    });
    const wrong = await mailKey("tester@acme.test", { password: "not-the-password" });
    expect(await ok(tryIt(testBody(wrong)))).toEqual({ ok: false, code: "auth_failed" });
    expect(await ok(tryIt(testBody(good, { folder: "Nowhere" })))).toEqual({
      ok: false,
      code: "folder_missing",
    });
    expect(await ok(tryIt(testBody(good, { port: dead })))).toEqual({ ok: false, code: "unreachable" });
    expect(await ok(tryIt(testBody(good, { port: gm.imapsPort })))).toEqual({
      ok: false,
      code: "host_not_allowed",
    });
    expect((await audits("mailbox.tested", wrong)).at(-1)).toMatchObject({
      result: "error",
      metadata: { code: "auth_failed" },
    });
  });

  it("TLS through the production path: a private-network alias admitted by the admin's allowance fails on GreenMail's self-signed certificate; without the allowance it is never reached", async () => {
    if (!lanAddress)
      throw new Error("this host has no private IPv4 interface to stand in for a LAN mail server");
    const alias = "mail-tls.ocw.test";
    dnsStub.set(alias, lanAddress);
    const u = user("tester@acme.test");
    const unitKey = (
      await ok(
        s.victor.request("POST", "/api/v1/keychain", {
          scope: "unit",
          unitId: null,
          kind: "basic",
          name: "LAN mail",
          allowedHosts: [`${alias}:${gm.imapsPort}`],
          username: u.login,
          password: u.password,
        }) as Promise<Res>,
        201,
      )
    ).id as string;
    const body = { vaultItemId: unitKey, host: alias, port: gm.imapsPort, folder: "INBOX" };
    // Not an OCW_EGRESS_TEST_HOSTS name: a private address without the admin's allowance is refused before connecting.
    expect(await ok(tryIt(body))).toEqual({ ok: false, code: "unreachable" });
    await ok(
      s.victor.request("PUT", "/api/v1/keychain/private-hosts", {
        hosts: [`${alias}:${gm.imapsPort}`],
      }) as Promise<Res>,
    );
    try {
      // Admitted and connected over implicit TLS: the certificate is checked against the host name and refused.
      expect(await ok(tryIt(body))).toEqual({ ok: false, code: "certificate" });
    } finally {
      await ok(s.victor.request("PUT", "/api/v1/keychain/private-hosts", { hosts: [] }) as Promise<Res>);
    }
    expect(await ok(tryIt(body))).toEqual({ ok: false, code: "unreachable" });
  });

  it("a personal key's host that resolves to a private address is refused with no connection attempted", async () => {
    if (!lanAddress)
      throw new Error("this host has no private IPv4 interface to stand in for a LAN mail server");
    let connections = 0;
    const lan: Server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => lan.listen(0, lanAddress, resolve));
    const port = (lan.address() as { port: number }).port;
    try {
      dnsStub.set("imap.lan.ocw.test", lanAddress);
      const key = await mailKey("tester@acme.test", { hosts: [`imap.lan.ocw.test:${port}`] });
      expect(await ok(tryIt({ vaultItemId: key, host: "imap.lan.ocw.test", port, folder: "INBOX" }))).toEqual(
        {
          ok: false,
          code: "unreachable",
        },
      );
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => lan.close(() => resolve()));
    }
  });

  it("another member's personal key is 403; a body with credentials is 400; creating with a host the key does not allow or a key the owner cannot use is 400 and leaves nothing", async () => {
    const victorKey = await mailKey("tester@acme.test");
    const asSam = await tryIt(testBody(victorKey), s.sam);
    expect(asSam.status).toBe(403);
    expect(codeOf(asSam)).toBe("mailbox_key_not_usable");
    const withPassword = await tryIt({ ...testBody(victorKey), password: "x" });
    expect(withPassword.status).toBe(400);

    const count = async () =>
      Number((await s.su.query("select count(*) from app.automations")).rows[0].count);
    const before = await count();
    const wrongHost = await createMailAutomation(victorKey, { port: gm.imapsPort });
    expect(wrongHost.status).toBe(400);
    expect(codeOf(wrongHost)).toBe("mailbox_host_not_allowed");
    const samKey = await mailKey("tester@acme.test", { as: s.sam });
    const notHis = await createMailAutomation(samKey);
    expect(notHis.status).toBe(400);
    expect(codeOf(notHis)).toBe("mailbox_key_not_usable");
    expect(await count()).toBe(before);
  });

  it("saving answers before the mail server does: the baseline poll runs after the response (07.6 review A MD-04)", async () => {
    const sockets = new Set<Socket>();
    const silent: Server = createServer((socket) => {
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as { port: number }).port;
    try {
      const key = await mailKey("tester@acme.test", { hosts: [`greenmail:${port}`] });
      const started = Date.now();
      const res = await s.victor.request("POST", "/api/v1/automations", {
        name: `Silent inbox ${randomUUID().slice(0, 6)}`,
        agentId: s.scoutId,
        instructions: "Read new supplier orders.",
        trigger: { kind: "mail", mailbox: mailbox(key, { port }) },
        target: { kind: "channel", conversationId: purchasingId },
        inbound: { action: "post", askBot: true, config: {} },
      });
      expect(res.status).toBe(201);
      // The server never greets: the old after-commit baseline held the response for its 10 s greeting timeout.
      expect(Date.now() - started).toBeLessThan(3_000);
      const automationId = (res.body as Json).automation.id as string;
      // The baseline is still talking to the server; ending its socket ends it, recorded like any poll.
      await vi.waitFor(() => expect(sockets.size).toBe(1), { timeout: 5_000, interval: 20 });
      for (const socket of sockets) socket.destroy();
      await vi.waitFor(
        async () => expect(await mailboxRow(automationId)).toMatchObject({ status: "unreachable" }),
        { timeout: 15_000, interval: 100 },
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("a wrong password at poll: auth_failed, backs off 30 minutes, audited once; a new password in Keychain resumes it", async () => {
    const key = await mailKey("status@acme.test", { password: "an-old-password" });
    const created = await ok(createMailAutomation(key), 201);
    const automationId = created.automation.id as string;
    const row = await mailboxRow(automationId);
    const mailboxId = row?.id as string;
    expect(row).toMatchObject({ status: "auth_failed", last_error_code: "auth_failed", last_uid: null });
    expect(new Date(row?.next_poll_at).getTime()).toBeGreaterThanOrEqual(Date.now() + 29 * 60_000);
    const failed = await audits("mailbox.poll_failed", mailboxId);
    expect(failed.map((a) => a.metadata)).toEqual([
      {
        mailboxId,
        automationId,
        host: "greenmail",
        port: gm.imapPort,
        status: "auth_failed",
        code: "auth_failed",
      },
    ]);
    expect(failed[0]).toMatchObject({ actor_kind: "system", user_id: s.victorId, result: "error" });
    const view = await ok(
      s.victor.request("GET", `/api/v1/automations/${automationId}/mailbox`) as Promise<Res>,
    );
    expect(view).toMatchObject({ status: "auth_failed", lastErrorCode: "auth_failed" });
    expect(await dueIds()).not.toContain(mailboxId);

    // The owner fixes the password in Keychain: the next tick polls it at once (no 30-minute wait).
    await ok(
      s.victor.request("PATCH", `/api/v1/keychain/${key}`, {
        secret: {
          kind: "basic",
          username: user("status@acme.test").login,
          password: user("status@acme.test").password,
        },
      }) as Promise<Res>,
    );
    expect(await dueIds()).toContain(mailboxId);
    await mailboxTick(core());
    await core().jobs.drain("mailbox.poll", { max: 50 });
    expect(await mailboxRow(automationId)).toMatchObject({
      status: "active",
      last_error_code: null,
      last_uid: "0",
    });
    expect(await dueIds()).not.toContain(mailboxId);

    await send("status@acme.test", { messageId: "<after-fix@shop.example>" });
    await pollNow(mailboxId);
    expect((await eventsOf(mailboxId)).map((e) => e.external_id)).toEqual(["<after-fix@shop.example>"]);
    expect(await audits("mailbox.poll_failed", mailboxId)).toHaveLength(1);
  });

  it("unreachable keeps trying at the interval and is audited on the change only", async () => {
    const dead = await closedPort();
    const key = await mailKey("unreach@acme.test", { hosts: [`greenmail:${dead}`] });
    const created = await ok(createMailAutomation(key, { port: dead }), 201);
    const automationId = created.automation.id as string;
    const row = await mailboxRow(automationId);
    const mailboxId = row?.id as string;
    expect(row).toMatchObject({ status: "unreachable", last_error_code: "unreachable" });
    const next = new Date(row?.next_poll_at).getTime() - Date.now();
    expect(next).toBeGreaterThan(4 * 60_000);
    expect(next).toBeLessThanOrEqual(5 * 60_000);
    await pollNow(mailboxId);
    expect(await mailboxRow(automationId)).toMatchObject({ status: "unreachable" });
    expect(await audits("mailbox.poll_failed", mailboxId)).toHaveLength(1);
    const view = await ok(
      s.victor.request("GET", `/api/v1/automations/${automationId}/mailbox`) as Promise<Res>,
    );
    expect(view).toMatchObject({ status: "unreachable", host: "greenmail", port: dead });
  });

  it("pausing the automation shows the mailbox paused and stops polling; resuming polls again", async () => {
    const key = await mailKey("paused@acme.test");
    const created = await ok(createMailAutomation(key), 201);
    const automationId = created.automation.id as string;
    const mailboxId = (await mailboxRow(automationId))?.id as string;
    await ok(s.victor.request("POST", `/api/v1/automations/${automationId}/pause`) as Promise<Res>);
    const view = await ok(
      s.victor.request("GET", `/api/v1/automations/${automationId}/mailbox`) as Promise<Res>,
    );
    expect(view.status).toBe("paused");
    await s.su.query("update app.mailboxes set next_poll_at = now() - interval '1 second' where id = $1", [
      mailboxId,
    ]);
    expect(await dueIds()).not.toContain(mailboxId);
    // A poll job that was already queued does nothing while paused.
    await send("paused@acme.test", { messageId: "<while-paused@shop.example>" });
    await core().db.withTenant({ organizationId: s.orgA }, (tx) =>
      core().jobs.sendInTx(tx, "mailbox.poll", { organizationId: s.orgA, mailboxId }),
    );
    await core().jobs.drain("mailbox.poll", { max: 50 });
    expect(await eventsOf(mailboxId)).toHaveLength(0);

    await ok(s.victor.request("POST", `/api/v1/automations/${automationId}/resume`) as Promise<Res>);
    expect(await dueIds()).toContain(mailboxId);
    await pollNow(mailboxId);
    expect((await eventsOf(mailboxId)).map((e) => e.external_id)).toEqual(["<while-paused@shop.example>"]);
    expect(
      (await ok(s.victor.request("GET", `/api/v1/automations/${automationId}/mailbox`) as Promise<Res>))
        .status,
    ).toBe("active");
  });

  it("deleting the automation deletes its mailbox (audited); a queued poll for it is a no-op", async () => {
    const key = await mailKey("gone@acme.test");
    const created = await ok(createMailAutomation(key), 201);
    const automationId = created.automation.id as string;
    const mailboxId = (await mailboxRow(automationId))?.id as string;
    const jobId = await core().db.withTenant({ organizationId: s.orgA }, (tx) =>
      core().jobs.sendInTx(tx, "mailbox.poll", { organizationId: s.orgA, mailboxId }),
    );
    const del = await s.victor.request("DELETE", `/api/v1/automations/${automationId}`);
    expect(del.status).toBe(204);
    expect(await mailboxRow(automationId)).toBeUndefined();
    expect((await audits("mailbox.deleted", mailboxId)).map((a) => a.metadata)).toEqual([
      { mailboxId, automationId, host: "greenmail", port: gm.imapPort },
    ]);
    await core().jobs.drain("mailbox.poll", { max: 50 });
    const job = (await s.su.query("select state from pgboss.job where id = $1", [jobId])).rows[0] as Json;
    expect(job.state).toBe("completed");
    const notFound = await s.victor.request("GET", `/api/v1/automations/${automationId}/mailbox`);
    expect(notFound.status).toBe(404);
  });
});
