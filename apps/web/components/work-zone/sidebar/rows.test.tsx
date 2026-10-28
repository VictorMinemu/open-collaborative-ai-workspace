import type { Project, WorkSession, WorkSessionVisibilitySummary } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRowModel, RepoRowModel } from "./model";
import { OnboardingLine } from "./onboarding-line";
import { HIDDEN_PROJECT_HINT, MoreRow, ProjectRow, RepoRow, SessionSubRow, subRowDetail } from "./rows";
import { fallbackGroups, ProjectsFallback, ProjectsLoading, startableTargets } from "./sections";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The Work Zone sidebar rows (07.10-03, UI-SPEC § 5-§ 7, Accessibility Contract) as static markup: silence on the
 * default audience (N2), the 07.9 marker only where it differs, project links that say their team and live count to
 * screen readers, repository rows that are not links and carry the hidden-project hint only when it applies.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const NOW = Date.parse("2026-10-27T12:00:00Z");
const ANA = "01a11635-d6e7-7c87-9f17-0000000000a1";
const PORTAL = "01a11635-d6e7-7c87-9f17-0000000000d1";
const REPO = "01a11635-d6e7-7c87-9f17-0000000000b1";

const vis = (over: Partial<WorkSessionVisibilitySummary> = {}): WorkSessionVisibilitySummary => ({
  kind: "project",
  activeCount: 0,
  differsFromDefault: false,
  firstTeamName: null,
  ...over,
});

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "01a11635-d6e7-7c87-9f17-0000000000c9",
    conversationId: "01a11635-d6e7-7c87-9f17-0000000000c9",
    projectId: REPO,
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
    runningSince: "2026-10-27T11:58:00Z",
    diffStat: null,
    createdAt: "2026-10-27T11:00:00Z",
    updatedAt: "2026-10-27T11:58:00Z",
    visibility: vis(),
    teamProject: { id: PORTAL, name: "Customer portal" },
    ...over,
  };
}

const projectRow = (over: Partial<ProjectRowModel> = {}): ProjectRowModel => ({
  id: PORTAL,
  name: "Customer portal",
  pill: null,
  live: 0,
  sessions: [],
  more: 0,
  active: false,
  repoCount: 1,
  ...over,
});

const repoRow = (over: Partial<RepoRowModel> = {}): RepoRowModel => ({
  projectId: REPO,
  name: "scratch",
  hiddenProject: false,
  live: 0,
  sessions: [],
  more: 0,
  expanded: false,
  ...over,
});

const markers = (markup: string) => markup.match(/data-testid="visibility-marker"/g)?.length ?? 0;
/** The text a screen reader reads for a link: its aria-label, else its text (sr-only included). */
const spoken = (markup: string) => {
  const label = markup.match(/^<a[^>]*aria-label="([^"]*)"/)?.[1];
  return (label ?? markup.replace(/<[^>]+>/g, "")).replace(/&#x27;/g, "'");
};

describe("SessionSubRow", () => {
  it("a default-audience row renders no marker and no screen-reader suffix (N2)", () => {
    const out = html(<SessionSubRow s={session()} now={NOW} active={false} viewerId={ANA} />);
    expect(markers(out)).toBe(0);
    expect(out).not.toContain("sr-only");
    expect(spoken(out)).toBe("Fix the login redirect, Working 2m");
    expect(out).toContain('data-testid="row-status" data-tone="primary"');
  });

  it("a row whose audience differs renders the marker after the title and the suffix in its name", () => {
    const s = session({ visibility: vis({ kind: "owner", differsFromDefault: true }) });
    const out = html(<SessionSubRow s={s} now={NOW} active={false} viewerId={ANA} />);
    expect(markers(out)).toBe(1);
    expect(out).toContain('<span class="sr-only">, only visible to you</span>');
    expect(out.indexOf('data-testid="row-title"')).toBeLessThan(
      out.indexOf('data-testid="visibility-marker"'),
    );
    expect(spoken(out)).toBe("Fix the login redirect, Working 2m, only visible to you");
  });

  it("is one line: no spinner, the full title and its detail in title attributes, aria-current when open", () => {
    const s = session({ diffStat: { files: 2, additions: 12, deletions: 3 } });
    const out = html(<SessionSubRow s={s} now={NOW} active viewerId={ANA} />);
    expect(out).toContain('aria-current="page"');
    expect(out).not.toContain("animate-spin");
    expect(out).toContain('title="Fix the login redirect"');
    expect(subRowDetail(s)).toBe("Fix the login redirect · Claude Code · fix/login · +12 −3");
    expect(subRowDetail(session({ branch: null }))).toBe(
      "Fix the login redirect · Claude Code · Ana's MacBook",
    );
    expect(out).toMatch(/class="[^"]*\bh-7\b[^"]*\bpl-8\b[^"]*max-md:h-11/);
  });

  it("an approval reads Needs approval in the warning tone, with the hand glyph", () => {
    const out = html(
      <SessionSubRow s={session({ status: "waiting_approval" })} now={NOW} active={false} viewerId={ANA} />,
    );
    expect(out).toContain('data-tone="warning"');
    expect(out).toContain("lucide-hand");
    expect(spoken(out)).toBe("Fix the login redirect, Needs approval");
  });
});

