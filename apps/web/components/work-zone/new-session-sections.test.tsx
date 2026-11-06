import type { Project } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { groupRepos } from "@/lib/new-session-groups";
import { ProjectList, ProjectsEmpty, ProjectsLoading } from "./new-session-sections";

/**
 * The New session dialog's Project step (owner feedback 2026-11-06, "the panel is chaos"): one bordered list with the
 * team project, the hidden link and Personal by device as headed groups; a skeleton while the list loads (never the
 * empty state); an empty state with a direct action for no computer and for no project.
 */

const PORTAL = {
  id: "01a11635-d6e7-7c87-9f17-0000000000e1",
  name: "Customer portal",
  defaultVisibility: "project" as const,
};
const repo = (n: string, over: Partial<Project> = {}): Project => ({
  id: `01a11635-d6e7-7c87-9f17-0000000000${n}`,
  deviceId: "01a11635-d6e7-7c87-9f17-0000000000c1",
  deviceName: "Ana's MacBook",
  deviceOnline: true,
  name: `repo-${n}`,
  gitRemote: null,
  defaultBranch: "main",
  available: true,
  createdAt: "2026-10-22T10:00:00Z",
  teamProject: null,
  ...over,
});
const web = repo("b1", { teamProject: PORTAL, name: "portal-web" });
const api = repo("b2", {
  teamProject: PORTAL,
  name: "portal-api",
  deviceName: "build-01",
  deviceOnline: false,
});
const payroll = repo("b3", { teamProjectHidden: true, name: "payroll" });
const scratch = repo("b4", { name: "scratch" });

const html = (selectedId: string | null, list: Project[] = [web, api, payroll, scratch]) =>
  renderToStaticMarkup(<ProjectList groups={groupRepos(list)} selectedId={selectedId} onSelect={() => {}} />);

/** The attributes of the radio whose markup contains `text`. */
function radio(markup: string, text: string): string {
  const parts = markup.split('role="radio"');
  const i = parts.findIndex((p, k) => k > 0 && p.includes(text));
  return i > 0 ? (parts[i]?.split(">")[0] ?? "") : "";
}

describe("ProjectList", () => {
  it("groups the team project first, then the hidden link, then Personal by device", () => {
    const out = html(web.id);
    expect(out).toContain('role="radiogroup" aria-label="Project"');
    expect(out).toContain(`data-testid="project-group-${PORTAL.id}"`);
    expect(out).toContain("Customer portal");
    expect(out).toContain("· Team project");
    expect(out).toContain('data-testid="project-group-hidden"');
    expect(out).toContain("Linked to a project you can&#x27;t open");
    expect(out).toMatch(/data-testid="project-group-personal"[^>]*>Personal</);
    expect(out.indexOf(PORTAL.name)).toBeLessThan(out.indexOf("payroll"));
    expect(out.indexOf("payroll")).toBeLessThan(out.indexOf("scratch"));
  });

  it("shows each team repository's device and status; a hidden one is disabled", () => {
    const out = html(web.id);
    expect(radio(out, "portal-api")).toContain('data-testid="project-option"');
    expect(out).toContain("build-01");
    expect(out).toContain("Offline");
    expect(radio(out, "payroll")).toContain('data-testid="project-option-hidden"');
    expect(radio(out, "payroll")).toContain("disabled");
  });

  it("is one tab stop: the chosen repository, else the first one that can start", () => {
    const out = html(scratch.id);
    expect(radio(out, "scratch")).toContain('aria-checked="true"');
    expect(radio(out, "scratch")).toContain('tabindex="0"');
    expect(radio(out, "portal-web")).toContain('tabindex="-1"');
    const none = html(null);
    expect(radio(none, "portal-web")).toContain('tabindex="0"');
    expect(radio(none, "scratch")).toContain('tabindex="-1"');
  });

  it("drops the Personal heading when personal repositories are all there is", () => {
    const out = html(scratch.id, [scratch]);
    expect(out).not.toContain('data-testid="project-group-personal"');
    expect(out).toContain("Ana&#x27;s MacBook");
  });
});

describe("ProjectsLoading", () => {
  it("is a busy placeholder the size of the list, never the empty state", () => {
    const out = renderToStaticMarkup(<ProjectsLoading />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('data-testid="new-session-projects-loading"');
    expect(out).toContain("Loading projects");
    expect(out).not.toContain("No projects");
  });
});

describe("ProjectsEmpty", () => {
  it("no computer yet: a direct way to add one, and to a server", () => {
    const out = renderToStaticMarkup(<ProjectsEmpty kind="no-devices" canPair desktop={false} />);
    expect(out).toContain('data-testid="new-session-empty-devices"');
    expect(out).toContain('href="/settings/devices?add=1"');
    expect(out).toContain("Add a device");
    expect(out).toContain('href="/settings/devices?add=server"');
  });

  it("no computer and no right to pair: who to ask, no dead link", () => {
    const out = renderToStaticMarkup(<ProjectsEmpty kind="no-devices" canPair={false} desktop={false} />);
    expect(out).toContain("Ask someone on your team to share a computer with you.");
    expect(out).not.toContain("/settings/devices?add");
  });

  it("no project yet: the command, Manage devices, and the desktop action when there is one", () => {
    const out = renderToStaticMarkup(<ProjectsEmpty kind="no-projects" canPair desktop />);
    expect(out).toContain('data-testid="new-session-empty-projects"');
    expect(out).toContain("ocw-runtime add-project .");
    expect(out).toContain('href="/settings/devices"');
    expect(out).toContain("Manage devices");
    expect(out).toContain("Add project from this computer");
    const web = renderToStaticMarkup(<ProjectsEmpty kind="no-projects" canPair desktop={false} />);
    expect(web).not.toContain("Add project from this computer");
  });
});
