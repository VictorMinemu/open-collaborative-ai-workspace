import type { ApprovalDetail, ToolCallApprovalView } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { approvalWho, decisionNoticeOf, NoticeBox } from "./approval-review";
import { ArgumentsView, formatBytes, tokenizeJson } from "./arguments-view";
import { askedInText, sourceText, ToolCallView, targetOf, whyText } from "./tool-call-view";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The action review (07.5-13, D-02, UI-SPEC Surface 2, R7): the arguments viewer shows the server's canonical JSON
 * exactly as given (approval binds to it), as plain text spans; the ToolCallView says who approves, who sees it, where
 * it was asked and why, then what the bot will send; a changed request shows Reload, never a decision.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
const preOf = (markup: string) => markup.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "";

const JSON_TEXT =
  '{\n  "10": 1,\n  "2": "two ⟨U+202E⟩",\n  "amount": 1250,\n  "to": "billing@globex.example"\n}';

describe("formatBytes", () => {
  it("says bytes, then KB with one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1229)).toBe("1.2 KB");
    expect(formatBytes(32_768)).toBe("32 KB");
  });
});

describe("tokenizeJson", () => {
  it("keeps every character and tells keys, strings and punctuation apart", () => {
    const tokens = tokenizeJson(JSON_TEXT);
    expect(tokens.map((t) => t.text).join("")).toBe(JSON_TEXT);
    expect(tokens.filter((t) => t.kind === "key").map((t) => t.text)).toEqual([
      '"10"',
      '"2"',
      '"amount"',
      '"to"',
    ]);
    expect(tokens.filter((t) => t.kind === "string").map((t) => t.text)).toEqual([
      '"two ⟨U+202E⟩"',
      '"billing@globex.example"',
    ]);
    expect(tokens.some((t) => t.kind === "punct" && t.text === "{")).toBe(true);
  });

  it("survives an escaped quote and a cut string at the end", () => {
    const cut = '{"a": "say \\"hi\\"", "b": "unterminat…';
    const tokens = tokenizeJson(cut);
    expect(tokens.map((t) => t.text).join("")).toBe(cut);
    expect(tokens.filter((t) => t.kind === "string").map((t) => t.text)).toEqual([
      '"say \\"hi\\""',
      '"unterminat…',
    ]);
  });
});

describe("ArgumentsView", () => {
  it("shows the given JSON unchanged: no re-serialization, integer-like keys in the given order", () => {
    const out = html(<ArgumentsView json={JSON_TEXT} bytes={1229} />);
    expect(textOf(preOf(out))).toBe(JSON_TEXT);
    expect(textOf(preOf(out)).indexOf('"10"')).toBeLessThan(textOf(preOf(out)).indexOf('"2"'));
  });

  it("colours keys, strings and punctuation with plain spans, and nothing is a link", () => {
    const out = html(<ArgumentsView json={JSON_TEXT} bytes={1229} />);
    expect(out).toMatch(/<span class="[^"]*text-foreground"[^>]*>&quot;amount&quot;<\/span>/);
    expect(out).toMatch(
      /<span class="[^"]*text-foreground\/80"[^>]*>&quot;billing@globex.example&quot;<\/span>/,
    );
    expect(out).toMatch(/<span class="[^"]*text-muted-foreground"[^>]*>\{<\/span>/);
    expect(out).not.toMatch(/<a[\s>]/);
  });

  it("turns a revealed invisible character inside a string into a chip", () => {
    const out = html(<ArgumentsView json={JSON_TEXT} bytes={1229} />);
    expect(out).toContain('aria-label="hidden character U+202E"');
  });

  it("is a named, keyboard-focusable region with the size", () => {
    const out = html(<ArgumentsView json={JSON_TEXT} bytes={1229} />);
    const pre = out.match(/<pre[^>]*>/)?.[0] ?? "";
    expect(pre).toContain('role="region"');
    expect(pre).toContain('tabindex="0"');
    expect(pre).toContain('aria-label="All arguments, 1.2 KB"');
    expect(out).toContain("All arguments");
    expect(out).toContain("1.2 KB");
  });

  it("Expand toggles aria-expanded and removes the max height", () => {
    const collapsed = html(<ArgumentsView json={JSON_TEXT} bytes={1229} />);
    const expanded = html(<ArgumentsView json={JSON_TEXT} bytes={1229} initialExpanded />);
    const toggle = (m: string) => m.match(/<button[^>]*data-testid="arguments-expand"[^>]*>/)?.[0] ?? "";
    expect(toggle(collapsed)).toContain('aria-expanded="false"');
    expect(toggle(expanded)).toContain('aria-expanded="true"');
    expect(collapsed).toContain("Expand");
    expect(expanded).toContain("Collapse");
    const pre = (m: string) => m.match(/<pre[^>]*>/)?.[0] ?? "";
    expect(pre(collapsed)).toContain("max-h-[480px]");
    expect(pre(collapsed)).toContain("max-sm:max-h-[360px]");
    expect(pre(expanded)).not.toContain("max-h-[480px]");
  });
});

