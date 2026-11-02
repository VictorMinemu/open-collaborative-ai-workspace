import type { Automation, Mailbox, VaultItem, WebhookDelivery, WebhookEndpoint } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  curlExample,
  deliveryView,
  EMPTY_INBOUND,
  EMPTY_MAILBOX,
  effectiveInboundAction,
  graceText,
  inboundErrors,
  inboundOf,
  liveValueText,
  mailboxConfigOf,
  mailboxErrors,
  mailboxStatusLine,
  mailboxTestText,
  mailHostAllowed,
  pointerError,
  rejectionNotice,
  secretSetText,
  triggerKeys,
} from "@/lib/automation-trigger-queries";
import { keychainKeys } from "@/lib/keychain-queries";
import { InboundMapping } from "./inbound-mapping";
import { MailboxPanel } from "./mailbox-panel";
import { TriggerStep } from "./trigger-step";
import { WebhookEndpointPanel } from "./webhook-endpoint-panel";

/**
 * The trigger UI (07.6-18, AUTO-02, D-02, D-07, R3, R4, R8, UI-SPEC Surfaces 2-4): JSON-pointer mapping with live
 * values, the rejection notice, the deliveries' lines, the mailbox test results and statuses, the What happens rules,
 * and the secrecy of the panels. Static markup in node; the browser flows are in e2e/tests/automation-triggers.spec.ts.
 */

const ID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const CONV = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
const ME = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e61";
const MSG = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e62";
const KEY = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e63";
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function render(node: ReactNode, seed?: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["me"], { user: { id: ME, name: "Víctor Ruiz" }, organization: { id: ID } });
  seed?.(qc);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const delivery = (patch: Partial<WebhookDelivery>): WebhookDelivery => ({
  id: MSG,
  receivedAt: ago(3),
  result: "accepted",
  reason: null,
  duplicateCount: 0,
  link: null,
  ...patch,
});

const endpoint = (patch: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  publicId: "7QK2M9XW4R7QK2M9XW4R7QK2M9",
  url: "https://ocw.acme.com/api/v1/hooks/7QK2M9XW4R7QK2M9XW4R7QK2M9",
  secretSetAt: "2026-10-08T12:00:00.000Z",
  previousValidUntil: null,
  lastRejectedAt: null,
  lastRejectedReason: null,
  deliveries: [],
  lastPayload: null,
  ...patch,
});

const mailbox = (patch: Partial<Mailbox> = {}): Mailbox => ({
  vaultItemId: KEY,
  vaultItemName: "Ops mailbox",
  host: "imap.acme.com",
  port: 993,
  folder: "INBOX",
  pollIntervalMinutes: 10,
  status: "active",
  lastPolledAt: ago(3),
  lastNewCount: 2,
  lastErrorCode: null,
  ...patch,
});

function automation(patch: Partial<Automation> = {}): Automation {
  return {
    id: ID,
    name: "Shopify orders",
    actionKind: "agent_turn",
    agent: { id: ID, displayName: "Ops helper", personal: false },
    runAs: { id: ME, displayName: "Víctor Ruiz" },
    instructions: "Read each order.",
    trigger: {
      kind: "webhook",
      schedule: null,
      webhook: { publicId: "7QK2M9XW4R7QK2M9XW4R7QK2M9", url: "https://ocw.acme.com/api/v1/hooks/x" },
      mailbox: null,
    },
    target: { kind: "board", conversationId: CONV, columnId: CONV, label: "orders board · Intake" },
    inbound: { action: "board_card", askBot: true, config: {} },
    maxRunsPerDay: 24,
    status: "active",
    pausedBy: null,
    pausedAt: null,
    consecutiveFailures: 0,
    nextRunAt: null,
    lastRun: null,
    inboundToday: 0,
    version: 1,
    createdAt: ago(60),
    updatedAt: ago(60),
    viewerCan: ["edit", "run", "pause", "delete"],
    ...patch,
  };
}

