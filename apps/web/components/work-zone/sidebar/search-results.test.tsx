import type { WorkSession, WorkSessionVisibilitySummary } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRowModel, RepoRowModel, SearchModel, SettledModel } from "./model";
import { SidebarSearchResults } from "./search-results";
import { SettledSection } from "./settled-section";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * Settled as a collapsed section (07.10-04, D-04, UI-SPEC § 8) and the grouped search results (D-08, § 11) as static
 * markup: the existing Settled test ids on the new section, no count on Settled, grouped results with one heading
 * per group, project and repository rows without "+", and a polite live region.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const NOW = Date.parse("2026-10-27T12:00:00Z");
const ANA = "01a11635-d6e7-7c87-9f17-0000000000a1";
const noop = () => {};

const vis = (): WorkSessionVisibilitySummary => ({
  kind: "project",
  activeCount: 0,
  differsFromDefault: false,
  firstTeamName: null,
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
    branch: "main",
    status: "completed",
    title: `Session ${n}`,
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
    createdAt: "2026-10-27T10:00:00Z",
    updatedAt: "2026-10-27T11:00:00Z",
    visibility: vis(),
    teamProject: { id: "01a11635-d6e7-7c87-9f17-0000000000d1", name: "Customer portal" },
    ...over,
  };
}

const settled = (over: Partial<SettledModel> = {}): SettledModel => ({
  key: "settled",
  collapsed: false,
  rows: [],
  total: 0,
  more: 0,
  expanded: false,
  ...over,
});

const project = (over: Partial<ProjectRowModel> = {}): ProjectRowModel => ({
  id: "01a11635-d6e7-7c87-9f17-0000000000d1",
  name: "Customer portal",
  pill: null,
  live: 0,
  sessions: [],
  more: 0,
  active: false,
  repoCount: 1,
  ...over,
});

const repo = (over: Partial<RepoRowModel> = {}): RepoRowModel => ({
  projectId: "01a11635-d6e7-7c87-9f17-0000000000b2",
  name: "scratch",
  hiddenProject: false,
  live: 0,
  sessions: [],
  more: 0,
  expanded: false,
  ...over,
});

const group = <T,>(rows: T[], total = rows.length, expanded = false) => ({ rows, total, expanded });

function result(over: Partial<SearchModel> = {}): SearchModel {
  const base: SearchModel = {
    projects: group([]),
    sessions: group([]),
    repos: group([]),
    count: 0,
    ...over,
  };
  return { ...base, count: base.projects.total + base.sessions.total + base.repos.total };
}

const ctx = { now: NOW, viewerId: ANA, openSessionId: null, onToggle: noop, onExpand: noop };

describe("SettledSection", () => {
  it("is absent when nothing settled", () => {
    expect(html(<SettledSection model={null} {...ctx} />)).toBe("");
  });

  it("collapsed: the existing ids on the shared header, no rows and no count (history is not news)", () => {
    const out = html(<SettledSection model={settled({ collapsed: true, total: 4 })} {...ctx} />);
    expect(out).toMatch(/<section[^>]*data-testid="settled-group"/);
    expect(out).toContain('data-section="settled"');
    expect(out).toMatch(/data-testid="settled-toggle"[^>]*aria-expanded="false"/);
    expect(out).toContain('aria-controls="wz-list-settled"');
    expect(out).toContain(">Settled<");
    expect(out).not.toContain('data-testid="section-count"');
    expect(out).not.toContain('data-testid="session-row"');
  });

  it("open: the existing settled rows, then Show {n} more as an expanding button", () => {
    const rows = [session({ title: "One" }), session({ title: "Two", status: "failed" })];
    const out = html(<SettledSection model={settled({ rows, total: 12, more: 10 })} {...ctx} />);
    expect(out).toMatch(/data-testid="settled-toggle"[^>]*aria-expanded="true"/);
    expect(out.match(/data-testid="session-row"/g)).toHaveLength(2);
    expect(out).toContain('data-status="failed"');
    expect(out).toMatch(/data-testid="settled-more"[^>]*aria-expanded="false"[^>]*>.*Show 10 more</);
    const all = html(<SettledSection model={settled({ rows, total: 2, expanded: true })} {...ctx} />);
    expect(all).toMatch(/data-testid="settled-more"[^>]*aria-expanded="true"[^>]*>.*Show fewer</);
  });
});

describe("SidebarSearchResults", () => {
  it("nothing found: one muted line naming the query", () => {
    const out = html(<SidebarSearchResults query="zzz" result={result()} {...ctx} />);
    expect(out).toContain("Nothing matches “zzz”.");
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain(">0 results<");
  });

  it("groups projects, sessions and repositories under one heading each, in a labelled section", () => {
    const active = session({ title: "Live one", status: "running", runningSince: "2026-10-27T11:59:50Z" });
    const done = session({ title: "Done one" });
    const out = html(
      <SidebarSearchResults
        query="one"
        result={result({
          projects: group([
            { row: project(), muted: false },
            { row: project({ id: "01a11635-d6e7-7c87-9f17-0000000000d2", name: "Payroll" }), muted: true },
          ]),
          sessions: group([active, done], 12),
          repos: group([repo()]),
        })}
        {...ctx}
      />,
    );
    expect(out).toMatch(/<section aria-label="Search results" data-testid="sidebar-search-results"/);
    for (const g of ["projects", "sessions", "repos"])
      expect(out).toContain(`data-testid="search-group-${g}"`);
    expect(out.match(/<h3/g)).toHaveLength(3);
    expect(out).toMatch(/<h3[^>]*>Projects<\/h3>/);
    expect(out).toMatch(/<h3[^>]*>Sessions<\/h3>/);
    expect(out).toMatch(/<h3[^>]*>Repositories<\/h3>/);
    // Project and repository rows have no "+" (X5); a non-member project is muted.
    expect(out).not.toContain("project-new-session");
    expect(out).not.toContain("repo-new-session");
    expect(out).toMatch(
      /data-testid="project-row-01a11635-d6e7-7c87-9f17-0000000000d2"[^>]*class="[^"]*text-muted-foreground/,
    );
    // An active session in the needs-you look with its status; a settled one as the Settled row.
    expect(out).toMatch(/aria-label="Live one, Working 10s, in Customer portal"/);
    expect(out).toContain('data-status="completed"');
    expect(out.match(/data-testid="session-row"/g)).toHaveLength(2);
    // "Show all {n}" where the group is capped.
    expect(out).toMatch(/data-testid="search-more-sessions"[^>]*aria-expanded="false"[^>]*>Show all 12</);
    expect(out).not.toContain('data-testid="search-more-projects"');
    expect(out).toContain(">15 results<");
    expect(out).not.toContain("Nothing matches");
  });

  it("omits empty groups and says one result in the singular", () => {
    const out = html(
      <SidebarSearchResults query="scr" result={result({ repos: group([repo()]) })} {...ctx} />,
    );
    expect(out).not.toContain("search-group-projects");
    expect(out).not.toContain("search-group-sessions");
    expect(out).toContain(">1 result<");
  });
});
