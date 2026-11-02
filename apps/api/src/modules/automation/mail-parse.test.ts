import { describe, expect, it } from "vitest";
import { htmlToText, parseMail } from "./mail-parse";

/**
 * 07.6-11 (AUTO-02, D-07, P-09; research Pattern 5): what a polled mail becomes before it is stored. Fixture sources
 * only: the Message-ID (idempotency), the thread key (first References id → In-Reply-To → own Message-ID), plain text
 * (HTML converted, capped at 32 768 characters) and the loop filters (RFC 3834 Auto-Submitted, Precedence, the
 * mailbox's own address, our own X-OCW-Automation-Run header).
 */

const MAILBOX = { mailboxAddress: "ops@acme.test" };

function source(headers: Record<string, string>, body = "Please deliver order 1001.", html = false): Buffer {
  const lines = [
    `From: ${headers.From ?? '"Shop Orders" <orders@shop.example>'}`,
    "To: ops@acme.test",
    `Subject: ${headers.Subject ?? "Order 1001"}`,
    ...Object.entries(headers)
      .filter(([k]) => k !== "From" && k !== "Subject")
      .map(([k, v]) => `${k}: ${v}`),
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`,
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8");
}

const skipOf = async (headers: Record<string, string>) =>
  (await parseMail(source({ "Message-ID": "<a@x>", ...headers }), MAILBOX)).skipReason;

describe("parseMail: ids and threading keys", () => {
  it("keeps the Message-ID and threads on the first References id", async () => {
    const m = await parseMail(
      source({
        "Message-ID": "<c@x>",
        References: "<a@x> <b@x>",
        "In-Reply-To": "<b@x>",
      }),
      MAILBOX,
    );
    expect(m.messageId).toBe("<c@x>");
    expect(m.threadKey).toBe("<a@x>");
    expect(m.skipReason).toBeNull();
  });

  it("folded References still give their first id", async () => {
    const m = await parseMail(source({ "Message-ID": "<c@x>", References: "<a@x>\r\n <b@x>" }), MAILBOX);
    expect(m.threadKey).toBe("<a@x>");
  });

  it("only In-Reply-To → that id; neither → the own Message-ID", async () => {
    const reply = await parseMail(source({ "Message-ID": "<c@x>", "In-Reply-To": "<b@x>" }), MAILBOX);
    expect(reply.threadKey).toBe("<b@x>");
    expect((await parseMail(source({ "Message-ID": "<c@x>" }), MAILBOX)).threadKey).toBe("<c@x>");
  });

  it("no Message-ID → null id and null key (the caller falls back to the UID hash)", async () => {
    const m = await parseMail(source({}), MAILBOX);
    expect(m.messageId).toBeNull();
    expect(m.threadKey).toBeNull();
  });

  it("a Message-ID that is not one id is not trusted as one", async () => {
    const m = await parseMail(source({ "Message-ID": "garbage without brackets" }), MAILBOX);
    expect(m.messageId).toBeNull();
  });
});

describe("parseMail: content", () => {
  it("sender and subject; encoded subjects decode", async () => {
    const m = await parseMail(
      source({ "Message-ID": "<s@x>", Subject: "=?UTF-8?B?w5NyZGVuIDEwMDEgwrcgdXJnZW50ZQ==?=" }),
      MAILBOX,
    );
    expect(m.subject).toBe("Órden 1001 · urgente");
    expect(m.from).toBe("Shop Orders <orders@shop.example>");
    expect(m.fromAddress).toBe("orders@shop.example");
  });

  it("an HTML-only mail becomes readable text without tags, scripts or styles", async () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head><body><header>Shop news</header>" +
      "<p>Hello <b>Víctor</b>,</p>" +
      "<div>order&nbsp;1001 &amp; 1002</div><script>alert('x')</script><!-- hidden --><ul><li>one</li>" +
      '<li>two</li></ul><a href="https://shop.example/o/1001">track</a></body></html>';
    const m = await parseMail(source({ "Message-ID": "<h@x>" }, html, true), MAILBOX);
    expect(m.text).toContain("Shop news");
    expect(m.text).toContain("Hello Víctor,");
    expect(m.text).toContain("order 1001 & 1002");
    expect(m.text).toContain("one");
    expect(m.text).toContain("track");
    expect(m.text).not.toMatch(/<|>|alert|color:red|hidden/);
  });

  it("a 40 KiB body is cut to 32 768 characters", async () => {
    const m = await parseMail(source({ "Message-ID": "<big@x>" }, "x".repeat(40 * 1024)), MAILBOX);
    expect(m.text).toHaveLength(32_768);
  });

  it("unclosed and nested tags stay linear and leave no markup", () => {
    const evil = `${"<a".repeat(100_000)}<script${"<script".repeat(10_000)}`;
    const started = Date.now();
    const text = htmlToText(evil);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain("script");
    expect(text).not.toContain("<");
  });
});

describe("parseMail: loop filters (P-09)", () => {
  it("Auto-Submitted other than no is skipped (auto-replied, auto-generated); no is not", async () => {
    for (const value of ["auto-replied", "auto-generated", "Auto-Notified; owner-email=a@b"]) {
      expect(await skipOf({ "Auto-Submitted": value }), value).toBe("auto_submitted");
    }
    expect(await skipOf({ "Auto-Submitted": "no" })).toBeNull();
  });

  it("Precedence bulk, junk or list is skipped as bulk", async () => {
    for (const value of ["bulk", "junk", "List"]) {
      expect(await skipOf({ Precedence: value }), value).toBe("bulk");
    }
    expect(await skipOf({ Precedence: "first-class" })).toBeNull();
  });

  it("mail from the mailbox's own address is skipped as self", async () => {
    expect(await skipOf({ From: "Ops <OPS@acme.test>" })).toBe("self");
  });

  it("mail carrying our own X-OCW-Automation-Run header is skipped as own_header", async () => {
    expect(await skipOf({ "X-OCW-Automation-Run": "run-1" })).toBe("own_header");
  });
});