function basicKey(patch: Partial<VaultItem> = {}): VaultItem {
  return {
    id: KEY,
    scope: "personal",
    unitId: null,
    ownerUserId: ME,
    name: "Ops mailbox",
    handle: "ops_mailbox",
    kind: "basic",
    injection: { header: "Authorization", scheme: "basic" },
    allowedHosts: ["imap.acme.com"],
    allowedPathPrefix: null,
    tokenUrl: null,
    hasValue: true,
    valueUpdatedAt: ago(60),
    agentIds: [],
    createdAt: ago(60),
    updatedAt: ago(60),
    lastUsedAt: null,
    ...patch,
  } as VaultItem;
}

describe("JSON-pointer mapping (UI-SPEC Surface 3)", () => {
  it("accepts RFC 6901 pointers and words a bad one", () => {
    expect(pointerError("")).toBe(null);
    expect(pointerError("  ")).toBe(null);
    expect(pointerError("/order/name")).toBe(null);
    expect(pointerError("/a~0b/~1c/0")).toBe(null);
    expect(pointerError("order/name")).toBe("Use a JSON pointer like /order/name");
    expect(pointerError("/a~2")).toBe("Use a JSON pointer like /order/name");
    expect(inboundErrors({ ...EMPTY_INBOUND, titlePointer: "name", bodyPointer: "/ok" })).toEqual({
      titlePointer: "Use a JSON pointer like /order/name",
    });
  });

  it("live values: plain text in curly quotes, at most 80 characters, `no value` when nothing is there", () => {
    const payload = { order: { name: "#1001", id: 450789, note: "x".repeat(100), empty: null, tags: ["a"] } };
    expect(liveValueText(payload, "/order/name")).toBe("“#1001”");
    expect(liveValueText(payload, "/order/id")).toBe("“450789”");
    expect(liveValueText(payload, "/order/tags")).toBe('“["a"]”');
    const long = liveValueText(payload, "/order/note") ?? "";
    expect(long).toBe(`“${"x".repeat(80)}…”`);
    expect(liveValueText(payload, "/order/missing")).toBe("no value");
    expect(liveValueText(payload, "/order/empty")).toBe("no value");
    expect(liveValueText(payload, "")).toBe(null);
    expect(liveValueText(payload, "order")).toBe(null);
    // HTML in a payload is text, never markup.
    expect(liveValueText({ t: "<b>hi</b>" }, "/t")).toBe("“<b>hi</b>”");
  });

  it("the mapping shows `Send a test event to preview values.` before any delivery, then the live values", () => {
    const value = { ...EMPTY_INBOUND, titlePointer: "/order/name" };
    const before = text(
      render(<InboundMapping value={value} onChange={() => undefined} errors={{}} payload={null} />),
    );
    expect(before).toContain("Map the payload (optional)");
    expect(before).toContain("Send a test event to preview values.");
    expect(before).not.toContain("“");

    const html = render(
      <InboundMapping
        value={value}
        onChange={() => undefined}
        errors={{ bodyPointer: "Use a JSON pointer like /order/name" }}
        payload={{ order: { name: "#1001" } }}
      />,
    );
    expect(text(html)).toContain("“#1001”");
    expect(text(html)).toContain("Values come from the last delivery. Leave empty to use the whole payload.");
    expect(text(html)).toContain("Use a JSON pointer like /order/name");
    expect(html).not.toContain("Send a test event to preview values.");
    expect(html).toContain('data-testid="mapping-title-value"');
    // A payload's markup is escaped text.
    const hostile = render(
      <InboundMapping
        value={value}
        onChange={() => undefined}
        errors={{}}
        payload={{ order: { name: "<img src=x onerror=alert(1)>" } }}
      />,
    );
    expect(hostile).not.toContain("<img");
  });
});

