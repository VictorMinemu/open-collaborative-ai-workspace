import type { AgentCard, AgentCardStatus } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentCardView } from "./agent-card";
import { workSessionStatusWord } from "./work-session-card";

/**
 * 07.16-18 (D-12, PD-12, PD-20; E13): the live Work Zone card of a bot-started session in chat. The server composes
 * it (platform-owned, viewer-neutral fields only); the renderer reads only `workSessionCardOf(card)`, the status, its
 * label and the notices. A proposal card (with `approval`) and a bot's own `work_zone` card render as before.
 * Static markup in node, through the one card renderer (`AgentCardView`).
 */

const MESSAGE_ID = "01a11635-d6e7-7c87-9f17-b6b1dc048941";
const SESSION_ID = "0b8f5c2e-3a41-4d7e-9c55-7f1e2d3c4b5a";
const TWO_MIN_AGO = () => new Date(Date.now() - 2 * 60_000).toISOString();

function live(over: Partial<AgentCard> = {}, fields: Record<string, string> = {}): AgentCard {
  const values: Record<string, string> = {
    Runtime: "Claude Code",
    Project: "billing-api",
    Device: "billing-server",
    Model: "opus",
    Mode: "Supervised",
    Step: "Working · turn 1",
    Updated: TWO_MIN_AGO(),
    ...fields,
  };
  return {
    kind: "work_zone",
    title: "Work Zone · billing-api",
    fields: Object.entries(values).map(([label, value]) => ({ label, value })),
    status: "running",
    actions: [
      { kind: "open", label: "Open session", target: `/work-zone/${SESSION_ID}` },
      { kind: "follow", label: "Follow" },
    ],
    version: 1,
    decision: null,
    updatedAt: "2026-11-09T12:00:00.000Z",
    following: false,
    viewerCan: ["follow"],
    platformOwned: true,
    ...over,
  };
}

function render(card: AgentCard, summary = card.title): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AgentCardView messageId={MESSAGE_ID} card={card} summary={summary} authorName="Atlas" />
    </QueryClientProvider>,
  );
}

const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1] ?? "");
const buttons = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    (m[1] ?? "").replace(/<[^>]+>/g, "").trim(),
  );
const factOf = (html: string, label: string) =>
  new RegExp(
    `<dt[^>]*>${label}</dt><dd[^>]*data-testid="wz-live-${label.toLowerCase()}"[^>]*>([\\s\\S]*?)</dd>`,
  )
    .exec(html)?.[1]
    ?.replace(/<[^>]+>/g, "")
    .trim();

describe("WorkSessionCard: the live card of a bot's session (D-12, PD-20)", () => {
  it("renders the runtime logo, the title, Working, the facts and Open session to the session", () => {
    const html = render(live());
    expect(html).toContain('data-testid="agent-card"');
    expect(html).toContain(`data-live-session="${SESSION_ID}"`);
    expect(html).toContain("<title>Claude Code</title>");
    expect(html).toContain(">Work Zone · billing-api<");
    expect(html).toContain('aria-label="Status: Working"');
    expect(html).toContain('data-status="running"');
    // The workspace made it, not the bot (07.6 R1).
    expect(html).toContain('data-testid="agent-card-workspace"');
    expect(html).toContain("Claude Code · Supervised");
    expect(factOf(html, "Device")).toBe("billing-server");
    expect(factOf(html, "Model")).toBe("opus");
    expect(factOf(html, "Step")).toBe("Working · turn 1");
    expect(factOf(html, "Updated")).toBe("2 minutes ago");
    expect(hrefs(html)).toEqual([`/work-zone/${SESSION_ID}`]);
    expect(html).toMatch(/<a[^>]*data-testid="agent-card-open"[^>]*>[\s\S]*Open session[\s\S]*<\/a>/);
    expect(buttons(html)).toEqual(["Follow"]);
    // No generic field list: Runtime, Project and Mode live in the header, not as facts.
    expect(html).not.toContain('data-testid="agent-card-fields"');
  });

  it("two columns from md, one below; a full-width 44 px Open and Follow on mobile; no raw colours", () => {
    const html = render(live());
    expect(html).toMatch(/data-testid="wz-live-facts"[^>]*class="[^"]*grid-cols-1[^"]*md:grid-cols-2/);
    const open = /<a[^>]*data-testid="agent-card-open"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(open).toContain("max-md:h-11");
    expect(open).toContain("max-md:w-full");
    const follow = /<button[^>]*data-testid="agent-card-follow"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(follow).toContain("max-md:h-11");
    expect(follow).toContain("max-md:w-full");
  });

  it("says each status in its own word: the server's label first", () => {
    const cases: Array<[AgentCardStatus, string | undefined, string]> = [
      ["running", undefined, "Working"],
      ["pending", "Approval", "Approval"],
      ["pending", "Offline", "Offline"],
      ["cancelled", "Stopped", "Stopped"],
      ["info", "Idle", "Idle"],
      ["succeeded", undefined, "Ended"],
      ["failed", undefined, "Failed"],
    ];
    for (const [status, statusLabel, word] of cases) {
      const html = render(live({ status, ...(statusLabel ? { statusLabel } : {}) }));
      expect(html, `${status}/${statusLabel}`).toContain(`aria-label="Status: ${word}"`);
      expect(workSessionStatusWord(status, statusLabel)).toBe(word);
    }
  });

  it("shows the Full access badge only when the mode is Full access", () => {
    expect(render(live())).not.toContain('data-testid="full-access-badge"');
    const full = render(live({}, { Mode: "Full access" }));
    expect(full).toContain('data-testid="full-access-badge"');
    expect(full).not.toContain("Claude Code · Full access");
  });

  it("a Codex session gets the Codex logo", () => {
    const html = render(live({}, { Runtime: "Codex" }));
    expect(html).toContain("<title>Codex</title>");
    expect(html).toContain("Codex · Supervised");
  });

  it("shows the server's notices and Following when followed", () => {
    const html = render(
      live({
        following: true,
        notices: [{ tone: "neutral", text: "Wake-up limit reached for today." }],
      }),
    );
    expect(html).toContain('data-testid="agent-card-notice"');
    expect(html).toContain("Wake-up limit reached for today.");
    expect(buttons(html)).toEqual(["Following"]);
  });

  it("renders no prompt, output or title text even when a field carries one (E13, T-07.16-18-02)", () => {
    const html = render(
      live({}, { Prompt: "SECRET-PROMPT fix invoices", Output: "SECRET-OUTPUT", Title: "SECRET-TITLE" }),
    );
    expect(html).not.toContain("SECRET-");
  });

  it("an unparseable Updated value is shown as it came", () => {
    expect(factOf(render(live({}, { Updated: "a moment ago" })), "Updated")).toBe("a moment ago");
  });
});

describe("AgentCardView dispatch: only live cards change (P4)", () => {
  it("a bot's own work_zone card (not platform-owned) renders as the generic card", () => {
    const html = render(live({ platformOwned: false }));
    expect(html).not.toContain("data-live-session");
    expect(html).toContain('data-testid="agent-card-fields"');
    expect(html).toMatch(/<dt[^>]*>Runtime<\/dt>/);
  });

  it("a platform card whose Open target is not a session renders as the generic card", () => {
    const html = render(
      live({
        actions: [
          { kind: "open", label: "Open", target: "/work-zone" },
          { kind: "follow", label: "Follow" },
        ],
      }),
    );
    expect(html).not.toContain("data-live-session");
    expect(html).toContain('data-testid="agent-card-fields"');
  });
});
