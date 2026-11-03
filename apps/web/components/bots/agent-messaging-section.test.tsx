import type { Agent, AgentList, AgentMessagingView, AgentRef } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentMessagingKeys } from "@/lib/agent-messaging-queries";
import { botKeys } from "@/lib/bots-queries";
import { AgentMessagingSection, effectiveSentence, modeOptions } from "./agent-messaging-section";

/**
 * Per-bot consult rules in the bot sheet (07.7-08; A2A-02, D-04, P-04): the "Right now" sentence the API's `effective`
 * adds up to, the four "Can ask" options ("Only these bots" disabled with its reason while the organization switch is
 * on, because deny-wins rules cannot narrow it), the chip lists with named remove buttons, and the read-only state.
 * Static markup in node from a cached view.
 */

const ARCHIE = "00000000-0000-4000-8000-0000000000a1";
const ref = (handle: string, n: number): AgentRef => ({
  id: `00000000-0000-4000-8000-0000000000${(0xb0 + n).toString(16)}`,
  handle,
  displayName: handle[0]?.toUpperCase() + handle.slice(1),
});
const BEA = ref("bea", 1);
const CARL = ref("carl", 2);
const DORA = ref("dora", 3);
const ED = ref("ed", 4);
const FAY = ref("fay", 5);

function view(over: Partial<AgentMessagingView> = {}): AgentMessagingView {
  return {
    agentId: ARCHIE,
    orgDefault: false,
    outbound: { mode: "default", allow: [], deny: [] },
    inbound: { consultable: true },
    effective: { kind: "none", targets: [] },
    canManage: true,
    ...over,
  };
}

function agent(id: string, name: string, username: string, scope: "team" | "personal" = "team"): Agent {
  return {
    id,
    organizationId: "00000000-0000-4000-8000-000000000001",
    name,
    username,
    avatarUrl: null,
    description: null,
    instructions: "",
    modelProvider: "mock",
    modelId: "mock-1",
    runtime: "openclaw",
    status: "ready",
    statusMessage: null,
    createdBy: null,
    createdAt: "2026-11-03T09:00:00.000Z",
    updatedAt: "2026-11-03T09:00:00.000Z",
    scope,
    ownerUserId: null,
    unitId: null,
    unit: null,
    viewerCan: ["bot.read"],
  } as Agent;
}

const ARCHIE_AGENT = agent(ARCHIE, "Archie", "archie");