describe("ProjectRow", () => {
  it("links to the project page and says its team and live count to screen readers", () => {
    const out = html(<ProjectRow project={projectRow({ pill: "Web", live: 2 })} />);
    expect(out).toContain(`href="/work-zone/projects/${PORTAL}"`);
    expect(out).toContain(`data-testid="project-row-${PORTAL}"`);
    expect(spoken(out)).toContain("Customer portal, Web, 2 running");
    expect(out).toMatch(/data-testid="project-pill" aria-hidden="true"[^>]*>Web</);
    expect(out).toMatch(/data-testid="project-live-count" aria-hidden="true"/);
    expect(out).toContain("lucide-folder-kanban");
  });

  it("gives the name the width before the team pill: the pill shrinks (≤ 35 %), the name keeps a minimum (07.10-07)", () => {
    const out = html(<ProjectRow project={projectRow({ pill: "Web", live: 2 })} />);
    const pill = out.match(/<span data-testid="project-pill"[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(pill.split(" ")).toEqual(expect.arrayContaining(["max-w-[35%]", "min-w-0", "shrink", "truncate"]));
    expect(pill).not.toContain("shrink-0");
    const name = out.match(/<span title="Customer portal" class="([^"]*)"/)?.[1] ?? "";
    expect(name.split(" ")).toEqual(expect.arrayContaining(["min-w-[55%]", "flex-1", "truncate"]));
  });

  it("is one quiet line with no pill and no count when neither applies; active when its page is open", () => {
    const out = html(<ProjectRow project={projectRow({ active: true })} />);
    expect(out).not.toContain("project-pill");
    expect(out).not.toContain("project-live-count");
    expect(out).not.toContain("sr-only");
    expect(out).toContain('aria-current="page"');
    expect(out).toContain('data-active="true"');
  });
});

describe("RepoRow", () => {
  it("is not a link and names only the repository", () => {
    const out = html(<RepoRow repo={repoRow({ live: 1 })} />);
    expect(out).not.toContain("<a");
    expect(out).toContain(`data-testid="repo-row-${REPO}"`);
    expect(out).toContain("scratch");
    expect(out).toContain("lucide-folder-git-2");
    expect(out).toContain('data-testid="repo-live-count"');
    expect(out).not.toContain(HIDDEN_PROJECT_HINT);
  });

  it("carries the fixed hint, and nothing else, when its project is hidden from the viewer", () => {
    expect(HIDDEN_PROJECT_HINT).toBe("Linked to a project you can't open");
    const out = html(<RepoRow repo={repoRow({ hiddenProject: true })} />);
    expect(out).toContain('title="Linked to a project you can&#x27;t open"');
    // 07.10-07 (LO-04): screen-reader and touch users get the hint too, not only a pointer's tooltip.
    expect(out).toContain('<span class="sr-only">, Linked to a project you can&#x27;t open</span>');
    expect(html(<RepoRow repo={repoRow()} />)).not.toContain('sr-only">, Linked');
  });
});

describe('the row "+" (07.10-05, R5, § 5, § 7)', () => {
  const noop = () => {};

  it('a project row has no "+" without onNewSession or without a repository; the row markup is unchanged then', () => {
    const plain = html(<ProjectRow project={projectRow({ live: 2 })} />);
    expect(plain).not.toContain("project-new-session");
    expect(html(<ProjectRow project={projectRow({ live: 2, repoCount: 0 })} onNewSession={noop} />)).toBe(
      plain,
    );
  });

  it('a project "+" is a named button beside the link (never inside it), in the count\'s slot, mouse only', () => {
    const out = html(<ProjectRow project={projectRow({ live: 2 })} onNewSession={noop} />);
    const plus = out.match(/<button[^>]*data-testid="project-new-session"[^>]*>/)?.[0] ?? "";
    expect(plus).toContain('aria-label="New session in Customer portal"');
    expect(plus).toContain('type="button"');
    expect(plus).toContain("pointer-coarse:hidden");
    expect(plus).toContain("absolute");
    // Not nested in the link: the link closes before the button opens.
    expect(out.indexOf("</a>")).toBeLessThan(out.indexOf('data-testid="project-new-session"'));
    // The count gives its place to the "+" with a pointer (no width change: visibility only).
    expect(out).toMatch(
      /data-testid="project-live-count"[^>]*class="[^"]*pointer-fine:group-hover\/project:invisible/,
    );
  });

  it("with no count, the \"+\" takes the pill's place on hover; no fixed 24 px gutter steals the name's width (07.10-07)", () => {
    const withPill = html(<ProjectRow project={projectRow({ pill: "Web", live: 0 })} onNewSession={noop} />);
    // No reserved spacer beside the link's content.
    expect(withPill).not.toMatch(/<span aria-hidden="true" class="[^"]*\bw-6\b/);
    const pill = withPill.match(/<span data-testid="project-pill"[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(pill).toContain("pointer-fine:group-hover/project:invisible");
    expect(pill).toContain("pointer-fine:group-has-[:focus-visible]/project:invisible");
    expect(pill).toContain("pointer-fine:min-w-6");
    // No pill and no count: the name keeps its box and only its text stops short of the "+" while it shows.
    const bare = html(<ProjectRow project={projectRow({ live: 0 })} onNewSession={noop} />);
    expect(bare).not.toMatch(/<span aria-hidden="true" class="[^"]*\bw-6\b/);
    const name = bare.match(/<span title="Customer portal" class="([^"]*)"/)?.[1] ?? "";
    expect(name).toContain("pointer-fine:group-hover/project:pr-7");
    // Without a "+" nothing of this applies.
    const plain = html(<ProjectRow project={projectRow({ pill: "Web", live: 0 })} />);
    expect(plain).not.toContain("group-hover/project:invisible");
  });

  it('a repository "+" is named with the repository, visible on touch with a 44 px target', () => {
    const out = html(<RepoRow repo={repoRow({ live: 1 })} onNewSession={noop} />);
    const plus = out.match(/<button[^>]*data-testid="repo-new-session"[^>]*>/)?.[0] ?? "";
    expect(plus).toContain('aria-label="New session in scratch"');
    expect(plus).toContain("max-md:size-11");
    expect(plus).toContain("[@media(hover:none)]:opacity-100");
    expect(html(<RepoRow repo={repoRow()} />)).not.toContain("repo-new-session");
  });

  it('a repository linked to a project the viewer can\'t open has no "+" (no start is possible there, D-14)', () => {
    const out = html(<RepoRow repo={repoRow({ hiddenProject: true })} onNewSession={noop} />);
    expect(out).not.toContain("repo-new-session");
  });
});

