import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, WorkProjectDetail, WorkProjectIndex, WorkSession } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NEW_PROJECT_COPY, parentLabel } from "./new-project-dialog";
import { repoCount, teamCaption, trailText } from "./project-labels";
import { NO_ACCESS_COPY, ProjectNoAccess } from "./project-page";
import {
  NewSessionAction,
  newSessionTarget,
  ProjectSessionsBody,
  projectSessions,
  SESSIONS_COPY,
  SESSIONS_PAGE,
} from "./project-sessions";
import { INDEX_COPY, ProjectsIndexBody } from "./projects-index";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

/**
 * The Work Zone project pages (07.9-11, UI-SPEC Surface 4 part 1, D-01, D-10, D-13, D-14): every state of the index and
 * the Sessions tab, as static markup. The API decides what is listed; these components only render it.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
/** Visible words only (tags stripped, entities of the copy decoded). */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const PORTAL = "01a11635-d6e7-7c87-9f17-0000000000d1";
const OTHER = "01a11635-d6e7-7c87-9f17-0000000000d2";
const REPO = "01a11635-d6e7-7c87-9f17-0000000000b1";
const REPO2 = "01a11635-d6e7-7c87-9f17-0000000000b2";
const DEVICE = "01a11635-d6e7-7c87-9f17-0000000000c1";
const ANA = "01a11635-d6e7-7c87-9f17-0000000000a1";

const index = (over: Partial<WorkProjectIndex> = {}): WorkProjectIndex => ({
  teamProjects: [
    { id: PORTAL, name: "Customer portal", trail: ["Engineering", "Web"], peopleCount: 3, repoCount: 2 },
  ],
  personalRepos: [
    {
      projectId: REPO,
      name: "scratch",
      deviceId: DEVICE,
      deviceName: "Víctor's MacBook",
      deviceOnline: true,
    },
  ],
  viewerCan: { create: false },
  ...over,
});

const repo = (
  over: Partial<WorkProjectDetail["repos"][number]> = {},
): WorkProjectDetail["repos"][number] => ({
  projectId: REPO,
  name: "web-app",
  deviceId: DEVICE,
  deviceName: "Ana's MacBook",
  deviceOnline: true,
  branch: "main",
  available: true,
  ...over,
});

const detail = (over: Partial<WorkProjectDetail> = {}): WorkProjectDetail => ({
  id: PORTAL,
  name: "Customer portal",
  parentId: OTHER,
  trail: ["Engineering", "Web"],
  defaultVisibility: "project",
  access: { count: 3, people: [] },
  teams: [],
  repos: [repo()],
  viewerCan: { manage: false, assignTeams: false, members: false },
  ...over,
});

let n = 0;
function session(over: Partial<WorkSession> = {}): WorkSession {
  n += 1;
  const id = `01a11635-d6e7-7c87-9f17-${String(n).padStart(12, "0")}`;
  return {
    id,
    conversationId: id,
    projectId: REPO,
    projectName: "web-app",
    deviceId: DEVICE,
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    runtime: "claude-code",
    model: null,
    permissionMode: "default",
    worktree: false,
    branch: "fix/login",
    status: "idle",
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
    createdAt: "2026-10-22T11:00:00Z",
    updatedAt: `2026-10-22T11:${String(n % 60).padStart(2, "0")}:00Z`,
    visibility: { kind: "project", activeCount: 0, differsFromDefault: false, firstTeamName: null },
    teamProject: { id: PORTAL, name: "Customer portal" },
    ...over,
  };
}

const device = (over: Partial<Project> = {}): Project => ({
  id: REPO,
  deviceId: DEVICE,
  deviceName: "Ana's MacBook",
  deviceOnline: true,
  name: "web-app",
  gitRemote: null,
  defaultBranch: "main",
  available: true,
  createdAt: "2026-10-22T10:00:00Z",
  teamProject: { id: PORTAL, name: "Customer portal", defaultVisibility: "project" },
  ...over,
});

const noop = () => {};

describe("labels", () => {
  it("uses singulars for one and words zero repositories", () => {
    expect(teamCaption({ trail: ["Engineering", "Web"], peopleCount: 3, repoCount: 2 })).toBe(
      "Engineering › Web · 3 people · 2 repositories",
    );
    expect(teamCaption({ trail: ["Web"], peopleCount: 1, repoCount: 1 })).toBe(
      "Web · 1 person · 1 repository",
    );
    expect(teamCaption({ trail: ["Web"], peopleCount: 3, repoCount: 0 })).toBe(
      "Web · 3 people · No repositories",
    );
    expect(repoCount(0)).toBe("No repositories");
    expect(trailText([])).toBe("");
    expect(parentLabel({ name: "Web", trail: ["Engineering"] })).toBe("Engineering › Web");
    expect(parentLabel({ name: "Engineering", trail: [] })).toBe("Engineering");
  });
});