describe("What happens (UI-SPEC Surface 2)", () => {
  it("the inbound action follows the delivery target", () => {
    expect(effectiveInboundAction(EMPTY_INBOUND, "board")).toBe("board_card");
    expect(effectiveInboundAction({ ...EMPTY_INBOUND, action: "post" }, "board")).toBe("post");
    expect(effectiveInboundAction({ ...EMPTY_INBOUND, action: "board_card" }, "channel")).toBe("post");
    expect(effectiveInboundAction(EMPTY_INBOUND, "dm")).toBe("post");
  });

  it("the inbound rule sends only the pointers that are set", () => {
    expect(
      inboundOf({ ...EMPTY_INBOUND, titlePointer: " /order/name ", threadKeyPointer: "/order/id" }, "board"),
    ).toEqual({
      action: "board_card",
      askBot: true,
      config: { titlePointer: "/order/name", threadKeyPointer: "/order/id" },
    });
    expect(inboundOf({ ...EMPTY_INBOUND, askBot: false }, "channel")).toEqual({
      action: "post",
      askBot: false,
      config: {},
    });
  });

  const base = {
    triggerKind: "webhook" as const,
    schedule: {
      preset: "weekly" as const,
      minute: "00",
      time: "17:00",
      days: [5],
      monthDay: "1",
      cron: "",
      timeZone: "Europe/Madrid",
    },
    setTriggerKind: () => undefined,
    setSchedule: () => undefined,
    scheduleErrors: {},
    preview: { state: "idle" as const },
    disabled: false,
    inbound: EMPTY_INBOUND,
    setInbound: () => undefined,
    botName: "Ops helper",
  };

  it("a new webhook: the URL line, the mapping, Create a board card and Ask Ops helper to read it", () => {
    const html = render(
      <TriggerStep form={{ ...base, targetKind: "board" }} canWebhook lastSave={null} mode="new" />,
    );
    const t = text(html);
    expect(t).toContain("The URL and signing secret appear after you create the automation.");
    expect(t).toContain("Map the payload (optional)");
    expect(t).toContain("What happens");
    expect(t).toContain("Create a board card");
    expect(t).toContain("Each item becomes a card in the column you pick.");
    expect(t).toContain("Post it in a thread");
    expect(t).toContain("Ask Ops helper to read it");
    expect(t).toContain(
      "Ops helper reads the item and answers in its thread. It can't take actions on outside content without approval.",
    );
    const card = /data-testid="inbound-action-board_card"[\s\S]*?<\/label>/.exec(html)?.[0] ?? "";
    expect(card).toMatch(/<input[^>]*checked/);
  });

  it("a channel offers only a thread; a DM only the DM", () => {
    const channel = text(
      render(<TriggerStep form={{ ...base, targetKind: "channel" }} canWebhook lastSave={null} mode="new" />),
    );
    expect(channel).toContain("Post it in a thread");
    expect(channel).toContain(
      "Each item starts a thread in the channel. Replies about the same item go to the same thread.",
    );
    expect(channel).not.toContain("Create a board card");
    const dm = text(
      render(<TriggerStep form={{ ...base, targetKind: "dm" }} canWebhook lastSave={null} mode="new" />),
    );
    expect(dm).toContain("Post it in your DM");
    expect(dm).not.toContain("Post it in a thread");
  });

  it("mail: the mailbox panel and What happens, no mapping (subject → title, text → body)", () => {
    const html = render(
      <TriggerStep
        form={{ ...base, triggerKind: "mail", targetKind: "channel", mailbox: EMPTY_MAILBOX }}
        canWebhook
        lastSave={null}
        mode="new"
      />,
      (qc) => qc.setQueryData(keychainKeys.list, { personal: [basicKey()], unit: [], manageableUnits: [] }),
    );
    expect(html).toContain('data-testid="mailbox-panel"');
    expect(text(html)).toContain("What happens");
    expect(text(html)).not.toContain("Map the payload");
  });
});