describe('startableTargets (07.10-05: a row "+" only where the viewer can start)', () => {
  const repo = (id: string, over: Partial<Project> = {}): Project => ({
    id: `01a11635-d6e7-7c87-9f17-0000000000${id}`,
    deviceId: "01a11635-d6e7-7c87-9f17-0000000000c1",
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    name: `repo-${id}`,
    gitRemote: null,
    defaultBranch: "main",
    available: true,
    createdAt: "2026-10-22T10:00:00Z",
    teamProject: null,
    ...over,
  });
  const portal = { id: PORTAL, name: "Customer portal", defaultVisibility: "project" as const };

  it("names the team projects and repositories the viewer's repository list lets them start on", () => {
    const linked = repo("b1", { teamProject: portal, deviceOnline: false });
    const scratch = repo("b2");
    const t = startableTargets([linked, scratch]);
    // An offline device still counts (the dialog opens on it and says why it can't start yet).
    expect(t.teamProjects.has(PORTAL)).toBe(true);
    expect(t.repos.has(linked.id)).toBe(true);
    expect(t.repos.has(scratch.id)).toBe(true);
  });

  it("leaves out what the viewer can't use: a removed repository, a hidden project's, and anything not listed", () => {
    const removed = repo("b3", { teamProject: portal, available: false });
    const hidden = repo("b4", { teamProjectHidden: true });
    const t = startableTargets([removed, hidden]);
    expect(t.teamProjects.size).toBe(0);
    expect(t.repos.size).toBe(0);
    // Still loading: no "+" at all (fail closed).
    expect(startableTargets(undefined).teamProjects.size).toBe(0);
  });
});