describe("ProjectsIndexBody", () => {
  it("lists team rows linking to their page, with the caption, and personal rows with New session", () => {
    const out = html(<ProjectsIndexBody data={index()} onNewSession={noop} />);
    expect(out).toContain('data-testid="projects-index-body"');
    expect(out).toContain(`data-testid="project-row-${PORTAL}"`);
    expect(out).toContain(`href="/work-zone/projects/${PORTAL}"`);
    expect(out).toContain('title="Customer portal"');
    expect(text(out)).toContain("Engineering › Web · 3 people · 2 repositories");
    expect(out).toContain(`data-testid="personal-row-${REPO}"`);
    expect(text(out)).toContain("Víctor's MacBook");
    expect(text(out)).toContain("Online");
    expect(out).toContain('aria-label="New session in scratch"');
    expect(text(out)).toContain(INDEX_COPY.personalHint);
    // No default-visibility badge on any row (N2).
    expect(text(out)).not.toMatch(/Default|Visible to/);
  });

  it("shows the team empty state with its body, and the personal dashed box", () => {
    const out = html(
      <ProjectsIndexBody data={index({ teamProjects: [], personalRepos: [] })} onNewSession={noop} />,
    );
    expect(text(out)).toContain("No team projects yet");
    expect(text(out)).toContain(
      "A team project lets everyone in it see and steer sessions together. Admins and team leads create them.",
    );
    expect(text(out)).toContain("No personal repositories. Add one from the desktop app.");
    expect(text(out)).not.toContain("New project");
  });

  it("offers New project in the empty state only when the API says the viewer may create one", () => {
    const out = html(
      <ProjectsIndexBody data={index({ teamProjects: [] })} onNewProject={noop} onNewSession={noop} />,
    );
    expect(text(out)).toContain("New project");
  });

  it("captions one person and one repository in the singular, none as No repositories", () => {
    const out = html(
      <ProjectsIndexBody
        data={index({
          teamProjects: [
            { id: PORTAL, name: "Solo", trail: ["Web"], peopleCount: 1, repoCount: 1 },
            { id: OTHER, name: "Empty", trail: ["Web"], peopleCount: 3, repoCount: 0 },
          ],
        })}
        onNewSession={noop}
      />,
    );
    expect(text(out)).toContain("1 person · 1 repository");
    expect(text(out)).toContain("3 people · No repositories");
  });

  it("shows two skeleton rows per section while loading", () => {
    const out = html(<ProjectsIndexBody data={undefined} onNewSession={noop} />);
    expect(out.match(/data-slot="skeleton"|animate-pulse/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe("the project's sessions", () => {
  it("keeps only this team project's sessions from the authorized list, newest first", () => {
    const a = session({ updatedAt: "2026-10-22T10:00:00Z" });
    const b = session({ updatedAt: "2026-10-22T12:00:00Z" });
    const other = session({ teamProject: { id: OTHER, name: "Payments" } });
    const personal = session({ teamProject: null });
    expect(projectSessions([a, other, b, personal], PORTAL).map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it("lists rows with the footnote, never the empty state", () => {
    const rows = [session(), session()];
    const out = html(
      <ProjectSessionsBody
        project={detail()}
        sessions={rows}
        viewerId={ANA}
        target={{ kind: "ready", projectId: REPO }}
        onStart={noop}
      />,
    );
    expect(out.match(/data-testid="project-session-row"/g)).toHaveLength(2);
    expect(text(out)).toContain(SESSIONS_COPY.footnote);
    expect(text(out)).not.toContain("No sessions you can see");
    // The row is WorkZoneHome's: "{repo} · {device} · {relative}" and a link to the session.
    expect(out).toContain(`href="/work-zone/${rows[0]?.id}"`);
    expect(text(out)).toContain("web-app");
  });

  it("shows the sidebar marker on a session whose audience differs from the default", () => {
    const out = html(
      <ProjectSessionsBody
        project={detail()}
        sessions={[
          session({
            visibility: { kind: "owner", activeCount: 0, differsFromDefault: true, firstTeamName: null },
          }),
        ]}
        viewerId={ANA}
        target={{ kind: "ready", projectId: REPO }}
        onStart={noop}
      />,
    );
    expect(out).toContain('data-testid="visibility-marker"');
    expect(text(out)).toContain(", only visible to you");
  });

  it(`shows ${SESSIONS_PAGE} rows, then Show more`, () => {
    const rows = Array.from({ length: SESSIONS_PAGE + 3 }, () => session());
    const out = html(
      <ProjectSessionsBody
        project={detail()}
        sessions={rows}
        viewerId={ANA}
        target={{ kind: "absent" }}
        onStart={noop}
      />,
    );
    expect(out.match(/data-testid="project-session-row"/g)).toHaveLength(SESSIONS_PAGE);
    expect(out).toContain('data-testid="project-sessions-more"');
    expect(text(out)).toContain("Show more");
  });

  it("without visible sessions: the empty state carries the footnote sentence and New session; no footnote line", () => {
    const out = html(
      <ProjectSessionsBody
        project={detail()}
        sessions={[session({ teamProject: { id: OTHER, name: "Payments" } })]}
        viewerId={ANA}
        target={{ kind: "ready", projectId: REPO }}
        onStart={noop}
      />,
    );
    expect(text(out)).toContain("No sessions you can see");
    expect(text(out)).toContain("Start one. Sessions people keep to themselves don't appear here.");
    expect(out).not.toContain('data-testid="project-sessions-footnote"');
    expect(out).toContain('data-testid="project-new-session"');
  });

  it("without repositories: No repositories yet, worded for editors and for everyone else", () => {
    const editor = html(
      <ProjectSessionsBody
        project={detail({ repos: [], viewerCan: { manage: true, assignTeams: true, members: true } })}
        sessions={[]}
        viewerId={ANA}
        target={{ kind: "absent" }}
        onStart={noop}
      />,
    );
    expect(text(editor)).toContain("No repositories yet");
    expect(text(editor)).toContain("Link a repository so the team can start sessions here.");
    const member = html(
      <ProjectSessionsBody
        project={detail({ repos: [] })}
        sessions={[]}
        viewerId={ANA}
        target={{ kind: "absent" }}
        onStart={noop}
      />,
    );
    expect(text(member)).toContain("Ask a project lead to link one.");
    expect(text(member)).not.toContain("No sessions you can see");
    expect(member).not.toContain('data-testid="project-sessions-footnote"');
  });

  it("shows three skeleton rows while the list loads", () => {
    const out = html(
      <ProjectSessionsBody
        project={detail()}
        sessions={undefined}
        viewerId={ANA}
        target={{ kind: "absent" }}
        onStart={noop}
      />,
    );
    expect(out).toContain('data-testid="project-sessions-loading"');
  });
});

describe("New session on a project", () => {
  it("preselects the first online repository the viewer can start on", () => {
    expect(
      newSessionTarget(detail({ repos: [repo(), repo({ projectId: REPO2 })] }), [
        device({ deviceOnline: false }),
        device({ id: REPO2 }),
      ]),
    ).toEqual({ kind: "ready", projectId: REPO2 });
  });

  it("is absent without repositories, or when the viewer can start on none of them", () => {
    expect(newSessionTarget(detail({ repos: [] }), [device()])).toEqual({ kind: "absent" });
    expect(newSessionTarget(detail(), [])).toEqual({ kind: "absent" });
    expect(newSessionTarget(detail(), undefined)).toEqual({ kind: "absent" });
    expect(newSessionTarget(detail(), [device({ teamProject: null })])).toEqual({ kind: "absent" });
    expect(newSessionTarget(detail(), [device({ available: false })])).toEqual({ kind: "absent" });
    expect(
      html(<NewSessionAction projectName="Customer portal" target={{ kind: "absent" }} onStart={noop} />),
    ).toBe("");
  });

  it("is disabled with the reason when none is online", () => {
    expect(newSessionTarget(detail(), [device({ deviceOnline: false })])).toEqual({ kind: "offline" });
    const out = html(
      <NewSessionAction projectName="Customer portal" target={{ kind: "offline" }} onStart={noop} />,
    );
    expect(out).toMatch(/data-disabled|aria-disabled="true"|disabled=""/);
    expect(text(out)).toContain("No repository of Customer portal is online right now.");
    expect(out).toContain("aria-describedby");
  });
});

describe("no access", () => {
  it("is one state for forbidden and unknown ids, with Back to projects", () => {
    const out = html(<ProjectNoAccess />);
    expect(text(out)).toContain(NO_ACCESS_COPY.title);
    expect(text(out)).toContain("You're not in this project");
    expect(text(out)).toContain("Ask a project lead to add you.");
    expect(out).toContain('href="/work-zone/projects"');
    expect(text(out)).toContain("Back to projects");
  });
});

describe("NewProjectDialog", () => {
  it("has no Top level option (D-13) and the UI-SPEC copy", () => {
    const source = readFileSync(join(import.meta.dirname, "new-project-dialog.tsx"), "utf8");
    expect(source).not.toMatch(/Top level/i);
    expect(NEW_PROJECT_COPY.placeholder).toBe("e.g. Customer portal");
    expect(NEW_PROJECT_COPY.nameMissing).toBe("Enter a name");
    expect(NEW_PROJECT_COPY.created("Customer portal")).toBe("Customer portal created");
    expect(NEW_PROJECT_COPY.submit).toBe("Create project");
  });
});
