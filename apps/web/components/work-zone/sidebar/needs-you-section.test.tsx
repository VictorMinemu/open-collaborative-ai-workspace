import type { WorkSession, WorkSessionVisibilitySummary } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NeedsYouModel } from "./model";
import { NeedsYouRow, NeedsYouSection } from "./needs-you-section";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * Needs you (07.10-04, D-05, UI-SPEC § 3, Accessibility Contract "Needs-you row") as static markup: one line per
 * session with its project badge, title, the 07.9 marker and the reason in the right slot; the project is named only
 * to screen readers and in the hover title; the section is absent when empty.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const NOW = Date.parse("2026-10-27T12:00:00Z");
const ANA = "01a11635-d6e7-7c87-9f17-0000000000a1";

const vis = (over: Partial<WorkSessionVisibilitySummary> = {}): WorkSessionVisibilitySummary => ({
  kind: "project",
  activeCount: 0,
  differsFromDefault: false,
  firstTeamName: null,
  ...over,
});

let n = 0;
function session(over: Partial<WorkSession> = {}): WorkSession {
  n += 1;
  const id = `01a11635-d6e7-7c87-9f17-${String(n).padStart(12, "0")}`;
  return {
    id,
    conversationId: id,
    projectId: "01a11635-d6e7-7c87-9f17-0000000000b1",
    projectName: "web-app",
    deviceId: "01a11635-d6e7-7c87-9f17-0000000000c1",
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    runtime: "claude-code",
    model: null,
    permissionMode: "default",
    worktree: false,
    branch: "fix/login",
    status: "waiting_approval",
    title: "Fix the login redirect",
    titleSource: "user",
    createdBy: ANA,
    createdByName: "Ana Ruiz",
    queuedCount: 0,
    pendingApprovals: 1,
    lastError: null,
    settings: {} as WorkSession["settings"],
    fullAccess: false,
    runningSince: null,
    diffStat: null,
    createdAt: "2026-10-27T11:00:00Z",
    updatedAt: "2026-10-27T11:58:00Z",
    visibility: vis(),
    teamProject: { id: "01a11635-d6e7-7c87-9f17-0000000000d1", name: "Customer portal" },
    attention: { approval: true, lastTurnEndedAt: null },
    ...over,
  };
}

const model = (over: Partial<NeedsYouModel> = {}): NeedsYouModel => ({
  key: "needs",
  collapsed: false,
  rows: [],
  more: 0,
  expanded: false,
  hidden: 0,
  ...over,
});

const noop = () => {};

