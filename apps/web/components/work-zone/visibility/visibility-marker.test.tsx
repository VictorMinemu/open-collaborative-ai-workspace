import type { WorkSession, WorkSessionVisibilitySummary } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { orderActiveSessions, rowProject, SettledRow } from "../session-sidebar";
import { NeedsYouRow } from "../sidebar/needs-you-section";
import { SessionSubRow } from "../sidebar/rows";
import { RecentSessionRow } from "../work-zone-home";
import { VisibilityMarker, VisibilitySrSuffix } from "./visibility-marker";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The sidebar marker (07.9-09, UI-SPEC Surface 2, D-07, N2, N5): silence on the default, one muted 12 px icon with a
 * screen-reader suffix on the row link otherwise; rows group under their team project (R10). Static markup in node;
 * the API decides who can see a session and whether it differs from the project's default.
 */

const ANA = "01a11635-d6e7-7c87-9f17-0000000000a1";
const LEO = "01a11635-d6e7-7c87-9f17-0000000000a2";
const NOW = Date.parse("2026-10-22T12:00:00Z");

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
    status: "running",
    title: "Fix the login redirect",
    titleSource: "user",
    createdBy: ANA,
    createdByName: "Ana Ruiz",
    queuedCount: 0,
    pendingApprovals: 0,
    lastError: null,
    settings: {} as WorkSession["settings"],
    fullAccess: false,
    runningSince: null,
    diffStat: null,
    createdAt: "2026-10-22T11:00:00Z",
    updatedAt: "2026-10-22T11:58:00Z",
    visibility: vis(),
    teamProject: { id: "01a11635-d6e7-7c87-9f17-0000000000d1", name: "Customer portal" },
    ...over,
  };
}

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const markers = (markup: string) => markup.match(/data-testid="visibility-marker"/g)?.length ?? 0;