// ---------------------------------------------------------------- the tool call view

const ME = "01a11635-d6e7-7c87-9f17-000000000001";
const BOT = "01a11635-d6e7-7c87-9f17-000000000002";
const MARTA = "01a11635-d6e7-7c87-9f17-000000000005";
const UNIT = "01a11635-d6e7-7c87-9f17-000000000006";

function toolView(over: Partial<ToolCallApprovalView> = {}): ToolCallApprovalView {
  return {
    type: "tool_call",
    title: "Run write_note on Acme CRM",
    tool: "m1a2b3c4d__write_note",
    source: { kind: "mcp", name: "Acme CRM", account: "org", keyName: null },
    target: null,
    preview: [
      { key: "to", label: "To", value: "billing@globex.example" },
      { key: "amount", label: "Amount", value: "1250" },
      { key: "text", label: "Text", value: "Invoice for September, 3 plants" },
    ],
    truncated: false,
    argumentsJson:
      '{\n  "amount": 1250,\n  "text": "Invoice for September, 3 plants",\n  "to": "billing@globex.example"\n}',
    argumentsBytes: 83,
    notices: { hiddenCharacters: false, maskedSecret: false },
    tainted: false,
    agent: { id: BOT, displayName: "Scout" },
    requestedFor: { id: ME, displayName: "Sam Lee" },
    approverLabel: "Waiting for Sam Lee to approve",
    policy: {
      scopeUnitId: null,
      scopeLabel: "Organization",
      mode: "always",
      pattern: "m1a2b3c4d__write_note",
      viewerCanManage: false,
    },
    audience: {
      origin: { kind: "dm", name: null },
      conversationReaders: 1,
      detailReaders: 1,
      messageRoute: null,
    },
    useBy: null,
    usedAt: null,
    ...over,
  };
}