describe("NeedsYouRow", () => {
  it("an approval: badge, title, the warning reason; the project only in sr-only text, the title and the name", () => {
    const s = session();
    const out = html(
      <NeedsYouRow s={s} reason="approval" place="Customer portal" active={false} viewerId={ANA} />,
    );
    expect(out).toContain('data-testid="needs-you-row"');
    expect(out).toContain(`href="/work-zone/${s.id}"`);
    expect(out).toMatch(/data-testid="row-project-badge"[^>]*>CP</);
    expect(out).toMatch(/data-testid="row-title"[^>]*>Fix the login redirect</);
    expect(out).toMatch(/data-testid="row-status" data-tone="warning"[^>]*class="[^"]*text-amber-700/);
    // 07.10-07 (UI review fix 2): the icon and "Approval" show, so the title keeps its width; the full words stay in
    // the link's name and the reason's tooltip.
    const status = out.match(/<span data-testid="row-status"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? "";
    expect(status).toContain('title="Needs approval"');
    expect(status.replace(/<[^>]+>/g, "")).toBe("Approval");
    expect(out).toContain("lucide-hand");
    expect(out).toMatch(/<span data-testid="row-project" class="sr-only">Customer portal<\/span>/);
    expect(out).toContain('title="Fix the login redirect · Customer portal"');
    expect(out).toContain('aria-label="Fix the login redirect, Needs approval, in Customer portal"');
    expect(out).toContain("max-md:h-11");
    // Silence on the default (N2): no marker.
    expect(out).not.toContain('data-testid="visibility-marker"');
  });

  it("your turn: plain foreground text, no icon, no colour", () => {
    const s = session({ status: "idle", pendingApprovals: 0 });
    const out = html(
      <NeedsYouRow s={s} reason="turn" place="Customer portal" active={false} viewerId={ANA} />,
    );
    expect(out).toMatch(/data-testid="row-status" data-tone="foreground"[^>]*class="[^"]*text-foreground/);
    expect(out).toContain(">Your turn<");
    expect(out).not.toContain("lucide-hand");
    const status = out.match(/<span data-testid="row-status"[^>]*>[^<]*<\/span>/)?.[0] ?? "";
    expect(status).not.toMatch(/amber|text-primary/);
    expect(out).toContain('aria-label="Fix the login redirect, Your turn, in Customer portal"');
  });

  it("carries the 07.9 marker after the title and its suffix in the name when the audience differs", () => {
    const s = session({ visibility: vis({ kind: "owner", differsFromDefault: true }) });
    const out = html(<NeedsYouRow s={s} reason="approval" place="web-app" active viewerId={ANA} />);
    expect(out).toContain('data-testid="visibility-marker"');
    expect(out.indexOf('data-testid="row-title"')).toBeLessThan(
      out.indexOf('data-testid="visibility-marker"'),
    );
    expect(out).toContain(
      'aria-label="Fix the login redirect, Needs approval, in web-app, only visible to you"',
    );
    expect(out).toContain('aria-current="page"');
  });
});

describe("NeedsYouSection", () => {
  it("is absent when nothing waits on the viewer", () => {
    expect(
      html(
        <NeedsYouSection
          model={null}
          now={NOW}
          viewerId={ANA}
          openSessionId={null}
          onToggle={noop}
          onExpand={noop}
        />,
      ),
    ).toBe("");
  });

  it("is a labelled section with the shared header and one list of rows, then Show {n} more", () => {
    const rows = [session({ title: "one" }), session({ title: "two" })].map((s) => ({
      session: s,
      reason: "approval" as const,
      place: "Customer portal",
    }));
    const out = html(
      <NeedsYouSection
        model={model({ rows, more: 3 })}
        now={NOW}
        viewerId={ANA}
        openSessionId={null}
        onToggle={noop}
        onExpand={noop}
      />,
    );
    expect(out).toContain('data-testid="needs-you"');
    expect(out).toContain('aria-labelledby="wz-section-needs"');
    expect(out).toContain('id="wz-section-needs"');
    expect(out).toContain('aria-controls="wz-list-needs"');
    expect(out).toContain(">Needs you<");
    expect(out.match(/data-testid="needs-you-row"/g)).toHaveLength(2);
    expect(out).toMatch(/<button[^>]*data-testid="needs-more"[^>]*aria-expanded="false"[^>]*>Show 3 more</);
  });

  it("collapsed: the count pill of what it hides, and no rows", () => {
    const out = html(
      <NeedsYouSection
        model={model({ collapsed: true, hidden: 2 })}
        now={NOW}
        viewerId={ANA}
        openSessionId={null}
        onToggle={noop}
        onExpand={noop}
      />,
    );
    expect(out).toContain('data-collapsed="true"');
    expect(out).toMatch(/data-testid="section-count"[^>]*>2</);
    expect(out).toContain(", 2 hidden");
    expect(out).not.toContain('data-testid="needs-you-row"');
  });

  it("expanded inline reads Show fewer", () => {
    const rows = [{ session: session(), reason: "turn" as const, place: "Customer portal" }];
    const out = html(
      <NeedsYouSection
        model={model({ rows, expanded: true })}
        now={NOW}
        viewerId={ANA}
        openSessionId={null}
        onToggle={noop}
        onExpand={noop}
      />,
    );
    expect(out).toMatch(/aria-expanded="true"[^>]*>Show fewer</);
  });
});
