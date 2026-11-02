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

/** Flags of every message of `address`'s INBOX, read over raw IMAP by the test (EXAMINE: the read changes nothing). */
async function flagsOf(address: string): Promise<string[][]> {
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
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const out: string[][] = [];
      for await (const m of client.fetch("1:*", { flags: true })) out.push([...(m.flags ?? [])]);
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

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