describe("MoreRow", () => {
  it("links to the project page with a named target", () => {
    const out = html(<MoreRow projectId={PORTAL} projectName="Customer portal" n={2} />);
    expect(out).toContain(`href="/work-zone/projects/${PORTAL}"`);
    expect(out).toContain('aria-label="2 more active sessions in Customer portal"');
    expect(out).toContain(">+2 more<");
    expect(html(<MoreRow projectId={PORTAL} projectName="Customer portal" n={1} />)).toContain(
      'aria-label="1 more active session in Customer portal"',
    );
  });
});

/** Visible words only (tags stripped, the copy's entities decoded). */
const words = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("OnboardingLine (07.10-05, D-08, § 9)", () => {
  it("a person who may create reads one line with the Create project link button", () => {
    const out = html(<OnboardingLine canCreate onCreate={() => {}} />);
    expect(out).toContain('data-testid="onboarding-line"');
    expect(words(out)).toBe("Share sessions with your team → Create project");
    expect(out).toMatch(/<button[^>]*>Create project<\/button>/);
    expect(out).toContain("max-md:min-h-11");
    // One quiet line: no card, border or icon.
    const lineClass = out.match(/^<p[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(lineClass.split(" ").sort()).toEqual(
      ["leading-4", "px-2.5", "py-1", "text-[12px]", "text-muted-foreground"].sort(),
    );
    expect(out).not.toContain("<svg");
  });

  it("anyone else reads the plain line, with no link", () => {
    const out = html(<OnboardingLine canCreate={false} onCreate={() => {}} />);
    expect(words(out)).toBe("Team projects you're added to appear here.");
    expect(out).not.toContain("<button");
    expect(out).not.toContain("<a");
  });
});

describe("the projects request's states (07.10-05, UI-SPEC States)", () => {
  const ctx = { now: NOW, viewerId: ANA, openSessionId: null };
  const portal = { id: PORTAL, name: "Customer portal" };
  const id = (n: number) => `01a11635-d6e7-7c87-9f17-00000000c${String(n).padStart(3, "0")}`;
  const live = session({ id: id(1), title: "Fix the login redirect", teamProject: portal });
  const idle = session({
    id: id(2),
    title: "Tidy the settings page",
    status: "idle",
    runningSince: null,
    updatedAt: "2026-10-27T10:00:00Z",
    teamProject: portal,
  });
  const settled = session({ id: id(3), title: "Old work", status: "completed", teamProject: portal });
  const scratch = session({
    id: id(4),
    title: "Try the new linter",
    projectId: "01a11635-d6e7-7c87-9f17-0000000000b9",
    projectName: "scratch",
    teamProject: null,
  });
  const hidden = session({
    id: id(5),
    title: "Rotate the keys",
    projectId: "01a11635-d6e7-7c87-9f17-0000000000b8",
    projectName: "linked-repo",
    status: "idle",
    runningSince: null,
    updatedAt: "2026-10-27T09:00:00Z",
    teamProject: null,
    teamProjectHidden: true,
  });

  it("loading: one header bar and three row skeletons", () => {
    const out = html(<ProjectsLoading />);
    expect(out).toContain('data-testid="projects-loading"');
    expect(out.match(/data-slot="skeleton"/g)).toHaveLength(4);
    expect(out).toContain("h-4 w-24");
    for (const w of ["w-[72%]", "w-[56%]", "w-[64%]"]) expect(out).toContain(w);
  });

  it("the fallback groups the active sessions not already under Personal, by project or repository", () => {
    // `scratch` is under Personal (in the model's scope): it is never drawn twice.
    const groups = fallbackGroups([settled, scratch, idle, live, hidden], new Set([scratch.id]), ctx);
    expect(groups.map((g) => [g.name, g.sessions.map((s) => s.title)])).toEqual([
      ["Customer portal", ["Fix the login redirect", "Tidy the settings page"]],
      ["linked-repo", ["Rotate the keys"]],
    ]);
    // The open session always shows, even settled.
    const open = fallbackGroups([settled], new Set(), { ...ctx, openSessionId: settled.id });
    expect(open[0]?.sessions.map((s) => s.id)).toEqual([settled.id]);
  });

  it("failed: the error line with Try again, then the fallback rows; a hidden project is never named", () => {
    const out = html(
      <ProjectsFallback
        sessions={[live, idle, scratch, hidden]}
        scope={new Set([scratch.id])}
        ctx={ctx}
        retrying={false}
        onRetry={() => {}}
      />,
    );
    expect(words(out)).toContain("Couldn't load projects. Try again");
    expect(out).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(out).toContain('aria-label="Active sessions in Customer portal"');
    expect(out.match(/data-testid="session-row"/g)).toHaveLength(3);
    expect(out).not.toContain("Try the new linter");
    expect(out).toContain('aria-label="Active sessions in linked-repo"');
  });
});
