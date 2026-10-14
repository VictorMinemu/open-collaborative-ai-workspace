import type { McpServerTool, ToolApprovalPolicy, ToolApprovalPolicyPage } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { McpToolsList } from "@/components/mcp/mcp-tools-list";
import { approvalPolicyKeys, effectiveRowMode } from "@/lib/approval-policy-queries";
import { historyAction } from "./policy-history-sheet";
import { type Person, PolicyRuleFields } from "./policy-rule-dialog";
import { ModeChip, ToolPolicyRow } from "./tool-policy-group";

/**
 * Settings › Approval policies (07.5-09, APPROVE-01, P-04, UI-SPEC Surface 4): which rule carries a row's mode, the
 * inherited strictness a unit cannot relax, the mode chips, the rule dialog's states and the "Needs approval" chip in
 * Settings › MCP servers. Pure rendering of the API's page (static markup in node); the API decides every write.
 */

const SAFE = "m1a2b3c4d";
const ECHO = `${SAFE}__echo`;
const WRITE = `${SAFE}__write_note`;
const SERVER = `${SAFE}__*`;
const SALES = "01a11635-d6e7-7c87-9f17-b6b1dc048941";
const NOW = "2026-10-14T10:00:00.000Z";
let n = 0;

function rule(over: Partial<ToolApprovalPolicy> = {}): ToolApprovalPolicy {
  n += 1;
  return {
    id: `01a11635-d6e7-7c87-9f17-${String(n).padStart(12, "0")}`,
    scopeUnitId: null,
    toolPattern: WRITE,
    mode: "always",
    approverKind: "admins",
    approverUserIds: [],
    version: 1,
    updatedAt: NOW,
    updatedBy: null,
    ...over,
  };
}

function page(over: Partial<ToolApprovalPolicyPage> = {}): ToolApprovalPolicyPage {
  const policies = over.policies ?? [];
  const inherited = over.inherited ?? [];
  return {
    scope: { unitId: null, label: "Organization" },
    catalog: [
      {
        source: { kind: "mcp", id: SALES, name: "Acme CRM", safeName: SAFE },
        tools: [
          { name: ECHO, sideEffecting: false },
          { name: WRITE, sideEffecting: true },
        ],
      },
    ],
    approverLabels: Object.fromEntries(
      [...policies, ...inherited].map((p) => [p.id, `label-${p.approverKind}`]),
    ),
    ...over,
    policies,
    inherited,
  };
}

const salesPage = (over: Partial<ToolApprovalPolicyPage> = {}) =>
  page({ scope: { unitId: SALES, label: "Sales" }, ...over });

describe("effectiveRowMode", () => {
  it("a row without any rule never asks and has no source", () => {
    const m = effectiveRowMode(page(), ECHO);
    expect(m).toMatchObject({ mode: "never", source: "none", sourceLabel: null, locked: false, own: null });
  });

  it("a server rule reaches every tool row as 'from all tools'; the server row is the rule's own", () => {
    const server = rule({ toolPattern: SERVER, approverKind: "admins" });
    const p = page({ policies: [server] });
    expect(effectiveRowMode(p, ECHO)).toMatchObject({
      mode: "always",
      source: "server",
      sourceLabel: "from all tools",
      approverLabel: "label-admins",
    });
    expect(effectiveRowMode(p, SERVER)).toMatchObject({ mode: "always", source: "own", own: server });
  });

  it("own beats the server rule, which beats an inherited rule, when equally strict", () => {
    const own = rule({
      toolPattern: ECHO,
      mode: "when_tainted",
      scopeUnitId: SALES,
      approverKind: "unit_leads",
    });
    const server = rule({ toolPattern: SERVER, mode: "when_tainted", scopeUnitId: SALES });
    const upper = { ...rule({ toolPattern: ECHO, mode: "when_tainted" }), scopeLabel: "Organization" };
    expect(effectiveRowMode(salesPage({ policies: [own, server], inherited: [upper] }), ECHO).source).toBe(
      "own",
    );
    expect(effectiveRowMode(salesPage({ policies: [server], inherited: [upper] }), ECHO).source).toBe(
      "server",
    );
    expect(effectiveRowMode(salesPage({ inherited: [upper] }), ECHO)).toMatchObject({
      source: "organization",
      sourceLabel: "from Organization",
      locked: false,
    });
  });

  it("a stricter upper rule wins and locks the row on a unit scope; an exact rule never covers the server row", () => {
    const upper = { ...rule({ toolPattern: WRITE, mode: "always" }), scopeLabel: "Organization" };
    const own = rule({ toolPattern: WRITE, mode: "when_tainted", scopeUnitId: SALES });
    const m = effectiveRowMode(salesPage({ policies: [own], inherited: [upper] }), WRITE);
    expect(m).toMatchObject({
      mode: "always",
      source: "organization",
      locked: true,
      inheritedMode: "always",
    });
    expect(m.own).toEqual(own);
    expect(effectiveRowMode(salesPage({ inherited: [upper] }), SERVER)).toMatchObject({
      mode: "never",
      locked: false,
    });
  });

  it("an upper unit rule is labelled with its unit; withoutOwn answers what Remove falls back to", () => {
    const upper = {
      ...rule({ toolPattern: SERVER, mode: "when_tainted", scopeUnitId: SALES }),
      scopeLabel: "Sales",
    };
    const own = rule({
      toolPattern: ECHO,
      mode: "always",
      scopeUnitId: "01a11635-d6e7-7c87-9f17-b6b1dc048999",
    });
    const p = page({
      scope: { unitId: own.scopeUnitId, label: "Sales East" },
      policies: [own],
      inherited: [upper],
    });
    expect(effectiveRowMode(p, ECHO).source).toBe("own");
    expect(effectiveRowMode(p, ECHO, { withoutOwn: true })).toMatchObject({
      mode: "when_tainted",
      source: "unit",
      sourceLabel: "from Sales",
    });
  });
});

