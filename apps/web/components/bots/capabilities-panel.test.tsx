import type { BotCapabilityView, ConfinedCapabilityState } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { capabilityKeys } from "@/lib/capability-queries";
import { CapabilitiesPanel } from "./capabilities-panel";

/**
 * The per-bot Sandbox and Browser rows of the Capabilities panel (07.8-15, D-12, UI-SPEC R11), as static markup from a
 * cached capability view: the Internet row's look, off by default, hidden while the module is off for the viewer,
 * disabled with the API's reason while the organization switch is off, the kill switch is on or the service is down.
 */

const AGENT = "00000000-0000-4000-8000-0000000000aa";
const on: ConfinedCapabilityState = { enabled: false, available: true, reason: null };
const eff = { enabled: true, effective: true, reason: null };

function view(confined?: BotCapabilityView["confined"]): BotCapabilityView {
  return {
    agentId: AGENT,
    scope: "team",
    capabilities: {
      internet: true,
      memory: true,
      dateTime: true,
      replyMode: "mentions",
      dailyLimit: 100,
      sandbox: false,
      browser: false,
    },
    effective: { internet: eff, memory: eff, dateTime: eff, replyModeAll: eff },
    tools: [],
    usage: { today: 0, limit: 100, resetsAt: new Date().toISOString() },
    dailyLimitMax: 1000,
    viewerCan: ["bot.read", "bot.configure"],
    confined,
  } as BotCapabilityView;
}

function render(v: BotCapabilityView): string {
  const qc = new QueryClient();
  qc.setQueryData(capabilityKeys.bot(AGENT), v);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <CapabilitiesPanel agentId={AGENT} />
    </QueryClientProvider>,
  ).replace(/&#x27;/g, "'");
}

const switchOf = (html: string, name: string) =>
  html.match(new RegExp(`<span[^>]*data-testid="capability-${name}"[^>]*>`))?.[0] ?? "";

describe("CapabilitiesPanel › Sandbox and Browser", () => {
  it("lists both rows after Date & time with their descriptions, off by default and switchable", () => {
    const html = render(view({ sandbox: on, browser: on }));
    expect(html).toContain("Keeps files and runs commands in its own sandbox");
    expect(html).toContain("Opens web pages in a real browser");
    expect(html.indexOf("Date &amp; time")).toBeLessThan(html.indexOf(">Sandbox<"));
    const sandbox = switchOf(html, "sandbox");
    expect(sandbox).toContain('aria-label="Sandbox"');
    expect(sandbox).toContain('aria-checked="false"');
    expect(sandbox).not.toContain("aria-disabled");
  });

  it("is checked when the bot's switch is on and nothing stands in the way", () => {
    const html = render(view({ sandbox: { ...on, enabled: true }, browser: on }));
    expect(switchOf(html, "sandbox")).toContain('aria-checked="true"');
  });

  it("disables the rows with the API's reason: organization off, kill switch, service down", () => {
    const off = render(view({ sandbox: { ...on, available: false, reason: "org_off" }, browser: on }));
    expect(off).toContain("Turned off by your organization");
    expect(switchOf(off, "sandbox")).toContain('aria-disabled="true"');
    const killed = render(
      view({ sandbox: { enabled: true, available: false, reason: "killed" }, browser: on }),
    );
    expect(killed).toContain("An admin stopped all sandboxes");
    expect(switchOf(killed, "sandbox")).toContain('aria-checked="false"');
    const down = render(view({ sandbox: on, browser: { ...on, available: false, reason: "service_down" } }));
    expect(down).toContain("The sandbox service isn't reachable");
  });

  it("hides a row while its module is off for the viewer, and both on an API without them", () => {
    const html = render(view({ sandbox: { ...on, available: false, reason: "module_off" }, browser: on }));
    expect(html).not.toContain('data-testid="capability-sandbox"');
    expect(html).toContain('data-testid="capability-browser"');
    const old = render(view(undefined));
    expect(old).not.toContain('data-testid="capability-sandbox"');
    expect(old).not.toContain('data-testid="capability-browser"');
  });
});