describe("the webhook panel (UI-SPEC Surface 3, R4)", () => {
  it("rejection notices per reason, only when newer than the last acceptance", () => {
    const rejected = (reason: WebhookEndpoint["lastRejectedReason"], at = ago(12)) =>
      rejectionNotice(endpoint({ lastRejectedAt: at, lastRejectedReason: reason }), NOW);
    expect(rejected("signature")).toBe(
      "Last rejected 12 minutes ago: the signature didn't match. Check that the sender uses the current secret.",
    );
    expect(rejected("timestamp")).toBe(
      "Last rejected 12 minutes ago: the timestamp was more than 5 minutes off. Check the sender's clock.",
    );
    expect(rejected("too_large")).toBe("Last rejected 12 minutes ago: the payload was over 64 KB.");
    expect(rejected("rate_limited")).toBe(
      "Last rejected 12 minutes ago: too many requests (over 60 a minute).",
    );
    expect(rejectionNotice(endpoint(), NOW)).toBe(null);
    // An acceptance after the rejection hides it; one before it does not.
    const later = endpoint({
      lastRejectedAt: ago(12),
      lastRejectedReason: "signature",
      deliveries: [delivery({ receivedAt: ago(3) })],
    });
    expect(rejectionNotice(later, NOW)).toBe(null);
    const earlier = endpoint({
      lastRejectedAt: ago(12),
      lastRejectedReason: "signature",
      deliveries: [delivery({ receivedAt: ago(30) })],
    });
    expect(rejectionNotice(earlier, NOW)).toMatch(/^Last rejected 12 minutes ago: the signature/);
  });

  it("deliveries: Accepted with the card or the thread, Duplicate, Not run with the reason", () => {
    const ctx = { prefix: "EXP", namingRule: "{prefix}-{seq:0000} · {summary}", automation: automation() };
    const card = deliveryView(
      delivery({ link: { conversationId: CONV, messageId: MSG, threadRootId: null, cardNumber: "42" } }),
      ctx,
    );
    expect(card).toMatchObject({ label: "Accepted", tone: "done", text: "Created card EXP-0042 in orders" });
    expect(card.href).toBe(`/chat/${CONV}?thread=${MSG}`);
    const channel = automation({
      target: { kind: "channel", conversationId: CONV, label: "#sales" },
      inbound: { action: "post", askBot: true, config: {} },
    });
    const posted = deliveryView(
      delivery({ link: { conversationId: CONV, messageId: MSG, threadRootId: null, cardNumber: null } }),
      { ...ctx, automation: channel },
    );
    expect(posted).toMatchObject({ label: "Accepted", text: "Posted in #sales" });
    expect(posted.href).toBe(`/chat/${CONV}?thread=${MSG}&m=${MSG}`);
    expect(deliveryView(delivery({ result: "duplicate", duplicateCount: 1 }), ctx)).toMatchObject({
      label: "Duplicate",
      tone: "muted",
      text: "Already received; nothing new",
      href: null,
    });
    expect(deliveryView(delivery({ result: "not_run", reason: "paused" }), ctx)).toMatchObject({
      label: "Not run",
      text: "Received while paused; not run",
    });
    expect(deliveryView(delivery({ result: "not_run", reason: "hourly_cap" }), ctx).text).toBe(
      "Too many incoming items this hour.",
    );
    expect(deliveryView(delivery({ result: "not_run", reason: "automation_inactive" }), ctx).text).toBe(
      "Not run.",
    );
    // No prefix on the board: the plain number.
    expect(
      deliveryView(
        delivery({ link: { conversationId: CONV, messageId: MSG, threadRootId: null, cardNumber: "7" } }),
        { ...ctx, prefix: null, namingRule: null },
      ).text,
    ).toBe("Created card 7 in orders");
  });

  it("the secret line, the grace line and the curl example", () => {
    expect(secretSetText("2026-10-08T12:00:00.000Z")).toBe("Set Oct 8 · shown once");
    expect(graceText("2026-10-09T12:05:00.000Z")).toMatch(
      /^Previous secret also valid until Oct 9, \d{1,2}:05 [AP]M\.$/,
    );
    const curl = curlExample("https://ocw.acme.com/api/v1/hooks/ABC");
    expect(curl).toContain("curl -X POST https://ocw.acme.com/api/v1/hooks/ABC");
    expect(curl).toContain('-H "webhook-id: msg_');
    expect(curl).toContain('-H "webhook-signature: v1,');
    expect(curl).not.toContain("whsec_");
  });

  it("renders the URL, the locked secret, deliveries, the rejection notice, and never a secret", () => {
    const ep = endpoint({
      previousValidUntil: "2026-10-09T12:05:00.000Z",
      lastRejectedAt: new Date(Date.now() - 60_000).toISOString(),
      lastRejectedReason: "signature",
      deliveries: [
        delivery({
          receivedAt: new Date(Date.now() - 3_600_000).toISOString(),
          link: { conversationId: CONV, messageId: MSG, threadRootId: null, cardNumber: "42" },
        }),
        delivery({ receivedAt: new Date(Date.now() - 120_000).toISOString(), result: "duplicate" }),
      ],
      lastPayload: { order: { name: "#1001" } },
    });
    const html = render(
      <WebhookEndpointPanel
        automation={automation()}
        inbound={{ ...EMPTY_INBOUND, titlePointer: "/order/name" }}
        onInbound={() => undefined}
        errors={{}}
        canRotate
        disabled={false}
      />,
      (qc) => qc.setQueryData(triggerKeys.webhook(ID), ep),
    );
    const t = text(html);
    expect(html).toContain('data-testid="webhook-url"');
    expect(html).toContain(ep.url);
    expect(t).toContain("Set Oct 8 · shown once");
    expect(t).toContain("Rotate secret");
    expect(t).toMatch(/Previous secret also valid until Oct 9/);
    expect(t).toContain("How to send events");
    expect(t).toContain("Recent deliveries");
    expect(t).toContain("Accepted");
    expect(t).toContain("Duplicate");
    expect(t).toContain("Already received; nothing new");
    expect(t).toContain("the signature didn't match");
    expect(t).toContain("“#1001”");
    expect(html).not.toContain("whsec_");
    expect(html.match(/data-testid="webhook-delivery"/g)?.length).toBe(2);
  });

  it("no deliveries: the dashed empty line; without the right to rotate there is no Rotate", () => {
    const html = render(
      <WebhookEndpointPanel
        automation={automation()}
        inbound={EMPTY_INBOUND}
        onInbound={() => undefined}
        errors={{}}
        canRotate={false}
        disabled
      />,
      (qc) => qc.setQueryData(triggerKeys.webhook(ID), endpoint()),
    );
    expect(text(html)).toContain("No deliveries yet. Send a test event from the other app.");
    expect(text(html)).not.toContain("Rotate secret");
  });
});

