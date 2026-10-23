import type { Project } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { defaultAudience, groupRepos, isStartable } from "./new-session-groups";

/**
 * The new-session dialog's repository groups and its starting audience (07.9-14, UI-SPEC Surface 3, D-01, D-03,
 * D-14, R5). Pure: the API already filtered `GET /projects` for the caller; this only arranges what it sent.
 */

const DEV_A = "01a11635-d6e7-7c87-9f17-00000000a0a1";
const DEV_B = "01a11635-d6e7-7c87-9f17-00000000a0a2";
const PORTAL = { id: "01a11635-d6e7-7c87-9f17-0000000000e1", name: "Customer portal" };
const BILLING = { id: "01a11635-d6e7-7c87-9f17-0000000000e2", name: "Billing" };

let n = 0;
function repo(name: string, over: Partial<Project> = {}): Project {
  n += 1;
  return {
    id: `01a11635-d6e7-7c87-9f17-${String(n).padStart(12, "0")}`,
    deviceId: DEV_A,
    deviceName: "Ana's MacBook",
    deviceOnline: true,
    name,
    gitRemote: null,
    defaultBranch: "main",
    available: true,
    createdAt: "2026-10-23T08:00:00.000Z",
    ...over,
  };
}

const team = (p: { id: string; name: string }, defaultVisibility: "project" | "owner" = "project") => ({
  teamProject: { ...p, defaultVisibility },
});

describe("groupRepos", () => {
  it("puts team projects first, alphabetically, each holding all of its repositories", () => {
    const web = repo("web-app", team(PORTAL));
    const api = repo("api", { ...team(PORTAL), deviceId: DEV_B, deviceName: "Leo's PC" });
    const invoices = repo("invoices", team(BILLING, "owner"));
    const scratch = repo("scratch");
    const g = groupRepos([scratch, web, invoices, api]);
    expect(g.teams.map((t) => t.project.name)).toEqual(["Billing", "Customer portal"]);
    expect(g.teams[1]?.project).toEqual({ ...PORTAL, defaultVisibility: "project" });
    expect(g.teams[1]?.repos.map((r) => r.name)).toEqual(["web-app", "api"]);
    expect(g.teams[0]?.repos.map((r) => r.name)).toEqual(["invoices"]);
  });

  it("groups unlinked repositories by device under Personal, in the order the API sent them", () => {
    const a1 = repo("scratch");
    const b1 = repo("dotfiles", { deviceId: DEV_B, deviceName: "Leo's PC", deviceOnline: false });
    const a2 = repo("notes");
    const linked = repo("web-app", team(PORTAL));
    const g = groupRepos([a1, b1, linked, a2]);
    expect(g.personal).toEqual([
      { deviceId: DEV_A, deviceName: "Ana's MacBook", deviceOnline: true, repos: [a1, a2] },
      { deviceId: DEV_B, deviceName: "Leo's PC", deviceOnline: false, repos: [b1] },
    ]);
  });

  it("keeps a repository linked to a project the caller can't open apart: never personal, never a team group (D-14)", () => {
    const hidden = repo("payroll", { teamProject: null, teamProjectHidden: true });
    const mine = repo("scratch");
    const g = groupRepos([hidden, mine]);
    expect(g.hidden).toEqual([hidden]);
    expect(g.personal.flatMap((d) => d.repos)).toEqual([mine]);
    expect(g.teams).toEqual([]);
  });

  it("sorts team projects by name, ignoring case, and two projects of one name stay apart (by id)", () => {
    const other = { id: "01a11635-d6e7-7c87-9f17-0000000000e3", name: "billing" };
    const g = groupRepos([repo("z", team(PORTAL)), repo("y", team(other)), repo("x", team(BILLING))]);
    expect(g.teams.map((t) => t.project.id)).toEqual([BILLING.id, other.id, PORTAL.id]);
  });

  it("an older payload without teamProject reads as personal", () => {
    const { teamProject: _drop, ...old } = repo("legacy");
    expect(groupRepos([old as Project]).personal[0]?.repos.map((r) => r.name)).toEqual(["legacy"]);
  });
});

describe("defaultAudience (D-03)", () => {
  it("a team project with the default on starts as Project", () => {
    expect(defaultAudience(repo("web", team(PORTAL, "project")))).toEqual({ kind: "project" });
  });
  it("a team project with the default off starts as Only me", () => {
    expect(defaultAudience(repo("web", team(PORTAL, "owner")))).toEqual({ kind: "owner" });
  });
  it("a personal repository starts as Project (everyone who can use the device)", () => {
    expect(defaultAudience(repo("scratch"))).toEqual({ kind: "project" });
  });
  it("no repository, or one nobody may start on here, has none", () => {
    expect(defaultAudience(null)).toBeNull();
    expect(defaultAudience(repo("payroll", { teamProjectHidden: true }))).toBeNull();
  });
});

describe("isStartable", () => {
  it("needs an online device and a project the caller can open", () => {
    expect(isStartable(repo("a"))).toBe(true);
    expect(isStartable(repo("b", { deviceOnline: false }))).toBe(false);
    expect(isStartable(repo("c", { teamProjectHidden: true }))).toBe(false);
  });
});