describe("ToolPolicyRow and ModeChip", () => {
  it("an inherited Always row shows the chip, 'from Organization' and an aria-disabled Edit described by the reason", () => {
    const upper = { ...rule({ toolPattern: WRITE, mode: "always" }), scopeLabel: "Organization" };
    const mode = effectiveRowMode(salesPage({ inherited: [upper] }), WRITE);
    const html = renderToStaticMarkup(
      <ul>
        <ToolPolicyRow
          row={{ pattern: WRITE, label: "write_note", server: false, sideEffecting: true }}
          mode={mode}
          onEdit={() => {}}
        />
      </ul>,
    );
    expect(html).toContain("Always ask");
    expect(html).toContain("from Organization");
    const edit = html.match(/<button[^>]*data-testid="policy-edit-[^"]*"[^>]*>/g) ?? [];
    expect(edit).toHaveLength(1);
    expect(edit[0]).toContain('aria-disabled="true"');
    const describedBy = edit[0]?.match(/aria-describedby="([^"]+)"/)?.[1] ?? "";
    expect(describedBy).not.toBe("");
    expect(html).toMatch(
      new RegExp(
        `id="${describedBy}"[^>]*>The organization already asks every time\\. A unit can only add approvals\\.`,
      ),
    );
  });

  it("an editable row has the desktop Edit and the phone whole-row button, both named for the tool", () => {
    const html = renderToStaticMarkup(
      <ul>
        <ToolPolicyRow
          row={{ pattern: ECHO, label: "echo", server: false, sideEffecting: false }}
          mode={effectiveRowMode(page(), ECHO)}
          onEdit={() => {}}
        />
      </ul>,
    );
    expect(html.match(/aria-label="Edit rule for echo"/g)).toHaveLength(2);
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain("Never ask");
  });

  it("the three mode chips render their label and icon", () => {
    const icon = {
      never: "lucide-circle-dashed",
      when_tainted: "lucide-triangle-alert",
      always: "lucide-hand",
    };
    const label = { never: "Never ask", when_tainted: "Ask after outside content", always: "Always ask" };
    for (const mode of ["never", "when_tainted", "always"] as const) {
      const html = renderToStaticMarkup(<ModeChip mode={mode} />);
      expect(html).toContain(label[mode]);
      expect(html).toContain(icon[mode]);
    }
  });
});

const PEOPLE: Person[] = [
  { userId: "01a11635-d6e7-7c87-9f17-b6b1dc048951", displayName: "Luis Mora", avatarUrl: null },
  { userId: "01a11635-d6e7-7c87-9f17-b6b1dc048952", displayName: "Marta Gil", avatarUrl: null },
];

function fields(props: Partial<Parameters<typeof PolicyRuleFields>[0]> = {}) {
  return renderToStaticMarkup(
    <PolicyRuleFields
      draft={{ mode: "never", approverKind: "requester", approverUserIds: [] }}
      onChange={() => {}}
      unitName={null}
      inheritedMode="never"
      inheritedScopeLabel={null}
      people={PEOPLE}
      peopleLoading={false}
      {...props}
    />,
  );
}

/** The opening tag of the element carrying `data-testid="<id>"`, and the input inside a radio label. */
const tagOf = (html: string, id: string) =>
  html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const inputOf = (html: string, id: string) =>
  html.match(new RegExp(`data-testid="${id}"[^>]*><input[^>]*>`))?.[0] ?? "";