describe("the mailbox (UI-SPEC Surface 4, R8)", () => {
  const ctx = { folder: "INBOX", host: "imap.acme.com", port: 993, key: "Ops mailbox" };

  it("test results in words", () => {
    expect(mailboxTestText({ ok: true, messages: 1284 }, ctx)).toBe("Connected. INBOX has 1,284 messages.");
    expect(mailboxTestText({ ok: true, messages: 0 }, ctx)).toBe("Connected. INBOX has 0 messages.");
    expect(mailboxTestText({ ok: false, code: "auth_failed" }, ctx)).toBe(
      "Sign-in failed. Check the username and app password in Keychain.",
    );
    expect(mailboxTestText({ ok: false, code: "unreachable" }, ctx)).toBe("Couldn't reach imap.acme.com:993.");
    expect(mailboxTestText({ ok: false, code: "host_not_allowed" }, ctx)).toBe(
      "imap.acme.com isn't an allowed host for “Ops mailbox”.",
    );
    expect(mailboxTestText({ ok: false, code: "folder_missing" }, ctx)).toBe(
      "The folder “INBOX” doesn't exist.",
    );
    expect(mailboxTestText({ ok: false, code: "certificate" }, ctx)).toBe(
      "The server's certificate isn't valid for imap.acme.com.",
    );
    expect(mailboxTestText({ ok: false, code: "unknown" }, ctx)).toBe("Couldn't connect. Try again.");
  });

  it("statuses in words", () => {
    expect(mailboxStatusLine(mailbox(), NOW)).toEqual({
      tone: "done",
      text: "Checked 3 minutes ago · 2 new messages",
    });
    expect(mailboxStatusLine(mailbox({ lastNewCount: 1 }), NOW).text).toBe(
      "Checked 3 minutes ago · 1 new message",
    );
    expect(mailboxStatusLine(mailbox({ lastNewCount: 0 }), NOW).text).toBe(
      "Checked 3 minutes ago · no new mail",
    );
    expect(mailboxStatusLine(mailbox({ lastPolledAt: null }), NOW).text).toBe("Not checked yet.");
    expect(mailboxStatusLine(mailbox({ status: "auth_failed" }), NOW)).toEqual({
      tone: "failed",
      text: "Sign-in failed 3 minutes ago. Update the password in Keychain.",
    });
    expect(mailboxStatusLine(mailbox({ status: "unreachable" }), NOW)).toEqual({
      tone: "warning",
      text: "Couldn't reach imap.acme.com 3 minutes ago. OCW keeps trying.",
    });
    expect(mailboxStatusLine(mailbox({ status: "paused" }), NOW)).toEqual({
      tone: "muted",
      text: "Paused with the automation.",
    });
  });

  it("allowed hosts: exact host or a *. subdomain, the pattern's port or 993", () => {
    expect(mailHostAllowed(["imap.acme.com"], "imap.acme.com", 993)).toBe(true);
    expect(mailHostAllowed(["imap.acme.com"], "IMAP.acme.com ", 993)).toBe(true);
    expect(mailHostAllowed(["imap.acme.com"], "imap.acme.com", 143)).toBe(false);
    expect(mailHostAllowed(["greenmail:4294"], "greenmail", 4294)).toBe(true);
    expect(mailHostAllowed(["*.acme.com"], "imap.acme.com", 993)).toBe(true);
    expect(mailHostAllowed(["*.acme.com"], "acme.com", 993)).toBe(false);
    expect(mailHostAllowed(["other.com"], "imap.acme.com", 993)).toBe(false);
  });

  it("the config is sent only when complete; no credential field exists", () => {
    expect(mailboxConfigOf(EMPTY_MAILBOX)).toBe(null);
    const v = {
      vaultItemId: KEY,
      host: " imap.acme.com ",
      port: "993",
      folder: " INBOX ",
      pollIntervalMinutes: 5 as const,
    };
    expect(mailboxConfigOf(v)).toEqual({
      vaultItemId: KEY,
      host: "imap.acme.com",
      port: 993,
      folder: "INBOX",
      pollIntervalMinutes: 5,
    });
    expect(mailboxErrors({ ...v, port: "0" }).port).toBe("Use a port from 1 to 65535");
    expect(mailboxErrors({ ...v, host: "" }).host).toBe("Enter the server, like imap.example.com");
    expect(mailboxErrors({ ...v, vaultItemId: "" }).vaultItemId).toBe("Pick a key");
    expect(mailboxErrors({ ...v, folder: "" }).folder).toBe("Enter a folder");
    expect(mailboxErrors(v)).toEqual({});
  });

  it("no Username & password keys: the line and the Keychain link instead of the select", () => {
    const html = render(
      <MailboxPanel
        value={EMPTY_MAILBOX}
        onChange={() => undefined}
        errors={{}}
        automation={null}
        disabled={false}
      />,
      (qc) =>
        qc.setQueryData(keychainKeys.list, {
          personal: [basicKey({ kind: "api_key" })],
          unit: [],
          manageableUnits: [],
        }),
    );
    const t = text(html);
    expect(t).toContain("You have no username and password keys.");
    expect(html).toMatch(/href="\/settings\/keychain"[^>]*>Add one in Keychain/);
    expect(t).toContain(
      "OCW only reads new mail that arrives after you save. It never marks, moves or deletes messages.",
    );
  });

  it("a server outside the key's hosts says so, with the Keychain link; saved, the status line shows", () => {
    const html = render(
      <MailboxPanel
        value={{ ...EMPTY_MAILBOX, vaultItemId: KEY, host: "mail.other.com" }}
        onChange={() => undefined}
        errors={{}}
        automation={automation({
          trigger: { kind: "mail", schedule: null, webhook: null, mailbox: mailbox() },
        })}
        disabled={false}
      />,
      (qc) => {
        qc.setQueryData(keychainKeys.list, { personal: [basicKey()], unit: [], manageableUnits: [] });
        qc.setQueryData(triggerKeys.mailbox(ID), mailbox());
      },
    );
    const t = text(html);
    expect(t).toContain("Add mail.other.com to the allowed hosts of “Ops mailbox” in Keychain.");
    expect(html).toContain('data-testid="mailbox-status"');
    expect(t).toMatch(/Checked .* · 2 new messages/);
  });
});
