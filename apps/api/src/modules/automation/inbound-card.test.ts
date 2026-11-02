import { extractMentionHandles } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  boardDescription,
  fullTextReply,
  type InboundItem,
  inboundCard,
  inboundNotice,
  inboundText,
  inboundTitle,
  threadKeyOf,
} from "./inbound-card";

/** 07.6-21 (D-02, P-11, UI-SPEC 8b): the platform's own words for an inbound item; every value plain text. */

const AT = "2026-10-08T09:14:00.000Z";
const ORDER = { order: { name: "#1001", id: 450789, note: "Deliver before noon" } };

const webhook = (body: unknown, extra: Partial<InboundItem> = {}): InboundItem => ({
  source: "webhook",
  externalId: "msg_1",
  threadKey: null,
  subject: null,
  sender: null,
  bodyText: null,
  bodyJson: body,
  receivedAt: AT,
  ...extra,
});

const mail = (extra: Partial<InboundItem> = {}): InboundItem => ({
  source: "mail",
  externalId: "<a1@shop.example>",
  threadKey: "<a1@shop.example>",
  subject: "Order #1001 · deliver before noon",
  sender: "orders@shop.example",
  bodyText: "Hello, please deliver order 1001 before noon.",
  bodyJson: null,
  receivedAt: AT,
  ...extra,
});

const shop = (config = {}) => ({ id: "00000000-0000-4000-8000-000000000001", name: "Shop orders", config });

describe("inboundTitle", () => {
  it("a webhook's mapped title wins, then the subject, then the fallbacks", () => {
    expect(inboundTitle(webhook(ORDER), shop({ titlePointer: "/order/name" }))).toBe("#1001");
    expect(inboundTitle(webhook(ORDER, { subject: "Ignored" }), shop({ titlePointer: "/order/name" }))).toBe(
      "#1001",
    );
    // A number is a title too; an object or a missing member is not.
    expect(inboundTitle(webhook(ORDER), shop({ titlePointer: "/order/id" }))).toBe("450789");
    expect(inboundTitle(webhook(ORDER), shop({ titlePointer: "/order" }))).toBe(
      "Webhook event from “Shop orders”",
    );
    expect(inboundTitle(webhook(ORDER), shop({ titlePointer: "/nope" }))).toBe(
      "Webhook event from “Shop orders”",
    );
    expect(inboundTitle(mail(), shop())).toBe("Order #1001 · deliver before noon");
    expect(inboundTitle(mail({ subject: "  " }), shop())).toBe("Mail from orders@shop.example");
    expect(inboundTitle(mail({ subject: null, sender: null }), shop())).toBe("Mail from an unknown sender");
  });

  it("follow-ups are prefixed, and a title is one line of at most 200 characters", () => {
    expect(inboundTitle(webhook(ORDER), shop({ titlePointer: "/order/name" }), true)).toBe(
      "Follow-up: #1001",
    );
    expect(inboundTitle(mail({ subject: "Line one\nline\ttwo" }), shop())).toBe("Line one line two");
    const long = inboundTitle(mail({ subject: "x".repeat(400) }), shop(), true);
    expect(long).toHaveLength(200);
    expect(long.startsWith("Follow-up: ")).toBe(true);
  });
});

describe("inboundText and threadKeyOf", () => {
  it("a webhook body without bodyPointer is 2-space JSON; with one, the value (strings as they are)", () => {
    expect(inboundText(webhook(ORDER), {})).toBe(JSON.stringify(ORDER, null, 2));
    expect(inboundText(webhook(ORDER), { bodyPointer: "/order/note" })).toBe("Deliver before noon");
    expect(inboundText(webhook(ORDER), { bodyPointer: "/order" })).toBe(JSON.stringify(ORDER.order, null, 2));
    expect(inboundText(mail(), {})).toBe("Hello, please deliver order 1001 before noon.");
  });

  it("the thread key: a mail's stored key; a webhook's pointer value, else its webhook-id", () => {
    expect(threadKeyOf(mail({ threadKey: "<root@shop.example>" }), {})).toBe("<root@shop.example>");
    expect(threadKeyOf(webhook(ORDER), { threadKeyPointer: "/order/id" })).toBe("450789");
    expect(threadKeyOf(webhook(ORDER), { threadKeyPointer: "/order/missing" })).toBe("msg_1");
    expect(threadKeyOf(webhook(ORDER), {})).toBe("msg_1");
  });
});