function detailOf(view: ToolCallApprovalView, over: Partial<ApprovalDetail> = {}): ApprovalDetail {
  return {
    id: "01a11635-d6e7-7c87-9f17-0000000000aa",
    kind: "tool.call",
    mode: "grant",
    status: "pending",
    actionHash: "a".repeat(64),
    requestedBy: { agentId: BOT, userId: ME, displayName: "Scout" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    resultCode: null,
    viewerCan: ["decide"],
    headline: null,
    view,
    ...over,
  };
}

describe("ToolCallView", () => {
  it("says who approves, who can see the details and, only when tainted, the outside content", () => {
    const clean = html(<ToolCallView view={toolView()} meId={ME} />);
    expect(clean).toContain('data-testid="approval-fact-approvers"');
    expect(textOf(clean)).toContain("You");
    expect(textOf(clean)).toContain("approve this");
    expect(textOf(clean)).toContain("Only youcan see the details");
    expect(clean).not.toContain('data-testid="approval-fact-taint"');
    const lead = html(
      <ToolCallView
        view={toolView({
          tainted: true,
          approverLabel: "Waiting for a lead of Sales",
          audience: {
            origin: { kind: "channel", name: "ops" },
            conversationReaders: 24,
            detailReaders: 3,
            messageRoute: "/chat/x?thread=y&m=z",
          },
        })}
        meId={MARTA}
      />,
    );
    expect(textOf(lead)).toContain("Leads of Sales");
    expect(textOf(lead)).toContain("3 people");
    expect(textOf(lead)).toContain("can see the details");
    expect(lead).toContain('data-testid="approval-fact-taint"');
    expect(textOf(lead)).toContain("Read outside content");
  });

  it("lists the action: short tool name in mono, source, where it was asked with Open message, and why", () => {
    const out = html(
      <ToolCallView
        view={toolView({
          target: "erp.acme.example/api/invoices",
          audience: {
            origin: { kind: "channel", name: "ops" },
            conversationReaders: 24,
            detailReaders: 3,
            messageRoute: "/chat/c1?thread=m1&m=m1",
          },
        })}
        meId={MARTA}
      />,
    );
    const text = textOf(out);
    expect(text).toContain("write_note");
    expect(text).not.toContain("m1a2b3c4d__write_note");
    expect(text).toContain("Acme CRM · MCP server");
    expect(text).toContain("erp.acme.example/api/invoices");
    expect(text).toContain("# ops · 24 people see a summary card");
    expect(out).toMatch(/<a[^>]*href="\/chat\/c1\?thread=m1&amp;m=m1"[^>]*>[\s\S]*Open message/);
    expect(text).toContain("Organization rule: Always ask for write_note");
    // No manage right: the Why is text, not a link.
    expect(out).not.toContain("/settings/approval-policies");
  });

  it("links the Why to the rule only for a manager of its scope", () => {
    const out = html(
      <ToolCallView
        view={toolView({
          policy: {
            scopeUnitId: UNIT,
            scopeLabel: "Sales",
            mode: "when_tainted",
            pattern: "m1a2b3c4d__*",
            viewerCanManage: true,
          },
        })}
        meId={ME}
      />,
    );
    expect(textOf(out)).toContain("Sales rule: Ask after outside content for all Acme CRM tools");
    expect(out).toContain(`href="/settings/approval-policies?scope=${UNIT}&amp;tool=m1a2b3c4d__*"`);
  });

  it("shows what the bot will send in the server's order, as text, with block values for long text", () => {
    const long = `${"word ".repeat(40)}end`;
    const out = html(
      <ToolCallView
        view={toolView({
          preview: [
            { key: "to", label: "To", value: "billing@globex.example" },
            { key: "amount", label: "Amount", value: "1250" },
            { key: "text", label: "Text", value: long },
          ],
        })}
        meId={ME}
      />,
    );
    const text = textOf(out);
    expect(text).toContain("What Scout will send");
    expect(text.indexOf("billing@globex.example")).toBeLessThan(text.indexOf("1250"));
    expect(text.indexOf("1250")).toBeLessThan(text.indexOf("word word"));
    expect(out).toContain('data-block="true"');
    expect(out).not.toMatch(/<a[^>]*href="mailto/);
    expect(text).toContain("Written by Scout. These exact values run once if you approve.");
    expect(out).toContain('data-testid="arguments-view"');
  });

  it("shows the hidden-character and masked-secret notices above the values", () => {
    const out = html(
      <ToolCallView
        view={toolView({
          notices: { hiddenCharacters: true, maskedSecret: true },
          preview: [{ key: "iban", label: "Iban", value: "ES91 •••• 1332 ⟨U+202E⟩" }],
        })}
        meId={ME}
      />,
    );
    const text = textOf(out);
    expect(text).toContain("Contains hidden characters, shown as ⟨U+…⟩.");
    expect(text).toContain("A value looks like a secret and is masked.");
    expect(text.indexOf("Contains hidden characters")).toBeLessThan(text.indexOf("What Scout will send"));
  });

  it("never shows an MCP server's internal safe name as the Target", () => {
    expect(targetOf({ tool: "mc4866abe__write_note", target: "mc4866abe" })).toBeNull();
    expect(targetOf({ tool: "mc4866abe__write_note", target: null })).toBeNull();
    expect(targetOf({ tool: "ocw_http_request", target: "erp.acme.example" })).toBe("erp.acme.example");
    const out = html(
      <ToolCallView view={toolView({ tool: "m1a2b3c4d__write_note", target: "m1a2b3c4d" })} meId={ME} />,
    );
    expect(out).not.toContain('data-testid="tool-call-target"');
  });

  it("names the account the source runs with", () => {
    const v = toolView();
    expect(sourceText(v, ME)).toBe("Acme CRM · MCP server");
    expect(
      sourceText(
        toolView({ source: { kind: "connector", name: "Acme CRM", account: "requester", keyName: null } }),
        ME,
      ),
    ).toBe("Acme CRM · your account");
    expect(
      sourceText(
        toolView({ source: { kind: "connector", name: "Acme CRM", account: "requester", keyName: null } }),
        MARTA,
      ),
    ).toBe("Acme CRM · Sam Lee's account");
    expect(
      sourceText(toolView({ source: { kind: "plugin", name: "notes", account: null, keyName: null } }), ME),
    ).toBe("notes · plugin");
    expect(
      sourceText(
        toolView({ source: { kind: "http", name: "Web request", account: "org", keyName: "CRM key" } }),
        ME,
      ),
    ).toBe("Web request · Keychain key CRM key");
  });

  it("words where it was asked for each origin", () => {
    expect(askedInText(toolView(), ME)).toBe("your DM with Scout · only you see this card");
    expect(askedInText(toolView(), MARTA)).toBe("Sam Lee's DM with Scout · only Sam Lee sees this card");
    expect(
      askedInText(
        toolView({
          audience: {
            origin: { kind: "thread", name: "ops" },
            conversationReaders: 1,
            detailReaders: 2,
            messageRoute: null,
          },
        }),
        ME,
      ),
    ).toBe("a thread in # ops · 1 person sees a summary card");
    expect(whyText(toolView({ policy: null }))).toBe("No rule asks for this any more.");
  });
});

describe("approvalWho", () => {
  it("turns the server's waiting label into who approves", () => {
    const v = toolView();
    expect(approvalWho(v, ME)).toBe("You");
    expect(approvalWho(v, MARTA)).toBe("Sam Lee");
    expect(approvalWho(toolView({ approverLabel: "Waiting for a lead of Sales" }), ME)).toBe(
      "Leads of Sales",
    );
    expect(approvalWho(toolView({ approverLabel: "Waiting for an admin" }), ME)).toBe("Admins");
    expect(approvalWho(toolView({ approverLabel: "Waiting for Marta Gil or 2 others" }), ME)).toBe(
      "Marta Gil or 2 others",
    );
    expect(
      approvalWho(toolView({ approverLabel: "No one can approve this: the people named are gone" }), ME),
    ).toBe("No one");
  });
});

describe("decision errors on the review", () => {
  it("a changed request shows the notice with Reload, never a decision", () => {
    const err = new ApiRequestError(409, "approval_action_changed", "changed");
    const notice = decisionNoticeOf(err);
    expect(notice).toEqual({ kind: "changed" });
    const out = html(<NoticeBox notice={notice ?? { kind: "changed" }} onReload={() => undefined} />);
    expect(out).toContain('role="alert"');
    expect(textOf(out)).toContain("This request changed while you were reviewing it.");
    expect(out).toMatch(/<button[^>]*>[\s\S]*Reload[\s\S]*<\/button>/);
  });

  it("someone already decided: words, no Reload", () => {
    const err = new ApiRequestError(409, "approval_already_decided", "decided");
    expect(decisionNoticeOf(err)).toEqual({ kind: "error", text: "Someone already decided this." });
  });

  it("keeps the detail helper honest", () => {
    expect(detailOf(toolView()).view.type).toBe("tool_call");
  });
});