describe("PolicyRuleFields", () => {
  it("Never ask disables Who approves with the reason", () => {
    const html = fields();
    expect(tagOf(html, "policy-approvers")).toContain("disabled");
    expect(html).toContain("No one approves when bots never ask.");
    expect(html).not.toContain("The person who asked can&#x27;t approve their own request.");
  });

  it("'Leads of {unit}' is offered only on a unit scope", () => {
    const always = { mode: "always" as const, approverKind: "requester" as const, approverUserIds: [] };
    expect(fields({ draft: always })).not.toContain("Leads of");
    const unit = fields({ draft: always, unitName: "Sales" });
    expect(unit).toContain("Leads of Sales");
    expect(unit).toContain('data-testid="policy-approvers-unit_leads"');
    expect(tagOf(unit, "policy-approvers")).not.toContain("disabled");
  });

  it("the four-eyes note shows when someone other than the asker approves", () => {
    const html = fields({ draft: { mode: "always", approverKind: "admins", approverUserIds: [] } });
    expect(html).toContain("The person who asked can&#x27;t approve their own request.");
    expect(
      fields({ draft: { mode: "always", approverKind: "requester", approverUserIds: [] } }),
    ).not.toContain("can&#x27;t approve their own request");
  });

  it("specific people: the chips, the checked boxes and the '{n} of 20' counter", () => {
    const html = fields({
      draft: { mode: "always", approverKind: "users", approverUserIds: PEOPLE.map((p) => p.userId) },
    });
    expect(html).toContain("2 of 20");
    expect(html.match(/data-testid="policy-person-chip"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Remove Marta Gil"');
    expect(html.match(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")[^>]*>/g)).toHaveLength(2);
    expect(html).toContain('role="group" aria-label="People"');
  });

  it("under an inherited Always rule, Always is selected and the weaker options are disabled with the reason", () => {
    const html = fields({
      draft: { mode: "always", approverKind: "unit_leads", approverUserIds: [] },
      unitName: "Sales",
      inheritedMode: "always",
      inheritedScopeLabel: "Organization",
    });
    expect(inputOf(html, "policy-mode-always")).toContain('checked=""');
    expect(inputOf(html, "policy-mode-always")).not.toContain("disabled");
    for (const weaker of ["never", "when_tainted"])
      expect(inputOf(html, `policy-mode-${weaker}`)).toContain("disabled");
    expect(
      html.match(/The organization already asks every time\. A unit can only add approvals\./g),
    ).toHaveLength(2);
  });
});

describe("history lines", () => {
  const catalog = page().catalog;
  const item = {
    id: "01a11635-d6e7-7c87-9f17-b6b1dc048961",
    at: NOW,
    actor: { id: PEOPLE[0]?.userId ?? "", displayName: "Víctor Ruiz" },
  };
  it("names the server pattern and the tool as the page does", () => {
    expect(
      historyAction(
        { ...item, action: "created", toolPattern: SERVER, mode: "always", approverLabel: "Admins" },
        catalog,
      ),
    ).toBe("set All Acme CRM tools to Always ask");
    expect(
      historyAction(
        { ...item, action: "deleted", toolPattern: WRITE, mode: null, approverLabel: null },
        catalog,
      ),
    ).toBe("removed the rule for write_note");
  });
});

describe("Settings › MCP servers chip", () => {
  const tool = (name: string, readOnly: boolean): McpServerTool => ({
    name,
    openclawName: `${SAFE}__${name}`,
    title: null,
    description: null,
    readOnly,
    destructive: !readOnly,
    inputSchema: null,
  });

  function list(orgRules: ToolApprovalPolicy[], organization = true) {
    const qc = new QueryClient();
    qc.setQueryData(approvalPolicyKeys.access, { manageable: { organization, unitIds: [] } });
    qc.setQueryData(approvalPolicyKeys.page("org"), page({ policies: orgRules }));
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <McpToolsList tools={[tool("echo", true), tool("write_note", false)]} />
      </QueryClientProvider>,
    );
  }
  const itemOf = (html: string, name: string) =>
    html.match(new RegExp(`<li[^>]*data-tool="${name}"[\\s\\S]*?</li>`))?.[0] ?? "";

  it("'Needs approval' after the effect under an Always rule, 'Asks after outside content' under a when-tainted one", () => {
    const html = list([
      rule({ toolPattern: WRITE, mode: "always" }),
      rule({ toolPattern: ECHO, mode: "when_tainted" }),
    ]);
    const write = itemOf(html, "write_note");
    expect(write).toContain('data-testid="tool-needs-approval"');
    expect(write).toContain("Needs approval");
    expect(write.indexOf("tool-effect")).toBeLessThan(write.indexOf("tool-needs-approval"));
    expect(itemOf(html, "echo")).toContain("Asks after outside content");
  });

  it("a server rule reaches every tool; without rules (or without access) nothing changes", () => {
    const html = list([rule({ toolPattern: SERVER, mode: "always" })]);
    expect(html.match(/data-testid="tool-needs-approval"/g)).toHaveLength(2);
    expect(list([])).not.toContain("tool-needs-approval");
    expect(list([rule({ toolPattern: WRITE })], false)).not.toContain("tool-needs-approval");
  });
});