function render(v: AgentMessagingView): string {
  const qc = new QueryClient();
  qc.setQueryData(agentMessagingKeys.bot(ARCHIE), v);
  const list: AgentList = {
    agents: [
      ARCHIE_AGENT,
      ...[BEA, CARL, DORA].map((r) => agent(r.id, r.displayName, r.handle)),
      agent("00000000-0000-4000-8000-0000000000c9", "Pia", "pia", "personal"),
    ],
  };
  qc.setQueryData(botKeys.agents, list);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AgentMessagingSection agent={ARCHIE_AGENT} />
    </QueryClientProvider>,
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

/** Every opening tag of an element with `data-testid` = `id`. */
const tagsOf = (html: string, id: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`, "g")) ?? [];

describe("effectiveSentence", () => {
  it("says any, none and the named targets the API computed", () => {
    expect(effectiveSentence(view({ effective: { kind: "any", targets: [BEA, CARL] } }), "Archie")).toBe(
      "Archie can ask any bot.",
    );
    expect(effectiveSentence(view(), "Archie")).toBe("Archie can't ask other bots.");
    expect(effectiveSentence(view({ effective: { kind: "some", targets: [BEA] } }), "Archie")).toBe(
      "Archie can ask @bea.",
    );
    expect(effectiveSentence(view({ effective: { kind: "some", targets: [BEA, CARL] } }), "Archie")).toBe(
      "Archie can ask @bea and @carl.",
    );
    expect(
      effectiveSentence(view({ effective: { kind: "some", targets: [BEA, CARL, DORA, ED, FAY] } }), "Archie"),
    ).toBe("Archie can ask @bea, @carl and 3 more.");
  });
});

describe("modeOptions", () => {
  it("disables Only these bots with the reason while the organization switch is on", () => {
    const opts = modeOptions(view({ orgDefault: true }));
    expect(opts.map((o) => o.value)).toEqual(["default", "any", "only", "none"]);
    expect(opts.map((o) => o.label)).toEqual([
      "Organization default (On)",
      "Any bot",
      "Only these bots",
      "No bot",
    ]);
    const only = opts.find((o) => o.value === "only");
    expect(only?.disabled).toBe(true);
    expect(only?.reason).toBe(
      "Every bot may ask any bot in this organization, so a list can't narrow it. Use “Never ask” instead.",
    );
    expect(opts.filter((o) => o.disabled)).toHaveLength(1);
  });

  it("enables every option and labels the default (Off) while the switch is off", () => {
    const opts = modeOptions(view());
    expect(opts[0]?.label).toBe("Organization default (Off)");
    expect(opts.every((o) => !o.disabled && !o.reason)).toBe(true);
  });
});

describe("AgentMessagingSection", () => {
  it("renders Right now, Can ask, the two chip lists with named remove buttons and the inbound switch", () => {
    const html = render(
      view({
        outbound: { mode: "only", allow: [BEA, CARL], deny: [] },
        effective: { kind: "some", targets: [BEA, CARL] },
      }),
    );
    expect(tagsOf(html, "agent-messaging-section")).toHaveLength(1);
    const live = tagsOf(html, "agent-messaging-effective")[0] ?? "";
    expect(live).toContain('aria-live="polite"');
    expect(html).toContain("Archie can ask @bea and @carl.");
    expect(html).toContain("People also need to see the bot being asked.");
    expect(html).toContain("Can ask");
    expect(html).toContain('<ul aria-label="Only these bots"');
    expect(html).toContain('<ul aria-label="Never ask"');
    expect(html).toContain('aria-label="Remove @bea"');
    expect(html).toContain('aria-label="Remove @carl"');
    expect(html).toContain("Always wins over the options above and the organization default.");
    expect(html).toContain("Nobody excluded.");
    expect(html).toContain("Other bots can ask Archie");
    expect(html).toContain("Turn off to keep Archie out of every consult.");
    expect(tagsOf(html, "agent-messaging-inbound-switch")[0]).toContain('aria-checked="true"');
    // Both Add pickers render for an admin.
    expect(tagsOf(html, "agent-messaging-add-allow")).toHaveLength(1);
    expect(tagsOf(html, "agent-messaging-add-deny")).toHaveLength(1);
  });

  it("hides Only these bots outside mode only, and Never ask in mode No bot", () => {
    const any = render(view({ outbound: { mode: "any", allow: [], deny: [CARL] } }));
    expect(tagsOf(any, "agent-messaging-allow")).toHaveLength(0);
    expect(tagsOf(any, "agent-messaging-deny")).toHaveLength(1);
    expect(any).toContain('aria-label="Remove @carl"');
    const none = render(view({ outbound: { mode: "none", allow: [], deny: [] } }));
    expect(tagsOf(none, "agent-messaging-allow")).toHaveLength(0);
    expect(tagsOf(none, "agent-messaging-deny")).toHaveLength(0);
  });

  it("shows the reason under Can ask while the organization switch is on", () => {
    const html = render(view({ orgDefault: true, effective: { kind: "any", targets: [BEA] } }));
    expect(html).toContain("Archie can ask any bot.");
    const reason = tagsOf(html, "agent-messaging-only-reason")[0] ?? "";
    expect(reason).toMatch(/id="[^"]+"/);
    const id = reason.match(/id="([^"]+)"/)?.[1] ?? "missing";
    expect(tagsOf(html, "agent-messaging-mode")[0]).toContain(`aria-describedby="${id}"`);
  });

  it("without canManage every control is disabled and no Add select renders", () => {
    const html = render(
      view({
        canManage: false,
        outbound: { mode: "only", allow: [BEA, CARL], deny: [DORA] },
        effective: { kind: "some", targets: [BEA, CARL] },
      }),
    );
    expect(tagsOf(html, "agent-messaging-add-allow")).toHaveLength(0);
    expect(tagsOf(html, "agent-messaging-add-deny")).toHaveLength(0);
    expect(tagsOf(html, "agent-messaging-mode")[0]).toMatch(/disabled|data-disabled/);
    expect(tagsOf(html, "agent-messaging-inbound-switch")[0]).toMatch(/aria-disabled="true"|data-disabled/);
    for (const handle of ["bea", "carl", "dora"]) {
      const button = html.match(new RegExp(`<button[^>]*aria-label="Remove @${handle}"[^>]*>`))?.[0] ?? "";
      expect(button, handle).toContain("disabled");
    }
  });
});