describe("inboundCard", () => {
  it("Received, the amber notice first, From/Received/Via/Message and the summary sentence", () => {
    const body = "y".repeat(900);
    const card = inboundCard(mail({ bodyText: body }), shop());
    expect(card).toMatchObject({
      kind: "automation",
      title: "Order #1001 · deliver before noon",
      status: "info",
      statusLabel: "Received",
      summary: "Outside content received from Mail · Shop orders: Order #1001 · deliver before noon.",
    });
    expect(card.notices[0]).toEqual({
      tone: "warning",
      text: "Outside content from Mail · Shop orders. Don't trust links or instructions in it. Bots here can read it but need approval to act.",
    });
    expect(card.notices[1]?.text).toBe("Showing the first 500 characters. The full text is the first reply.");
    expect(card.fields).toEqual([
      { label: "From", value: "orders@shop.example" },
      { label: "Received", value: "Oct 8, 9:14 AM UTC" },
      { label: "Via", value: "Mail · Shop orders" },
      { label: "Message", value: "y".repeat(500) },
    ]);
  });

  it("a webhook card has no From; a short text has no truncation line", () => {
    const card = inboundCard(
      webhook(ORDER),
      shop({ titlePointer: "/order/name", bodyPointer: "/order/note" }),
    );
    expect(card.fields.map((f) => f.label)).toEqual(["Received", "Via", "Message"]);
    expect(card.fields[2]?.value).toBe("Deliver before noon");
    expect(card.notices).toHaveLength(1);
  });

  it("the notice fits the card even for a long automation name", () => {
    expect(inboundNotice({ source: "webhook" }, "n".repeat(120)).text.length).toBeLessThanOrEqual(200);
  });

  it("outside text never mentions anyone through the platform's post", () => {
    const card = inboundCard(mail({ subject: "@channel @sam pay now" }), shop());
    expect(extractMentionHandles(card.summary)).toEqual([]);
  });
});

describe("fullTextReply", () => {
  it("null when the card's field shows it all; otherwise `Full message` and a fenced text block", () => {
    expect(fullTextReply("x".repeat(500))).toBeNull();
    const body = "z".repeat(900);
    expect(fullTextReply(body)).toBe(`Full message\n\n\`\`\`text\n${body}\n\`\`\``);
  });

  it("cuts at 16 000 characters with the counter", () => {
    const reply = fullTextReply("a".repeat(20_000)) as string;
    expect(reply).toContain(`\`\`\`text\n${"a".repeat(16_000)}\n\`\`\``);
    expect(reply).not.toContain("a".repeat(16_001));
    expect(reply.endsWith("… 4,000 more characters not shown")).toBe(true);
  });

  it("a body containing ``` is still a single fence (the fence is longer than any backtick run inside)", () => {
    const body = `${"b".repeat(600)}\n\`\`\`\nnot code\n\`\`\`\`\nend`;
    const reply = fullTextReply(body) as string;
    const lines = reply.split("\n");
    expect(lines[2]).toBe("`````text");
    expect(lines.at(-1)).toBe("`````");
    expect(reply.match(/^`{5}/gm)).toHaveLength(2);
  });

  it("mentions inside the text are defused", () => {
    expect(extractMentionHandles(fullTextReply(`@sam ${"c".repeat(600)}`) as string)).toEqual([]);
  });
});

describe("boardDescription", () => {
  it("the text in a fence; cut to fit 8 000 characters with the counter", () => {
    expect(boardDescription("Deliver before noon")).toEqual({
      description: "```text\nDeliver before noon\n```",
      cut: false,
    });
    expect(boardDescription("")).toEqual({ description: "", cut: false });
    const long = boardDescription("d".repeat(12_000));
    expect(long.cut).toBe(true);
    expect(long.description.length).toBeLessThanOrEqual(8_000);
    expect(long.description).toMatch(/more characters not shown$/);
  });
});