describe("VisibilityMarker", () => {
  it("renders nothing when the session follows its project's default", () => {
    expect(html(<VisibilityMarker session={session()} viewerId={ANA} />)).toBe("");
    expect(html(<VisibilityMarker session={session({ visibility: undefined })} viewerId={ANA} />)).toBe("");
    expect(
      html(
        <VisibilityMarker
          session={session({ visibility: vis({ kind: "owner", differsFromDefault: false }) })}
          viewerId={ANA}
        />,
      ),
    ).toBe("");
  });

  it("shows one muted 12 px lock, icon only, for Only me under a default-on project", () => {
    const out = html(
      <VisibilityMarker
        session={session({ visibility: vis({ kind: "owner", differsFromDefault: true }) })}
        viewerId={ANA}
      />,
    );
    expect(markers(out)).toBe(1);
    expect(out).toContain('data-kind="lock"');
    const svg = out.match(/<svg[^>]*>/)?.[0] ?? "";
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toMatch(/class="[^"]*\bsize-3\b[^"]*text-muted-foreground\/80/);
    expect(out).toContain("lucide-lock");
    // No visible text: the meaning is in the tooltip and the row link's suffix.
    expect(out.replace(/<[^>]+>/g, "")).toBe("");
  });

  it("shows people and project icons, never a colour", () => {
    const people = html(
      <VisibilityMarker
        session={session({ visibility: vis({ kind: "people", activeCount: 2, differsFromDefault: true }) })}
        viewerId={LEO}
      />,
    );
    expect(people).toContain('data-kind="users"');
    const project = html(
      <VisibilityMarker
        session={session({ visibility: vis({ kind: "project", differsFromDefault: true }) })}
        viewerId={LEO}
      />,
    );
    expect(project).toContain('data-kind="project"');
    for (const out of [people, project])
      expect(out).not.toMatch(/text-primary|bg-primary|amber|text-red|destructive|violet/);
  });

  it("gives the row link its meaning in a screen-reader suffix", () => {
    const mine = session({ visibility: vis({ kind: "owner", differsFromDefault: true }) });
    expect(html(<VisibilitySrSuffix session={mine} viewerId={ANA} />)).toBe(
      '<span class="sr-only">, only visible to you</span>',
    );
    expect(html(<VisibilitySrSuffix session={mine} viewerId={LEO} />)).toBe(
      '<span class="sr-only">, only visible to Ana Ruiz</span>',
    );
    expect(html(<VisibilitySrSuffix session={session()} viewerId={ANA} />)).toBe("");
  });
});

describe("sidebar rows", () => {
  const marked = session({ visibility: vis({ kind: "owner", differsFromDefault: true }) });

  // 07.10-04: the three-line active row is retired; its cases run on the one-line rows that replaced it (the sub-row
  // under a project and the needs-you row). The branch line is gone (UI-SPEC § 6, X4): the marker now comes before
  // the right slot (`row-status`), where it came before `row-branch`.
  const activeRows = (s: WorkSession) => [
    html(<SessionSubRow s={s} now={NOW} active={false} viewerId={ANA} />),
    html(<NeedsYouRow s={s} reason="approval" place={rowProject(s).name} active={false} viewerId={ANA} />),
  ];

  it("an active row of a marked session carries the marker after the title and the suffix in its link", () => {
    for (const out of activeRows(marked)) {
      expect(markers(out)).toBe(1);
      expect(out).toContain('<span class="sr-only">, only visible to you</span>');
      expect(out.indexOf('data-testid="row-title"')).toBeLessThan(
        out.indexOf('data-testid="visibility-marker"'),
      );
      expect(out.indexOf('data-testid="visibility-marker"')).toBeLessThan(
        out.indexOf('data-testid="row-status"'),
      );
    }
  });

  it("a settled row carries it before the diff stat", () => {
    const s = session({
      ...marked,
      status: "completed",
      diffStat: { files: 2, additions: 12, deletions: 1 },
    });
    const out = html(<SettledRow s={s} now={NOW} active={false} viewerId={ANA} />);
    expect(markers(out)).toBe(1);
    expect(out).toContain("sr-only");
    expect(out.indexOf('data-testid="visibility-marker"')).toBeLessThan(
      out.indexOf('data-testid="row-diffstat"'),
    );
  });

  it("rows on the default render exactly as before: no marker, no suffix, no new element", () => {
    const [sub = "", needs = ""] = activeRows(session());
    const settled = html(
      <SettledRow s={session({ status: "completed" })} now={NOW} active={false} viewerId={ANA} />,
    );
    for (const out of [sub, settled]) {
      expect(markers(out)).toBe(0);
      expect(out).not.toContain("sr-only");
    }
    // The needs-you row's only sr-only text is its project (UI-SPEC § 3): no visibility suffix on the default.
    expect(markers(needs)).toBe(0);
    expect(needs.match(/class="sr-only"/g)).toHaveLength(1);
    expect(needs).toMatch(/<span data-testid="row-project" class="sr-only">Customer portal<\/span>/);
    // The title is still a direct child of the link (no wrapper on the default).
    for (const out of [sub, needs]) expect(out).toMatch(/<\/span><span data-testid="row-title"/);
  });

  it("labels and badges a linked session with its team project, an unlinked one with its repository", () => {
    expect(rowProject(session())).toEqual({
      key: "01a11635-d6e7-7c87-9f17-0000000000d1",
      name: "Customer portal",
    });
    const personal = session({ teamProject: null, projectName: "scratch" });
    expect(rowProject(personal)).toEqual({ key: personal.projectId, name: "scratch" });
    const [, out = ""] = activeRows(session());
    expect(out).toMatch(/data-testid="row-project-badge"[^>]*>CP</);
    expect(out).toMatch(/data-testid="row-project"[^>]*>Customer portal</);
    const [, mine = ""] = activeRows(personal);
    expect(mine).toMatch(/data-testid="row-project-badge"[^>]*>SC</);
    expect(mine).toMatch(/data-testid="row-project"[^>]*>scratch</);
  });

  it("two repositories of one team project sort together; an unlinked repository keeps its own group", () => {
    const portal = { id: "01a11635-d6e7-7c87-9f17-0000000000d1", name: "Customer portal" };
    const a = session({
      projectId: "01a11635-d6e7-7c87-9f17-0000000000b1",
      projectName: "web-app",
      teamProject: portal,
      updatedAt: "2026-10-22T11:59:00Z",
    });
    const solo = session({
      projectId: "01a11635-d6e7-7c87-9f17-0000000000b9",
      projectName: "scratch",
      teamProject: null,
      updatedAt: "2026-10-22T11:58:00Z",
    });
    const b = session({
      projectId: "01a11635-d6e7-7c87-9f17-0000000000b2",
      projectName: "api",
      teamProject: portal,
      updatedAt: "2026-10-22T11:57:00Z",
    });
    expect(orderActiveSessions([solo, b, a]).map((s) => s.id)).toEqual([a.id, b.id, solo.id]);
  });
});

describe("home recent sessions", () => {
  it("render the marker by the same rule", () => {
    const marked = session({ visibility: vis({ kind: "teams", activeCount: 2, differsFromDefault: true }) });
    const out = html(<RecentSessionRow s={marked} viewerId={ANA} />);
    expect(markers(out)).toBe(1);
    expect(out).toContain('data-kind="users"');
    expect(out).toContain('<span class="sr-only">, visible to 2 teams</span>');
    const plain = html(<RecentSessionRow s={session()} viewerId={ANA} />);
    expect(markers(plain)).toBe(0);
    expect(plain).not.toContain("sr-only");
  });
});
